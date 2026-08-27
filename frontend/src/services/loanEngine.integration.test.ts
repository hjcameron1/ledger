/**
 * Phase 4.2 — the mortgage/debt engine, end to end through the store.
 *
 * The engine is unit-tested on its own; these are the things it cannot prove
 * without the real data service wired up:
 *
 *   • a property-linked mortgage is the SAME loan — the projection, the balance
 *     and net worth all read one record, so there is no second mortgage debt to
 *     drift from it;
 *   • an offset and a redraw stay out of net worth: the offset is already cash
 *     in a bank account, and redraw is borrowing capacity, not money;
 *   • recording a repayment, an extra repayment, a redraw or a rate change
 *     queues the right write, so a second device sees the same loan and the same
 *     history (cross-device persistence);
 *   • a partial repayment reduces the debt but does NOT tick the schedule on;
 *   • deleting a loan takes its history with it and leaves the property alone;
 *   • one user never sees another's loans or their movements.
 *
 * Sync is mocked, so "cross-device" here means "the right op, with the right
 * payload, was queued" — which is exactly what the other device replays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Loan, LoanEvent, Property } from '../types';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import { syncWithRetry } from './syncQueue';
import { loansDS, loanEventsDS, loanReportDS, propertiesDS, calculateNetWorth } from './dataService';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const mockedSync = vi.mocked(syncWithRetry);

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: ME, name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 600_000, current_balance: 500_000,
  interest_rate: 6, minimum_repayment: 3_000, repayment_frequency: 'monthly',
  next_due_date: '2026-09-01', include_in_net_worth: true,
  offset_balance: 0, redraw_available: 0, extra_repayment: 0, ...o,
} as Loan);

const property = (o: Partial<Property> = {}): Property => ({
  id: 'p1', user_id: ME, name: 'Bondi apartment',
  address_unit: null, address_street: '34 Beach Rd', address_suburb: 'Bondi',
  address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
  property_type: 'home', held_by: 'personal',
  purchase_price: 800_000, current_value: 1_000_000, ownership_percent: 100,
  loan_id: null, include_in_net_worth: true, ...o,
} as Property);

const loanEvent = (o: Partial<LoanEvent> = {}): LoanEvent => ({
  id: 'e1', user_id: ME, loan_id: 'l1', kind: 'repayment', amount: 0,
  date: '2026-08-01', ...o,
});

function seed(opts: {
  loans?: Loan[]; loanEvents?: LoanEvent[]; properties?: Property[]; accounts?: any[];
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com', currency_preference: 'AUD' } as any,
    loans: opts.loans ?? [],
    loanEvents: opts.loanEvents ?? [],
    properties: opts.properties ?? [],
    accounts: opts.accounts ?? [],
    // Everything else calculateNetWorth reads — empty unless a test needs it.
    creditCards: [], investments: [], superFunds: [], bills: [],
  } as any);
}

const kinds = () => mockedSync.mock.calls.map(c => c[0] as string);
const payloadOf = (kind: string) => mockedSync.mock.calls.find(c => c[0] === kind)?.[1] as any;
const theLoan = () => useStore.getState().loans[0];

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  One loan, one debt — the promise Phase 4.1 made
// ═════════════════════════════════════════════════════════════════════════════
describe('a property-linked mortgage is the same loan', () => {
  it('projects the loan the property points at, not a copy of it', () => {
    seed({ loans: [loan()], properties: [property({ loan_id: 'l1' })] });
    const row = loanReportDS.row('l1')!;

    expect(row.property).toEqual({ id: 'p1', name: 'Bondi apartment' });
    expect(row.balance).toBe(500_000);
    expect(row.payoffDate).not.toBeNull();
  });

  it('moves the property\'s equity when the mortgage is paid down — one number, one place', () => {
    seed({ loans: [loan()], properties: [property({ loan_id: 'l1' })] });
    expect(calculateNetWorth().net_worth).toBe(500_000);   // 1m house − 500k debt

    loansDS.recordExtraRepayment('l1', 100_000);

    expect(theLoan().current_balance).toBe(400_000);
    expect(calculateNetWorth().net_worth).toBe(600_000);
    // The property never stored a mortgage, so nothing had to be updated on it.
    expect(propertiesDS.getAll()[0].loan_id).toBe('l1');
    expect(kinds()).not.toContain('property.update');
  });

  it('counts the debt exactly once across the loan and the property', () => {
    seed({ loans: [loan()], properties: [property({ loan_id: 'l1' })] });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(1_000_000);            // the asset, whole
    expect(nw.net_worth).toBe(500_000);             // 1,000,000 − 500,000, once
    // And the Loans tab agrees with the total: the debt it reports is the debt
    // net worth subtracted, not a second figure of its own.
    expect(loanReportDS.build().totals.netWorthDebt).toBe(500_000);
  });

  it('leaves the property alone when the loan is deleted', () => {
    seed({ loans: [loan()], properties: [property({ loan_id: 'l1' })] });
    loansDS.remove('l1');
    // Phase 4.1's rule: the asset survives, unencumbered.
    expect(propertiesDS.getAll()).toHaveLength(1);
    expect(propertiesDS.getAll()[0].loan_id).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Net worth is untouched by the new figures
// ═════════════════════════════════════════════════════════════════════════════
describe('offset and redraw stay out of net worth', () => {
  it('an offset reduces the interest and not the debt', () => {
    seed({ loans: [loan({ offset_balance: 120_000 })] });
    const row = loanReportDS.row('l1')!;

    expect(row.balance).toBe(500_000);
    expect(row.effectiveBalance).toBe(380_000);
    expect(row.offsetSavingPerYear).toBe(7_200);          // 120,000 × 6%
    // Net worth still subtracts the whole balance — the offset money is already
    // counted as cash in the account it sits in.
    expect(calculateNetWorth().net_worth).toBe(-500_000);
  });

  it('a linked offset account is counted as cash once, and only lowers the interest', () => {
    seed({
      loans: [loan({ offset_balance: 0, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 80_000 }],
    });
    const row = loanReportDS.row('l1')!;

    expect(row.offsetBalance).toBe(80_000);
    expect(row.effectiveBalance).toBe(420_000);
    const nw = calculateNetWorth();
    expect(nw.bank_balance).toBe(80_000);                  // the asset, once
    expect(nw.net_worth).toBe(-420_000);                   // 80,000 − 500,000
  });

  it('redraw is borrowing capacity, never an asset', () => {
    seed({ loans: [loan({ redraw_available: 45_000 })] });
    expect(loanReportDS.row('l1')!.redrawAvailable).toBe(45_000);
    expect(calculateNetWorth().net_worth).toBe(-500_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Repayments
// ═════════════════════════════════════════════════════════════════════════════
describe('recording a repayment', () => {
  it('charges the interest first and advances the schedule', () => {
    seed({ loans: [loan()] });
    loansDS.markPaid('l1');

    // 500,000 × 6% ÷ 12 = 2,500 interest, so only 500 comes off the debt.
    expect(theLoan().current_balance).toBe(499_500);
    expect(theLoan().next_due_date).toBe('2026-10-01');
    expect(kinds()).toContain('loan.update');
    expect(kinds()).toContain('loanEvent.create');
  });

  it('records the movement with the amount actually paid', () => {
    seed({ loans: [loan()] });
    loansDS.markPaid('l1');

    const events = loanEventsDS.forLoan('l1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('repayment');
    expect(events[0].amount).toBe(3_000);
    expect(payloadOf('loanEvent.create').data).toMatchObject({
      loan_id: 'l1', kind: 'repayment', amount: 3_000,
    });
  });

  it('a PARTIAL repayment pays what it can and leaves the period owing', () => {
    seed({ loans: [loan()] });
    loansDS.markPaid('l1', 1_000);

    expect(theLoan().current_balance).toBe(500_000);        // under the interest
    expect(theLoan().next_due_date).toBe('2026-09-01');     // still due
    expect(loanEventsDS.forLoan('l1')[0].amount).toBe(1_000);
  });

  it('a partial repayment that beats the interest still reduces the debt', () => {
    seed({ loans: [loan()] });
    loansDS.markPaid('l1', 2_800);

    expect(theLoan().current_balance).toBe(499_700);        // 300 of principal
    expect(theLoan().next_due_date).toBe('2026-09-01');
  });

  it('an overpayment clears the period and the surplus becomes redrawable', () => {
    seed({ loans: [loan()] });
    loansDS.markPaid('l1', 5_000);

    expect(theLoan().current_balance).toBe(497_500);        // 2,500 of principal
    expect(theLoan().redraw_available).toBe(2_000);         // paid above the schedule
    expect(theLoan().next_due_date).toBe('2026-10-01');
  });

  it('an offset makes more of the same repayment land on the principal', () => {
    seed({ loans: [loan({ offset_balance: 200_000 })] });
    loansDS.markPaid('l1');
    // Interest on 300,000 is 1,500, so 1,500 comes off instead of 500.
    expect(theLoan().current_balance).toBe(498_500);
  });

  it('uses a linked offset account\'s live balance', () => {
    seed({
      loans: [loan({ offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 200_000 }],
    });
    loansDS.markPaid('l1');
    expect(theLoan().current_balance).toBe(498_500);
  });

  it('puts the whole payment on an indexed debt', () => {
    seed({ loans: [loan({ id: 'l1', loan_type: 'hecs', current_balance: 20_000, minimum_repayment: 500 })] });
    loansDS.markPaid('l1');
    expect(theLoan().current_balance).toBe(19_500);
  });

  it('never pays past zero', () => {
    seed({ loans: [loan({ current_balance: 400, interest_rate: 0, minimum_repayment: 3_000 })] });
    loansDS.markPaid('l1');
    expect(theLoan().current_balance).toBe(0);
    expect(loanEventsDS.forLoan('l1')[0].amount).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Extra repayments and redraw
// ═════════════════════════════════════════════════════════════════════════════
describe('extra repayments and redraw', () => {
  it('an extra repayment cuts the debt and builds redraw', () => {
    seed({ loans: [loan()] });
    loansDS.recordExtraRepayment('l1', 25_000, { date: '2026-08-20', note: 'Bonus' });

    expect(theLoan().current_balance).toBe(475_000);
    expect(theLoan().redraw_available).toBe(25_000);
    expect(payloadOf('loanEvent.create').data).toMatchObject({
      kind: 'extra_repayment', amount: 25_000, date: '2026-08-20', note: 'Bonus',
    });
  });

  it('shortens the loan — the projection moves with the balance', () => {
    seed({ loans: [loan({ minimum_repayment: 4_000 })] });
    const before = loanReportDS.row('l1')!.monthsToPayoff!;
    loansDS.recordExtraRepayment('l1', 50_000);
    expect(loanReportDS.row('l1')!.monthsToPayoff!).toBeLessThan(before);
  });

  it('a redraw puts the debt back up and spends the available redraw', () => {
    seed({ loans: [loan({ current_balance: 475_000, redraw_available: 25_000 })] });
    loansDS.recordRedraw('l1', 10_000);

    expect(theLoan().current_balance).toBe(485_000);
    expect(theLoan().redraw_available).toBe(15_000);
    expect(payloadOf('loanEvent.create').data).toMatchObject({ kind: 'redraw', amount: 10_000 });
  });

  it('cannot redraw more than was paid ahead', () => {
    seed({ loans: [loan({ current_balance: 475_000, redraw_available: 25_000 })] });
    loansDS.recordRedraw('l1', 999_999);

    expect(theLoan().current_balance).toBe(500_000);
    expect(theLoan().redraw_available).toBe(0);
    expect(payloadOf('loanEvent.create').data.amount).toBe(25_000);
  });

  it('refuses an over-redraw before it is recorded', () => {
    seed({ loans: [loan({ redraw_available: 1_000 })] });
    expect(loansDS.validateMovement('l1', { kind: 'redraw', amount: 5_000, date: '2026-08-17' }))
      .toEqual(['Only 1000.00 is available to redraw.']);
  });

  it('paying extra then redrawing it all leaves the loan where it started', () => {
    seed({ loans: [loan()] });
    loansDS.recordExtraRepayment('l1', 30_000);
    loansDS.recordRedraw('l1', 30_000);

    expect(theLoan().current_balance).toBe(500_000);
    expect(theLoan().redraw_available).toBe(0);
    expect(loanEventsDS.forLoan('l1')).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Variable rates
// ═════════════════════════════════════════════════════════════════════════════
describe('rate changes', () => {
  it('a change dated today takes effect on the loan', () => {
    seed({ loans: [loan()] });
    loansDS.recordRateChange('l1', 6.85, { date: '2026-08-17' });

    expect(theLoan().interest_rate).toBe(6.85);
    expect(payloadOf('loan.update').data).toMatchObject({ interest_rate: 6.85 });
    expect(payloadOf('loanEvent.create').data).toMatchObject({ kind: 'rate_change', rate: 6.85 });
  });

  it('a FUTURE change is recorded but not charged yet', () => {
    seed({ loans: [loan()] });
    loansDS.recordRateChange('l1', 9, { date: '2099-01-01' });

    expect(theLoan().interest_rate).toBe(6);            // still paying today's rate
    expect(kinds()).not.toContain('loan.update');
    expect(loanEventsDS.forLoan('l1')[0].rate).toBe(9);
  });

  it('the projection charges the future rate from its date', () => {
    seed({ loans: [loan({ minimum_repayment: 4_000 })] });
    const before = loanReportDS.row('l1')!.projection.totalInterest;

    loansDS.recordRateChange('l1', 8, { date: '2028-01-01' });

    const after = loanReportDS.row('l1')!;
    expect(after.rate).toBe(6);
    expect(after.upcomingRateChanges).toEqual([{ from: '2028-01-01', rate: 8 }]);
    expect(after.projection.totalInterest).toBeGreaterThan(before);
  });

  it('a fixed loan reverts in the projection without a movement being recorded', () => {
    seed({
      loans: [loan({
        minimum_repayment: 4_000, rate_type: 'fixed', fixed_until: '2029-01-01', revert_rate: 8.2,
      })],
    });
    const row = loanReportDS.row('l1')!;
    expect(row.rateType).toBe('fixed');
    expect(row.upcomingRateChanges).toEqual([{ from: '2029-01-01', rate: 8.2 }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What-if
// ═════════════════════════════════════════════════════════════════════════════
describe('repayment impact', () => {
  it('prices paying more each period against the live loan', () => {
    seed({ loans: [loan({ minimum_repayment: 4_000 })] });
    const impact = loansDS.impact('l1', { extraPerPeriod: 500 })!;

    expect(impact.comparable).toBe(true);
    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(impact.monthsSaved!).toBeGreaterThan(0);
    expect(impact.periodPayment).toBe(4_500);
  });

  it('agrees with the schedule the loan is already being shown', () => {
    seed({ loans: [loan({ minimum_repayment: 4_000 })] });
    const impact = loansDS.impact('l1', { extraPerPeriod: 0 })!;
    expect(impact.baseline.payoffDate).toBe(loansDS.projection('l1')!.payoffDate);
  });

  it('prices a lump sum without touching the loan', () => {
    seed({ loans: [loan({ minimum_repayment: 4_000 })] });
    const impact = loansDS.impact('l1', { lumpSum: 50_000 })!;

    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(theLoan().current_balance).toBe(500_000);   // a projection, not a payment
    expect(kinds()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Persistence
// ═════════════════════════════════════════════════════════════════════════════
describe('persistence', () => {
  it('queues the engine\'s fields when a loan is created', () => {
    loansDS.add({
      name: 'Investment mortgage', loan_type: 'mortgage',
      original_amount: 400_000, current_balance: 400_000,
      interest_rate: 6.2, minimum_repayment: 2_400, repayment_frequency: 'monthly',
      offset_balance: 15_000, extra_repayment: 100, redraw_available: 0,
      rate_type: 'fixed', fixed_until: '2028-06-01', revert_rate: 7.4,
      term_months: 360,
    } as any);

    expect(payloadOf('loan.create').data).toMatchObject({
      offset_balance: 15_000, extra_repayment: 100,
      rate_type: 'fixed', fixed_until: '2028-06-01', revert_rate: 7.4, term_months: 360,
    });
  });

  it('queues both halves of a movement — the balance AND the history', () => {
    seed({ loans: [loan()] });
    loansDS.recordExtraRepayment('l1', 10_000);

    expect(payloadOf('loan.update').data).toMatchObject({
      current_balance: 490_000, redraw_available: 10_000,
    });
    expect(payloadOf('loanEvent.create').data).toMatchObject({
      loan_id: 'l1', kind: 'extra_repayment', amount: 10_000,
    });
  });

  it('replays a movement recorded offline against the same loan', () => {
    seed({ loans: [loan()] });
    loansDS.recordRedraw('l1', 0);   // nothing available — nothing to take
    const payload = payloadOf('loanEvent.create');
    expect(payload.data.loan_id).toBe('l1');
    expect(payload.recordId).toBeTruthy();
  });

  it('forgetting a movement keeps the balance it changed', () => {
    seed({ loans: [loan()] });
    loansDS.recordExtraRepayment('l1', 10_000);
    const id = loanEventsDS.forLoan('l1')[0].id;

    loanEventsDS.remove(id);

    expect(loanEventsDS.forLoan('l1')).toHaveLength(0);
    expect(theLoan().current_balance).toBe(490_000);   // the money really moved
    expect(kinds()).toContain('loanEvent.delete');
  });

  it('deleting a loan takes its history with it', () => {
    seed({
      loans: [loan(), loan({ id: 'l2', name: 'Car loan' })],
      loanEvents: [
        loanEvent({ id: 'e1', loan_id: 'l1' }),
        loanEvent({ id: 'e2', loan_id: 'l2' }),
      ],
    });
    loansDS.remove('l1');

    expect(loanEventsDS.getAll().map(e => e.id)).toEqual(['e2']);
    // The server cascades loan_events on the loan's delete, so no per-event
    // delete is queued.
    expect(kinds().filter(k => k === 'loanEvent.delete')).toHaveLength(0);
  });

  it('sorts a loan\'s history newest first', () => {
    seed({
      loans: [loan()],
      loanEvents: [
        loanEvent({ id: 'old', date: '2026-01-01' }),
        loanEvent({ id: 'new', date: '2026-06-01' }),
      ],
    });
    expect(loanEventsDS.forLoan('l1').map(e => e.id)).toEqual(['new', 'old']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  User isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('one user never sees another\'s debt', () => {
  it('leaves another user\'s loan out of the report', () => {
    seed({ loans: [loan(), loan({ id: 'l9', user_id: OTHER, current_balance: 999_999 })] });
    const report = loanReportDS.build();
    expect(report.rows.map(r => r.id)).toEqual(['l1']);
    expect(report.totals.balance).toBe(500_000);
  });

  it('leaves another user\'s movements out of the history', () => {
    seed({
      loans: [loan()],
      loanEvents: [loanEvent({ id: 'mine' }), loanEvent({ id: 'theirs', user_id: OTHER })],
    });
    expect(loanEventsDS.forLoan('l1').map(e => e.id)).toEqual(['mine']);
  });

  it('does not offset a loan against another user\'s account', () => {
    seed({
      loans: [loan({ offset_account_id: 'a9' })],
      accounts: [{ id: 'a9', user_id: OTHER, balance: 400_000 }],
    });
    expect(loanReportDS.row('l1')!.offsetBalance).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Overpayment — through the store, where the balance actually gets written
// ═════════════════════════════════════════════════════════════════════════════
describe('a repayment can never write a negative balance', () => {
  // The reported case, with the interest taken out of the way so the arithmetic
  // is the user's: a 10,000 loan with 9,000 left, paid 10,000.
  const nearlyPaid = (o: Partial<Loan> = {}) => loan({
    original_amount: 10_000, current_balance: 9_000, interest_rate: 0,
    minimum_repayment: 500, next_due_date: '2026-09-01', ...o,
  });

  it('flags the excess before anything is recorded', () => {
    seed({ loans: [nearlyPaid()] });
    const check = loansDS.checkMovement('l1', { kind: 'repayment', amount: 10_000, date: '2026-08-17' });

    expect(check.excess).toBe(1_000);
    expect(check.maxApplicable).toBe(9_000);
    expect(check.requiresConfirmation).toBe(true);
    // Nothing has been written or queued by asking.
    expect(theLoan().current_balance).toBe(9_000);
    expect(kinds()).toEqual([]);
  });

  it('applies the payoff figure and no more when it is confirmed', () => {
    seed({ loans: [nearlyPaid()] });
    loansDS.markPaid('l1', 10_000);

    expect(theLoan().current_balance).toBe(0);
    expect(payloadOf('loan.update').data.current_balance).toBe(0);
    // The history records what was APPLIED, not what was typed.
    expect(loanEventsDS.forLoan('l1')[0].amount).toBe(9_000);
    expect(payloadOf('loanEvent.create').data.amount).toBe(9_000);
  });

  it('counts a paid-out loan as zero debt, never as an asset', () => {
    seed({ loans: [nearlyPaid()], properties: [] });
    loansDS.markPaid('l1', 50_000);

    expect(theLoan().current_balance).toBe(0);
    expect(calculateNetWorth().net_worth).toBe(0);
    expect(loanReportDS.build().totals.netWorthDebt).toBe(0);
  });

  it('includes the period interest in the figure it will accept', () => {
    seed({ loans: [nearlyPaid({ interest_rate: 6 })] });
    const check = loansDS.checkMovement('l1', { kind: 'repayment', amount: 10_000, date: '2026-08-17' });

    expect(check.maxApplicable).toBe(9_045);          // 9,000 + one month at 6%
    expect(check.excess).toBe(955);

    loansDS.markPaid('l1', 10_000);
    expect(theLoan().current_balance).toBe(0);
    expect(loanEventsDS.forLoan('l1')[0].amount).toBe(9_045);
  });

  it('measures the payoff against the LINKED offset account, not a stale figure', () => {
    seed({
      loans: [nearlyPaid({ interest_rate: 6, offset_balance: 0, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, name: 'Offset', balance: 9_000 }],
    });
    // The offset covers the balance, so no interest is due and the payoff is
    // the balance exactly.
    expect(loansDS.checkMovement('l1', { kind: 'repayment', amount: 10_000, date: '2026-08-17' }).maxApplicable)
      .toBe(9_000);
  });

  it('caps an extra repayment at the balance and says so', () => {
    seed({ loans: [nearlyPaid()] });
    const check = loansDS.checkMovement('l1', { kind: 'extra_repayment', amount: 10_000, date: '2026-08-17' });
    expect(check.requiresConfirmation).toBe(true);
    expect(check.errors).toEqual([]);

    loansDS.recordExtraRepayment('l1', 10_000);
    expect(theLoan().current_balance).toBe(0);
    expect(theLoan().redraw_available).toBe(9_000);      // only what was owed
    expect(payloadOf('loanEvent.create').data.amount).toBe(9_000);
  });

  it('leaves an ordinary repayment completely alone', () => {
    seed({ loans: [nearlyPaid()] });
    expect(loansDS.checkMovement('l1', { kind: 'repayment', amount: 500, date: '2026-08-17' }).requiresConfirmation)
      .toBe(false);
    loansDS.markPaid('l1', 500);
    expect(theLoan().current_balance).toBe(8_500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Redraw is capacity, not a discount
// ═════════════════════════════════════════════════════════════════════════════
describe('redraw never reduces the interest charged', () => {
  it('an extra repayment cuts the interest once — through the balance', () => {
    seed({ loans: [loan({ current_balance: 500_000, interest_rate: 6, minimum_repayment: 3_500 })] });
    loansDS.recordExtraRepayment('l1', 50_000);

    const row = loanReportDS.row('l1')!;
    expect(row.balance).toBe(450_000);
    expect(row.redrawAvailable).toBe(50_000);
    // Interest is charged on the balance, not on balance − redraw (400,000).
    expect(row.effectiveBalance).toBe(450_000);
    expect(row.interestThisPeriod).toBe(2_250);         // 450,000 × 6% ÷ 12
  });

  it('two loans that differ only in redraw are charged the same', () => {
    seed({
      loans: [
        loan({ id: 'l1', current_balance: 450_000, redraw_available: 50_000 }),
        loan({ id: 'l2', current_balance: 450_000, redraw_available: 0 }),
      ],
    });
    const [a, b] = loanReportDS.build().rows;
    expect(a.interestPerYear).toBe(b.interestPerYear);
    expect(a.payoffDate).toBe(b.payoffDate);
  });

  it('redrawing it back puts the interest back where it was', () => {
    seed({ loans: [loan({ current_balance: 500_000, interest_rate: 6, minimum_repayment: 3_500 })] });
    const before = loanReportDS.row('l1')!.interestThisPeriod;

    loansDS.recordExtraRepayment('l1', 25_000);
    expect(loanReportDS.row('l1')!.interestThisPeriod).toBeLessThan(before);

    loansDS.recordRedraw('l1', 25_000);
    expect(loanReportDS.row('l1')!.interestThisPeriod).toBe(before);
    expect(theLoan().redraw_available).toBe(0);
  });

  it('the offset is the only balance that discounts the interest', () => {
    seed({
      loans: [loan({
        current_balance: 480_000, interest_rate: 6, offset_balance: 20_000, redraw_available: 20_000,
      })],
    });
    const row = loanReportDS.row('l1')!;
    expect(row.effectiveBalance).toBe(460_000);         // offset only
    expect(row.interestThisPeriod).toBe(2_300);
    expect(row.offsetSavingPerYear).toBe(1_200);        // 20,000 × 6%
    // And neither one moves the debt net worth subtracts.
    expect(calculateNetWorth().net_worth).toBe(-480_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  "What if I paid extra?" can't outgrow the loan
// ═════════════════════════════════════════════════════════════════════════════

describe('a scenario extra is bounded by what the loan still needs', () => {
  // 9,000 owing at 6% monthly: 45 interest for the period, so 9,045 pays it out.
  const nearlyPaid = (o: Partial<Loan> = {}) => loan({
    current_balance: 9_000, interest_rate: 6, minimum_repayment: 500, ...o,
  });

  it('reports the ceiling and the excess for an absurd amount', () => {
    seed({ loans: [nearlyPaid()] });
    const s = loansDS.extraScenario('l1', 1_000_000)!;

    expect(s.payoffAmount).toBe(9_045);
    expect(s.maxUsefulExtra).toBe(8_545);
    expect(s.excess).toBe(991_455);
    expect(s.exceedsPayoff).toBe(true);
  });

  it('the capped amount is worth every cent the absurd one is', () => {
    seed({ loans: [nearlyPaid()] });
    const capped = loansDS.impact('l1', { extraPerPeriod: 8_545 })!;
    const absurd = loansDS.impact('l1', { extraPerPeriod: 1_000_000 })!;

    expect(capped.comparable).toBe(true);
    expect(capped.interestSaved).toBe(absurd.interestSaved);
    expect(capped.scenario.payoffDate).toBe(absurd.scenario.payoffDate);
  });

  it('reads the LINKED offset account, so the ceiling moves with the balance', () => {
    seed({
      loans: [nearlyPaid({ offset_balance: 0, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 4_000 }],
    });
    // Interest on (9,000 − 4,000) is 25, so paying out costs 9,025.
    const s = loansDS.extraScenario('l1', 20_000)!;
    expect(s.payoffAmount).toBe(9_025);
    expect(s.maxUsefulExtra).toBe(8_525);
  });

  it('an offset does not become redraw, however large it is', () => {
    seed({
      loans: [nearlyPaid({ offset_balance: 0, offset_account_id: 'a1', redraw_available: 0 })],
      accounts: [{ id: 'a1', user_id: ME, balance: 50_000 }],
    });
    const row = loanReportDS.row('l1')!;
    expect(row.offsetBalance).toBe(50_000);
    expect(row.redrawAvailable).toBe(0);

    // …so there is nothing to redraw, and asking is a hard error rather than a
    // confirmable overshoot.
    const check = loansDS.checkMovement('l1', { kind: 'redraw', amount: 1, date: '2026-08-17' });
    expect(check.maxApplicable).toBe(0);
    expect(check.errors.length).toBe(1);
    expect(check.requiresConfirmation).toBe(false);
  });

  it('a real extra repayment lowers the ceiling, and its redraw does not lift it', () => {
    seed({ loans: [nearlyPaid()] });
    loansDS.recordExtraRepayment('l1', 4_000);

    const row = loanReportDS.row('l1')!;
    expect(row.balance).toBe(5_000);
    expect(row.redrawAvailable).toBe(4_000);

    const s = loansDS.extraScenario('l1', 8_545)!;
    expect(s.payoffAmount).toBe(5_025);                   // the 4,000 of redraw is not in it
    expect(s.maxUsefulExtra).toBe(4_525);
    expect(s.exceedsPayoff).toBe(true);
  });

  it('says the schedule already clears it when no extra could help', () => {
    seed({ loans: [nearlyPaid({ minimum_repayment: 10_000 })] });
    const s = loansDS.extraScenario('l1', 200)!;
    expect(s.alreadyCleared).toBe(true);
    expect(s.maxUsefulExtra).toBe(0);
    expect(s.excess).toBe(200);
  });

  it('is null for a loan that is not there', () => {
    seed({ loans: [] });
    expect(loansDS.extraScenario('nope', 100)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  "What if I added to my offset?" — the same question, asked of the offset
// ═════════════════════════════════════════════════════════════════════════════

describe('a scenario offset is bounded by what is still charged interest', () => {
  const nearlyPaid = (o: Partial<Loan> = {}) => loan({
    current_balance: 9_000, interest_rate: 6, minimum_repayment: 500, ...o,
  });

  it('reads the LINKED account, so the ceiling is what is really offsetting', () => {
    seed({
      loans: [nearlyPaid({ offset_balance: 999_999, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 4_000 }],
    });
    // The stored 999,999 is dead — the account's live 4,000 is the offset, so
    // 5,000 more is all this loan can still use.
    const s = loansDS.offsetScenario('l1', 50_000)!;
    expect(s.currentOffset).toBe(4_000);
    expect(s.maxUsefulExtra).toBe(5_000);
    expect(s.effectiveOffset).toBe(9_000);
    expect(s.excess).toBe(45_000);
    expect(s.exceedsBalance).toBe(true);
  });

  it('moves with the linked account the moment its balance does', () => {
    seed({
      loans: [nearlyPaid({ offset_balance: 0, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 1_000 }],
    });
    expect(loansDS.offsetScenario('l1', 100)!.maxUsefulExtra).toBe(8_000);

    useStore.setState({ accounts: [{ id: 'a1', user_id: ME, balance: 6_000 }] } as any);
    expect(loansDS.offsetScenario('l1', 100)!.maxUsefulExtra).toBe(3_000);
  });

  it('a broken link offsets nothing, so the whole balance is still chargeable', () => {
    seed({ loans: [nearlyPaid({ offset_balance: 4_000, offset_account_id: 'gone' })], accounts: [] });
    const s = loansDS.offsetScenario('l1', 100)!;
    expect(s.currentOffset).toBe(0);
    expect(s.maxUsefulExtra).toBe(9_000);
  });

  it('prices the addition against the live offset and changes nothing', () => {
    seed({
      loans: [loan({ current_balance: 300_000, minimum_repayment: 2_000, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 20_000 }],
    });
    const before = loanReportDS.row('l1')!;
    const s = loansDS.offsetScenario('l1', 30_000)!;
    expect(s.effectiveOffset).toBe(50_000);

    const impact = loansDS.impact('l1', { offsetBalance: s.effectiveOffset })!;
    expect(impact.comparable).toBe(true);
    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(impact.monthsSaved!).toBeGreaterThan(0);
    // A what-if is a question. The loan, the account and the report it feeds
    // are all exactly where they were.
    expect(loanReportDS.row('l1')).toEqual(before);
    expect(useStore.getState().accounts[0].balance).toBe(20_000);
    expect(useStore.getState().loans[0].current_balance).toBe(300_000);
  });

  it('says so when the offset already covers the balance', () => {
    seed({
      loans: [nearlyPaid({ offset_balance: 0, offset_account_id: 'a1' })],
      accounts: [{ id: 'a1', user_id: ME, balance: 12_000 }],
    });
    const s = loansDS.offsetScenario('l1', 5_000)!;
    expect(s.alreadyInterestFree).toBe(true);
    expect(s.maxUsefulExtra).toBe(0);
    expect(s.excess).toBe(5_000);
  });

  it('is null for a loan that is not there', () => {
    seed({ loans: [] });
    expect(loansDS.offsetScenario('nope', 100)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A linked offset is LIVE — the account is the offset, the stored figure is dead
// ═════════════════════════════════════════════════════════════════════════════
//
// However the account moves — Basiq, a statement import, a manual edit, a sync
// replacing the whole list — the loan's interest, projection and payoff have to
// move with it, because the offset only exists while the money really does.
describe('a linked offset account is read live', () => {
  const linked = (o: Partial<Loan> = {}) =>
    loan({ offset_balance: 250_000, offset_account_id: 'a1', ...o });
  const acct = (balance: number, o: Record<string, unknown> = {}) =>
    ({ id: 'a1', user_id: ME, name: 'Everyday offset', balance, ...o });

  /** However the account's balance got there. */
  const setBalance = (balance: number) => {
    const s = useStore.getState();
    useStore.setState({ accounts: s.accounts.map(a => (a.id === 'a1' ? { ...a, balance } : a)) } as any);
  };

  it('ignores the stale typed figure entirely', () => {
    seed({ loans: [linked()], accounts: [acct(60_000)] });
    const row = loanReportDS.row('l1')!;

    expect(row.offsetBalance).toBe(60_000);               // not the 250,000 on the loan
    expect(row.offsetIsLinked).toBe(true);
    expect(row.offsetAccount).toEqual({ id: 'a1', name: 'Everyday offset' });
    expect(row.effectiveBalance).toBe(440_000);
    expect(row.offsetSavingPerYear).toBe(3_600);
    expect(row.offsetSavingPerMonth).toBe(300);
  });

  it('moves the interest and the payoff date when the balance changes', () => {
    seed({ loans: [linked({ minimum_repayment: 3_500 })], accounts: [acct(0)] });
    const before = loanReportDS.row('l1')!;

    setBalance(100_000);                                  // a deposit lands
    const after = loanReportDS.row('l1')!;

    expect(after.offsetBalance).toBe(100_000);
    expect(after.balance).toBe(before.balance);           // the debt itself never moved
    expect(after.interestPerYear).toBeLessThan(before.interestPerYear);
    expect(after.monthsToPayoff!).toBeLessThan(before.monthsToPayoff!);
    expect(after.payoffDate! < before.payoffDate!).toBe(true);

    setBalance(0);                                        // and back out again
    const drained = loanReportDS.row('l1')!;
    expect(drained.offsetBalance).toBe(0);
    expect(drained.interestPerYear).toBe(before.interestPerYear);
    expect(drained.payoffDate).toBe(before.payoffDate);
  });

  it('follows a sync that replaces the account list wholesale', () => {
    seed({ loans: [linked()], accounts: [acct(40_000)] });
    expect(loanReportDS.row('l1')!.offsetBalance).toBe(40_000);

    // What a refresh does: new objects, same ids.
    useStore.setState({ accounts: [acct(41_912.37)] } as any);
    expect(loanReportDS.row('l1')!.offsetBalance).toBe(41_912.37);
  });

  it('prices a repayment and a payoff against the live balance, not the stored one', () => {
    seed({ loans: [linked()], accounts: [acct(200_000)] });
    // Interest on 300,000 is 1,500, so 1,500 of the 3,000 comes off the principal.
    loansDS.markPaid('l1');
    expect(theLoan().current_balance).toBe(498_500);

    setBalance(500_000);                                  // now the offset covers it all
    const check = loansDS.checkMovement('l1', { kind: 'repayment', amount: 999_999, date: '2026-08-18' });
    expect(check.maxApplicable).toBe(498_500);            // balance + zero interest
    expect(loansDS.extraScenario('l1', 999_999)!.payoffAmount).toBe(498_500);
  });

  it('offsets nothing once the link is broken, instead of using the old figure', () => {
    seed({ loans: [linked()], accounts: [acct(60_000)] });
    // The account is deleted; the FK sets nothing on the loan, so the link is
    // left pointing at an id that isn't there.
    useStore.setState({ accounts: [] } as any);

    const row = loanReportDS.row('l1')!;
    expect(row.offsetBalance).toBe(0);
    expect(row.offsetLinkBroken).toBe(true);
    expect(row.offsetAccount).toBeNull();
    expect(row.effectiveBalance).toBe(500_000);
    expect(row.interestPerYear).toBe(30_000);
    expect(loansDS.extraScenario('l1', 1)!.payoffAmount).toBe(502_500);
  });

  it('hands the loan back to a typed figure when it is unlinked', () => {
    seed({ loans: [linked({ offset_balance: 0 })], accounts: [acct(60_000)] });
    expect(loanReportDS.row('l1')!.offsetBalance).toBe(60_000);

    // Unlinking is what the edit form saves: no account, a figure of its own.
    loansDS.update('l1', { offset_account_id: null, offset_balance: 25_000 });

    const row = loanReportDS.row('l1')!;
    expect(row.offsetIsLinked).toBe(false);
    expect(row.offsetAccount).toBeNull();
    expect(row.offsetBalance).toBe(25_000);               // the account is now irrelevant
    expect(row.effectiveBalance).toBe(475_000);
    expect(payloadOf('loan.update')?.data?.offset_account_id ?? null).toBeNull();
  });

  it('never counts the offset cash twice, at any balance', () => {
    seed({ loans: [linked()], accounts: [acct(0)] });
    for (const balance of [0, 60_000, 500_000, 900_000]) {
      setBalance(balance);
      const nw = calculateNetWorth();
      const row = loanReportDS.row('l1')!;
      // The cash is an asset once; the debt is subtracted in full. The offset
      // only ever changes what interest is charged on.
      expect(nw.bank_balance).toBe(balance);
      expect(row.balance).toBe(500_000);
      expect(nw.net_worth).toBe(balance - 500_000);
      expect(row.offsetBalance).toBe(balance);
    }
  });

  it('an overdrawn offset account offsets nothing and never inflates the debt', () => {
    seed({ loans: [linked()], accounts: [acct(-3_200)] });
    const row = loanReportDS.row('l1')!;

    expect(row.offsetBalance).toBe(0);
    expect(row.effectiveBalance).toBe(500_000);
    expect(row.interestPerYear).toBe(30_000);
    expect(row.offsetLinkBroken).toBe(false);             // the account exists, it's just overdrawn
    expect(calculateNetWorth().net_worth).toBe(-503_200); // the overdraft is the account's problem
  });

  it('will not read another user\'s account, even for a repayment', () => {
    seed({ loans: [linked()], accounts: [acct(400_000, { user_id: OTHER })] });
    expect(loanReportDS.row('l1')!.offsetBalance).toBe(0);
    loansDS.markPaid('l1');
    // Full interest of 2,500 charged, so only 500 comes off — not the 3,000 a
    // borrowed offset would have allowed.
    expect(theLoan().current_balance).toBe(499_500);
  });
});
