import { describe, it, expect } from 'vitest';
import type { Transaction, RecurringSeries } from '../types';
import type { RecurringPattern } from './recurringDetection';
import {
  seriesKey, patternKey, seriesFromPattern, inferKind,
  isSuggestionSuppressed, occurrenceIdsForSeries,
} from './recurringSeries';

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1', account_id: 'acc', account_type: 'bank',
    date: '2026-08-01', merchant: 'Netflix', currency: 'AUD', category: 'Entertainment',
    is_duplicate_flagged: false, is_subscription: false, ...partial,
  };
}

function pattern(partial: Partial<RecurringPattern> = {}): RecurringPattern {
  const txns = partial.matchingTransactions ?? [
    tx({ amount: -18.99, merchant: 'NETFLIX.COM', merchant_normalized: 'netflix', date: '2026-06-01' }),
    tx({ amount: -18.99, merchant: 'NETFLIX.COM', merchant_normalized: 'netflix', date: '2026-07-01' }),
    tx({ amount: -18.99, merchant: 'NETFLIX.COM', merchant_normalized: 'netflix', date: '2026-08-01' }),
  ];
  return {
    merchant: 'netflix',
    displayMerchant: 'Netflix',
    amount: -18.99,
    frequency: 'monthly',
    transactionIds: txns.map(t => t.id),
    matchingTransactions: txns,
    accountId: 'acc',
    ...partial,
  };
}

function series(partial: Partial<RecurringSeries> & { merchant_normalized: string; frequency: RecurringSeries['frequency']; status: RecurringSeries['status'] }): RecurringSeries {
  return { id: `s${seq++}`, name: partial.merchant_normalized, kind: 'subscription', ...partial } as RecurringSeries;
}

describe('recurring series identity', () => {
  it('a pattern and its series share the same identity key', () => {
    const p = pattern();
    expect(patternKey(p)).toBe(seriesKey('netflix', 'monthly'));
  });
});

describe('seriesFromPattern — persistable fields from a detected pattern', () => {
  it('captures merchant, amount, last date and predicts next', () => {
    const s = seriesFromPattern(pattern());
    expect(s.merchant_normalized).toBe('netflix');
    expect(s.name).toBe('Netflix');
    expect(s.expected_amount).toBe(-18.99);
    expect(s.last_transaction_date).toBe('2026-08-01');
    expect(s.next_expected_date).toBe('2026-09-01'); // reuses calcNextChargeDate
    expect(s.status).toBe('active');
  });

  it('infers income for a positive cluster', () => {
    expect(inferKind({ displayMerchant: 'ACME PAYROLL', amount: 3000 })).toBe('income');
  });

  it('infers a loan repayment from the name', () => {
    expect(inferKind({ displayMerchant: 'HOME LOAN REPAYMENT', amount: -2200 })).toBe('loan_repayment');
  });
});

describe('suggestion suppression — dismissed stays dismissed', () => {
  it('an ACTIVE series suppresses re-suggesting the same pattern', () => {
    const s = [series({ merchant_normalized: 'netflix', frequency: 'monthly', status: 'active' })];
    expect(isSuggestionSuppressed(pattern(), s)).toBe(true);
  });

  it('a DISMISSED series suppresses the suggestion (persists across devices)', () => {
    const s = [series({ merchant_normalized: 'netflix', frequency: 'monthly', status: 'dismissed' })];
    expect(isSuggestionSuppressed(pattern(), s)).toBe(true);
  });

  it('does NOT suppress a different frequency', () => {
    const s = [series({ merchant_normalized: 'netflix', frequency: 'weekly', status: 'dismissed' })];
    expect(isSuggestionSuppressed(pattern(), s)).toBe(false);
  });

  it('an ENDED series does not suppress (it may have restarted)', () => {
    const s = [series({ merchant_normalized: 'netflix', frequency: 'monthly', status: 'ended' })];
    expect(isSuggestionSuppressed(pattern(), s)).toBe(false);
  });
});

describe('occurrence linking', () => {
  it('links the outflow occurrences of a negative series', () => {
    const txns = [
      tx({ id: 'a', amount: -18.99, merchant_normalized: 'netflix' }),
      tx({ id: 'b', amount: -18.99, merchant_normalized: 'netflix' }),
      tx({ id: 'c', amount: -50, merchant_normalized: 'woolworths' }),      // different merchant
      tx({ id: 'd', amount: 18.99, merchant_normalized: 'netflix' }),        // inflow — not this series
    ];
    const ids = occurrenceIdsForSeries({ merchant_normalized: 'netflix', expected_amount: -18.99 }, txns);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('links inflow occurrences of a positive (income) series', () => {
    const txns = [
      tx({ id: 'x', amount: 3000, merchant_normalized: 'acme payroll' }),
      tx({ id: 'y', amount: -20, merchant_normalized: 'acme payroll' }),
    ];
    const ids = occurrenceIdsForSeries({ merchant_normalized: 'acme payroll', expected_amount: 3000 }, txns);
    expect(ids).toEqual(['x']);
  });
});
