import { describe, it, expect } from 'vitest';
import {
  validateSplits, splitsAreValid, splitCategoryAmounts, splitTarget,
  splitDisplay, needsSplitDecision, splitContribution,
} from './transactionSplits';

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

// ═════════════════════════════════════════════════════════════════════════════
//  What a split transaction is FILED AS (the display ↔ reporting contract)
// ═════════════════════════════════════════════════════════════════════════════
//
// The rule these prove: whatever `splitDisplay` puts on screen is a category
// `splitCategoryAmounts` — and therefore `spendByCategory` — actually charged.

describe('splitDisplay — the category shown is one the reports use', () => {
  it('unsplit: the transaction’s own category', () => {
    const d = splitDisplay('Dining', []);
    expect(d).toEqual({ label: 'Dining', isSplit: false, categories: ['Dining'], extra: 0 });
  });

  it('unsplit with no category: Uncategorised, never blank', () => {
    expect(splitDisplay(null, []).label).toBe('Uncategorised');
    expect(splitDisplay('   ', []).label).toBe('Uncategorised');
  });

  it('split: headlines the LARGEST slice and counts the rest', () => {
    const d = splitDisplay('Travel', costco);
    expect(d.isSplit).toBe(true);
    expect(d.label).toBe('Groceries');           // $140, the biggest
    expect(d.categories).toEqual(['Groceries', 'Household', 'Work']);
    expect(d.extra).toBe(2);
  });

  it('split IGNORES the parent column entirely — that is the whole point', () => {
    // The bug: main category changed to Travel, split left underneath. Budgets
    // count Groceries/Household/Work; the chip must not say Travel.
    const d = splitDisplay('Travel', costco);
    expect(d.label).not.toBe('Travel');
    expect(d.categories).not.toContain('Travel');
  });

  it('breaks equal slices alphabetically so the headline never flickers', () => {
    const lines = [{ category: 'Zoo', amount: 50 }, { category: 'Aquarium', amount: 50 }];
    expect(splitDisplay('X', lines).label).toBe('Aquarium');
    expect(splitDisplay('X', [...lines].reverse()).label).toBe('Aquarium');
  });

  it('a split wholly in one category still reports as that category', () => {
    const d = splitDisplay('Travel', [{ category: 'Fuel', amount: 100 }]);
    expect(d.label).toBe('Fuel');
    expect(d.extra).toBe(0);
  });

  it('merges duplicate lines before deciding the headline', () => {
    // Two $80 Household lines beat one $140 Groceries line once merged.
    const d = splitDisplay(null, [
      { category: 'Groceries', amount: 140 },
      { category: 'Household', amount: 80 },
      { category: 'Household', amount: 80 },
    ]);
    expect(d.label).toBe('Household');
    expect(d.categories).toEqual(['Household', 'Groceries']);
  });
});

describe('needsSplitDecision — when re-filing has to ask', () => {
  it('no split: never asks', () => {
    expect(needsSplitDecision([], 'Travel')).toBe(false);
  });

  it('split that disagrees with the new category: asks', () => {
    expect(needsSplitDecision(costco, 'Travel')).toBe(true);
  });

  it('asks even when the new category is ALREADY one of the lines', () => {
    // Picking Groceries on a 3-way split still leaves Household and Work
    // underneath — the user has to say what happens to them.
    expect(needsSplitDecision(costco, 'Groceries')).toBe(true);
  });

  it('single-category split re-filed to that same category: nothing to ask', () => {
    const lines = [{ category: 'Fuel', amount: 100 }];
    expect(needsSplitDecision(lines, 'Fuel')).toBe(false);
    expect(needsSplitDecision(lines, 'fuel  ')).toBe(false); // case/space insensitive
    expect(needsSplitDecision(lines, 'Travel')).toBe(true);
  });
});

describe('splitContribution — what a category was actually charged', () => {
  it('returns the slice for a category in the split', () => {
    expect(splitContribution(costco, 'Groceries')).toBe(140);
    expect(splitContribution(costco, 'work')).toBe(40); // case-insensitive
  });

  it('returns 0 for a category the split does not touch', () => {
    expect(splitContribution(costco, 'Travel')).toBe(0);
  });

  it('returns null when there is no split, so callers use the full amount', () => {
    expect(splitContribution([], 'Groceries')).toBeNull();
  });

  it('sums duplicate lines for the same category', () => {
    expect(splitContribution(
      [{ category: 'Work', amount: 40 }, { category: 'Work', amount: 10.005 }],
      'Work',
    )).toBe(50.01);
  });
});
