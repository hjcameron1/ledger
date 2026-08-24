/**
 * Phase 9.2/9.3 — what-if scenarios, end to end through the store.
 *
 * The pure layer is tested on its own (utils/scenario.test.ts). These are the
 * things it cannot prove without the real data service wired up, and they are
 * the ones that matter for a feature whose whole promise is "this changes
 * nothing":
 *
 *   • running a scenario WRITES NOTHING — no store mutation, no queued sync,
 *     not even on the loan whose repayment is being tested;
 *   • the BEFORE column is the real screen — the same forecast, loan report,
 *     budget report and goal report the user sees when no scenario is running;
 *   • each kind of change reaches the engine it belongs to, and only that one:
 *     an offset moves interest and not cash, a purchase moves cash and not the
 *     loan, a contribution moves a goal and not the balance;
 *   • several changes in one scenario compose;
 *   • applying is separate, explicit, per-change, and refuses what it cannot
 *     honestly write.
 *
 * Sync is mocked, which is how "writes nothing" is proved: if running a
 * scenario had touched a record, a sync op would have been queued.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  BankAccount, Transaction, Loan, Goal, Budget, IncomeEntry, Subscription,
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
import { askDS, scenarioDS, forecastDS, loanReportDS, goalReportDS, budgetReportDS } from './dataService';
import { emptyChange, type Scenario, type ScenarioChange } from '../utils/scenario';
import { splitFigures } from '../utils/askAnswer';

const ADA = 'user-ada';
const BO = 'user-bo';
const HH = 'hh-1';
const TODAY = '2026-08-24';
const MONTH = '2026-08';

const mockedSync = vi.mocked(syncWithRetry);

// ── Fixtures ────────────────────────────────────────────────────────────────

const account = (o: Partial<BankAccount> = {}): BankAccount => ({
  id: 'acc-1', user_id: ADA, name: 'Everyday', institution: 'CBA',
  account_type: 'transaction', balance: 20_000, currency: 'AUD', is_manual: true,
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
  original_amount: 600_000, current_balance: 400_000, interest_rate: 6,
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
  incomeEntries?: IncomeEntry[];
  subscriptions?: Subscription[];
}

function seed(o: Seed = {}) {
  useStore.setState({
    user: { id: o.as ?? ADA, email: 'ada@example.com', currency_preference: 'AUD' } as any,
    households: o.households ?? [],
    householdMembers: o.members ?? [],
    financeScope: o.scope ?? 'personal',
    activeHouseholdId: o.activeHouseholdId ?? (o.scope === 'household' ? HH : null),
    accounts: o.accounts ?? [account()],
    transactions: o.transactions ?? [],
    loans: o.loans ?? [],
    goals: o.goals ?? [],
    budgets: o.budgets ?? [],
    incomeEntries: o.incomeEntries ?? [],
    subscriptions: o.subscriptions ?? [],
    bills: [],
    creditCards: [], investments: [], investmentSales: [],
    superFunds: [], properties: [], goalContributions: [], loanEvents: [],
    recurringSeries: [], transactionSplits: [], customCategories: [],
    alertStates: [], netWorthHistory: [], pendingSyncQueue: [],
    recordShares: [], shareCodes: [], insurancePolicies: [],
    insurancePremiumHistory: [], merchants: [], merchantAliases: [],
    transactionRules: [], pendingPayments: [], notifications: [],
  } as any);
}

let changeSeq = 0;
/** One change, filled in over its blank so a test only states what it means. */
function change<K extends ScenarioChange['kind']>(
  kind: K,
  o: Partial<Extract<ScenarioChange, { kind: K }>> = {},
): ScenarioChange {
  const blank = emptyChange(kind, `c${++changeSeq}`, TODAY);
  return { ...blank, ...o } as ScenarioChange;
}

function scenarioOf(...changes: ScenarioChange[]): Scenario {
  return { id: 'sc-1', name: 'What if', changes };
}

const run = (...changes: ScenarioChange[]) =>
  scenarioDS.run(scenarioOf(...changes), { asOf: TODAY, month: MONTH });

/** The 90-day projected total-cash balance. */
const balance90 = (c: ReturnType<typeof run>, side: 'before' | 'after') =>
  c.cash.find(l => l.days === 90)![side].projectedBalance;

beforeEach(() => {
  mockedSync.mockClear();
  txSeq = 0;
  changeSeq = 0;
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Nothing is written
// ═════════════════════════════════════════════════════════════════════════════
describe('a scenario changes nothing', () => {
  beforeEach(() => {
    seed({
      loans: [loan({ offset_balance: 10_000 })],
      goals: [goal({ target_date: '2027-12-01' })],
      budgets: [budget()],
      incomeEntries: [income()],
    });
  });

  it('queues no sync op, however much it moves', () => {
    run(
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }),
      change('offset', { loanId: 'loan-1', delta: 20_000 }),
      change('savings-contribution', { goalId: 'goal-1', monthlyAmount: 800 }),
      change('one-off', { name: 'Car', amount: 9_000, date: '2026-11-01' }),
    );
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('leaves every record exactly as it was', () => {
    const before = JSON.stringify({
      loans: useStore.getState().loans,
      goals: useStore.getState().goals,
      budgets: useStore.getState().budgets,
      accounts: useStore.getState().accounts,
      incomeEntries: useStore.getState().incomeEntries,
    });
    run(
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }),
      change('offset', { loanId: 'loan-1', delta: 20_000 }),
      change('income', { incomeId: 'inc-1', mode: 'percent', value: 25 }),
    );
    expect(JSON.stringify({
      loans: useStore.getState().loans,
      goals: useStore.getState().goals,
      budgets: useStore.getState().budgets,
      accounts: useStore.getState().accounts,
      incomeEntries: useStore.getState().incomeEntries,
    })).toBe(before);
  });

  it('can be run twice and say the same thing', () => {
    const a = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    changeSeq = 0;
    const b = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    expect(b.loans[0].interestSaved).toBe(a.loans[0].interestSaved);
    expect(balance90(b, 'after')).toBe(balance90(a, 'after'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The before column is the real screen
// ═════════════════════════════════════════════════════════════════════════════
describe('the before column is what the user already sees', () => {
  beforeEach(() => {
    seed({
      loans: [loan()],
      goals: [goal({ target_date: '2027-12-01' })],
      budgets: [budget()],
      incomeEntries: [income()],
      transactions: [txn({ amount: -120 }), txn({ amount: -90, date: '2026-08-10' })],
    });
  });

  it('matches the Forecast page, horizon for horizon', () => {
    const c = run();
    const real = forecastDS.build({ asOf: TODAY, horizons: [30, 60, 90] });
    expect(c.cash.map(l => l.before.projectedBalance))
      .toEqual(real.horizons.map(h => h.projectedBalance));
  });

  it('matches the Loans page', () => {
    const c = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    const real = loanReportDS.build({ today: TODAY }).rows[0];
    expect(c.loans[0].before.payoffDate).toBe(real.payoffDate);
    expect(c.loans[0].before.totalInterest).toBe(real.projection.totalInterest);
    // And the real report is still the real one afterwards — projecting a
    // scenario must not have left the loan changed behind it.
    expect(loanReportDS.build({ today: TODAY }).rows[0].payoffDate).toBe(real.payoffDate);
  });

  it('an empty scenario moves nothing at all', () => {
    const c = run();
    expect(c.unchanged).toBe(true);
    expect(c.loans).toEqual([]);
    expect(c.budgets).toEqual([]);
    expect(c.goals).toEqual([]);
    expect(c.monthlyCashChange).toBe(0);
  });

  it('leaves out a change the user has unticked', () => {
    const c = run(change('one-off', { name: 'Car', amount: 40_000, date: '2026-09-15', enabled: false }));
    expect(c.unchanged).toBe(true);
    expect(c.resolved).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Income
// ═════════════════════════════════════════════════════════════════════════════
describe('a change in pay', () => {
  beforeEach(() => seed({ incomeEntries: [income()] }));

  it('raises the projected balance by the rise, month after month', () => {
    const c = run(change('income', { incomeId: 'inc-1', mode: 'percent', value: 10 }));
    expect(c.monthlyCashChange).toBe(800);
    // Two of the three monthly occurrences land inside the 90-day window.
    expect(balance90(c, 'after') - balance90(c, 'before')).toBeCloseTo(1_600, 0);
  });

  it('a pay cut lowers it', () => {
    const c = run(change('income', { incomeId: 'inc-1', mode: 'percent', value: -25 }));
    expect(c.monthlyCashChange).toBe(-2_000);
    expect(balance90(c, 'after')).toBeLessThan(balance90(c, 'before'));
  });

  it('reports a percentage it has no income to apply to, rather than guessing', () => {
    seed();
    const c = run(change('income', { incomeId: null, mode: 'percent', value: 10 }));
    expect(c.unchanged).toBe(true);
    expect(c.notes.some(n => n.kind === 'gap')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Spending and new commitments
// ═════════════════════════════════════════════════════════════════════════════
describe('spending more or less', () => {
  it('a new recurring expense pushes its budget toward the cap and takes cash with it', () => {
    seed({
      budgets: [budget({ category: 'Health', limit_amount: 50 })],
      transactions: [txn({ category: 'Health', amount: -20, date: '2026-08-02' })],
    });
    const c = run(change('recurring-expense', {
      name: 'Gym', amount: 200, frequency: 'monthly', category: 'Health', startDate: '2026-08-28',
    }));
    const line = c.budgets.find(b => b.category === 'Health');
    expect(line).toBeDefined();
    expect(line!.projectedChange).toBeCloseTo(200, 0);
    expect(line!.newlyOver).toBe(true);
    expect(balance90(c, 'after')).toBeLessThan(balance90(c, 'before'));
    expect(c.monthlyCashChange).toBe(-200);
  });

  it('spending less leaves more cash and eases the budget', () => {
    seed({
      budgets: [budget({ category: 'Dining', limit_amount: 300 })],
      transactions: Array.from({ length: 12 }, (_, i) => txn({
        category: 'Dining', amount: -60, date: `2026-0${i < 4 ? 6 : i < 8 ? 7 : 8}-${String(i + 3).padStart(2, '0')}`,
      })),
    });
    const c = run(change('spending', { category: 'Dining', mode: 'amount', value: -150 }));
    expect(c.monthlyCashChange).toBe(150);
    expect(balance90(c, 'after')).toBeGreaterThan(balance90(c, 'before'));
    const line = c.budgets.find(b => b.category === 'Dining');
    expect(line!.projectedChange).toBeLessThan(0);
  });

  it('will not turn a percentage into dollars for a category it has never seen spend in', () => {
    seed({ budgets: [budget({ category: 'Travel' })] });
    const c = run(change('spending', { category: 'Travel', mode: 'percent', value: -20 }));
    expect(c.unchanged).toBe(true);
    expect(c.notes.some(n => n.kind === 'gap' && /Travel/.test(n.text))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One-off purchases
// ═════════════════════════════════════════════════════════════════════════════
describe('one big purchase', () => {
  beforeEach(() => seed({ accounts: [account({ balance: 30_000 })] }));

  it('comes out of the projected balance on the day it happens, and not before', () => {
    const c = run(change('one-off', { name: 'Car', amount: 9_000, date: '2026-10-15' }));
    const at30 = c.cash.find(l => l.days === 30)!;
    const at90 = c.cash.find(l => l.days === 90)!;
    expect(at30.balanceChange).toBe(0);
    expect(at90.balanceChange).toBe(-9_000);
  });

  it('shows up in this month\'s budget when it lands this month', () => {
    seed({
      accounts: [account({ balance: 30_000 })],
      budgets: [budget({ category: 'Transport', limit_amount: 500 })],
    });
    const c = run(change('one-off', { name: 'Tyres', amount: 900, date: '2026-08-29', category: 'Transport' }));
    const line = c.budgets.find(b => b.category === 'Transport');
    expect(line!.projectedChange).toBe(900);
    expect(line!.newlyOver).toBe(true);
  });

  it('is a one-off, not a monthly cost', () => {
    const c = run(change('one-off', { name: 'Car', amount: 9_000, date: '2026-10-15' }));
    expect(c.monthlyCashChange).toBe(0);
    expect(c.oneOffTotal).toBe(9_000);
  });

  it('a windfall goes the other way', () => {
    const c = run(change('one-off', { name: 'Tax refund', amount: -4_000, date: '2026-09-10' }));
    expect(balance90(c, 'after') - balance90(c, 'before')).toBe(4_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Loans
// ═════════════════════════════════════════════════════════════════════════════
describe('paying more off a loan', () => {
  beforeEach(() => seed({ loans: [loan()] }));

  it('brings the payoff forward and saves interest', () => {
    const c = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    expect(c.loans).toHaveLength(1);
    expect(c.loans[0].monthsSaved).toBeGreaterThan(0);
    expect(c.loans[0].interestSaved).toBeGreaterThan(0);
    expect(c.loans[0].after.payoffDate! < c.loans[0].before.payoffDate!).toBe(true);
  });

  it('costs that money out of the cash projection too', () => {
    const c = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    expect(c.loans[0].outlayChange).toBe(500);
    // Three monthly repayments inside 90 days.
    expect(balance90(c, 'after') - balance90(c, 'before')).toBeCloseTo(-1_500, 0);
  });

  it('counts the loan once, not twice', () => {
    const c = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    const events = c.cash.find(l => l.days === 90)!;
    expect(events.after.outflow - events.before.outflow).toBeCloseTo(-1_500, 0);
  });
});

describe('putting more in the offset', () => {
  beforeEach(() => seed({ loans: [loan({ offset_balance: 10_000 })] }));

  it('cuts the interest without touching the cash projection', () => {
    const c = run(change('offset', { loanId: 'loan-1', delta: 40_000 }));
    expect(c.loans).toHaveLength(1);
    expect(c.loans[0].interestSaved).toBeGreaterThan(0);
    expect(c.loans[0].after.effectiveBalance).toBe(c.loans[0].before.effectiveBalance - 40_000);
    expect(c.cash.every(l => l.balanceChange === 0)).toBe(true);
    expect(c.notes.some(n => /still your money/i.test(n.text))).toBe(true);
  });

  it('says when the offset would be bigger than the debt', () => {
    const c = run(change('offset', { loanId: 'loan-1', delta: 900_000 }));
    expect(c.notes.some(n => n.kind === 'warning' && /saves nothing/i.test(n.text))).toBe(true);
  });

  it('works through the linked account when the offset tracks one', () => {
    seed({
      accounts: [account({ id: 'acc-off', name: 'Offset', balance: 10_000 }), account()],
      loans: [loan({ offset_account_id: 'acc-off' })],
    });
    const c = run(change('offset', { loanId: 'loan-1', delta: 30_000 }));
    // A typed figure would have been ignored on a linked loan — the interest
    // has to actually move, or the what-if would report a change that isn't one.
    expect(c.loans[0].after.effectiveBalance).toBe(c.loans[0].before.effectiveBalance - 30_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Goals
// ═════════════════════════════════════════════════════════════════════════════
describe('committing money to a goal', () => {
  beforeEach(() => seed({
    goals: [goal({ target_date: '2026-12-01', current_amount: 0 })],
    incomeEntries: [income()],
  }));

  it('brings the finish date forward without moving the balance', () => {
    const c = run(change('savings-contribution', { goalId: 'goal-1', monthlyAmount: 2_000 }));
    expect(c.goals).toHaveLength(1);
    expect(c.goals[0].after.allocatedPerMonth).toBe(2_000);
    expect(c.goals[0].daysEarlier).not.toBeNull();
    expect(c.cash.every(l => l.balanceChange === 0)).toBe(true);
  });

  it('says so when the goals are promised more than the forecast expects to spare', () => {
    const c = run(change('savings-contribution', { goalId: 'goal-1', monthlyAmount: 50_000 }));
    expect(c.notes.some(n => n.kind === 'warning' && /somewhere else/i.test(n.text))).toBe(true);
  });

  it('a scenario that frees up cash reaches the goals as well', () => {
    const c = run(change('income', { incomeId: 'inc-1', mode: 'percent', value: 50 }));
    const line = c.goals.find(g => g.id === 'goal-1');
    expect(line).toBeDefined();
    expect(line!.after.allocatedPerMonth).toBeGreaterThan(line!.before.allocatedPerMonth);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  More than one change at a time
// ═════════════════════════════════════════════════════════════════════════════
describe('several changes in one scenario', () => {
  beforeEach(() => seed({
    loans: [loan()],
    goals: [goal({ target_date: '2028-12-01', current_amount: 0 })],
    budgets: [budget()],
    incomeEntries: [income()],
  }));

  it('adds up, engine by engine', () => {
    const c = run(
      change('income', { incomeId: 'inc-1', mode: 'amount', value: 1_000 }),
      change('recurring-expense', { name: 'Gym', amount: 100, frequency: 'monthly', category: 'Health' }),
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 400 }),
      change('savings-contribution', { goalId: 'goal-1', monthlyAmount: 300 }),
    );
    expect(c.monthlyCashChange).toBe(500); // +1000 − 100 − 400
    expect(c.loans).toHaveLength(1);
    expect(c.goals).toHaveLength(1);
    expect(c.resolved).toHaveLength(4);
  });

  it('composes two changes to the same loan into one projection', () => {
    const one = run(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 500 }));
    changeSeq = 0;
    const two = run(
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 300 }),
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 200 }),
    );
    expect(two.loans[0].after.payoffDate).toBe(one.loans[0].after.payoffDate);
    expect(two.loans[0].outlayChange).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Scope
// ═════════════════════════════════════════════════════════════════════════════
describe('what a question can name', () => {
  it('only the user\'s own records, in a personal view', () => {
    seed({
      loans: [loan(), loan({ id: 'loan-bo', user_id: BO, name: "Bo's car" })],
      goals: [goal(), goal({ id: 'goal-bo', user_id: BO, name: "Bo's bike" })],
    });
    const v = askDS.vocabulary();
    expect(v.loans.map(l => l.id)).toEqual(['loan-1']);
    expect(v.goals.map(g => g.id)).toEqual(['goal-1']);
  });

  it('what the household was shown, in a household view', () => {
    seed({
      scope: 'household', households: [household()], members: COUPLE,
      loans: [loan(), loan({ id: 'loan-bo', user_id: BO, name: "Bo's car", household_ids: [HH] })],
      goals: [goal({ household_ids: [HH] })],
    });
    const v = askDS.vocabulary();
    expect(v.loans.map(l => l.id)).toContain('loan-bo');
  });

  it('says which offsets cannot simply be typed over', () => {
    seed({
      accounts: [account({ id: 'acc-off', name: 'Offset', balance: 5_000 }), account()],
      loans: [loan({ offset_account_id: 'acc-off' }), loan({ id: 'loan-2', name: 'Car', offset_balance: 0 })],
    });
    const base = scenarioDS.baselines({ asOf: TODAY });
    expect(base.loans.find(l => l.id === 'loan-1')!.offsetIsLinked).toBe(true);
    expect(base.loans.find(l => l.id === 'loan-2')!.offsetIsLinked).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Applying — the only thing here that writes
// ═════════════════════════════════════════════════════════════════════════════
describe('applying a scenario', () => {
  beforeEach(() => seed({
    loans: [loan({ offset_balance: 5_000, extra_repayment: 100 })],
    goals: [goal()],
    incomeEntries: [income()],
  }));

  it('writes only the changes the user named', () => {
    const s = scenarioOf(
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 400 }),
      change('one-off', { name: 'Tyres', amount: 900, date: '2026-09-29', category: 'Transport' }),
    );
    const result = scenarioDS.apply(s, [s.changes[0].id], { asOf: TODAY });
    expect(result.applied.map(a => a.changeId)).toEqual([s.changes[0].id]);
    expect(useStore.getState().loans[0].extra_repayment).toBe(500);
    expect(useStore.getState().bills).toHaveLength(0);
  });

  it('writes nothing at all when nothing is named', () => {
    const s = scenarioOf(change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 400 }));
    const result = scenarioDS.apply(s, [], { asOf: TODAY });
    expect(result.applied).toEqual([]);
    expect(mockedSync).not.toHaveBeenCalled();
    expect(useStore.getState().loans[0].extra_repayment).toBe(100);
  });

  it('creates a bill for a purchase and a subscription for a commitment', () => {
    const s = scenarioOf(
      change('one-off', { name: 'Tyres', amount: 900, date: '2026-09-29', category: 'Transport' }),
      change('recurring-expense', { name: 'Gym', amount: 60, frequency: 'monthly', category: 'Health', startDate: '2026-09-01' }),
    );
    scenarioDS.apply(s, s.changes.map(c => c.id), { asOf: TODAY });
    expect(useStore.getState().bills[0]).toMatchObject({ name: 'Tyres', amount: 900, due_date: '2026-09-29' });
    expect(useStore.getState().subscriptions[0]).toMatchObject({ name: 'Gym', amount: 60, frequency: 'monthly' });
    expect(mockedSync).toHaveBeenCalledWith('bill.create', expect.anything());
    expect(mockedSync).toHaveBeenCalledWith('subscription.create', expect.anything());
  });

  it('refuses to type a balance over an offset that tracks a real account', () => {
    seed({
      accounts: [account({ id: 'acc-off', name: 'Offset', balance: 5_000 }), account()],
      loans: [loan({ offset_account_id: 'acc-off' })],
    });
    const s = scenarioOf(change('offset', { loanId: 'loan-1', delta: 20_000 }));
    const result = scenarioDS.apply(s, [s.changes[0].id], { asOf: TODAY });
    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/actually move/i);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('has nothing to write for a decision to spend less, and says so', () => {
    const s = scenarioOf(change('spending', { category: 'Dining', mode: 'amount', value: -100 }));
    const result = scenarioDS.apply(s, [s.changes[0].id], { asOf: TODAY });
    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/decision, not a record/i);
  });

  it('scales a recurring income by the same ratio it was asked to change by', () => {
    const s = scenarioOf(change('income', { incomeId: 'inc-1', mode: 'percent', value: 10 }));
    scenarioDS.apply(s, [s.changes[0].id], { asOf: TODAY });
    expect(useStore.getState().incomeEntries[0].amount).toBe(8_800);
  });

  it('reports what applying would do before anything is applied', () => {
    const s = scenarioOf(
      change('extra-repayment', { loanId: 'loan-1', amountPerPeriod: 400 }),
      change('savings-contribution', { goalId: 'goal-1', monthlyAmount: 500 }),
    );
    const checks = scenarioDS.applicability(s, { asOf: TODAY });
    expect(checks.map(c => c.canApply)).toEqual([true, false]);
    expect(mockedSync).not.toHaveBeenCalled();
    expect(useStore.getState().loans[0].extra_repayment).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 9.3 — asking the same question in words
// ═════════════════════════════════════════════════════════════════════════════
//
// The scenario builder became a question box. What is being tested here is the
// whole path: a sentence → the change it describes → the engines run twice →
// an answer with both columns in it. Still nothing written.

describe('asking a what-if question', () => {
  beforeEach(() => seed({
    loans: [
      loan({ id: 'loan-1', name: 'Home mortgage' }),
      loan({
        id: 'loan-2', name: 'Car loan', loan_type: 'car', original_amount: 30_000,
        current_balance: 18_000, interest_rate: 8, minimum_repayment: 400,
        repayment_frequency: 'monthly', next_due_date: '2026-09-05',
      }),
    ],
    goals: [goal({ target_date: '2027-12-01' })],
    budgets: [budget()],
    incomeEntries: [income()],
  }));

  const ask = (q: string, previous?: any) => askDS.answer(q, { asOf: TODAY, previous });
  const whatIf = (q: string, previous?: any) => {
    const answer = ask(q, previous);
    expect(answer.facts.kind).toBe('what-if');
    return answer;
  };

  it('reads the question, runs the engines and answers with both columns', () => {
    const answer = whatIf('What happens if I pay $1,000 off my car loan right now?');
    const facts: any = answer.facts;
    expect(answer.intent).toBe('what-if');
    expect(facts.comparison.scenario.changes[0]).toMatchObject({ kind: 'lump-sum', loanId: 'loan-2', amount: 1_000 });
    const line = facts.comparison.loans.find((l: any) => l.id === 'loan-2');
    expect(line.after.effectiveBalance).toBeCloseTo(line.before.effectiveBalance - 1_000, 2);
    expect(line.interestSaved).toBeGreaterThan(0);
  });

  it('takes the money out of the cash projection as well as off the loan', () => {
    const facts: any = whatIf('What happens if I pay $1,000 off my car loan right now?').facts;
    const ninety = facts.comparison.cash.find((c: any) => c.days === 90);
    expect(ninety.balanceChange).toBeCloseTo(-1_000, 2);
    // Once, not every month.
    expect(facts.comparison.monthlyCashChange).toBe(0);
    expect(facts.comparison.oneOffTotal).toBe(1_000);
  });

  it('writes nothing by answering', () => {
    whatIf('What happens if I pay $1,000 off my car loan right now?');
    expect(mockedSync).not.toHaveBeenCalled();
    expect(useStore.getState().loans.find(l => l.id === 'loan-2')!.current_balance).toBe(18_000);
  });

  it('the before column is the real loan report', () => {
    const facts: any = whatIf('What happens if I pay $1,000 off my car loan?').facts;
    const real = loanReportDS.build({ today: TODAY }).rows.find(r => r.id === 'loan-2')!;
    const line = facts.comparison.loans.find((l: any) => l.id === 'loan-2');
    expect(line.before.payoffDate).toBe(real.payoffDate);
    expect(line.before.totalInterest).toBe(real.projection.totalInterest);
  });

  it('states the answer in a sentence, with the figures beside it', () => {
    const answer = whatIf('What happens if I pay $1,000 off my car loan right now?');
    expect(answer.headline).toMatch(/Car loan/);
    expect(answer.figures.some(f => f.emphasis)).toBe(true);
    expect(answer.sources.some(s => s.to === '/loans')).toBe(true);
  });

  it('says how it read the question', () => {
    const facts: any = whatIf('What happens if I pay $1,000 off my car loan right now?').facts;
    expect(facts.reading.join(' ')).toMatch(/paid off Car loan today/i);
  });

  it('"What about $2,000?" re-runs the same change with the new figure', () => {
    const first: any = whatIf('What happens if I pay $1,000 off my car loan right now?').facts;
    const second: any = whatIf('What about $2,000?', first.comparison.scenario).facts;
    expect(second.comparison.scenario.changes[0]).toMatchObject({ kind: 'lump-sum', loanId: 'loan-2', amount: 2_000 });
    const before = first.comparison.loans.find((l: any) => l.id === 'loan-2');
    const after = second.comparison.loans.find((l: any) => l.id === 'loan-2');
    expect(after.interestSaved).toBeGreaterThan(before.interestSaved);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('answers a pay rise from the income on file', () => {
    const facts: any = whatIf('What if I get a 10% pay rise?').facts;
    expect(facts.comparison.monthlyCashChange).toBe(800); // 10% of the $8,000 on file
  });

  it('answers a spending cut against the budget as well as the cash', () => {
    seed({
      budgets: [budget()],
      transactions: Array.from({ length: 8 }, (_, i) =>
        txn({ date: `2026-08-0${i + 1}`, amount: -60, category: 'Dining' })),
    });
    const facts: any = whatIf('What if I spend $100 a month less on dining?').facts;
    expect(facts.comparison.resolved[0].rateDelta).toEqual({ category: 'Dining', amount: -100 });
  });

  it('never models a loan the user does not have', () => {
    const answer = ask('What happens if I pay $1,000 off my boat loan?');
    const facts: any = answer.facts;
    expect(facts.comparison).toBeNull();
    expect(answer.gaps.some(g => /boat loan/i.test(g.message))).toBe(true);
    expect(answer.headline).not.toMatch(/Car loan|Home mortgage/);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('offers a hypothetical among the suggested questions', () => {
    expect(askDS.suggestions().some(q => /^What if I pay/.test(q))).toBe(true);
  });

  it('applies only what the user names, and only when asked', () => {
    const answer = whatIf('What happens if I pay $1,000 off my car loan right now?');
    const facts: any = answer.facts;
    expect(facts.applicability[0].canApply).toBe(true);
    expect(facts.applicability[0].description).toMatch(/17,000 owing/);
    expect(mockedSync).not.toHaveBeenCalled();

    const result = askDS.applyWhatIf(answer, [facts.comparison.scenario.changes[0].id]);
    expect(result.applied).toHaveLength(1);
    expect(useStore.getState().loans.find(l => l.id === 'loan-2')!.current_balance).toBe(17_000);
    expect(mockedSync).toHaveBeenCalledWith('loan.update', expect.anything());
  });

  it('applies nothing when no change is named', () => {
    const answer = whatIf('What happens if I pay $1,000 off my car loan right now?');
    expect(askDS.applyWhatIf(answer, []).applied).toEqual([]);
    expect(useStore.getState().loans.find(l => l.id === 'loan-2')!.current_balance).toBe(18_000);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('has nothing to write for a spending cut, and says why', () => {
    const answer = whatIf('What if I spend $100 a month less on dining?');
    const facts: any = answer.facts;
    expect(facts.applicability[0].canApply).toBe(false);
    expect(facts.applicability[0].description).toMatch(/decision, not a record/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A follow-up hypothetical is a COMPARISON
// ═════════════════════════════════════════════════════════════════════════════
//
// Somebody asking "what about $2,000?" has the $1,000 answer in front of them.
// What they want is the difference between the two — not the same shape of
// answer with different numbers in it, which they would have to diff by eye.

describe('"What about $2,000?" after "$1,000"', () => {
  beforeEach(() => seed({
    accounts: [account({ balance: 20_000 })],
    loans: [
      loan({
        id: 'loan-2', name: 'Car loan', loan_type: 'car', original_amount: 30_000,
        current_balance: 18_000, interest_rate: 8, minimum_repayment: 400,
        repayment_frequency: 'monthly', next_due_date: '2026-09-05',
      }),
    ],
  }));

  const ask = (q: string, previous?: any) => askDS.answer(q, { asOf: TODAY, previous });

  it('states what the bigger payment buys over the smaller one', () => {
    const first: any = ask('What happens if I pay $1,000 off my car loan right now?').facts;
    const answer = ask('What about $2,000?', first.comparison.scenario);
    const second: any = answer.facts;

    expect(second.versus).not.toBeNull();
    expect(second.versus.label).toMatch(/1,000/);
    expect(second.versus.subject).toBe('Car loan');

    // Both columns are the ENGINE's, and the extra is their difference.
    const before = first.comparison.loans.find((l: any) => l.id === 'loan-2');
    const after = second.comparison.loans.find((l: any) => l.id === 'loan-2');
    expect(second.versus.interestSavedBefore).toBeCloseTo(before.interestSaved, 2);
    expect(second.versus.interestSavedAfter).toBeCloseTo(after.interestSaved, 2);
    expect(second.versus.extraInterestSaved)
      .toBeCloseTo(after.interestSaved - before.interestSaved, 2);
    expect(second.versus.extraInterestSaved).toBeGreaterThan(0);
    expect(second.versus.extraCost).toBeCloseTo(1_000, 2);
  });

  it('says it in the sentence, and shows it as a figure', () => {
    const first: any = ask('What happens if I pay $1,000 off my car loan right now?').facts;
    const answer = ask('What about $2,000?', first.comparison.scenario);

    expect(answer.headline).toMatch(/Against \$1,000/);
    expect(answer.headline).toMatch(/more interest saved/);

    const extra = answer.figures.find(f => f.key === 'versus-interest');
    expect(extra).toBeTruthy();
    expect(extra!.label).toMatch(/1,000/);
    // The comparison is a LEAD fact — it is the answer to what was asked.
    expect(splitFigures(answer.figures).lead.some(f => f.key === 'versus-interest')).toBe(true);
    expect(splitFigures(answer.figures).lead.length).toBeLessThanOrEqual(4);
  });

  it('carries what the first question saved, behind the calculation', () => {
    const first: any = ask('What happens if I pay $1,000 off my car loan right now?').facts;
    const answer = ask('What about $2,000?', first.comparison.scenario);
    const detail = splitFigures(answer.figures).detail;
    expect(detail.some(f => f.key === 'versus-before')).toBe(true);
  });

  it('is an ordinary answer when nothing came before it', () => {
    const answer = ask('What happens if I pay $2,000 off my car loan right now?');
    expect((answer.facts as any).versus).toBeNull();
    expect(answer.headline).not.toMatch(/Against/);
  });

  it('writes nothing, either time', () => {
    const first: any = ask('What happens if I pay $1,000 off my car loan right now?').facts;
    ask('What about $2,000?', first.comparison.scenario);
    expect(mockedSync).not.toHaveBeenCalled();
    expect(useStore.getState().loans.find(l => l.id === 'loan-2')!.current_balance).toBe(18_000);
  });
});
