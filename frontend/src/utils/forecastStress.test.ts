/**
 * Forecast STRESS SUITE — synthetic data only.
 *
 * Every fixture in this file is hand-built. Nothing here touches Supabase,
 * localStorage, the network, or any of the user's real records. It drives the
 * same pure functions production uses:
 *   • utils/cashFlowForecast.ts  — occurrence generation, de-dup, projection
 *   • utils/adaptiveForecast.ts  — learned income + learned discretionary spend
 *   • utils/forecastView.ts      — per-account scoping and the balance line
 *
 * Each `describe` is one scenario from the stress brief. Expected 30/60/90
 * figures are derived by hand in the comments so a failure says which side is
 * wrong — the engine or the expectation.
 *
 * asOf is fixed at 2026-08-16, so:
 *   +30d → 2026-09-15   +60d → 2026-10-15   +90d → 2026-11-14
 */
import { describe, it, expect } from 'vitest';

import {
  buildCashFlowForecast, generateOccurrences, dedupeInputs, addDays, addMonths, round2,
  type RecurringInput, type AccountBalanceInput, type CashFlowForecast,
} from './cashFlowForecast';
import {
  learnFromHistory, detectCadence, removeOutliers, monthlyEquivalent, type HistoryTxn,
} from './adaptiveForecast';
import { scopePostings, openingFor, buildSeries } from './forecastView';

const ASOF = '2026-08-16';
const H30 = '2026-09-15';
const H60 = '2026-10-15';
const H90 = '2026-11-14';

// ── Fixture factories ────────────────────────────────────────────────────────

function ri(p: Partial<RecurringInput> & { id: string; amount: number; anchorDate: string }): RecurringInput {
  return {
    sourceType: 'bill', name: 'Thing', frequency: 'monthly',
    accountId: null, confidence: 1, ...p,
  } as RecurringInput;
}

function acct(accountId: string, balance: number, name = accountId): AccountBalanceInput {
  return { accountId, name, balance };
}

function htxn(p: Partial<HistoryTxn> & { date: string; amount: number }): HistoryTxn {
  return {
    category: 'Uncategorised', accountId: 'acc-1', merchantKey: 'thing', merchantName: 'Thing',
    isSpend: p.amount < 0, isTransfer: false, isRefund: false, committed: false, ...p,
  };
}

function run(accounts: AccountBalanceInput[], inputs: RecurringInput[], asOf = ASOF): CashFlowForecast {
  return buildCashFlowForecast({ asOf, accounts, inputs });
}

/** [d30, d60, d90] projected household balances. */
function balances(f: CashFlowForecast): number[] {
  return f.horizons.map(h => h.projectedBalance);
}

/** Sum of every per-account projection at one horizon (incl. the unallocated bucket). */
function accountSum(f: CashFlowForecast, key: 'd30' | 'd60' | 'd90'): number {
  return round2(f.accounts.reduce((s, a) => s + a[key], 0));
}

/** INVARIANT: per-account projections must add up to the household total.
 *  If they don't, one screen contradicts the other. */
function expectAccountsReconcile(f: CashFlowForecast): void {
  expect(accountSum(f, 'd30')).toBe(f.horizons[0].projectedBalance);
  expect(accountSum(f, 'd60')).toBe(f.horizons[1].projectedBalance);
  expect(accountSum(f, 'd90')).toBe(f.horizons[2].projectedBalance);
}

/** Dates of every projected event for one source id. */
function datesFor(f: CashFlowForecast, sourceId: string): string[] {
  return f.events.filter(e => e.sourceId === sourceId).map(e => e.date);
}

// A regularly-spaced series of dates working BACKWARDS from `last`.
function backSeries(last: string, stepDays: number, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(last, -i * stepDays));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Steady salary
// ─────────────────────────────────────────────────────────────────────────────
describe('S1 · steady salary + fixed rent', () => {
  const inputs = [
    ri({ id: 'income:salary', sourceType: 'income', name: 'Acme Payroll', amount: 3000, frequency: 'fortnightly', anchorDate: '2026-08-20' }),
    ri({ id: 'bill:rent', name: 'Rent', amount: -2000, frequency: 'monthly', anchorDate: '2026-09-01' }),
  ];

  it('projects the hand-computed 30/60/90 balances', () => {
    // Salary: 08-20,09-03 (2) | +09-17,10-01,10-15 (5) | +10-29,11-12 (7)
    // Rent:   09-01 (1)       | +10-01 (2)             | +11-01 (3)
    // 5000 + 6000 − 2000 = 9000 | 5000 + 15000 − 4000 = 16000 | 5000 + 21000 − 6000 = 20000
    const f = run([acct('acc-1', 5000)], inputs);
    expect(balances(f)).toEqual([9000, 16000, 20000]);
  });

  it('reports inflow/outflow separately and never dips below opening', () => {
    const f = run([acct('acc-1', 5000)], inputs);
    expect(f.horizons[2].inflow).toBe(21000);
    expect(f.horizons[2].outflow).toBe(-6000);
    expect(f.horizons[2].net).toBe(15000);
    expect(f.horizons[2].lowestBalance).toBe(5000); // pay always lands before the next rent
  });

  it('keeps per-account projections reconciled with the household total', () => {
    expectAccountsReconcile(run([acct('acc-1', 5000)], inputs));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Weekly / fortnightly / monthly pay cadences
// ─────────────────────────────────────────────────────────────────────────────
describe('S2 · weekly, fortnightly and monthly pay cadences', () => {
  it('weekly pay lands 5 / 9 / 13 times', () => {
    const f = run([acct('acc-1', 0)], [
      ri({ id: 'income:w', sourceType: 'income', name: 'Weekly pay', amount: 1000, frequency: 'weekly', anchorDate: '2026-08-17' }),
    ]);
    expect(balances(f)).toEqual([5000, 9000, 13000]);
  });

  it('fortnightly pay lands 3 / 5 / 7 times', () => {
    const f = run([acct('acc-1', 0)], [
      ri({ id: 'income:f', sourceType: 'income', name: 'Fortnightly pay', amount: 2000, frequency: 'fortnightly', anchorDate: '2026-08-17' }),
    ]);
    expect(balances(f)).toEqual([6000, 10000, 14000]);
  });

  it('monthly pay lands 1 / 2 / 3 times', () => {
    const f = run([acct('acc-1', 0)], [
      ri({ id: 'income:m', sourceType: 'income', name: 'Monthly pay', amount: 4000, frequency: 'monthly', anchorDate: '2026-08-17' }),
    ]);
    expect(balances(f)).toEqual([4000, 8000, 12000]);
  });

  it('a stale anchor years in the past still projects the current cycle', () => {
    // A weekly series anchored 2006-01-04 is 1076 periods old. The engine must
    // fast-forward to the live cycle rather than give up and project nothing.
    const dates = generateOccurrences(
      { anchorDate: '2006-01-04', frequency: 'weekly' }, ASOF, H30,
    );
    expect(dates).toEqual(['2026-08-19', '2026-08-26', '2026-09-02', '2026-09-09']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pay rises
// ─────────────────────────────────────────────────────────────────────────────
describe('S3 · pay rise carries forward at the new level', () => {
  const dates = backSeries('2026-08-14', 14, 6); // 06-05 … 08-14
  const history = dates.map((date, i) => htxn({
    date, amount: i < 3 ? 3000 : 3300, isSpend: false,
    merchantKey: 'acme', merchantName: 'Acme Payroll', category: 'Salary',
  }));

  it('learns the post-rise amount, not the average', () => {
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income).toHaveLength(1);
    expect(r.income[0].amount).toBe(3300);          // median of the last three
    expect(r.income[0].frequency).toBe('fortnightly');
    expect(r.income[0].nextDate).toBe('2026-08-28');
    expect(r.income[0].confidence).toBe(0.85);      // capped: 6 observations
  });

  it('projects 2 / 4 / 6 pays at the new level', () => {
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    const f = run([acct('acc-1', 0)], r.learnedInputs);
    expect(balances(f)).toEqual([6600, 13200, 19800]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Bonuses
// ─────────────────────────────────────────────────────────────────────────────
describe('S4 · a one-off bonus does not inflate the ongoing rate', () => {
  const dates = backSeries('2026-08-14', 14, 6);

  it('smooths a bonus in the middle of the run', () => {
    const history = dates.map((date, i) => htxn({
      date, amount: date === '2026-07-31' ? 9000 : 3000, isSpend: false,
      merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    void dates;
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income[0].amount).toBe(3000);
  });

  it('smooths a bonus paid in the most recent cycle', () => {
    const history = dates.map(date => htxn({
      date, amount: date === '2026-08-14' ? 9000 : 3000, isSpend: false,
      merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income[0].amount).toBe(3000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Irregular income
// ─────────────────────────────────────────────────────────────────────────────
describe('S5 · irregular income is never mistaken for salary', () => {
  it('rejects erratic spacing', () => {
    expect(detectCadence(['2026-06-05', '2026-06-25', '2026-07-02', '2026-08-10'])).toBeNull();
  });

  it('projects nothing for a freelancer with lumpy deposits', () => {
    const history = [
      htxn({ date: '2026-06-05', amount: 1800, isSpend: false, merchantKey: 'client', merchantName: 'Client Co' }),
      htxn({ date: '2026-06-25', amount: 4200, isSpend: false, merchantKey: 'client', merchantName: 'Client Co' }),
      htxn({ date: '2026-07-02', amount: 900, isSpend: false, merchantKey: 'client', merchantName: 'Client Co' }),
      htxn({ date: '2026-08-10', amount: 3100, isSpend: false, merchantKey: 'client', merchantName: 'Client Co' }),
    ];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income).toHaveLength(0);
    expect(r.learnedInputs.filter(i => i.sourceType === 'learned_income')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Unemployment / stopped income
// ─────────────────────────────────────────────────────────────────────────────
describe('S6 · income that has stopped is not projected forward', () => {
  it('drops a fortnightly stream whose last pay is 58 days old', () => {
    const history = backSeries('2026-06-19', 14, 3).map(date => htxn({
      date, amount: 3000, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income).toHaveLength(0);
  });

  it('still projects a stream only one cycle late (a shifted payday)', () => {
    // last pay 2026-08-01 → 15 days old, inside 14 × 1.6 = 22.4
    const history = backSeries('2026-08-01', 14, 3).map(date => htxn({
      date, amount: 3000, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income).toHaveLength(1);
    expect(r.income[0].confidence).toBe(0.6); // floor: exactly 3 observations
  });

  it('a stopped salary leaves the balance falling under fixed costs', () => {
    const history = backSeries('2026-06-19', 14, 3).map(date => htxn({
      date, amount: 3000, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    const f = run([acct('acc-1', 4000)], [
      ...r.learnedInputs,
      ri({ id: 'bill:rent', name: 'Rent', amount: -2000, frequency: 'monthly', anchorDate: '2026-09-01' }),
    ]);
    expect(balances(f)).toEqual([2000, 0, -2000]);
    expect(f.horizons[2].lowestBalance).toBe(-2000);
    expect(f.horizons[2].lowestDate).toBe('2026-11-01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Variable grocery / fun spending
// ─────────────────────────────────────────────────────────────────────────────
const GROCERY_DATES = Array.from({ length: 12 }, (_, i) => addDays('2026-05-24', i * 7));

describe('S7 · variable discretionary spend becomes a smooth weekly rate', () => {
  const history = GROCERY_DATES.map((date, i) => htxn({
    date, amount: i % 2 === 0 ? -80 : -120, category: 'Groceries', merchantKey: 'coles', merchantName: 'Coles',
  }));

  it('learns $434.82/mo from $1,200 over an 84-day span', () => {
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    const cat = r.categories.find(c => c.category === 'Groceries')!;
    expect(cat.txns).toBe(12);
    expect(cat.removedOutliers).toBe(0);
    expect(cat.monthlyObserved).toBe(434.82);
    expect(cat.monthlyResidual).toBe(434.82);
  });

  it('spreads it as $100/week → −400 / −800 / −1200', () => {
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    const spend = r.learnedInputs.find(i => i.sourceType === 'learned_spend')!;
    expect(spend.amount).toBe(-100);
    expect(spend.frequency).toBe('weekly');
    expect(spend.confidence).toBe(0.5);
    const f = run([acct('acc-1', 0)], r.learnedInputs);
    expect(balances(f)).toEqual([-400, -800, -1200]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Seasonal spikes
// ─────────────────────────────────────────────────────────────────────────────
describe('S8 · a seasonal spike is excluded from the ongoing rate', () => {
  it('removes a $2,000 one-off and keeps the $434.82 baseline', () => {
    const history = [
      ...GROCERY_DATES.map((date, i) => htxn({
        date, amount: i % 2 === 0 ? -80 : -120, category: 'Groceries', merchantKey: 'coles',
      })),
      htxn({ date: '2026-07-15', amount: -2000, category: 'Groceries', merchantKey: 'coles' }),
    ];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    const cat = r.categories.find(c => c.category === 'Groceries')!;
    expect(cat.removedOutliers).toBe(1);
    expect(cat.monthlyObserved).toBe(434.82);
  });

  it('keeps a genuinely bimodal category (no MAD → 4× median fallback)', () => {
    expect(removeOutliers([100, 100, 100, 100, 5000])).toEqual({ kept: [100, 100, 100, 100], removed: 1 });
    expect(removeOutliers([100, 120, 300, 320])).toEqual({ kept: [100, 120, 300, 320], removed: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Annual bills
// ─────────────────────────────────────────────────────────────────────────────
describe('S9 · annual bills', () => {
  it('lands once inside the horizon it falls in', () => {
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:insurance', name: 'Car insurance', amount: -1200, frequency: 'annually', anchorDate: '2026-10-01' }),
    ]);
    expect(balances(f)).toEqual([5000, 3800, 3800]);
    expect(datesFor(f, 'bill:insurance')).toEqual(['2026-10-01']);
  });

  it('is invisible when it falls beyond 90 days', () => {
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:rego', name: 'Rego', amount: -900, frequency: 'annually', anchorDate: '2027-03-01' }),
    ]);
    expect(balances(f)).toEqual([5000, 5000, 5000]);
    expect(f.events).toHaveLength(0);
  });

  it('rolls a past anchor forward to next year', () => {
    expect(generateOccurrences({ anchorDate: '2025-10-01', frequency: 'annually' }, ASOF, H90))
      .toEqual(['2026-10-01']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Quarterly bills
// ─────────────────────────────────────────────────────────────────────────────
describe('S10 · quarterly bills', () => {
  it('lands once in a 90-day window', () => {
    const f = run([acct('acc-1', 3000)], [
      ri({ id: 'bill:water', name: 'Water', amount: -450, frequency: 'quarterly', anchorDate: '2026-09-10' }),
    ]);
    expect(balances(f)).toEqual([2550, 2550, 2550]);
  });

  it('steps a past anchor to the next quarter, not to today', () => {
    const f = run([acct('acc-1', 3000)], [
      ri({ id: 'bill:power', name: 'Power', amount: -600, frequency: 'quarterly', anchorDate: '2026-06-20' }),
    ]);
    expect(datesFor(f, 'bill:power')).toEqual(['2026-09-20']);
    expect(balances(f)).toEqual([3000, 2400, 2400]);
  });

  it('two quarterly bills can both land inside 90 days', () => {
    const f = run([acct('acc-1', 3000)], [
      ri({ id: 'bill:water', name: 'Water', amount: -450, frequency: 'quarterly', anchorDate: '2026-08-25' }),
      ri({ id: 'bill:power', name: 'Power', amount: -600, frequency: 'quarterly', anchorDate: '2026-06-20' }),
    ]);
    expect(balances(f)).toEqual([2550, 1950, 1950]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Subscriptions with price changes
// ─────────────────────────────────────────────────────────────────────────────
describe('S11 · subscription price changes vs a stale detected series', () => {
  it('de-dupes when the price moved inside the 2% / $1 tolerance', () => {
    const { kept, suppressed } = dedupeInputs([
      ri({ id: 'sub:spotify', sourceType: 'subscription', name: 'Spotify Premium', amount: -16.2, anchorDate: '2026-09-05' }),
      ri({ id: 'series:spotify', sourceType: 'recurring_series', name: 'Spotify', amount: -15.99, anchorDate: '2026-09-05' }),
    ]);
    expect(kept.map(k => k.id)).toEqual(['sub:spotify']);
    expect(suppressed[0]).toMatchObject({ id: 'series:spotify', reason: 'series-matches-subscription', keptId: 'sub:spotify' });
  });

  it('KNOWN GAP: a >2% price rise leaves both records and double-counts', () => {
    // Real case: Spotify went 15.99 → 18.99. The detected series still carries
    // the old amount, so amountsClose() fails and BOTH project.
    // Deliberately left as-is: silently suppressing here would risk deleting a
    // genuine second obligation, and over-stating an OUTFLOW is the safe error.
    const inputs = [
      ri({ id: 'sub:spotify', sourceType: 'subscription', name: 'Spotify Premium', amount: -18.99, anchorDate: '2026-09-05' }),
      ri({ id: 'series:spotify', sourceType: 'recurring_series', name: 'Spotify', amount: -15.99, anchorDate: '2026-09-05' }),
    ];
    const { suppressed } = dedupeInputs(inputs);
    expect(suppressed).toHaveLength(0);
    const f = run([acct('acc-1', 500)], inputs);
    expect(balances(f)).toEqual([465.02, 430.04, 395.06]); // −34.98/mo, i.e. both charged
  });

  it('does not de-dupe two genuinely different subscriptions from one vendor', () => {
    const { suppressed } = dedupeInputs([
      ri({ id: 'sub:icloud', sourceType: 'subscription', name: 'Apple iCloud', amount: -4.49, anchorDate: '2026-09-05' }),
      ri({ id: 'series:applemusic', sourceType: 'recurring_series', name: 'Apple Music', amount: -12.99, anchorDate: '2026-09-05' }),
    ]);
    expect(suppressed).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Missed / overdue bills
// ─────────────────────────────────────────────────────────────────────────────
describe('S12 · missed and overdue bills', () => {
  it('an unpaid ONE-OFF bill that is already overdue must not vanish', () => {
    // A $2,400 tax bill that fell due on 2026-08-01 and was never paid is still
    // money that will leave the account. It must appear in the forecast.
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:tax', name: 'ATO tax', amount: -2400, frequency: 'once', anchorDate: '2026-08-01', overdue: true }),
    ]);
    expect(datesFor(f, 'bill:tax')).toEqual(['2026-08-17']);
    expect(balances(f)).toEqual([2600, 2600, 2600]);
  });

  it('a PAID one-off bill in the past stays out of the forecast', () => {
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:tax', name: 'ATO tax', amount: -2400, frequency: 'once', anchorDate: '2026-08-01', skipAnchor: true, overdue: false }),
    ]);
    expect(f.events).toHaveLength(0);
  });

  it('an overdue RECURRING bill catches up once, then resumes its cycle', () => {
    // Anchor 2026-07-05, unpaid. Normal cycle resumes 08-05→next future is 09-05.
    // The missed cycle is carried to tomorrow rather than written off.
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:strata', name: 'Strata', amount: -300, frequency: 'monthly', anchorDate: '2026-07-05', overdue: true }),
    ]);
    expect(datesFor(f, 'bill:strata')).toEqual(['2026-08-17', '2026-09-05', '2026-10-05', '2026-11-05']);
    expect(balances(f)).toEqual([4400, 4100, 3800]);
  });

  it('does not double-count when the overdue flag is set but the anchor is future', () => {
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:strata', name: 'Strata', amount: -300, frequency: 'monthly', anchorDate: '2026-09-05', overdue: true }),
    ]);
    expect(datesFor(f, 'bill:strata')).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
  });

  it('a recurring bill whose cycle already settled skips only the anchor', () => {
    const f = run([acct('acc-1', 5000)], [
      ri({ id: 'bill:rent', name: 'Rent', amount: -2000, frequency: 'monthly', anchorDate: '2026-08-20', skipAnchor: true }),
    ]);
    expect(datesFor(f, 'bill:rent')).toEqual(['2026-09-20', '2026-10-20']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Refunds
// ─────────────────────────────────────────────────────────────────────────────
describe('S13 · refunds', () => {
  const base = GROCERY_DATES.slice(0, 8).map((date, i) => htxn({
    date, amount: i % 2 === 0 ? -80 : -120, category: 'Groceries', merchantKey: 'coles',
  }));

  it('a refund inflow is never learned as income', () => {
    const history = [
      ...base,
      ...backSeries('2026-08-10', 30, 3).map(date => htxn({
        date, amount: 250, isSpend: false, isRefund: true, merchantKey: 'myer', merchantName: 'Myer',
      })),
    ];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income).toHaveLength(0);
  });

  it('KNOWN GAP: refunds do not reduce the learned spend rate', () => {
    // Refunds are excluded from learning by design, so a return-heavy category
    // forecasts GROSS spend. Conservative (over-states outflow) but it means a
    // category where half the purchases come back still projects at full rate.
    const withRefund = [
      ...base,
      htxn({ date: '2026-07-20', amount: 300, category: 'Groceries', isSpend: false, isRefund: true, merchantKey: 'coles' }),
    ];
    const a = learnFromHistory({ asOf: ASOF, history: base, knownInputs: [] });
    const b = learnFromHistory({ asOf: ASOF, history: withRefund, knownInputs: [] });
    expect(b.categories[0].monthlyObserved).toBe(a.categories[0].monthlyObserved);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Reimbursements
// ─────────────────────────────────────────────────────────────────────────────
describe('S14 · expense reimbursements', () => {
  it('a regular reimbursement IS learned as income, at the low-confidence floor', () => {
    // Not strictly wrong — it is real recurring cash — but it is the weakest
    // class of inflow, so it must carry the 0.6 floor rather than salary-grade
    // confidence, and it must not out-rank a real salary in the audit list.
    const history = [
      ...backSeries('2026-08-05', 30, 3).map(date => htxn({
        date, amount: 420, isSpend: false, merchantKey: 'expensify', merchantName: 'Expensify',
      })),
      ...backSeries('2026-08-14', 14, 6).map(date => htxn({
        date, amount: 3000, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll',
      })),
    ];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.income.map(i => i.merchantKey)).toEqual(['acme', 'expensify']);
    expect(r.income[1].confidence).toBe(0.6);
    expect(r.income[0].confidence).toBe(0.85);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Transfers between own accounts
// ─────────────────────────────────────────────────────────────────────────────
describe('S15 · internal transfers', () => {
  const accounts = [acct('acc-1', 5000, 'Everyday'), acct('acc-2', 1000, 'Savings')];

  it('moves money between accounts without changing household cash', () => {
    const f = run(accounts, [
      ri({ id: 'series:save', sourceType: 'recurring_series', name: 'To savings', amount: -500, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'acc-1', transfer: { counterpartAccountId: 'acc-2' } }),
    ]);
    expect(balances(f)).toEqual([6000, 6000, 6000]);
    const everyday = f.accounts.find(a => a.accountId === 'acc-1')!;
    const savings = f.accounts.find(a => a.accountId === 'acc-2')!;
    expect([everyday.d30, everyday.d60, everyday.d90]).toEqual([4500, 4000, 3500]);
    expect([savings.d30, savings.d60, savings.d90]).toEqual([1500, 2000, 2500]);
    expectAccountsReconcile(f);
  });

  it('a transfer with an UNKNOWN counterpart still reconciles to the total', () => {
    // This is what the DS actually emits for a detected transfer-like series:
    // counterpartAccountId is null. The debit leg must not disappear from the
    // account roll-up, or the per-account view contradicts the headline.
    const f = run(accounts, [
      ri({ id: 'series:save', sourceType: 'recurring_series', name: 'Transfer out', amount: -500, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'acc-1', transfer: { counterpartAccountId: null } }),
    ]);
    expect(balances(f)).toEqual([6000, 6000, 6000]);
    expectAccountsReconcile(f);
  });

  it('is excluded from the learned spend rate', () => {
    const history = [
      ...GROCERY_DATES.map((date, i) => htxn({
        date, amount: i % 2 === 0 ? -80 : -120, category: 'Groceries', merchantKey: 'coles',
      })),
      ...GROCERY_DATES.map(date => htxn({
        date, amount: -500, category: 'Transfer', isSpend: false, isTransfer: true, merchantKey: 'xfer',
      })),
    ];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.categories.map(c => c.category)).toEqual(['Groceries']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. Credit-card repayments
// ─────────────────────────────────────────────────────────────────────────────
describe('S16 · credit-card repayments', () => {
  it('a manual card-payment bill is de-duped against the card minimum', () => {
    const inputs = [
      ri({ id: 'card:amex', sourceType: 'credit_card', name: 'Amex (min payment)', amount: -450, anchorDate: '2026-09-03', confidence: 0.9 }),
      ri({ id: 'bill:amex', name: 'Amex payment', amount: -450, anchorDate: '2026-09-05', creditCardPayment: true }),
    ];
    const { suppressed } = dedupeInputs(inputs);
    expect(suppressed).toEqual([{ id: 'bill:amex', sourceType: 'bill', reason: 'mirrors-card', keptId: 'card:amex' }]);
    const f = run([acct('acc-1', 2000)], inputs);
    expect(balances(f)).toEqual([1550, 1100, 650]);
  });

  it('one bill cannot cancel two different cards', () => {
    const { suppressed } = dedupeInputs([
      ri({ id: 'card:a', sourceType: 'credit_card', name: 'Amex (min payment)', amount: -450, anchorDate: '2026-09-03' }),
      ri({ id: 'card:b', sourceType: 'credit_card', name: 'Visa (min payment)', amount: -450, anchorDate: '2026-09-03' }),
      ri({ id: 'bill:pay', name: 'Card payment', amount: -450, anchorDate: '2026-09-04', creditCardPayment: true }),
    ]);
    expect(suppressed).toHaveLength(1);
  });

  it('a same-amount utility bill near the card due date is NOT removed', () => {
    const { suppressed } = dedupeInputs([
      ri({ id: 'card:amex', sourceType: 'credit_card', name: 'Amex (min payment)', amount: -450, anchorDate: '2026-09-03' }),
      ri({ id: 'bill:power', name: 'Electricity', amount: -450, anchorDate: '2026-09-04' }),
    ]);
    expect(suppressed).toHaveLength(0);
  });

  it('KNOWN GAP: paying the full statement balance double-counts the minimum', () => {
    // User pays the whole $1,200 statement; the card record still projects its
    // $450 minimum. Amounts are not close, so no de-dup → −1,650 forecast for
    // −1,200 of real cash. Over-states an outflow, so it is left conservative.
    const inputs = [
      ri({ id: 'card:amex', sourceType: 'credit_card', name: 'Amex (min payment)', amount: -450, anchorDate: '2026-09-03' }),
      ri({ id: 'bill:amex', name: 'Amex payment', amount: -1200, anchorDate: '2026-09-05', creditCardPayment: true }),
    ];
    expect(dedupeInputs(inputs).suppressed).toHaveLength(0);
    const f = run([acct('acc-1', 5000)], inputs);
    expect(f.horizons[0].outflow).toBe(-1650);
  });

  it('a bill mirrored from a loan keeps the loan and records the audit trail', () => {
    const { kept, suppressed } = dedupeInputs([
      ri({ id: 'loan:car', sourceType: 'loan', name: 'Car loan', amount: -620, frequency: 'monthly', anchorDate: '2026-09-02' }),
      ri({ id: 'bill:car', name: 'Car loan payment', amount: -620, anchorDate: '2026-09-02', links: { loan_id: 'loan:car' } }),
    ]);
    expect(kept.map(k => k.id)).toEqual(['loan:car']);
    expect(suppressed[0].reason).toBe('mirrors-loan');
  });

  it('a mirror bill survives when the linked loan was deleted', () => {
    const { kept } = dedupeInputs([
      ri({ id: 'bill:car', name: 'Car loan payment', amount: -620, anchorDate: '2026-09-02', links: { loan_id: 'loan:gone' } }),
    ]);
    expect(kept.map(k => k.id)).toEqual(['bill:car']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. Large one-offs
// ─────────────────────────────────────────────────────────────────────────────
describe('S17 · large one-off movements', () => {
  it('a single big purchase hits exactly one horizon boundary', () => {
    const f = run([acct('acc-1', 12000)], [
      ri({ id: 'bill:reno', name: 'Kitchen deposit', amount: -8000, frequency: 'once', anchorDate: '2026-10-05' }),
    ]);
    expect(balances(f)).toEqual([12000, 4000, 4000]);
    expect(datesFor(f, 'bill:reno')).toEqual(['2026-10-05']);
  });

  it('a one-off dated exactly on a horizon boundary is included in that horizon', () => {
    const f = run([acct('acc-1', 12000)], [
      ri({ id: 'bill:edge', name: 'Edge', amount: -1000, frequency: 'once', anchorDate: H30 }),
    ]);
    expect(balances(f)).toEqual([11000, 11000, 11000]);
  });

  it('a one-off dated today is already in the balance and is not re-applied', () => {
    const f = run([acct('acc-1', 12000)], [
      ri({ id: 'bill:today', name: 'Today', amount: -1000, frequency: 'once', anchorDate: ASOF }),
    ]);
    expect(f.events).toHaveLength(0);
  });

  it('a large one-off inflow (asset sale) is projected too', () => {
    const f = run([acct('acc-1', 1000)], [
      ri({ id: 'income:sale', sourceType: 'income', name: 'Car sale', amount: 18000, frequency: 'once', anchorDate: '2026-09-01' }),
    ]);
    expect(balances(f)).toEqual([19000, 19000, 19000]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. Negative balances
// ─────────────────────────────────────────────────────────────────────────────
describe('S18 · negative balances and liquidity troughs', () => {
  it('reports the trough date, not just the horizon balance', () => {
    const f = run([acct('acc-1', 500)], [
      ri({ id: 'bill:rent', name: 'Rent', amount: -2000, frequency: 'once', anchorDate: '2026-08-20' }),
      ri({ id: 'income:pay', sourceType: 'income', name: 'Pay', amount: 3000, frequency: 'once', anchorDate: '2026-08-28' }),
    ]);
    expect(balances(f)).toEqual([1500, 1500, 1500]);
    expect(f.horizons[0].lowestBalance).toBe(-1500);
    expect(f.horizons[0].lowestDate).toBe('2026-08-20');
  });

  it('an already-overdrawn account projects from the negative opening', () => {
    const f = run([acct('acc-1', -820)], [
      ri({ id: 'income:pay', sourceType: 'income', name: 'Pay', amount: 1500, frequency: 'fortnightly', anchorDate: '2026-08-21' }),
    ]);
    expect(f.openingTotal).toBe(-820);
    expect(balances(f)).toEqual([2180, 5180, 9680]); // 2 / 4 / 7 pays
    expect(f.horizons[2].lowestBalance).toBe(-820);
    expect(f.horizons[2].lowestDate).toBe(ASOF);
  });

  it('the engine trough must match the chart trough (same-day netting)', () => {
    // Rent −2,000 and pay +3,000 both land on 2026-08-20. The day nets +1,000,
    // so the balance never actually goes negative. An engine that walks events
    // one at a time in NAME order would report a phantom −1,500 dip.
    const f = run([acct('acc-1', 500)], [
      ri({ id: 'bill:rent', name: 'Rent', amount: -2000, frequency: 'once', anchorDate: '2026-08-20' }),
      ri({ id: 'income:pay', sourceType: 'income', name: 'Salary', amount: 3000, frequency: 'once', anchorDate: '2026-08-20' }),
    ]);
    const chart = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 30);
    expect(chart.lowest).toBe(500);
    expect(f.horizons[0].lowestBalance).toBe(500);
    expect(f.horizons[0].lowestBalance).toBe(chart.lowest);
    expect(f.horizons[0].lowestDate).toBe(chart.lowestDate);
  });

  it('trough reporting is independent of event NAME ordering', () => {
    const withNames = (rentName: string, payName: string) => run([acct('acc-1', 500)], [
      ri({ id: 'bill:rent', name: rentName, amount: -2000, frequency: 'once', anchorDate: '2026-08-20' }),
      ri({ id: 'income:pay', sourceType: 'income', name: payName, amount: 3000, frequency: 'once', anchorDate: '2026-08-20' }),
    ]);
    const a = withNames('Rent', 'Salary');       // outflow sorts first
    const b = withNames('Zzz rent', 'Aaa salary'); // inflow sorts first
    expect(a.horizons[0].lowestBalance).toBe(b.horizons[0].lowestBalance);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. Sparse history
// ─────────────────────────────────────────────────────────────────────────────
describe('S19 · sparse history', () => {
  it('a brand-new user with no history still gets a valid forecast', () => {
    const r = learnFromHistory({ asOf: ASOF, history: [], knownInputs: [] });
    expect(r.learnedInputs).toHaveLength(0);
    const f = run([acct('acc-1', 250)], []);
    expect(balances(f)).toEqual([250, 250, 250]);
    expect(f.horizons[0].lowestBalance).toBe(250);
  });

  it('with no accounts at all the totals are zero rather than NaN', () => {
    const f = run([], [ri({ id: 'bill:x', name: 'X', amount: -100, anchorDate: '2026-09-01' })]);
    expect(f.openingTotal).toBe(0);
    expect(balances(f)).toEqual([-100, -200, -300]);
    expectAccountsReconcile(f);
  });

  it('fewer than 3 transactions in a category is not a pattern', () => {
    const history = [
      htxn({ date: '2026-06-01', amount: -90, category: 'Fun', merchantKey: 'a' }),
      htxn({ date: '2026-07-01', amount: -110, category: 'Fun', merchantKey: 'b' }),
    ];
    expect(learnFromHistory({ asOf: ASOF, history, knownInputs: [] }).categories).toHaveLength(0);
  });

  it('a burst inside 21 days is not annualised', () => {
    const history = [1, 2, 3, 4].map(i => htxn({
      date: addDays(ASOF, -10 + i), amount: -200, category: 'Fun', merchantKey: `m${i}`,
    }));
    expect(learnFromHistory({ asOf: ASOF, history, knownInputs: [] }).categories).toHaveLength(0);
  });

  it('two deposits are not enough to declare a salary', () => {
    const history = backSeries('2026-08-14', 14, 2).map(date => htxn({
      date, amount: 3000, isSpend: false, merchantKey: 'acme', merchantName: 'Acme',
    }));
    expect(learnFromHistory({ asOf: ASOF, history, knownInputs: [] }).income).toHaveLength(0);
  });

  it('KNOWN GAP: a 3-transaction, 22-day category extrapolates aggressively', () => {
    // $900 seen over 22 days becomes $1,245/mo. It clears the minimum gates but
    // rests on a very thin base — this is why learned spend carries confidence 0.5.
    const history = ['2026-07-25', '2026-08-01', '2026-08-08'].map((date, i) => htxn({
      date, amount: -300, category: 'Fun', merchantKey: `m${i}`,
    }));
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.categories[0].monthlyObserved).toBe(1245.17);
    expect(r.learnedInputs[0].confidence).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. Month-end dates
// ─────────────────────────────────────────────────────────────────────────────
describe('S20 · month-end anchors', () => {
  it('a 31st charge clamps in short months and RECOVERS afterwards', () => {
    expect(generateOccurrences({ anchorDate: '2026-08-31', frequency: 'monthly' }, ASOF, '2026-12-31'))
      .toEqual(['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
  });

  it('does not drift earlier month after month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-01-31', 3)).toBe('2026-04-30');
    expect(addMonths('2026-01-31', 4)).toBe('2026-05-31');
  });

  it('projects 1 / 2 / 3 month-end payments across the horizons', () => {
    const f = run([acct('acc-1', 4000)], [
      ri({ id: 'bill:strata', name: 'Strata', amount: -400, frequency: 'monthly', anchorDate: '2026-08-31' }),
    ]);
    expect(balances(f)).toEqual([3600, 3200, 2800]);
  });

  it('a 30th anchor never lands on the 31st', () => {
    expect(generateOccurrences({ anchorDate: '2026-09-30', frequency: 'monthly' }, ASOF, '2026-12-31'))
      .toEqual(['2026-09-30', '2026-10-30', '2026-11-30', '2026-12-30']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21. Leap years
// ─────────────────────────────────────────────────────────────────────────────
describe('S21 · leap years', () => {
  it('a 31st monthly charge lands on 29 Feb in a leap year', () => {
    expect(generateOccurrences({ anchorDate: '2028-01-31', frequency: 'monthly' }, '2028-02-15', '2028-04-30'))
      .toEqual(['2028-02-29', '2028-03-31', '2028-04-30']);
  });

  it('a 29 Feb annual bill clamps to 28 Feb in common years', () => {
    expect(generateOccurrences({ anchorDate: '2028-02-29', frequency: 'annually' }, '2029-01-15', '2029-04-15'))
      .toEqual(['2029-02-28']);
  });

  it('and returns to 29 Feb at the next leap year', () => {
    expect(generateOccurrences({ anchorDate: '2028-02-29', frequency: 'annually' }, '2032-01-01', '2032-12-31'))
      .toEqual(['2032-02-29']);
  });

  it('a 90-day window spanning 29 Feb has the right day count', () => {
    expect(addDays('2028-01-15', 90)).toBe('2028-04-14'); // 2028 is a leap year
    expect(addDays('2029-01-15', 90)).toBe('2029-04-15');
  });

  it('projects a full leap-February forecast without drift', () => {
    const f = run([acct('acc-1', 6000)], [
      ri({ id: 'income:pay', sourceType: 'income', name: 'Pay', amount: 2500, frequency: 'fortnightly', anchorDate: '2028-02-18' }),
      ri({ id: 'bill:rent', name: 'Rent', amount: -1800, frequency: 'monthly', anchorDate: '2028-01-31' }),
    ], '2028-02-15');
    // Pay ≤ 03-16: 02-18, 03-03 (2) | Rent ≤ 03-16: 02-29 (1)
    expect(f.horizons[0].projectedBalance).toBe(6000 + 5000 - 1800);
    expect(datesFor(f, 'bill:rent')).toContain('2028-02-29');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22. Account filters
// ─────────────────────────────────────────────────────────────────────────────
describe('S22 · account filters', () => {
  const accounts = [acct('acc-1', 5000, 'Everyday'), acct('acc-2', 9000, 'Savings')];
  const inputs = [
    ri({ id: 'sub:netflix', sourceType: 'subscription', name: 'Netflix', amount: -20, anchorDate: '2026-09-01', accountId: 'acc-1', confidence: 0.85 }),
    ri({ id: 'sub:gym', sourceType: 'subscription', name: 'Gym', amount: -60, anchorDate: '2026-09-02', accountId: 'acc-2' }),
    ri({ id: 'bill:rent', name: 'Rent', amount: -2000, anchorDate: '2026-09-01', accountId: null }),
  ];

  it('scopes the balance line to one account', () => {
    const f = run(accounts, inputs);
    const everyday = buildSeries(openingFor(f, 'acc-1'), scopePostings(f, 'acc-1'), ASOF, 30);
    expect(everyday.closing).toBe(4980);
    const savings = buildSeries(openingFor(f, 'acc-2'), scopePostings(f, 'acc-2'), ASOF, 30);
    expect(savings.closing).toBe(8940);
  });

  it('the household total still includes unallocated obligations', () => {
    const f = run(accounts, inputs);
    expect(balances(f)).toEqual([11920, 9840, 7760]);
    expectAccountsReconcile(f);
  });

  it('KNOWN GAP: bills/income/loans/cards have no account, so they sit in Unallocated', () => {
    // The DS assigns accountId only to subscriptions and detected series. Every
    // bill, income, loan and card payment lands in __unallocated__, so filtering
    // to a single account shows a materially incomplete picture.
    const f = run(accounts, inputs);
    const unallocated = f.accounts.find(a => a.name === 'Unallocated')!;
    expect(unallocated.openingBalance).toBe(0);
    expect(unallocated.d30).toBe(-2000);
    expect([...new Set(scopePostings(f, 'acc-1').map(p => p.event.sourceId))]).toEqual(['sub:netflix']);
  });

  it('an event on an unknown account routes to Unallocated rather than being lost', () => {
    const f = run(accounts, [
      ri({ id: 'sub:ghost', sourceType: 'subscription', name: 'Ghost', amount: -30, anchorDate: '2026-09-01', accountId: 'acc-deleted' }),
    ]);
    expect(f.accounts.find(a => a.name === 'Unallocated')!.d30).toBe(-30);
    expectAccountsReconcile(f);
  });

  it('the transfer receiving leg appears in the destination account only', () => {
    const f = run(accounts, [
      ri({ id: 'series:save', sourceType: 'recurring_series', name: 'To savings', amount: -500, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'acc-1', transfer: { counterpartAccountId: 'acc-2' } }),
    ]);
    expect(scopePostings(f, 'acc-2').map(p => ({ amount: p.amount, incoming: p.incoming })))
      .toEqual([{ amount: 500, incoming: true }, { amount: 500, incoming: true }, { amount: 500, incoming: true }]);
    expect(scopePostings(f, 'all')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23. Overlapping known / learned expenses
// ─────────────────────────────────────────────────────────────────────────────
const ENT_DATES = Array.from({ length: 8 }, (_, i) => addDays('2026-05-24', i * 12));

describe('S23 · overlapping known and learned expenses', () => {
  // 8 entertainment txns totalling $600 across an 84-day span → $217.41/mo.
  const entHistory = ENT_DATES.map(date => htxn({
    date, amount: -75, category: 'Entertainment', merchantKey: 'various',
  }));

  it('subtracts a known subscription from the learned category rate', () => {
    const known = [ri({ id: 'sub:netflix', sourceType: 'subscription', name: 'Netflix', amount: -20, frequency: 'monthly', anchorDate: '2026-09-01', category: 'Entertainment' })];
    const r = learnFromHistory({ asOf: ASOF, history: entHistory, knownInputs: known });
    const cat = r.categories[0];
    expect(cat.monthlyObserved).toBe(217.41);
    expect(cat.monthlyKnown).toBe(20);
    expect(cat.monthlyResidual).toBe(197.41);
    expect(r.learnedInputs.find(i => i.sourceType === 'learned_spend')!.amount).toBe(-45.4);
  });

  it('projects nothing extra when a bill already covers the whole category', () => {
    const known = [ri({ id: 'bill:ent', name: 'Entertainment package', amount: -250, frequency: 'monthly', anchorDate: '2026-09-01', category: 'Entertainment' })];
    const r = learnFromHistory({ asOf: ASOF, history: entHistory, knownInputs: known });
    expect(r.categories[0].monthlyResidual).toBe(0);
    expect(r.learnedInputs.filter(i => i.sourceType === 'learned_spend')).toHaveLength(0);
  });

  it('converts non-monthly obligations to a monthly rate before subtracting', () => {
    expect(monthlyEquivalent(-1200, 'annually')).toBe(100);
    expect(monthlyEquivalent(-450, 'quarterly')).toBe(150);
    expect(monthlyEquivalent(-100, 'fortnightly')).toBeCloseTo(217.41, 2);
    expect(monthlyEquivalent(-5000, 'once')).toBe(0);
  });

  it('a bill that MIRRORS a subscription is not subtracted twice', () => {
    // The engine will de-dup this bill away, so counting both would over-subtract
    // $20/mo and silently under-forecast discretionary spend.
    const known = [
      ri({ id: 'sub:netflix', sourceType: 'subscription', name: 'Netflix', amount: -20, frequency: 'monthly', anchorDate: '2026-09-01', category: 'Entertainment' }),
      ri({ id: 'bill:netflix', name: 'Netflix', amount: -20, frequency: 'monthly', anchorDate: '2026-09-01', category: 'Entertainment', links: { subscription_id: 'sub:netflix' } }),
    ];
    const r = learnFromHistory({ asOf: ASOF, history: entHistory, knownInputs: known });
    expect(r.categories[0].monthlyKnown).toBe(20);
    expect(r.categories[0].monthlyResidual).toBe(197.41);
  });

  it('committed transactions are excluded so a known series is not counted twice', () => {
    const history = [
      ...entHistory,
      ...ENT_DATES.map(date => htxn({
        date, amount: -60, category: 'Entertainment', merchantKey: 'gym', committed: true,
      })),
    ];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: [] });
    expect(r.categories[0].monthlyObserved).toBe(217.41);
  });

  it('a learned income stream is suppressed by a matching declared income', () => {
    const history = backSeries('2026-08-14', 14, 6).map(date => htxn({
      date, amount: 3000, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    const known = [ri({ id: 'income:acme', sourceType: 'income', name: 'Acme Payroll', amount: 3000, frequency: 'fortnightly', anchorDate: '2026-08-28' })];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: known });
    expect(r.income[0].suppressed).toBe(true);
    expect(r.learnedInputs.filter(i => i.sourceType === 'learned_income')).toHaveLength(0);
  });

  it('a declared income record left stale by a pay rise must not double-count', () => {
    // Declared says $3,000/fortnight; the bank shows $3,300 since the rise.
    // Projecting BOTH would forecast $6,300 a fortnight — a catastrophic
    // over-statement of income. The declared record must still win.
    const history = backSeries('2026-08-14', 14, 6).map(date => htxn({
      date, amount: 3300, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll',
    }));
    const known = [ri({ id: 'income:acme', sourceType: 'income', name: 'Acme Payroll', amount: 3000, frequency: 'fortnightly', anchorDate: '2026-08-28' })];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: known });
    expect(r.income[0].suppressed).toBe(true);
    const f = run([acct('acc-1', 0)], [...known, ...r.learnedInputs]);
    expect(balances(f)).toEqual([6000, 12000, 18000]); // one stream, not two
  });

  it('a genuinely separate inflow from the same payer is still learned', () => {
    // A $500 monthly expense reimbursement from Acme is NOT the fortnightly
    // salary — different cadence and a very different amount.
    const history = backSeries('2026-08-05', 30, 4).map(date => htxn({
      date, amount: 500, isSpend: false, merchantKey: 'acme-reimb', merchantName: 'Acme Expenses',
    }));
    const known = [ri({ id: 'income:acme', sourceType: 'income', name: 'Acme Payroll', amount: 3000, frequency: 'fortnightly', anchorDate: '2026-08-28' })];
    const r = learnFromHistory({ asOf: ASOF, history, knownInputs: known });
    expect(r.income[0].suppressed).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 24. Whole-pipeline stress: everything at once
// ─────────────────────────────────────────────────────────────────────────────
describe('S24 · combined pipeline', () => {
  const accounts = [acct('acc-1', 4200, 'Everyday'), acct('acc-2', 15000, 'Savings')];

  const history: HistoryTxn[] = [
    ...backSeries('2026-08-14', 14, 6).map(date => htxn({
      date, amount: 3300, isSpend: false, merchantKey: 'acme', merchantName: 'Acme Payroll', category: 'Salary',
    })),
    ...GROCERY_DATES.map((date, i) => htxn({
      date, amount: i % 2 === 0 ? -80 : -120, category: 'Groceries', merchantKey: 'coles',
    })),
    htxn({ date: '2026-07-15', amount: -2000, category: 'Groceries', merchantKey: 'coles' }), // seasonal spike
    ...GROCERY_DATES.map(date => htxn({
      date, amount: -700, category: 'Transfer', isSpend: false, isTransfer: true, merchantKey: 'xfer',
    })),
    htxn({ date: '2026-07-20', amount: 260, category: 'Shopping', isSpend: false, isRefund: true, merchantKey: 'myer' }),
  ];

  const known: RecurringInput[] = [
    ri({ id: 'bill:rent', name: 'Rent', amount: -2200, frequency: 'monthly', anchorDate: '2026-09-01', category: 'Housing' }),
    ri({ id: 'bill:tax', name: 'ATO instalment', amount: -1500, frequency: 'once', anchorDate: '2026-08-05', overdue: true }),
    ri({ id: 'bill:water', name: 'Water', amount: -300, frequency: 'quarterly', anchorDate: '2026-09-10', category: 'Utilities' }),
    ri({ id: 'bill:insurance', name: 'Home insurance', amount: -1400, frequency: 'annually', anchorDate: '2026-10-20', category: 'Insurance' }),
    ri({ id: 'sub:netflix', sourceType: 'subscription', name: 'Netflix', amount: -20, frequency: 'monthly', anchorDate: '2026-09-04', accountId: 'acc-1', category: 'Entertainment', confidence: 0.85 }),
    ri({ id: 'bill:netflix', name: 'Netflix', amount: -20, frequency: 'monthly', anchorDate: '2026-09-04', category: 'Entertainment', links: { subscription_id: 'sub:netflix' } }),
    ri({ id: 'card:amex', sourceType: 'credit_card', name: 'Amex (min payment)', amount: -450, frequency: 'monthly', anchorDate: '2026-09-03', confidence: 0.9 }),
    ri({ id: 'bill:amex', name: 'Amex payment', amount: -450, frequency: 'monthly', anchorDate: '2026-09-05', creditCardPayment: true }),
    ri({ id: 'series:save', sourceType: 'recurring_series', name: 'Savings transfer', amount: -700, frequency: 'fortnightly', anchorDate: '2026-08-21', accountId: 'acc-1', confidence: 0.7, transfer: { counterpartAccountId: 'acc-2' } }),
  ];

  function build() {
    const learned = learnFromHistory({ asOf: ASOF, history, knownInputs: known });
    return { learned, f: run(accounts, [...known, ...learned.learnedInputs]) };
  }

  it('suppresses exactly the two duplicated obligations', () => {
    const { f } = build();
    expect(f.suppressed.map(s => `${s.id}:${s.reason}`).sort()).toEqual([
      'bill:amex:mirrors-card',
      'bill:netflix:mirrors-subscription',
    ]);
  });

  it('projects the hand-computed 30/60/90 balances', () => {
    const { f } = build();
    // Opening 19,200.
    // Learned income 3,300 fortnightly from 08-28 → 2 / 4 / 6
    // Rent −2,200 monthly from 09-01        → 1 / 2 / 3
    // ATO −1,500 overdue one-off            → 08-17 (1 / 1 / 1)
    // Water −300 quarterly from 09-10       → 1 / 1 / 1
    // Insurance −1,400 annual from 10-20    → 0 / 0 / 1
    // Netflix −20 monthly from 09-04        → 1 / 2 / 3
    // Amex −450 monthly from 09-03          → 1 / 2 / 3
    // Groceries learned −100/wk from 08-23  → 4 / 8 / 12
    // Transfers excluded from the total.
    //  30: 19200 + 6600 − 2200 − 1500 − 300 − 20 − 450 − 400   = 20930
    //  60: 19200 + 13200 − 4400 − 1500 − 300 − 40 − 900 − 800  = 24460
    //  90: 19200 + 19800 − 6600 − 1500 − 300 − 1400 − 60 − 1350 − 1200 = 26590
    expect(balances(f)).toEqual([20930, 24460, 26590]);
  });

  it('keeps the account roll-up reconciled with the headline', () => {
    expectAccountsReconcile(build().f);
  });

  it('keeps the chart trough and the engine trough in agreement', () => {
    const { f } = build();
    const chart = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 90);
    expect(f.horizons[2].lowestBalance).toBe(chart.lowest);
    expect(f.horizons[2].lowestDate).toBe(chart.lowestDate);
    expect(chart.closing).toBe(f.horizons[2].projectedBalance);
  });

  it('carries a confidence on every projected event', () => {
    const { f } = build();
    const byType = new Map(f.events.map(e => [e.sourceType, e.confidence]));
    expect(byType.get('bill')).toBe(1);
    expect(byType.get('subscription')).toBe(0.85);
    expect(byType.get('credit_card')).toBe(0.9);
    expect(byType.get('recurring_series')).toBe(0.7);
    expect(byType.get('learned_income')).toBe(0.85);
    expect(byType.get('learned_spend')).toBe(0.5);
    expect(f.events.every(e => e.confidence > 0 && e.confidence <= 1)).toBe(true);
  });

  it('KNOWN GAP: the projected balance is not confidence-weighted', () => {
    // A 0.5-confidence learned spend moves the headline exactly as hard as a
    // 1.0-confidence rent bill. Confidence is reported per event but never
    // narrows the projection into a band.
    const { f } = build();
    const weighted = round2(f.openingTotal + f.events
      .filter(e => !e.isTransfer && e.date <= H30)
      .reduce((s, e) => s + e.amount * e.confidence, 0));
    expect(weighted).not.toBe(f.horizons[0].projectedBalance);
    expect(weighted).toBeLessThan(f.horizons[0].projectedBalance); // discounting the big inflow dominates
  });

  it('is deterministic — same inputs, identical output', () => {
    expect(JSON.stringify(build().f)).toBe(JSON.stringify(build().f));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 25. Graphs: the Forecast chart and stat tiles must equal the engine
// ─────────────────────────────────────────────────────────────────────────────
// The page draws its line and its 30/60/90 tiles from buildSeries(scopePostings())
// rather than from the engine's own horizon/account figures. If the two ever
// disagree, the graph lies about numbers the engine already computed correctly.
describe('S25 · chart data matches the engine for every scope', () => {
  const accounts = [acct('acc-1', 5000, 'Everyday'), acct('acc-2', 9000, 'Savings')];
  const inputs = [
    ri({ id: 'income:salary', sourceType: 'income', name: 'Payroll', amount: 3000, frequency: 'fortnightly', anchorDate: '2026-08-21' }),
    ri({ id: 'bill:rent', name: 'Rent', amount: -2000, frequency: 'monthly', anchorDate: '2026-09-01' }),
    ri({ id: 'bill:tax', name: 'ATO', amount: -900, frequency: 'once', anchorDate: '2026-08-02', overdue: true }),
    ri({ id: 'sub:netflix', sourceType: 'subscription', name: 'Netflix', amount: -20, anchorDate: '2026-09-04', accountId: 'acc-1', confidence: 0.85 }),
    ri({ id: 'sub:ghost', sourceType: 'subscription', name: 'Ghost', amount: -30, anchorDate: '2026-09-06', accountId: 'acc-deleted' }),
    ri({ id: 'series:save', sourceType: 'recurring_series', name: 'To savings', amount: -600, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'acc-1', transfer: { counterpartAccountId: 'acc-2' } }),
    ri({ id: 'series:out', sourceType: 'recurring_series', name: 'Transfer out', amount: -250, frequency: 'monthly', anchorDate: '2026-08-25', accountId: 'acc-1', transfer: { counterpartAccountId: null } }),
  ];
  const f = run(accounts, inputs);

  it('the "All accounts" line closes on the engine total at 30 / 60 / 90', () => {
    const postings = scopePostings(f, 'all');
    const opening = openingFor(f, 'all');
    for (const [i, days] of [30, 60, 90].entries()) {
      expect(buildSeries(opening, postings, ASOF, days).closing).toBe(f.horizons[i].projectedBalance);
    }
  });

  it('each account line closes on that account\'s engine projection', () => {
    for (const a of f.accounts) {
      const s30 = buildSeries(openingFor(f, a.accountId), scopePostings(f, a.accountId), ASOF, 30);
      const s60 = buildSeries(openingFor(f, a.accountId), scopePostings(f, a.accountId), ASOF, 60);
      const s90 = buildSeries(openingFor(f, a.accountId), scopePostings(f, a.accountId), ASOF, 90);
      expect([s30.closing, s60.closing, s90.closing]).toEqual([a.d30, a.d60, a.d90]);
    }
  });

  it('the Unallocated filter shows the obligations the engine put there', () => {
    // Bills, income, loans and card payments all carry accountId = null, and an
    // event on a deleted account routes here too. Matching on the literal id
    // showed an empty $0 chart for a bucket the engine had loaded up.
    const postings = scopePostings(f, '__unallocated__');
    expect(postings.length).toBeGreaterThan(0);
    expect([...new Set(postings.map(p => p.event.sourceId))].sort())
      .toEqual(['bill:rent', 'bill:tax', 'income:salary', 'series:out', 'sub:ghost']);
  });

  it('the chart trough matches the engine trough at every horizon', () => {
    const postings = scopePostings(f, 'all');
    const opening = openingFor(f, 'all');
    for (const [i, days] of [30, 60, 90].entries()) {
      const s = buildSeries(opening, postings, ASOF, days);
      expect(s.lowest).toBe(f.horizons[i].lowestBalance);
      expect(s.lowestDate).toBe(f.horizons[i].lowestDate);
    }
  });

  it('every account line plus the unallocated line reconstructs the total line', () => {
    const perAccount = f.accounts.map(a =>
      buildSeries(openingFor(f, a.accountId), scopePostings(f, a.accountId), ASOF, 90).series);
    const total = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 90).series;
    for (let i = 0; i < total.length; i++) {
      expect(round2(perAccount.reduce((s, p) => s + p[i].balance, 0))).toBe(total[i].balance);
    }
  });

  it('draws one point per day, starting at the actual opening balance', () => {
    const s = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 30);
    expect(s.series).toHaveLength(31);
    expect(s.series[0]).toEqual({ date: ASOF, balance: f.openingTotal });
    expect(s.series[30].date).toBe(H30);
    expect(s.series.every(p => Number.isFinite(p.balance))).toBe(true);
  });

  it('never emits a transfer into the household line (no phantom movement)', () => {
    expect(scopePostings(f, 'all').every(p => !p.event.isTransfer)).toBe(true);
    expect(windowPostingsCount(f, 'all')).toBe(scopePostings(f, 'all').filter(p => p.date <= H90).length);
  });
});

function windowPostingsCount(f: CashFlowForecast, scope: string): number {
  return scopePostings(f, scope).filter(p => p.date > ASOF && p.date <= H90).length;
}
