import { describe, it, expect } from 'vitest';
import { isSpendRow, totalSpend, looksLikeCardRepayment, type SpendRow } from './transactionSpend';

describe('backend canonical spend (mirror of frontend transactionCore)', () => {
  it('counts a normal purchase', () => {
    expect(isSpendRow({ amount: -50, category: 'Food' })).toBe(true);
  });

  it('does not count income / inflow', () => {
    expect(isSpendRow({ amount: 5000, category: 'Income' })).toBe(false);
    expect(isSpendRow({ amount: 30, category: 'Shopping' })).toBe(false); // refund
  });

  it('does not count a persisted transfer leg', () => {
    expect(isSpendRow({ amount: -500, is_transfer: true })).toBe(false);
    expect(isSpendRow({ amount: -500, transfer_pair_id: 'p1' })).toBe(false);
    expect(isSpendRow({ amount: -500, category: 'Transfer' })).toBe(false);
  });

  it('does not count a bank credit-card repayment', () => {
    expect(looksLikeCardRepayment('AMEX PAYMENT')).toBe(true);
    expect(isSpendRow({ amount: -300, account_type: 'bank', merchant: 'AMEX PAYMENT' })).toBe(false);
  });

  it('handles string amounts from the DB layer', () => {
    expect(isSpendRow({ amount: '-50' })).toBe(true);
    expect(totalSpend([{ amount: '-50' }, { amount: '-25.5' }])).toBe(75.5);
  });

  // Parity: the SAME representative set the frontend test uses must yield the
  // SAME monthly-expenses total (50 + 80 + 120 = 250).
  it('matches the canonical frontend total for a mixed set', () => {
    const rows: SpendRow[] = [
      { amount: -50, category: 'Food' },
      { amount: -80, category: 'Transport' },
      { amount: 5000, category: 'Income' },
      { amount: 30, category: 'Shopping' },
      { amount: -500, is_transfer: true, category: 'Transfer' },
      { amount: 500, is_transfer: true, category: 'Transfer' },
      { amount: -300, account_type: 'bank', merchant: 'AMEX PAYMENT' },
      { amount: -120, account_type: 'credit_card', category: 'Food' },
    ];
    expect(totalSpend(rows)).toBe(250);
  });

  // ── Phase 2C: refund netting (must match frontend transactionCore.totalSpend) ──
  it('nets a matched refund against its category', () => {
    const rows: SpendRow[] = [
      { amount: -120, category: 'Shopping' },
      { amount: 40, category: 'Shopping', transaction_type: 'refund' },
    ];
    expect(totalSpend(rows)).toBe(80);
  });

  it('does not let an unmatched inflow reduce spend', () => {
    const rows: SpendRow[] = [
      { amount: -120, category: 'Shopping' },
      { amount: 40, category: 'Shopping' }, // not transaction_type='refund'
    ];
    expect(totalSpend(rows)).toBe(120);
  });

  it('floors an over-refunded category at zero (never negative, never income)', () => {
    const rows: SpendRow[] = [
      { amount: -30, category: 'Shopping' },
      { amount: 100, category: 'Shopping', transaction_type: 'refund' },
      { amount: -50, category: 'Food' },
    ];
    expect(totalSpend(rows)).toBe(50); // Shopping floored to 0, Food 50
  });
});
