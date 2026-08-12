import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import { isNeedsReview, reviewQueue, reviewCount, reviewByReason, reviewReasonLabel } from './reviewQueue';

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

describe('needs-review queue', () => {
  const items = [
    tx({ id: 'a', amount: -10, review_status: 'needs_review', review_reason: 'possible_refund', date: '2026-08-03' }),
    tx({ id: 'b', amount: -20, review_status: 'clear' }),
    tx({ id: 'c', amount: -30, review_status: 'needs_review', review_reason: 'ambiguous_duplicate', date: '2026-08-05' }),
    tx({ id: 'd', amount: -40, review_status: 'reviewed' }),
  ];

  it('flags only needs_review items', () => {
    expect(isNeedsReview(items[0])).toBe(true);
    expect(isNeedsReview(items[1])).toBe(false);
    expect(isNeedsReview(items[3])).toBe(false);
  });

  it('returns the queue newest-first', () => {
    expect(reviewQueue(items).map(t => t.id)).toEqual(['c', 'a']);
    expect(reviewCount(items)).toBe(2);
  });

  it('groups by reason', () => {
    const g = reviewByReason(items);
    expect(Object.keys(g).sort()).toEqual(['ambiguous_duplicate', 'possible_refund']);
    expect(g.possible_refund.map(t => t.id)).toEqual(['a']);
  });

  it('has a human label per reason', () => {
    expect(reviewReasonLabel('possible_refund')).toBe('Possible refund');
    expect(reviewReasonLabel(null)).toBe('Needs review');
  });
});
