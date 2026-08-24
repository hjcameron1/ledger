/**
 * Phase 9.1 — Ask Ledger, end to end through the store.
 *
 * The pure layers are tested on their own (utils/askIntent.test.ts,
 * utils/askAnswer.test.ts). These are the things they cannot prove without the
 * real data service wired up — and they are the ones that matter, because this
 * phase puts a natural-language front door on somebody's finances:
 *
 *   • the five questions in the brief return the RIGHT figures, and the same
 *     figures the corresponding screen would show;
 *   • an answer is scoped: personal reports the user's own rows, a household
 *     view reports what was shared to it, and one user never sees another's;
 *   • missing data is REPORTED, never estimated — no budget, no offset, no
 *     goal date, history that doesn't reach back that far;
 *   • conflicting records are surfaced rather than silently reconciled;
 *   • asking a question WRITES NOTHING — no store mutation, no queued sync.
 *
 * Sync is mocked, which is how the last one is proved: if asking a question had
 * touched anything, a sync op would have been queued.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  BankAccount, Transaction, Loan, Goal, Budget, Bill, IncomeEntry,
  Household, HouseholdMember,
} from '../types';

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
import { askDS } from './dataService';
import type { AskFacts } from '../utils/askAnswer';

const ADA = 'user-ada';
const BO = 'user-bo';
const HH = 'hh-1';
const TODAY = '2026-08-24';

const mockedSync = vi.mocked(syncWithRetry);

// ── Fixtures ────────────────────────────────────────────────────────────────

const account = (o: Partial<BankAccount> = {}): BankAccount => ({
  id: 'acc-1', user_id: ADA, name: 'Everyday', institution: 'CBA',
  account_type: 'transaction', balance: 10_000, currency: 'AUD', is_manual: true,
  household_id: null, ...o,
});

let txSeq = 0;
const txn = (o: Partial<Transaction> = {}): Transaction => ({
  id: `tx-${++txSeq}`, user_id: ADA, account_id: 'acc-1', account_type: 'bank',
  date: '2026-08-01', merchant: 'Cornerstone Cafe', amount: -50, currency: 'AUD',
  category: 'Dining', is_duplicate_flagged: false, is_subscription: false,
  household_id: null, ...o,
} as Transaction);

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'loan-1', user_id: ADA, name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 600_000, current_balance: 500_000, interest_rate: 6,
  minimum_repayment: 3_000, repayment_frequency: 'monthly',
  next_due_date: '2026-09-01', include_in_net_worth: true,
  household_id: null, ...o,
} as Loan);

const goal = (o: Partial<Goal> = {}): Goal => ({
  id: 'goal-1', user_id: ADA, name: 'House deposit', target_amount: 100_000,
  current_amount: 25_000, household_id: null, ...o,
} as Goal);

const budget = (o: Partial<Budget> = {}): Budget => ({
  id: 'bud-1', user_id: ADA, scope: 'category', category: 'Dining',
  limit_amount: 400, period: 'monthly', rollover_enabled: false, active: true,
  household_id: null, ...o,
});

const bill = (o: Partial<Bill> = {}): Bill => ({
  id: 'bill-1', user_id: ADA, name: 'Electricity', amount: 180,
  due_date: '2026-09-05', is_recurring: false, colour: 'grey', is_paid: false,
  ...o,
} as Bill);

const income = (o: Partial<IncomeEntry> = {}): IncomeEntry => ({
  id: 'inc-1', user_id: ADA, source: 'Acme Pty Ltd', amount: 8_000,
  frequency: 'monthly', is_recurring: true, status: 'approved',
  date: '2026-08-15', household_id: null, ...o,
} as IncomeEntry);

const household = (o: Partial<Household> = {}): Household =>
  ({ id: HH, name: 'Ada & Bo', created_by: ADA, currency: 'AUD', ...o });

const member = (o: Partial<HouseholdMember> = {}): HouseholdMember =>
  ({ id: `m-${o.user_id ?? ADA}`, household_id: HH, user_id: ADA, role: 'owner', status: 'active', ...o });

const COUPLE = [member({ user_id: ADA, role: 'owner' }), member({ user_id: BO, role: 'member' })];

interface Seed {
  as?: string;
  scope?: 'personal' | 'household';
  households?: Household[];
  members?: HouseholdMember[];
  activeHouseholdId?: string | null;
  accounts?: BankAccount[];
  transactions?: Transaction[];
  loans?: Loan[];
  goals?: Goal[];
  budgets?: Budget[];
  bills?: Bill[];
  incomeEntries?: IncomeEntry[];
}

function seed(o: Seed = {}) {
  useStore.setState({
    user: { id: o.as ?? ADA, email: 'ada@example.com', currency_preference: 'AUD' } as any,
    households: o.households ?? [],
    householdMembers: o.members ?? [],
    financeScope: o.scope ?? 'personal',
    activeHouseholdId: o.activeHouseholdId ?? (o.scope === 'household' ? HH : null),
    accounts: o.accounts ?? [],
    transactions: o.transactions ?? [],
    loans: o.loans ?? [],
    goals: o.goals ?? [],
    budgets: o.budgets ?? [],
    bills: o.bills ?? [],
    incomeEntries: o.incomeEntries ?? [],
    // Everything the engines read — empty unless a test needs it.
    creditCards: [], subscriptions: [], investments: [], investmentSales: [],
    superFunds: [], properties: [], goalContributions: [], loanEvents: [],
    recurringSeries: [], transactionSplits: [], customCategories: [],
    alertStates: [], netWorthHistory: [], pendingSyncQueue: [],
    recordShares: [], shareCodes: [], insurancePolicies: [],
    insurancePremiumHistory: [], merchants: [], merchantAliases: [],
    transactionRules: [], pendingPayments: [], notifications: [],
  } as any);
}

const ask = (q: string) => askDS.answer(q, { asOf: TODAY });

/** Narrow the facts union in a test without repeating the assertion. */
function factsOf<K extends AskFacts['kind']>(q: string, kind: K): Extract<AskFacts, { kind: K }> {
  const answer = ask(q);
  expect(answer.facts.kind).toBe(kind);
  return answer.facts as Extract<AskFacts, { kind: K }>;
}

/** A year of dining, so "this year" has something real to count. */
function diningYear(): Transaction[] {
  return [
    txn({ date: '2026-02-10', amount: -80, category: 'Dining', merchant: 'Uber Eats' }),
    txn({ date: '2026-05-14', amount: -120.50, category: 'Dining', merchant: 'Cornerstone Cafe' }),
    txn({ date: '2026-08-02', amount: -60, category: 'Dining', merchant: 'Uber Eats' }),
    txn({ date: '2026-08-11', amount: -240, category: 'Groceries', merchant: 'Woolworths' }),
    // Last year — must NOT be counted by a "this year" question.
    txn({ date: '2025-11-01', amount: -500, category: 'Dining', merchant: 'Uber Eats' }),
  ];
}

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  txSeq = 0;
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  The questions the brief names
// ═════════════════════════════════════════════════════════════════════════════

describe('"How much did I spend eating out this year?"', () => {
  beforeEach(() => seed({ accounts: [account()], transactions: diningYear() }));

  it('counts the right transactions and no others', () => {
    const facts = factsOf('How much did I spend eating out this year?', 'spend-category');
    expect(facts.category).toBe('Dining');
    expect(facts.total).toBe(260.50);      // 80 + 120.50 + 60 — NOT last year's 500
    expect(facts.count).toBe(3);
    expect(facts.period.from).toBe('2026-01-01');
  });

  it('reports the share of all spending from the same numbers', () => {
    const facts = factsOf('How much did I spend eating out this year?', 'spend-category');
    expect(facts.totalSpend).toBe(500.50);            // dining + groceries
    expect(facts.share).toBeCloseTo(52.05, 1);
  });

  it('names the merchants behind it', () => {
    const facts = factsOf('How much did I spend eating out this year?', 'spend-category');
    expect(facts.merchants[0]).toMatchObject({ merchant: 'Uber Eats', total: 140, count: 2 });
  });

  it('links to exactly the transactions it counted', () => {
    const answer = ask('How much did I spend eating out this year?');
    const source = answer.sources.find(s => s.kind === 'transactions');
    expect(source?.to).toBe('/accounts?tab=transactions&category=Dining');
    expect(source?.count).toBe(3);
  });

  it('says so, and does not answer $0 quietly, when the category has nothing', () => {
    seed({ accounts: [account()], transactions: [txn({ category: 'Groceries', amount: -100 })] });
    const answer = ask('How much did I spend on Dining this month?');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
    expect(answer.headline).toMatch(/no Dining spending/i);
  });

  it('answers about ALL spending — and says why — when the category cannot be placed', () => {
    seed({ accounts: [account()], transactions: diningYear() });
    const answer = ask('How much did I spend on yacht maintenance this year?');
    expect(answer.intent).toBe('spend-total');
    expect(answer.gaps.some(g => g.kind === 'unresolved')).toBe(true);
  });
});

describe('"Why is my forecast dropping?"', () => {
  it('reports the projection, its low point and the biggest outgoings', () => {
    seed({
      accounts: [account({ balance: 4_000 })],
      loans: [loan({ minimum_repayment: 3_000, next_due_date: '2026-09-01' })],
      incomeEntries: [income({ amount: 1_000 })],
    });
    const facts = factsOf('Why is my forecast dropping?', 'forecast-outlook');
    expect(facts.opening).toBe(4_000);
    expect(facts.horizonDays).toBe(90);
    expect(facts.outflow).toBeGreaterThan(0);
    expect(facts.biggestOutflows.length).toBeGreaterThan(0);
    // The mortgage repayment is the thing pulling it down, and it is named.
    expect(facts.biggestOutflows.some(o => /mortgage/i.test(o.name))).toBe(true);
  });

  it('warns when the projection goes below zero, with the date', () => {
    seed({
      accounts: [account({ balance: 500 })],
      loans: [loan({ minimum_repayment: 3_000, next_due_date: '2026-09-01' })],
    });
    const answer = ask('Why is my forecast dropping?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'forecast-outlook' }>;
    expect(facts.negativeFrom).not.toBeNull();
    expect(answer.gaps.some(g => g.kind === 'conflict')).toBe(true);
  });

  it('refuses to project at all with no accounts, rather than projecting from zero', () => {
    seed({ loans: [loan()] });
    const answer = ask('Why is my forecast dropping?');
    expect(answer.facts.kind).toBe('unknown');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
    expect(answer.figures).toEqual([]);
  });
});

describe('"How much interest is my offset saving?"', () => {
  it('prices the offset from the loan engine', () => {
    seed({
      accounts: [account({ id: 'offset-acc', name: 'Offset', balance: 100_000 })],
      loans: [loan({ current_balance: 500_000, interest_rate: 6, offset_account_id: 'offset-acc' })],
    });
    const facts = factsOf('How much interest is my offset saving?', 'loan-offset');
    expect(facts.totalOffset).toBe(100_000);
    expect(facts.totalSavingPerYear).toBe(6_000);      // 100k × 6%
    expect(facts.loans[0].effectiveBalance).toBe(400_000);
    expect(facts.loans[0].accountName).toBe('Offset');
  });

  it('reads the LIVE account balance, not a stale stored figure', () => {
    seed({
      accounts: [account({ id: 'offset-acc', name: 'Offset', balance: 50_000 })],
      loans: [loan({ offset_balance: 999_999, offset_account_id: 'offset-acc' })],
    });
    const facts = factsOf('What is my offset saving me?', 'loan-offset');
    expect(facts.totalOffset).toBe(50_000);
  });

  it('reports a broken link as offsetting NOTHING, and says so', () => {
    // The dangerous case: a deleted account would otherwise go on discounting
    // interest forever against cash that isn't there.
    seed({
      accounts: [],
      loans: [loan({ offset_balance: 100_000, offset_account_id: 'deleted-acc' })],
    });
    const answer = ask('How much interest is my offset saving?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'loan-offset' }>;
    expect(facts.totalOffset).toBe(0);
    expect(facts.totalSavingPerYear).toBe(0);
    expect(facts.loans[0].linkBroken).toBe(true);
    expect(answer.gaps.some(g => g.kind === 'conflict')).toBe(true);
  });

  it('says there is no offset rather than reporting a saving of zero as news', () => {
    seed({ accounts: [account()], loans: [loan({ offset_balance: 0 })] });
    const answer = ask('How much interest is my offset saving?');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
  });

  it('cannot price an offset on a loan with no rate, and admits it', () => {
    seed({
      accounts: [account({ id: 'offset-acc', name: 'Offset', balance: 50_000 })],
      loans: [loan({ interest_rate: 0, offset_account_id: 'offset-acc' })],
    });
    const answer = ask('How much interest is my offset saving?');
    expect(answer.gaps.some(g => /no interest rate on file/i.test(g.message))).toBe(true);
  });
});

describe('"What deductions do I have?"', () => {
  it('totals the deductible transactions for the financial year', () => {
    seed({
      accounts: [account()],
      transactions: [
        txn({ date: '2026-07-10', amount: -300, is_tax_deductible: true, category: 'Other' } as any),
        txn({ date: '2026-08-01', amount: -200, is_tax_deductible: true, category: 'Other' } as any),
        // Last financial year — a different question's answer.
        txn({ date: '2026-06-01', amount: -900, is_tax_deductible: true, category: 'Other' } as any),
        // Not deductible.
        txn({ date: '2026-08-02', amount: -1_000, category: 'Dining' }),
      ],
    });
    const facts = factsOf('What deductions do I have?', 'tax-deductions');
    expect(facts.fy).toBe('2026-2027');
    expect(facts.total).toBe(500);
    expect(facts.lineCount).toBe(2);
  });

  it('answers about a named financial year', () => {
    seed({
      accounts: [account()],
      transactions: [
        txn({ date: '2026-06-01', amount: -900, is_tax_deductible: true } as any),
        txn({ date: '2026-08-01', amount: -200, is_tax_deductible: true } as any),
      ],
    });
    const facts = factsOf('What deductions do I have for last financial year?', 'tax-deductions');
    expect(facts.fy).toBe('2025-2026');
    expect(facts.total).toBe(900);
  });

  it('says there are none rather than reporting a confident zero', () => {
    seed({ accounts: [account()], transactions: [txn({ amount: -100 })] });
    const answer = ask('What deductions do I have?');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
    expect(answer.headline).toMatch(/no deductions/i);
  });
});

describe('"Am I on track for my goal?"', () => {
  it('reports progress against the target', () => {
    seed({
      accounts: [account()],
      goals: [goal({ target_amount: 100_000, current_amount: 25_000, target_date: '2028-01-01' })],
    });
    const facts = factsOf('Am I on track for my goal?', 'goal-progress');
    expect(facts.goals[0]).toMatchObject({ name: 'House deposit', target: 100_000, saved: 25_000, percent: 25 });
  });

  it('answers about the goal the question names', () => {
    seed({
      accounts: [account()],
      goals: [
        goal({ id: 'g1', name: 'House deposit', target_amount: 100_000, current_amount: 25_000 }),
        goal({ id: 'g2', name: 'Japan trip', target_amount: 8_000, current_amount: 6_000 }),
      ],
    });
    const facts = factsOf('Am I on track for the Japan trip?', 'goal-progress');
    expect(facts.focus).toBe('Japan trip');
    expect(facts.goals).toHaveLength(1);
    expect(facts.goals[0].saved).toBe(6_000);
  });

  it('will not say on-track or off-track for a goal with no target date', () => {
    seed({ accounts: [account()], goals: [goal({ target_date: null } as any)] });
    const answer = ask('Am I on track for my goal?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.goals[0].onTrack).toBeNull();
    expect(answer.gaps.some(g => /no target date/i.test(g.message))).toBe(true);
  });

  it('says there are no goals rather than inventing one', () => {
    seed({ accounts: [account()] });
    const answer = ask('Am I on track for my goal?');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
    expect(answer.headline).toMatch(/no savings goals/i);
  });

  it('reports a goal named in the question but absent from this view', () => {
    seed({ accounts: [account()], goals: [goal({ name: 'House deposit' })] });
    const answer = ask('Am I on track for my Ferrari fund?');
    // The goal isn't nameable, so the question is answered about the goals the
    // user HAS — never about a different goal dressed up as the one they asked for.
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.goals.every(g => g.name !== 'Ferrari fund')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Other questions, and agreement with the screens
// ═════════════════════════════════════════════════════════════════════════════

describe('the rest of the question set', () => {
  it('reports the budget position from the budget engine', () => {
    seed({
      accounts: [account()],
      budgets: [budget({ category: 'Dining', limit_amount: 400 })],
      transactions: [
        txn({ date: '2026-08-02', amount: -300, category: 'Dining' }),
        txn({ date: '2026-08-10', amount: -250, category: 'Dining' }),
      ],
    });
    const facts = factsOf('How am I tracking against my budget?', 'budget-status');
    expect(facts.budgeted).toBe(400);
    expect(facts.spent).toBe(550);
    expect(facts.over.map(l => l.category)).toContain('Dining');
  });

  it('says there is no budget rather than reporting 0 of 0', () => {
    seed({ accounts: [account()], transactions: [txn({ amount: -100 })] });
    const answer = ask('How am I tracking against my budget?');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
  });

  it('adds up net worth exactly as the Overview does', () => {
    seed({ accounts: [account({ balance: 12_000 })], loans: [loan({ current_balance: 5_000 })] });
    const facts = factsOf('What is my net worth?', 'net-worth');
    expect(facts.net).toBe(7_000);
    expect(facts.assets).toBe(12_000);
    expect(facts.liabilities).toBe(5_000);
  });

  it('lists the bills actually due, and flags the overdue ones it did not count', () => {
    seed({
      accounts: [account()],
      bills: [
        bill({ id: 'b1', name: 'Electricity', amount: 180, due_date: '2026-09-05' }),
        bill({ id: 'b2', name: 'Council rates', amount: 900, due_date: '2027-01-01' }),
        bill({ id: 'b3', name: 'Water', amount: 90, due_date: '2026-08-01' }),
      ],
    });
    const answer = ask('What bills are due?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'bills-upcoming' }>;
    expect(facts.bills.map(b => b.name)).toEqual(['Electricity']);
    expect(facts.total).toBe(180);
    expect(answer.gaps.some(g => /past due/i.test(g.message))).toBe(true);
  });

  it('counts income that actually landed, and flags entries that did not', () => {
    seed({
      accounts: [account()],
      transactions: [txn({ date: '2026-08-15', amount: 8_000, merchant: 'Acme Pty Ltd', category: 'Income' })],
      incomeEntries: [income({ date: '2026-08-15' })],
    });
    const facts = factsOf('How much have I earned this month?', 'income-total');
    expect(facts.total).toBe(8_000);
    // Counted once — the deposit — with the entry reported beside it, not added.
    expect(ask('How much have I earned this month?').gaps.some(g => /income entr/i.test(g.message))).toBe(true);
  });

  it('answers an unanswerable question honestly', () => {
    seed({ accounts: [account()] });
    const answer = ask('What is the capital of France?');
    expect(answer.facts.kind).toBe('unknown');
    expect(answer.figures).toEqual([]);
    expect(answer.gaps.some(g => g.kind === 'unsupported')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Permissions, households and isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('user isolation', () => {
  it('never counts another user’s transactions', () => {
    seed({
      accounts: [account()],
      transactions: [
        txn({ user_id: ADA, date: '2026-08-01', amount: -100, category: 'Dining' }),
        txn({ user_id: BO, date: '2026-08-02', amount: -900, category: 'Dining' }),
      ],
    });
    const facts = factsOf('How much did I spend on Dining this month?', 'spend-category');
    expect(facts.total).toBe(100);
    expect(facts.count).toBe(1);
  });

  it('never counts another user’s loans, goals or bills', () => {
    seed({
      accounts: [account()],
      loans: [loan({ user_id: BO, offset_balance: 100_000 })],
      goals: [goal({ user_id: BO })],
      bills: [bill({ user_id: BO, due_date: '2026-09-01' })],
    });
    expect((ask('How much interest is my offset saving?').facts as any).loans).toEqual([]);
    expect((ask('Am I on track for my goal?').facts as any).goals).toEqual([]);
    expect((ask('What bills are due?').facts as any).bills).toEqual([]);
  });

  it('cannot name another user’s goal, so it cannot be asked about', () => {
    seed({ accounts: [account()], goals: [goal({ user_id: BO, name: 'Bo secret fund' })] });
    expect(askDS.vocabulary().goals).toEqual([]);
    const answer = ask('Am I on track for Bo secret fund?');
    expect((answer.facts as any).goals).toEqual([]);
  });

  it('the same store answers differently for a different signed-in user', () => {
    const shared = [
      txn({ user_id: ADA, date: '2026-08-01', amount: -100, category: 'Dining' }),
      txn({ user_id: BO, date: '2026-08-02', amount: -900, category: 'Dining' }),
    ];
    seed({ as: ADA, accounts: [account()], transactions: shared });
    expect(factsOf('How much did I spend on Dining this month?', 'spend-category').total).toBe(100);

    seed({ as: BO, accounts: [account({ user_id: BO })], transactions: shared });
    expect(factsOf('How much did I spend on Dining this month?', 'spend-category').total).toBe(900);
  });
});

describe('households', () => {
  const shared = (o: Partial<Transaction>): Transaction =>
    txn({ household_ids: [HH], ...o } as Partial<Transaction>);

  it('a personal answer counts the user’s own rows, shared or not', () => {
    seed({
      as: ADA, scope: 'personal', households: [household()], members: COUPLE,
      accounts: [account()],
      transactions: [
        shared({ user_id: ADA, date: '2026-08-01', amount: -100, category: 'Dining' }),
        shared({ user_id: BO, date: '2026-08-02', amount: -300, category: 'Dining' }),
      ],
    });
    const facts = factsOf('How much did I spend on Dining this month?', 'spend-category');
    expect(facts.total).toBe(100);   // Bo's shared row is visible, not Ada's spend
  });

  it('a household answer counts what every member shared, once each', () => {
    seed({
      as: ADA, scope: 'household', households: [household()], members: COUPLE,
      accounts: [
        account({ id: 'acc-1', household_ids: [HH] } as any),
        // Ada's own account, shared with nobody.
        account({ id: 'acc-private', name: 'Private savings' }),
      ],
      transactions: [
        shared({ user_id: ADA, date: '2026-08-01', amount: -100, category: 'Dining' }),
        shared({ user_id: BO, date: '2026-08-02', amount: -300, category: 'Dining' }),
        // On the private account, so it is in no household view — including
        // via the account cascade that carries a shared account's rows with it.
        txn({ user_id: ADA, account_id: 'acc-private', date: '2026-08-03', amount: -50, category: 'Dining' }),
      ],
    });
    const facts = factsOf('How much did I spend on Dining this month?', 'spend-category');
    expect(facts.total).toBe(400);   // 100 + 300; the private 50 stays out
  });

  it('a shared account carries its transactions into the household view', () => {
    // The documented cascade: an account without its transactions is a number
    // with no explanation, so sharing the account shares what moved through it.
    seed({
      as: ADA, scope: 'household', households: [household()], members: COUPLE,
      accounts: [account({ id: 'acc-1', household_ids: [HH] } as any)],
      transactions: [txn({ user_id: ADA, date: '2026-08-03', amount: -50, category: 'Dining' })],
    });
    expect(factsOf('How much did I spend on Dining this month?', 'spend-category').total).toBe(50);
  });

  it('names the household it answered for, and says so', () => {
    seed({
      as: ADA, scope: 'household', households: [household()], members: COUPLE,
      accounts: [account()], transactions: [shared({ amount: -100, date: '2026-08-01' })],
    });
    const answer = ask('How much did I spend this month?');
    expect(answer.scope).toBe('household');
    expect(answer.scopeLabel).toBe('Ada & Bo');
    expect(answer.gaps.some(g => g.kind === 'scope' && g.message.includes('Ada & Bo'))).toBe(true);
  });

  it('tells a household member when they are reading their personal view', () => {
    seed({
      as: ADA, scope: 'personal', households: [household()], members: COUPLE,
      accounts: [account()], transactions: [txn({ amount: -100, date: '2026-08-01' })],
    });
    const answer = ask('How much did I spend this month?');
    expect(answer.gaps.some(g => g.kind === 'scope' && /your own records only/i.test(g.message))).toBe(true);
  });

  it('says nothing about scope to somebody in no household', () => {
    seed({ accounts: [account()], transactions: [txn({ amount: -100, date: '2026-08-01' })] });
    expect(ask('How much did I spend this month?').gaps.some(g => g.kind === 'scope')).toBe(false);
  });

  it('a household view never reaches a member’s private goal', () => {
    seed({
      as: ADA, scope: 'household', households: [household()], members: COUPLE,
      accounts: [account()],
      goals: [
        goal({ id: 'g1', user_id: BO, name: 'Bo private', target_amount: 50_000, current_amount: 40_000 }),
        goal({ id: 'g2', user_id: BO, name: 'Our house', target_amount: 100_000, current_amount: 20_000, household_ids: [HH] } as any),
      ],
    });
    const facts = factsOf('Am I on track for my goals?', 'goal-progress');
    expect(facts.goals.map(g => g.name)).toEqual(['Our house']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Missing data and conflicting records
// ═════════════════════════════════════════════════════════════════════════════

describe('missing data is reported, never estimated', () => {
  it('an empty ledger answers every question without inventing a figure', () => {
    seed();
    for (const q of [
      'How much did I spend this month?',
      'Why is my forecast dropping?',
      'How much interest is my offset saving?',
      'What deductions do I have?',
      'Am I on track for my goal?',
      'How am I tracking against my budget?',
      'What is my net worth?',
      'What bills are due?',
    ]) {
      const answer = ask(q);
      expect(answer.gaps.length).toBeGreaterThan(0);
      for (const f of answer.figures) {
        if (typeof f.value === 'number') expect(f.value).toBe(0);
      }
    }
  });

  it('flags a question reaching back past the loaded history', () => {
    // The dangerous case: an empty window would otherwise read as "you spent $0".
    seed({
      accounts: [account()],
      transactions: [txn({ date: '2026-08-01', amount: -100, category: 'Dining' })],
    });
    const answer = ask('How much did I spend last year?');
    expect(answer.gaps.some(g => g.kind === 'partial-history')).toBe(true);
  });

  it('does not compare against a previous window it cannot see', () => {
    seed({
      accounts: [account()],
      transactions: [txn({ date: '2026-08-01', amount: -100, category: 'Dining' })],
    });
    const facts = factsOf('How much did I spend this month?', 'spend-total');
    // August is the whole history, so July is unknown — reported as null, not 0.
    expect(facts.previousTotal).toBeNull();
    expect(facts.delta).toBeNull();
  });

  it('compares against a previous window it CAN see', () => {
    seed({
      accounts: [account()],
      transactions: [
        txn({ date: '2026-07-05', amount: -200, category: 'Dining' }),
        txn({ date: '2026-08-01', amount: -100, category: 'Dining' }),
      ],
    });
    const facts = factsOf('How much did I spend this month?', 'spend-total');
    expect(facts.previousTotal).toBe(200);
    expect(facts.delta).toBe(-100);
  });

  it('compares a month against the SAME days of the month before, not a rolling window', () => {
    seed({
      accounts: [account()],
      transactions: [
        txn({ date: '2026-06-15', amount: -999, category: 'Dining' }),  // covers June
        txn({ date: '2026-07-03', amount: -200, category: 'Dining' }),  // in 1-24 July
        txn({ date: '2026-07-28', amount: -700, category: 'Dining' }),  // after the 24th
        txn({ date: '2026-08-01', amount: -100, category: 'Dining' }),
      ],
    });
    // Today is the 24th, so this month is 1-24 August and last month is 1-24 July.
    // A rolling 24-day window would have started on 8 July and missed the 3rd.
    expect(factsOf('How much did I spend this month?', 'spend-total').previousTotal).toBe(200);
  });

  it('compares against a PART of the previous window, and says where it starts', () => {
    seed({
      accounts: [account()],
      transactions: [
        txn({ date: '2026-07-05', amount: -200, category: 'Dining' }),
        txn({ date: '2026-08-01', amount: -100, category: 'Dining' }),
      ],
    });
    const answer = ask('How much did I spend this month?');
    // The history starts on 5 July, so 1-4 July is unknown — the comparison is
    // still worth making, and the answer says what it could not see.
    expect((answer.facts as any).previousTotal).toBe(200);
    expect(answer.gaps.some(g => g.kind === 'partial-history' && g.message.includes('2026-07-01'))).toBe(true);
  });
});

describe('conflicting records are surfaced, not reconciled', () => {
  it('a stored offset that disagrees with its linked account defers to the account', () => {
    seed({
      accounts: [account({ id: 'offset-acc', name: 'Offset', balance: 20_000 })],
      loans: [loan({ offset_balance: 80_000, offset_account_id: 'offset-acc' })],
    });
    const facts = factsOf('How much is my offset saving?', 'loan-offset');
    // One resolution rule, the same one the Loans page uses. Nothing is written
    // back to make the two agree — the question didn't ask to change anything.
    expect(facts.totalOffset).toBe(20_000);
    expect(useStore.getState().loans[0].offset_balance).toBe(80_000);
  });

  it('an unpaid bill in the past is reported separately, not folded into the total', () => {
    seed({
      accounts: [account()],
      bills: [
        bill({ id: 'b1', name: 'Water', amount: 90, due_date: '2026-08-01' }),
        bill({ id: 'b2', name: 'Electricity', amount: 180, due_date: '2026-09-05' }),
      ],
    });
    const answer = ask('What bills are due?');
    expect((answer.facts as any).total).toBe(180);
    expect(answer.gaps.some(g => g.kind === 'conflict')).toBe(true);
  });

  it('a goal linked to a deleted account is flagged rather than silently understated', () => {
    seed({
      accounts: [account()],
      goals: [goal({ linked_account_ids: ['gone-acc'], current_amount: 0 } as any)],
    });
    const answer = ask('Am I on track for my goal?');
    expect(answer.gaps.some(g => g.kind === 'conflict' || g.kind === 'incomplete-record')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Read-only
// ═════════════════════════════════════════════════════════════════════════════

describe('asking a question changes nothing', () => {
  const everyQuestion = [
    'How much did I spend eating out this year?',
    'Why is my forecast dropping?',
    'How much interest is my offset saving?',
    'What deductions do I have?',
    'Am I on track for my goal?',
    'How am I tracking against my budget?',
    'What is my net worth?',
    'What bills are due?',
    'How much have I earned this year?',
    'What changed in my spending?',
    'What is the capital of France?',
  ];

  function fullLedger() {
    seed({
      accounts: [account({ id: 'offset-acc', name: 'Offset', balance: 20_000 }), account({ id: 'acc-1', balance: 5_000 })],
      transactions: diningYear(),
      loans: [loan({ offset_account_id: 'offset-acc' })],
      goals: [goal({ target_date: '2028-01-01' })],
      budgets: [budget()],
      bills: [bill()],
      incomeEntries: [income()],
    });
  }

  it('queues no sync operation for any question', () => {
    fullLedger();
    mockedSync.mockClear();
    for (const q of everyQuestion) ask(q);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('leaves every record byte-identical', () => {
    fullLedger();
    const before = JSON.stringify({
      accounts: useStore.getState().accounts,
      transactions: useStore.getState().transactions,
      loans: useStore.getState().loans,
      goals: useStore.getState().goals,
      budgets: useStore.getState().budgets,
      bills: useStore.getState().bills,
      incomeEntries: useStore.getState().incomeEntries,
    });
    for (const q of everyQuestion) ask(q);
    const after = JSON.stringify({
      accounts: useStore.getState().accounts,
      transactions: useStore.getState().transactions,
      loans: useStore.getState().loans,
      goals: useStore.getState().goals,
      budgets: useStore.getState().budgets,
      bills: useStore.getState().bills,
      incomeEntries: useStore.getState().incomeEntries,
    });
    expect(after).toBe(before);
  });

  it('is idempotent — the same question twice gives the same answer', () => {
    fullLedger();
    for (const q of everyQuestion) {
      expect(JSON.stringify(ask(q).facts)).toBe(JSON.stringify(ask(q).facts));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Suggestions are drawn from real data
// ═════════════════════════════════════════════════════════════════════════════

describe('suggested questions', () => {
  it('never offers a question about something the user does not have', () => {
    seed({ accounts: [account()] });
    const suggestions = askDS.suggestions();
    expect(suggestions.some(s => /offset/i.test(s))).toBe(false);
    expect(suggestions.some(s => /on track for/i.test(s))).toBe(false);
  });

  it('offers the offset question to somebody with an offset', () => {
    seed({
      accounts: [account({ id: 'offset-acc', balance: 10_000 })],
      loans: [loan({ offset_account_id: 'offset-acc' })],
    });
    expect(askDS.suggestions().some(s => /offset/i.test(s))).toBe(true);
  });

  it('names the user’s own goal', () => {
    seed({ accounts: [account()], goals: [goal({ name: 'Japan trip' })] });
    expect(askDS.suggestions().some(s => s.includes('Japan trip'))).toBe(true);
  });

  it('every suggestion is a question Ask Ledger can actually answer', () => {
    seed({
      accounts: [account({ id: 'offset-acc', balance: 10_000 })],
      transactions: diningYear(),
      loans: [loan({ offset_account_id: 'offset-acc' })],
      goals: [goal()],
      budgets: [budget()],
    });
    for (const s of askDS.suggestions()) {
      expect(ask(s).intent).not.toBe('unknown');
    }
  });
});
