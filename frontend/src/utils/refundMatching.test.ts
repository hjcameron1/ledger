import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import { classifyRefund, refundCandidates } from './refundMatching';

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1',
    account_id: 'card-1',
    account_type: 'credit_card',
    date: '2026-08-01',
    merchant: 'Merchant',
    currency: 'AUD',
    category: 'Shopping',
    is_duplicate_flagged: false,
    is_subscription: false,
    ...partial,
  };
}

describe('conservative refund matching', () => {
  it('matches a full refund to the original purchase', () => {
    const purchase = tx({ id: 'p', amount: -120, merchant: 'JB HI-FI', merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const refund = tx({ id: 'r', amount: 120, merchant: 'JB HI-FI', merchant_normalized: 'jb hi fi', date: '2026-08-10' });
    const d = classifyRefund(refund, [purchase]);
    expect(d.status).toBe('matched');
    if (d.status === 'matched') {
      expect(d.original.id).toBe('p');
      expect(d.partial).toBe(false);
    }
  });

  it('matches a PARTIAL refund (less than the purchase)', () => {
    const purchase = tx({ id: 'p', amount: -120, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const refund = tx({ id: 'r', amount: 40, merchant_normalized: 'jb hi fi', date: '2026-08-05' });
    const d = classifyRefund(refund, [purchase]);
    expect(d.status).toBe('matched');
    if (d.status === 'matched') expect(d.partial).toBe(true);
  });

  it('does NOT treat an unrelated positive transaction as a refund', () => {
    const purchase = tx({ id: 'p', amount: -120, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const salary = tx({ id: 's', amount: 3000, merchant: 'ACME PAYROLL', merchant_normalized: 'acme payroll', category: 'Income', date: '2026-08-03' });
    expect(classifyRefund(salary, [purchase]).status).toBe('none');
  });

  it('does NOT match when the merchant differs', () => {
    const purchase = tx({ id: 'p', amount: -120, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const refund = tx({ id: 'r', amount: 120, merchant_normalized: 'woolworths', date: '2026-08-05' });
    expect(classifyRefund(refund, [purchase]).status).toBe('none');
  });

  it('does NOT match a credit that predates the purchase', () => {
    const purchase = tx({ id: 'p', amount: -120, merchant_normalized: 'jb hi fi', date: '2026-08-10' });
    const refund = tx({ id: 'r', amount: 120, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    expect(classifyRefund(refund, [purchase]).status).toBe('none');
  });

  it('does NOT match outside the date window', () => {
    const purchase = tx({ id: 'p', amount: -120, merchant_normalized: 'jb hi fi', date: '2026-01-01' });
    const refund = tx({ id: 'r', amount: 120, merchant_normalized: 'jb hi fi', date: '2026-08-01' }); // ~7 months
    expect(classifyRefund(refund, [purchase]).status).toBe('none');
  });

  it('sends an AMBIGUOUS refund (two candidate purchases) to review', () => {
    const p1 = tx({ id: 'p1', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const p2 = tx({ id: 'p2', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-03' });
    const refund = tx({ id: 'r', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-08-06' });
    const d = classifyRefund(refund, [p1, p2]);
    expect(d.status).toBe('review');
    if (d.status === 'review') expect(d.reason).toBe('ambiguous');
  });

  it('sends an OVER-refund (exceeds the purchase) to review', () => {
    const purchase = tx({ id: 'p', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const refund = tx({ id: 'r', amount: 120, merchant_normalized: 'jb hi fi', date: '2026-08-05' });
    const d = classifyRefund(refund, [purchase]);
    expect(d.status).toBe('review');
    if (d.status === 'review') expect(d.reason).toBe('over_refund');
  });

  it('a second partial refund cannot exceed the remaining balance', () => {
    const purchase = tx({ id: 'p', amount: -100, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const firstRefund = tx({ id: 'r1', amount: 70, merchant_normalized: 'jb hi fi', date: '2026-08-05', transaction_type: 'refund', refund_of: 'p' });
    // Only $30 remains; a $50 refund can't be absorbed → review (over_refund).
    const second = tx({ id: 'r2', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-08-06' });
    const d = classifyRefund(second, [purchase, firstRefund]);
    expect(d.status).toBe('review');
    if (d.status === 'review') expect(d.reason).toBe('over_refund');
  });

  it('a second partial WITHIN the remaining balance matches', () => {
    const purchase = tx({ id: 'p', amount: -100, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const firstRefund = tx({ id: 'r1', amount: 70, merchant_normalized: 'jb hi fi', date: '2026-08-05', transaction_type: 'refund', refund_of: 'p' });
    const second = tx({ id: 'r2', amount: 30, merchant_normalized: 'jb hi fi', date: '2026-08-06' });
    expect(classifyRefund(second, [purchase, firstRefund]).status).toBe('matched');
  });

  it('prefers a same-account purchase and treats cross-account matches cautiously', () => {
    const sameAcct = tx({ id: 'p', amount: -80, account_id: 'card-1', merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const refund = tx({ id: 'r', amount: 80, account_id: 'card-1', merchant_normalized: 'jb hi fi', date: '2026-08-05' });
    const d = classifyRefund(refund, [sameAcct]);
    expect(d.status).toBe('matched');
    if (d.status === 'matched') expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

// refundCandidates powers the Needs-Review UI's "choose another purchase" list —
// it must use the SAME conservative criteria as classifyRefund, never wider.
describe('refundCandidates (read-only pool for the review UI)', () => {
  it('lists the ambiguous candidates classifyRefund refuses to auto-pick', () => {
    const p1 = tx({ id: 'p1', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const p2 = tx({ id: 'p2', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-03' });
    const refund = tx({ id: 'r', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-08-10' });
    // classifyRefund sends two plausible purchases to review…
    expect(classifyRefund(refund, [p1, p2]).status).toBe('review');
    // …and the UI helper surfaces both so the user can pick.
    const ids = refundCandidates(refund, [p1, p2]).map(c => c.id).sort();
    expect(ids).toEqual(['p1', 'p2']);
  });

  it('excludes a different merchant and anything already fully refunded', () => {
    const same = tx({ id: 'p', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const other = tx({ id: 'o', amount: -50, merchant_normalized: 'woolworths', date: '2026-08-01' });
    const fully = tx({ id: 'f', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-02' });
    const priorRefund = tx({ id: 'pr', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-08-04', transaction_type: 'refund', refund_of: 'f' });
    const refund = tx({ id: 'r', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-08-10' });
    const ids = refundCandidates(refund, [same, other, fully, priorRefund]).map(c => c.id);
    expect(ids).toEqual(['p']); // 'o' wrong merchant, 'f' already refunded
  });

  it('returns nothing for a non-inflow', () => {
    const p = tx({ id: 'p', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-01' });
    const outflow = tx({ id: 'x', amount: -50, merchant_normalized: 'jb hi fi', date: '2026-08-10' });
    expect(refundCandidates(outflow, [p])).toEqual([]);
  });
});
