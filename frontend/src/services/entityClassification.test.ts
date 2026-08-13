import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction, TransactionRule } from '../types';

// The store's persist middleware writes to localStorage, which the node test env
// lacks. Polyfill a Map-backed stub BEFORE the store module is imported.
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

// The write layer makes network calls; stub it so these tests exercise the pure
// store transitions of applyCorrection / upsertLearned without any I/O.
vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import { transactionsDS, transactionRulesDS } from './dataService';

const ME = 'user-ME';
const OTHER = 'user-OTHER';

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 'x', user_id: ME, account_id: 'acc-1', account_type: 'bank',
    date: '2026-08-13', merchant: 'Woolworths', raw_description: 'WOOLWORTHS 1234 ROBINA',
    amount: -50, currency: 'AUD', category: 'Groceries', source: 'basiq',
    created_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:00:00Z',
    ...over,
  } as Transaction;
}

/** Reset the slice of the store these flows read/write, as user ME. */
function seed(transactions: Transaction[], rules: TransactionRule[] = []) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com' } as any,
    transactions,
    transactionRules: rules,
    merchants: [], merchantAliases: [], customCategories: [],
  });
}

const rulesNow = () => useStore.getState().transactionRules;
const txNow = (id: string) => useStore.getState().transactions.find(t => t.id === id)!;

beforeEach(() => seed([]));

describe('applyCorrection — business/personal classification', () => {
  it('"only" sets the row entity and teaches NO rule', () => {
    seed([tx({ id: 't1' })]);
    transactionsDS.applyCorrection('t1', { entity: 'business' }, 'only');
    expect(txNow('t1').entity).toBe('business');
    expect(rulesNow()).toHaveLength(0);
  });

  it('"future" sets the row and persists a user-owned rule that stamps the entity', () => {
    seed([tx({ id: 't1' })]);
    transactionsDS.applyCorrection('t1', { entity: 'business' }, 'future');

    expect(txNow('t1').entity).toBe('business');
    const rules = rulesNow();
    expect(rules).toHaveLength(1);
    expect(rules[0].user_id).toBe(ME);
    expect(rules[0].actions.entity).toBe('business');
    expect(rules[0].conditions.merchant_contains).toBe('WOOLWORTHS');
  });

  it('teaching a category then an entity for the same merchant MERGES into one rule', () => {
    seed([tx({ id: 't1' })]);
    transactionsDS.applyCorrection('t1', { category: 'Office supplies' }, 'future');
    transactionsDS.applyCorrection('t1', { entity: 'business' }, 'future');

    const rules = rulesNow();
    expect(rules).toHaveLength(1);                       // not two competing rules
    expect(rules[0].actions.category).toBe('Office supplies');
    expect(rules[0].actions.entity).toBe('business');
  });

  it('"existing" retro-applies the entity to every stored match, sparing hand-set categories', () => {
    seed([
      tx({ id: 't1', raw_description: 'WOOLWORTHS 1234 ROBINA' }),
      tx({ id: 't2', raw_description: 'WOOLWORTHS 5678 SYDNEY' }),
      tx({ id: 't3', raw_description: 'WOOLWORTHS ONLINE', category: 'Health', category_source: 'user' }),
      tx({ id: 't4', merchant: 'Coles', raw_description: 'COLES 999', category: 'Groceries' }),
    ]);

    transactionsDS.applyCorrection('t1', { entity: 'business' }, 'existing');

    expect(txNow('t1').entity).toBe('business');
    expect(txNow('t2').entity).toBe('business');         // sibling variant caught
    expect(txNow('t3').entity).toBe('business');         // caught even though user-categorised
    expect(txNow('t3').category).toBe('Health');         // …but its hand-set category is untouched
    expect(txNow('t4').entity).toBeUndefined();          // unrelated merchant left alone
  });

  it('clearing (direct update) removes the classification without touching rules', () => {
    seed([tx({ id: 't1', entity: 'business' })], [
      { id: 'r1', user_id: ME, priority: 100, enabled: true,
        conditions: { merchant_contains: 'WOOLWORTHS' }, actions: { entity: 'business' },
        created_at: '2026-08-13T00:00:00Z' },
    ]);
    transactionsDS.update('t1', { entity: null });
    expect(txNow('t1').entity).toBeNull();
    expect(rulesNow()).toHaveLength(1);                  // the rule persists for future rows
  });

  it('user isolation: never merges into another user\'s rule — mints my own', () => {
    seed([tx({ id: 't1' })], [
      { id: 'foreign', user_id: OTHER, priority: 100, enabled: true,
        conditions: { merchant_contains: 'WOOLWORTHS' }, actions: { entity: 'personal' },
        created_at: '2026-08-13T00:00:00Z' },
    ]);

    transactionsDS.applyCorrection('t1', { entity: 'business' }, 'future');

    const rules = rulesNow();
    expect(rules).toHaveLength(2);                                   // foreign rule untouched
    expect(rules.find(r => r.id === 'foreign')!.actions.entity).toBe('personal');
    const mine = rules.find(r => r.user_id === ME)!;
    expect(mine.id).not.toBe('foreign');
    expect(mine.actions.entity).toBe('business');
  });
});
