import { describe, it, expect } from 'vitest';
import {
  isTransactionReconciled,
  hasOpenCardPrompt,
  shouldPromptCardPayment,
  linkedCardPayments,
} from './cardPaymentReconciliation';
import type { PendingPayment, CcPaymentPrompt } from '../types';

// Minimal factories — only the fields the predicates read.
const pay = (p: Partial<PendingPayment>): PendingPayment => ({
  id: 'p1', user_id: 'u1', credit_card_id: 'card1', amount: 100,
  status: 'reconciled', created_at: '2026-08-13T00:00:00Z', ...p,
} as PendingPayment);

const prompt = (p: Partial<CcPaymentPrompt>): CcPaymentPrompt => ({
  id: 'q1', kind: 'whole-amount', transaction_id: 'tx1', merchant: 'ANZ', amount: 100,
  created_at: '2026-08-13T00:00:00Z', ...p,
} as CcPaymentPrompt);

describe('isTransactionReconciled', () => {
  it('true when a reconciled payment points at the transaction', () => {
    expect(isTransactionReconciled('tx1', [pay({ reconciled_transaction_id: 'tx1' })])).toBe(true);
  });

  it('false when the only payment for this tx is still pending', () => {
    expect(isTransactionReconciled('tx1', [pay({ status: 'pending', reconciled_transaction_id: 'tx1' })])).toBe(false);
  });

  it('false when a reconciled payment points at a different transaction', () => {
    expect(isTransactionReconciled('tx1', [pay({ reconciled_transaction_id: 'tx2' })])).toBe(false);
  });

  it('false on an empty ledger', () => {
    expect(isTransactionReconciled('tx1', [])).toBe(false);
  });

  it('true when at least one of several payments matches', () => {
    const payments = [
      pay({ id: 'a', status: 'pending', reconciled_transaction_id: undefined }),
      pay({ id: 'b', reconciled_transaction_id: 'other' }),
      pay({ id: 'c', reconciled_transaction_id: 'tx1' }),
    ];
    expect(isTransactionReconciled('tx1', payments)).toBe(true);
  });
});

describe('linkedCardPayments', () => {
  it('returns the reconciled payment(s) settling the transaction', () => {
    const payments = [
      pay({ id: 'a', status: 'pending', reconciled_transaction_id: undefined }),
      pay({ id: 'b', reconciled_transaction_id: 'tx1', amount: 200 }),
      pay({ id: 'c', reconciled_transaction_id: 'other' }),
    ];
    const linked = linkedCardPayments('tx1', payments);
    expect(linked.map(p => p.id)).toEqual(['b']);
    expect(linked[0].amount).toBe(200);
  });

  it('returns empty when nothing settles the transaction', () => {
    expect(linkedCardPayments('tx1', [pay({ status: 'pending', reconciled_transaction_id: 'tx1' })])).toEqual([]);
    expect(linkedCardPayments('tx1', [])).toEqual([]);
  });
});

// linkedCardPayments is the ONLY thing the delete flow reverses when a repayment
// is removed. These pin the invariant: deleting a repayment touches the payment
// RELATIONSHIP and nothing else — never another card's payment, never a still-
// pending payment, never anything but the reconciled links for this one tx. Card
// purchases aren't PendingPayments at all, so they can't be in the reversal set.
describe('repayment reversal is surgical (invariant: remove only the payment link)', () => {
  it('reverses only THIS transaction\'s reconciled link, not another card\'s payment', () => {
    const payments = [
      pay({ id: 'thisTx', credit_card_id: 'cardA', reconciled_transaction_id: 'tx1', amount: 500 }),
      pay({ id: 'otherCard', credit_card_id: 'cardB', reconciled_transaction_id: 'tx2', amount: 999 }),
    ];
    const linked = linkedCardPayments('tx1', payments);
    expect(linked.map(p => p.id)).toEqual(['thisTx']);
    expect(linked.map(p => p.credit_card_id)).not.toContain('cardB');
  });

  it('never reverses a still-pending payment even if it names this tx', () => {
    const payments = [pay({ id: 'p', status: 'pending', reconciled_transaction_id: 'tx1' })];
    expect(linkedCardPayments('tx1', payments)).toEqual([]);
  });

  it('reverses every reconciled slice of a split payment for the same tx (sum preserved)', () => {
    const payments = [
      pay({ id: 's1', reconciled_transaction_id: 'tx1', amount: 300, statement_id: 'stmtA' }),
      pay({ id: 's2', reconciled_transaction_id: 'tx1', amount: 200, statement_id: 'stmtB' }),
      pay({ id: 'x', reconciled_transaction_id: 'txOther', amount: 77 }),
    ];
    const linked = linkedCardPayments('tx1', payments);
    expect(linked.map(p => p.id).sort()).toEqual(['s1', 's2']);
    expect(linked.reduce((n, p) => n + p.amount, 0)).toBe(500);
  });
});

describe('hasOpenCardPrompt', () => {
  it('true when a popup for the transaction is open', () => {
    expect(hasOpenCardPrompt('tx1', [prompt({ transaction_id: 'tx1' })])).toBe(true);
  });
  it('false when open popups are for other transactions', () => {
    expect(hasOpenCardPrompt('tx1', [prompt({ transaction_id: 'tx9' })])).toBe(false);
  });
  it('false when there are no popups', () => {
    expect(hasOpenCardPrompt('tx1', [])).toBe(false);
  });
});

describe('shouldPromptCardPayment', () => {
  it('prompts a fresh, unreconciled transaction with no open popup', () => {
    expect(shouldPromptCardPayment('tx1', [], [])).toBe(true);
  });

  it('does NOT prompt once the relationship is reconciled (never ask again)', () => {
    const payments = [pay({ reconciled_transaction_id: 'tx1' })];
    expect(shouldPromptCardPayment('tx1', payments, [])).toBe(false);
  });

  it('does NOT stack a second popup while one is already open', () => {
    expect(shouldPromptCardPayment('tx1', [], [prompt({ transaction_id: 'tx1' })])).toBe(false);
  });

  it('still prompts a genuinely unresolved payment when OTHER records are reconciled', () => {
    const payments = [pay({ reconciled_transaction_id: 'txOther' })];
    const prompts = [prompt({ transaction_id: 'txElse' })];
    expect(shouldPromptCardPayment('tx1', payments, prompts)).toBe(true);
  });
});
