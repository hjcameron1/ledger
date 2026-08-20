/**
 * Phase 7.2 — direct sharing and multiple households, end to end through the
 * store.
 *
 * The engines are unit-tested on their own (utils/household.test.ts,
 * utils/sharing.test.ts). These are the things they cannot prove without the
 * real data service wired up:
 *
 *   • two people looking at ONE account see one account, one id and one balance
 *     — and only the owner's net worth contains it;
 *   • an account shared directly brings its transactions and nothing else, and
 *     none of that spending becomes the recipient's;
 *   • somebody in a couple AND a family gets two separate pictures, neither of
 *     which leaks into the other or into their own totals;
 *   • revoking and leaving both end access and delete nothing, for either party;
 *   • a row reachable two ways is still one row in every list and every sum;
 *   • goals, budgets, loans and properties behave exactly as accounts do;
 *   • a user with no sharing sees precisely what they saw before 7.2 shipped;
 *   • everything survives a cold start on another device.
 *
 * Sync and the API are mocked, so "the server was told" means "the right call,
 * with the right arguments, was made".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  BankAccount, CreditCard, Transaction, Loan, Property, Budget, Goal,
  Household, HouseholdMember, RecordShare, ShareCode,
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

// The sharing calls are NOT local-first — a grant is an agreement with somebody
// else, so its truth is the server's. Mocked here so the tests can assert what
// the server was asked to do.
vi.mock('./api', () => {
  const stub = () => vi.fn().mockResolvedValue({});
  return {
    API_BASE: 'http://test',
    accountsApi: {}, investmentsApi: {}, incomeApi: {}, overviewApi: {}, smsfApi: {},
    householdsApi: {
      getAll: vi.fn().mockResolvedValue({ households: [], members: [], invitations: [] }),
      create: stub(), update: stub(), remove: stub(),
      getMembers: stub(), setRole: stub(), removeMember: stub(), leave: stub(), transfer: stub(),
      invite: stub(), revokeInvite: stub(), acceptInvite: stub(), declineInvite: stub(),
      regenerateCode: vi.fn().mockResolvedValue({ household: null }),
      revokeCode: stub(),
      join: vi.fn().mockResolvedValue({ household: null }),
    },
    sharesApi: {
      getAll: vi.fn().mockResolvedValue({ shares: [], codes: [] }),
      createCode: vi.fn().mockResolvedValue({ code: { id: 'c-new', code: 'MINTED' } }),
      revokeCode: stub(),
      redeem: vi.fn().mockResolvedValue({ share: null, already: false }),
      end: vi.fn().mockResolvedValue({ success: true }),
      setPermission: stub(),
    },
  };
});

import { useStore } from '../store';
import { sharesApi } from './api';
import {
  accountsDS, creditCardsDS, transactionsDS, loansDS, propertiesDS,
  budgetsDS, goalsDS, sharingDS, sharesDS, householdsDS,
  sharingContext, currentScope, calculateNetWorth,
} from './dataService';

const ADA = 'user-ada';
const BO  = 'user-bo';
const CY  = 'user-cy';
const COUPLE = 'hh-couple';
const FAMILY = 'hh-family';

// ── Fixtures ────────────────────────────────────────────────────────────────

const account = (o: Partial<BankAccount> = {}): BankAccount => ({
  id: 'acc-1', user_id: ADA, name: 'Everyday', institution: 'CBA',
  account_type: 'transaction', balance: 0, currency: 'AUD', is_manual: true,
  household_id: null, ...o,
});

const card = (o: Partial<CreditCard> = {}): CreditCard => ({
  id: 'card-1', user_id: ADA, name: 'Amex', institution: 'Amex',
  balance_owing: 0, credit_limit: 10_000, currency: 'AUD', is_manual: true,
  household_id: null, ...o,
});

const txn = (o: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-1', user_id: ADA, account_id: 'acc-1', account_type: 'bank',
  date: '2026-08-01', merchant: 'Woolworths', amount: -100, currency: 'AUD',
  category: 'Groceries', is_duplicate_flagged: false, is_subscription: false,
  household_id: null, ...o,
} as Transaction);

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'loan-1', user_id: ADA, name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 600_000, current_balance: 500_000, interest_rate: 6,
  minimum_repayment: 3_000, repayment_frequency: 'monthly',
  next_due_date: '2026-09-01', include_in_net_worth: true,
  household_id: null, ...o,
} as Loan);

const property = (o: Partial<Property> = {}): Property => ({
  id: 'prop-1', user_id: ADA, name: 'Bondi apartment',
  address_unit: null, address_street: '34 Beach Rd', address_suburb: 'Bondi',
  address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
  property_type: 'home', held_by: 'personal',
  purchase_price: 800_000, current_value: 1_000_000, ownership_percent: 100,
  loan_id: null, include_in_net_worth: true, household_id: null, ...o,
} as Property);

const budget = (o: Partial<Budget> = {}): Budget => ({
  id: 'bud-1', user_id: ADA, scope: 'category', category: 'Groceries',
  limit_amount: 800, period: 'monthly', rollover_enabled: false, active: true,
  household_id: null, ...o,
});

const goal = (o: Partial<Goal> = {}): Goal => ({
  id: 'goal-1', user_id: ADA, name: 'Holiday', target_amount: 5_000,
  current_amount: 1_000, household_id: null, ...o,
});

const household = (id: string, name: string): Household =>
  ({ id, name, created_by: ADA, currency: 'AUD' });

const member = (
  householdId: string, userId: string, role: HouseholdMember['role'] = 'member',
): HouseholdMember =>
  ({ id: `m-${householdId}-${userId}`, household_id: householdId, user_id: userId, role, status: 'active' });

const grant = (o: Partial<RecordShare> = {}): RecordShare => ({
  id: 'g-1', record_type: 'account', record_id: 'acc-1',
  owner_user_id: ADA, shared_with_user_id: BO,
  permission: 'view', status: 'active',
  owner_name: 'Ada', shared_with_name: 'Bo', ...o,
});

const shareCode = (o: Partial<ShareCode> = {}): ShareCode => ({
  id: 'c-1', code: 'CODE-1', record_type: 'account', record_id: 'acc-1',
  owner_user_id: ADA, permission: 'view', max_uses: 1, uses: 0,
  status: 'active', expires_at: '2099-01-01T00:00:00.000Z', ...o,
});

interface Seed {
  as?: string;
  households?: Household[];
  members?: HouseholdMember[];
  shares?: RecordShare[];
  codes?: ShareCode[];
  scope?: 'personal' | 'household';
  activeHouseholdId?: string | null;
  accounts?: BankAccount[];
  creditCards?: CreditCard[];
  transactions?: Transaction[];
  loans?: Loan[];
  properties?: Property[];
  budgets?: Budget[];
  goals?: Goal[];
}

function seed(o: Seed = {}) {
  useStore.setState({
    user: { id: o.as ?? ADA, email: 'ada@example.com', currency_preference: 'AUD' } as any,
    households: o.households ?? [],
    householdMembers: o.members ?? [],
    householdInvitations: [],
    recordShares: o.shares ?? [],
    shareCodes: o.codes ?? [],
    financeScope: o.scope ?? 'personal',
    activeHouseholdId: o.activeHouseholdId ?? null,
    accounts: o.accounts ?? [],
    creditCards: o.creditCards ?? [],
    transactions: o.transactions ?? [],
    loans: o.loans ?? [],
    properties: o.properties ?? [],
    budgets: o.budgets ?? [],
    goals: o.goals ?? [],
    investments: [], superFunds: [], bills: [], netWorthHistory: [],
    transactionSplits: [], recurringSeries: [], pendingSyncQueue: [],
  } as any);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Two people, one account
// ═════════════════════════════════════════════════════════════════════════════

describe('an account shared directly with another user', () => {
  const shared = account({ id: 'acc-1', user_id: ADA, balance: 20_000 });
  const bosOwn = account({ id: 'acc-bo', user_id: BO, balance: 8_000 });

  it('shows the owner the same account it always did', () => {
    seed({ as: ADA, accounts: [shared], shares: [grant()] });
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-1']);
    expect(calculateNetWorth().bank_balance).toBe(20_000);
  });

  it('shows the recipient the SAME row — one id, one balance', () => {
    seed({ as: BO, accounts: [shared, bosOwn], shares: [grant()] });
    const visible = accountsDS.getVisible();
    expect(visible.map(a => a.id).sort()).toEqual(['acc-1', 'acc-bo']);
    expect(visible.find(a => a.id === 'acc-1')!.balance).toBe(20_000);
  });

  it("keeps it out of the recipient's own list and out of their net worth", () => {
    seed({ as: BO, accounts: [shared, bosOwn], shares: [grant()] });
    // The list every total is computed from is ownership, and nothing else.
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-bo']);
    const nw = calculateNetWorth();
    expect(nw.bank_balance).toBe(8_000);
    expect(nw.net_worth).toBe(8_000);
  });

  it('is offered as its own list, badged as somebody else\'s', () => {
    seed({ as: BO, accounts: [shared, bosOwn], shares: [grant()] });
    const theirs = accountsDS.sharedWithMe();
    expect(theirs.map(a => a.id)).toEqual(['acc-1']);
    expect(theirs[0].user_id).toBe(ADA);
    expect(sharesDS.incoming()[0]).toMatchObject({ owner_name: 'Ada', permission: 'view' });
  });

  it('adds up: the two of them together hold 28k, not 48k', () => {
    seed({ as: ADA, accounts: [shared, bosOwn], shares: [grant()] });
    const adasTotal = calculateNetWorth().bank_balance;
    seed({ as: BO, accounts: [shared, bosOwn], shares: [grant()] });
    const bosTotal = calculateNetWorth().bank_balance;
    expect(adasTotal).toBe(20_000);
    expect(bosTotal).toBe(8_000);
    expect(adasTotal + bosTotal).toBe(28_000);
  });

  it('a card shares the same way', () => {
    seed({
      as: BO,
      creditCards: [card({ id: 'card-1', user_id: ADA, balance_owing: 3_000 })],
      shares: [grant({ record_type: 'card', record_id: 'card-1' })],
    });
    expect(creditCardsDS.getAll()).toEqual([]);
    expect(creditCardsDS.sharedWithMe().map(c => c.id)).toEqual(['card-1']);
    expect(calculateNetWorth().credit_card_debt).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The transactions that come with it
// ═════════════════════════════════════════════════════════════════════════════

describe('the transactions on a directly-shared account', () => {
  const shared = account({ id: 'acc-1', user_id: ADA, balance: 20_000 });
  const onIt = txn({ id: 'tx-1', user_id: ADA, account_id: 'acc-1', amount: -100 });
  const elsewhere = txn({ id: 'tx-2', user_id: ADA, account_id: 'acc-private', amount: -500 });
  const bosOwn = txn({ id: 'tx-3', user_id: BO, account_id: 'acc-bo', amount: -20 });

  it('are visible to the recipient — the balance means nothing without them', () => {
    seed({ as: BO, accounts: [shared], transactions: [onIt, elsewhere, bosOwn], shares: [grant()] });
    expect(transactionsDS.getVisible().map(t => t.id).sort()).toEqual(['tx-1', 'tx-3']);
  });

  it('do not drag in transactions from accounts that were not shared', () => {
    seed({ as: BO, accounts: [shared], transactions: [onIt, elsewhere], shares: [grant()] });
    expect(transactionsDS.getVisible().map(t => t.id)).not.toContain('tx-2');
  });

  it("never become the recipient's spending", () => {
    seed({ as: BO, transactions: [onIt, bosOwn], shares: [grant()] });
    expect(transactionsDS.getAll().map(t => t.id)).toEqual(['tx-3']);
    expect(transactionsDS.sharedWithMe().map(t => t.id)).toEqual(['tx-1']);
  });

  it('keep their owner, so nothing about whose money it is has moved', () => {
    seed({ as: BO, transactions: [onIt], shares: [grant()] });
    expect(transactionsDS.sharedWithMe()[0].user_id).toBe(ADA);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Everything else that can be shared directly
// ═════════════════════════════════════════════════════════════════════════════

describe('goals, budgets, loans and properties', () => {
  it('are visible to the recipient and counted by nobody but their owner', () => {
    seed({
      as: BO,
      loans: [loan({ id: 'loan-1', user_id: ADA, current_balance: 500_000 })],
      properties: [property({ id: 'prop-1', user_id: ADA, current_value: 1_000_000 })],
      budgets: [budget({ id: 'bud-1', user_id: ADA })],
      goals: [goal({ id: 'goal-1', user_id: ADA })],
      shares: [
        grant({ id: 'g-1', record_type: 'loan', record_id: 'loan-1' }),
        grant({ id: 'g-2', record_type: 'property', record_id: 'prop-1' }),
        grant({ id: 'g-3', record_type: 'budget', record_id: 'bud-1' }),
        grant({ id: 'g-4', record_type: 'goal', record_id: 'goal-1' }),
      ],
    });

    // Not in Bo's lists…
    expect(loansDS.getAll()).toEqual([]);
    expect(propertiesDS.getAll()).toEqual([]);
    expect(budgetsDS.getAll()).toEqual([]);
    expect(goalsDS.getAll()).toEqual([]);

    // …and so, necessarily, not in Bo's net worth.
    const nw = calculateNetWorth();
    expect(nw.loans).toBe(0);
    expect(nw.property).toBe(0);
    expect(nw.net_worth).toBe(0);

    // …but every one of them is visible, and every one still Ada's.
    expect(sharesDS.incoming()).toHaveLength(4);
    expect(sharesDS.incoming().every(g => g.owner_user_id === ADA)).toBe(true);
  });

  it('a shared goal in a HOUSEHOLD is counted once, by the household', () => {
    seed({
      as: BO, scope: 'household', activeHouseholdId: COUPLE,
      households: [household(COUPLE, 'Ada & Bo')],
      members: [member(COUPLE, ADA, 'owner'), member(COUPLE, BO, 'member')],
      goals: [goal({ id: 'goal-1', user_id: ADA, household_id: COUPLE })],
      budgets: [budget({ id: 'bud-1', user_id: ADA, household_id: COUPLE })],
      loans: [loan({ id: 'loan-1', user_id: ADA, household_id: COUPLE, current_balance: 400_000 })],
      properties: [property({ id: 'prop-1', user_id: ADA, household_id: COUPLE, current_value: 900_000 })],
    });
    expect(goalsDS.getAll().map(g => g.id)).toEqual(['goal-1']);
    expect(budgetsDS.getAll().map(b => b.id)).toEqual(['bud-1']);
    expect(calculateNetWorth('household').net_worth).toBe(500_000); // 900k − 400k
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  More than one household
// ═════════════════════════════════════════════════════════════════════════════

describe('belonging to a couple AND a family', () => {
  const houses = [household(COUPLE, 'Ada & Bo'), household(FAMILY, 'The Camerons')];
  const members = [
    member(COUPLE, ADA, 'owner'), member(COUPLE, BO, 'member'),
    member(FAMILY, ADA, 'member'), member(FAMILY, CY, 'owner'),
  ];
  const rows = {
    accounts: [
      account({ id: 'acc-joint', user_id: ADA, household_id: COUPLE, balance: 30_000 }),
      account({ id: 'acc-family', user_id: CY, household_id: FAMILY, balance: 12_000 }),
      account({ id: 'acc-priv', user_id: ADA, household_id: null, balance: 5_000 }),
    ],
  };

  const asAda = (activeHouseholdId: string | null, scope: 'personal' | 'household') =>
    seed({ as: ADA, households: houses, members, scope, activeHouseholdId, ...rows });

  it('lists both, with their member counts', () => {
    asAda(COUPLE, 'household');
    const mine = householdsDS.mine();
    expect(mine.map(h => h.household.name)).toEqual(['Ada & Bo', 'The Camerons']);
    expect(mine.map(h => h.memberCount)).toEqual([2, 2]);
    expect(mine.map(h => h.role)).toEqual(['owner', 'member']);
    expect(mine.filter(h => h.isActive).map(h => h.household.id)).toEqual([COUPLE]);
  });

  it('gives each one its own picture with its own total', () => {
    asAda(COUPLE, 'household');
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-joint']);
    expect(calculateNetWorth('household').bank_balance).toBe(30_000);

    householdsDS.switchTo(FAMILY);
    expect(currentScope()).toBe('household');
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-family']);
    expect(calculateNetWorth('household').bank_balance).toBe(12_000);
  });

  it('never merges them — no figure anywhere is 42k', () => {
    asAda(COUPLE, 'household');
    const couple = calculateNetWorth('household').bank_balance;
    householdsDS.switchTo(FAMILY);
    const family = calculateNetWorth('household').bank_balance;
    expect(couple).toBe(30_000);
    expect(family).toBe(12_000);
    expect(couple).not.toBe(42_000);
    expect(family).not.toBe(42_000);
  });

  it('My Finances stays the rows Ada owns, whichever household is selected', () => {
    asAda(FAMILY, 'personal');
    expect(accountsDS.getAll().map(a => a.id).sort()).toEqual(['acc-joint', 'acc-priv']);
    expect(calculateNetWorth('personal').bank_balance).toBe(35_000);
  });

  it("keeps each household's rows away from the other's members", () => {
    // Bo is only in the couple.
    seed({ as: BO, households: houses, members, scope: 'household', activeHouseholdId: COUPLE, ...rows });
    expect(accountsDS.getVisible().map(a => a.id)).toEqual(['acc-joint']);
    householdsDS.switchTo(FAMILY);           // not Bo's to switch to
    expect(useStore.getState().activeHouseholdId).toBe(COUPLE);
  });

  it('a private account is in neither household, for anybody', () => {
    asAda(COUPLE, 'household');
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('acc-priv');
    householdsDS.switchTo(FAMILY);
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('acc-priv');
    seed({ as: CY, households: houses, members, scope: 'household', activeHouseholdId: FAMILY, ...rows });
    expect(accountsDS.getVisible().map(a => a.id)).toEqual(['acc-family']);
  });

  it('offers a row every household it could move to, and not the one it is in', () => {
    asAda(COUPLE, 'household');
    expect(sharingDS.assignment('account', 'acc-joint')!.targets.map(h => h.id)).toEqual([FAMILY]);
    expect(sharingDS.assignment('account', 'acc-priv')!.targets.map(h => h.id)).toEqual([COUPLE, FAMILY]);
  });

  it('moving a row between households leaves it in exactly one', () => {
    asAda(COUPLE, 'household');
    expect(sharingDS.share('account', 'acc-priv', FAMILY).ok).toBe(true);
    const moved = useStore.getState().accounts.find(a => a.id === 'acc-priv')!;
    expect(moved.household_id).toBe(FAMILY);
    expect(moved.user_id).toBe(ADA);
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-joint']);   // still the couple's view
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A row reachable two ways is still one row
// ═════════════════════════════════════════════════════════════════════════════

describe('duplicate prevention', () => {
  it('household-shared AND directly granted still shows once, counts once', () => {
    const joint = account({ id: 'acc-joint', user_id: ADA, household_id: COUPLE, balance: 30_000 });
    seed({
      as: BO, scope: 'household', activeHouseholdId: COUPLE,
      households: [household(COUPLE, 'Ada & Bo')],
      members: [member(COUPLE, ADA, 'owner'), member(COUPLE, BO, 'member')],
      accounts: [joint],
      shares: [grant({ record_id: 'acc-joint' })],
    });
    expect(accountsDS.getVisible()).toHaveLength(1);
    expect(accountsDS.getAll()).toHaveLength(1);
    expect(calculateNetWorth('household').bank_balance).toBe(30_000);
  });

  it('two grants on the same row from a re-share still show one account', () => {
    seed({
      as: BO,
      accounts: [account({ id: 'acc-1', user_id: ADA, balance: 20_000 })],
      shares: [grant({ id: 'g-1' }), grant({ id: 'g-2' })],
    });
    expect(accountsDS.sharedWithMe()).toHaveLength(1);
    expect(accountsDS.getVisible()).toHaveLength(1);
  });

  it('a redeem for something already visible is reported, not duplicated', async () => {
    seed({ as: BO, accounts: [account({ user_id: ADA })], shares: [grant()] });
    vi.mocked(sharesApi.redeem).mockResolvedValueOnce({ already: true, share: grant() });
    // The reload that follows every share action returns the ONE grant that
    // already existed — which is the point: redeeming again added nothing.
    vi.mocked(sharesApi.getAll).mockResolvedValueOnce({ shares: [grant()], codes: [] });
    const result = await sharesDS.redeem('CODE-1');
    expect(result.already).toBe(true);
    expect(accountsDS.sharedWithMe()).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Permissions
// ═════════════════════════════════════════════════════════════════════════════

describe('what a recipient may do', () => {
  const shared = account({ id: 'acc-1', user_id: ADA, balance: 20_000 });

  it('view means look: no edit, no delete, no re-sharing', () => {
    seed({ as: BO, accounts: [shared], shares: [grant({ permission: 'view' })] });
    const a = sharingDS.assignment('account', 'acc-1')!;
    expect(a.mine).toBe(false);
    expect(a.canEdit).toBe(false);
    expect(a.canDelete).toBe(false);
    expect(a.refusal).toBe('This was shared with you to look at, not to change.');
    expect(sharingDS.canShareDirectly('account', 'acc-1')).toMatchObject({
      ok: false, error: 'Only the person this belongs to can share it.',
    });
  });

  it('edit means correct it, and still never delete it', () => {
    seed({ as: BO, accounts: [shared], shares: [grant({ permission: 'edit' })] });
    const a = sharingDS.assignment('account', 'acc-1')!;
    expect(a.canEdit).toBe(true);
    expect(a.canDelete).toBe(false);
  });

  it('the owner keeps every right, having shared it', () => {
    seed({ as: ADA, accounts: [shared], shares: [grant({ permission: 'edit' })] });
    const a = sharingDS.assignment('account', 'acc-1')!;
    expect(a).toMatchObject({ mine: true, canEdit: true, canDelete: true, scope: 'personal', directCount: 1 });
    expect(sharingDS.canShareDirectly('account', 'acc-1').ok).toBe(true);
    expect(sharingDS.people('account', 'acc-1').map(p => p.shared_with_name)).toEqual(['Bo']);
  });

  it("a household member who can edit the joint account still can't hand it out", () => {
    seed({
      as: BO,
      households: [household(COUPLE, 'Ada & Bo')],
      members: [member(COUPLE, ADA, 'owner'), member(COUPLE, BO, 'member')],
      accounts: [account({ id: 'acc-joint', user_id: ADA, household_id: COUPLE })],
    });
    const a = sharingDS.assignment('account', 'acc-joint')!;
    expect(a.canEdit).toBe(true);
    expect(sharingDS.canShareDirectly('account', 'acc-joint').ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Ending access
// ═════════════════════════════════════════════════════════════════════════════

describe('revoking and leaving', () => {
  const shared = account({ id: 'acc-1', user_id: ADA, balance: 20_000 });
  const onIt = txn({ id: 'tx-1', user_id: ADA, account_id: 'acc-1' });
  const bosOwn = account({ id: 'acc-bo', user_id: BO, balance: 8_000 });

  it('the recipient can hand it back, and their own money is untouched', async () => {
    seed({ as: BO, accounts: [shared, bosOwn], transactions: [onIt], shares: [grant()] });
    const result = await sharesDS.end('g-1');
    expect(result.ok).toBe(true);
    expect(sharesApi.end).toHaveBeenCalledWith('g-1');

    // The rows this device can no longer see are dropped from the cache —
    // nothing is deleted anywhere, and nothing of Bo's moves.
    const after = useStore.getState();
    expect(after.accounts.map(a => a.id)).toEqual(['acc-bo']);
    expect(after.transactions).toEqual([]);
    expect(calculateNetWorth().bank_balance).toBe(8_000);
  });

  it('reports the transactions that go with it — and deletes none of them', () => {
    seed({ as: BO, accounts: [shared], transactions: [onIt], shares: [grant()] });
    const cascade = sharesDS.cascade('g-1');
    expect(cascade.transactions).toEqual(['tx-1']);
    expect(cascade.deletes).toEqual([]);
  });

  it("the owner can revoke, and their own account is exactly where it was", async () => {
    seed({ as: ADA, accounts: [shared], transactions: [onIt], shares: [grant()] });
    expect((await sharesDS.end('g-1')).ok).toBe(true);
    const after = useStore.getState();
    expect(after.accounts.map(a => a.id)).toEqual(['acc-1']);
    expect(after.accounts[0].balance).toBe(20_000);
    expect(after.transactions.map(t => t.id)).toEqual(['tx-1']);
  });

  it('a bystander cannot end somebody else\'s grant', async () => {
    seed({ as: CY, shares: [grant()] });
    const result = await sharesDS.end('g-1');
    expect(result.ok).toBe(false);
    expect(sharesApi.end).not.toHaveBeenCalled();
  });

  it('an ended grant stops showing the row immediately', () => {
    seed({ as: BO, accounts: [shared, bosOwn], shares: [grant({ status: 'revoked' })] });
    expect(accountsDS.getVisible().map(a => a.id)).toEqual(['acc-bo']);
    expect(accountsDS.sharedWithMe()).toEqual([]);
  });

  it('withdrawing an unused link touches no grant at all', async () => {
    seed({ as: ADA, accounts: [shared], codes: [shareCode()], shares: [grant()] });
    await sharesDS.revokeCode('c-1');
    expect(sharesApi.revokeCode).toHaveBeenCalledWith('c-1');
    expect(sharesApi.end).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Minting a link
// ═════════════════════════════════════════════════════════════════════════════

describe('creating a share link', () => {
  it('sends the row, the permission and a readable label', async () => {
    seed({ as: ADA, accounts: [account({ name: 'Everyday offset' })] });
    await sharesDS.createCode('account', 'acc-1', 'edit');
    expect(sharesApi.createCode).toHaveBeenCalledWith({
      record_type: 'account', record_id: 'acc-1', permission: 'edit', label: 'Everyday offset',
    });
  });

  it('refuses before it asks the server when the row is not yours', async () => {
    seed({ as: BO, accounts: [account({ user_id: ADA })], shares: [grant()] });
    await expect(sharesDS.createCode('account', 'acc-1'))
      .rejects.toThrow('Only the person this belongs to can share it.');
    expect(sharesApi.createCode).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Nothing changed for anybody who shares nothing
// ═════════════════════════════════════════════════════════════════════════════

describe('a user with no sharing at all', () => {
  it('sees exactly what they saw before 7.2', () => {
    seed({
      as: ADA,
      accounts: [account({ balance: 12_000 })],
      creditCards: [card({ balance_owing: 2_000 })],
      loans: [loan({ current_balance: 500_000 })],
      properties: [property({ current_value: 1_000_000, loan_id: 'loan-1' })],
      transactions: [txn()],
    });
    const nw = calculateNetWorth();
    expect(nw.net_worth).toBe(510_000);
    expect(accountsDS.getAll()).toHaveLength(1);
    expect(accountsDS.getVisible()).toHaveLength(1);
    expect(accountsDS.sharedWithMe()).toEqual([]);
    expect(transactionsDS.getAll()).toHaveLength(1);
    expect(currentScope()).toBe('personal');
    expect(householdsDS.mine()).toEqual([]);
    expect(sharesDS.incoming()).toEqual([]);
    expect(sharesDS.outgoing()).toEqual([]);
  });

  it('the row menu offers a link and nothing else', () => {
    seed({ as: ADA, accounts: [account()] });
    const a = sharingDS.assignment('account', 'acc-1')!;
    expect(a).toMatchObject({ scope: 'personal', directCount: 0, mine: true });
    expect(a.targets).toEqual([]);
    expect(sharingDS.canShareDirectly('account', 'acc-1').ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Cross-device persistence
// ═════════════════════════════════════════════════════════════════════════════

describe('another device, cold start', () => {
  it('remembers grants and codes, so a shared account is still there and still theirs', () => {
    seed({
      as: BO,
      accounts: [account({ id: 'acc-1', user_id: ADA, balance: 20_000 }), account({ id: 'acc-bo', user_id: BO, balance: 8_000 })],
      shares: [grant()],
      codes: [shareCode()],
    });

    // What zustand actually wrote for the next cold start.
    const persisted = JSON.parse(localStorage.getItem('ledger-store')!).state;
    expect(persisted.recordShares).toHaveLength(1);
    expect(persisted.shareCodes).toHaveLength(1);
    expect(persisted.recordShares[0]).toMatchObject({ record_id: 'acc-1', shared_with_user_id: BO });

    // Rehydrate a blank session from exactly that, and ask the same questions.
    useStore.setState({
      ...useStore.getState(),
      recordShares: [], shareCodes: [], accounts: [],
    } as any);
    expect(accountsDS.sharedWithMe()).toEqual([]);

    useStore.setState({
      user: { id: BO, email: 'bo@example.com', currency_preference: 'AUD' } as any,
      recordShares: persisted.recordShares,
      shareCodes: persisted.shareCodes,
      accounts: [account({ id: 'acc-1', user_id: ADA, balance: 20_000 }), account({ id: 'acc-bo', user_id: BO, balance: 8_000 })],
    } as any);

    expect(accountsDS.sharedWithMe().map(a => a.id)).toEqual(['acc-1']);
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-bo']);
    expect(calculateNetWorth().bank_balance).toBe(8_000);
  });

  it('remembers which household the view was on', () => {
    seed({
      as: ADA, scope: 'household', activeHouseholdId: FAMILY,
      households: [household(COUPLE, 'Ada & Bo'), household(FAMILY, 'The Camerons')],
      members: [member(COUPLE, ADA, 'owner'), member(FAMILY, ADA, 'member')],
    });
    const persisted = JSON.parse(localStorage.getItem('ledger-store')!).state;
    expect(persisted.activeHouseholdId).toBe(FAMILY);
    expect(persisted.financeScope).toBe('household');
    expect(persisted.households.map((h: Household) => h.id)).toEqual([COUPLE, FAMILY]);
  });

  it('a stale grant from a household the user left resolves to nothing', () => {
    // The grant names a row this device no longer has. It must not conjure one.
    seed({ as: BO, accounts: [], shares: [grant()] });
    expect(accountsDS.sharedWithMe()).toEqual([]);
    expect(accountsDS.getVisible()).toEqual([]);
    expect(sharesDS.incoming()).toHaveLength(1);   // the grant is still real
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('one user never sees another user\'s anything', () => {
  it('a stranger with their own household and their own grants sees neither', () => {
    seed({
      as: CY,
      households: [household(COUPLE, 'Ada & Bo'), household(FAMILY, 'The Camerons')],
      members: [member(COUPLE, ADA, 'owner'), member(COUPLE, BO, 'member'), member(FAMILY, CY, 'owner')],
      accounts: [
        account({ id: 'acc-1', user_id: ADA, balance: 20_000 }),
        account({ id: 'acc-joint', user_id: ADA, household_id: COUPLE, balance: 30_000 }),
        account({ id: 'acc-cy', user_id: CY, balance: 1_000 }),
      ],
      shares: [grant()],   // Ada → Bo. Nothing to do with Cy.
    });
    expect(accountsDS.getVisible().map(a => a.id)).toEqual(['acc-cy']);
    expect(accountsDS.sharedWithMe()).toEqual([]);
    expect(calculateNetWorth().bank_balance).toBe(1_000);
    expect(sharesDS.incoming()).toEqual([]);
    expect(sharesDS.outgoing()).toEqual([]);
  });

  it('the sharing context is rebuilt per session and carries only that user', () => {
    seed({ as: BO, shares: [grant()] });
    expect(sharingContext().userId).toBe(BO);
    seed({ as: CY, shares: [grant()] });
    expect(sharingContext().userId).toBe(CY);
    expect(sharesDS.incoming()).toEqual([]);
  });
});
