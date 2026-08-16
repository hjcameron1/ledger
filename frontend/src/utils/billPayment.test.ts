import { describe, it, expect } from 'vitest';
import type { Bill, Transaction } from '../types';
import { buildBillPayment, canRecordBillPayment, type BillPaymentAccount } from './billPayment';
import { classifyManualAgainstSync } from './reconcile';

const ASOF = '2026-08-16';

// ── Fixture factories ─────────────────────────────────────────────────────────
function bill(partial: Partial<Bill> & { name: string; amount: number }): Bill {
  return {
    id: 'b1',
    due_date: '2026-08-20',
    is_recurring: false,
    colour: 'grey',
    is_paid: false,
    calendar_synced: false,
    kind: 'bill',
    ...partial,
  };
}

const bankAcc: BillPaymentAccount = { id: 'acc-bank', kind: 'bank', currency: 'AUD', is_manual: false };
const manualBank: BillPaymentAccount = { id: 'acc-manual', kind: 'bank', currency: 'AUD', is_manual: true };
const card: BillPaymentAccount = { id: 'card-1', kind: 'credit_card', currency: 'AUD', is_manual: false };

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1',
    account_id: 'acc-bank',
    account_type: 'bank',
    date: ASOF,
    merchant: 'Merchant',
    currency: 'AUD',
    category: 'Bills',
    is_duplicate_flagged: false,
    is_subscription: false,
    source: 'manual',
    ...partial,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  canRecordBillPayment — which bills produce a transaction
// ═══════════════════════════════════════════════════════════════════════════════
describe('canRecordBillPayment', () => {
  it('true for an assigned payable bill', () => {
    expect(canRecordBillPayment(bill({ name: 'Power', amount: 120, account_id: 'acc-bank', account_type: 'bank' }))).toBe(true);
  });
  it('false when no account is assigned', () => {
    expect(canRecordBillPayment(bill({ name: 'Power', amount: 120 }))).toBe(false);
  });
  it('false for a reminder even if assigned', () => {
    expect(canRecordBillPayment(bill({ name: 'Rent review', amount: 0, kind: 'reminder', account_id: 'acc-bank', account_type: 'bank' }))).toBe(false);
  });
  it('false for a zero-amount bill', () => {
    expect(canRecordBillPayment(bill({ name: 'x', amount: 0, account_id: 'acc-bank', account_type: 'bank' }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buildBillPayment — account assignment (bank)
// ═══════════════════════════════════════════════════════════════════════════════
describe('buildBillPayment — bank account assignment', () => {
  it('records an outflow that lowers the bank balance', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Electricity', amount: 140, category: 'Utilities', account_id: 'acc-bank', account_type: 'bank' }), account: bankAcc, asOf: ASOF })!;
    expect(plan).not.toBeNull();
    expect(plan.ingest.amount).toBe(-140);          // money out
    expect(plan.balanceDelta).toBe(-140);           // bank balance falls
    expect(plan.ingest.account_id).toBe('acc-bank');
    expect(plan.ingest.account_type).toBe('bank');
    expect(plan.ingest.source).toBe('manual');
    expect(plan.ingest.date).toBe(ASOF);
    expect(plan.ingest.merchant).toBe('Electricity');
    expect(plan.ingest.category).toBe('Utilities');
    expect(plan.ingest.category_source).toBe('user');
  });

  it('a live-synced owner enters reconciliation (pending)', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Power', amount: 50, account_id: 'acc-bank', account_type: 'bank' }), account: bankAcc, asOf: ASOF })!;
    expect(plan.ingest.reconcile_state).toBe('pending');
  });

  it('a manual owner records no reconcile_state (like a hand-added entry)', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Power', amount: 50, account_id: 'acc-manual', account_type: 'bank' }), account: manualBank, asOf: ASOF })!;
    expect(plan.ingest.reconcile_state).toBeUndefined();
  });

  it('falls back to the Bills category when the bill is uncategorised', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Power', amount: 50, account_id: 'acc-bank', account_type: 'bank' }), account: bankAcc, asOf: ASOF })!;
    expect(plan.ingest.category).toBe('Bills');
    expect(plan.ingest.category_source).toBe('auto');
  });

  it('returns null for an unassigned bill', () => {
    expect(buildBillPayment({ bill: bill({ name: 'Power', amount: 50 }), account: bankAcc, asOf: ASOF })).toBeNull();
  });

  it('uses the absolute amount even if the bill amount is stored negative', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Power', amount: -50, account_id: 'acc-bank', account_type: 'bank' }), account: bankAcc, asOf: ASOF })!;
    expect(plan.ingest.amount).toBe(-50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buildBillPayment — credit-card bills
// ═══════════════════════════════════════════════════════════════════════════════
describe('buildBillPayment — credit-card bills', () => {
  it('records a charge that raises the card owing (moveOwnerBalance: owing -= delta)', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Netflix', amount: 25, category: 'Subscriptions', account_id: 'card-1', account_type: 'credit_card' }), account: card, asOf: ASOF })!;
    expect(plan.ingest.account_type).toBe('credit_card');
    expect(plan.ingest.amount).toBe(-25);           // a charge is negative
    // moveOwnerBalance does owing -= delta → a negative delta RAISES owing by 25.
    expect(plan.balanceDelta).toBe(-25);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Paid → unpaid reversal is symmetric at the balance level
// ═══════════════════════════════════════════════════════════════════════════════
describe('paid/unpaid reversal', () => {
  it('the reverse delta exactly undoes the pay delta', () => {
    const plan = buildBillPayment({ bill: bill({ name: 'Power', amount: 90, account_id: 'acc-bank', account_type: 'bank' }), account: bankAcc, asOf: ASOF })!;
    // pay() applies +balanceDelta; removeAndReverseBalance applies -amount.
    expect(plan.balanceDelta + -plan.ingest.amount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Statement / Basiq reconciliation — the recorded payment de-dups, never doubles
// ═══════════════════════════════════════════════════════════════════════════════
describe('bill-payment reconciliation against a later import', () => {
  // Build the manual transaction exactly as pay() would ingest it, then check the
  // shared reconcile policy treats a matching import as the authoritative twin.
  const plan = buildBillPayment({ bill: bill({ name: 'Coles Insurance', amount: 200, account_id: 'acc-bank', account_type: 'bank' }), account: bankAcc, asOf: '2026-08-16' })!;
  const manual = tx({ ...plan.ingest, id: 'billpay', reconcile_state: 'pending' });

  it('EXACT: a statement import of the same payment supersedes the manual entry', () => {
    const statement = tx({ amount: -200, merchant: 'Coles Insurance', date: '2026-08-17', source: 'statement' });
    const m = classifyManualAgainstSync(manual, [statement]);
    expect(m.result).toBe('exact');           // → dataService drops the manual dup
    expect(m.candidate?.id).toBe(statement.id);
  });

  it('EXACT: a Basiq import of the same payment supersedes the manual entry', () => {
    const basiq = tx({ amount: -200, merchant: 'Coles Insurance', date: '2026-08-16', source: 'basiq', basiq_tx_id: 'x1' });
    expect(classifyManualAgainstSync(manual, [basiq]).result).toBe('exact');
  });

  it('CONFLICT: a near-but-not-identical import is surfaced, not silently dropped', () => {
    const statement = tx({ amount: -203, merchant: 'Coles Insurance', date: '2026-08-18', source: 'statement' });
    expect(classifyManualAgainstSync(manual, [statement]).result).toBe('conflict');
  });

  it('NONE: an unrelated import leaves the recorded payment standing', () => {
    const statement = tx({ amount: -60, merchant: 'Spotify', date: '2026-08-16', source: 'statement' });
    expect(classifyManualAgainstSync(manual, [statement]).result).toBe('none');
  });
});
