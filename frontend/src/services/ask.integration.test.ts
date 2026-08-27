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
  Household, HouseholdMember, RecurringSeries, InsurancePolicy, LedgerDocument,
  DocumentFact,
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
import { askDS, documentsDS } from './dataService';
import { documentsApi } from './api';
import type { AskFacts } from '../utils/askAnswer';
import { splitFigures } from '../utils/askAnswer';
import { sanitiseIntent } from '../utils/askIntent';

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

const policy = (o: Partial<InsurancePolicy> = {}): InsurancePolicy => ({
  id: 'pol-1', user_id: ADA, name: 'Car insurance', policy_type: 'car',
  insurer: 'NRMA', policy_number: 'C-1', premium_amount: 110,
  premium_frequency: 'monthly', start_date: '2026-03-03', renewal_date: '2027-03-03',
  excess: 800, coverage_amount: null, linked_type: null, linked_id: null,
  document_id: null, notes: null, active: true, household_id: null, ...o,
} as InsurancePolicy);

const document = (o: Partial<LedgerDocument> = {}): LedgerDocument => ({
  id: 'doc-1', user_id: ADA, name: 'NRMA renewal.pdf',
  original_filename: 'NRMA renewal.pdf', mime_type: 'application/pdf',
  size_bytes: 12_000, document_type: 'insurance', document_date: '2026-03-01',
  provider: 'NRMA', notes: null, linked_type: null, linked_id: null, ...o,
});

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
  recurringSeries?: RecurringSeries[];
  insurancePolicies?: InsurancePolicy[];
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
    recurringSeries: o.recurringSeries ?? [],
    // Everything the engines read — empty unless a test needs it.
    creditCards: [], subscriptions: [], investments: [], investmentSales: [],
    superFunds: [], properties: [], goalContributions: [], loanEvents: [],
    transactionSplits: [], customCategories: [],
    alertStates: [], pendingSyncQueue: [],
    recordShares: [], shareCodes: [],
    insurancePolicies: o.insurancePolicies ?? [],
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
  documentsDS.reset();
  vi.restoreAllMocks();
  seed();
});

/** Put documents — and what has been read out of them — in front of Ask, the
 *  way the page does before it answers. */
async function withVault(docs: LedgerDocument[], readings: DocumentFact[] = []) {
  vi.spyOn(documentsApi, 'getAll').mockResolvedValue(docs);
  vi.spyOn(documentsApi, 'facts').mockResolvedValue(readings);
  await documentsDS.refresh();
}

/** One stored reading, with the words on the page it came from. */
const fact = (o: Partial<DocumentFact> = {}): DocumentFact => ({
  id: `f-${o.field ?? 'renewal_date'}`, document_id: 'doc-1', user_id: ADA,
  field: 'renewal_date', value_kind: 'date',
  value_text: '2027-03-03', value_number: null, value_date: '2027-03-03',
  quote: 'Period of cover ends 3 March 2027', page: 1,
  confidence: 0.94, source: 'model', model: 'claude-sonnet-4-5',
  status: 'unconfirmed', ...o,
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
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.goals.every(g => g.name !== 'Ferrari fund')).toBe(true);
    expect(facts.unmatched?.requested).toBe('ferrari');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A GOAL THAT ISN'T THERE
//
//  The one-goal account is the case that matters. "How is my car goal going?"
//  answered with the house deposit is not a near miss — it is a confident,
//  well-formatted answer to a question nobody asked, and nothing on the screen
//  would tell the user that. Every assertion here is that Ledger says so
//  instead.
// ═════════════════════════════════════════════════════════════════════════════

describe('asking about a goal that does not exist', () => {
  const oneGoal = () => seed({
    accounts: [account()],
    goals: [goal({ id: 'g1', name: 'House deposit', target_amount: 100_000, current_amount: 25_000 })],
  });

  it('does NOT answer with the only goal on file', () => {
    oneGoal();
    const answer = ask('Am I on track for my car goal?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.goals).toEqual([]);
    expect(facts.focus).toBeNull();
    expect(answer.headline).not.toContain('House deposit —');
    expect(answer.headline).toMatch(/no goal called "car"/i);
  });

  it('states no figure at all about a goal it could not find', () => {
    oneGoal();
    const answer = ask('Am I on track for my car goal?');
    expect(answer.figures).toEqual([]);
    // 25,000 belongs to a goal the user did not ask about. It must not appear.
    expect(answer.headline).not.toContain('25,000');
  });

  it('lists the goals the user does have', () => {
    oneGoal();
    const answer = ask('How is my car fund going?');
    expect(answer.headline).toContain('House deposit');
    expect(answer.gaps.some(g => g.kind === 'unresolved')).toBe(true);
  });

  it('asks which one, rather than choosing, when several are similar', () => {
    seed({
      accounts: [account()],
      goals: [
        goal({ id: 'g1', name: 'Car fund', target_amount: 20_000, current_amount: 5_000 }),
        goal({ id: 'g2', name: 'Car upgrade', target_amount: 8_000, current_amount: 1_000 }),
      ],
    });
    const answer = ask('Am I on track for my car goal?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.goals).toEqual([]);
    expect(facts.unmatched?.suggestions).toEqual(['Car fund', 'Car upgrade']);
    expect(answer.headline).toMatch(/did you mean Car fund and Car upgrade\?/i);
  });

  it('forgives a typo in a goal that does exist', () => {
    oneGoal();
    const facts = factsOf('Am I on track for my house depost goal?', 'goal-progress');
    expect(facts.unmatched).toBeNull();
    expect(facts.goals.map(g => g.name)).toEqual(['House deposit']);
  });

  it('still answers about every goal when the question names none', () => {
    seed({
      accounts: [account()],
      goals: [
        goal({ id: 'g1', name: 'House deposit', target_amount: 100_000, current_amount: 25_000 }),
        goal({ id: 'g2', name: 'Japan trip', target_amount: 8_000, current_amount: 6_000 }),
      ],
    });
    const facts = factsOf('Am I on track for my goals?', 'goal-progress');
    expect(facts.unmatched).toBeNull();
    expect(facts.goals).toHaveLength(2);
  });

  it('says the account has no goals at all rather than naming one', () => {
    seed({ accounts: [account()] });
    const answer = ask('Am I on track for my car goal?');
    expect(answer.headline).toMatch(/no goal called "car"/i);
    expect(answer.headline).toMatch(/no savings goals/i);
  });

  it('cannot be talked into the wrong goal by the model either', () => {
    oneGoal();
    const vocab = askDS.vocabulary();
    const intent = sanitiseIntent(
      { intent: 'goal-progress', goal: 'Car fund', confidence: 0.95 },
      'Am I on track for my car goal?', vocab, TODAY,
    );
    expect(intent.goal).toBeNull();
    const answer = askDS.answerFor(intent, { asOf: TODAY });
    expect((answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>).goals).toEqual([]);
    // Reported in the user's words, not the model's rewording of them.
    expect(answer.headline).toMatch(/no goal called "car"/i);
    expect(answer.headline).not.toMatch(/25,000|on track/i);
  });

  it('a goal in the household view cannot be asked about from the personal one', () => {
    seed({
      as: ADA, scope: 'personal', households: [household()], members: COUPLE,
      accounts: [account()],
      goals: [
        goal({ id: 'g1', user_id: ADA, name: 'House deposit', target_amount: 100_000, current_amount: 25_000 }),
        goal({ id: 'g2', user_id: BO, name: 'Car fund', target_amount: 20_000, current_amount: 9_000, household_ids: [HH] } as any),
      ],
    });
    const answer = ask('Am I on track for my Car fund?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.unmatched?.requested).toBe('car');
    expect(facts.unmatched?.available).toEqual(['House deposit']);   // only what this view holds
    expect(facts.goals).toEqual([]);
  });

  it('answers the same question from the household view, where the goal exists', () => {
    seed({
      as: ADA, scope: 'household', households: [household()], members: COUPLE,
      accounts: [account()],
      goals: [
        goal({ id: 'g1', user_id: ADA, name: 'House deposit', target_amount: 100_000, current_amount: 25_000, household_ids: [HH] } as any),
        goal({ id: 'g2', user_id: BO, name: 'Car fund', target_amount: 20_000, current_amount: 9_000, household_ids: [HH] } as any),
      ],
    });
    const facts = factsOf('Am I on track for my Car fund?', 'goal-progress');
    expect(facts.unmatched).toBeNull();
    expect(facts.goals.map(g => g.name)).toEqual(['Car fund']);
  });

  it('never suggests another user’s goal as a "did you mean"', () => {
    seed({
      as: ADA, scope: 'personal', accounts: [account()],
      goals: [
        goal({ id: 'g1', user_id: ADA, name: 'House deposit' }),
        goal({ id: 'g2', user_id: BO, name: 'Car fund' }),
      ],
    });
    const answer = ask('Am I on track for my car goal?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'goal-progress' }>;
    expect(facts.unmatched?.suggestions).toEqual([]);
    expect(facts.unmatched?.available).toEqual(['House deposit']);
    expect(answer.headline).not.toContain('Car fund');
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

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 9.4 — the answer LEADS with the facts that decide the question
// ═════════════════════════════════════════════════════════════════════════════

describe('the decision facts behind "what if I pay $1,000 off my car loan?"', () => {
  const carLoan = () => loan({
    id: 'loan-car', name: 'Car loan', loan_type: 'car',
    original_amount: 30_000, current_balance: 18_000, interest_rate: 8,
    minimum_repayment: 400, repayment_frequency: 'monthly',
    next_due_date: '2026-09-01',
  });

  const repaymentSeries = (): RecurringSeries => ({
    id: 'series-car', user_id: ADA, merchant_normalized: 'car loan direct debit|monthly',
    name: 'Car Loan Direct Debit', kind: 'other', frequency: 'monthly',
    expected_amount: -400, next_expected_date: '2026-09-01',
    account_id: 'acc-1', status: 'active',
  } as RecurringSeries);

  it('reports the balance the payment leaves, and the account that pays the loan', () => {
    seed({
      accounts: [account({ balance: 10_000 })],
      loans: [carLoan()],
      recurringSeries: [repaymentSeries()],
    });
    const answer = ask('What happens if I pay $1,000 off my car loan right now?');
    expect(answer.facts.kind).toBe('what-if');

    const byKey = new Map(answer.figures.map(f => [f.key, f]));
    // The new balance: what is owed today, less the payment.
    expect(byKey.get('loan-balance')?.value).toBe(17_000);
    // The funding account: the one whose detected repayment series pays this
    // loan — named, with what is in it today.
    expect(byKey.get('funding')?.label).toContain('Everyday');
    expect(byKey.get('funding')?.value).toBe(10_000);
    // Both are LEAD facts, and the lead never exceeds four.
    const lead = splitFigures(answer.figures).lead;
    expect(lead.length).toBeLessThanOrEqual(4);
    expect(lead.some(f => f.key === 'loan-balance')).toBe(true);
    expect(lead.some(f => f.key === 'funding')).toBe(true);
  });

  it('falls back to total cash today when no series names the paying account', () => {
    seed({
      accounts: [account({ balance: 10_000 }), account({ id: 'acc-2', name: 'Savings', balance: 5_000 })],
      loans: [carLoan()],
    });
    const answer = ask('What happens if I pay $1,000 off my car loan right now?');
    const funding = answer.figures.find(f => f.key === 'funding');
    expect(funding?.label).toBe('Cash across your accounts today');
    expect(funding?.value).toBe(15_000);
  });

  it('leads the prose with the loan, not with the mechanics', () => {
    seed({ accounts: [account({ balance: 10_000 })], loans: [carLoan()] });
    const answer = ask('What happens if I pay $1,000 off my car loan right now?');
    // The first sentence is about the Car loan — interest and time saved —
    // because that is what the question was really asking.
    expect(answer.headline.startsWith('Car loan')).toBe(true);
    // Compact: at most four sentences.
    expect(answer.headline.split(/\. [A-Z$]/).length).toBeLessThanOrEqual(4);
  });
});

describe('follow-ups carry the previous question', () => {
  beforeEach(() => seed({ accounts: [account()], transactions: diningYear() }));

  it('"what about Groceries?" is the Dining question with the category swapped', () => {
    const first = askDS.interpret('How much did I spend on Dining this year?', { asOf: TODAY });
    const revised = askDS.interpret('What about Groceries?', { asOf: TODAY, previousIntent: first });
    expect(revised.name).toBe('spend-category');
    expect(revised.source).toBe('follow-up');
    const answer = askDS.answerFor(revised, { asOf: TODAY });
    expect(answer.facts.kind).toBe('spend-category');
    expect((answer.facts as Extract<AskFacts, { kind: 'spend-category' }>).category).toBe('Groceries');
    expect((answer.facts as Extract<AskFacts, { kind: 'spend-category' }>).total).toBe(240);
    expect(answer.period?.from).toBe('2026-01-01');
  });

  it('"and last month?" swaps the period and keeps the category', () => {
    const first = askDS.interpret('How much did I spend on Dining this year?', { asOf: TODAY });
    const revised = askDS.interpret('and last month?', { asOf: TODAY, previousIntent: first });
    expect(revised.name).toBe('spend-category');
    expect(revised.category).toBe('Dining');
    expect(revised.period?.from).toBe('2026-07-01');
  });

  it('a question the matcher understands on its own is never treated as a follow-up', () => {
    const first = askDS.interpret('How much did I spend on Dining this year?', { asOf: TODAY });
    const next = askDS.interpret('What is my net worth?', { asOf: TODAY, previousIntent: first });
    expect(next.name).toBe('net-worth');
    expect(next.source).toBe('rules');
  });
});

describe('every answer leads with at most four figures', () => {
  it('across the whole question set', () => {
    seed({
      accounts: [account()],
      transactions: diningYear(),
      loans: [loan({ offset_balance: 20_000 })],
      goals: [goal({ target_date: '2027-06-30' } as any)],
      budgets: [budget()],
      bills: [bill()],
      incomeEntries: [income()],
    });
    const questions = [
      'How much did I spend this year?',
      'How much did I spend on Dining this year?',
      'Why is my forecast dropping?',
      'How am I tracking against my budget?',
      'Am I on track for my goals?',
      'How much interest is my offset saving?',
      'When will I be debt free?',
      'What deductions do I have?',
      'What is my tax position?',
      'How much did I earn this year?',
      'What is my net worth?',
      'What bills are due soon?',
      'What changed in my spending recently?',
    ];
    for (const q of questions) {
      const answer = ask(q);
      expect(splitFigures(answer.figures).lead.length, q).toBeLessThanOrEqual(4);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Insurance — answered from policies and the vault, never from the bill list
// ═════════════════════════════════════════════════════════════════════════════

describe('"What insurance do I have?"', () => {
  it('prices cover from the policies, not from whatever bill is next', async () => {
    seed({
      accounts: [account()],
      bills: [bill({ name: 'Electricity', amount: 180, due_date: '2026-08-26' })],
      insurancePolicies: [policy()],
    });
    await withVault([]);
    const answer = ask('How much is my insurance costing me?');
    expect(answer.intent).toBe('insurance-cover');
    const facts = answer.facts as Extract<AskFacts, { kind: 'insurance-cover' }>;
    expect(facts.policies).toHaveLength(1);
    expect(facts.totalAnnual).toBe(1320);          // $110 a month, annualised
    expect(facts.totalMonthly).toBe(110);
    // Nothing about the electricity bill reached the answer.
    expect(answer.sources.some(src => src.kind === 'bill')).toBe(false);
    expect(answer.sources.some(src => src.kind === 'insurance')).toBe(true);
    expect(answer.headline).not.toMatch(/Electricity/);
  });

  it('leads with at most four figures and links to the Insurance page', async () => {
    seed({
      accounts: [account()],
      insurancePolicies: [
        policy(),
        policy({ id: 'pol-2', name: 'Home & contents', policy_type: 'home', premium_amount: 1_800, premium_frequency: 'annually', renewal_date: '2026-11-01' }),
        policy({ id: 'pol-3', name: 'Life cover', policy_type: 'life', premium_amount: 60, premium_frequency: 'monthly', renewal_date: null }),
      ],
    });
    await withVault([]);
    const answer = ask('What insurance do I have?');
    expect(splitFigures(answer.figures).lead.length).toBeLessThanOrEqual(4);
    expect(answer.sources[0].to).toBe('/insurance');
  });

  it('reports an uploaded document as a document, and invents no policy from it', async () => {
    seed({ accounts: [account()], insurancePolicies: [] });
    await withVault([document()]);
    const answer = ask('What insurance do I have?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'insurance-cover' }>;
    expect(facts.documentsOnly).toBe(true);
    expect(facts.policies).toEqual([]);
    expect(facts.documents[0]).toMatchObject({ name: 'NRMA renewal.pdf', provider: 'NRMA' });
    expect(answer.figures).toEqual([]);            // no cover, so no figures about cover
    expect(answer.headline).toMatch(/no insurance policies recorded/i);
    expect(answer.headline).toMatch(/have Ledger read/i);
    expect(answer.sources.some(src => src.kind === 'document')).toBe(true);
  });

  it('says so plainly when there is neither a policy nor paperwork', async () => {
    seed({ accounts: [account()] });
    await withVault([]);
    const answer = ask('What insurance do I have?');
    expect(answer.gaps.some(g => g.kind === 'no-data')).toBe(true);
    expect(answer.headline).toMatch(/no insurance policies/i);
  });

  it('reports a policy it cannot place rather than pricing the one that exists', async () => {
    seed({ accounts: [account()], insurancePolicies: [policy()] });
    await withVault([]);
    const answer = ask('How much is my boat insurance?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'insurance-cover' }>;
    expect(facts.unmatched?.requested).toBe('boat insurance');
    expect(facts.policies).toEqual([]);
    expect(answer.figures).toEqual([]);
    expect(answer.headline).toMatch(/no policy called "boat insurance"/i);
    expect(answer.headline).not.toMatch(/1,320/);
  });

  it('flags cover that has passed its renewal date instead of counting it as sound', async () => {
    seed({
      accounts: [account()],
      insurancePolicies: [policy({ renewal_date: '2026-06-01' })],
    });
    await withVault([]);
    const answer = ask('What insurance do I have?');
    expect(answer.gaps.some(g => g.kind === 'conflict' && /renewal date/i.test(g.message))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A question Ledger cannot answer is not answered as one it can
// ═════════════════════════════════════════════════════════════════════════════

describe('an unrecognised question', () => {
  beforeEach(() => seed({ accounts: [account()], transactions: diningYear(), loans: [loan()] }));

  it('comes back unknown, with no figures and no sources', () => {
    const answer = ask('How much should I spend on a wedding?');
    expect(answer.intent).toBe('unknown');
    expect(answer.figures).toEqual([]);
    expect(answer.sources).toEqual([]);
    expect(answer.gaps.some(g => g.kind === 'unsupported')).toBe(true);
  });

  it('says what it cannot do when it recognises the topic', () => {
    const answer = ask('Should I buy Telstra shares?');
    expect(answer.intent).toBe('unknown');
    expect(answer.headline).toMatch(/cannot advise/i);
  });

  it('does not report every loan when the loan named is not there', () => {
    const answer = ask('When will my boat loan be paid off?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'loan-payoff' }>;
    expect(facts.unmatched?.requested).toBe('boat loan');
    expect(facts.loans).toEqual([]);
    expect(answer.figures).toEqual([]);
    expect(answer.headline).toMatch(/no loan called "boat loan"/i);
    expect(answer.headline).toMatch(/Home mortgage/);   // what they DO have
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 8.3 — answering out of the documents themselves
// ═════════════════════════════════════════════════════════════════════════════

describe('what a document says', () => {
  const policyDoc = document();
  const readings = [
    fact(),
    fact({
      id: 'f-premium', field: 'premium_amount', value_kind: 'money',
      value_text: '1240.50', value_number: 1240.5, value_date: null,
      quote: 'Total premium $1,240.50', confidence: 0.91,
    }),
    fact({
      id: 'f-excess', field: 'excess', value_kind: 'money',
      value_text: '750', value_number: 750, value_date: null,
      quote: 'Excess payable per claim: $750', page: 2, confidence: 0.88,
    }),
  ];

  it('answers an insurance question out of the paperwork when there is no policy', async () => {
    seed({ accounts: [account()], insurancePolicies: [] });
    await withVault([policyDoc], readings);

    const answer = ask('What insurance do I have?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'insurance-cover' }>;

    expect(facts.policies).toEqual([]);
    expect(facts.documentFacts[0].facts.map(f => f.field))
      .toEqual(['excess', 'premium_amount', 'renewal_date']);

    // Stated, with the words behind each figure — and no annual total, which
    // would be arithmetic on a number nobody has checked.
    expect(answer.headline).toMatch(/renews 3 March 2027/);
    expect(answer.headline).toMatch(/document's own words, not a policy/i);
    const renewal = answer.figures.find(f => f.key === 'read:renewal_date');
    expect(renewal?.note).toContain('Period of cover ends 3 March 2027');
    expect(answer.figures.some(f => f.key === 'annual')).toBe(false);
    expect(answer.sources.some(src => src.kind === 'document')).toBe(true);
  });

  it('states nothing it is unsure of, and asks for it instead', async () => {
    seed({ accounts: [account()], insurancePolicies: [] });
    await withVault([policyDoc], [
      fact({ confidence: 0.4 }),
      fact({
        id: 'f-excess', field: 'excess', value_kind: 'money',
        value_text: '750', value_number: 750, value_date: null,
        quote: 'Excess payable per claim: $750', confidence: 0.4,
      }),
    ]);

    const answer = ask('What insurance do I have?');
    expect(answer.figures).toEqual([]);
    expect(answer.headline).not.toMatch(/2027|750/);
    expect(answer.gaps.some(g => /not sure it read/i.test(g.message))).toBe(true);
  });

  it('answers from a shaky reading once the user has confirmed it', async () => {
    seed({ accounts: [account()], insurancePolicies: [] });
    await withVault([policyDoc], [fact({ confidence: 0.4, status: 'confirmed', source: 'user' })]);

    const answer = ask('What insurance do I have?');
    expect(answer.headline).toMatch(/renews 3 March 2027/);
  });

  it('never answers from a reading the user rejected', async () => {
    seed({ accounts: [account()], insurancePolicies: [] });
    await withVault([policyDoc], [fact({ status: 'rejected' })]);

    const answer = ask('What insurance do I have?');
    expect(answer.headline).not.toMatch(/2027/);
    expect(answer.headline).toMatch(/have Ledger read/i);
  });

  it('quotes the document when asked what the document says', async () => {
    seed({ accounts: [account()] });
    await withVault([policyDoc], readings);

    const answer = ask('What does my NRMA renewal say?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'document-facts' }>;

    expect(answer.facts.kind).toBe('document-facts');
    expect(facts.document?.name).toBe('NRMA renewal.pdf');
    expect(facts.facts.map(f => f.field)).toEqual(['excess', 'premium_amount', 'renewal_date']);
    expect(answer.headline).toMatch(/NRMA renewal\.pdf says/);
    // The provenance travels with every figure, or the figure does not go up.
    for (const figure of answer.figures) expect(figure.note).toMatch(/"/);
    expect(answer.sources[0]).toMatchObject({ kind: 'document', to: '/documents' });
  });

  it('says a document has not been read rather than describing what it might say', async () => {
    seed({ accounts: [account()] });
    await withVault([policyDoc], []);

    const answer = ask('What does my NRMA renewal say?');
    expect(answer.figures).toEqual([]);
    expect(answer.headline).toMatch(/has not read NRMA renewal\.pdf yet/i);
    expect(answer.gaps.some(g => /Read this document/.test(g.message))).toBe(true);
  });

  // ── A document that is only SHARED with the asker ──────────────────────────
  //
  // The owner's unconfirmed readings are between the owner and their own
  // paperwork. A viewer's Ask answers from CONFIRMED facts alone — and never
  // tells the viewer to read a document, because reading is not theirs to ask.

  const BO = 'user-bo';
  const sharedDoc = document({ id: 'doc-bo', user_id: BO, name: 'Bo home policy.pdf' });

  it('answers a viewer from the facts the owner has confirmed', async () => {
    seed({ accounts: [account()] });
    await withVault([sharedDoc], [
      fact({ id: 'f-shared', document_id: 'doc-bo', user_id: BO, status: 'confirmed' }),
    ]);

    const answer = ask('What does Bo home policy say?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'document-facts' }>;
    expect(facts.document?.owned).toBe(false);
    expect(facts.facts.map(f => f.field)).toEqual(['renewal_date']);
    expect(answer.headline).toMatch(/Bo home policy\.pdf says/);
  });

  it('never shows a viewer a reading the owner has not confirmed — even if one leaks through', async () => {
    seed({ accounts: [account()] });
    // The server withholds these; the client repeats the rule in case an old
    // backend does not. High confidence changes nothing: usable-to-the-owner
    // and confirmed-for-others are different bars.
    await withVault([sharedDoc], [
      fact({ id: 'f-leak', document_id: 'doc-bo', user_id: BO, status: 'unconfirmed', confidence: 0.99 }),
    ]);

    const answer = ask('What does Bo home policy say?');
    expect(answer.figures).toEqual([]);
    expect(answer.headline).toMatch(/confirmed by its owner/i);
    // And the viewer is never told to go read someone else's paperwork.
    expect(answer.headline).not.toMatch(/Read this document/);
    expect(answer.gaps.some(g => /only its owner/i.test(g.message))).toBe(true);
    expect(answer.gaps.some(g => /Read this document/.test(g.message))).toBe(false);
  });

  it('keeps shared documents off the "unread — go read one" list', async () => {
    seed({ accounts: [account()] });
    await withVault([policyDoc, sharedDoc], []);

    const answer = ask('What do my documents say?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'document-facts' }>;
    // Ada's own unread policy is an invitation; Bo's is not hers to read.
    expect(facts.unread.map(d => d.id)).toEqual(['doc-1']);
    expect(facts.total).toBe(2);
  });

  it('reports a document it cannot place instead of reading the other one', async () => {
    seed({ accounts: [account()] });
    await withVault([policyDoc, document({ id: 'doc-2', name: 'CommBank statement.pdf', document_type: 'statement' })], readings);

    const answer = ask('What does my AAMI policy say?');
    const facts = answer.facts as Extract<AskFacts, { kind: 'document-facts' }>;
    expect(facts.unmatched?.requested).toBe('aami policy');
    expect(facts.facts).toEqual([]);
    expect(answer.figures).toEqual([]);
    expect(answer.headline).toMatch(/no document called "aami policy"/i);
    // Not one word about the document that WAS read.
    expect(answer.headline).not.toMatch(/2027|1,240/);
  });

  it('keeps a document question away from the bill list', async () => {
    seed({
      accounts: [account()],
      bills: [bill({ name: 'Electricity', amount: 240, due_date: '2026-08-30' })],
      insurancePolicies: [],
    });
    await withVault([policyDoc], readings);

    const answer = ask('What does my NRMA renewal say?');
    expect(answer.sources.some(src => src.kind === 'bill')).toBe(false);
    expect(answer.headline).not.toMatch(/Electricity/);
  });
});
