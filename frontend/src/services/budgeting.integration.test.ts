import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, Transaction } from '../types';

// Polyfill localStorage (the store's persist middleware needs it) BEFORE the
// store module loads.
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

import { useStore } from '../store';
import { syncWithRetry } from './syncQueue';
import { budgetsDS, budgetReportDS } from './dataService';

const ME = 'user-ME';
const mockedSync = vi.mocked(syncWithRetry);

let seq = 0;
function tx(o: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: o.id ?? `t${seq}`,
    user_id: ME,
    account_id: 'acc-1',
    account_type: 'bank',
    date: '2026-08-10',
    merchant: 'Woolworths',
    currency: 'AUD',
    category: 'Groceries',
    is_duplicate_flagged: false,
    is_subscription: false,
    ...o,
  } as Transaction;
}

function seed(opts: { budgets?: Budget[]; transactions?: Transaction[]; userId?: string } = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    budgets: opts.budgets ?? [],
    transactions: opts.transactions ?? [],
    transactionSplits: [],
    accounts: [{ id: 'acc-1', name: 'Everyday' } as any],
    creditCards: [],
    budgetLines: [],
    budgetSettings: null,
    customCategories: [],
  });
}

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

/** The sync-queue calls a DS write made, by kind. */
function syncKinds(): string[] {
  return mockedSync.mock.calls.map(c => c[0] as string);
}

describe('budgetsDS persistence', () => {
  it('creates a category budget and queues it for the server', () => {
    const b = budgetsDS.setCategoryBudget('Groceries', 500, { rollover: true });

    expect(b).not.toBeNull();
    expect(useStore.getState().budgets).toHaveLength(1);
    expect(syncKinds()).toContain('budget.create');

    // The payload the server receives carries the whole Phase 4 shape — a
    // budget set on one device is the same budget on the next.
    const call = mockedSync.mock.calls.find(c => c[0] === 'budget.create')!;
    expect((call[1] as any).data).toMatchObject({
      scope: 'category',
      category: 'Groceries',
      limit_amount: 500,
      period: 'monthly',
      rollover_enabled: true,
      active: true,
    });
  });

  it('edits the existing budget instead of creating a duplicate', () => {
    budgetsDS.setCategoryBudget('Groceries', 500);
    mockedSync.mockClear();
    budgetsDS.setCategoryBudget('groceries', 650); // different casing, same category

    expect(useStore.getState().budgets).toHaveLength(1);
    expect(useStore.getState().budgets[0].limit_amount).toBe(650);
    expect(syncKinds()).toEqual(['budget.update']);
  });

  it('registers a custom category so the budget’s category is pickable elsewhere', () => {
    budgetsDS.setCategoryBudget('Dog stuff', 80);
    expect(useStore.getState().customCategories.map(c => c.name)).toContain('Dog stuff');
  });

  it('removes a budget when its amount is cleared', () => {
    budgetsDS.setCategoryBudget('Groceries', 500);
    mockedSync.mockClear();
    budgetsDS.setCategoryBudget('Groceries', 0);

    expect(useStore.getState().budgets).toHaveLength(0);
    expect(syncKinds()).toEqual(['budget.delete']);
  });

  it('keeps one overall budget, upserting it', () => {
    budgetsDS.setOverallBudget(3000);
    budgetsDS.setOverallBudget(3500, { rollover: true });

    const all = useStore.getState().budgets;
    expect(all).toHaveLength(1);
    expect(all[0].scope).toBe('overall');
    expect(all[0].category).toBeNull();
    expect(all[0].limit_amount).toBe(3500);
    expect(all[0].rollover_enabled).toBe(true);
  });

  it('imports the legacy plan’s goals once', () => {
    useStore.setState({
      budgetSettings: { id: 's1', period: 'monthly', income_basis: 'manual', income_amount: 0 } as any,
      budgetLines: [
        { id: 'l1', name: 'Groceries', amount: 400, type: 'expense', source: 'manual', is_category_budget: true } as any,
        { id: 'l2', name: 'Health', amount: 100, type: 'expense', source: 'manual', is_category_budget: true } as any,
        { id: 'l3', name: 'Netflix', amount: 18, type: 'bill', source: 'bill', is_category_budget: false } as any,
      ],
    });

    expect(budgetsDS.seedFromPlan()).toBe(2);          // the two categories only
    expect(budgetsDS.seedFromPlan()).toBe(0);          // idempotent
    expect(useStore.getState().budgets).toHaveLength(2);
  });
});

describe('budgetReportDS', () => {
  it('reports spend for the month using the canonical spend rules', () => {
    seed({
      transactions: [
        tx({ amount: -120, date: '2026-08-05', category: 'Groceries' }),
        tx({ amount: -80, date: '2026-08-06', category: 'Dining' }),
        // Excluded: a transfer pair, a card repayment, and last month's spend.
        tx({ id: 'o', amount: -500, date: '2026-08-07', merchant: 'TRANSFER TO SAVINGS', account_id: 'acc-1' }),
        tx({ id: 'i', amount: 500, date: '2026-08-07', merchant: 'TRANSFER FROM CHEQUE', account_id: 'acc-2' }),
        tx({ amount: -300, date: '2026-08-08', merchant: 'AMEX PAYMENT', category: 'Bills' }),
        tx({ amount: -900, date: '2026-07-20', category: 'Groceries' }),
      ],
    });
    budgetsDS.setCategoryBudget('Groceries', 400);

    const r = budgetReportDS.build({ month: '2026-08', asOf: '2026-08-31', adaptive: false });

    expect(r.categories).toHaveLength(1);
    expect(r.categories[0].spent).toBe(120);
    expect(r.categories[0].remaining).toBe(280);
    expect(r.categories[0].percentUsed).toBe(30);
    expect(r.totalSpent).toBe(200); // groceries + dining, nothing else
  });

  it('scopes the report to the signed-in user', () => {
    seed({
      transactions: [
        tx({ amount: -100, user_id: ME, category: 'Groceries' }),
        tx({ amount: -900, user_id: 'user-OTHER', category: 'Groceries' }),
      ],
      budgets: [
        { id: 'mine', user_id: ME, scope: 'category', category: 'Groceries', limit_amount: 500, period: 'monthly', rollover_enabled: false, active: true },
        { id: 'theirs', user_id: 'user-OTHER', scope: 'category', category: 'Dining', limit_amount: 999, period: 'monthly', rollover_enabled: false, active: true },
      ],
    });

    const r = budgetReportDS.build({ month: '2026-08', asOf: '2026-08-31', adaptive: false });

    expect(r.categories.map(c => c.name)).toEqual(['Groceries']);
    expect(r.categories[0].spent).toBe(100);
    expect(r.totalSpent).toBe(100);
  });

  it('projects month-end spend from the learned rate mid-month', () => {
    // Three months of ~$600/month groceries, then a quiet first week of August.
    const history: Transaction[] = [];
    for (const month of ['05', '06', '07']) {
      for (const day of ['05', '12', '19', '26']) {
        history.push(tx({ amount: -150, date: `2026-${month}-${day}`, category: 'Groceries' }));
      }
    }
    history.push(tx({ amount: -60, date: '2026-08-03', category: 'Groceries' }));
    seed({ transactions: history });
    budgetsDS.setCategoryBudget('Groceries', 500);

    const r = budgetReportDS.build({ month: '2026-08', asOf: '2026-08-04' });
    const line = r.categories[0];

    // Four days in, $60 spent: the naive run rate says ~$465, but history says
    // this is a ~$600/month category — so the projection warns, not reassures.
    expect(line.spent).toBe(60);
    expect(line.projected).toBeGreaterThan(500);
    expect(line.status).toBe('at-risk');
  });

  it('defaults to the current month when none is given', () => {
    const r = budgetReportDS.build({ asOf: '2026-08-14', adaptive: false });
    expect(r.month).toBe('2026-08');
    expect(r.daysElapsed).toBe(14);
  });
});
