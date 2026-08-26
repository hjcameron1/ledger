/**
 * L1/L2 (stress audit) — the shared formatters and the money bound.
 *
 * A reconciliation line reading "−$0.00" undermines the exact claim it exists
 * to make, and a figure past IEEE safe-integer range silently corrupts every
 * total it enters. Both are folded away at the ONE formatter / ONE bound the
 * whole app uses.
 */
import { describe, it, expect } from 'vitest';
import { formatCurrency, formatPercent, boundMoney } from './format';

describe('formatCurrency never renders negative zero', () => {
  it('folds IEEE −0 into plain zero', () => {
    expect(formatCurrency(-0)).toBe(formatCurrency(0));
    expect(formatCurrency(-0)).not.toContain('-');
  });

  it('folds a sub-cent negative that would round to −$0.00', () => {
    expect(formatCurrency(-0.004)).toBe(formatCurrency(0));
    expect(formatCurrency(parseFloat((-0.001).toFixed(2)))).not.toContain('-');
  });

  it('still shows a real negative cent as negative', () => {
    expect(formatCurrency(-0.01)).toContain('0.01');
    expect(formatCurrency(-5)).toMatch(/-|−/);
  });
});

describe('formatPercent never renders "-0.00%"', () => {
  it('folds −0 and sub-precision negatives', () => {
    expect(formatPercent(-0)).toBe('0.00%');
    expect(formatPercent(-0.001)).toBe('0.00%');
  });

  it('keeps a real negative', () => {
    expect(formatPercent(-0.01)).toBe('-0.01%');
  });
});

describe('boundMoney (L2)', () => {
  it('clamps beyond ±MAX_SAFE_INTEGER', () => {
    expect(boundMoney(9_007_199_254_740_993)).toBe(Number.MAX_SAFE_INTEGER);
    expect(boundMoney(-(2 ** 60))).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('turns non-finite input into zero rather than poisoning totals', () => {
    expect(boundMoney(Number.NaN)).toBe(0);
    expect(boundMoney(Number.POSITIVE_INFINITY)).toBe(0);
    expect(boundMoney(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('passes every storable figure through untouched', () => {
    expect(boundMoney(0)).toBe(0);
    expect(boundMoney(-1234.56)).toBe(-1234.56);
    expect(boundMoney(41_000_000)).toBe(41_000_000);
  });
});
