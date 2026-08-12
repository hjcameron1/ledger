import { describe, it, expect } from 'vitest';
import { validateSplits, splitsAreValid, splitCategoryAmounts, splitTarget } from './transactionSplits';

// The canonical example from the spec: Costco -$250 split three ways.
const costco = [
  { category: 'Groceries', amount: 140 },
  { category: 'Household', amount: 70 },
  { category: 'Work', amount: 40 },
];

describe('split validation — amounts must sum to the parent', () => {
  it('target is the parent magnitude regardless of sign', () => {
    expect(splitTarget(-250)).toBe(250);
    expect(splitTarget(250)).toBe(250);
  });

  it('accepts splits that sum exactly to |parent|', () => {
    const v = validateSplits(costco, -250);
    expect(v.ok).toBe(true);
    expect(v.total).toBe(250);
    expect(v.target).toBe(250);
    expect(v.remaining).toBe(0);
    expect(splitsAreValid(costco, -250)).toBe(true);
  });

  it('REJECTS splits that under-sum (shortfall reported)', () => {
    const v = validateSplits([{ category: 'Groceries', amount: 140 }, { category: 'Household', amount: 70 }], -250);
    expect(v.ok).toBe(false);
    expect(v.error).toBe('sum_mismatch');
    expect(v.remaining).toBe(40); // $40 still unallocated
  });

  it('REJECTS splits that over-sum', () => {
    const v = validateSplits([...costco, { category: 'Extra', amount: 10 }], -250);
    expect(v.ok).toBe(false);
    expect(v.error).toBe('sum_mismatch');
    expect(v.remaining).toBe(-10);
  });

  it('tolerates sub-cent float drift', () => {
    const v = validateSplits([{ category: 'A', amount: 33.33 }, { category: 'B', amount: 33.33 }, { category: 'C', amount: 33.34 }], -100);
    expect(v.ok).toBe(true);
  });

  it('rejects an empty split set', () => {
    expect(validateSplits([], -250).error).toBe('no_lines');
  });

  it('rejects an empty category', () => {
    expect(validateSplits([{ category: '', amount: 250 }], -250).error).toBe('empty_category');
  });

  it('rejects a non-positive amount', () => {
    expect(validateSplits([{ category: 'A', amount: 250 }, { category: 'B', amount: 0 }], -250).error).toBe('nonpositive_amount');
  });
});

describe('split distribution — per-category amounts sum to |parent|', () => {
  it('distributes across categories', () => {
    const dist = splitCategoryAmounts(costco);
    expect(dist).toEqual({ Groceries: 140, Household: 70, Work: 40 });
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    expect(sum).toBe(250);
  });

  it('merges duplicate categories in the split lines', () => {
    const dist = splitCategoryAmounts([
      { category: 'Work', amount: 40 },
      { category: 'Work', amount: 10 },
      { category: 'Groceries', amount: 200 },
    ]);
    expect(dist).toEqual({ Work: 50, Groceries: 200 });
  });
});
