import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import { spendByCategory, totalSpend } from './transactionCore';

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1', account_id: 'acc', account_type: 'bank',
    date: '2026-08-01', merchant: 'Merchant', currency: 'AUD', category: 'Other',
    is_duplicate_flagged: false, is_subscription: false, ...partial,
  };
}

describe('Phase 2C reporting — refunds reduce net spend', () => {
  it('a matched refund nets against its category', () => {
    const purchase = tx({ amount: -120, category: 'Shopping' });
    const refund = tx({ amount: 40, category: 'Shopping', transaction_type: 'refund', refund_of: purchase.id });
    const byCat = spendByCategory([purchase, refund]);
    expect(byCat.Shopping).toBe(80);          // 120 − 40
    expect(totalSpend([purchase, refund])).toBe(80);
  });

  it('an UNMATCHED positive inflow does NOT reduce spend (conservative)', () => {
    const purchase = tx({ amount: -120, category: 'Shopping' });
    const mystery = tx({ amount: 40, category: 'Shopping' }); // no transaction_type='refund'
    expect(totalSpend([purchase, mystery])).toBe(120);
  });

  it('a refund never counts as income and never makes a category negative', () => {
    const purchase = tx({ amount: -30, category: 'Shopping' });
    const bigRefund = tx({ amount: 100, category: 'Shopping', transaction_type: 'refund' });
    const byCat = spendByCategory([purchase, bigRefund]);
    expect(byCat.Shopping).toBe(0);           // floored, not −70
    expect(totalSpend([purchase, bigRefund])).toBe(0);
  });
});

describe('Phase 2C reporting — splits replace the parent category', () => {
  const costco = tx({ id: 'costco', amount: -250, category: 'Groceries' });
  const splitsByTxId = new Map<string, { category: string; amount: number }[]>([
    ['costco', [
      { category: 'Groceries', amount: 140 },
      { category: 'Household', amount: 70 },
      { category: 'Work', amount: 40 },
    ]],
  ]);

  it('distributes a split across its categories', () => {
    const byCat = spendByCategory([costco], { splitsByTxId });
    expect(byCat).toEqual({ Groceries: 140, Household: 70, Work: 40 });
  });

  it('does NOT double-count: total spend equals the parent magnitude', () => {
    expect(totalSpend([costco], { splitsByTxId })).toBe(250);
    // ...and the parent's own category is not also counted in full.
    const byCat = spendByCategory([costco], { splitsByTxId });
    expect(byCat.Groceries).toBe(140); // the split slice, not the full 250
  });

  it('an unsplit transaction still counts under its own category', () => {
    const plain = tx({ id: 'plain', amount: -60, category: 'Dining' });
    const byCat = spendByCategory([costco, plain], { splitsByTxId });
    expect(byCat.Dining).toBe(60);
    expect(byCat.Groceries).toBe(140);
  });

  it('splits + refunds coexist and totals stay consistent', () => {
    const refund = tx({ id: 'ref', amount: 20, category: 'Household', transaction_type: 'refund' });
    const byCat = spendByCategory([costco, refund], { splitsByTxId });
    expect(byCat.Household).toBe(50);   // 70 − 20
    expect(totalSpend([costco, refund], { splitsByTxId })).toBe(230); // 250 − 20
  });
});

describe('Phase 2C reporting — transfers stay excluded', () => {
  it('a transfer leg is neither spend nor netted by a refund', () => {
    const transfer = tx({ amount: -500, category: 'Transfer', is_transfer: true, transfer_pair_id: 'p1' });
    const purchase = tx({ amount: -100, category: 'Shopping' });
    expect(totalSpend([transfer, purchase])).toBe(100);
  });
});
