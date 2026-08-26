/**
 * Phase 9.2 — the what-if engine.
 *
 * Everything here is synthetic and pure: no store, no network, no dates read
 * from the clock. What is being tested is the ONE job this module has — turning
 * a hypothetical into the inputs the four real engines take, and comparing what
 * they say afterwards with what they said before.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveChange, resolveScenario, activeChanges,
  scenarioForecastInputs, scenarioBudgetProjection,
  scenarioLoanAdjustments, scenarioGoalCommitments,
  buildScenarioComparison, applicability, applicableChanges, emptyChange,
  SCENARIO_KINDS, SCENARIO_KIND_LABELS,
  type Scenario, type ScenarioBaselines, type ScenarioChange, type ResolvedChange,
} from './scenario';
import type { CashFlowForecast, HorizonTotal, RecurringInput } from './cashFlowForecast';
import type { BudgetReport, BudgetReportLine } from './budgeting';
import type { GoalLine, GoalReport } from './savingsGoals';
import type { LoanReport, LoanRow } from './loanEngine';

const ASOF = '2026-08-24';
const MONTH = '2026-08';

const BASE: ScenarioBaselines = {
  asOf: ASOF,
  month: MONTH,
  monthlyIncomeById: { 'inc-1': 6_000, 'inc-2': 1_000 },
  monthlyIncomeTotal: 7_000,
  monthlySpendByCategory: { Groceries: 900, Dining: 400 },
  monthlyDiscretionary: 1_300,
  loans: [
    {
      id: 'loan-1', name: 'Home loan', frequency: 'fortnightly', nextDueDate: '2026-09-01',
      repayment: 1_800, balance: 500_000, offsetBalance: 20_000, offsetIsLinked: false,
    },
    {
      id: 'loan-2', name: 'Car loan', frequency: 'monthly', nextDueDate: null,
      repayment: 0, balance: 18_000, offsetBalance: 0, offsetIsLinked: true,
    },
  ],
  goals: [{ id: 'goal-1', name: 'House deposit' }, { id: 'goal-2', name: 'Japan trip' }],
};

function change(c: Partial<ScenarioChange> & { kind: ScenarioChange['kind']; id: string }): ScenarioChange {
  return c as ScenarioChange;
}

function scenarioOf(...changes: ScenarioChange[]): Scenario {
  return { id: 's1', name: 'Test', changes };
}

// ── A lump sum straight off a loan ──────────────────────────────────────────

describe('one payment straight off a loan', () => {
  const lump = (amount: number, loanId = 'loan-2') =>
    resolveChange(change({ id: 'c1', kind: 'lump-sum', loanId, amount }), BASE);

  it('comes off the balance and out of the account, once', () => {
    const r = lump(1_000);
    expect(r.loan).toEqual({ loanId: 'loan-2', extraPerPeriod: 0, offsetDelta: 0, balanceDelta: -1_000 });
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0].amount).toBe(-1_000);
    expect(r.inputs[0].frequency).toBe('once');
    // Not a rate: a single payment never shows as a monthly cost.
    expect(r.monthlyCash).toBe(0);
  });

  it('is dated tomorrow, because today is already in the opening balance', () => {
    expect(lump(1_000).inputs[0].anchorDate).toBe('2026-08-25');
  });

  it('cannot pay off more than is owed, and says so', () => {
    const r = lump(25_000);
    expect(r.loan!.balanceDelta).toBe(-18_000);
    expect(r.inputs[0].amount).toBe(-18_000);
    expect(r.notes.some(n => n.kind === 'warning' && /nowhere to go/i.test(n.text))).toBe(true);
  });

  it('is left out when the loan has gone', () => {
    const r = resolveChange(change({ id: 'c1', kind: 'lump-sum', loanId: 'gone', amount: 500 }), BASE);
    expect(r.loan).toBeNull();
    expect(r.notes[0].kind).toBe('gap');
  });

  it('counts as money out once, not as a monthly change', () => {
    const resolved = resolveScenario(
      scenarioOf(change({ id: 'c1', kind: 'lump-sum', loanId: 'loan-2', amount: 1_000 })),
      BASE,
    );
    expect(scenarioLoanAdjustments(resolved).get('loan-2'))
      .toEqual({ extraPerPeriod: 0, offsetDelta: 0, balanceDelta: -1_000 });
  });

  it('can be written: it takes money off the balance on file', () => {
    const check = applicability(
      change({ id: 'c1', kind: 'lump-sum', loanId: 'loan-2', amount: 1_000 }), BASE,
    );
    expect(check.canApply).toBe(true);
    expect(check.description).toMatch(/17,000 owing/);
  });
});

// ── Resolving a change into dollars ─────────────────────────────────────────

describe('resolving a change into concrete dollars', () => {
  it('reads a percentage pay rise against that income stream, not the total', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'income', incomeId: 'inc-1', mode: 'percent', value: 10, startDate: null,
    }), BASE);
    expect(r.monthlyCash).toBe(600); // 10% of 6,000 — not of 7,000
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0].amount).toBe(600);
    expect(r.inputs[0].frequency).toBe('monthly');
  });

  it('reads a percentage with no stream named against every recurring income', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'income', incomeId: null, mode: 'percent', value: 10, startDate: null,
    }), BASE);
    expect(r.monthlyCash).toBe(700);
  });

  it('a pay cut is money out', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'income', incomeId: 'inc-1', mode: 'percent', value: -20, startDate: null,
    }), BASE);
    expect(r.monthlyCash).toBe(-1_200);
    expect(r.inputs[0].amount).toBe(-1_200);
  });

  it('refuses a percentage it has no baseline for, and says why', () => {
    const bare: ScenarioBaselines = { ...BASE, monthlyIncomeById: {}, monthlyIncomeTotal: 0 };
    const r = resolveChange(change({
      id: 'c1', kind: 'income', incomeId: null, mode: 'percent', value: 10, startDate: null,
    }), bare);
    expect(r.monthlyCash).toBe(0);
    expect(r.inputs).toEqual([]);
    expect(r.notes.some(n => n.kind === 'gap')).toBe(true);
    expect(r.notes[0].text).toMatch(/amount instead/i);
  });

  it('never guesses a typical month it has not learned', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'spending', category: 'Travel', mode: 'percent', value: -10,
    }), BASE);
    expect(r.monthlyCash).toBe(0);
    expect(r.rateDelta).toBeNull();
    expect(r.notes[0].kind).toBe('gap');
    expect(r.notes[0].text).toContain('Travel');
  });

  it('turns "10% less on groceries" into ONE dollar figure both engines see', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'spending', category: 'Groceries', mode: 'percent', value: -10,
    }), BASE);
    expect(r.rateDelta).toEqual({ category: 'Groceries', amount: -90 });
    expect(r.monthlyCash).toBe(90);          // spending less leaves more cash
    expect(r.inputs[0].amount).toBe(90);      // and the same 90 reaches the forecast
    expect(r.inputs[0].category).toBe('Groceries');
  });

  it('spending with no category means everyday variable spending', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'spending', category: null, mode: 'percent', value: -10,
    }), BASE);
    expect(r.monthlyCash).toBe(130); // 10% of 1,300 discretionary
    expect(r.rateDelta).toEqual({ category: null, amount: -130 });
  });

  it('a new recurring expense is scheduled money this month, not a learned rate', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'recurring-expense', name: 'Gym', amount: 60,
      frequency: 'monthly', category: 'Health', startDate: '2026-08-28',
    }), BASE);
    expect(r.monthlyCash).toBe(-60);
    expect(r.inputs[0].amount).toBe(-60);
    // It cannot be in the rate: the rate was learned from history, and this
    // expense has none. Counting it both ways would double it.
    expect(r.rateDelta).toBeNull();
    expect(r.scheduled).toEqual({ category: 'Health', amount: 60 });
  });

  it('counts the charges that actually land this month, not a monthly average', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'recurring-expense', name: 'Cleaner', amount: 100,
      frequency: 'weekly', category: 'Home', startDate: '2026-08-25',
    }), BASE);
    // Seven days of August are left, so the cleaner comes once — not the
    // ~$304 a month a weekly charge averages out to.
    expect(r.scheduled?.amount).toBe(100);
    expect(r.monthlyCash).toBeCloseTo(-434.82, 2);
  });

  it('a purchase in a later month still reaches the cash projection, not this budget', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'one-off', name: 'Car', amount: 9_000, date: '2026-11-01', category: 'Transport',
    }), BASE);
    expect(r.inputs[0].amount).toBe(-9_000);
    expect(r.inputs[0].frequency).toBe('once');
    expect(r.scheduled).toBeNull();
    // A one-off is an event, not a rate — it must not show up as a monthly cost.
    expect(r.monthlyCash).toBe(0);
  });

  it('says so when a purchase is dated in the past', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'one-off', name: 'Sofa', amount: 2_000, date: '2026-08-01', category: null,
    }), BASE);
    expect(r.notes.some(n => n.kind === 'warning' && /already passed/i.test(n.text))).toBe(true);
  });

  it('a windfall is money in', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'one-off', name: 'Tax refund', amount: -3_000, date: '2026-09-01', category: null,
    }), BASE);
    expect(r.inputs[0].amount).toBe(3_000);
  });

  it('prices an extra repayment as cash out at the loan cadence', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 300,
    }), BASE);
    expect(r.loan).toEqual({ loanId: 'loan-1', extraPerPeriod: 300, offsetDelta: 0, balanceDelta: 0 });
    expect(r.monthlyCash).toBeCloseTo(-652.23, 2); // fortnightly → 30.4375/14 periods
    // The loan is already in the forecast, so there is nothing to add beside it.
    expect(r.inputs).toEqual([]);
  });

  it('projects an extra repayment on a loan the forecast cannot see, from today', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'loan-2', amountPerPeriod: 200,
    }), BASE);
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0].anchorDate).toBe(ASOF);
    expect(r.notes.some(n => /no next due date/i.test(n.text))).toBe(true);
  });

  it('projects an extra repayment on a loan with no repayment amount on file', () => {
    // The forecast only carries a loan that has BOTH a due date and an amount.
    // Without the amount there is no line to fold the extra into, and it would
    // otherwise cost the user nothing at all.
    const base: ScenarioBaselines = {
      ...BASE,
      loans: [{ ...BASE.loans[0], repayment: 0 }],
    };
    const r = resolveChange(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 200,
    }), base);
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0].amount).toBe(-200);
    expect(r.notes.some(n => /repayment amount/i.test(n.text))).toBe(true);
  });

  it('leaves the cash projection alone when money only moves into an offset', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'offset', loanId: 'loan-1', delta: 10_000,
    }), BASE);
    expect(r.monthlyCash).toBe(0);
    expect(r.inputs).toEqual([]);
    expect(r.loan).toEqual({ loanId: 'loan-1', extraPerPeriod: 0, offsetDelta: 10_000, balanceDelta: 0 });
    expect(r.notes.some(n => /still your money/i.test(n.text))).toBe(true);
  });

  it('warns when an offset addition is past what the loan can use', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'offset', loanId: 'loan-1', delta: 600_000,
    }), BASE);
    expect(r.notes.some(n => n.kind === 'warning' && /saves nothing/i.test(n.text))).toBe(true);
  });

  it('leaves the cash projection alone when money moves into a goal', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'savings-contribution', goalId: 'goal-1', monthlyAmount: 500,
    }), BASE);
    expect(r.monthlyCash).toBe(0);
    expect(r.goal).toEqual({ goalId: 'goal-1', monthlyAmount: 500 });
  });

  it('drops a change pointing at a record that is gone, and says so', () => {
    const r = resolveChange(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'nope', amountPerPeriod: 300,
    }), BASE);
    expect(r.loan).toBeNull();
    expect(r.notes[0].kind).toBe('gap');
  });

  it('leaves unticked changes out of the run entirely', () => {
    const s = scenarioOf(
      change({ id: 'c1', kind: 'spending', category: 'Groceries', mode: 'percent', value: -10 }),
      change({ id: 'c2', kind: 'spending', category: 'Dining', mode: 'percent', value: -50, enabled: false }),
    );
    expect(activeChanges(s).map(c => c.id)).toEqual(['c1']);
    expect(resolveScenario(s, BASE)).toHaveLength(1);
  });
});

// ── Feeding the engines ─────────────────────────────────────────────────────

describe('feeding the engines', () => {
  const loanInput: RecurringInput = {
    id: 'loan:loan-1', sourceType: 'loan', name: 'Home loan', amount: -1_800,
    frequency: 'fortnightly', anchorDate: '2026-09-01', accountId: null, confidence: 0.95,
  };

  it('folds an extra repayment into the loan line rather than beside it', () => {
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 300,
    })), BASE);
    const inputs = scenarioForecastInputs([loanInput], resolved);
    // One loan, one line — two would read as two payments.
    expect(inputs.filter(i => i.sourceType === 'loan')).toHaveLength(1);
    expect(inputs[0].amount).toBe(-2_100);
  });

  it('composes two changes on the same loan', () => {
    const resolved = resolveScenario(scenarioOf(
      change({ id: 'c1', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 300 }),
      change({ id: 'c2', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 200 }),
      change({ id: 'c3', kind: 'offset', loanId: 'loan-1', delta: 5_000 }),
    ), BASE);
    expect(scenarioLoanAdjustments(resolved).get('loan-1'))
      .toEqual({ extraPerPeriod: 500, offsetDelta: 5_000, balanceDelta: 0 });
    expect(scenarioForecastInputs([loanInput], resolved)[0].amount).toBe(-2_300);
  });

  it('leaves every other forecast input untouched', () => {
    const other: RecurringInput = {
      id: 'sub:s1', sourceType: 'subscription', name: 'Netflix', amount: -20,
      frequency: 'monthly', anchorDate: '2026-09-02', accountId: null, confidence: 1,
    };
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 300,
    })), BASE);
    expect(scenarioForecastInputs([other, loanInput], resolved)[0]).toBe(other);
  });

  it('moves a budget rate by the resolved dollars, matching the category case-insensitively', () => {
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'spending', category: 'groceries', mode: 'amount', value: -200,
    })), BASE);
    const p = scenarioBudgetProjection({ byCategory: { Groceries: 900, Dining: 400 }, overall: 1_300 }, resolved);
    expect(p.monthlyRateByCategory.Groceries).toBe(700);
    expect(p.monthlyRateByCategory.Dining).toBe(400);
    expect(p.overallMonthlyRate).toBe(1_100);
  });

  it('never lets a cut drive a rate below zero', () => {
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'spending', category: 'Dining', mode: 'amount', value: -5_000,
    })), BASE);
    const p = scenarioBudgetProjection({ byCategory: { Dining: 400 }, overall: 400 }, resolved);
    expect(p.monthlyRateByCategory.Dining).toBe(0);
    expect(p.overallMonthlyRate).toBe(0);
  });

  it('sums scheduled outflows across changes, per category and overall', () => {
    const resolved = resolveScenario(scenarioOf(
      change({ id: 'c1', kind: 'one-off', name: 'Tyres', amount: 800, date: '2026-08-30', category: 'Transport' }),
      change({ id: 'c2', kind: 'one-off', name: 'Service', amount: 400, date: '2026-08-29', category: 'Transport' }),
    ), BASE);
    const p = scenarioBudgetProjection({ byCategory: {}, overall: 0 }, resolved);
    expect(p.scheduledByCategory.Transport).toBe(1_200);
    expect(p.scheduledOverall).toBe(1_200);
  });

  it('sums goal commitments so two changes to one goal compose', () => {
    const resolved = resolveScenario(scenarioOf(
      change({ id: 'c1', kind: 'savings-contribution', goalId: 'goal-1', monthlyAmount: 300 }),
      change({ id: 'c2', kind: 'savings-contribution', goalId: 'goal-1', monthlyAmount: 200 }),
      change({ id: 'c3', kind: 'savings-contribution', goalId: 'goal-2', monthlyAmount: 100 }),
    ), BASE);
    expect(scenarioGoalCommitments(resolved)).toEqual({ 'goal-1': 500, 'goal-2': 100 });
  });
});

// ── Before vs after ─────────────────────────────────────────────────────────

function horizon(days: number, o: Partial<HorizonTotal> = {}): HorizonTotal {
  return {
    days, date: '2026-09-23', inflow: 7_000, outflow: -6_000, net: 1_000,
    openingBalance: 10_000, projectedBalance: 11_000, lowestBalance: 9_000,
    lowestDate: '2026-09-01', ...o,
  };
}

function forecastOf(...horizons: HorizonTotal[]): CashFlowForecast {
  return {
    asOf: ASOF, horizonDays: horizons.map(h => h.days), openingTotal: 10_000,
    horizons, accounts: [], events: [], suppressed: [],
  };
}

function loanRow(o: Partial<LoanRow> = {}): LoanRow {
  return {
    id: 'loan-1', name: 'Home loan', type: 'mortgage', lender: null,
    balance: 500_000, originalAmount: 600_000, repaidPercent: 16, offsetBalance: 20_000,
    offsetAccount: null, offsetIsLinked: false, offsetLinkBroken: false, effectiveBalance: 480_000,
    redrawAvailable: 0, rate: 6, rateType: 'variable', fixedUntil: null, revertRate: null,
    upcomingRateChanges: [], frequency: 'fortnightly', repayment: 1_800, extraRepayment: 0,
    periodOutlay: 1_800, nextDueDate: '2026-09-01', interestOnly: false, interestOnlyUntil: null,
    repaymentAfterInterestOnly: null, interestThisPeriod: 1_100, interestPerYear: 28_800,
    offsetSavingPerYear: 1_200, offsetSavingPerMonth: 100,
    projection: {
      payoffDate: '2049-01-01', periodsToPayoff: 585, monthsToPayoff: 269,
      totalInterest: 400_000, totalPaid: 900_000, neverPaysOff: false, shortfall: 0, truncated: false,
    },
    monthsToPayoff: 269, payoffDate: '2049-01-01', contractEndDate: null,
    contractedRemainingMonths: null, monthsAheadOfContract: null, contractedRepayment: null,
    countsTowardNetWorth: true, property: null, events: [], ...o,
  };
}

function loanReportOf(...rows: LoanRow[]): LoanReport {
  return {
    rows,
    totals: {
      balance: 0, netWorthDebt: 0, offsetBalance: 0, effectiveBalance: 0, redrawAvailable: 0,
      interestPerYear: 0, monthlyOutlay: 0, debtFreeDate: null, count: rows.length,
    },
  };
}

function budgetLine(o: Partial<BudgetReportLine> = {}): BudgetReportLine {
  return {
    id: 'b1', key: 'category:groceries', scope: 'category', name: 'Groceries', category: 'Groceries',
    baseLimit: 800, rolloverIn: 0, effectiveLimit: 800, spent: 400, remaining: 400,
    percentUsed: 50, projected: 780, projectedRemaining: 20, rollover: false, rolloverOut: 0,
    startMonth: null, status: 'under', ...o,
  };
}

function budgetReportOf(...categories: BudgetReportLine[]): BudgetReport {
  return {
    month: MONTH, asOf: ASOF, daysInMonth: 31, daysElapsed: 24, overall: null,
    categories, unbudgeted: [], unbudgetedSpend: 0,
    totals: { budgeted: 0, spent: 0, remaining: 0, projected: 0 },
    spendByCategory: {}, totalSpent: 0, interestSpent: 0,
  };
}

function goalLine(o: Partial<GoalLine> = {}): GoalLine {
  return {
    id: 'goal-1', name: 'House deposit', targetAmount: 60_000, targetDate: '2027-12-01',
    saved: 20_000, linkedSaved: 20_000, manualSaved: 0, reflectedTotal: 0,
    remaining: 40_000, progressPct: 33, daysRemaining: 464, requiredPerWeek: 600,
    requiredPerMonth: 2_600, allocatedPerMonth: 500, shortfallPerMonth: 2_100,
    projectedDate: '2033-01-01', capacityKnown: true, status: 'at-risk',
    depositedTotal: 0, withdrawnTotal: 0, contributionCount: 0, brokenLinks: [], ...o,
  };
}

function goalReportOf(...lines: GoalLine[]): GoalReport {
  return {
    asOf: ASOF, lines, monthlyCapacity: 500, totalRequiredPerMonth: 2_600,
    unallocatedPerMonth: 0, committedPerMonth: 0, shortfallPerMonth: 2_100,
    totalTarget: 60_000, totalSaved: 20_000, completeCount: 0,
  };
}

function compare(
  scenario: Scenario,
  resolved: ResolvedChange[],
  before: Parameters<typeof buildScenarioComparison>[0]['before'],
  after: Parameters<typeof buildScenarioComparison>[0]['after'],
) {
  return buildScenarioComparison({ scenario, resolved, asOf: ASOF, month: MONTH, before, after });
}

describe('putting the two runs side by side', () => {
  const empty = {
    forecast: forecastOf(horizon(30), horizon(90)),
    loans: loanReportOf(),
    budgets: budgetReportOf(),
    goals: goalReportOf(),
  };

  it('reports a scenario that moved nothing as having moved nothing', () => {
    const c = compare(scenarioOf(), [], empty, empty);
    expect(c.unchanged).toBe(true);
    expect(c.cash.every(l => l.balanceChange === 0)).toBe(true);
  });

  it('reads the cash change off the forecast, horizon by horizon', () => {
    const after = {
      ...empty,
      forecast: forecastOf(
        horizon(30, { net: 1_600, projectedBalance: 11_600, lowestBalance: 9_600 }),
        horizon(90, { net: 2_800, projectedBalance: 12_800, lowestBalance: 9_400 }),
      ),
    };
    const c = compare(scenarioOf(), [], empty, after);
    expect(c.cash[0].balanceChange).toBe(600);
    expect(c.cash[1].netChange).toBe(1_800);
    expect(c.unchanged).toBe(false);
  });

  it('flags the horizon a scenario takes below zero', () => {
    const after = { ...empty, forecast: forecastOf(horizon(30, { lowestBalance: -400 }), horizon(90)) };
    const c = compare(scenarioOf(), [], empty, after);
    expect(c.cash[0].newlyNegative).toBe(true);
    expect(c.cash[1].newlyNegative).toBe(false);
  });

  it('reports what an extra repayment buys, in months and in interest', () => {
    const before = { ...empty, loans: loanReportOf(loanRow()) };
    const after = {
      ...empty,
      loans: loanReportOf(loanRow({
        periodOutlay: 2_100, extraRepayment: 300, monthsToPayoff: 221, payoffDate: '2045-01-01',
        projection: { ...loanRow().projection, totalInterest: 310_000, monthsToPayoff: 221, payoffDate: '2045-01-01' },
      })),
    };
    const c = compare(scenarioOf(), [], before, after);
    expect(c.loans).toHaveLength(1);
    expect(c.loans[0].monthsSaved).toBe(48);
    expect(c.loans[0].interestSaved).toBe(90_000);
    expect(c.loans[0].outlayChange).toBe(300);
  });

  it('keeps a loan the scenario named even when the loan could not use the money', () => {
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'extra-repayment', loanId: 'loan-1', amountPerPeriod: 300,
    })), BASE);
    const both = { ...empty, loans: loanReportOf(loanRow()) };
    const c = compare(scenarioOf(), resolved, both, both);
    // Nothing moved, but the user asked about this loan — silence would read as
    // "no answer" rather than "it changes nothing".
    expect(c.loans.map(l => l.id)).toEqual(['loan-1']);
    expect(c.loans[0].interestSaved).toBe(0);
  });

  it('leaves out loans the scenario neither named nor moved', () => {
    const both = { ...empty, loans: loanReportOf(loanRow(), loanRow({ id: 'loan-2', name: 'Car loan' })) };
    expect(compare(scenarioOf(), [], both, both).loans).toEqual([]);
  });

  it('says which budget the scenario pushes over its cap', () => {
    const before = { ...empty, budgets: budgetReportOf(budgetLine()) };
    const after = {
      ...empty,
      budgets: budgetReportOf(budgetLine({ projected: 980, projectedRemaining: -180, status: 'at-risk' })),
    };
    const c = compare(scenarioOf(), [], before, after);
    expect(c.budgets).toHaveLength(1);
    expect(c.budgets[0].projectedChange).toBe(200);
    expect(c.budgets[0].newlyOver).toBe(true);
    expect(c.budgets[0].newlyUnder).toBe(false);
  });

  it('says which budget the scenario brings back inside', () => {
    const before = {
      ...empty,
      budgets: budgetReportOf(budgetLine({ projected: 980, projectedRemaining: -180, status: 'at-risk' })),
    };
    const after = {
      ...empty,
      budgets: budgetReportOf(budgetLine({ projected: 700, projectedRemaining: 100, status: 'under' })),
    };
    expect(compare(scenarioOf(), [], before, after).budgets[0].newlyUnder).toBe(true);
  });

  it('reports how much sooner a goal lands', () => {
    const before = { ...empty, goals: goalReportOf(goalLine()) };
    const after = {
      ...empty,
      goals: goalReportOf(goalLine({
        allocatedPerMonth: 2_600, shortfallPerMonth: 0, status: 'on-track', projectedDate: '2027-11-01',
      })),
    };
    const c = compare(scenarioOf(), [], before, after);
    expect(c.goals).toHaveLength(1);
    expect(c.goals[0].daysEarlier).toBe(1_888);
    expect(c.goals[0].newlyOnTrack).toBe(true);
  });

  it('reports a goal the scenario knocks off track', () => {
    const before = { ...empty, goals: goalReportOf(goalLine({ status: 'on-track', shortfallPerMonth: 0 })) };
    const after = { ...empty, goals: goalReportOf(goalLine({ status: 'behind', allocatedPerMonth: 0 })) };
    expect(compare(scenarioOf(), [], before, after).goals[0].newlyOffTrack).toBe(true);
  });

  it('adds up the ongoing monthly cost and keeps one-offs out of it', () => {
    const resolved = resolveScenario(scenarioOf(
      change({ id: 'c1', kind: 'income', incomeId: 'inc-1', mode: 'percent', value: 10, startDate: null }),
      change({ id: 'c2', kind: 'recurring-expense', name: 'Gym', amount: 60, frequency: 'monthly', category: null, startDate: null }),
      change({ id: 'c3', kind: 'one-off', name: 'Car', amount: 9_000, date: '2026-11-01', category: null }),
    ), BASE);
    const c = compare(scenarioOf(), resolved, empty, empty);
    expect(c.monthlyCashChange).toBe(540); // +600 pay rise − 60 gym
    expect(c.oneOffTotal).toBe(9_000);
  });

  it('says out loud when the goals are promised more than there is', () => {
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'savings-contribution', goalId: 'goal-1', monthlyAmount: 2_000,
    })), BASE);
    const c = compare(scenarioOf(), resolved, empty, empty); // capacity 500
    expect(c.notes.some(n => n.kind === 'warning' && /has to come from somewhere else/i.test(n.text))).toBe(true);
  });

  it('carries every change note through to the comparison', () => {
    const resolved = resolveScenario(scenarioOf(change({
      id: 'c1', kind: 'offset', loanId: 'loan-1', delta: 10_000,
    })), BASE);
    const c = compare(scenarioOf(), resolved, empty, empty);
    expect(c.notes.some(n => n.changeId === 'c1' && n.kind === 'assumption')).toBe(true);
  });
});

// ── What applying would write ───────────────────────────────────────────────

describe('what applying a change would write', () => {
  it('refuses to type a balance over a linked offset', () => {
    const a = applicability(change({ id: 'c1', kind: 'offset', loanId: 'loan-2', delta: 5_000 }), BASE);
    expect(a.canApply).toBe(false);
    expect(a.description).toMatch(/actually move/i);
  });

  it('writes an unlinked offset', () => {
    expect(applicability(change({ id: 'c1', kind: 'offset', loanId: 'loan-1', delta: 5_000 }), BASE).canApply).toBe(true);
  });

  it('has nothing to write for a decision to spend less', () => {
    const a = applicability(change({ id: 'c1', kind: 'spending', category: 'Dining', mode: 'percent', value: -20 }), BASE);
    expect(a.canApply).toBe(false);
    expect(a.description).toMatch(/decision, not a record/i);
  });

  it('will not invent a contribution for money that has not moved', () => {
    const a = applicability(change({ id: 'c1', kind: 'savings-contribution', goalId: 'goal-1', monthlyAmount: 500 }), BASE);
    expect(a.canApply).toBe(false);
  });

  it('will not record a windfall as a bill', () => {
    const a = applicability(change({ id: 'c1', kind: 'one-off', name: 'Refund', amount: -500, date: '2026-09-01', category: null }), BASE);
    expect(a.canApply).toBe(false);
  });

  it('creates a recurring expense and a one-off bill', () => {
    expect(applicability(change({
      id: 'c1', kind: 'recurring-expense', name: 'Gym', amount: 60, frequency: 'monthly', category: null, startDate: null,
    }), BASE).canApply).toBe(true);
    expect(applicability(change({
      id: 'c2', kind: 'one-off', name: 'Car', amount: 9_000, date: '2026-11-01', category: null,
    }), BASE).canApply).toBe(true);
  });

  it('only edits an income Ledger already has a recurring amount for', () => {
    expect(applicability(change({
      id: 'c1', kind: 'income', incomeId: 'inc-1', mode: 'percent', value: 10, startDate: null,
    }), BASE).canApply).toBe(true);
    expect(applicability(change({
      id: 'c2', kind: 'income', incomeId: null, mode: 'percent', value: 10, startDate: null,
    }), BASE).canApply).toBe(false);
  });

  it('reports on the enabled changes only', () => {
    const s = scenarioOf(
      change({ id: 'c1', kind: 'offset', loanId: 'loan-1', delta: 5_000 }),
      change({ id: 'c2', kind: 'offset', loanId: 'loan-1', delta: 5_000, enabled: false }),
    );
    expect(applicableChanges(s, BASE).map(a => a.changeId)).toEqual(['c1']);
  });
});

describe('the blanks the picker starts from', () => {
  it('has one for every kind, and a label to go with it', () => {
    for (const kind of SCENARIO_KINDS) {
      const blank = emptyChange(kind, 'x', ASOF);
      expect(blank.kind).toBe(kind);
      expect(blank.id).toBe('x');
      expect(SCENARIO_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it('starts a purchase a month out rather than today', () => {
    const blank = emptyChange('one-off', 'x', ASOF);
    expect(blank).toMatchObject({ kind: 'one-off', date: '2026-09-24' });
  });

  it('never touches a record it has not been pointed at', () => {
    // Income and spending blanks carry a sensible starting percentage, so they
    // resolve to a real figure. The ones that need a record — a loan, a goal,
    // an amount — must contribute nothing at all until they have one, or an
    // unfinished row would quietly change the answer.
    for (const kind of SCENARIO_KINDS) {
      const r = resolveChange(emptyChange(kind, 'x', ASOF), BASE);
      expect(r.loan).toBeNull();
      expect(r.goal).toBeNull();
      expect(r.scheduled).toBeNull();
      if (kind !== 'income' && kind !== 'spending') {
        expect(r.inputs).toEqual([]);
        expect(r.monthlyCash).toBe(0);
      }
    }
  });
});
