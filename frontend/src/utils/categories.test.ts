/**
 * The pickable-category rule — the single list every category picker reads.
 *
 * `useAllCategories` is a hook, so the rule itself lives in the pure
 * `pickableCategories`; this is where its behaviour is pinned down.
 */

import { describe, it, expect } from 'vitest';
import { pickableCategories, mergeCategories, BASE_TX_CATEGORIES } from './categories';
import { categoryKey } from './categoryResolve';

const universe = (extra: string[] = []) => mergeCategories(extra);
const has = (list: string[], name: string) => list.some(c => categoryKey(c) === categoryKey(name));

describe('with a saved Settings allowlist', () => {
  it('shows only the chosen categories', () => {
    const out = pickableCategories({
      universe: universe(), committed: [], custom: [],
      selected: ['Food', 'Transport'], hidden: [],
    });
    expect(out).toEqual(['Food', 'Transport']);
  });

  it('ALWAYS shows a budgeted category, chosen or not', () => {
    const out = pickableCategories({
      universe: universe(), committed: ['Groceries'], custom: [],
      selected: ['Food'], hidden: [],
    });
    expect(has(out, 'Groceries')).toBe(true);
    expect(has(out, 'Food')).toBe(true);
  });

  it('matches the allowlist across spelling, so a stale entry still counts', () => {
    // A selection saved before normalisation may hold "groceries".
    const out = pickableCategories({
      universe: universe(), committed: [], custom: [],
      selected: ['groceries'], hidden: [],
    });
    expect(out).toEqual(['Groceries']);
  });

  it('respects an EMPTY allowlist — except for budgets', () => {
    expect(pickableCategories({
      universe: universe(), committed: [], custom: [], selected: [], hidden: [],
    })).toEqual([]);

    expect(pickableCategories({
      universe: universe(), committed: ['Groceries'], custom: [], selected: [], hidden: [],
    })).toEqual(['Groceries']);
  });

  it('offers a budget-only category that is in no other list', () => {
    const out = pickableCategories({
      universe: universe(['Pet supplies']), committed: ['Pet supplies'], custom: [],
      selected: ['Food'], hidden: [],
    });
    expect(has(out, 'Pet supplies')).toBe(true);
  });
});

describe('before any allowlist is saved (legacy default)', () => {
  it('shows everything', () => {
    const out = pickableCategories({
      universe: universe(), committed: [], custom: [], selected: null, hidden: [],
    });
    expect(out).toEqual(BASE_TX_CATEGORIES);
  });

  it('honours the legacy per-category blocklist', () => {
    const out = pickableCategories({
      universe: universe(), committed: [], custom: [], selected: null, hidden: ['Dividends'],
    });
    expect(has(out, 'Dividends')).toBe(false);
  });

  it('never hides a category the user made or budgeted', () => {
    const out = pickableCategories({
      universe: universe(['Pet supplies']),
      committed: ['Groceries'], custom: ['Pet supplies'],
      selected: null, hidden: ['Groceries', 'Pet supplies'],
    });
    expect(has(out, 'Groceries')).toBe(true);
    expect(has(out, 'Pet supplies')).toBe(true);
  });
});

describe('a retired planner goal is not a commitment', () => {
  it('stays in the menu but does not override the allowlist', () => {
    // `budget_lines` rows come from the Phase 4.1 planner, which no longer runs.
    // They belong in the universe so an existing user's names don't vanish —
    // but only a LIVE budget may force a category past the user's own choice.
    const out = pickableCategories({
      universe: universe(['Transport goal']),   // as useCategoryUniverse would build it
      committed: [],                            // no live budget
      custom: [],
      selected: ['Food'], hidden: [],
    });
    expect(out).toEqual(['Food']);
    expect(has(out, 'Transport goal')).toBe(false);
  });
});

describe('mergeCategories', () => {
  it('appends the user\'s own categories after the built-ins', () => {
    expect(mergeCategories(['Childcare'])).toEqual([...BASE_TX_CATEGORIES, 'Childcare']);
  });

  it('drops a "new" category that is a built-in differently spelled', () => {
    expect(mergeCategories(['groceries', 'GROCERIES!', 'Childcare']))
      .toEqual([...BASE_TX_CATEGORIES, 'Childcare']);
  });

  it('keeps one entry when the user supplies the same name twice', () => {
    const out = mergeCategories(['Pet supplies', 'pet-supplies']);
    expect(out.filter(c => categoryKey(c) === 'petsupplies')).toEqual(['Pet supplies']);
  });
});
