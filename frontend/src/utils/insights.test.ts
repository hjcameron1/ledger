/**
 * Phase 6.1 — financial insights.
 *
 * The reports feeding these tests are built by the REAL engines
 * (buildBudgetReport / buildLoanReport / buildPropertyReport /
 * buildTaxYearPosition / buildCashFlowForecast) rather than hand-written
 * literals, for the same reason alerts.test.ts does it: faking a report tests
 * this module against my reading of another engine's field semantics, while
 * building one for real tests it against the semantics themselves.
 *
 * What is proved here, in order:
 *
 *   • each kind fires on a real movement and stays quiet on a small one;
 *   • ranking is materiality in dollars, with news above context;
 *   • two descriptions of the same money collapse to the most specific one;
 *   • nothing is claimed about a period the history does not cover;
 *   • a dismissal holds until the situation gets materially worse, and a
 *     resolved observation gives its stored state back to be pruned.
 */

import { describe, it, expect } from 'vitest';
import type { Budget, Transaction, Loan, Property } from '../types';
import { buildBudgetReport } from './budgeting';
import { buildLoanReport } from './loanEngine';
import { buildPropertyReport } from './property';
import { buildTaxYearPosition } from './taxYear';
import { buildCashFlowForecast } from './cashFlowForecast';
import {
  buildInsuranceReport,
  type InsurancePolicyInput, type PremiumRecordInput,
} from './insurance';
import {
  buildInsights, insightWindows, sortInsights, monthlyImpactOf, isInsightKey,
  DEFAULT_INSIGHT_THRESHOLDS,
  type BuildInsightsParams, type Insight, type InsightReport,
  type WindowSpend, type WindowTxn, type RecurringCostInput,
} from './insights';

const TODAY = '2026-08-17';
const { window: WINDOW, previousWindow: PREVIOUS } = insightWindows(TODAY, 30);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const spend = (total: number, byCategory: Record<string, number> = {}): WindowSpend =>
  ({ total, byCategory });

/** The smallest params that build: no dimensions supplied, nothing to say. */
function params(extra: Partial<BuildInsightsParams> = {}): BuildInsightsParams {
  return { asOf: TODAY, window: WINDOW, previousWindow: PREVIOUS, ...extra };
}

const build = (extra: Partial<BuildInsightsParams> = {}): InsightReport =>
  buildInsights(params(extra));

const kinds = (r: InsightReport): string[] => r.visible.map(i => i.kind);
const of = (r: InsightReport, kind: string): Insight | undefined =>
  r.visible.find(i => i.kind === kind);

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

let wseq = 0;
function windowTxn(partial: Partial<WindowTxn> & { amount: number }): WindowTxn {
  wseq += 1;
  return {
    id: partial.id ?? `w${wseq}`,
    date: '2026-08-10',
    category: 'Groceries',
    merchant: 'Merchant',
    ...partial,
  };
}

function loan(partial: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-1',
    user_id: 'u1',
    name: 'Mortgage',
    loan_type: 'mortgage',
    original_amount: 500_000,
    current_balance: 400_000,
    interest_rate: 6,
    minimum_repayment: 2_500,
    repayment_frequency: 'monthly',
    ...partial,
  } as Loan;
}

/** One month of budget history, built by the real budget engine. */
function budgetMonth(month: string, opts: {
  limit?: number;
  spent: number;
  category?: string;
}) {
  const category = opts.category ?? 'Groceries';
  const budgets: Budget[] = [{
    id: 'b1', user_id: 'u1', scope: 'category', category,
    limit_amount: opts.limit ?? 500, period: 'monthly',
    rollover_enabled: false, active: true,
  }];
  const transactions = opts.spent > 0
    ? [tx({ amount: -opts.spent, category, date: `${month}-05`, id: `${month}-tx` })]
    : [];
  return buildBudgetReport({ month, asOf: TODAY, budgets, transactions, userId: 'u1' });
}

// ═════════════════════════════════════════════════════════════════════════════
//  Windows
// ═════════════════════════════════════════════════════════════════════════════
describe('the windows a change is measured over', () => {
  it('ends today and runs back the requested number of days', () => {
    expect(WINDOW).toEqual({ from: '2026-07-19', to: '2026-08-17', days: 30 });
  });

  it('puts the comparison window immediately before it, same length', () => {
    expect(PREVIOUS).toEqual({ from: '2026-06-19', to: '2026-07-18', days: 30 });
  });

  it('never overlaps the two windows', () => {
    expect(PREVIOUS.to < WINDOW.from).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Nothing to say
// ═════════════════════════════════════════════════════════════════════════════
describe('an empty build', () => {
  it('reports nothing rather than throwing', () => {
    const r = build();
    expect(r.all).toEqual([]);
    expect(r.visible).toEqual([]);
    expect(r.unreadCount).toBe(0);
    expect(r.resolvedKeys).toEqual([]);
  });

  it('says nothing about a household whose spending barely moved', () => {
    const r = build({
      spend: { current: spend(2_000, { Groceries: 2_000 }), previous: spend(1_990, { Groceries: 1_990 }) },
      income: { current: 5_000, previous: 5_000 },
    });
    expect(r.visible).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Spending
// ═════════════════════════════════════════════════════════════════════════════
describe('overall spending', () => {
  const bigger = {
    current: spend(3_000, { Groceries: 1_200, Travel: 900, Dining: 900 }),
    previous: spend(2_000, { Groceries: 1_100, Travel: 300, Dining: 600 }),
  };

  it('reports a rise as worsening, with what changed', () => {
    const insight = of(build({ spend: bigger }), 'spending-change')!;
    expect(insight.direction).toBe('worsening');
    expect(insight.facts).toMatchObject({
      kind: 'spending-change', current: 3_000, previous: 2_000, delta: 1_000, percent: 50,
    });
  });

  it('names the categories behind the movement, biggest first', () => {
    const insight = of(build({ spend: bigger }), 'spending-change')!;
    const drivers = insight.facts.kind === 'spending-change' ? insight.facts.drivers : [];
    expect(drivers[0]).toEqual({ category: 'Travel', delta: 600 });
    expect(drivers[1]).toEqual({ category: 'Dining', delta: 300 });
  });

  it('reports a fall as improving', () => {
    const r = build({ spend: { current: spend(1_500), previous: spend(3_000) } });
    expect(of(r, 'spending-change')!.direction).toBe('improving');
  });

  it('ignores a movement below the dollar floor, however large the percentage', () => {
    const r = build({ spend: { current: spend(140), previous: spend(10) } });
    expect(kinds(r)).not.toContain('spending-change');
  });

  it('ignores a movement below the percentage floor, however large the dollars', () => {
    const r = build({ spend: { current: spend(20_200), previous: spend(20_000) } });
    expect(kinds(r)).not.toContain('spending-change');
  });

  it('treats a window with no previous spending as a full increase', () => {
    const r = build({ spend: { current: spend(900), previous: spend(0) } });
    const insight = of(r, 'spending-change')!;
    expect(insight.facts).toMatchObject({ percent: 100, delta: 900 });
  });

  it('is keyed by month, so tomorrow rebuilds the same observation', () => {
    const today = of(build({ spend: bigger }), 'spending-change')!;
    const tomorrow = buildInsights({
      ...params({ spend: bigger }),
      asOf: '2026-08-18',
      ...insightWindows('2026-08-18', 30),
    });
    expect(of(tomorrow, 'spending-change')!.key).toBe(today.key);
  });
});

describe('one category', () => {
  it('reports the categories that moved, biggest movement first', () => {
    const r = build({
      spend: {
        current: spend(3_000, { Travel: 1_400, Dining: 900, Groceries: 700 }),
        previous: spend(1_700, { Travel: 200, Dining: 600, Groceries: 900 }),
      },
    });
    const categories = r.visible.filter(i => i.kind === 'category-change');
    expect(categories[0].facts).toMatchObject({ category: 'Travel', delta: 1_200 });
  });

  it('caps how many it will report at once', () => {
    const current: Record<string, number> = {};
    const previous: Record<string, number> = {};
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      current[name] = 900;
      previous[name] = 100;
    }
    const r = build({ spend: { current: spend(4_500, current), previous: spend(500, previous) } });
    expect(r.visible.filter(i => i.kind === 'category-change')).toHaveLength(
      DEFAULT_INSIGHT_THRESHOLDS.maxCategoryInsights,
    );
  });

  it('says what share of this window the category now is', () => {
    const r = build({
      spend: {
        current: spend(2_000, { Travel: 1_000, Rent: 1_000 }),
        previous: spend(1_100, { Travel: 100, Rent: 1_000 }),
      },
    });
    expect(of(r, 'category-change')!.facts).toMatchObject({ shareOfSpend: 50 });
  });

  it('ignores a big percentage on a small category', () => {
    const r = build({
      spend: { current: spend(80, { Coffee: 60 }), previous: spend(20, { Coffee: 10 }) },
    });
    expect(kinds(r)).not.toContain('category-change');
  });

  it('matches a category across the two windows case-insensitively', () => {
    const r = build({
      spend: {
        current: spend(900, { groceries: 900 }),
        previous: spend(200, { Groceries: 200 }),
      },
    });
    expect(of(r, 'category-change')!.facts).toMatchObject({ previous: 200, current: 900 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Income
// ═════════════════════════════════════════════════════════════════════════════
describe('income', () => {
  it('reports a rise as improving and a fall as worsening', () => {
    const up = of(build({ income: { current: 6_000, previous: 5_000 } }), 'income-change')!;
    const down = of(build({ income: { current: 4_000, previous: 5_000 } }), 'income-change')!;
    expect(up.direction).toBe('improving');
    expect(down.direction).toBe('worsening');
  });

  it('ignores a movement below the dollar floor', () => {
    const r = build({ income: { current: 5_150, previous: 5_000 } });
    expect(kinds(r)).not.toContain('income-change');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Recurring commitments
// ═════════════════════════════════════════════════════════════════════════════
describe('a recurring cost that went up', () => {
  const netflix = (extra: Partial<RecurringCostInput> = {}): RecurringCostInput => ({
    id: 'series-1', name: 'Netflix', category: 'Entertainment',
    frequency: 'monthly', amount: 26, previousAmount: 20, history: 4,
    lastDate: '2026-08-04', ...extra,
  });

  it('reports the rise per charge and over a year', () => {
    const insight = of(build({ recurring: [netflix()] }), 'recurring-increase')!;
    expect(insight.facts).toMatchObject({
      kind: 'recurring-increase', amount: 26, previousAmount: 20, delta: 6, percent: 30, annualDelta: 72,
    });
    expect(insight.impact).toEqual({ amount: 6, basis: 'per-month' });
  });

  it('converts a weekly rise to what it really costs each month', () => {
    const insight = of(build({
      recurring: [netflix({ frequency: 'weekly', amount: 15, previousAmount: 10 })],
    }), 'recurring-increase')!;
    expect(insight.impact.amount).toBeCloseTo(5 * (30.4375 / 7), 2);
  });

  it('will not price a rise it has only seen once', () => {
    const r = build({ recurring: [netflix({ history: 1 })] });
    expect(kinds(r)).not.toContain('recurring-increase');
  });

  it('says nothing about a cost that went down — the user did that on purpose', () => {
    const r = build({ recurring: [netflix({ amount: 14, previousAmount: 20 })] });
    expect(kinds(r)).not.toContain('recurring-increase');
  });

  it('says nothing about a one-off charge, which has no monthly cost to rise', () => {
    const r = build({ recurring: [netflix({ frequency: 'once', amount: 300, previousAmount: 100 })] });
    expect(kinds(r)).not.toContain('recurring-increase');
  });

  it('ignores a rise below the dollar floor', () => {
    const r = build({ recurring: [netflix({ amount: 21, previousAmount: 20 })] });
    expect(kinds(r)).not.toContain('recurring-increase');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One outsized charge
// ═════════════════════════════════════════════════════════════════════════════
describe('an unusually large charge', () => {
  const ordinary = [
    windowTxn({ amount: 60 }), windowTxn({ amount: 70 }), windowTxn({ amount: 65 }),
  ];

  it('is measured against the category median, not its average', () => {
    const insight = of(build({
      transactions: [...ordinary, windowTxn({ amount: 900, merchant: 'Whitegoods Co', id: 'big' })],
    }), 'unusual-transaction')!;
    expect(insight.facts).toMatchObject({ amount: 900, usual: 67.5, merchant: 'Whitegoods Co' });
    expect(insight.impact).toEqual({ amount: 832.5, basis: 'window' });
  });

  it('will not call anything unusual without enough charges to have a normal', () => {
    const r = build({
      transactions: [windowTxn({ amount: 60 }), windowTxn({ amount: 900, id: 'big' })],
    });
    expect(kinds(r)).not.toContain('unusual-transaction');
  });

  it('ignores a charge that is merely the largest', () => {
    const r = build({ transactions: [...ordinary, windowTxn({ amount: 120, id: 'big' })] });
    expect(kinds(r)).not.toContain('unusual-transaction');
  });

  it('reports at most two, largest first', () => {
    const noisy: WindowTxn[] = [];
    for (const category of ['Groceries', 'Dining', 'Travel']) {
      noisy.push(
        windowTxn({ amount: 50, category }), windowTxn({ amount: 50, category }),
        windowTxn({ amount: 50, category }),
      );
    }
    noisy.push(windowTxn({ amount: 400, category: 'Groceries', id: 'g' }));
    noisy.push(windowTxn({ amount: 900, category: 'Dining', id: 'd' }));
    noisy.push(windowTxn({ amount: 700, category: 'Travel', id: 't' }));
    const found = build({ transactions: noisy }).visible.filter(i => i.kind === 'unusual-transaction');
    expect(found).toHaveLength(2);
    expect(found.map(i => i.facts.kind === 'unusual-transaction' && i.facts.category))
      .toEqual(['Dining', 'Travel']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Budgets, over complete months
// ═════════════════════════════════════════════════════════════════════════════
describe('a budget trend', () => {
  it('reports a cap missed two complete months running', () => {
    const insight = of(build({
      budgetHistory: [
        budgetMonth('2026-06', { limit: 500, spent: 700 }),
        budgetMonth('2026-07', { limit: 500, spent: 800 }),
      ],
    }), 'budget-trend')!;
    expect(insight.direction).toBe('worsening');
    expect(insight.facts).toMatchObject({
      trend: 'over', months: 2, averageGap: 250, monthKeys: ['2026-06', '2026-07'],
    });
  });

  it('says nothing when only one of the two months missed', () => {
    const r = build({
      budgetHistory: [
        budgetMonth('2026-06', { limit: 500, spent: 200 }),
        budgetMonth('2026-07', { limit: 500, spent: 800 }),
      ],
    });
    expect(kinds(r)).not.toContain('budget-trend');
  });

  it('questions a cap nothing has come close to for three months', () => {
    const insight = of(build({
      budgetHistory: [
        budgetMonth('2026-05', { limit: 1_000, spent: 300 }),
        budgetMonth('2026-06', { limit: 1_000, spent: 250 }),
        budgetMonth('2026-07', { limit: 1_000, spent: 200 }),
      ],
    }), 'budget-trend')!;
    expect(insight.direction).toBe('neutral');
    expect(insight.facts).toMatchObject({ trend: 'under', months: 3, averageGap: 750 });
  });

  it('needs more than one month before it will call anything a trend', () => {
    const r = build({ budgetHistory: [budgetMonth('2026-07', { limit: 500, spent: 900 })] });
    expect(kinds(r)).not.toContain('budget-trend');
  });

  it('ignores a trend whose average miss is trivial', () => {
    const r = build({
      budgetHistory: [
        budgetMonth('2026-06', { limit: 500, spent: 510 }),
        budgetMonth('2026-07', { limit: 500, spent: 515 }),
      ],
    });
    expect(kinds(r)).not.toContain('budget-trend');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Cash flow
// ═════════════════════════════════════════════════════════════════════════════
describe('cash flow', () => {
  const forecast = buildCashFlowForecast({
    asOf: TODAY,
    accounts: [{ accountId: 'acc-bank', name: 'Everyday', balance: 8_000 }],
    inputs: [{
      id: 'rent', sourceType: 'bill', name: 'Rent', amount: -2_000,
      frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'acc-bank', confidence: 1,
    }],
    horizons: [30],
  });

  it('compares like with like: net movement now against net movement before', () => {
    const insight = of(build({
      netMovement: { current: -400, previous: 900 },
    }), 'cash-flow-trend')!;
    expect(insight.direction).toBe('worsening');
    expect(insight.facts).toMatchObject({ current: -400, previous: 900, delta: -1_300 });
  });

  it('adds where the forecast says it goes next, without mixing it into the comparison', () => {
    const insight = of(build({
      netMovement: { current: 2_000, previous: 200 }, forecast,
    }), 'cash-flow-trend')!;
    expect(insight.direction).toBe('improving');
    expect(insight.source).toBe('forecast');
    expect(insight.facts).toMatchObject({
      delta: 1_800, projectedDays: 30, projectedNet: -2_000, projectedLow: 6_000,
    });
  });

  it('still speaks without a forecast, and says so in its source', () => {
    const insight = of(build({ netMovement: { current: 2_000, previous: 200 } }), 'cash-flow-trend')!;
    expect(insight.source).toBe('transactions');
    expect(insight.facts).toMatchObject({ projectedNet: null });
  });

  it('ignores a small swing', () => {
    const r = build({ netMovement: { current: 1_100, previous: 1_000 } });
    expect(kinds(r)).not.toContain('cash-flow-trend');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Debt and offsets
// ═════════════════════════════════════════════════════════════════════════════
describe('debt', () => {
  const report = (l: Loan) => buildLoanReport([l], [], [], { today: TODAY });

  it('reports the money going in above the contract, with the months it buys', () => {
    const insight = of(build({
      loans: report(loan({
        extra_repayment: 500, start_date: '2020-08-01', term_months: 360,
      })),
    }), 'debt-progress')!;
    expect(insight.direction).toBe('improving');
    // $3,000 a month is going out against the $2,628 the 30-year term actually
    // needs, so the overpayment is that gap — not the $500 typed as "extra",
    // which is measured against a minimum the contract disagrees with.
    expect(insight.impact.basis).toBe('per-month');
    expect(insight.impact.amount).toBeCloseTo(3_000 - 2_628.02, 0);
    const facts = insight.facts.kind === 'debt-progress' ? insight.facts : null;
    expect(facts!.monthsAhead).toBeGreaterThan(0);
    expect(facts!.repaidPercent).toBeCloseTo(20, 0);
  });

  it('says nothing about a loan being paid exactly as agreed', () => {
    const r = build({ loans: report(loan()) });
    expect(kinds(r)).not.toContain('debt-progress');
  });

  it('says nothing about a loan already repaid', () => {
    const r = build({ loans: report(loan({ current_balance: 0, extra_repayment: 500 })) });
    expect(kinds(r)).not.toContain('debt-progress');
  });

  it('scales a fortnightly overpayment to what it is worth in a month', () => {
    const insight = of(build({
      loans: report(loan({ repayment_frequency: 'fortnightly', minimum_repayment: 1_200, extra_repayment: 200 })),
    }), 'debt-progress')!;
    expect(insight.impact.amount).toBeCloseTo((200 * 26) / 12, 1);
  });
});

describe('an offset account', () => {
  it('reports what it saves in a year', () => {
    const insight = of(build({
      loans: buildLoanReport([loan({ offset_balance: 60_000 })], [], [], { today: TODAY }),
    }), 'offset-benefit')!;
    expect(insight.impact).toEqual({ amount: 3_600, basis: 'per-year' });
    expect(insight.monthlyImpact).toBe(300);
    expect(insight.facts).toMatchObject({ offsetBalance: 60_000, effectiveBalance: 340_000 });
  });

  it('ignores an offset too small to matter', () => {
    const r = build({
      loans: buildLoanReport([loan({ offset_balance: 500 })], [], [], { today: TODAY }),
    });
    expect(kinds(r)).not.toContain('offset-benefit');
  });

  it('stays quiet when the linked account is gone rather than reporting a saving of nothing', () => {
    const r = build({
      loans: buildLoanReport(
        [loan({ offset_account_id: 'deleted-account', offset_balance: 60_000 })],
        [], [], { today: TODAY, offsetAccounts: [] },
      ),
    });
    expect(kinds(r)).not.toContain('offset-benefit');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Property
// ═════════════════════════════════════════════════════════════════════════════
describe('a property', () => {
  const rental: Property = {
    id: 'prop-1', user_id: 'u1', name: 'Unit 4',
    property_type: 'investment', purchase_price: 600_000, current_value: 750_000,
    ownership_percent: 100, loan_id: null,
    rent_match_terms: ['Ray White'], expected_rent_amount: 600,
    expected_rent_frequency: 'weekly',
    property_expenses: [],
  } as Property;

  const rentTxns = [
    tx({ id: 'r1', amount: 600, merchant: 'Ray White', date: '2026-08-01', category: 'Rent' }),
    tx({ id: 'r2', amount: 600, merchant: 'Ray White', date: '2026-08-08', category: 'Rent' }),
  ];

  it('reports what it earns against what it costs, over the trailing year', () => {
    const report = buildPropertyReport([rental], [], [], { transactions: rentTxns, asOf: TODAY });
    const insight = of(build({ property: report }), 'property-performance')!;
    expect(insight.direction).toBe('improving');
    expect(insight.facts).toMatchObject({ kind: 'property-performance', annualRent: 600 * 52 });
    expect(insight.impact.basis).toBe('per-year');
  });

  it('says nothing about a home the user lives in', () => {
    const home = { ...rental, id: 'prop-2', property_type: 'home', rent_match_terms: [] } as Property;
    const report = buildPropertyReport([home], [], [], { transactions: [], asOf: TODAY });
    expect(kinds(build({ property: report }))).not.toContain('property-performance');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Tax
// ═════════════════════════════════════════════════════════════════════════════
describe('the financial year', () => {
  const position = buildTaxYearPosition({
    fy: '2026-2027',
    transactions: [],
    manualDeductions: [
      { id: 'd1', name: 'Laptop', amount: 1_800, category: 'Work equipment', date: '2026-07-20' },
      { id: 'd2', name: 'Union fees', amount: 400, category: 'Memberships', date: '2026-08-01' },
    ],
    incomeEntries: [],
    payslips: [],
  });

  it('re-presents what the tax engine has already totalled', () => {
    const insight = of(build({
      tax: { fy: '2026-2027', start: '2026-07-01', position },
    }), 'tax-deductions')!;
    expect(insight.facts).toMatchObject({
      kind: 'tax-deductions', fy: '2026-2027', deductions: 2_200, topCategory: 'Work equipment',
    });
    expect(insight.link.to).toBe('/tax');
  });

  it('ignores a year with almost nothing claimed', () => {
    const thin = buildTaxYearPosition({
      fy: '2026-2027', transactions: [], incomeEntries: [], payslips: [],
      manualDeductions: [{ id: 'd1', name: 'Stationery', amount: 40, category: 'Office', date: '2026-07-20' }],
    });
    const r = build({ tax: { fy: '2026-2027', start: '2026-07-01', position: thin } });
    expect(kinds(r)).not.toContain('tax-deductions');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Ranking
// ═════════════════════════════════════════════════════════════════════════════
describe('ranking', () => {
  it('converts every basis to what it is worth in a month', () => {
    expect(monthlyImpactOf({ amount: 1_200, basis: 'per-year' }, 30)).toBe(100);
    expect(monthlyImpactOf({ amount: 250, basis: 'per-month' }, 30)).toBe(250);
    expect(monthlyImpactOf({ amount: 300, basis: 'window' }, 30)).toBeCloseTo(304.38, 1);
  });

  it('puts the bigger movement first, whatever kind it is', () => {
    const r = build({
      spend: { current: spend(4_000), previous: spend(2_000) },
      recurring: [{
        id: 's1', name: 'Gym', category: null, frequency: 'monthly',
        amount: 90, previousAmount: 60, history: 5, lastDate: '2026-08-02',
      }],
    });
    expect(kinds(r)).toEqual(['spending-change', 'recurring-increase']);
  });

  it('ranks a problem above an equally sized improvement', () => {
    const worse = of(build({ spend: { current: spend(3_000), previous: spend(2_000) } }), 'spending-change')!;
    const better = of(build({ spend: { current: spend(2_000), previous: spend(3_000) } }), 'spending-change')!;
    expect(worse.monthlyImpact).toBe(better.monthlyImpact);
    expect(worse.score).toBeGreaterThan(better.score);
  });

  it('ranks a standing fact below a change of the same size', () => {
    const r = build({
      income: { current: 8_600, previous: 5_000 },     // +3,600 over the window
      loans: buildLoanReport([loan({ offset_balance: 60_000 })], [], [], { today: TODAY }),
    });
    expect(kinds(r)).toEqual(['income-change', 'offset-benefit']);
  });

  it('sorts on score, then kind, then stage, then key', () => {
    const rows = [
      { key: 'b', kind: 'category-change', score: 10, stage: 1 },
      { key: 'a', kind: 'category-change', score: 10, stage: 3 },
      { key: 'c', kind: 'spending-change', score: 10, stage: 1 },
      { key: 'd', kind: 'category-change', score: 99, stage: 1 },
    ] as unknown as Insight[];
    expect(sortInsights(rows).map(i => i.key)).toEqual(['d', 'c', 'a', 'b']);
  });
});

describe('how loud a movement is', () => {
  const at = (current: number) =>
    of(build({ spend: { current: spend(current), previous: spend(1_000) } }), 'spending-change')!.stage;

  it('rises as the movement outgrows the smallest one worth reporting', () => {
    expect(at(1_200)).toBe(1);   // +200, just over the floor
    expect(at(1_400)).toBe(2);   // +400, twice it
    expect(at(1_800)).toBe(3);   // +800, four times it
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Saying one thing once
// ═════════════════════════════════════════════════════════════════════════════
describe('two descriptions of the same money', () => {
  const entertainmentUp = {
    current: spend(1_000, { Entertainment: 260 }),
    previous: spend(900, { Entertainment: 60 }),
  };

  it('drops the category when a price rise explains most of it', () => {
    const r = build({
      spend: entertainmentUp,
      recurring: [{
        id: 's1', name: 'Streaming', category: 'Entertainment', frequency: 'monthly',
        amount: 210, previousAmount: 20, history: 4, lastDate: '2026-08-04',
      }],
    });
    expect(kinds(r)).toEqual(['recurring-increase']);
  });

  it('keeps both when the price rise explains only a little of it', () => {
    const r = build({
      spend: entertainmentUp,
      recurring: [{
        id: 's1', name: 'Streaming', category: 'Entertainment', frequency: 'monthly',
        amount: 26, previousAmount: 20, history: 4, lastDate: '2026-08-04',
      }],
    });
    expect(kinds(r).sort()).toEqual(['category-change', 'recurring-increase']);
  });

  it('drops the category when one outsized charge explains it', () => {
    const r = build({
      spend: {
        current: spend(1_200, { Groceries: 1_000 }),
        previous: spend(400, { Groceries: 200 }),
      },
      transactions: [
        windowTxn({ amount: 60 }), windowTxn({ amount: 70 }), windowTxn({ amount: 65 }),
        windowTxn({ amount: 800, id: 'big', merchant: 'Costco' }),
      ],
    });
    expect(kinds(r)).toContain('unusual-transaction');
    expect(kinds(r)).not.toContain('category-change');
  });

  it('prefers a missed cap to the same money measured against last month', () => {
    const r = build({
      spend: {
        current: spend(1_500, { Groceries: 900 }),
        previous: spend(900, { Groceries: 300 }),
      },
      budgetHistory: [
        budgetMonth('2026-06', { limit: 500, spent: 700 }),
        budgetMonth('2026-07', { limit: 500, spent: 800 }),
      ],
    });
    expect(kinds(r)).toContain('budget-trend');
    expect(kinds(r)).not.toContain('category-change');
  });

  it('drops the overall figure when one category is nearly all of it', () => {
    const r = build({
      spend: {
        current: spend(3_000, { Travel: 1_900, Rent: 1_100 }),
        previous: spend(2_000, { Travel: 900, Rent: 1_100 }),
      },
    });
    expect(kinds(r)).toEqual(['category-change']);
  });

  it('keeps the overall figure when the movement is spread across categories', () => {
    const r = build({
      spend: {
        current: spend(3_000, { Travel: 1_000, Dining: 1_000, Groceries: 1_000 }),
        previous: spend(1_800, { Travel: 600, Dining: 600, Groceries: 600 }),
      },
    });
    expect(kinds(r)).toContain('spending-change');
  });

  it('keeps the overall figure when the dominant category was itself too small to report', () => {
    const r = build({
      spend: {
        current: spend(2_300, { Travel: 1_800, Rent: 500 }),
        previous: spend(2_000, { Travel: 1_500, Rent: 500 }),
      },
    });
    // Travel moved $300 — the whole of the overall movement — but only 20% of
    // its own previous window, so it is not reported on its own. Dropping the
    // overall figure too would leave the movement unreported entirely.
    expect(kinds(r)).toEqual(['spending-change']);
  });

  it('drops anything a live alert is already shouting about', () => {
    const spendParams = {
      spend: {
        current: spend(3_000, { Travel: 1_000, Dining: 1_000, Groceries: 1_000 }),
        previous: spend(1_800, { Travel: 600, Dining: 600, Groceries: 600 }),
      },
    };
    const quiet = build({ ...spendParams, spokenFor: ['category:travel', 'spend:overall'] });
    expect(kinds(quiet)).not.toContain('spending-change');
    expect(quiet.visible.map(i => i.entity)).not.toContain('category:travel');
    expect(quiet.visible.map(i => i.entity)).toContain('category:dining');
    // Counted, not just done: a caller summarising this list has to be able to
    // say where the missing ones went (Phase 6.2).
    expect(quiet.suppressedByAlert).toBe(2);
    expect(build(spendParams).suppressedByAlert).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Coverage — what the history cannot support is not said
// ═════════════════════════════════════════════════════════════════════════════
describe('sparse history', () => {
  const movement = {
    spend: { current: spend(3_000), previous: spend(500) },
    income: { current: 8_000, previous: 2_000 },
    netMovement: { current: -2_000, previous: 1_000 },
  };

  it('says nothing about two windows when only one of them is loaded', () => {
    const r = build({ ...movement, coverageFrom: WINDOW.from });
    expect(r.visible).toEqual([]);
    expect(r.skipped[0]).toContain(PREVIOUS.from);
  });

  it('still reports what only needs the current window', () => {
    const r = build({
      ...movement,
      coverageFrom: WINDOW.from,
      recurring: [{
        id: 's1', name: 'Insurance', category: 'Insurance', frequency: 'monthly',
        amount: 180, previousAmount: 120, history: 3, lastDate: '2026-08-02',
      }],
    });
    expect(kinds(r)).toEqual(['recurring-increase']);
  });

  it('leaves out budget months the history does not cover, and says so', () => {
    const r = build({
      coverageFrom: '2026-07-01',
      budgetHistory: [
        budgetMonth('2026-05', { limit: 500, spent: 900 }),
        budgetMonth('2026-06', { limit: 500, spent: 900 }),
        budgetMonth('2026-07', { limit: 500, spent: 900 }),
      ],
    });
    expect(kinds(r)).not.toContain('budget-trend');   // only one covered month left
    expect(r.skipped.join(' ')).toContain('budget months');
  });

  it('will not talk about a financial year it cannot see the start of', () => {
    const position = buildTaxYearPosition({
      fy: '2026-2027', transactions: [], incomeEntries: [], payslips: [],
      manualDeductions: [{ id: 'd1', name: 'Laptop', amount: 1_800, category: 'Work equipment', date: '2026-07-20' }],
    });
    const r = build({
      coverageFrom: '2026-07-15',
      tax: { fy: '2026-2027', start: '2026-07-01', position },
    });
    expect(kinds(r)).not.toContain('tax-deductions');
    expect(r.skipped.join(' ')).toContain('2026-2027');
  });

  it('leaves standing facts alone — they do not depend on a window', () => {
    const r = build({
      coverageFrom: TODAY,
      loans: buildLoanReport([loan({ offset_balance: 60_000 })], [], [], { today: TODAY }),
    });
    expect(kinds(r)).toContain('offset-benefit');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Conflicting signals
// ═════════════════════════════════════════════════════════════════════════════
describe('signals that disagree', () => {
  it('reports spending down and cash flow down together, without either cancelling the other', () => {
    const r = build({
      spend: { current: spend(2_000), previous: spend(3_500) },   // improving
      income: { current: 2_000, previous: 6_000 },                // worsening
      netMovement: { current: -1_500, previous: 1_500 },          // worsening
    });
    const byKind = new Map(r.visible.map(i => [i.kind, i.direction]));
    expect(byKind.get('spending-change')).toBe('improving');
    expect(byKind.get('income-change')).toBe('worsening');
    expect(byKind.get('cash-flow-trend')).toBe('worsening');
    // The problems lead: the improvement is real but there is nothing to do about it.
    expect(r.visible[0].direction).toBe('worsening');
  });

  it('lets one category rise while another falls, and reports both', () => {
    const r = build({
      spend: {
        current: spend(2_000, { Travel: 1_500, Groceries: 500 }),
        previous: spend(2_000, { Travel: 500, Groceries: 1_500 }),
      },
    });
    const directions = r.visible
      .filter(i => i.kind === 'category-change')
      .map(i => i.direction)
      .sort();
    expect(directions).toEqual(['improving', 'worsening']);
    // Overall spending did not move, so nothing claims it did.
    expect(kinds(r)).not.toContain('spending-change');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Dismissal, reading and resolution
// ═════════════════════════════════════════════════════════════════════════════
describe('what the user has already done about an insight', () => {
  const rising = (current: number) => ({ spend: { current: spend(current), previous: spend(1_000) } });
  const KEY = 'insight:spending-change:2026-08';

  it('namespaces every key, so insight and alert state can share a store', () => {
    const r = build(rising(1_400));
    expect(r.all.every(i => isInsightKey(i.key))).toBe(true);
  });

  it('hides a dismissed insight but keeps it in the full list', () => {
    const r = build({
      ...rising(1_400),
      states: [{ key: KEY, dismissedStage: 2, readStage: null }],
    });
    expect(r.visible).toEqual([]);
    expect(r.all[0].dismissed).toBe(true);
  });

  it('brings it back once the movement gets materially worse', () => {
    const states = [{ key: KEY, dismissedStage: 2, readStage: null }];
    expect(build({ ...rising(1_400), states }).visible).toHaveLength(0);   // stage 2
    expect(build({ ...rising(2_000), states }).visible).toHaveLength(1);   // stage 3
  });

  it('counts what has not been read at its current stage', () => {
    const read = build({ ...rising(1_400), states: [{ key: KEY, dismissedStage: null, readStage: 2 }] });
    expect(read.unreadCount).toBe(0);
    const worse = build({ ...rising(2_000), states: [{ key: KEY, dismissedStage: null, readStage: 2 }] });
    expect(worse.unreadCount).toBe(1);
  });

  it('hands back the state of an observation that no longer holds', () => {
    const r = build({
      spend: { current: spend(1_000), previous: spend(1_000) },
      states: [{ key: KEY, dismissedStage: 1, readStage: null }],
    });
    expect(r.resolvedKeys).toEqual([KEY]);
  });

  it("never reports an alert's stored state as resolved", () => {
    const r = build({
      ...rising(1_400),
      states: [{ key: 'budget-limit:2026-08:groceries', dismissedStage: 1, readStage: null }],
    });
    expect(r.resolvedKeys).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Insurance premium changes (Phase 8.2)
// ═════════════════════════════════════════════════════════════════════════════
describe('insurance premium changes', () => {
  /** Policies through the REAL insurance engine, for the same reason every other
   *  report in this file is real. */
  const insurance = (
    policies: Partial<InsurancePolicyInput>[],
    premiumHistory: PremiumRecordInput[] = [],
  ) => buildInsuranceReport({
    asOf: TODAY,
    policies: policies.map((p, i) => ({
      id: p.id ?? `pol${i}`,
      name: p.name ?? 'House',
      policy_type: p.policy_type ?? 'home',
      insurer: p.insurer ?? 'NRMA',
      premium_amount: p.premium_amount ?? 1200,
      premium_frequency: p.premium_frequency ?? 'annually',
      renewal_date: p.renewal_date ?? '2026-12-01',
      active: p.active ?? true,
      ...p,
    })),
    premiumHistory,
  });

  const priced = (policyId: string, amount: number, date: string): PremiumRecordInput =>
    ({ id: `h-${policyId}-${amount}`, policy_id: policyId, premium_amount: amount,
       premium_frequency: 'annually', effective_date: date });

  it('says nothing when there are no policies', () => {
    expect(kinds(build({ insurance: insurance([]) }))).toEqual([]);
  });

  it('says nothing when the premium has not moved', () => {
    const r = build({
      insurance: insurance([{ id: 'a', premium_amount: 1200 }], [priced('a', 1200, '2025-12-01')]),
    });
    expect(kinds(r)).toEqual([]);
  });

  it('reports a rise, in what it costs a YEAR', () => {
    const r = build({
      insurance: insurance(
        [{ id: 'a', name: 'House', premium_amount: 1500 }],
        [priced('a', 1200, '2024-12-01'), priced('a', 1500, '2025-12-01')],
      ),
    });
    const i = of(r, 'insurance-premium-change')!;
    expect(i.title).toBe('House costs more than it did');
    expect(i.direction).toBe('worsening');
    expect(i.source).toBe('insurance');
    expect(i.entity).toBe('insurance:a');
    expect(i.impact).toEqual({ amount: 300, basis: 'per-year' });
    expect(i.monthlyImpact).toBe(25);
    expect(i.facts).toMatchObject({
      kind: 'insurance-premium-change', annual: 1500, previousAnnual: 1200,
      delta: 300, percent: 25, insurer: 'NRMA',
    });
  });

  it('reports a fall as an improvement, and ranks it below an equal rise', () => {
    const down = build({
      insurance: insurance(
        [{ id: 'a', premium_amount: 900 }],
        [priced('a', 1200, '2024-12-01'), priced('a', 900, '2025-12-01')],
      ),
    });
    const up = build({
      insurance: insurance(
        [{ id: 'b', premium_amount: 1500 }],
        [priced('b', 1200, '2024-12-01'), priced('b', 1500, '2025-12-01')],
      ),
    });
    const fell = of(down, 'insurance-premium-change')!;
    const rose = of(up, 'insurance-premium-change')!;
    expect(fell.direction).toBe('improving');
    expect(fell.monthlyImpact).toBe(rose.monthlyImpact);
    expect(fell.score).toBeLessThan(rose.score);
  });

  it('ignores a move too small in dollars to be worth saying', () => {
    const r = build({
      insurance: insurance(
        [{ id: 'a', premium_amount: 240 }],
        [priced('a', 200, '2024-12-01'), priced('a', 240, '2025-12-01')],
      ),
    });
    // $40 a year clears the 5% floor twice over, and still isn't $50.
    expect(kinds(r)).toEqual([]);
  });

  it('ignores a move too small as a SHARE of the premium', () => {
    const r = build({
      insurance: insurance(
        [{ id: 'a', premium_amount: 4_060 }],
        [priced('a', 4_000, '2024-12-01'), priced('a', 4_060, '2025-12-01')],
      ),
    });
    // $60 clears the absolute floor; 1.5% does not clear the relative one.
    expect(kinds(r)).toEqual([]);
  });

  it('stages on how big the movement is', () => {
    const small = of(build({
      insurance: insurance([{ id: 'a', premium_amount: 1_260 }],
        [priced('a', 1_200, '2024-12-01'), priced('a', 1_260, '2025-12-01')]),
    }), 'insurance-premium-change')!;
    const huge = of(build({
      insurance: insurance([{ id: 'b', premium_amount: 4_800 }],
        [priced('b', 1_200, '2024-12-01'), priced('b', 4_800, '2025-12-01')]),
    }), 'insurance-premium-change')!;
    expect(small.stage).toBe(1);
    expect(huge.stage).toBe(3);
  });

  it('is a standing fact, not a windowed change — and needs no history coverage', () => {
    const r = build({
      // History that reaches back nowhere near the price change.
      coverageFrom: '2026-08-01',
      insurance: insurance(
        [{ id: 'a', premium_amount: 1500 }],
        [priced('a', 1200, '2020-01-01'), priced('a', 1500, '2021-12-01')],
      ),
    });
    const i = of(r, 'insurance-premium-change')!;
    expect(i.window).toBeNull();
    expect(r.skipped.join(' ')).not.toContain('polic');
  });

  it('says nothing about cover the user no longer holds', () => {
    const r = build({
      insurance: insurance(
        [{ id: 'a', premium_amount: 1500, active: false }],
        [priced('a', 1200, '2024-12-01'), priced('a', 1500, '2025-12-01')],
      ),
    });
    expect(kinds(r)).toEqual([]);
  });

  it('carries the renewal date so the reader knows when they could act', () => {
    const r = build({
      insurance: insurance(
        [{ id: 'a', premium_amount: 1500, renewal_date: '2026-11-30' }],
        [priced('a', 1200, '2024-12-01'), priced('a', 1500, '2025-12-01')],
      ),
    });
    expect(of(r, 'insurance-premium-change')!.facts).toMatchObject({ renewalDate: '2026-11-30' });
  });

  it('keys on the policy AND the date, so next year is next year\'s news', () => {
    const r = build({
      insurance: insurance(
        [{ id: 'a', premium_amount: 1500 }],
        [priced('a', 1200, '2024-12-01'), priced('a', 1500, '2025-12-01')],
      ),
    });
    const i = of(r, 'insurance-premium-change')!;
    expect(i.key).toBe('insight:insurance-premium-change:a:2025-12-01');
    expect(isInsightKey(i.key)).toBe(true);
  });

  it('a dismissal holds until the movement grows into a worse stage', () => {
    const key = 'insight:insurance-premium-change:a:2025-12-01';
    const hidden = build({
      insurance: insurance([{ id: 'a', premium_amount: 1_260 }],
        [priced('a', 1_200, '2024-12-01'), priced('a', 1_260, '2025-12-01')]),
      states: [{ key, dismissedStage: 1, readStage: null }],
    });
    expect(hidden.visible).toEqual([]);
    expect(hidden.all).toHaveLength(1);

    const worse = build({
      insurance: insurance([{ id: 'a', premium_amount: 4_800 }],
        [priced('a', 1_200, '2024-12-01'), priced('a', 4_800, '2025-12-01')]),
      states: [{ key, dismissedStage: 1, readStage: null }],
    });
    expect(worse.visible).toHaveLength(1);
  });

  it('reports a stored key as resolved once the price settles again', () => {
    const key = 'insight:insurance-premium-change:a:2025-12-01';
    const r = build({
      insurance: insurance([{ id: 'a', premium_amount: 1200 }], [priced('a', 1200, '2025-12-01')]),
      states: [{ key, dismissedStage: 1, readStage: null }],
    });
    expect(r.resolvedKeys).toEqual([key]);
  });

  it('one insight per policy, ranked in dollars against everything else', () => {
    const r = build({
      insurance: insurance(
        [
          { id: 'a', name: 'House', premium_amount: 2_400 },
          { id: 'b', name: 'Car', premium_amount: 700 },
        ],
        [
          priced('a', 1_200, '2024-12-01'), priced('a', 2_400, '2025-12-01'),
          priced('b', 600, '2024-12-01'), priced('b', 700, '2025-12-01'),
        ],
      ),
    });
    const found = r.visible.filter(i => i.kind === 'insurance-premium-change');
    expect(found).toHaveLength(2);
    // Materiality, not alphabet: $1,200 a year outranks $100 a year.
    expect(found.map(i => i.entity)).toEqual(['insurance:a', 'insurance:b']);
  });
});
