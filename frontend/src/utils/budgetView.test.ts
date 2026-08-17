import { describe, it, expect } from 'vitest';
import type { Budget, Transaction } from '../types';
import { buildBudgetReport, type BudgetReport, type BudgetReportLine } from './budgeting';
import { computeTransferExclusionIds } from './transactionCore';
import { detectInternalTransferIds } from './recurringDetection';
import {
  toneFor, barFor, messageFor, projectionFor, rolloverFor, toLineView, sortLineViews,
  toBudgetView, monthLabel, shouldSeedFromPlan, countPlanGoals, seedFlagKey,
  budgetableCategories, type BudgetViewContext,
} from './budgetView';

/** The month a line is being read in — August, mid-flight, unless stated. */
const AUG: BudgetViewContext = { month: '2026-08', monthComplete: false };

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1',
    account_id: 'acc-bank',
    account_type: 'bank',
    date: '2026-08-10',
    merchant: 'Merchant',
    currency: 'AUD',
    category: 'Groceries',
    is_duplicate_flagged: false,
    is_subscription: false,
    ...partial,
  };
}

let bseq = 0;
function budget(partial: Partial<Budget> = {}): Budget {
  bseq += 1;
  return {
    id: partial.id ?? `b${bseq}`,
    user_id: 'u1',
    scope: 'category',
    category: 'Groceries',
    limit_amount: 500,
    period: 'monthly',
    rollover_enabled: false,
    active: true,
    ...partial,
  };
}

/** A real report, built by the real engine — the view model is never fed
 *  hand-made lines, so these tests fail if the engine's contract shifts. */
function report(opts: {
  budgets: Budget[];
  transactions?: Transaction[];
  month?: string;
  asOf?: string;
  includeUnbudgeted?: boolean;
  coverageFromMonth?: string | null;
  monthlyRateByCategory?: Record<string, number>;
}): BudgetReport {
  const transactions = opts.transactions ?? [];
  return buildBudgetReport({
    month: opts.month ?? '2026-08',
    asOf: opts.asOf ?? '2026-08-31',
    budgets: opts.budgets,
    transactions,
    userId: 'u1',
    spendOptions: { excludeIds: computeTransferExclusionIds(transactions, detectInternalTransferIds) },
    includeUnbudgeted: opts.includeUnbudgeted,
    coverageFromMonth: opts.coverageFromMonth ?? null,
    projection: opts.monthlyRateByCategory
      ? { monthlyRateByCategory: opts.monthlyRateByCategory }
      : undefined,
  });
}

/** The single category line of a one-budget report. */
function line(opts: Parameters<typeof report>[0]): BudgetReportLine {
  return report(opts).categories[0];
}

// ═════════════════════════════════════════════════════════════════════════════
//  Tone
// ═════════════════════════════════════════════════════════════════════════════
describe('tone', () => {
  it('maps every engine status to a tone', () => {
    expect(toneFor('under')).toBe('ok');
    expect(toneFor('at-risk')).toBe('warn');
    expect(toneFor('over')).toBe('over');
    expect(toneFor('no-limit')).toBe('neutral');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Bars — the geometry the user actually reads
// ═════════════════════════════════════════════════════════════════════════════
describe('bar geometry', () => {
  it('fills in proportion to the cap', () => {
    const l = line({
      budgets: [budget({ limit_amount: 400 })],
      transactions: [tx({ amount: -100 })],
    });
    expect(barFor(l).fillPct).toBe(25);
  });

  it('SATURATES at 100% when overspent rather than overflowing the track', () => {
    const l = line({
      budgets: [budget({ limit_amount: 200 })],
      transactions: [tx({ amount: -600 })],
    });
    const bar = barFor(l);
    expect(l.spent).toBe(600);           // the number is still the truth…
    expect(bar.fillPct).toBe(100);       // …the bar just can't grow past its track
    expect(bar.tone).toBe('over');
  });

  it('marks where the month is projected to land', () => {
    // Half the month gone, $200 of a $1000 cap spent, history says ~$800/month.
    const l = line({
      budgets: [budget({ limit_amount: 1000 })],
      transactions: [tx({ amount: -200, date: '2026-08-05' })],
      asOf: '2026-08-15',
      monthlyRateByCategory: { Groceries: 800 },
    });
    const bar = barFor(l);
    expect(l.projected).toBeGreaterThan(l.spent);
    expect(bar.markerPct).not.toBeNull();
    expect(bar.markerPct!).toBeGreaterThan(bar.fillPct);
    expect(bar.markerPct!).toBeLessThan(100);
  });

  it('drops the marker once projection is off the end of the bar', () => {
    const l = line({
      budgets: [budget({ limit_amount: 100 })],
      transactions: [tx({ amount: -90, date: '2026-08-02' })],
      asOf: '2026-08-10',
      monthlyRateByCategory: { Groceries: 900 },
    });
    // Projected way past the cap: a marker pinned at 100% would just sit on the
    // end of a full bar and say nothing the colour doesn't already say.
    expect(barFor(l).markerPct).toBeNull();
  });

  it('drops the marker on a finished month — nothing left to predict', () => {
    const l = line({
      budgets: [budget({ limit_amount: 500 })],
      transactions: [tx({ amount: -200, date: '2026-07-10' })],
      month: '2026-07',
      asOf: '2026-08-15',
    });
    expect(l.projected).toBe(l.spent);
    expect(barFor(l).markerPct).toBeNull();
  });

  it('renders an uncapped category as an inert empty bar', () => {
    const r = report({
      budgets: [],
      transactions: [tx({ amount: -300, category: 'Dining' })],
      includeUnbudgeted: true,
    });
    const bar = barFor(r.unbudgeted[0]);
    expect(bar).toEqual({ fillPct: 0, markerPct: null, tone: 'neutral' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Overspending
// ═════════════════════════════════════════════════════════════════════════════
describe('overspending', () => {
  it('reports how far over the cap the user is', () => {
    const l = line({
      budgets: [budget({ limit_amount: 300 })],
      transactions: [tx({ amount: -412.5 })],
    });
    expect(l.status).toBe('over');
    expect(messageFor(l)).toEqual({ kind: 'over', by: 112.5 });
  });

  it('reports what is left while on track', () => {
    const l = line({
      budgets: [budget({ limit_amount: 500 })],
      transactions: [tx({ amount: -150 })],
    });
    expect(l.status).toBe('under');
    expect(messageFor(l)).toEqual({ kind: 'left', left: 350 });
  });

  it('says nothing about limits for an uncapped category', () => {
    const r = report({
      budgets: [],
      transactions: [tx({ amount: -80, category: 'Dining' })],
      includeUnbudgeted: true,
    });
    expect(messageFor(r.unbudgeted[0])).toEqual({ kind: 'no-limit', spent: 80 });
  });

  it('counts over and at-risk budgets for the attention strip', () => {
    const r = report({
      budgets: [
        budget({ id: 'g', category: 'Groceries', limit_amount: 100 }),
        budget({ id: 'd', category: 'Dining', limit_amount: 1000 }),
        budget({ id: 'f', category: 'Fuel', limit_amount: 200 }),
      ],
      transactions: [
        tx({ amount: -250, category: 'Groceries', date: '2026-08-03' }),  // over
        tx({ amount: -50, category: 'Dining', date: '2026-08-03' }),      // under
        tx({ amount: -60, category: 'Fuel', date: '2026-08-03' }),        // at risk
      ],
      asOf: '2026-08-06',
      monthlyRateByCategory: { Fuel: 400 },
    });
    const v = toBudgetView(r);
    expect(v.summary.overCount).toBe(1);
    expect(v.summary.atRiskCount).toBe(1);
    expect(v.summary.count).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Projection — a forecast, never mixed into the current position
// ═════════════════════════════════════════════════════════════════════════════
describe('projection', () => {
  /** A budget still inside its cap but spending fast enough to break it. */
  const heading = () => line({
    budgets: [budget({ limit_amount: 500 })],
    transactions: [tx({ amount: -120, date: '2026-08-04' })],
    asOf: '2026-08-08',
    monthlyRateByCategory: { Groceries: 700 },
  });

  it('keeps a projected overshoot OUT of the current position', () => {
    // The bug this guards: "heading $X over" was the only thing said about an
    // at-risk budget, so a forecast occupied the slot where spent money goes.
    const l = heading();
    expect(l.status).toBe('at-risk');
    expect(messageFor(l)).toEqual({ kind: 'left', left: l.remaining });
    expect(l.remaining).toBeGreaterThan(0);      // still inside the cap, today
  });

  it('states the overshoot as a projection, sized from the engine', () => {
    const l = heading();
    const p = projectionFor(l, AUG);
    expect(p.final).toBe(false);
    expect(p.amount).toBe(l.projected);
    expect(p.outlook.kind).toBe('over');
    expect((p.outlook as { by: number }).by).toBeCloseTo(l.projected - l.effectiveLimit, 2);
    expect(p.tone).toBe('warn');                 // heading over, not yet over
  });

  it('reports headroom when the month is projected to stay inside the cap', () => {
    const l = line({
      budgets: [budget({ limit_amount: 1000 })],
      transactions: [tx({ amount: -150, date: '2026-08-05' })],
      asOf: '2026-08-20',
      monthlyRateByCategory: { Groceries: 200 },
    });
    const p = projectionFor(l, AUG);
    expect(p.outlook.kind).toBe('under');
    expect((p.outlook as { by: number }).by).toBeCloseTo(l.effectiveLimit - l.projected, 2);
    expect(p.tone).toBe('ok');
  });

  it('stays red, not amber, once the cap is already broken', () => {
    const l = line({
      budgets: [budget({ limit_amount: 200 })],
      transactions: [tx({ amount: -600 })],
    });
    expect(projectionFor(l, AUG).tone).toBe('over');
  });

  it('is a FINAL figure once the month is done, not a forecast', () => {
    const l = line({
      budgets: [budget({ limit_amount: 500 })],
      transactions: [tx({ amount: -200, date: '2026-07-10' })],
      month: '2026-07',
      asOf: '2026-08-15',
    });
    const p = projectionFor(l, { month: '2026-07', monthComplete: true });
    expect(p.final).toBe(true);
    expect(p.amount).toBe(l.spent);              // the engine stops predicting
  });

  it('has nothing to measure against without a cap', () => {
    const r = report({
      budgets: [],
      transactions: [tx({ amount: -80, category: 'Dining' })],
      includeUnbudgeted: true,
    });
    const p = projectionFor(r.unbudgeted[0], AUG);
    expect(p.outlook).toEqual({ kind: 'untracked' });
    expect(p.tone).toBe('neutral');
  });

  it('measures the projection against the EFFECTIVE cap, rollover included', () => {
    const l = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-07' })],
      transactions: [
        tx({ amount: -100, date: '2026-07-10' }),    // +$300 into August
        tx({ amount: -500, date: '2026-08-05' }),
      ],
      coverageFromMonth: '2026-07',
    });
    // $500 spent against a nominal $400 would be over; against the $700 the
    // user actually has this month it is not.
    expect(l.effectiveLimit).toBe(700);
    expect(projectionFor(l, AUG).outlook.kind).toBe('under');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rollover
// ═════════════════════════════════════════════════════════════════════════════
describe('rollover', () => {
  it('surfaces the surplus carried in from an underspent month', () => {
    const l = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-07' })],
      transactions: [
        tx({ amount: -100, date: '2026-07-10' }),   // $300 left over in July
        tx({ amount: -50, date: '2026-08-05' }),
      ],
      coverageFromMonth: '2026-07',
    });
    expect(l.rolloverIn).toBe(300);
    expect(l.effectiveLimit).toBe(700);
    expect(rolloverFor(l, AUG)).toEqual({
      enabled: true,
      carriedIn: 300,
      carriedFrom: '2026-07',
      baseLimit: 400,
      effectiveLimit: 700,
      firstMonth: false,
    });
  });

  it('surfaces a DEBT carried from an overspent month', () => {
    const l = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-07' })],
      transactions: [
        tx({ amount: -650, date: '2026-07-10' }),   // $250 overspent in July
        tx({ amount: -100, date: '2026-08-05' }),
      ],
      coverageFromMonth: '2026-07',
    });
    expect(l.rolloverIn).toBe(-250);
    expect(l.effectiveLimit).toBe(150);
    const carry = rolloverFor(l, AUG);
    expect(carry.carriedIn).toBe(-250);
    expect(carry.baseLimit).toBe(400);
    expect(carry.effectiveLimit).toBe(150);      // the debt shrank this month's cap
  });

  it('measures the bar against the EFFECTIVE cap, not the nominal one', () => {
    const l = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-07' })],
      transactions: [
        tx({ amount: -650, date: '2026-07-10' }),   // carries −250 into August
        tx({ amount: -150, date: '2026-08-05' }),   // 150 of an effective 150
      ],
      coverageFromMonth: '2026-07',
    });
    // Against the nominal $400 this looks like 37% used; against the cap the
    // user actually has this month it is exactly spent out.
    expect(l.baseLimit).toBe(400);
    expect(l.effectiveLimit).toBe(150);
    expect(barFor(l).fillPct).toBe(100);
    expect(l.percentUsed).toBe(100);
  });

  it('says nothing at all when rollover is off', () => {
    const off = line({
      budgets: [budget({ limit_amount: 400 })],
      transactions: [tx({ amount: -100, date: '2026-07-10' })],
      coverageFromMonth: '2026-07',
    });
    expect(rolloverFor(off, AUG).enabled).toBe(false);
    expect(rolloverFor(off, AUG).carriedIn).toBe(0);
  });

  it('still reports a ZERO carry when rollover is on but the month broke even', () => {
    // Reporting nothing here is indistinguishable from a bug — the user turned
    // rollover on and is entitled to see what it did, even when the answer is
    // "nothing".
    const exact = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-07' })],
      transactions: [tx({ amount: -400, date: '2026-07-10' })],
      coverageFromMonth: '2026-07',
    });
    expect(exact.rolloverIn).toBe(0);
    const carry = rolloverFor(exact, AUG);
    expect(carry.enabled).toBe(true);
    expect(carry.carriedIn).toBe(0);
    expect(carry.firstMonth).toBe(false);        // it existed in July, and broke even
  });

  it('reports $0 carried, and says WHY, in the budget\'s first month', () => {
    const fresh = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-08' })],
      transactions: [
        tx({ amount: -900, date: '2026-07-10' }),   // July spend that is NOT this budget's
        tx({ amount: -50, date: '2026-08-05' }),
      ],
      coverageFromMonth: '2026-07',
    });
    const carry = rolloverFor(fresh, AUG);
    expect(carry.carriedIn).toBe(0);              // nothing to carry from before it existed
    expect(carry.firstMonth).toBe(true);          // …and that is the reason
    expect(carry.effectiveLimit).toBe(carry.baseLimit);
  });

  it('names the month a carry came from', () => {
    const l = line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true, start_month: '2026-01' })],
      month: '2026-01',
      asOf: '2026-01-15',
    });
    expect(rolloverFor(l, { month: '2026-01', monthComplete: false }).carriedFrom).toBe('2025-12');
  });

  it('carries the rollover flag onto the view so the ⟳ marker is honest', () => {
    const v = toLineView(line({
      budgets: [budget({ limit_amount: 400, rollover_enabled: true })],
    }), AUG);
    expect(v.rollover).toBe(true);
    expect(v.baseLimit).toBe(400);
    expect(v.carry.enabled).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Ordering — what the card shows first
// ═════════════════════════════════════════════════════════════════════════════
describe('display order', () => {
  const views = (r: BudgetReport) =>
    sortLineViews(r.categories.map(l => toLineView(l, AUG))).map(v => v.name);

  it('puts over budget first, then heading over, then on track', () => {
    const r = report({
      budgets: [
        budget({ id: 'a', category: 'Fine', limit_amount: 1000 }),
        budget({ id: 'b', category: 'Blown', limit_amount: 50 }),
        budget({ id: 'c', category: 'Risky', limit_amount: 200 }),
      ],
      transactions: [
        tx({ amount: -20, category: 'Fine', date: '2026-08-02' }),
        tx({ amount: -300, category: 'Blown', date: '2026-08-02' }),
        tx({ amount: -40, category: 'Risky', date: '2026-08-02' }),
      ],
      asOf: '2026-08-05',
      monthlyRateByCategory: { Risky: 500 },
    });
    expect(views(r)).toEqual(['Blown', 'Risky', 'Fine']);
  });

  it('breaks ties within a band on how full the budget is', () => {
    const r = report({
      budgets: [
        budget({ id: 'a', category: 'Quarter', limit_amount: 400 }),
        budget({ id: 'b', category: 'Half', limit_amount: 400 }),
      ],
      transactions: [
        tx({ amount: -100, category: 'Quarter' }),
        tx({ amount: -200, category: 'Half' }),
      ],
    });
    expect(views(r)).toEqual(['Half', 'Quarter']);
  });

  it('is stable — the same report always orders the same way', () => {
    const r = report({
      budgets: [
        budget({ id: 'a', category: 'Beta', limit_amount: 100 }),
        budget({ id: 'b', category: 'Alpha', limit_amount: 100 }),
      ],
    });
    expect(views(r)).toEqual(views(r));
    expect(views(r)).toEqual(['Alpha', 'Beta']);   // identical state → by name
  });

  it('lists uncapped categories by spend, biggest first', () => {
    const v = toBudgetView(report({
      budgets: [],
      transactions: [
        tx({ amount: -30, category: 'Small' }),
        tx({ amount: -300, category: 'Big' }),
      ],
      includeUnbudgeted: true,
    }));
    expect(v.unbudgeted.map(u => u.name)).toEqual(['Big', 'Small']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The whole view
// ═════════════════════════════════════════════════════════════════════════════
describe('toBudgetView', () => {
  it('is empty only when there is no cap of any kind', () => {
    expect(toBudgetView(report({ budgets: [] })).isEmpty).toBe(true);

    const withOverallOnly = toBudgetView(report({
      budgets: [budget({ id: 'o', scope: 'overall', category: null, limit_amount: 3000 })],
    }));
    expect(withOverallOnly.isEmpty).toBe(false);
    expect(withOverallOnly.overall?.name).toBe('Overall');
    expect(withOverallOnly.categories).toHaveLength(0);
  });

  it('reports the month, its length and how much of it has passed', () => {
    const v = toBudgetView(report({ budgets: [], month: '2026-02', asOf: '2026-02-14' }));
    expect(v.month).toBe('2026-02');
    expect(v.monthLabel).toBe('February 2026');
    expect(v.daysInMonth).toBe(28);      // 2026 is not a leap year
    expect(v.daysElapsed).toBe(14);
    expect(v.monthComplete).toBe(false);
  });

  it('gets February right in a leap year', () => {
    const v = toBudgetView(report({ budgets: [], month: '2028-02', asOf: '2028-02-10' }));
    expect(v.daysInMonth).toBe(29);
    expect(v.monthLabel).toBe('February 2028');
  });

  it('knows when a month is finished', () => {
    const v = toBudgetView(report({ budgets: [], month: '2026-07', asOf: '2026-08-02' }));
    expect(v.monthComplete).toBe(true);
    expect(v.daysElapsed).toBe(31);
  });

  it('carries the engine totals through untouched', () => {
    const r = report({
      budgets: [budget({ limit_amount: 500 })],
      transactions: [
        tx({ amount: -120, category: 'Groceries' }),
        tx({ amount: -80, category: 'Dining' }),
      ],
      includeUnbudgeted: true,
    });
    const v = toBudgetView(r);
    expect(v.summary.spent).toBe(r.totals.spent);
    expect(v.summary.budgeted).toBe(r.totals.budgeted);
    expect(v.summary.totalSpent).toBe(200);
    expect(v.summary.unbudgetedSpend).toBe(80);
  });

  it('never re-derives money — the view copies the engine line exactly', () => {
    const l = line({
      budgets: [budget({ limit_amount: 500, rollover_enabled: true })],
      transactions: [tx({ amount: -175.5 })],
    });
    const v = toLineView(l, AUG);
    expect(v.spent).toBe(l.spent);
    expect(v.limit).toBe(l.effectiveLimit);
    expect(v.remaining).toBe(l.remaining);
    expect(v.percentUsed).toBe(l.percentUsed);
    expect(v.projected).toBe(l.projected);
    expect(v.status).toBe(l.status);
    expect(v.rolloverIn).toBe(l.rolloverIn);
    expect(v.projection.amount).toBe(l.projected);
    expect(v.carry.effectiveLimit).toBe(l.effectiveLimit);
  });

  it('reads the projection as final for a month that is already over', () => {
    const v = toBudgetView(report({
      budgets: [budget({ limit_amount: 500 })],
      transactions: [tx({ amount: -200, date: '2026-07-10' })],
      month: '2026-07',
      asOf: '2026-08-15',
    }));
    expect(v.monthComplete).toBe(true);
    expect(v.categories[0].projection.final).toBe(true);
    expect(v.categories[0].carry.carriedFrom).toBe('2026-06');
  });
});

describe('monthLabel', () => {
  it('names a month without going near Date parsing', () => {
    expect(monthLabel('2026-01')).toBe('January 2026');
    expect(monthLabel('2026-12')).toBe('December 2026');
  });
  it('passes anything unrecognisable straight through', () => {
    expect(monthLabel('nonsense')).toBe('nonsense');
    expect(monthLabel('')).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Migration off the legacy planner
// ═════════════════════════════════════════════════════════════════════════════
describe('planner migration', () => {
  it('imports when a fresh install finds planner goals', () => {
    expect(shouldSeedFromPlan({ alreadySeeded: false, existingBudgets: 0, planGoals: 3 })).toBe(true);
  });

  it('never imports twice on the same device', () => {
    expect(shouldSeedFromPlan({ alreadySeeded: true, existingBudgets: 0, planGoals: 3 })).toBe(false);
  });

  it('does not import when budgets already exist — the other device did it', () => {
    // The decisive guard: without it, a second device would re-create budgets
    // the user had deliberately deleted on the first.
    expect(shouldSeedFromPlan({ alreadySeeded: false, existingBudgets: 2, planGoals: 3 })).toBe(false);
  });

  it('does not import when the planner has nothing worth importing', () => {
    expect(shouldSeedFromPlan({ alreadySeeded: false, existingBudgets: 0, planGoals: 0 })).toBe(false);
  });

  it('counts only category rows with a real goal, de-duped by name', () => {
    expect(countPlanGoals([
      { name: 'Groceries', amount: 400, is_category_budget: true },
      { name: 'groceries', amount: 250, is_category_budget: true },   // same category
      { name: 'Health', amount: 0, is_category_budget: true },        // no goal
      { name: '', amount: 100, is_category_budget: true },            // unnamed
      { name: 'Netflix', amount: 18, is_category_budget: false },     // an item, not a category
      { name: 'Transport', amount: 120, is_category_budget: true },
    ])).toBe(2);
  });

  it('keys the one-time flag per user so switching accounts re-evaluates', () => {
    expect(seedFlagKey('user-a')).not.toBe(seedFlagKey('user-b'));
    expect(seedFlagKey(null)).toBe(seedFlagKey(undefined));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Choosing a category to budget
// ═════════════════════════════════════════════════════════════════════════════
describe('budgetableCategories', () => {
  it('offers what the user actually spends on first', () => {
    expect(budgetableCategories(
      ['Bills', 'Dining', 'Groceries'],
      { Dining: 40, Groceries: 400 },
      [],
    )).toEqual(['Groceries', 'Dining', 'Bills']);
  });

  it('hides categories that already have a cap, whatever the casing', () => {
    expect(budgetableCategories(['Groceries', 'Dining'], { Groceries: 100 }, ['groceries']))
      .toEqual(['Dining']);
  });

  it('surfaces a category seen only in transactions, so it can be capped', () => {
    // A category that arrived from the bank and is in no menu still needs to be
    // budgetable — that is exactly the spend a user wants to get a grip on.
    expect(budgetableCategories(['Bills'], { 'Pet supplies': 220 }, []))
      .toEqual(['Pet supplies', 'Bills']);
  });

  it('ignores categories with no spend and de-dupes case-insensitively', () => {
    expect(budgetableCategories(['Dining'], { dining: 0, Dining: 0 }, [])).toEqual(['Dining']);
  });

  it('sorts the untouched remainder alphabetically', () => {
    expect(budgetableCategories(['Zoo', 'Apples', 'Mangos'], {}, [])).toEqual(['Apples', 'Mangos', 'Zoo']);
  });
});
