/**
 * Phase 4.2 — the Budget UI's write paths, end to end through the store.
 *
 * These are the tests the React components would otherwise need a DOM harness
 * for: every button in the Budget card and editor ends in one of the calls
 * below, so proving the call does the right thing to the store — and that the
 * next report reflects it — is what proves the screen is correct.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, Transaction } from '../types';

// The store's persist middleware needs localStorage before the module loads —
// and so does the one-time planner migration flag.
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
import { budgetsDS, budgetReportDS, customCategoriesDS } from './dataService';
import { autoSeedPlanGoals, pendingPlanGoals } from '../components/overview/budgetShared';
import { toBudgetView } from '../utils/budgetView';

const ME = 'user-ME';
const MONTH = '2026-08';
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

function seed(opts: { budgets?: Budget[]; transactions?: Transaction[]; budgetLines?: any[] } = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com' } as any,
    budgets: opts.budgets ?? [],
    transactions: opts.transactions ?? [],
    transactionSplits: [],
    accounts: [{ id: 'acc-1', name: 'Everyday' } as any],
    creditCards: [],
    budgetLines: opts.budgetLines ?? [],
    budgetSettings: null,
    customCategories: [],
  });
}

/** What the card renders, for a fixed month and "today". */
function view(opts: { month?: string; asOf?: string } = {}) {
  return toBudgetView(budgetReportDS.build({
    month: opts.month ?? MONTH,
    asOf: opts.asOf ?? '2026-08-20',
    adaptive: false,
    includeUnbudgeted: true,
  }));
}

const syncKinds = () => mockedSync.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Editing a budget
// ═════════════════════════════════════════════════════════════════════════════
describe('editing budgets from the UI', () => {
  it('adding a budget makes it appear on the card immediately', () => {
    seed({ transactions: [tx({ amount: -120, category: 'Groceries' })] });
    budgetsDS.setCategoryBudget('Groceries', 500);

    const v = view();
    expect(v.isEmpty).toBe(false);
    expect(v.categories).toHaveLength(1);
    expect(v.categories[0].limit).toBe(500);
    expect(v.categories[0].spent).toBe(120);
    expect(v.categories[0].percentUsed).toBe(24);
    expect(v.categories[0].status).toBe('under');
  });

  it('editing the amount re-reports against the NEW cap, not a stale one', () => {
    seed({ transactions: [tx({ amount: -300, category: 'Groceries' })] });
    budgetsDS.setCategoryBudget('Groceries', 500);
    expect(view().categories[0].status).toBe('under');

    // The user decides $500 was too generous.
    budgetsDS.setCategoryBudget('Groceries', 250);

    const line = view().categories[0];
    expect(line.limit).toBe(250);
    expect(line.status).toBe('over');
    expect(line.message).toEqual({ kind: 'over', by: 50 });
    expect(useStore.getState().budgets).toHaveLength(1);   // edited, not duplicated
  });

  it('deleting a budget moves its spend into the unbudgeted bucket', () => {
    seed({ transactions: [tx({ amount: -120, category: 'Groceries' })] });
    const b = budgetsDS.setCategoryBudget('Groceries', 500)!;
    mockedSync.mockClear();

    budgetsDS.remove(b.id);

    const v = view();
    expect(v.categories).toHaveLength(0);
    expect(v.unbudgeted.map(u => u.name)).toEqual(['Groceries']);
    expect(v.summary.unbudgetedSpend).toBe(120);
    expect(syncKinds()).toEqual(['budget.delete']);
  });

  it('the overall cap is a single row, edited in place', () => {
    seed({
      transactions: [
        tx({ amount: -400, category: 'Groceries' }),
        tx({ amount: -300, category: 'Dining' }),
      ],
    });
    budgetsDS.setOverallBudget(1000);
    budgetsDS.setOverallBudget(600);

    const v = view();
    expect(useStore.getState().budgets.filter(b => b.scope === 'overall')).toHaveLength(1);
    expect(v.overall!.limit).toBe(600);
    expect(v.overall!.spent).toBe(700);            // ALL spend, budgeted or not
    expect(v.overall!.status).toBe('over');
    expect(v.overall!.bar.fillPct).toBe(100);      // saturated, not overflowing
  });

  it('clearing the amount removes the budget rather than capping at zero', () => {
    budgetsDS.setCategoryBudget('Groceries', 500);
    budgetsDS.setCategoryBudget('Groceries', 0);
    expect(useStore.getState().budgets).toHaveLength(0);
    expect(view().isEmpty).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Overspending
// ═════════════════════════════════════════════════════════════════════════════
describe('overspending', () => {
  it('a refund landing later pulls the category back under its cap', () => {
    seed({
      transactions: [
        tx({ id: 'buy', amount: -600, date: '2026-08-05', merchant: 'Harvey Norman', category: 'Shopping' }),
      ],
    });
    budgetsDS.setCategoryBudget('Shopping', 500);
    expect(view().categories[0].status).toBe('over');

    // The canonical spend rules net a MATCHED refund (transaction_type set by
    // refund matching) against its category, so the budget must recover rather
    // than stay permanently over.
    useStore.setState({
      transactions: [
        ...useStore.getState().transactions,
        tx({
          id: 'ref', amount: 250, date: '2026-08-12', merchant: 'Harvey Norman',
          category: 'Shopping', transaction_type: 'refund',
        }),
      ],
    });

    const line = view().categories[0];
    expect(line.spent).toBe(350);
    expect(line.remaining).toBe(150);
    expect(line.status).not.toBe('over');
    // Still flagged at-risk: the run rate for the rest of the month is what it
    // is. The refund undid the breach, not the trend.
    expect(line.status).toBe('at-risk');
  });

  it('an overall cap counts spend the category budgets miss', () => {
    seed({
      transactions: [
        tx({ amount: -100, category: 'Groceries' }),
        tx({ amount: -900, category: 'Impulse' }),   // no budget of its own
      ],
    });
    budgetsDS.setCategoryBudget('Groceries', 500);
    budgetsDS.setOverallBudget(800);

    const v = view();
    expect(v.categories[0].status).toBe('under');    // groceries are fine…
    expect(v.overall!.status).toBe('over');          // …the month is not
    expect(v.summary.unbudgetedSpend).toBe(900);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rollover
// ═════════════════════════════════════════════════════════════════════════════
describe('rollover', () => {
  it('turning rollover on carries last month’s surplus into this month', () => {
    seed({
      transactions: [
        tx({ amount: -100, date: '2026-07-10', category: 'Groceries' }),   // $400 spare
        tx({ amount: -450, date: '2026-08-10', category: 'Groceries' }),
      ],
    });
    budgetsDS.setCategoryBudget('Groceries', 500, { startMonth: '2026-07' });

    // Without rollover, $450 spent by the 20th is heading past the $500 cap.
    expect(view().categories[0].limit).toBe(500);
    expect(view().categories[0].status).toBe('at-risk');

    budgetsDS.setCategoryBudget('Groceries', 500, { rollover: true });

    // With July's surplus carried in, the same spending is comfortable.
    const line = view().categories[0];
    expect(line.rollover).toBe(true);
    expect(line.rolloverIn).toBe(400);
    expect(line.limit).toBe(900);
    expect(line.baseLimit).toBe(500);
    expect(line.status).toBe('under');
  });

  it('turning rollover off again drops the carry', () => {
    seed({ transactions: [tx({ amount: -100, date: '2026-07-10', category: 'Groceries' })] });
    budgetsDS.setCategoryBudget('Groceries', 500, { rollover: true, startMonth: '2026-07' });
    expect(view().categories[0].limit).toBe(900);

    budgetsDS.setCategoryBudget('Groceries', 500, { rollover: false });
    expect(view().categories[0].limit).toBe(500);
    expect(view().categories[0].rolloverIn).toBe(0);
  });

  it('carries a DEBT from an overspent month, shrinking this month’s cap', () => {
    seed({
      transactions: [
        tx({ amount: -700, date: '2026-07-10', category: 'Groceries' }),   // $200 over
        tx({ amount: -150, date: '2026-08-10', category: 'Groceries' }),
      ],
    });
    budgetsDS.setCategoryBudget('Groceries', 500, { rollover: true, startMonth: '2026-07' });

    const line = view().categories[0];
    expect(line.rolloverIn).toBe(-200);
    expect(line.limit).toBe(300);
    expect(line.remaining).toBe(150);
  });

  it('rolls the overall cap independently of the category caps', () => {
    seed({ transactions: [tx({ amount: -100, date: '2026-07-10', category: 'Groceries' })] });
    budgetsDS.setCategoryBudget('Groceries', 500, { startMonth: '2026-07' });
    budgetsDS.setOverallBudget(2000, { rollover: true, startMonth: '2026-07' });

    const v = view();
    expect(v.overall!.rolloverIn).toBe(1900);
    expect(v.categories[0].rolloverIn).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Categories
// ═════════════════════════════════════════════════════════════════════════════
describe('categories', () => {
  it('budgeting a made-up category registers it for use everywhere', () => {
    budgetsDS.setCategoryBudget('Dog stuff', 80);
    expect(useStore.getState().customCategories.map(c => c.name)).toContain('Dog stuff');
  });

  it('renaming moves the budget AND the transactions, so spend never vanishes', () => {
    seed({ transactions: [tx({ amount: -200, category: 'Dining' })] });
    budgetsDS.setCategoryBudget('Dining', 300);
    expect(view().categories[0].spent).toBe(200);

    const moved = customCategoriesDS.rename('Dining', 'Eating out');

    expect(moved).toEqual({ budgets: 1, transactions: 1 });
    const line = view().categories[0];
    expect(line.name).toBe('Eating out');
    expect(line.spent).toBe(200);                  // the whole point: still tracked
    expect(line.limit).toBe(300);
    expect(useStore.getState().customCategories.map(c => c.name)).toContain('Eating out');
    expect(useStore.getState().customCategories.map(c => c.name)).not.toContain('Dining');
  });

  it('renaming onto a category that already has a cap retires the loser', () => {
    seed({ transactions: [tx({ amount: -50, category: 'Dining' })] });
    budgetsDS.setCategoryBudget('Dining', 300);
    budgetsDS.setCategoryBudget('Groceries', 400);

    customCategoriesDS.rename('Dining', 'Groceries');

    // Two user-chosen caps must never be silently summed into one.
    const v = view();
    expect(v.categories).toHaveLength(1);
    expect(v.categories[0].name).toBe('Groceries');
    expect(v.categories[0].limit).toBe(400);
    expect(v.categories[0].spent).toBe(50);        // the transaction still moved
  });

  it('a no-op rename touches nothing', () => {
    budgetsDS.setCategoryBudget('Dining', 300);
    mockedSync.mockClear();
    expect(customCategoriesDS.rename('Dining', 'dining')).toEqual({ budgets: 0, transactions: 0 });
    expect(customCategoriesDS.rename('Dining', '  ')).toEqual({ budgets: 0, transactions: 0 });
    expect(syncKinds()).toEqual([]);
  });

  it('counts what a rename or delete would affect', () => {
    seed({
      transactions: [
        tx({ amount: -10, category: 'Dining' }),
        tx({ amount: -20, category: 'dining' }),
        tx({ amount: -30, category: 'Groceries' }),
      ],
    });
    expect(customCategoriesDS.countTransactions('Dining')).toBe(2);
    expect(customCategoriesDS.countTransactions('Nothing')).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Migration off the planner
// ═════════════════════════════════════════════════════════════════════════════
describe('one-time planner migration', () => {
  const PLAN = [
    { id: 'l1', name: 'Groceries', amount: 400, type: 'expense', source: 'manual', is_category_budget: true },
    { id: 'l2', name: 'Health', amount: 100, type: 'expense', source: 'manual', is_category_budget: true },
    { id: 'l3', name: 'Netflix', amount: 18, type: 'bill', source: 'bill', is_category_budget: false },
  ];

  it('imports the old goals the first time the card is opened', () => {
    seed({ budgetLines: PLAN });

    expect(autoSeedPlanGoals(ME)).toBe(2);

    const v = view();
    expect(v.categories.map(c => c.name).sort()).toEqual(['Groceries', 'Health']);
    expect(v.categories.find(c => c.name === 'Groceries')!.limit).toBe(400);
  });

  it('never imports twice', () => {
    seed({ budgetLines: PLAN });
    expect(autoSeedPlanGoals(ME)).toBe(2);
    expect(autoSeedPlanGoals(ME)).toBe(0);
    expect(useStore.getState().budgets).toHaveLength(2);
  });

  it('does not resurrect a budget the user deleted on another device', () => {
    // Device B: budgets already synced down, planner rows still present.
    seed({ budgetLines: PLAN });
    budgetsDS.setCategoryBudget('Health', 100);

    expect(autoSeedPlanGoals(ME)).toBe(0);
    expect(useStore.getState().budgets.map(b => b.category)).toEqual(['Health']);
  });

  it('imports nothing when there was never a plan', () => {
    seed();
    expect(autoSeedPlanGoals(ME)).toBe(0);
    expect(view().isEmpty).toBe(true);
  });

  it('converts a WEEKLY plan into monthly caps', () => {
    seed({ budgetLines: [{ id: 'l1', name: 'Groceries', amount: 100, type: 'expense', source: 'manual', is_category_budget: true }] });
    useStore.setState({ budgetSettings: { id: 's1', period: 'weekly', income_basis: 'manual', income_amount: 0 } as any });

    autoSeedPlanGoals(ME);

    // $100/week is $433.33/month on the 52/12 year Ledger uses everywhere.
    expect(view().categories[0].limit).toBeCloseTo(433.33, 2);
  });

  it('offers a manual import while plan goals remain uncovered', () => {
    seed({ budgetLines: PLAN });
    expect(pendingPlanGoals()).toBe(2);

    budgetsDS.setCategoryBudget('Groceries', 400);
    expect(pendingPlanGoals()).toBe(1);

    budgetsDS.setCategoryBudget('Health', 100);
    expect(pendingPlanGoals()).toBe(0);
  });

  it('re-evaluates for a different user on a shared device', () => {
    seed({ budgetLines: PLAN });
    expect(autoSeedPlanGoals(ME)).toBe(2);

    // Another account signs in: its own flag has never been set.
    seed({ budgetLines: PLAN });
    expect(autoSeedPlanGoals('user-OTHER')).toBe(2);
  });

  it('writes nothing back to the planner — it is retired, not maintained', () => {
    seed({ budgetLines: PLAN });
    autoSeedPlanGoals(ME);
    budgetsDS.setCategoryBudget('Groceries', 650);
    budgetsDS.setOverallBudget(3000);
    customCategoriesDS.rename('Health', 'Wellbeing');

    expect(syncKinds().some(k => k.startsWith('budgetLine.') || k.startsWith('budgetSettings.'))).toBe(false);
    expect(useStore.getState().budgetLines).toEqual(PLAN);   // untouched, unread
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Refresh
// ═════════════════════════════════════════════════════════════════════════════
describe('refresh', () => {
  it('picks up a transaction that lands after the budget was set', () => {
    seed({ transactions: [tx({ amount: -100, category: 'Groceries' })] });
    budgetsDS.setCategoryBudget('Groceries', 300);
    expect(view().categories[0].spent).toBe(100);

    // A sync from the bank (or another device) lands.
    useStore.setState({
      transactions: [...useStore.getState().transactions, tx({ amount: -250, category: 'Groceries', date: '2026-08-15' })],
    });

    const line = view().categories[0];
    expect(line.spent).toBe(350);
    expect(line.status).toBe('over');
  });

  it('picks up a budget that syncs in from another device', () => {
    seed({ transactions: [tx({ amount: -100, category: 'Groceries' })] });
    expect(view().isEmpty).toBe(true);

    useStore.setState({
      budgets: [{
        id: 'from-server', user_id: ME, scope: 'category', category: 'Groceries',
        limit_amount: 250, period: 'monthly', rollover_enabled: false, active: true,
      } as Budget],
    });

    expect(view().categories[0].limit).toBe(250);
  });

  it('reports a past month without disturbing the current one', () => {
    seed({
      transactions: [
        tx({ amount: -900, date: '2026-07-04', category: 'Groceries' }),
        tx({ amount: -100, date: '2026-08-04', category: 'Groceries' }),
      ],
    });
    budgetsDS.setCategoryBudget('Groceries', 500, { startMonth: '2026-07' });

    const july = view({ month: '2026-07' });
    expect(july.categories[0].spent).toBe(900);
    expect(july.categories[0].status).toBe('over');
    expect(july.monthComplete).toBe(true);
    expect(july.categories[0].projected).toBe(900);   // a finished month is its actuals

    expect(view().categories[0].spent).toBe(100);
  });

  it('scopes everything to the signed-in user', () => {
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

    const v = view();
    expect(v.categories.map(c => c.name)).toEqual(['Groceries']);
    expect(v.categories[0].spent).toBe(100);
    expect(v.summary.totalSpent).toBe(100);
  });
});
