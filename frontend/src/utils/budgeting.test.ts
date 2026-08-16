import { describe, it, expect } from 'vitest';
import type { Budget, Transaction } from '../types';
import {
  BUDGET_OVERALL_KEY,
  monthKeyOf, monthKeyFromDate, addMonthsKey, monthsBetweenKeys, daysInMonthKey,
  dayOfMonth, bucketByMonth, toMonthlyLimit, budgetKey, normaliseBudgets,
  monthlySpend, spendForCategoryKey, projectMonthEnd, buildBudgetReport,
  applyCategoryRename, budgetsFromLegacyPlan,
} from './budgeting';
import { computeTransferExclusionIds } from './transactionCore';
import { detectInternalTransferIds } from './recurringDetection';

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

/** The canonical spend options every real caller passes. */
function spendOptions(txns: Transaction[]) {
  return { excludeIds: computeTransferExclusionIds(txns, detectInternalTransferIds) };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Month boundaries
// ═════════════════════════════════════════════════════════════════════════════
describe('month keys and boundaries', () => {
  it('reads a month from the date STRING, not a parsed Date', () => {
    // `new Date('2026-08-01')` is UTC midnight — July 31st in any negative-offset
    // timezone. Reading the string keeps the 1st in August everywhere.
    expect(monthKeyOf('2026-08-01')).toBe('2026-08');
    expect(monthKeyOf('2026-08-31')).toBe('2026-08');
    expect(monthKeyOf('2026-08-01T23:30:00Z')).toBe('2026-08');
    expect(monthKeyOf('2026-08')).toBe('2026-08');
    expect(monthKeyOf(null)).toBeNull();
    expect(monthKeyOf('not a date')).toBeNull();
  });

  it('reads a month from a Date using local calendar parts', () => {
    expect(monthKeyFromDate(new Date(2026, 0, 31))).toBe('2026-01');
    expect(monthKeyFromDate(new Date(2026, 11, 1))).toBe('2026-12');
  });

  it('steps months across a year boundary in both directions', () => {
    expect(addMonthsKey('2026-12', 1)).toBe('2027-01');
    expect(addMonthsKey('2026-01', -1)).toBe('2025-12');
    expect(addMonthsKey('2026-08', -24)).toBe('2024-08');
    expect(monthsBetweenKeys('2026-01', '2026-08')).toBe(7);
    expect(monthsBetweenKeys('2026-08', '2026-01')).toBe(-7);
  });

  it('knows the length of short, long and leap-February months', () => {
    expect(daysInMonthKey('2026-02')).toBe(28);
    expect(daysInMonthKey('2028-02')).toBe(29); // leap year
    expect(daysInMonthKey('2026-04')).toBe(30);
    expect(daysInMonthKey('2026-08')).toBe(31);
    expect(dayOfMonth('2026-08-07')).toBe(7);
  });

  it('files the first and last day of a month into that month, never a neighbour', () => {
    const txns = [
      tx({ amount: -10, date: '2026-07-31' }),
      tx({ amount: -20, date: '2026-08-01' }),
      tx({ amount: -30, date: '2026-08-31' }),
      tx({ amount: -40, date: '2026-09-01' }),
    ];
    const buckets = bucketByMonth(txns);
    expect(buckets.get('2026-07')).toHaveLength(1);
    expect(buckets.get('2026-08')).toHaveLength(2);
    expect(buckets.get('2026-09')).toHaveLength(1);
  });

  it('counts only the reported month, ignoring spend either side of it', () => {
    const txns = [
      tx({ amount: -100, date: '2026-07-31', category: 'Groceries' }),
      tx({ amount: -60, date: '2026-08-01', category: 'Groceries' }),
      tx({ amount: -40, date: '2026-08-31', category: 'Groceries' }),
      tx({ amount: -500, date: '2026-09-01', category: 'Groceries' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].spent).toBe(100);
    expect(r.categories[0].remaining).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Limit normalisation + identity
// ═════════════════════════════════════════════════════════════════════════════
describe('budget normalisation', () => {
  it('converts legacy weekly / yearly caps to a monthly amount', () => {
    expect(toMonthlyLimit(100, 'monthly')).toBe(100);
    expect(toMonthlyLimit(50, 'weekly')).toBe(216.67);
    expect(toMonthlyLimit(1200, 'yearly')).toBe(100);
    expect(toMonthlyLimit(-300, 'monthly')).toBe(300); // sign is never a cap
  });

  it('keys a category budget case-insensitively and the overall budget by itself', () => {
    expect(budgetKey({ scope: 'category', category: 'Groceries' })).toBe('groceries');
    expect(budgetKey({ scope: 'category', category: '  GROCERIES ' })).toBe('groceries');
    expect(budgetKey({ scope: 'overall', category: null })).toBe(BUDGET_OVERALL_KEY);
    expect(budgetKey({ scope: 'category', category: '  ' })).toBeNull();
  });

  it('drops inactive rows and collapses duplicates to the newest', () => {
    const rows = [
      budget({ id: 'old', limit_amount: 100, updated_at: '2026-01-01' }),
      budget({ id: 'new', limit_amount: 400, updated_at: '2026-08-01' }),
      budget({ id: 'retired', category: 'Dining', active: false }),
    ];
    const out = normaliseBudgets(rows);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('new');
    expect(out[0].monthlyLimit).toBe(400);
  });

  it('treats a row with no scope as a category budget (pre-Phase-4 rows)', () => {
    const legacy = { ...budget(), scope: undefined };
    expect(normaliseBudgets([legacy])[0].scope).toBe('category');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Spend: canonical exclusions (transfers, refunds, non-spend)
// ═════════════════════════════════════════════════════════════════════════════
describe('what counts against a budget', () => {
  it('excludes internal transfers and credit-card repayments', () => {
    const txns = [
      tx({ amount: -100, category: 'Groceries' }),
      tx({ id: 'out', amount: -900, account_id: 'acc-bank', merchant: 'TRANSFER TO SAVINGS', category: 'Groceries' }),
      tx({ id: 'in', amount: 900, account_id: 'acc-save', merchant: 'TRANSFER FROM CHEQUE', category: 'Groceries' }),
      tx({ amount: -400, merchant: 'AMEX PAYMENT', category: 'Groceries' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].spent).toBe(100);
  });

  it('excludes income and explicitly non-spend categories', () => {
    const txns = [
      tx({ amount: -100, category: 'Groceries' }),
      tx({ amount: 5000, category: 'Income', merchant: 'Employer' }),
      tx({ amount: -50, category: 'Transfer', merchant: 'Moving money' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].spent).toBe(100);
    expect(r.totalSpent).toBe(100);
  });

  it('nets a matched refund against the category it reverses', () => {
    const txns = [
      tx({ id: 'buy', amount: -200, category: 'Shopping', merchant: 'Kmart' }),
      tx({
        id: 'ref', amount: 80, category: 'Shopping', merchant: 'Kmart',
        transaction_type: 'refund', refund_of: 'buy',
      }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ category: 'Shopping', limit_amount: 150 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    // 200 spent − 80 refunded = 120 against a 150 cap.
    expect(r.categories[0].spent).toBe(120);
    expect(r.categories[0].remaining).toBe(30);
    expect(r.categories[0].status).toBe('under');
  });

  it('never lets an over-refunded category show negative spend', () => {
    const txns = [
      tx({ id: 'buy', amount: -50, category: 'Shopping' }),
      tx({ id: 'ref', amount: 300, category: 'Shopping', transaction_type: 'refund', refund_of: 'buy' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ category: 'Shopping', limit_amount: 100 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].spent).toBe(0);
    expect(r.categories[0].remaining).toBe(100);
  });

  it('nets a refund in the month it lands, not the month of the purchase', () => {
    const txns = [
      tx({ id: 'buy', amount: -200, date: '2026-07-20', category: 'Shopping' }),
      tx({
        id: 'ref', amount: 200, date: '2026-08-05', category: 'Shopping',
        transaction_type: 'refund', refund_of: 'buy',
      }),
      tx({ amount: -120, date: '2026-08-06', category: 'Shopping' }),
    ];
    const opts = { month: '2026-08', asOf: '2026-08-31', spendOptions: spendOptions(txns) };
    const aug = buildBudgetReport({
      ...opts, budgets: [budget({ category: 'Shopping', limit_amount: 300 })], transactions: txns,
    });
    // August: 120 of new spend, less the 200 refunded → floored at 0.
    expect(aug.categories[0].spent).toBe(0);

    const jul = buildBudgetReport({
      ...opts, month: '2026-07',
      budgets: [budget({ category: 'Shopping', limit_amount: 300 })], transactions: txns,
    });
    expect(jul.categories[0].spent).toBe(200);
  });

  it('distributes a split transaction across its split categories', () => {
    const txns = [tx({ id: 'sp', amount: -100, category: 'Shopping' })];
    const splitsByTxId = new Map([[
      'sp', [{ category: 'Groceries', amount: 70 }, { category: 'Health', amount: 30 }],
    ]]);
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ category: 'Groceries', limit_amount: 100 })],
      transactions: txns,
      spendOptions: { ...spendOptions(txns), splitsByTxId },
    });
    expect(r.categories[0].spent).toBe(70);
    expect(r.totalSpent).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Spent / remaining / percentage / overspending
// ═════════════════════════════════════════════════════════════════════════════
describe('spent, remaining and percentage used', () => {
  it('reports spent, remaining and percent for a category under its cap', () => {
    const txns = [tx({ amount: -125, category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    const line = r.categories[0];
    expect(line.spent).toBe(125);
    expect(line.remaining).toBe(375);
    expect(line.percentUsed).toBe(25);
    expect(line.status).toBe('under');
  });

  it('matches the budget category case-insensitively', () => {
    const txns = [tx({ amount: -60, category: 'groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ category: 'Groceries', limit_amount: 100 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].spent).toBe(60);
  });

  it('goes NEGATIVE remaining and over 100% when overspent', () => {
    const txns = [tx({ amount: -650, category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    const line = r.categories[0];
    expect(line.remaining).toBe(-150);
    expect(line.percentUsed).toBe(130);
    expect(line.status).toBe('over');
  });

  it('has no percentage when there is no positive cap', () => {
    const txns = [tx({ amount: -20, category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 0 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].percentUsed).toBeNull();
    expect(r.categories[0].status).toBe('over'); // spent against a zero cap
  });

  it('ignores a budget in months before it starts', () => {
    const txns = [tx({ amount: -80, date: '2026-07-10', category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-07', asOf: '2026-08-15',
      budgets: [budget({ limit_amount: 500, start_month: '2026-08' })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].effectiveLimit).toBe(0);
    expect(r.categories[0].percentUsed).toBeNull();
  });

  it('sums per-category spend correctly via the helpers', () => {
    const txns = [
      tx({ amount: -10, category: 'Groceries' }),
      tx({ amount: -15, category: 'groceries' }),
      tx({ amount: -25, category: 'Dining' }),
    ];
    const spend = monthlySpend(txns, spendOptions(txns));
    expect(spend.total).toBe(50);
    expect(spendForCategoryKey(spend.byCategory, 'groceries')).toBe(25);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Overall budget
// ═════════════════════════════════════════════════════════════════════════════
describe('overall spending budget', () => {
  it('caps every category together, including unbudgeted ones', () => {
    const txns = [
      tx({ amount: -300, category: 'Groceries' }),
      tx({ amount: -200, category: 'Dining' }),
      tx({ amount: -100, category: 'Fuel' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [
        budget({ id: 'all', scope: 'overall', category: null, limit_amount: 1000 }),
        budget({ id: 'gro', category: 'Groceries', limit_amount: 250 }),
      ],
      transactions: txns, spendOptions: spendOptions(txns),
      includeUnbudgeted: true,
    });

    expect(r.overall).not.toBeNull();
    expect(r.overall!.spent).toBe(600);
    expect(r.overall!.remaining).toBe(400);
    expect(r.overall!.percentUsed).toBe(60);

    // The category budget still tracks only its own category, and overspends.
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0].spent).toBe(300);
    expect(r.categories[0].status).toBe('over');

    // Spend with no budget of its own is surfaced, not hidden.
    expect(r.unbudgetedSpend).toBe(300);
    expect(r.unbudgeted.map(u => u.name).sort()).toEqual(['Dining', 'Fuel']);

    // Totals cover category budgets only — the overall cap is not added in.
    expect(r.totals.budgeted).toBe(250);
    expect(r.totals.spent).toBe(300);
  });

  it('is null when the user has not set one', () => {
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31', budgets: [budget()], transactions: [],
    });
    expect(r.overall).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rollover
// ═════════════════════════════════════════════════════════════════════════════
describe('rollover', () => {
  const threeMonths = () => [
    tx({ amount: -300, date: '2026-06-10', category: 'Groceries' }), // 200 under
    tx({ amount: -400, date: '2026-07-10', category: 'Groceries' }), // 100 under
    tx({ amount: -100, date: '2026-08-10', category: 'Groceries' }),
  ];

  it('carries nothing when rollover is off', () => {
    const txns = threeMonths();
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500, rollover_enabled: false, start_month: '2026-06' })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].rolloverIn).toBe(0);
    expect(r.categories[0].effectiveLimit).toBe(500);
    expect(r.categories[0].rolloverOut).toBe(0);
  });

  it('adds unspent earlier months to this month’s cap', () => {
    const txns = threeMonths();
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500, rollover_enabled: true, start_month: '2026-06' })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    const line = r.categories[0];
    expect(line.rolloverIn).toBe(300);        // 200 (Jun) + 100 (Jul)
    expect(line.effectiveLimit).toBe(800);
    expect(line.spent).toBe(100);
    expect(line.remaining).toBe(700);
    expect(line.percentUsed).toBe(12.5);
    expect(line.rolloverOut).toBe(700);       // what September would inherit
  });

  it('carries an overspend forward as a DEBT against the next month', () => {
    const txns = [
      tx({ amount: -800, date: '2026-07-10', category: 'Groceries' }), // 300 over
      tx({ amount: -200, date: '2026-08-10', category: 'Groceries' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500, rollover_enabled: true, start_month: '2026-07' })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    const line = r.categories[0];
    expect(line.rolloverIn).toBe(-300);
    expect(line.effectiveLimit).toBe(200);
    expect(line.remaining).toBe(0);
    expect(line.status).toBe('under'); // exactly on the reduced cap
  });

  it('never accumulates from before the budget started', () => {
    const txns = threeMonths();
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500, rollover_enabled: true, start_month: '2026-07' })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].rolloverIn).toBe(100); // July only, not June
  });

  it('never invents surplus from months whose transactions are not loaded', () => {
    // Only August is loaded, but the budget claims to have started in January.
    // Assuming zero spend for Feb–Jul would hand it seven phantom months of cap.
    const txns = [tx({ amount: -100, date: '2026-08-10', category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 500, rollover_enabled: true, start_month: '2026-01' })],
      transactions: txns, spendOptions: spendOptions(txns),
      coverageFromMonth: '2026-08',
    });
    expect(r.categories[0].rolloverIn).toBe(0);
    expect(r.categories[0].effectiveLimit).toBe(500);
  });

  it('bounds how far back carry accumulates', () => {
    const txns = [tx({ amount: -0.01, date: '2026-08-10', category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ limit_amount: 100, rollover_enabled: true, start_month: '2000-01' })],
      transactions: txns, spendOptions: spendOptions(txns),
      rolloverMaxMonths: 3,
    });
    expect(r.categories[0].rolloverIn).toBe(300); // 3 unspent months, not 26 years
  });

  it('rolls the overall budget over independently of category budgets', () => {
    const txns = [
      tx({ amount: -600, date: '2026-07-10', category: 'Dining' }),
      tx({ amount: -100, date: '2026-08-10', category: 'Dining' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({
        id: 'all', scope: 'overall', category: null,
        limit_amount: 1000, rollover_enabled: true, start_month: '2026-07',
      })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.overall!.rolloverIn).toBe(400);
    expect(r.overall!.effectiveLimit).toBe(1400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Projected month-end spend
// ═════════════════════════════════════════════════════════════════════════════
describe('projected month-end spend', () => {
  it('projects a completed month to exactly what was spent', () => {
    expect(projectMonthEnd({ spent: 420, daysElapsed: 31, daysInMonth: 31 })).toBe(420);
  });

  it('extrapolates the in-month run rate when nothing has been learned', () => {
    // $100 over 10 of 30 days → $300 by month end.
    expect(projectMonthEnd({ spent: 100, daysElapsed: 10, daysInMonth: 30 })).toBe(300);
  });

  it('leans on the learned monthly rate early, on actuals late', () => {
    const early = projectMonthEnd({ spent: 20, daysElapsed: 3, daysInMonth: 30, monthlyRate: 600 });
    const late = projectMonthEnd({ spent: 500, daysElapsed: 27, daysInMonth: 30, monthlyRate: 600 });
    // Day 3: a $200/month run rate barely moves the $600 expectation.
    expect(early).toBeGreaterThan(400);
    // Day 27: actuals dominate — near the $555 run rate, not the $600 estimate.
    expect(late).toBeLessThan(580);
    expect(late).toBeGreaterThan(500);
  });

  it('uses the learned rate alone for a month that has not started', () => {
    expect(projectMonthEnd({ spent: 0, daysElapsed: 0, daysInMonth: 30, monthlyRate: 450 })).toBe(450);
    expect(projectMonthEnd({ spent: 0, daysElapsed: 0, daysInMonth: 30 })).toBe(0);
  });

  it('adds known scheduled outflows still to land', () => {
    expect(projectMonthEnd({
      spent: 100, daysElapsed: 15, daysInMonth: 30, scheduledRemaining: 50,
    })).toBe(250);
  });

  it('never projects below what is already spent', () => {
    expect(projectMonthEnd({ spent: 900, daysElapsed: 29, daysInMonth: 30, monthlyRate: 100 }))
      .toBeGreaterThanOrEqual(900);
  });

  it('flags a category as at-risk while it is still under its cap', () => {
    // $300 in the first 10 days of a 31-day month against a $500 cap.
    const txns = [tx({ amount: -300, date: '2026-08-05', category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-10',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    const line = r.categories[0];
    expect(line.spent).toBe(300);
    expect(line.remaining).toBe(200);          // still inside the cap today
    expect(line.projected).toBeGreaterThan(500);
    expect(line.projectedRemaining).toBeLessThan(0);
    expect(line.status).toBe('at-risk');
  });

  it('uses the learned per-category rate, matched case-insensitively', () => {
    const txns = [tx({ amount: -10, date: '2026-08-02', category: 'Groceries' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-02',
      budgets: [budget({ limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns),
      projection: { monthlyRateByCategory: { groceries: 620 } },
    });
    // Two days in, the learned $620/month dominates the tiny run rate.
    expect(r.categories[0].projected).toBeGreaterThan(500);
    expect(r.categories[0].status).toBe('at-risk');
  });

  it('reports days elapsed as 0 for a future month and full for a past one', () => {
    const future = buildBudgetReport({
      month: '2026-12', asOf: '2026-08-10', budgets: [budget()], transactions: [],
    });
    expect(future.daysElapsed).toBe(0);
    expect(future.daysInMonth).toBe(31);

    const past = buildBudgetReport({
      month: '2026-02', asOf: '2026-08-10', budgets: [budget()], transactions: [],
    });
    expect(past.daysElapsed).toBe(28);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Category changes
// ═════════════════════════════════════════════════════════════════════════════
describe('category changes', () => {
  it('moves spend between budgets when a transaction is recategorised', () => {
    const budgets = [
      budget({ id: 'gro', category: 'Groceries', limit_amount: 300 }),
      budget({ id: 'din', category: 'Dining', limit_amount: 300 }),
    ];
    const before = [tx({ id: 'x', amount: -120, category: 'Groceries' })];
    const after = [tx({ id: 'x', amount: -120, category: 'Dining' })];
    const common = { month: '2026-08', asOf: '2026-08-31', budgets };

    const r1 = buildBudgetReport({ ...common, transactions: before, spendOptions: spendOptions(before) });
    const r2 = buildBudgetReport({ ...common, transactions: after, spendOptions: spendOptions(after) });

    expect(r1.categories.find(c => c.key === 'groceries')!.spent).toBe(120);
    expect(r1.categories.find(c => c.key === 'dining')!.spent).toBe(0);
    expect(r2.categories.find(c => c.key === 'groceries')!.spent).toBe(0);
    expect(r2.categories.find(c => c.key === 'dining')!.spent).toBe(120);
  });

  it('tracks a user-created custom category like any built-in one', () => {
    const txns = [tx({ amount: -75, category: 'Dog stuff' })];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ category: 'Dog stuff', limit_amount: 100 })],
      transactions: txns, spendOptions: spendOptions(txns),
    });
    expect(r.categories[0].spent).toBe(75);
    expect(r.categories[0].percentUsed).toBe(75);
  });

  it('re-points a budget when its category is renamed', () => {
    const rows = [budget({ id: 'gro', category: 'Groceries' })];
    const out = applyCategoryRename(rows, 'groceries', 'Food & Drink');
    expect(out[0].category).toBe('Food & Drink');
    expect(out[0].active).not.toBe(false);
  });

  it('retires the renamed budget instead of doubling an existing cap', () => {
    const rows = [
      budget({ id: 'gro', category: 'Groceries', limit_amount: 400 }),
      budget({ id: 'food', category: 'Food', limit_amount: 250 }),
    ];
    const out = applyCategoryRename(rows, 'Groceries', 'Food');
    expect(out.find(b => b.id === 'gro')!.active).toBe(false);
    expect(out.find(b => b.id === 'food')!.limit_amount).toBe(250);
    expect(normaliseBudgets(out)).toHaveLength(1);
  });

  it('leaves the overall budget and unrelated rows untouched on rename', () => {
    const rows = [
      budget({ id: 'all', scope: 'overall', category: null }),
      budget({ id: 'din', category: 'Dining' }),
    ];
    const out = applyCategoryRename(rows, 'Groceries', 'Food');
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toBe(rows[1]);
  });

  it('imports the legacy plan’s category goals once, converted to monthly', () => {
    const plan = [{ name: 'Groceries', amount: 100 }, { name: 'Health', amount: 50 }];
    const first = budgetsFromLegacyPlan(plan, 'weekly', []);
    expect(first).toEqual([
      { category: 'Groceries', monthlyLimit: 433.33 },
      { category: 'Health', monthlyLimit: 216.67 },
    ]);

    // Once imported, a second run proposes nothing for that category.
    const existing = [budget({ category: 'Groceries', limit_amount: 433.33 })];
    expect(budgetsFromLegacyPlan(plan, 'weekly', existing).map(p => p.category)).toEqual(['Health']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  User isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('user isolation', () => {
  it('ignores another user’s budgets entirely', () => {
    const rows = [
      budget({ id: 'mine', user_id: 'u1', category: 'Groceries', limit_amount: 300 }),
      budget({ id: 'theirs', user_id: 'u2', category: 'Dining', limit_amount: 900 }),
    ];
    const out = normaliseBudgets(rows, { userId: 'u1' });
    expect(out.map(b => b.id)).toEqual(['mine']);
  });

  it('does not let another user’s budget shadow mine on the same category', () => {
    const rows = [
      budget({ id: 'mine', user_id: 'u1', category: 'Groceries', limit_amount: 300, updated_at: '2026-01-01' }),
      budget({ id: 'theirs', user_id: 'u2', category: 'Groceries', limit_amount: 9999, updated_at: '2026-08-01' }),
    ];
    const out = normaliseBudgets(rows, { userId: 'u1' });
    expect(out).toHaveLength(1);
    expect(out[0].monthlyLimit).toBe(300);
  });

  it('ignores another user’s transactions when totalling spend', () => {
    const txns = [
      tx({ amount: -100, user_id: 'u1', category: 'Groceries' }),
      tx({ amount: -900, user_id: 'u2', category: 'Groceries' }),
    ];
    const r = buildBudgetReport({
      month: '2026-08', asOf: '2026-08-31',
      budgets: [budget({ user_id: 'u1', limit_amount: 500 })],
      transactions: txns, spendOptions: spendOptions(txns), userId: 'u1',
    });
    expect(r.categories[0].spent).toBe(100);
    expect(r.totalSpent).toBe(100);
  });

  it('keeps local rows that have no user stamped yet (created offline)', () => {
    const rows = [{ ...budget({ id: 'local' }), user_id: undefined }];
    expect(normaliseBudgets(rows, { userId: 'u1' })).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Report shape
// ═════════════════════════════════════════════════════════════════════════════
describe('report assembly', () => {
  it('defaults the month to the month of asOf', () => {
    const r = buildBudgetReport({ asOf: '2026-08-14', budgets: [], transactions: [] });
    expect(r.month).toBe('2026-08');
    expect(r.daysElapsed).toBe(14);
  });

  it('is empty but well-formed with no budgets and no transactions', () => {
    const r = buildBudgetReport({ asOf: '2026-08-14', budgets: [], transactions: [] });
    expect(r.overall).toBeNull();
    expect(r.categories).toEqual([]);
    expect(r.unbudgetedSpend).toBe(0);
    expect(r.totals).toEqual({ budgeted: 0, spent: 0, remaining: 0, projected: 0 });
  });

  it('orders categories by the size of their cap', () => {
    const budgets = [
      budget({ id: 'a', category: 'Small', limit_amount: 50 }),
      budget({ id: 'b', category: 'Big', limit_amount: 900 }),
      budget({ id: 'c', category: 'Mid', limit_amount: 300 }),
    ];
    const r = buildBudgetReport({ asOf: '2026-08-14', budgets, transactions: [] });
    expect(r.categories.map(c => c.name)).toEqual(['Big', 'Mid', 'Small']);
  });

  it('is deterministic — the same inputs give the same report', () => {
    const txns = [tx({ amount: -100, category: 'Groceries' })];
    const args = {
      month: '2026-08', asOf: '2026-08-15',
      budgets: [budget({ limit_amount: 500, rollover_enabled: true })],
      transactions: txns, spendOptions: spendOptions(txns),
    };
    expect(buildBudgetReport(args)).toEqual(buildBudgetReport(args));
  });
});
