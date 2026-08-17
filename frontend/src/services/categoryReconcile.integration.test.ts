/**
 * Categories as ONE system, end to end through the store.
 *
 * The reported bug: a budget existed for Groceries, but Groceries was not
 * offered when categorising or splitting a transaction — so nothing could ever
 * be filed into the budget. Two separate causes, both covered here:
 *
 *   • the Settings allowlist filtered budget categories out of the picker;
 *   • a budget's category name existed nowhere else, as no category row.
 *
 * Every category picker in the app (transaction rows, splits, rules, bills, the
 * budget editor) reads `useAllCategories`, whose rule is the pure
 * `pickableCategories` tested below — so proving the rule proves all of them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, CustomCategory, Transaction } from '../types';

// The store's persist middleware needs localStorage before the module loads.
vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

// The cross-device mirror is a network write; assert the calls, don't make them.
vi.mock('./uiPreferences', () => ({
  patchUiPrefs: vi.fn(),
  loadUiPrefs: vi.fn(async () => ({})),
  resetUiPrefsCache: vi.fn(),
}));

import { useStore } from '../store';
import { syncWithRetry } from './syncQueue';
import { patchUiPrefs } from './uiPreferences';
import { customCategoriesDS, budgetsDS } from './dataService';
import {
  pickableCategories, BASE_TX_CATEGORIES, mergeCategories,
} from '../utils/categories';
import { categoryKey } from '../utils/categoryResolve';

const ME = 'user-ME';
const mockedSync = vi.mocked(syncWithRetry);
const mockedPatch = vi.mocked(patchUiPrefs);

let bseq = 0;
function budget(o: Partial<Budget> = {}): Budget {
  bseq += 1;
  return {
    id: o.id ?? `b${bseq}`,
    user_id: ME,
    scope: 'category',
    category: 'Groceries',
    limit_amount: 500,
    period: 'monthly',
    rollover_enabled: false,
    active: true,
    ...o,
  } as Budget;
}

let cseq = 0;
function cat(name: string, id?: string): CustomCategory {
  cseq += 1;
  return {
    id: id ?? `c${cseq}`, user_id: ME, name,
    created_at: '2026-01-01', updated_at: '2026-01-01',
  } as CustomCategory;
}

function seed(o: {
  budgets?: Budget[]; customCategories?: CustomCategory[];
  selectedCategories?: string[] | null; transactions?: Transaction[];
  categoryAliases?: Record<string, string>;
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com' } as any,
    budgets: o.budgets ?? [],
    customCategories: o.customCategories ?? [],
    selectedCategories: o.selectedCategories ?? null,
    hiddenCategories: [],
    budgetLines: [],
    transactions: o.transactions ?? [],
    transactionSplits: [],
    categoryAliases: o.categoryAliases ?? {},
  } as any);
}

/** What every category picker in the app would show, right now. */
function picker(): string[] {
  const s = useStore.getState();
  const committed = s.budgets
    .filter(b => b.active !== false && b.scope !== 'overall')
    .map(b => (b.category ?? '').trim())
    .filter(Boolean);
  const custom = s.customCategories.map(c => c.name);
  return pickableCategories({
    universe: mergeCategories([...custom, ...committed]),
    committed,
    custom,
    selected: s.selectedCategories,
    hidden: s.hiddenCategories,
  });
}

const has = (list: string[], name: string) => list.some(c => categoryKey(c) === categoryKey(name));

beforeEach(() => {
  mockedSync.mockClear();
  mockedPatch.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  The reported bug
// ═════════════════════════════════════════════════════════════════════════════
describe('a budgeted category is always available to transactions', () => {
  it('offers a budget category the Settings allowlist leaves out', () => {
    // The exact reported state: Groceries is budgeted, but the user's saved
    // category selection does not include it.
    seed({
      budgets: [budget({ category: 'Groceries' })],
      selectedCategories: ['Food', 'Transport'],
    });
    expect(has(picker(), 'Groceries')).toBe(true);
  });

  it('offers a budget-only category that exists in no other list', () => {
    seed({
      budgets: [budget({ category: 'Pet supplies' })],
      selectedCategories: ['Food'],
      customCategories: [],
    });
    expect(has(picker(), 'Pet supplies')).toBe(true);
  });

  it('stops offering it the moment the budget is deleted', () => {
    // The override lasts exactly as long as the commitment behind it.
    seed({
      budgets: [budget({ id: 'b1', category: 'Groceries' })],
      selectedCategories: ['Food'],
    });
    expect(has(picker(), 'Groceries')).toBe(true);
    budgetsDS.remove('b1');
    expect(has(picker(), 'Groceries')).toBe(false);
  });

  it('does not resurrect a category the user switched off and never budgeted', () => {
    seed({ budgets: [budget({ category: 'Groceries' })], selectedCategories: ['Food'] });
    expect(has(picker(), 'Entertainment')).toBe(false);
  });

  it('keeps an inactive budget from forcing its category back into the menu', () => {
    seed({
      budgets: [budget({ category: 'Groceries', active: false })],
      selectedCategories: ['Food'],
    });
    expect(has(picker(), 'Groceries')).toBe(false);
  });

  it('ignores the OVERALL budget, which has no category to offer', () => {
    seed({
      budgets: [budget({ scope: 'overall', category: null, limit_amount: 3000 })],
      selectedCategories: ['Food'],
    });
    expect(picker()).toEqual(['Food']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  No duplicates
// ═════════════════════════════════════════════════════════════════════════════
describe('one category, one record', () => {
  it('will not create a second row for a different spelling', () => {
    customCategoriesDS.add('Pet supplies');
    customCategoriesDS.add('pet supplies');
    customCategoriesDS.add('  PET   SUPPLIES  ');
    customCategoriesDS.add('Pet-supplies');
    expect(useStore.getState().customCategories).toHaveLength(1);
    expect(useStore.getState().customCategories[0].name).toBe('Pet supplies');
  });

  it('syncs the create exactly once', () => {
    customCategoriesDS.add('Pet supplies');
    customCategoriesDS.add('pet supplies');
    const creates = mockedSync.mock.calls.filter(c => c[0] === 'customCategory.create');
    expect(creates).toHaveLength(1);
  });

  it('never adds a row for a built-in, whatever the casing', () => {
    const { name, created } = customCategoriesDS.addResolved('groceries');
    expect(name).toBe('Groceries');
    expect(created).toBe(false);
    expect(useStore.getState().customCategories).toHaveLength(0);
  });

  it('shows one entry when a budget and a category row disagree on spelling', () => {
    seed({
      budgets: [budget({ category: 'groceries' })],
      customCategories: [cat('Groceries')],
    });
    const shown = picker().filter(c => categoryKey(c) === 'groceries');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBe('Groceries');   // the built-in spelling wins
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Migrating existing data
// ═════════════════════════════════════════════════════════════════════════════
describe('reconcile() — existing data', () => {
  it('registers a budget-only category so it becomes a real one', () => {
    seed({ budgets: [budget({ category: 'Pet supplies' })] });
    const result = customCategoriesDS.reconcile();
    expect(result.registered).toBe(1);
    expect(useStore.getState().customCategories.map(c => c.name)).toEqual(['Pet supplies']);
  });

  it('leaves built-in budget categories alone — they need no row', () => {
    seed({ budgets: [budget({ category: 'Groceries' })] });
    customCategoriesDS.reconcile();
    expect(useStore.getState().customCategories).toHaveLength(0);
  });

  it('re-points a budget onto the canonical spelling of a real category', () => {
    seed({ budgets: [budget({ id: 'b1', category: 'groceries' })] });
    const result = customCategoriesDS.reconcile();
    expect(result.repointed).toBe(1);
    expect(budgetsDS.getAll().find(b => b.id === 'b1')?.category).toBe('Groceries');
  });

  it('collapses duplicate category rows, keeping one', () => {
    seed({ customCategories: [cat('Pet supplies', 'c1'), cat('pet supplies', 'c2'), cat('PET SUPPLIES', 'c3')] });
    const result = customCategoriesDS.reconcile();
    expect(result.merged).toBe(2);
    expect(useStore.getState().customCategories.map(c => c.id)).toEqual(['c1']);
  });

  it('does NOT merge a budget category that is merely similar', () => {
    // "Grocuries" might be a typo — or a real category. Reconciliation runs
    // unattended with nobody to ask, so it must never decide.
    seed({ budgets: [budget({ id: 'b1', category: 'Grocuries' })] });
    customCategoriesDS.reconcile();
    expect(budgetsDS.getAll().find(b => b.id === 'b1')?.category).toBe('Grocuries');
    expect(useStore.getState().customCategories.map(c => c.name)).toEqual(['Grocuries']);
  });

  it('is idempotent — a second run changes nothing', () => {
    seed({
      budgets: [budget({ category: 'Pet supplies' }), budget({ id: 'b2', category: 'groceries' })],
      customCategories: [cat('Dining out', 'c1'), cat('dining out', 'c2')],
    });
    customCategoriesDS.reconcile();
    const after = JSON.stringify(useStore.getState().customCategories) + JSON.stringify(budgetsDS.getAll());
    expect(customCategoriesDS.reconcile()).toEqual({ merged: 0, repointed: 0, registered: 0 });
    expect(JSON.stringify(useStore.getState().customCategories) + JSON.stringify(budgetsDS.getAll()))
      .toBe(after);
  });

  it('retires the older of two budgets claiming the same category', () => {
    // Already broken before reconciliation: the engine keeps whichever row was
    // updated last and silently ignores the other. Make the survivor the one the
    // user is currently looking at, rather than leaving it to row order.
    seed({
      budgets: [
        budget({ id: 'old', category: 'groceries', limit_amount: 300, updated_at: '2026-01-01' } as any),
        budget({ id: 'new', category: 'Groceries', limit_amount: 800, updated_at: '2026-08-01' } as any),
      ],
    });
    expect(customCategoriesDS.reconcile().merged).toBe(1);
    const live = budgetsDS.active().filter(b => b.scope !== 'overall');
    expect(live.map(b => b.id)).toEqual(['new']);
    expect(live[0].limit_amount).toBe(800);
  });

  it('converges after the duplicate is retired', () => {
    seed({
      budgets: [
        budget({ id: 'a', category: 'Groceries', updated_at: '2026-08-01' } as any),
        budget({ id: 'b', category: 'groceries', updated_at: '2026-01-01' } as any),
      ],
    });
    customCategoriesDS.reconcile();
    customCategoriesDS.reconcile();
    expect(customCategoriesDS.reconcile()).toEqual({ merged: 0, repointed: 0, registered: 0 });
    expect(budgetsDS.active().filter(b => b.scope !== 'overall').map(b => b.category))
      .toEqual(['Groceries']);
  });

  it('does nothing at all on a clean install', () => {
    seed();
    expect(customCategoriesDS.reconcile()).toEqual({ merged: 0, repointed: 0, registered: 0 });
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('makes a migrated budget category immediately pickable', () => {
    seed({ budgets: [budget({ category: 'Pet supplies' })], selectedCategories: ['Food'] });
    customCategoriesDS.reconcile();
    expect(has(picker(), 'Pet supplies')).toBe(true);
  });

  it('drops remembered decisions about categories that have gone', () => {
    seed({
      budgets: [],
      customCategories: [],
      categoryAliases: { grocuries: 'Groceries', wdgets: 'Widgets' },
    });
    customCategoriesDS.reconcile();
    expect(useStore.getState().categoryAliases).toEqual({ grocuries: 'Groceries' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rename still propagates
// ═════════════════════════════════════════════════════════════════════════════
describe('rename', () => {
  it('moves the category row, its budget and its loaded transactions together', () => {
    seed({
      budgets: [budget({ id: 'b1', category: 'Dining' })],
      customCategories: [cat('Dining', 'c1')],
      transactions: [
        { id: 't1', user_id: ME, category: 'Dining', amount: -40, date: '2026-08-01' } as Transaction,
        { id: 't2', user_id: ME, category: 'dining', amount: -20, date: '2026-08-02' } as Transaction,
        { id: 't3', user_id: ME, category: 'Fuel', amount: -60, date: '2026-08-03' } as Transaction,
      ],
    });

    const moved = customCategoriesDS.rename('Dining', 'Eating out');

    expect(moved).toEqual({ budgets: 1, transactions: 2 });
    expect(budgetsDS.getAll().find(b => b.id === 'b1')?.category).toBe('Eating out');
    const byId = Object.fromEntries(useStore.getState().transactions.map(t => [t.id, t.category]));
    expect(byId).toEqual({ t1: 'Eating out', t2: 'Eating out', t3: 'Fuel' });
    expect(useStore.getState().customCategories.map(c => c.name)).toEqual(['Eating out']);
  });

  it('carries a remembered decision across the rename', () => {
    seed({
      customCategories: [cat('Eating out', 'c1')],
      categoryAliases: { eatngout: 'Eating out' },
    });
    customCategoriesDS.rename('Eating out', 'Dining out');
    expect(useStore.getState().categoryAliases).toEqual({ eatngout: 'Dining out' });
    expect(mockedPatch).toHaveBeenCalledWith({ category_aliases: { eatngout: 'Dining out' } });
  });

  it('is a no-op when the name only differs in spelling', () => {
    seed({ customCategories: [cat('Dining', 'c1')] });
    expect(customCategoriesDS.rename('Dining', ' dining ')).toEqual({ budgets: 0, transactions: 0 });
    expect(useStore.getState().customCategories.map(c => c.name)).toEqual(['Dining']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Remembering a decision, and syncing it
// ═════════════════════════════════════════════════════════════════════════════
describe('remembered decisions persist and sync', () => {
  it('records a confirmed merge and mirrors it for other devices', () => {
    seed();
    customCategoriesDS.rememberAlias('grocuries', 'Groceries');
    expect(useStore.getState().categoryAliases).toEqual({ grocuries: 'Groceries' });
    expect(mockedPatch).toHaveBeenCalledWith({ category_aliases: { grocuries: 'Groceries' } });
  });

  it('applies the remembered answer instead of asking again', () => {
    seed({ categoryAliases: { grocuries: 'Groceries' } });
    const r = customCategoriesDS.resolve('Grocuries');
    expect(r.status).toBe('alias');
    expect(customCategoriesDS.addResolved('Grocuries')).toEqual({ name: 'Groceries', created: false });
    expect(useStore.getState().customCategories).toHaveLength(0);
  });

  it('honours a "no, it is different" decision by keeping the new category', () => {
    seed({ customCategories: [cat('Grocuries')], categoryAliases: { grocuries: 'Grocuries' } });
    expect(customCategoriesDS.resolve('grocuries').status).toBe('alias');
    expect(customCategoriesDS.addResolved('grocuries').name).toBe('Grocuries');
    expect(useStore.getState().customCategories).toHaveLength(1);
  });

  it('does not write when the decision is already recorded', () => {
    seed({ categoryAliases: { grocuries: 'Groceries' } });
    customCategoriesDS.rememberAlias('grocuries', 'Groceries');
    expect(mockedPatch).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Custom categories still work as before
// ═════════════════════════════════════════════════════════════════════════════
describe('custom categories', () => {
  it('a brand-new name is created and offered', () => {
    seed({ selectedCategories: [...BASE_TX_CATEGORIES] });
    const { name, created } = customCategoriesDS.addResolved('Childcare');
    expect({ name, created }).toEqual({ name: 'Childcare', created: true });
    // Not in the saved allowlist yet — Settings adds it to the draft on save —
    // but it exists as a real category from this moment.
    expect(customCategoriesDS.known().some(c => categoryKey(c) === 'childcare')).toBe(true);
  });

  it('survives alongside built-ins in the picker', () => {
    seed({ customCategories: [cat('Childcare')], selectedCategories: null });
    expect(has(picker(), 'Childcare')).toBe(true);
    expect(has(picker(), 'Groceries')).toBe(true);
  });
});
