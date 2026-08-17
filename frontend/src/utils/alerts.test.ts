/**
 * Phase 4.4 — proactive alerts.
 *
 * The reports feeding these tests are built by the REAL engines
 * (buildBudgetReport / buildGoalReport / buildCashFlowForecast) rather than
 * hand-written literals. Faking the reports would test this module against my
 * reading of their field semantics; building them for real tests it against the
 * semantics themselves, so a change in what `projected` or `shortfallPerMonth`
 * means fails here instead of shipping a wrong alert.
 */

import { describe, it, expect } from 'vitest';
import type { Budget, Transaction } from '../types';
import { buildBudgetReport } from './budgeting';
import { buildGoalReport, type GoalInput, type ContributionInput, type SourceValue } from './savingsGoals';
import { buildCashFlowForecast, type RecurringInput, type AccountBalanceInput } from './cashFlowForecast';
import {
  buildAlerts, sortAlerts, DEFAULT_THRESHOLDS,
  type Alert, type AlertStateInput,
} from './alerts';

const TODAY = '2026-08-17';   // mid-month: 17 of 31 days elapsed
const MONTH = '2026-08';

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
  } as Transaction;
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

function budgetReport(opts: {
  budgets?: Budget[];
  transactions?: Transaction[];
  asOf?: string;
  /** Learned monthly averages, fed to the projection exactly as the DS does. */
  rates?: Record<string, number>;
} = {}) {
  return buildBudgetReport({
    asOf: opts.asOf ?? TODAY,
    budgets: opts.budgets ?? [],
    transactions: opts.transactions ?? [],
    includeUnbudgeted: true,
    projection: opts.rates ? { monthlyRateByCategory: opts.rates } : undefined,
  });
}

function goalReport(opts: {
  goals?: GoalInput[];
  contributions?: ContributionInput[];
  balances?: SourceValue[];
  /** Monthly spare cash. Omit for "no forecast to judge against". */
  perMonth?: number | null;
} = {}) {
  return buildGoalReport({
    asOf: TODAY,
    goals: opts.goals ?? [],
    contributions: opts.contributions ?? [],
    balances: opts.balances ?? [],
    capacity: opts.perMonth == null ? null : { surplus: opts.perMonth * (90 / 30.4375), days: 90 },
  });
}

const goal = (o: Partial<GoalInput> = {}): GoalInput => ({
  id: 'g1', name: 'House deposit', targetAmount: 12_000,
  targetDate: '2027-08-17', openingAmount: 0, links: [], ...o,
});

function forecast(opts: {
  accounts?: AccountBalanceInput[];
  inputs?: RecurringInput[];
} = {}) {
  return buildCashFlowForecast({
    asOf: TODAY,
    accounts: opts.accounts ?? [{ accountId: 'acc-bank', name: 'Everyday', balance: 50_000 }],
    inputs: opts.inputs ?? [],
  });
}

/** A recurring outflow, the shape forecastDS produces for a bill. */
const outflow = (amount: number, o: Partial<RecurringInput> = {}): RecurringInput => ({
  id: o.id ?? 'bill:1', sourceType: 'bill', name: o.name ?? 'Rent',
  amount: -Math.abs(amount), frequency: 'monthly', anchorDate: '2026-08-20',
  accountId: 'acc-bank', confidence: 1, ...o,
});

/** Build with everything quiet unless a test says otherwise. */
function alerts(opts: Parameters<typeof buildAlerts>[0] extends never ? never : {
  budget?: ReturnType<typeof budgetReport>;
  goals?: ReturnType<typeof goalReport>;
  forecast?: ReturnType<typeof forecast>;
  baselineByCategory?: Record<string, number>;
  states?: AlertStateInput[];
  thresholds?: Partial<typeof DEFAULT_THRESHOLDS>;
} = {}) {
  return buildAlerts({
    asOf: TODAY,
    budget: opts.budget ?? budgetReport(),
    goals: opts.goals ?? goalReport(),
    forecast: opts.forecast ?? forecast(),
    baselineByCategory: opts.baselineByCategory,
    states: opts.states,
    thresholds: opts.thresholds,
  });
}

const kinds = (list: Alert[]) => list.map(a => a.kind);
const find = (list: Alert[], kind: string) => list.find(a => a.kind === kind);

// ═════════════════════════════════════════════════════════════════════════════
//  Nothing to say
// ═════════════════════════════════════════════════════════════════════════════
describe('a quiet account', () => {
  it('raises nothing at all', () => {
    const r = alerts();
    expect(r.all).toEqual([]);
    expect(r.visible).toEqual([]);
    expect(r.unreadCount).toBe(0);
    expect(r.resolvedKeys).toEqual([]);
  });

  it('says nothing about a budget comfortably under its cap', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 1_000 })],
        transactions: [tx({ amount: -100 })],
        rates: { Groceries: 200 },
      }),
    });
    expect(r.all).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Budgets
// ═════════════════════════════════════════════════════════════════════════════
describe('budget alerts', () => {
  it('warns when a category budget nears its limit', () => {
    // $430 of a $500 cap = 86%, late in the month so the projection stays inside
    // it. (Reaching 86% by mid-month is not "nearing" the cap — it is heading
    // straight past it, and the alert below says so instead.)
    const r = alerts({
      budget: budgetReport({
        asOf: '2026-08-30',
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -430 })],
        rates: { Groceries: 450 },
      }),
    });
    const a = find(r.visible, 'budget-limit')!;
    expect(a.stage).toBe(1);
    expect(a.severity).toBe('warning');
    expect(a.title).toContain('nearing its limit');
    expect(a.facts.kind === 'budget-limit' && a.facts.over).toBe(0);
  });

  it('escalates to critical once the cap is actually passed', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -560 })],
        rates: { Groceries: 560 },
      }),
    });
    const a = find(r.visible, 'budget-limit')!;
    expect(a.stage).toBe(2);
    expect(a.severity).toBe('critical');
    expect(a.facts.kind === 'budget-limit' && a.facts.over).toBe(60);
  });

  it('escalates again once well over the cap', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -700 })],   // 140%
        rates: { Groceries: 700 },
      }),
    });
    expect(find(r.visible, 'budget-limit')!.stage).toBe(3);
  });

  it('warns about a projected month-end overspend while still inside the cap', () => {
    // $300 of $500 by day 17, and history says this category costs $900 a month.
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -300 })],
        rates: { Groceries: 900 },
      }),
    });
    const a = find(r.visible, 'budget-projected-over')!;
    expect(a.severity).toBe('warning');
    expect(a.facts.kind === 'budget-projected-over' && a.facts.by).toBeGreaterThan(0);
    // Exactly ONE alert about this budget — not "nearing" and "heading over" both.
    expect(r.all.filter(x => x.kind.startsWith('budget-'))).toHaveLength(1);
  });

  it('never says both "over" and "heading over" about one budget', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -600 })],
        rates: { Groceries: 1_200 },
      }),
    });
    expect(kinds(r.all)).toEqual(['budget-limit']);
  });

  it('ignores an overspend of a few cents', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -200 })],
        // Projects to land a whisker over — not worth an alert.
        rates: { Groceries: 502 },
      }),
    });
    expect(r.all).toEqual([]);
  });

  it('covers the overall budget as well as category ones', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ id: 'ov', scope: 'overall', category: null, limit_amount: 400 })],
        transactions: [tx({ amount: -460, category: 'Dining' })],   // 115% — over, not well over
        rates: { Dining: 460 },
      }),
    });
    const a = find(r.visible, 'budget-limit')!;
    expect(a.title).toContain('Overall spending');
    expect(a.stage).toBe(2);
  });

  it('reports each budget separately when several are in trouble', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [
          budget({ id: 'b-g', category: 'Groceries', limit_amount: 300 }),
          budget({ id: 'b-d', category: 'Dining', limit_amount: 200 }),
          budget({ id: 'b-t', category: 'Transport', limit_amount: 400 }),
        ],
        transactions: [
          tx({ amount: -400, category: 'Groceries' }),
          tx({ amount: -180, category: 'Dining' }),
          tx({ amount: -50, category: 'Transport' }),
        ],
        rates: { Groceries: 400, Dining: 190, Transport: 100 },
      }),
    });
    const budgetAlerts = r.visible.filter(a => a.kind.startsWith('budget-'));
    expect(budgetAlerts).toHaveLength(2);        // Transport is fine
    // Every key is distinct, so dismissing one never silences another.
    expect(new Set(budgetAlerts.map(a => a.key)).size).toBe(2);
    // Over-budget outranks nearing-the-limit.
    expect(budgetAlerts[0].facts.kind === 'budget-limit' && budgetAlerts[0].facts.name).toBe('Groceries');
  });

  it('says nothing about a budget with no cap to measure against', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 0 })],
        transactions: [tx({ amount: -900 })],
      }),
    });
    expect(r.all.filter(a => a.kind.startsWith('budget-'))).toEqual([]);
  });

  it('keys budget alerts to the month, so a new month starts clean', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -600 })],
        rates: { Groceries: 600 },
      }),
    });
    expect(r.all[0].key).toBe(`budget-limit:${MONTH}:groceries`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Goals
// ═════════════════════════════════════════════════════════════════════════════
describe('goal alerts', () => {
  it('warns when a goal is only partly funded', () => {
    // Needs ~$1,000/mo; only $400/mo is spare.
    const r = alerts({ goals: goalReport({ goals: [goal()], perMonth: 400 }) });
    const a = find(r.visible, 'goal-behind')!;
    expect(a.stage).toBe(1);
    expect(a.severity).toBe('warning');
    expect(a.facts.kind === 'goal-behind' && a.facts.shortfallPerMonth).toBeGreaterThan(0);
  });

  it('rates a goal nothing is reaching as worse than one that is merely short', () => {
    const r = alerts({ goals: goalReport({ goals: [goal()], perMonth: 0 }) });
    expect(find(r.visible, 'goal-behind')!.stage).toBe(2);
  });

  it('treats a passed target date as critical', () => {
    const r = alerts({
      goals: goalReport({ goals: [goal({ targetDate: '2026-06-01', openingAmount: 1_000 })], perMonth: 5_000 }),
    });
    const a = find(r.visible, 'goal-behind')!;
    expect(a.stage).toBe(3);
    expect(a.severity).toBe('critical');
    expect(a.facts.kind === 'goal-behind' && a.facts.daysPast).toBe(77);
  });

  it('stays silent when there is no forecast to judge affordability against', () => {
    // status 'unknown' — an alert here would be a guess wearing a warning's clothes.
    const r = alerts({ goals: goalReport({ goals: [goal()], perMonth: null }) });
    expect(r.all).toEqual([]);
  });

  it('stays silent for a goal that is on track, complete or open-ended', () => {
    const r = alerts({
      goals: goalReport({
        goals: [
          goal({ id: 'ok', targetAmount: 1_200 }),
          goal({ id: 'done', targetAmount: 500, openingAmount: 500 }),
          goal({ id: 'someday', targetAmount: 9_000, targetDate: null }),
        ],
        perMonth: 5_000,
      }),
    });
    expect(r.all).toEqual([]);
  });

  it('ignores a shortfall of a few dollars a month', () => {
    const r = alerts({
      goals: goalReport({ goals: [goal({ targetAmount: 1_200 })], perMonth: 98 }),
      thresholds: { goalShortfallMin: 5 },
    });
    expect(r.all).toEqual([]);
  });

  it('raises one alert per struggling goal, each with its own key', () => {
    const r = alerts({
      goals: goalReport({
        goals: [
          goal({ id: 'a', name: 'Car', targetAmount: 6_000, targetDate: '2027-02-17' }),
          goal({ id: 'b', name: 'Trip', targetAmount: 6_000, targetDate: '2027-04-17' }),
          goal({ id: 'c', name: 'Fine', targetAmount: 120, targetDate: '2027-08-17' }),
        ],
        perMonth: 300,
      }),
    });
    const goalAlerts = r.visible.filter(a => a.kind === 'goal-behind');
    expect(goalAlerts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(goalAlerts.map(a => a.key)).size).toBe(goalAlerts.length);
    expect(goalAlerts.every(a => a.key.startsWith('goal-behind:'))).toBe(true);
  });

  it('is not month-scoped — a goal shortfall is not this month\'s news', () => {
    const r = alerts({ goals: goalReport({ goals: [goal()], perMonth: 0 }) });
    expect(r.all[0].key).toBe('goal-behind:g1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Cash
// ═════════════════════════════════════════════════════════════════════════════
describe('cash alerts', () => {
  it('warns when the projected low point falls under a sensible buffer', () => {
    // $3,000 opening, $900/month out: the 90-day trough is $300 — still positive,
    // but under half a month of outflow.
    const f = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 3_000 }],
      inputs: [outflow(900)],
    });
    const a = find(alerts({ forecast: f }).visible, 'cash-low')!;
    expect(a.severity).toBe('warning');
    expect(a.stage).toBe(1);
    expect(a.facts.kind === 'cash-low' && a.facts.lowest).toBeGreaterThanOrEqual(0);
  });

  it('escalates to critical once the balance is projected to go negative', () => {
    const f = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 1_000 }],
      inputs: [outflow(2_000)],
    });
    const a = find(alerts({ forecast: f }).visible, 'cash-low')!;
    expect(a.severity).toBe('critical');
    expect(a.stage).toBe(2);
    expect(a.facts.kind === 'cash-low' && a.facts.lowest).toBeLessThan(0);
  });

  it('scales the buffer to the household, not to a fixed number', () => {
    // $8,000 in the bank looks healthy — until you see $12,000 a month going out.
    const f = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 8_000 }],
      inputs: [outflow(7_500, { id: 'bill:rent' })],
    });
    const r = alerts({ forecast: f });
    expect(find(r.visible, 'cash-low')).toBeTruthy();

    // The same balance with modest outflows says nothing.
    const calm = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 8_000 }],
      inputs: [outflow(200, { id: 'bill:phone' })],
    });
    expect(find(alerts({ forecast: calm }).visible, 'cash-low')).toBeUndefined();
  });

  it('keeps a floor under the buffer so a quiet forecast still has a minimum', () => {
    // Almost nothing going out, but $40 left is still worth knowing about.
    const f = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 40 }],
      inputs: [],
    });
    const a = find(alerts({ forecast: f }).visible, 'cash-low')!;
    expect(a.facts.kind === 'cash-low' && a.facts.buffer).toBe(DEFAULT_THRESHOLDS.cashBufferMin);
  });

  it('points at the forecast page', () => {
    const f = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 100 }],
      inputs: [],
    });
    expect(find(alerts({ forecast: f }).visible, 'cash-low')!.link.to).toBe('/forecast');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Unusual spending
// ═════════════════════════════════════════════════════════════════════════════
describe('unusual spending', () => {
  it('flags a category running well above its own normal month', () => {
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -1_200, category: 'Dining' })],
        rates: { Dining: 300 },
      }),
      baselineByCategory: { Dining: 300 },
    });
    const a = find(r.visible, 'unusual-spend')!;
    expect(a.facts.kind === 'unusual-spend' && a.facts.category).toBe('Dining');
    expect(a.facts.kind === 'unusual-spend' && a.facts.multiple).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.unusualRatio);
    expect(a.link.to).toContain('category=Dining');
  });

  it('raises the severity when the spending is extreme', () => {
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -3_000, category: 'Dining' })],
        rates: { Dining: 300 },
      }),
      baselineByCategory: { Dining: 300 },
    });
    const a = find(r.visible, 'unusual-spend')!;
    expect(a.stage).toBe(2);
    expect(a.severity).toBe('warning');
  });

  it('stays quiet on a normal month', () => {
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -150, category: 'Dining' })],
        rates: { Dining: 300 },
      }),
      baselineByCategory: { Dining: 300 },
    });
    expect(r.all).toEqual([]);
  });

  it('ignores a big percentage on a trivial baseline', () => {
    // Four times as much, but four times $10 is not news.
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -40, category: 'Dining' })],
        rates: { Dining: 10 },
      }),
      baselineByCategory: { Dining: 10 },
    });
    expect(r.all).toEqual([]);
  });

  it('ignores a big dollar overshoot that is barely above normal', () => {
    // A few hundred dollars clears the absolute floor easily, but on a $5,000
    // category it is an ordinary month.
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -2_900, category: 'Rent' })],
        rates: { Rent: 5_000 },
      }),
      baselineByCategory: { Rent: 5_000 },
    });
    expect(r.all).toEqual([]);
  });

  it('does not repeat news a budget alert already delivered', () => {
    // Groceries is both over its cap AND above its usual — one alert, not two.
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ category: 'Groceries', limit_amount: 300 })],
        transactions: [tx({ amount: -1_500, category: 'Groceries' })],
        rates: { Groceries: 300 },
      }),
      baselineByCategory: { Groceries: 300 },
    });
    expect(kinds(r.visible)).toEqual(['budget-limit']);
  });

  it('still flags an unusual category that has a budget it is nowhere near', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ category: 'Dining', limit_amount: 50_000 })],
        transactions: [tx({ amount: -1_200, category: 'Dining' })],
        rates: { Dining: 300 },
      }),
      baselineByCategory: { Dining: 300 },
    });
    expect(kinds(r.visible)).toEqual(['unusual-spend']);
  });

  it('matches the baseline case-insensitively', () => {
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -1_200, category: 'Dining' })],
        rates: { Dining: 300 },
      }),
      baselineByCategory: { dining: 300 },
    });
    expect(find(r.visible, 'unusual-spend')).toBeTruthy();
  });

  it('says nothing when there is no history to compare against', () => {
    const r = alerts({
      budget: budgetReport({ transactions: [tx({ amount: -1_200, category: 'Dining' })] }),
    });
    expect(r.all).toEqual([]);
  });

  it('is month-scoped, so it re-arms next month', () => {
    const r = alerts({
      budget: budgetReport({
        transactions: [tx({ amount: -1_200, category: 'Dining' })],
        rates: { Dining: 300 },
      }),
      baselineByCategory: { Dining: 300 },
    });
    expect(r.all[0].key).toBe(`unusual-spend:${MONTH}:dining`);
  });

  it('does not fire on day two of the month', () => {
    // A normal week's spending bought on the 1st is a 50×-a-day run rate. The
    // projection damps that but cannot remove it (it may never fall below what
    // is already spent), so it projects ~1.6× a normal month and would fire.
    // Two days is simply not enough month to judge.
    const early = {
      asOf: '2026-08-02',
      transactions: [tx({ amount: -100, date: '2026-08-01', category: 'Dining' })],
      rates: { Dining: 300 },
    };
    expect(alerts({ budget: budgetReport(early), baselineByCategory: { Dining: 300 } }).all).toEqual([]);

    // The very same spending pattern, judged once the month has enough in it to
    // judge, is unremarkable — which is the point.
    const later = alerts({
      budget: budgetReport({ ...early, asOf: '2026-08-12' }),
      baselineByCategory: { Dining: 300 },
    });
    expect(later.all).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Repeats — the same condition must not accumulate
// ═════════════════════════════════════════════════════════════════════════════
describe('repeated builds', () => {
  const busy = () => ({
    budget: budgetReport({
      budgets: [budget({ limit_amount: 300 })],
      transactions: [tx({ amount: -500 })],
      rates: { Groceries: 500 },
    }),
    goals: goalReport({ goals: [goal()], perMonth: 0 }),
    forecast: forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 100 }],
      inputs: [outflow(900)],
    }),
  });

  it('produces the identical set every time it runs', () => {
    const first = alerts(busy());
    const second = alerts(busy());
    const third = alerts(busy());
    expect(first.all.map(a => a.key)).toEqual(second.all.map(a => a.key));
    expect(second.all.map(a => a.key)).toEqual(third.all.map(a => a.key));
    expect(new Set(first.all.map(a => a.key)).size).toBe(first.all.length);
  });

  it('returns a stable order across builds', () => {
    expect(alerts(busy()).visible.map(a => a.key))
      .toEqual(alerts(busy()).visible.map(a => a.key));
  });

  it('puts critical before warning before info', () => {
    const sorted = sortAlerts([
      { severity: 'info', kind: 'unusual-spend', key: 'c', stage: 1 } as Alert,
      { severity: 'warning', kind: 'goal-behind', key: 'b', stage: 1 } as Alert,
      { severity: 'critical', kind: 'cash-low', key: 'a', stage: 2 } as Alert,
    ]);
    expect(sorted.map(a => a.key)).toEqual(['a', 'b', 'c']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Dismissals and threshold crossings
// ═════════════════════════════════════════════════════════════════════════════
describe('dismissals', () => {
  const overBy = (spent: number, rate = spent, asOf = TODAY) => budgetReport({
    asOf,
    budgets: [budget({ limit_amount: 500 })],
    transactions: [tx({ amount: -spent })],
    rates: { Groceries: rate },
  });

  const state = (key: string, dismissedStage: number | null, readStage: number | null = null): AlertStateInput =>
    ({ key, dismissedStage, readStage });

  const KEY = `budget-limit:${MONTH}:groceries`;

  it('hides an alert dismissed at its current stage', () => {
    const r = alerts({ budget: overBy(560), states: [state(KEY, 2)] });
    expect(r.all).toHaveLength(1);
    expect(r.all[0].dismissed).toBe(true);
    expect(r.visible).toEqual([]);
  });

  it('keeps it hidden while the situation does not get worse', () => {
    // 560 → 600 is still stage 2. Dismissed means dismissed.
    const r = alerts({ budget: overBy(600), states: [state(KEY, 2)] });
    expect(r.visible).toEqual([]);
  });

  it('brings it back once the next threshold is crossed', () => {
    // Past 125% of the cap — a materially worse situation than the one dismissed.
    const r = alerts({ budget: overBy(700), states: [state(KEY, 2)] });
    expect(r.visible).toHaveLength(1);
    expect(r.visible[0].stage).toBe(3);
  });

  it('brings back a nearing-limit alert once the cap is actually passed', () => {
    const LATE = '2026-08-30';
    const near = alerts({ budget: overBy(430, 450, LATE) });
    expect(near.visible[0].stage).toBe(1);

    const dismissed = alerts({ budget: overBy(430, 450, LATE), states: [state(KEY, 1)] });
    expect(dismissed.visible).toEqual([]);

    const over = alerts({ budget: overBy(560), states: [state(KEY, 1)] });
    expect(over.visible).toHaveLength(1);
    expect(over.visible[0].stage).toBe(2);
  });

  it('does not let a dismissal leak between different alerts', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [
          budget({ id: 'b-g', category: 'Groceries', limit_amount: 300 }),
          budget({ id: 'b-d', category: 'Dining', limit_amount: 300 }),
        ],
        transactions: [
          tx({ amount: -400, category: 'Groceries' }),
          tx({ amount: -400, category: 'Dining' }),
        ],
        rates: { Groceries: 400, Dining: 400 },
      }),
      states: [state(`budget-limit:${MONTH}:groceries`, 3)],
    });
    expect(r.visible).toHaveLength(1);
    expect(r.visible[0].key).toBe(`budget-limit:${MONTH}:dining`);
  });

  it('does not let a dismissal leak between months', () => {
    // Same budget, same overspend, previous month's dismissal.
    const r = alerts({
      budget: overBy(560),
      states: [state('budget-limit:2026-07:groceries', 3)],
    });
    expect(r.visible).toHaveLength(1);
  });

  it('lets a goal dismissal expire when the goal stops being funded at all', () => {
    const atRisk = alerts({ goals: goalReport({ goals: [goal()], perMonth: 400 }) });
    expect(atRisk.visible[0].stage).toBe(1);

    const hidden = alerts({
      goals: goalReport({ goals: [goal()], perMonth: 400 }),
      states: [state('goal-behind:g1', 1)],
    });
    expect(hidden.visible).toEqual([]);

    const worse = alerts({
      goals: goalReport({ goals: [goal()], perMonth: 0 }),
      states: [state('goal-behind:g1', 1)],
    });
    expect(worse.visible).toHaveLength(1);
    expect(worse.visible[0].stage).toBe(2);
  });

  it('brings a dismissed cash warning back when the balance turns negative', () => {
    const low = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 3_000 }],
      inputs: [outflow(900)],
    });
    expect(alerts({ forecast: low, states: [state('cash-low', 1)] }).visible).toEqual([]);

    const negative = forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 1_000 }],
      inputs: [outflow(2_000)],
    });
    expect(alerts({ forecast: negative, states: [state('cash-low', 1)] }).visible).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Read state
// ═════════════════════════════════════════════════════════════════════════════
describe('read state', () => {
  const over = budgetReport({
    budgets: [budget({ limit_amount: 500 })],
    transactions: [tx({ amount: -560 })],
    rates: { Groceries: 560 },
  });
  const KEY = `budget-limit:${MONTH}:groceries`;

  it('counts an alert nobody has seen as unread', () => {
    const r = alerts({ budget: over });
    expect(r.visible[0].unread).toBe(true);
    expect(r.unreadCount).toBe(1);
  });

  it('stops counting it once it has been read at that stage', () => {
    const r = alerts({ budget: over, states: [{ key: KEY, dismissedStage: null, readStage: 2 }] });
    expect(r.visible[0].unread).toBe(false);
    expect(r.unreadCount).toBe(0);
  });

  it('becomes unread again when the situation worsens', () => {
    const worse = budgetReport({
      budgets: [budget({ limit_amount: 500 })],
      transactions: [tx({ amount: -700 })],
      rates: { Groceries: 700 },
    });
    const r = alerts({ budget: worse, states: [{ key: KEY, dismissedStage: null, readStage: 2 }] });
    expect(r.visible[0].unread).toBe(true);
    expect(r.unreadCount).toBe(1);
  });

  it('never counts a dismissed alert as unread news', () => {
    const r = alerts({ budget: over, states: [{ key: KEY, dismissedStage: 2, readStage: null }] });
    expect(r.unreadCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Resolved conditions
// ═════════════════════════════════════════════════════════════════════════════
describe('resolved alerts', () => {
  it('stops producing an alert whose condition has cleared', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 5_000 })],
        transactions: [tx({ amount: -100 })],
        rates: { Groceries: 200 },
      }),
    });
    expect(r.all).toEqual([]);
  });

  it('reports the stored state of a cleared condition so it can be dropped', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 5_000 })],
        transactions: [tx({ amount: -100 })],
        rates: { Groceries: 200 },
      }),
      states: [{ key: `budget-limit:${MONTH}:groceries`, dismissedStage: 2, readStage: 2 }],
    });
    expect(r.resolvedKeys).toEqual([`budget-limit:${MONTH}:groceries`]);
  });

  it('leaves the state of a still-firing alert alone', () => {
    const KEY = `budget-limit:${MONTH}:groceries`;
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -560 })],
        rates: { Groceries: 560 },
      }),
      states: [{ key: KEY, dismissedStage: 2, readStage: null }],
    });
    expect(r.resolvedKeys).toEqual([]);
  });

  it('reports a stale state even when other alerts are firing', () => {
    const r = alerts({
      budget: budgetReport({
        budgets: [budget({ limit_amount: 500 })],
        transactions: [tx({ amount: -560 })],
        rates: { Groceries: 560 },
      }),
      states: [
        { key: `budget-limit:${MONTH}:groceries`, dismissedStage: 2, readStage: null },
        { key: 'goal-behind:long-deleted', dismissedStage: 1, readStage: null },
        { key: 'cash-low', dismissedStage: 2, readStage: null },
      ],
    });
    expect(r.resolvedKeys.sort()).toEqual(['cash-low', 'goal-behind:long-deleted']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Everything at once
// ═════════════════════════════════════════════════════════════════════════════
describe('a thoroughly bad month', () => {
  /** Over budget, heading over another, two starved goals, no cash, a blow-out. */
  const everything = (states?: AlertStateInput[]) => alerts({
    budget: budgetReport({
      budgets: [
        budget({ id: 'ov', scope: 'overall', category: null, limit_amount: 2_000 }),
        budget({ id: 'b-g', category: 'Groceries', limit_amount: 300 }),
        budget({ id: 'b-t', category: 'Transport', limit_amount: 600 }),
      ],
      transactions: [
        tx({ amount: -900, category: 'Groceries' }),
        tx({ amount: -300, category: 'Transport' }),
        tx({ amount: -1_400, category: 'Dining' }),
      ],
      rates: { Groceries: 900, Transport: 900, Dining: 300 },
    }),
    goals: goalReport({ goals: [goal(), goal({ id: 'g2', name: 'Car', targetAmount: 8_000 })], perMonth: 0 }),
    forecast: forecast({
      accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 500 }],
      inputs: [outflow(1_500)],
    }),
    baselineByCategory: { Dining: 300 },
    states,
  });

  it('raises one alert per distinct problem, worst first', () => {
    const r = everything();
    expect(new Set(r.visible.map(a => a.key)).size).toBe(r.visible.length);

    const severities = r.visible.map(a => a.severity);
    const rank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(rank[severities[i - 1]]);
    }

    expect(new Set(kinds(r.visible))).toEqual(new Set([
      'budget-limit', 'budget-projected-over', 'goal-behind', 'cash-low', 'unusual-spend',
    ]));
  });

  it('gives every alert a link to the thing it is about', () => {
    for (const a of everything().visible) {
      expect(a.link.to.startsWith('/')).toBe(true);
      expect(a.link.label.length).toBeGreaterThan(0);
    }
  });

  it('dismissing one leaves the rest exactly as they were', () => {
    const before = everything();
    const target = before.visible[0];

    const after = everything([{ key: target.key, dismissedStage: target.stage, readStage: null }]);

    expect(after.visible.map(a => a.key)).toEqual(
      before.visible.filter(a => a.key !== target.key).map(a => a.key),
    );
    expect(after.resolvedKeys).toEqual([]);
  });
});
