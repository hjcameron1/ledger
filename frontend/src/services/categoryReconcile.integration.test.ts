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
import type {
  Budget, CustomCategory, Transaction, TransactionRule, TransactionSplit,
} from '../types';

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
import { categoryKey, isSeparable } from '../utils/categoryResolve';

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
  transactionRules?: TransactionRule[]; transactionSplits?: TransactionSplit[];
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com' } as any,
    budgets: o.budgets ?? [],
    customCategories: o.customCategories ?? [],
    selectedCategories: o.selectedCategories ?? null,
    hiddenCategories: [],
    budgetLines: [],
    transactions: o.transactions ?? [],
    transactionSplits: o.transactionSplits ?? [],
    transactionRules: o.transactionRules ?? [],
    categoryAliases: o.categoryAliases ?? {},
  } as any);
}

const rule = (o: Partial<TransactionRule>): TransactionRule => ({
  id: 'r1', user_id: ME, priority: 10, enabled: true,
  conditions: { merchant_contains: 'CAFE' }, actions: { category: 'Dining' },
  label: null, ...o,
} as TransactionRule);

const txn = (o: Partial<Transaction>): Transaction => ({
  id: 't1', user_id: ME, category: 'Dining', amount: -40, date: '2026-08-01', ...o,
} as Transaction);

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

    expect(moved).toMatchObject({ budgets: 1, transactions: 2 });
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
    expect(customCategoriesDS.rename('Dining', ' dining ')).toMatchObject({ budgets: 0, transactions: 0 });
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

// ═════════════════════════════════════════════════════════════════════════════
//  Duplicates the user is warned about
// ═════════════════════════════════════════════════════════════════════════════
describe('a name that matches something already there', () => {
  it('is reported as an existing category rather than quietly reused', () => {
    // The UI shows "This category already exists as Groceries" for ANY match —
    // this is the resolution behind that message.
    seed({ customCategories: [cat('Groceries', 'c1')] });
    expect(customCategoriesDS.resolve('groceries')).toMatchObject({
      status: 'exact', canonical: 'Groceries',
    });
    expect(customCategoriesDS.resolve('GROCERIES!')).toMatchObject({ status: 'exact' });
    expect(customCategoriesDS.resolve('grocery')).toMatchObject({
      status: 'alias', via: 'taxonomy', canonical: 'Groceries',
    });
    expect(customCategoriesDS.resolve('grocuries')).toMatchObject({
      status: 'suggestion', canonical: 'Groceries',
    });
  });

  it('marks a decision the user already made, so it is never re-asked', () => {
    seed();
    customCategoriesDS.rememberAlias('grocuries', 'Groceries');
    const again = customCategoriesDS.resolve('GROCURIES ');
    expect(again).toMatchObject({ status: 'alias', via: 'remembered', canonical: 'Groceries' });
  });

  it('separates what CAN be kept apart from what cannot', () => {
    seed({ customCategories: [cat('Groceries', 'c1')] });
    // Different identity: two real categories are possible.
    expect(isSeparable(customCategoriesDS.resolve('Grocery'))).toBe(true);
    expect(isSeparable(customCategoriesDS.resolve('grocuries'))).toBe(true);
    // Same identity: every category lookup in Ledger would treat these as one,
    // so "Add anyway" would produce one category wearing two labels.
    expect(isSeparable(customCategoriesDS.resolve('groceries'))).toBe(false);
    expect(isSeparable(customCategoriesDS.resolve(' GROCERIES! '))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  "Add anyway" — an intentional duplicate
// ═════════════════════════════════════════════════════════════════════════════
describe('a lookalike the user insists is its own category', () => {
  /** What Settings does when "Add anyway" is pressed. */
  const addAnyway = (name: string) => {
    customCategoriesDS.rememberAlias(name, name);
    customCategoriesDS.add(name);
  };

  it('is created, and both categories are offered', () => {
    seed({ customCategories: [cat('Groceries', 'c1')], selectedCategories: null });
    addAnyway('Grocery');
    expect(has(picker(), 'Groceries')).toBe(true);
    expect(has(picker(), 'Grocery')).toBe(true);
  });

  it('stops being questioned on every later use', () => {
    seed({ customCategories: [cat('Groceries', 'c1')] });
    addAnyway('Grocery');
    // Without the remembered decision this is the taxonomy alias grocery →
    // Groceries, and the user would be asked the same question forever.
    expect(customCategoriesDS.resolve('Grocery'))
      .toMatchObject({ status: 'alias', via: 'remembered', canonical: 'Grocery' });
  });

  it('survives reconciliation — the merge it refused is never done for it', () => {
    seed({ customCategories: [cat('Groceries', 'c1')] });
    addAnyway('Grocery');
    budgetsDS.add({
      scope: 'category', category: 'Grocery', limit_amount: 100,
      period: 'monthly', rollover_enabled: false, active: true,
    } as any);

    customCategoriesDS.reconcile();
    customCategoriesDS.reconcile();     // idempotent: still no merge

    const names = useStore.getState().customCategories.map(c => c.name);
    expect(names).toContain('Grocery');
    expect(names).toContain('Groceries');
    expect(budgetsDS.active().find(b => b.category === 'Grocery')).toBeTruthy();
  });

  it('is mirrored to the other devices, like every other decision', () => {
    seed();
    addAnyway('Grocery');
    expect(mockedPatch).toHaveBeenCalledWith({ category_aliases: { grocery: 'Grocery' } });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Deleting a category
// ═════════════════════════════════════════════════════════════════════════════
describe('deleting a category the user created', () => {
  const seedDining = () => seed({
    customCategories: [cat('Supper club', 'c1')],
    budgets: [budget({ id: 'b1', category: 'Supper club' })],
    transactionRules: [rule({ id: 'r1', actions: { category: 'Supper club' } })],
    transactions: [
      txn({ id: 't1', category: 'Supper club' }),
      txn({ id: 't2', category: 'Fuel' }),
    ],
    selectedCategories: ['Food', 'Supper club'],
  });

  it('reports what it is holding up before anything happens', () => {
    seedDining();
    expect(customCategoriesDS.usage('Supper club'))
      .toEqual({ budgets: 1, rules: 1, transactions: 1, splits: 0 });
  });

  it('refuses a built-in', () => {
    seed({ customCategories: [cat('Supper club', 'c1')] });
    const result = customCategoriesDS.deleteCategory('Groceries');
    expect(result.ok).toBe(false);
    expect(useStore.getState().customCategories).toHaveLength(1);
    expect(has(picker(), 'Groceries')).toBe(true);
  });

  it('keeps every transaction, filing them as Uncategorised', () => {
    seedDining();
    customCategoriesDS.deleteCategory('Supper club');

    const txns = useStore.getState().transactions;
    expect(txns).toHaveLength(2);                       // nothing deleted
    expect(txns.find(t => t.id === 't1')?.category).toBe('Uncategorised');
    expect(txns.find(t => t.id === 't2')?.category).toBe('Fuel');
  });

  it('moves them instead when the user picks somewhere', () => {
    seedDining();
    customCategoriesDS.deleteCategory('Supper club', { reassignTo: 'Dining' });

    expect(useStore.getState().transactions.find(t => t.id === 't1')?.category).toBe('Dining');
    expect(budgetsDS.active().find(b => b.id === 'b1')?.category).toBe('Dining');
    expect(useStore.getState().transactionRules[0].actions.category).toBe('Dining');
  });

  it('retires the budget, so the category cannot resurrect itself', () => {
    // reconcile() registers a category for every ACTIVE budget. A live budget
    // left behind would recreate the row on the very next load.
    seedDining();
    customCategoriesDS.deleteCategory('Supper club');
    expect(budgetsDS.active().some(b => b.id === 'b1')).toBe(false);

    customCategoriesDS.reconcile();
    expect(has(customCategoriesDS.names(), 'Supper club')).toBe(false);
    expect(has(picker(), 'Supper club')).toBe(false);
  });

  it('stops the rule filing new transactions under it, without deleting the rule', () => {
    seedDining();
    customCategoriesDS.deleteCategory('Supper club');

    const rules = useStore.getState().transactionRules;
    expect(rules).toHaveLength(1);                      // the user's conditions survive
    expect(rules[0].actions.category).toBeUndefined();
    expect(rules[0].enabled).toBe(false);               // nothing left to do
  });

  it('keeps a rule that still does something else', () => {
    seed({
      customCategories: [cat('Supper club', 'c1')],
      transactionRules: [rule({ id: 'r1', actions: { category: 'Supper club', entity: 'business' } })],
    });
    customCategoriesDS.deleteCategory('Supper club');

    const [r] = useStore.getState().transactionRules;
    expect(r.enabled).toBe(true);
    expect(r.actions).toEqual({ entity: 'business' });
  });

  it('drops it from the saved Settings selection, and says so to the server', () => {
    seedDining();
    customCategoriesDS.deleteCategory('Supper club');
    expect(useStore.getState().selectedCategories).toEqual(['Food']);
    expect(mockedPatch).toHaveBeenCalledWith({ selected_categories: ['Food'] });
  });

  it('puts the destination into the selection when reassigning', () => {
    seedDining();
    customCategoriesDS.deleteCategory('Supper club', { reassignTo: 'Dining' });
    expect(useStore.getState().selectedCategories).toEqual(['Food', 'Dining']);
  });

  it('tells the server the category is gone', () => {
    seedDining();
    customCategoriesDS.deleteCategory('Supper club');
    expect(mockedSync).toHaveBeenCalledWith('customCategory.delete', { id: 'c1' });
  });

  it('forgets aliases that pointed at it', () => {
    seed({
      customCategories: [cat('Supper club', 'c1')],
      categoryAliases: { supperclubb: 'Supper club', grocuries: 'Groceries' },
    });
    customCategoriesDS.deleteCategory('Supper club');
    // The dead alias would otherwise keep capturing every future attempt to
    // create a category with a similar name.
    expect(useStore.getState().categoryAliases).toEqual({ grocuries: 'Groceries' });
  });

  it('leaves the OTHER category alone when deleting an intentional duplicate', () => {
    seed({ customCategories: [cat('Groceries', 'c1'), cat('Grocery', 'c2')] });
    customCategoriesDS.deleteCategory('Grocery');
    expect(useStore.getState().customCategories.map(c => c.name)).toEqual(['Groceries']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Split lines
// ═════════════════════════════════════════════════════════════════════════════
describe('a category used inside a split transaction', () => {
  const seedSplit = () => seed({
    customCategories: [cat('Supper club', 'c1')],
    transactions: [txn({ id: 't1', category: 'Supper club', amount: -100 })],
    transactionSplits: [
      { id: 's1', user_id: ME, transaction_id: 't1', category: 'Supper club', amount: 60 } as TransactionSplit,
      { id: 's2', user_id: ME, transaction_id: 't1', category: 'Fuel', amount: 40 } as TransactionSplit,
    ],
  });

  it('counts split lines towards the category\'s usage', () => {
    seedSplit();
    expect(customCategoriesDS.usage('Supper club')).toMatchObject({ transactions: 1, splits: 1 });
  });

  it('rewrites only the affected line, and the split still balances', () => {
    seedSplit();
    customCategoriesDS.deleteCategory('Supper club', { reassignTo: 'Dining' });

    const lines = useStore.getState().transactionSplits;
    expect(lines).toHaveLength(2);
    expect(lines.map(l => [l.category, l.amount]).sort())
      .toEqual([['Dining', 60], ['Fuel', 40]].sort());
  });

  it('uncategorises the line when there is nowhere to move it', () => {
    seedSplit();
    customCategoriesDS.deleteCategory('Supper club');
    const moved = useStore.getState().transactionSplits.find(l => l.amount === 60);
    expect(moved?.category).toBe('Uncategorised');
  });
});

describe('the Settings menu after a category moves', () => {
  it('does not switch on a destination the user had chosen not to see', () => {
    // Reassigning into a category should not smuggle it into the visible menu.
    seed({
      customCategories: [cat('Supper club', 'c1')],
      selectedCategories: ['Food'],
    });
    customCategoriesDS.deleteCategory('Supper club', { reassignTo: 'Dining' });
    expect(useStore.getState().selectedCategories).toEqual(['Food']);
  });
});
