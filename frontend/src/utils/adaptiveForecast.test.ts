import { describe, it, expect } from 'vitest';
import {
  learnFromHistory,
  detectCadence,
  removeOutliers,
  monthlyEquivalent,
  DEFAULT_ADAPTIVE_CONFIG,
  type HistoryTxn,
} from './adaptiveForecast';
import {
  buildCashFlowForecast,
  addDays,
  round2,
  type RecurringInput,
  type AccountBalanceInput,
} from './cashFlowForecast';

// Fixed "today" so every relative date is deterministic.
const ASOF = '2026-08-13';
const DAYS_PER_MONTH = 30.4375;

/** N days before ASOF, as YYYY-MM-DD. */
const daysAgo = (n: number) => addDays(ASOF, -n);

function htxn(p: Partial<HistoryTxn> & { date: string; amount: number }): HistoryTxn {
  const isOut = p.amount < 0;
  return {
    category: 'Uncategorised',
    accountId: 'acc-cheque',
    merchantKey: 'thing',
    merchantName: 'Thing',
    // Sensible defaults: an outflow is spend, an inflow is income; callers
    // override to model transfers/refunds.
    isSpend: isOut,
    isTransfer: false,
    isRefund: false,
    committed: false,
    ...p,
  };
}

function learn(history: HistoryTxn[], knownInputs: RecurringInput[] = []) {
  return learnFromHistory({ asOf: ASOF, history, knownInputs });
}

// ── Low-level pure helpers ───────────────────────────────────────────────────

describe('monthlyEquivalent', () => {
  it('converts each cadence to a monthly rate; once contributes nothing', () => {
    expect(monthlyEquivalent(-100, 'monthly')).toBe(100);
    expect(monthlyEquivalent(-100, 'weekly')).toBeCloseTo(100 * (DAYS_PER_MONTH / 7), 4);
    expect(monthlyEquivalent(-100, 'fortnightly')).toBeCloseTo(100 * (DAYS_PER_MONTH / 14), 4);
    expect(monthlyEquivalent(-1200, 'annually')).toBe(100);
    expect(monthlyEquivalent(-300, 'quarterly')).toBe(100);
    expect(monthlyEquivalent(-100, 'once')).toBe(0);
  });
});

describe('detectCadence', () => {
  it('recognises regular weekly / fortnightly / monthly spacing', () => {
    expect(detectCadence(['2026-08-01', '2026-08-08', '2026-08-15'])?.frequency).toBe('weekly');
    expect(detectCadence(['2026-07-01', '2026-07-15', '2026-07-29'])?.frequency).toBe('fortnightly');
    expect(detectCadence(['2026-06-10', '2026-07-10', '2026-08-10'])?.frequency).toBe('monthly');
  });

  it('rejects irregular spacing (not a salary)', () => {
    expect(detectCadence(['2026-06-01', '2026-06-20', '2026-08-05'])).toBeNull();
    expect(detectCadence(['2026-08-01'])).toBeNull();
  });
});

describe('removeOutliers', () => {
  it('drops an abnormal one-off spike but keeps the steady cluster', () => {
    const { kept, removed } = removeOutliers([40, 40, 40, 40, 40, 800]);
    expect(removed).toBe(1);
    expect(kept).not.toContain(800);
  });

  it('keeps everything when there are too few points to judge', () => {
    expect(removeOutliers([10, 900]).removed).toBe(0);
  });
});

// ── Recurring income detection ───────────────────────────────────────────────

describe('income detection', () => {
  const salary = (date: string, amount: number): HistoryTxn =>
    htxn({ date, amount, category: 'Income', merchantKey: 'acme payroll', merchantName: 'ACME Payroll' });

  it('detects a regular fortnightly salary and projects the current amount', () => {
    const r = learn([
      salary(daysAgo(42), 2000),
      salary(daysAgo(28), 2000),
      salary(daysAgo(14), 2000),
    ]);
    expect(r.income).toHaveLength(1);
    const inc = r.income[0];
    expect(inc.frequency).toBe('fortnightly');
    expect(inc.amount).toBe(2000);
    expect(inc.suppressed).toBeUndefined();

    const learned = r.learnedInputs.find(i => i.sourceType === 'learned_income');
    expect(learned).toBeDefined();
    expect(learned!.amount).toBe(2000);
    expect(learned!.frequency).toBe('fortnightly');
    // Projected forward, not stuck on the last observed date.
    expect(learned!.anchorDate > ASOF || learned!.anchorDate === ASOF).toBe(true);
  });

  it('tracks CHANGING income — a raise carries forward, a single spike is smoothed', () => {
    const r = learn([
      salary(daysAgo(56), 2000),
      salary(daysAgo(42), 2000),
      salary(daysAgo(28), 2500), // raise
      salary(daysAgo(14), 2500),
    ]);
    // Median of the recent three (2000, 2500, 2500) → the new level, not the old.
    expect(r.income[0].amount).toBe(2500);
  });

  it('SPARSE history: one or two deposits are not a pattern', () => {
    expect(learn([salary(daysAgo(14), 2000)]).income).toHaveLength(0);
    expect(learn([salary(daysAgo(28), 2000), salary(daysAgo(14), 2000)]).income).toHaveLength(0);
  });

  it('does not project a salary stream that has clearly stopped', () => {
    // Regular fortnightly, but the last deposit is ~2 months stale.
    const r = learn([
      salary(daysAgo(84), 2000),
      salary(daysAgo(70), 2000),
      salary(daysAgo(56), 2000),
    ]);
    expect(r.income).toHaveLength(0);
  });

  it('BLEND: a learned stream matching a declared income obligation is suppressed', () => {
    const declared: RecurringInput = {
      id: 'income:1', sourceType: 'income', name: 'ACME Payroll', amount: 2000,
      frequency: 'fortnightly', anchorDate: daysAgo(0), accountId: null, confidence: 1,
    };
    const r = learn([
      salary(daysAgo(42), 2000),
      salary(daysAgo(28), 2000),
      salary(daysAgo(14), 2000),
    ], [declared]);
    expect(r.income[0].suppressed).toBe(true);
    // …and it is NOT emitted as a learned input (no double-counting the pay).
    expect(r.learnedInputs.some(i => i.sourceType === 'learned_income')).toBe(false);
  });
});

// ── Discretionary spend by category ──────────────────────────────────────────

describe('category spend learning', () => {
  const dining = (date: string, amount: number): HistoryTxn =>
    htxn({ date, amount, category: 'Dining', merchantKey: 'cafe', merchantName: 'Cafe' });

  const steadyDining = () => [
    dining(daysAgo(61), -40),
    dining(daysAgo(50), -40),
    dining(daysAgo(40), -40),
    dining(daysAgo(30), -40),
    dining(daysAgo(20), -40),
    dining(daysAgo(10), -40),
  ];

  it('learns a monthly category rate and projects it as a smooth weekly outflow', () => {
    const r = learn(steadyDining());
    const cat = r.categories.find(c => c.category === 'Dining')!;
    // 6×40 over a 61-day span → ~$120/month.
    const expectedMonthly = round2(240 / (61 / DAYS_PER_MONTH));
    expect(cat.monthlyObserved).toBeCloseTo(expectedMonthly, 2);
    expect(cat.monthlyKnown).toBe(0);
    expect(cat.monthlyResidual).toBe(cat.monthlyObserved);

    const spend = r.learnedInputs.find(i => i.sourceType === 'learned_spend')!;
    expect(spend.frequency).toBe('weekly');
    expect(spend.amount).toBe(-round2(cat.monthlyResidual * (7 / DAYS_PER_MONTH)));
    expect(spend.category).toBe('Dining');
  });

  it('excludes abnormal one-off purchases from the average', () => {
    const r = learn([...steadyDining(), dining(daysAgo(15), -900)]);
    const cat = r.categories.find(c => c.category === 'Dining')!;
    expect(cat.removedOutliers).toBe(1);
    // The $900 splurge did not inflate the steady ~$120/month rate.
    expect(cat.monthlyObserved).toBeLessThan(200);
  });

  it('SPARSE history: a category with too few transactions is not projected', () => {
    const r = learn([dining(daysAgo(20), -40), dining(daysAgo(10), -40)]);
    expect(r.categories).toHaveLength(0);
    expect(r.learnedInputs).toHaveLength(0);
  });

  it('does not project a category whose activity spans too short a window', () => {
    // Three txns but all within ~1 week — no reliable monthly rate.
    const r = learn([dining(daysAgo(6), -40), dining(daysAgo(4), -40), dining(daysAgo(2), -40)]);
    expect(r.categories).toHaveLength(0);
  });

  it('BLEND: a known obligation in the category is subtracted (no double-count)', () => {
    const utilBill: RecurringInput = {
      id: 'bill:1', sourceType: 'bill', name: 'Power', amount: -60, frequency: 'monthly',
      anchorDate: daysAgo(0), accountId: null, confidence: 1, category: 'Dining',
    };
    const r = learn(steadyDining(), [utilBill]);
    const cat = r.categories.find(c => c.category === 'Dining')!;
    expect(cat.monthlyKnown).toBe(60);
    expect(cat.monthlyResidual).toBe(round2(Math.max(0, cat.monthlyObserved - 60)));
  });

  it('BLEND: a category fully covered by a known bill yields NO learned spend', () => {
    const bigBill: RecurringInput = {
      id: 'bill:2', sourceType: 'bill', name: 'Cover', amount: -500, frequency: 'monthly',
      anchorDate: daysAgo(0), accountId: null, confidence: 1, category: 'Dining',
    };
    const r = learn(steadyDining(), [bigBill]);
    expect(r.categories.find(c => c.category === 'Dining')!.monthlyResidual).toBe(0);
    expect(r.learnedInputs.some(i => i.sourceType === 'learned_spend')).toBe(false);
  });
});

// ── Transfers, refunds & committed rows are never learned ─────────────────────

describe('exclusions keep the All-Accounts total honest', () => {
  it('internal transfers produce no learned income or spend (net zero)', () => {
    const transfer = (date: string, amount: number): HistoryTxn =>
      htxn({ date, amount, category: 'Transfer', merchantKey: 'move to savings', isSpend: false, isTransfer: true });
    // A stream of regular transfers out AND in — regular enough to look periodic.
    const r = learn([
      transfer(daysAgo(42), -500), transfer(daysAgo(28), -500), transfer(daysAgo(14), -500),
      transfer(daysAgo(42), 500), transfer(daysAgo(28), 500), transfer(daysAgo(14), 500),
    ]);
    expect(r.income).toHaveLength(0);
    expect(r.categories).toHaveLength(0);
    expect(r.learnedInputs).toHaveLength(0);
  });

  it('refund inflows are not mistaken for income', () => {
    const refund = (date: string, amount: number): HistoryTxn =>
      htxn({ date, amount, category: 'Shopping', merchantKey: 'store', isSpend: false, isRefund: true });
    const r = learn([refund(daysAgo(42), 200), refund(daysAgo(28), 200), refund(daysAgo(14), 200)]);
    expect(r.income).toHaveLength(0);
  });

  it('transactions already modelled as a known series are excluded from learning', () => {
    const committed = (date: string): HistoryTxn =>
      htxn({ date, amount: -40, category: 'Dining', committed: true });
    const r = learn([
      committed(daysAgo(61)), committed(daysAgo(45)), committed(daysAgo(30)),
      committed(daysAgo(15)), committed(daysAgo(5)),
    ]);
    expect(r.categories).toHaveLength(0);
  });
});

// ── End-to-end through the engine: 30 / 60 / 90 projections ───────────────────

describe('learned inputs flow through the engine across 30/60/90 horizons', () => {
  const ACC: AccountBalanceInput = { accountId: 'acc-cheque', name: 'Cheque', balance: 1000 };

  function forecastWithLearned(history: HistoryTxn[]) {
    const { learnedInputs } = learn(history);
    return buildCashFlowForecast({
      asOf: ASOF, accounts: [ACC], inputs: learnedInputs, horizons: [30, 60, 90],
    });
  }

  it('accrues learned income and spend proportionally to the horizon', () => {
    const salary = (date: string): HistoryTxn =>
      htxn({ date, amount: 3000, category: 'Income', merchantKey: 'acme', merchantName: 'ACME' });
    const dining = (date: string): HistoryTxn =>
      htxn({ date, amount: -40, category: 'Dining', merchantKey: 'cafe' });

    const f = forecastWithLearned([
      salary('2026-06-10'), salary('2026-07-10'), salary('2026-08-10'),
      dining(daysAgo(61)), dining(daysAgo(50)), dining(daysAgo(40)),
      dining(daysAgo(30)), dining(daysAgo(20)), dining(daysAgo(10)),
    ]);

    const [d30, d60, d90] = f.horizons;
    // More weeks of discretionary spend as the horizon widens.
    expect(d90.outflow).toBeLessThan(d30.outflow);
    expect(d60.outflow).toBeLessThan(d30.outflow);
    // More pay runs land by 90 days than by 30.
    expect(d90.inflow).toBeGreaterThan(d30.inflow);
    // Income dominates spend here, so the balance grows over time.
    expect(d90.projectedBalance).toBeGreaterThan(ACC.balance);
  });

  it('empty history is a no-op: the forecast still builds and is flat', () => {
    const f = forecastWithLearned([]);
    expect(f.events).toHaveLength(0);
    expect(f.horizons.every(h => h.projectedBalance === ACC.balance)).toBe(true);
  });
});

// ── Config surface ────────────────────────────────────────────────────────────

describe('DEFAULT_ADAPTIVE_CONFIG', () => {
  it('exposes sane defaults', () => {
    expect(DEFAULT_ADAPTIVE_CONFIG.lookbackDays).toBe(90);
    expect(DEFAULT_ADAPTIVE_CONFIG.minIncomeOccurrences).toBe(3);
  });
});
