import { describe, it, expect } from 'vitest';
import {
  buildCashFlowForecast,
  type RecurringInput,
  type AccountBalanceInput,
} from './cashFlowForecast';
import {
  addDaysISO, buildSeries, openingFor, scopePostings, windowPostings,
} from './forecastView';

// Fixed "today" so every projected date is deterministic.
const ASOF = '2026-08-13';

function input(p: Partial<RecurringInput> & { id: string; amount: number }): RecurringInput {
  return {
    sourceType: 'bill',
    name: 'Thing',
    frequency: 'monthly',
    anchorDate: '2026-08-20',
    accountId: null,
    confidence: 1,
    ...p,
  };
}

const CHEQUE: AccountBalanceInput = { accountId: 'acc-cheque', name: 'Cheque', balance: 1000 };
const SAVINGS: AccountBalanceInput = { accountId: 'acc-savings', name: 'Savings', balance: 5000 };

function build(accounts: AccountBalanceInput[], inputs: RecurringInput[]) {
  return buildCashFlowForecast({ asOf: ASOF, accounts, inputs, horizons: [30, 60, 90] });
}

describe('addDaysISO', () => {
  it('advances UTC dates and crosses month boundaries', () => {
    expect(addDaysISO('2026-08-13', 30)).toBe('2026-09-12');
    expect(addDaysISO('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysISO('2026-08-13', 0)).toBe('2026-08-13');
  });
});

describe('scopePostings — account filtering', () => {
  it('"all" includes every non-transfer event, ignoring account', () => {
    const f = build([CHEQUE, SAVINGS], [
      input({ id: 'a', amount: -100, frequency: 'once', anchorDate: '2026-08-20', accountId: 'acc-cheque' }),
      input({ id: 'b', amount: -50, frequency: 'once', anchorDate: '2026-08-21', accountId: 'acc-savings' }),
    ]);
    const all = scopePostings(f, 'all');
    expect(all).toHaveLength(2);
    expect(all.reduce((s, p) => s + p.amount, 0)).toBe(-150);
  });

  it('an account scope keeps only that account\'s own events', () => {
    const f = build([CHEQUE, SAVINGS], [
      input({ id: 'a', amount: -100, frequency: 'once', anchorDate: '2026-08-20', accountId: 'acc-cheque' }),
      input({ id: 'b', amount: -50, frequency: 'once', anchorDate: '2026-08-21', accountId: 'acc-savings' }),
    ]);
    const cheque = scopePostings(f, 'acc-cheque');
    expect(cheque).toHaveLength(1);
    expect(cheque[0].event.sourceId).toBe('a');
    expect(cheque[0].amount).toBe(-100);
  });
});

describe('scopePostings — transfers', () => {
  const transferInputs = [
    input({
      id: 't', sourceType: 'recurring_series', name: 'Move to savings', amount: -200,
      frequency: 'once', anchorDate: '2026-08-20', accountId: 'acc-cheque',
      transfer: { counterpartAccountId: 'acc-savings' },
    }),
  ];

  it('excludes transfers from the household total (no net cash change)', () => {
    const f = build([CHEQUE, SAVINGS], transferInputs);
    const all = scopePostings(f, 'all');
    expect(all).toHaveLength(0);
  });

  it('debits the source account and credits the counterpart account', () => {
    const f = build([CHEQUE, SAVINGS], transferInputs);

    const cheque = scopePostings(f, 'acc-cheque');
    expect(cheque).toHaveLength(1);
    expect(cheque[0].amount).toBe(-200);
    expect(cheque[0].incoming).toBeUndefined();

    const savings = scopePostings(f, 'acc-savings');
    expect(savings).toHaveLength(1);
    expect(savings[0].amount).toBe(200); // sign flipped — the receiving leg
    expect(savings[0].incoming).toBe(true);
  });
});

describe('buildSeries — recurring events over the horizon', () => {
  it('steps the balance on each monthly occurrence and reports the horizon window', () => {
    const f = build([CHEQUE], [
      input({ id: 'rent', amount: -300, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'acc-cheque' }),
    ]);
    const postings = scopePostings(f, 'all');
    const opening = openingFor(f, 'all');
    expect(opening).toBe(1000);

    // 30 days → one occurrence (Aug 20). 90 days → three (Aug/Sep/Oct 20).
    const d30 = buildSeries(opening, postings, ASOF, 30);
    const d90 = buildSeries(opening, postings, ASOF, 90);
    expect(d30.series).toHaveLength(31);   // day 0..30 inclusive
    expect(d30.closing).toBe(700);         // 1000 − 300
    expect(d90.closing).toBe(100);         // 1000 − 300×3

    // Day 0 is today's opening balance (actual), before any event lands.
    expect(d30.series[0]).toEqual({ date: ASOF, balance: 1000 });
  });

  it('tracks the lowest projected balance and its date', () => {
    const f = build([CHEQUE], [
      input({ id: 'big', amount: -900, frequency: 'once', anchorDate: '2026-08-25', accountId: 'acc-cheque' }),
      input({ id: 'pay', sourceType: 'income', name: 'Pay', amount: 1500, frequency: 'once', anchorDate: '2026-09-01', accountId: 'acc-cheque' }),
    ]);
    const s = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 60);
    expect(s.lowest).toBe(100);            // 1000 − 900 before payday
    expect(s.lowestDate).toBe('2026-08-25');
    expect(s.closing).toBe(1600);          // after the 1500 inflow
  });

  it('flags a negative dip in the lowest balance', () => {
    const f = build([CHEQUE], [
      input({ id: 'huge', amount: -1500, frequency: 'once', anchorDate: '2026-08-20', accountId: 'acc-cheque' }),
    ]);
    const s = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 30);
    expect(s.lowest).toBe(-500);
    expect(s.lowest < 0).toBe(true);
  });
});

describe('windowPostings — horizon switching', () => {
  it('returns only postings within the selected horizon, sorted by date', () => {
    const f = build([CHEQUE], [
      input({ id: 'now', amount: -10, frequency: 'once', anchorDate: '2026-08-20', accountId: 'acc-cheque' }),
      input({ id: 'later', amount: -20, frequency: 'once', anchorDate: '2026-10-01', accountId: 'acc-cheque' }),
    ]);
    const postings = scopePostings(f, 'all');
    expect(windowPostings(postings, ASOF, 30).map(p => p.event.sourceId)).toEqual(['now']);
    expect(windowPostings(postings, ASOF, 90).map(p => p.event.sourceId)).toEqual(['now', 'later']);
  });
});

describe('empty states', () => {
  it('no inputs → flat line at the opening balance, no movements', () => {
    const f = build([CHEQUE], []);
    const postings = scopePostings(f, 'all');
    expect(postings).toHaveLength(0);
    const s = buildSeries(openingFor(f, 'all'), postings, ASOF, 90);
    expect(s.closing).toBe(1000);
    expect(s.lowest).toBe(1000);
    expect(windowPostings(postings, ASOF, 90)).toHaveLength(0);
  });

  it('no accounts → zero opening and an empty series that never throws', () => {
    const f = build([], [
      input({ id: 'orphan', amount: -100, frequency: 'once', anchorDate: '2026-08-20', accountId: 'acc-gone' }),
    ]);
    expect(openingFor(f, 'all')).toBe(0);
    const s = buildSeries(openingFor(f, 'all'), scopePostings(f, 'all'), ASOF, 30);
    expect(s.closing).toBe(-100); // the unallocated movement still lands in the total
    expect(openingFor(f, 'missing-account')).toBe(0);
  });
});
