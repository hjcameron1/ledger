/**
 * Re-filing a transaction that is already SPLIT, end to end through the store.
 *
 * The bug this covers: changing a split transaction's main category moved the
 * category column and left the split lines running underneath it. Budgets kept
 * counting the old division while the row on screen named the new category —
 * a number and a label that could not both be true.
 *
 * The fix is a decision, not a default, so what has to hold is:
 *
 *   • 'replace' removes the split, and the whole amount lands on the new
 *     category — in the budget report, not just in the row;
 *   • 'keep' leaves the split deciding the reporting, and the new category
 *     becomes the dormant fallback the transaction reverts to;
 *   • whichever was chosen survives a reload, because both halves are stored;
 *   • a RULE never answers for a split it has never seen (retro-apply skips
 *     split rows) — a merchant rename still lands;
 *   • removing the split hands reporting back to the category column;
 *   • what the row displays is always a category the report charged.
 *
 * The pure display/decision rules are unit-tested in
 * utils/transactionSplits.test.ts. These are the store-level consequences —
 * everything the report and the sync queue see. Sync is mocked, so
 * "cross-device" means "the right op was queued", which is what the other
 * device replays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, Transaction, TransactionSplit } from '../types';

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
import { transactionsDS, transactionSplitsDS, budgetReportDS } from './dataService';
import { splitDisplay, needsSplitDecision, splitContribution } from '../utils/transactionSplits';

const ME = 'user-ME';
const TODAY = '2026-08-17';
const mockedSync = vi.mocked(syncWithRetry);

const tx = (o: Partial<Transaction> & { amount: number }): Transaction => ({
  id: 'tx-costco', user_id: ME, account_id: 'acc-bank', account_type: 'bank',
  date: '2026-08-10', merchant: 'COSTCO WHOLESALE', raw_description: 'COSTCO WHOLESALE 1234',
  currency: 'AUD', category: 'Groceries', category_source: 'auto',
  is_duplicate_flagged: false, is_subscription: false, ...o,
} as Transaction);

const split = (category: string, amount: number, id = `sp-${category}`): TransactionSplit => ({
  id, user_id: ME, transaction_id: 'tx-costco', category, amount,
  notes: null, tags: null, created_at: TODAY, updated_at: TODAY,
} as TransactionSplit);

const budget = (category: string, limit = 1000, id = `b-${category}`): Budget => ({
  id, user_id: ME, scope: 'category', category, limit_amount: limit,
  period: 'monthly', rollover_enabled: false, active: true,
});

/** The canonical case: Costco −$250 divided three ways. */
const COSTCO_SPLIT = [split('Groceries', 140), split('Household', 70), split('Work', 40)];

function seed(opts: {
  transactions?: Transaction[];
  splits?: TransactionSplit[];
  budgets?: Budget[];
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com' } as any,
    transactions: opts.transactions ?? [tx({ amount: -250 })],
    transactionSplits: opts.splits ?? COSTCO_SPLIT,
    budgets: opts.budgets ?? [budget('Groceries'), budget('Household'), budget('Work'), budget('Travel')],
    accounts: [{ id: 'acc-bank', name: 'Everyday', balance: 5000, type: 'bank' }],
    goals: [], goalContributions: [], alertStates: [], investments: [], superFunds: [],
    creditCards: [], subscriptions: [], incomeEntries: [], bills: [], loans: [],
    recurringSeries: [], customCategories: [], merchants: [], merchantAliases: [],
    transactionRules: [],
  } as any);
}

/** What the BUDGET REPORT charged each category this month. */
function spendByCategory(): Record<string, number> {
  const report = budgetReportDS.build({ asOf: TODAY, includeUnbudgeted: true, adaptive: false });
  const out: Record<string, number> = {};
  for (const l of [...report.categories, ...report.unbudgeted]) {
    if (l.category) out[l.category] = l.spent;
  }
  return out;
}

/** What the ROW shows — the same function every transaction surface renders. */
function displayed(id = 'tx-costco') {
  const s = useStore.getState();
  const t = s.transactions.find(x => x.id === id)!;
  return splitDisplay(t.category, s.transactionSplits.filter(sp => sp.transaction_id === id));
}

const linesFor = (id = 'tx-costco') => transactionSplitsDS.forTransaction(id);
const opsOf = (kind: string) => mockedSync.mock.calls.filter(c => c[0] === kind).map(c => c[1] as any);

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  The bug itself
// ═════════════════════════════════════════════════════════════════════════════
describe('the mismatch the fix exists to prevent', () => {
  it('a split transaction is reported by its LINES, not its category column', () => {
    expect(spendByCategory()).toMatchObject({ Groceries: 140, Household: 70, Work: 40 });
  });

  it('the row never shows a category the report did not charge', () => {
    // The old behaviour: category column moved to Travel, split left underneath.
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });

    const spend = spendByCategory();
    expect(spend.Travel ?? 0).toBe(0);
    expect(spend).toMatchObject({ Groceries: 140, Household: 70, Work: 40 });

    // …and the chip agrees with that, rather than announcing Travel.
    expect(displayed().label).toBe('Groceries');
    expect(displayed().categories).not.toContain('Travel');
  });

  it('asks for a decision only when there is a split that disagrees', () => {
    expect(needsSplitDecision(linesFor(), 'Travel')).toBe(true);
    expect(needsSplitDecision([], 'Travel')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Replace split with the new category
// ═════════════════════════════════════════════════════════════════════════════
describe('“Replace split with new category”', () => {
  it('removes the split and charges the WHOLE amount to the new category', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'replace' });

    expect(linesFor()).toEqual([]);
    const spend = spendByCategory();
    expect(spend.Travel).toBe(250);
    expect(spend.Groceries ?? 0).toBe(0);
    expect(spend.Household ?? 0).toBe(0);
    expect(spend.Work ?? 0).toBe(0);
  });

  it('the displayed category becomes the new one — no deck left behind', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'replace' });
    const d = displayed();
    expect(d).toEqual({ label: 'Travel', isSplit: false, categories: ['Travel'], extra: 0 });
  });

  it('tells the other devices to drop the split as well as re-file the row', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'replace' });

    expect(opsOf('split.deleteFor')).toContainEqual({ id: 'tx-costco' });
    expect(opsOf('split.create')).toEqual([]);          // nothing recreated
    expect(opsOf('transaction.update')[0].data).toMatchObject({
      category: 'Travel', category_source: 'user',
    });
  });

  it('marks the category as the user’s, so no rule can move it back', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'replace' });
    const t = useStore.getState().transactions.find(x => x.id === 'tx-costco')!;
    expect(t.category_source).toBe('user');
    expect(t.confidence).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Keep the existing split
// ═════════════════════════════════════════════════════════════════════════════
describe('“Keep existing split”', () => {
  it('leaves every line untouched — amounts and categories both', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });
    expect(linesFor().map(l => [l.category, l.amount])).toEqual([
      ['Groceries', 140], ['Household', 70], ['Work', 40],
    ]);
    expect(opsOf('split.deleteFor')).toEqual([]);
  });

  it('the split still decides the budgets', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });
    expect(spendByCategory()).toMatchObject({ Groceries: 140, Household: 70, Work: 40 });
  });

  it('the new category becomes the fallback the transaction reverts to', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });
    // Dormant while split…
    expect(displayed().label).toBe('Groceries');
    // …and in force the moment the split is removed.
    transactionSplitsDS.clear('tx-costco');
    expect(displayed().label).toBe('Travel');
    expect(spendByCategory().Travel).toBe(250);
  });

  it('defaults to keeping when no decision was passed — nothing is destroyed unasked', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only');
    expect(linesFor()).toHaveLength(3);
    expect(opsOf('split.deleteFor')).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Editing the split instead
// ═════════════════════════════════════════════════════════════════════════════
describe('“Edit split”', () => {
  it('re-dividing to include the new category moves exactly that much money', () => {
    // What the split editor does when the user gives Travel $40 of the $250.
    transactionSplitsDS.setSplits('tx-costco', [
      { category: 'Groceries', amount: 140 },
      { category: 'Household', amount: 70 },
      { category: 'Travel', amount: 40 },
    ]);

    const spend = spendByCategory();
    expect(spend).toMatchObject({ Groceries: 140, Household: 70, Travel: 40 });
    expect(spend.Work ?? 0).toBe(0);
    expect(displayed().categories).toEqual(['Groceries', 'Household', 'Travel']);
  });

  it('refuses a division that no longer sums to the transaction', () => {
    const res = transactionSplitsDS.setSplits('tx-costco', [
      { category: 'Groceries', amount: 140 },
      { category: 'Travel', amount: 40 },
    ]);
    expect(res.ok).toBe(false);
    expect(linesFor()).toHaveLength(3);                 // untouched
    expect(spendByCategory()).toMatchObject({ Groceries: 140, Household: 70, Work: 40 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rules must not answer for a split they have never seen
// ═════════════════════════════════════════════════════════════════════════════
describe('rule-applied category changes', () => {
  const OTHER_COSTCO = tx({ id: 'tx-plain', amount: -80, category: 'Groceries' });
  const HANDSET = tx({ id: 'tx-handset', amount: -60, category: 'Dining', category_source: 'user' });

  beforeEach(() => {
    seed({
      transactions: [tx({ amount: -250 }), OTHER_COSTCO, HANDSET],
      splits: COSTCO_SPLIT,
    });
  });

  it('“apply to matching existing” re-files the plain row and SKIPS the split one', () => {
    // Correct a different Costco row and push it across every match.
    transactionsDS.applyCorrection('tx-plain', { category: 'Travel' }, 'existing');

    const s = useStore.getState();
    expect(s.transactions.find(t => t.id === 'tx-plain')!.category).toBe('Travel');
    // The split row keeps its column AND its lines — the rule had no way to ask.
    expect(s.transactions.find(t => t.id === 'tx-costco')!.category).toBe('Groceries');
    expect(linesFor()).toHaveLength(3);
    expect(spendByCategory()).toMatchObject({ Groceries: 140 + 0, Household: 70, Work: 40 });
  });

  it('a merchant rename still reaches the split row — that is not what a split decides', () => {
    transactionsDS.applyCorrection('tx-plain', { merchant: 'Costco' }, 'existing');
    const s = useStore.getState();
    expect(s.transactions.find(t => t.id === 'tx-costco')!.merchant).toBe('Costco');
    expect(s.transactions.find(t => t.id === 'tx-costco')!.category).toBe('Groceries');
  });

  it('still protects hand-set rows, as before', () => {
    transactionsDS.applyCorrection('tx-plain', { category: 'Travel' }, 'existing');
    expect(useStore.getState().transactions.find(t => t.id === 'tx-handset')!.category).toBe('Dining');
  });

  it('the user’s own choice on a split row is never treated as a rule', () => {
    // Directly asked for, on this row: it applies, split decision and all.
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'replace' });
    expect(useStore.getState().transactions.find(t => t.id === 'tx-costco')!.category).toBe('Travel');
    expect(linesFor()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Removing the split
// ═════════════════════════════════════════════════════════════════════════════
describe('split removal', () => {
  it('hands reporting back to the transaction’s own category', () => {
    transactionSplitsDS.clear('tx-costco');
    expect(spendByCategory().Groceries).toBe(250);
    expect(displayed()).toEqual({
      label: 'Groceries', isSplit: false, categories: ['Groceries'], extra: 0,
    });
  });

  it('un-splitting after a “keep” lands on the category that was chosen then', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });
    transactionSplitsDS.clear('tx-costco');
    expect(spendByCategory().Travel).toBe(250);
    expect(spendByCategory().Groceries ?? 0).toBe(0);
  });

  it('tells the other devices, so the split does not come back on sync', () => {
    transactionSplitsDS.clear('tx-costco');
    expect(opsOf('split.deleteFor')).toContainEqual({ id: 'tx-costco' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Reload
// ═════════════════════════════════════════════════════════════════════════════
describe('persistence across a refresh', () => {
  /** Round-trip the store through its persisted blob, as a reload does. */
  function reload() {
    const persisted = JSON.parse(localStorage.getItem('ledger-store') ?? '{}');
    const state = persisted.state ?? {};
    useStore.setState({
      transactions: state.transactions ?? [],
      transactionSplits: state.transactionSplits ?? [],
    } as any);
  }

  it('“replace” survives — the split is gone after a reload, not just on screen', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'replace' });
    reload();
    expect(linesFor()).toEqual([]);
    expect(displayed().label).toBe('Travel');
    expect(spendByCategory().Travel).toBe(250);
  });

  it('“keep” survives — split lines AND the fallback category both come back', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });
    reload();
    expect(linesFor().map(l => l.category)).toEqual(['Groceries', 'Household', 'Work']);
    expect(useStore.getState().transactions.find(t => t.id === 'tx-costco')!.category).toBe('Travel');
    expect(displayed().label).toBe('Groceries');
    expect(spendByCategory()).toMatchObject({ Groceries: 140, Household: 70, Work: 40 });
  });

  it('an edited split survives with its new division', () => {
    transactionSplitsDS.setSplits('tx-costco', [
      { category: 'Groceries', amount: 210 },
      { category: 'Travel', amount: 40 },
    ]);
    reload();
    expect(spendByCategory()).toMatchObject({ Groceries: 210, Travel: 40 });
    expect(displayed().label).toBe('Groceries');
    expect(displayed().extra).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What a category drill-down is charged
// ═════════════════════════════════════════════════════════════════════════════
describe('reporting a category’s share of a split', () => {
  it('each category is charged its own slice, and the slices sum to the transaction', () => {
    const lines = linesFor();
    const slices = ['Groceries', 'Household', 'Work'].map(c => splitContribution(lines, c)!);
    expect(slices).toEqual([140, 70, 40]);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it('a category the split does not touch is charged nothing, whatever the column says', () => {
    transactionsDS.applyCorrection('tx-costco', { category: 'Travel' }, 'only', { splits: 'keep' });
    expect(splitContribution(linesFor(), 'Travel')).toBe(0);
    expect(spendByCategory().Travel ?? 0).toBe(0);
  });
});
