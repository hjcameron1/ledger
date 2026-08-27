/**
 * Phase 7.1 — households, end to end through the store.
 *
 * The engine is unit-tested on its own (utils/household.test.ts). These are the
 * things it cannot prove without the real data service wired up:
 *
 *   • a couple sharing an account see ONE account and one balance — the
 *     household's net worth counts it once, from either partner's session;
 *   • the household total is exactly the members' totals added up, so nothing is
 *     double-counted and nothing is lost;
 *   • private money stays private: a partner's own savings never reach the
 *     household view, the household total, or the other partner's screen;
 *   • a shared transaction keeps its owner, and attributing the SPEND to the
 *     other partner moves no balance anywhere;
 *   • removing a member takes access, not money — their rows come home to them
 *     and everybody else's are untouched;
 *   • a viewer can look and cannot touch, and nobody but an owner can delete;
 *   • a one-person account behaves EXACTLY as it did before this phase shipped;
 *   • one user never sees another's anything.
 *
 * Sync is mocked, so "the partner's device sees it" means "the right op, with
 * the right payload, was queued" — which is exactly what that device replays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  BankAccount, CreditCard, Transaction, Loan, Property, Budget, Goal, Bill,
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
import {
  accountsDS, creditCardsDS, transactionsDS, loansDS, propertiesDS,
  budgetsDS, goalsDS, billsDS, sharingDS, householdsDS, householdReportDS,
  householdContext, currentScope, calculateNetWorth,
  transactionHouseholds, canAttribute,
} from './dataService';

const ADA = 'user-ada';
const BO  = 'user-bo';
const CY  = 'user-cy';
const HH  = 'hh-1';

const mockedSync = vi.mocked(syncWithRetry);

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

const bill = (o: Partial<Bill> = {}): Bill => ({
  id: 'bill-1', user_id: ADA, name: 'Electricity', amount: 180,
  due_date: '2099-01-01', is_recurring: false, colour: 'grey', is_paid: false,
  calendar_synced: false, ...o,
});

const household = (o: Partial<Household> = {}): Household =>
  ({ id: HH, name: 'Ada & Bo', created_by: ADA, currency: 'AUD', ...o });

const member = (o: Partial<HouseholdMember> = {}): HouseholdMember =>
  ({ id: `m-${o.user_id ?? ADA}`, household_id: HH, user_id: ADA, role: 'owner', status: 'active', ...o });

const COUPLE = [member({ user_id: ADA, role: 'owner' }), member({ user_id: BO, role: 'member' })];

interface Seed {
  as?: string;
  households?: Household[];
  members?: HouseholdMember[];
  scope?: 'personal' | 'household';
  accounts?: BankAccount[];
  creditCards?: CreditCard[];
  transactions?: Transaction[];
  loans?: Loan[];
  properties?: Property[];
  budgets?: Budget[];
  goals?: Goal[];
  bills?: Bill[];
}

function seed(o: Seed = {}) {
  useStore.setState({
    user: { id: o.as ?? ADA, email: 'ada@example.com', currency_preference: 'AUD' } as any,
    households: o.households ?? [],
    householdMembers: o.members ?? [],
    financeScope: o.scope ?? 'personal',
    activeHouseholdId: null,
    accounts: o.accounts ?? [],
    creditCards: o.creditCards ?? [],
    transactions: o.transactions ?? [],
    loans: o.loans ?? [],
    properties: o.properties ?? [],
    budgets: o.budgets ?? [],
    goals: o.goals ?? [],
    bills: o.bills ?? [],
    // Everything else calculateNetWorth reads — empty unless a test needs it.
    investments: [], superFunds: [],
    transactionSplits: [], recurringSeries: [], pendingSyncQueue: [],
  } as any);
}

/** The couple, seeded from one partner's session. */
const couple = (o: Seed = {}) =>
  seed({ households: [household()], members: COUPLE, ...o });

const kinds = () => mockedSync.mock.calls.map(c => c[0] as string);
const payloadOf = (kind: string) => mockedSync.mock.calls.find(c => c[0] === kind)?.[1] as any;

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  A one-person account — nothing may have changed for them
// ═════════════════════════════════════════════════════════════════════════════

describe('a one-person account', () => {
  it('reports the same net worth it always did', () => {
    seed({
      accounts: [account({ balance: 12_000 })],
      creditCards: [card({ balance_owing: 2_000 })],
      loans: [loan({ current_balance: 500_000 })],
      properties: [property({ current_value: 1_000_000, loan_id: 'loan-1' })],
    });
    const nw = calculateNetWorth();
    expect(nw.net_worth).toBe(510_000);   // 12k + 1m − 2k − 500k
    expect(nw.bank_balance).toBe(12_000);
    expect(nw.property).toBe(1_000_000);
    expect(nw.loans).toBe(500_000);
  });

  it('sees every one of its own rows through every accessor', () => {
    seed({
      accounts: [account()], creditCards: [card()], transactions: [txn()],
      loans: [loan()], properties: [property()], budgets: [budget()], goals: [goal()],
    });
    expect(accountsDS.getAll()).toHaveLength(1);
    expect(creditCardsDS.getAll()).toHaveLength(1);
    expect(transactionsDS.getAll()).toHaveLength(1);
    expect(loansDS.getAll()).toHaveLength(1);
    expect(propertiesDS.getAll()).toHaveLength(1);
    expect(budgetsDS.active()).toHaveLength(1);
    expect(goalsDS.getAll()).toHaveLength(1);
  });

  it('stays on the personal scope even if a stale preference says otherwise', () => {
    seed({ scope: 'household', accounts: [account({ balance: 500 })] });
    expect(currentScope()).toBe('personal');
    expect(calculateNetWorth().net_worth).toBe(500);
  });

  it('cannot share anything, because there is no household to share with', () => {
    seed({ accounts: [account()] });
    expect(sharingDS.share('account', 'acc-1')).toEqual({ ok: false, error: "You're not in a household yet." });
    expect(mockedSync).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A couple with a shared account
// ═════════════════════════════════════════════════════════════════════════════

describe('a couple sharing an account', () => {
  // Ada's joint account holds the household money; each keeps a private one.
  const joint    = account({ id: 'joint', user_id: ADA, balance: 10_000, household_id: HH });
  const adaSaver = account({ id: 'ada-saver', user_id: ADA, balance: 5_000 });
  const boSaver  = account({ id: 'bo-saver', user_id: BO, balance: 3_000 });
  const boCar    = account({ id: 'bo-car', user_id: BO, balance: 25_000, household_id: HH });
  const all = [joint, adaSaver, boSaver, boCar];

  it('counts the shared account ONCE in the household total, from either session', () => {
    couple({ as: ADA, accounts: all, scope: 'household' });
    const fromAda = calculateNetWorth();
    couple({ as: BO, accounts: all, scope: 'household' });
    const fromBo = calculateNetWorth();

    // 10,000 + 25,000 — the joint account appears once, not once per partner.
    expect(fromAda.bank_balance).toBe(35_000);
    expect(fromBo.bank_balance).toBe(35_000);
    expect(fromAda.net_worth).toBe(fromBo.net_worth);
  });

  it('keeps each partner\'s personal total to their own money', () => {
    // Sharing never removes a row from its owner's "My Finances" — the
    // household is a combined view, not a place money moves to.
    couple({ as: ADA, accounts: all });
    expect(calculateNetWorth().bank_balance).toBe(15_000);   // joint + her saver
    couple({ as: BO, accounts: all });
    expect(calculateNetWorth().bank_balance).toBe(28_000);   // his car + his saver
  });

  it('leaves private savings out of the household total entirely', () => {
    couple({ as: ADA, accounts: all, scope: 'household' });
    const shown = accountsDS.getAll().map(a => a.id).sort();
    expect(shown).toEqual(['bo-car', 'joint']);
    expect(shown).not.toContain('ada-saver');
    expect(shown).not.toContain('bo-saver');
  });

  it('never shows one partner the other\'s private account, in any scope', () => {
    couple({ as: BO, accounts: all });
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('ada-saver');
    useStore.getState().setFinanceScope('household');
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('ada-saver');
    // Not even through the deliberately-wider accessor the pickers use.
    expect(accountsDS.getVisible().map(a => a.id)).not.toContain('ada-saver');
    expect(accountsDS.getVisible().map(a => a.id).sort()).toEqual(['bo-car', 'bo-saver', 'joint']);
  });

  it('shares every kind of entity the same way, and only the household column moves', () => {
    couple({
      as: ADA,
      accounts: [account()], creditCards: [card()], transactions: [txn()],
      loans: [loan()], properties: [property()], budgets: [budget()], goals: [goal()],
    });
    useStore.getState().setActiveHouseholdId(HH);

    expect(sharingDS.share('account', 'acc-1').ok).toBe(true);
    expect(sharingDS.share('card', 'card-1').ok).toBe(true);
    expect(sharingDS.share('transaction', 'tx-1').ok).toBe(true);
    expect(sharingDS.share('loan', 'loan-1').ok).toBe(true);
    expect(sharingDS.share('property', 'prop-1').ok).toBe(true);
    expect(sharingDS.share('budget', 'bud-1').ok).toBe(true);
    expect(sharingDS.share('goal', 'goal-1').ok).toBe(true);

    const s = useStore.getState();
    for (const row of [s.accounts[0], s.creditCards[0], s.transactions[0], s.loans[0],
                       s.properties[0], s.budgets[0], s.goals[0]]) {
      expect(row.household_ids).toEqual([HH]);
      expect(row.user_id).toBe(ADA);     // ownership never moves
    }
    expect(s.accounts[0].balance).toBe(0);   // and no figure moved either
  });

  it('queues the share so the partner\'s device sees it', () => {
    couple({ as: ADA, accounts: [account()] });
    useStore.getState().setActiveHouseholdId(HH);
    sharingDS.share('account', 'acc-1');

    expect(kinds()).toContain('account.update');
    // The patch is the COMPLETE list of households the row should end up in —
    // the server diffs it, so re-sending it is harmless.
    expect(payloadOf('account.update')).toEqual({ id: 'acc-1', data: { household_ids: [HH] } });
  });

  // The local store updating is only half of a share, and it is the half that
  // never fails. Cards used to have no update endpoint wired at all, and a
  // property's sync payload is a column whitelist that silently dropped the
  // field — in both cases the row moved into the household on screen, was never
  // written anywhere, and came back personal on the next load. That is what
  // "sometimes it shows up and sometimes it doesn't" was. So: every kind must
  // TELL THE SERVER, and the message must carry the households.
  it('tells the server for every kind, not just the ones on screen', () => {
    couple({
      as: ADA,
      accounts: [account()], creditCards: [card()], transactions: [txn()],
      loans: [loan()], properties: [property()], budgets: [budget()], goals: [goal()],
    });
    useStore.getState().setActiveHouseholdId(HH);

    const shares: [Parameters<typeof sharingDS.share>[0], string, string][] = [
      ['account', 'acc-1', 'account.update'],
      ['card', 'card-1', 'card.update'],
      ['transaction', 'tx-1', 'transaction.update'],
      ['loan', 'loan-1', 'loan.update'],
      ['property', 'prop-1', 'property.update'],
      ['budget', 'bud-1', 'budget.update'],
      ['goal', 'goal-1', 'goal.update'],
    ];

    for (const [kind, id, syncKind] of shares) {
      mockedSync.mockClear();
      expect(sharingDS.share(kind, id, HH).ok).toBe(true);
      expect(kinds()).toContain(syncKind);
      // Whatever else a kind's payload carries (a property sends its whole
      // column set), the households have to be in it.
      expect(payloadOf(syncKind)).toMatchObject({ id, data: { household_ids: [HH] } });
    }
  });

  // The other side of that whitelist fix: sharing rides the entity's ordinary
  // update, so an ordinary update must stay silent about sharing. If a plain
  // edit sent `household_ids` too, saving a property from the property screen
  // would re-assert this device's stale view and quietly un-share it everywhere
  // a partner had put it.
  it('says nothing about sharing when the edit is not a share', () => {
    couple({ as: ADA, properties: [property({ household_id: HH })] });
    mockedSync.mockClear();
    propertiesDS.update('prop-1', { current_value: 1_100_000 });
    expect(payloadOf('property.update').data).not.toHaveProperty('household_ids');
  });

  it('takes it back out again on the owner\'s say-so', () => {
    couple({ as: ADA, accounts: [account({ household_id: HH })], scope: 'household' });
    expect(accountsDS.getAll()).toHaveLength(1);

    expect(sharingDS.unshare('account', 'acc-1').ok).toBe(true);
    expect(useStore.getState().accounts[0].household_ids).toEqual([]);
    expect(accountsDS.getAll()).toHaveLength(0);          // gone from the household view
    useStore.getState().setFinanceScope('personal');
    expect(accountsDS.getAll()).toHaveLength(1);          // still entirely hers
  });

  it('tells a row\'s menu what it is and what may be done to it', () => {
    couple({ as: BO, accounts: [joint, adaSaver, boCar] });
    expect(sharingDS.status('account', 'joint')).toMatchObject({ shared: true, mine: false, canEdit: true });
    expect(sharingDS.status('account', 'bo-car')).toMatchObject({ shared: true, mine: true, canEdit: true });
    expect(sharingDS.status('account', 'ada-saver')).toMatchObject({ canView: false, canEdit: false });
  });

  it('summarises who brought what without adding per-member lists together', () => {
    couple({ as: ADA, accounts: all });
    useStore.getState().setActiveHouseholdId(HH);
    const s = sharingDS.summary();
    expect(s.account).toEqual({ sharedByMe: 1, personalToMe: 1, sharedByOthers: 1, householdTotal: 2 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Net worth: counted once, and the parts add up
// ═════════════════════════════════════════════════════════════════════════════

describe('household net worth', () => {
  // A shared house with a shared mortgage, a shared account, and a car loan Bo
  // brought with him. Everything private is deliberately large enough that
  // including it by mistake would be unmissable.
  const setup = (as: string) => couple({
    as,
    scope: 'household',
    accounts: [
      account({ id: 'joint', user_id: ADA, balance: 20_000, household_id: HH }),
      account({ id: 'ada-secret', user_id: ADA, balance: 999_999 }),
      account({ id: 'bo-secret', user_id: BO, balance: 888_888 }),
    ],
    creditCards: [card({ id: 'joint-card', user_id: BO, balance_owing: 4_000, household_id: HH })],
    loans: [
      loan({ id: 'mortgage', user_id: ADA, current_balance: 600_000, household_id: HH }),
      loan({ id: 'bo-car-loan', user_id: BO, current_balance: 30_000, household_id: HH }),
    ],
    properties: [property({ id: 'home', user_id: ADA, current_value: 1_200_000, loan_id: 'mortgage', household_id: HH })],
  });

  it('adds the shared rows up once each', () => {
    setup(ADA);
    const nw = calculateNetWorth();
    // 20,000 + 1,200,000 − 4,000 − 600,000 − 30,000
    expect(nw.net_worth).toBe(586_000);
    expect(nw.bank_balance).toBe(20_000);
    expect(nw.property).toBe(1_200_000);
    expect(nw.loans).toBe(630_000);
  });

  it('gives both partners the identical household figure', () => {
    setup(ADA);
    const fromAda = calculateNetWorth();
    setup(BO);
    expect(calculateNetWorth()).toEqual(fromAda);
  });

  it('nets the shared mortgage against the shared house exactly once', () => {
    setup(ADA);
    const before = calculateNetWorth();
    // The house is worth 1.2m and the mortgage is 600k, so the pair contributes
    // 600k — never 1.2m (debt lost) and never 0 (debt counted twice).
    const withoutProperty = { ...before, property: 0 };
    expect(before.property - before.loans).toBe(1_200_000 - 630_000);
    expect(withoutProperty.property).toBe(0);
  });

  it('reconciles to the members\' contributions, to the cent', () => {
    setup(ADA);
    useStore.getState().setActiveHouseholdId(HH);
    const report = householdReportDS.build()!;

    expect(report.total.net_worth).toBe(586_000);
    // Ada brought 20,000 + 1,200,000 − 600,000 = 620,000.
    // Bo brought −4,000 − 30,000 = −34,000.
    expect(report.members.find(m => m.userId === ADA)!.netWorth.net_worth).toBe(620_000);
    expect(report.members.find(m => m.userId === BO)!.netWorth.net_worth).toBe(-34_000);
    // Nothing counted twice, nothing left out — and never IEEE negative zero,
    // which formats as "−$0.00" and undermines the exact claim this line makes.
    expect(report.reconciliation).toBe(0);
    expect(Object.is(report.reconciliation, -0)).toBe(false);
    expect(report.members.reduce((t, m) => t + m.netWorth.net_worth, 0)).toBe(report.total.net_worth);
  });

  it('never lets private money reach the household figure', () => {
    setup(ADA);
    // Both secrets together are over 1.8m; the household total is 586k.
    expect(calculateNetWorth().bank_balance).toBe(20_000);
  });

  it('keeps investments and super personal — the household shows what is shared', () => {
    setup(ADA);
    useStore.setState({
      investments: [{ id: 'i1', user_id: ADA, current_value: 50_000 } as any],
      superFunds: [{ id: 's1', user_id: ADA, balance: 200_000 } as any],
    });
    expect(calculateNetWorth('household').investments).toBe(0);
    expect(calculateNetWorth('household').super).toBe(0);
    expect(calculateNetWorth('personal').investments).toBe(50_000);
  });

  // Restated: `calculateNetWorth` used to append to a `netWorthHistory` slice as
  // a side effect of being READ, and this test pinned the household view out of
  // that write. The slice was persisted and no screen ever read it — the trend
  // comes from the server's snapshots — so the write went, and with it the
  // question of which scope was allowed to make it. What still matters is that
  // asking is free: switching views must not change anything.
  it('changes nothing by being asked — reading net worth writes nothing', () => {
    setup(ADA);
    const before = JSON.stringify(useStore.getState().accounts);
    calculateNetWorth('household');
    calculateNetWorth('personal');
    expect(JSON.stringify(useStore.getState().accounts)).toBe(before);
    expect(useStore.getState().netWorth).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A shared transaction keeps its owner
// ═════════════════════════════════════════════════════════════════════════════

describe('a shared transaction', () => {
  const shared = txn({ id: 'tx-shared', user_id: ADA, amount: -250, household_id: HH });

  it('is one transaction, visible to both, owned by one', () => {
    couple({ as: BO, transactions: [shared], scope: 'household' });
    expect(transactionsDS.getAll()).toHaveLength(1);
    expect(transactionsDS.getAll()[0].user_id).toBe(ADA);
    // …and it is NOT in Bo's personal view, because it is not his record.
    useStore.getState().setFinanceScope('personal');
    expect(transactionsDS.getAll()).toHaveLength(0);
  });

  it('can be attributed to the partner who actually spent it, without moving it', () => {
    couple({
      as: ADA, scope: 'household',
      accounts: [account({ id: 'joint', balance: 10_000, household_id: HH })],
      transactions: [shared],
    });
    const before = calculateNetWorth().net_worth;

    sharingDS.setResponsible('tx-shared', BO);

    expect(sharingDS.responsibleFor('tx-shared')).toBe(BO);
    expect(useStore.getState().transactions[0].user_id).toBe(ADA);   // owner unchanged
    // Balances come from account rows, never from adding transactions up, so
    // handing the spend to Bo cannot have moved a cent of anyone's net worth.
    expect(calculateNetWorth().net_worth).toBe(before);
    expect(payloadOf('transaction.update')).toMatchObject({ data: { responsible_user_id: BO } });
  });

  it('splits shared spending by who is responsible, counting each once', () => {
    couple({
      as: ADA, scope: 'household',
      transactions: [
        txn({ id: 't1', user_id: ADA, household_id: HH }),
        txn({ id: 't2', user_id: ADA, household_id: HH, responsible_user_id: BO }),
        txn({ id: 't3', user_id: BO, household_id: HH }),
        txn({ id: 't4', user_id: ADA }),   // private — not household spending
      ],
    });
    useStore.getState().setActiveHouseholdId(HH);
    const by = sharingDS.spendByMember();
    expect(by.get(ADA)!.map(t => t.id)).toEqual(['t1']);
    expect(by.get(BO)!.map(t => t.id).sort()).toEqual(['t2', 't3']);
    expect([...by.values()].flat()).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Shared spending & responsibilities (Phase 7.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('who paid and the responsibility split', () => {
  // Dated today so the this-month summary counts them whatever month it is run in.
  const today = new Date().toISOString().split('T')[0];
  const shared = (o: Partial<Transaction> = {}) =>
    txn({ id: 'tx-split', amount: -100, date: today, household_id: HH, ...o });

  it('saves who paid and the split in ONE queued write, and moves no money', () => {
    couple({
      as: ADA, scope: 'household',
      accounts: [account({ id: 'acc-1', balance: 10_000, household_id: HH })],
      transactions: [shared()],
    });
    useStore.getState().setActiveHouseholdId(HH);
    const before = calculateNetWorth().net_worth;

    const result = sharingDS.setAttribution('tx-split', {
      paidBy: BO,
      split: [{ user_id: ADA, percent: 60 }, { user_id: BO, percent: 40 }],
    });

    expect(result.ok).toBe(true);
    expect(kinds().filter(k => k === 'transaction.update')).toHaveLength(1);
    expect(payloadOf('transaction.update')).toMatchObject({
      id: 'tx-split',
      data: {
        paid_by_user_id: BO,
        responsible_user_id: null,
        responsibility_split: [{ user_id: ADA, percent: 60 }, { user_id: BO, percent: 40 }],
      },
    });
    expect(useStore.getState().transactions[0].user_id).toBe(ADA); // owner untouched
    expect(calculateNetWorth().net_worth).toBe(before);            // and no money moved
  });

  it('refuses an unbalanced split before anything is written', () => {
    couple({ as: ADA, transactions: [shared()] });
    const result = sharingDS.setAttribution('tx-split', {
      split: [{ user_id: ADA, amount: 30 }, { user_id: BO, amount: 30 }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/add up/);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('choosing a single responsible person clears any split', () => {
    couple({
      as: ADA,
      transactions: [shared({
        responsibility_split: [{ user_id: ADA, amount: 50 }, { user_id: BO, amount: 50 }],
      })],
    });
    sharingDS.setResponsible('tx-split', BO);
    expect(payloadOf('transaction.update')).toMatchObject({
      data: { responsible_user_id: BO, responsibility_split: null },
    });
  });

  it('summarises the month by member — paid vs their share, netting to zero', () => {
    couple({
      as: ADA, scope: 'household',
      transactions: [
        // Ada fronted $100 of half-each groceries…
        shared({ id: 't1', responsibility_split: [{ user_id: ADA, amount: 50 }, { user_id: BO, amount: 50 }] }),
        // …Bo paid a $60 bill that was wholly Ada's…
        shared({ id: 't2', amount: -60, paid_by_user_id: BO, responsible_user_id: ADA }),
        // …and a $20 refund came back against the split groceries.
        shared({
          id: 't3', amount: 20, transaction_type: 'refund',
          responsibility_split: [{ user_id: ADA, percent: 50 }, { user_id: BO, percent: 50 }],
        }),
      ],
    });
    useStore.getState().setActiveHouseholdId(HH);
    const rows = sharingDS.memberSpending(HH);
    const ada = rows.find(r => r.userId === ADA)!;
    const bo = rows.find(r => r.userId === BO)!;
    // Ada paid 100 − 20 refund = 80; her share is 50 − 10 + 60 = 100.
    expect(ada).toMatchObject({ paid: 80, responsible: 100, net: -20, isYou: true });
    expect(bo).toMatchObject({ paid: 60, responsible: 40, net: 20, isYou: false });
    expect(rows.reduce((s, r) => s + r.net, 0)).toBe(0);
  });

  it('counts a joint-account purchase through the account it sits on', () => {
    // The transaction itself was never stamped — it inherits the shared
    // account's households at read time, like every transaction list.
    couple({
      as: ADA, scope: 'household',
      accounts: [account({ id: 'acc-1', household_id: HH })],
      transactions: [txn({ id: 'tx-joint', user_id: BO, amount: -80, date: today })],
    });
    useStore.getState().setActiveHouseholdId(HH);
    const bo = sharingDS.memberSpending(HH).find(r => r.userId === BO)!;
    expect(bo).toMatchObject({ paid: 80, responsible: 80, net: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Where the "Who paid & split" affordance may appear
// ═════════════════════════════════════════════════════════════════════════════
//
// The row and the modal both decide from these two functions, so what they
// prove is exactly what the screen offers: household visibility is derived
// from the transaction AND its account — never from which list a particular
// copy of the row happened to arrive through.

describe('attribution visibility (transactionHouseholds / canAttribute)', () => {
  const OTHER_HH = 'hh-2';

  it('a directly shared transaction reaches its household', () => {
    couple({ as: ADA, transactions: [txn({ id: 't1', household_id: HH })] });
    const tx = useStore.getState().transactions[0];
    expect(transactionHouseholds(tx)).toEqual([HH]);
    expect(canAttribute(tx)).toBe(true);
  });

  it('an UNSTAMPED transaction on a shared account inherits the account\'s household', () => {
    couple({
      as: BO, // the partner, not the owner — a member may attribute it
      accounts: [account({ id: 'acc-1', user_id: ADA, household_id: HH })],
      transactions: [txn({ id: 't1', user_id: ADA })],
    });
    const tx = useStore.getState().transactions[0];
    expect(transactionHouseholds(tx)).toEqual([HH]);
    expect(canAttribute(tx)).toBe(true);
  });

  it('a joint credit-card charge inherits through the card too', () => {
    couple({
      as: ADA,
      creditCards: [card({ id: 'card-1', household_id: HH })],
      transactions: [txn({ id: 't1', account_id: 'card-1', account_type: 'credit_card' })],
    });
    expect(canAttribute(useStore.getState().transactions[0])).toBe(true);
  });

  it('unions the row\'s own households with the account\'s', () => {
    couple({
      as: ADA,
      households: [household(), household({ id: OTHER_HH, name: 'The Camerons' })],
      members: [...COUPLE, member({ id: 'm-ada-2', household_id: OTHER_HH, user_id: ADA })],
      accounts: [account({ id: 'acc-1', household_id: HH })],
      transactions: [txn({ id: 't1', household_id: OTHER_HH })],
    });
    const tx = useStore.getState().transactions[0];
    expect(transactionHouseholds(tx).sort()).toEqual([HH, OTHER_HH].sort());
    expect(canAttribute(tx)).toBe(true);
  });

  it('a personal transaction on a personal account reaches nobody — no affordance', () => {
    couple({ as: ADA, accounts: [account()], transactions: [txn()] });
    const tx = useStore.getState().transactions[0];
    expect(transactionHouseholds(tx)).toEqual([]);
    expect(canAttribute(tx)).toBe(false);
  });

  it('a stranger to the household cannot attribute, however the row reached them', () => {
    seed({
      as: CY, households: [household()], members: COUPLE, // Cy is in no household
      accounts: [account({ id: 'acc-1', household_id: HH })],
      transactions: [txn({ id: 't1', household_id: HH })],
    });
    expect(canAttribute(useStore.getState().transactions[0])).toBe(false);
  });

  it('a viewer can look and cannot re-attribute — unless the transaction is their own', () => {
    const asViewer = (transactions: Transaction[], accounts: BankAccount[] = []) => seed({
      as: BO,
      households: [household()],
      members: [member({ user_id: ADA, role: 'owner' }), member({ user_id: BO, role: 'viewer' })],
      accounts, transactions,
    });

    // Ada's shared spend: visible to viewer Bo, not his to re-attribute.
    asViewer([txn({ id: 't1', household_id: HH })]);
    expect(canAttribute(useStore.getState().transactions[0])).toBe(false);

    // Same through a shared account.
    asViewer([txn({ id: 't1', user_id: ADA })], [account({ id: 'acc-1', user_id: ADA, household_id: HH })]);
    expect(canAttribute(useStore.getState().transactions[0])).toBe(false);

    // But Bo's OWN transaction shared into the household stays his to attribute.
    asViewer([txn({ id: 't1', user_id: BO, household_id: HH })]);
    expect(canAttribute(useStore.getState().transactions[0])).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Shared bills (Phase 7.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('shared bills', () => {
  it('shares with the same household_ids patch as every other entity', () => {
    couple({ as: ADA, bills: [bill()] });
    useStore.getState().setActiveHouseholdId(HH);
    expect(sharingDS.share('bill', 'bill-1')).toEqual({ ok: true });
    expect(payloadOf('bill.update')).toMatchObject({
      id: 'bill-1', data: { household_ids: [HH] },
    });
  });

  it('appears once in the household view and never in the partner\'s personal list', () => {
    couple({ as: BO, scope: 'household', bills: [bill({ household_ids: [HH] })] });
    expect(billsDS.getAll().map(b => b.id)).toEqual(['bill-1']);
    useStore.getState().setFinanceScope('personal');
    expect(billsDS.getAll()).toHaveLength(0);
  });

  it('records the responsible member as one queued update', () => {
    couple({ as: ADA, bills: [bill({ household_ids: [HH] })] });
    billsDS.update('bill-1', { responsible_user_id: BO });
    expect(payloadOf('bill.update')).toMatchObject({
      id: 'bill-1', data: { responsible_user_id: BO },
    });
    expect(useStore.getState().bills[0].user_id).toBe(ADA); // still Ada's row
  });

  it('never lazily deletes a same-looking bill someone else shared', () => {
    // Ada and Bo each have a "Rent" bill for the same amount and date; Bo's is
    // shared in. The duplicate sweep must only ever collapse Ada's OWN rows.
    couple({
      as: ADA, scope: 'household',
      bills: [
        bill({ id: 'ada-rent', name: 'Rent', amount: 900 }),
        bill({ id: 'bo-rent', name: 'Rent', amount: 900, user_id: BO, household_ids: [HH] }),
      ],
    });
    billsDS.getAll();
    expect(kinds()).not.toContain('bill.delete');
    expect(useStore.getState().bills).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Permissions
// ═════════════════════════════════════════════════════════════════════════════

describe('permissions', () => {
  const asViewer = (extra: Seed = {}) => seed({
    as: BO,
    households: [household()],
    members: [member({ user_id: ADA, role: 'owner' }), member({ user_id: BO, role: 'viewer' })],
    ...extra,
  });

  it('lets a viewer see the shared money', () => {
    asViewer({ accounts: [account({ id: 'joint', balance: 10_000, household_id: HH })], scope: 'household' });
    expect(accountsDS.getAll()).toHaveLength(1);
    expect(calculateNetWorth().bank_balance).toBe(10_000);
  });

  it('stops a viewer changing it', () => {
    asViewer({ accounts: [account({ id: 'joint', household_id: HH })] });
    expect(sharingDS.status('account', 'joint')).toMatchObject({ canView: true, canEdit: false });
    expect(sharingDS.status('account', 'joint')!.refusal).toMatch(/Viewers/);
  });

  it('stops a viewer putting their own money in', () => {
    asViewer({ accounts: [account({ id: 'bo-own', user_id: BO })] });
    useStore.getState().setActiveHouseholdId(HH);
    const result = sharingDS.share('account', 'bo-own');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Viewers/);
    expect(useStore.getState().accounts[0].household_id).toBeNull();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('lets a member edit shared money but never share what isn\'t theirs', () => {
    couple({ as: BO, accounts: [account({ id: 'joint', user_id: ADA, household_id: HH })] });
    expect(sharingDS.status('account', 'joint')!.canEdit).toBe(true);
    // Bo can't take Ada's account back OUT of the household either — that is
    // her decision about her account.
    expect(sharingDS.unshare('account', 'joint')).toEqual({
      ok: false, error: 'Only the person this belongs to can make it personal again.',
    });
  });

  it('refuses to share a row belonging to somebody else', () => {
    couple({ as: BO, accounts: [account({ id: 'ada-saver', user_id: ADA })] });
    useStore.getState().setActiveHouseholdId(HH);
    expect(sharingDS.share('account', 'ada-saver').error).toMatch(/Only the person this belongs to/);
  });

  it('surfaces what the signed-in user may do in the household', () => {
    couple({ as: ADA });
    useStore.getState().setActiveHouseholdId(HH);
    expect(householdsDS.current()!.can).toEqual({
      invite: true, remove: true, changeRole: true, rename: true,
      delete: true, editShared: true, shareOwn: true,
    });

    couple({ as: BO });
    useStore.getState().setActiveHouseholdId(HH);
    expect(householdsDS.current()!.can).toMatchObject({
      invite: false, remove: false, changeRole: false, delete: false, editShared: true,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Member removal
// ═════════════════════════════════════════════════════════════════════════════

describe('when a member leaves', () => {
  const after = [member({ user_id: ADA }), member({ user_id: BO, role: 'member', status: 'removed' })];

  const rows = () => ({
    accounts: [
      account({ id: 'joint', user_id: ADA, balance: 20_000, household_id: HH }),
      account({ id: 'bo-car', user_id: BO, balance: 25_000, household_id: HH }),
      account({ id: 'bo-secret', user_id: BO, balance: 3_000 }),
    ],
  });

  it('cuts them off from the shared rows immediately', () => {
    seed({ as: BO, households: [household()], members: after, scope: 'household', ...rows() });
    // No sweep and no cache to purge: their membership stopped being active, so
    // every filter stops letting them through. The household view empties…
    expect(useStore.getState().accounts.filter(a => a.id === 'joint')).toHaveLength(1); // still cached
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('joint');
    // …and the app falls back to their personal view, which is their own rows —
    // being removed from a household must not take them to an empty screen.
    expect(currentScope()).toBe('personal');
    expect(accountsDS.getAll().map(a => a.id).sort()).toEqual(['bo-car', 'bo-secret']);
    expect(calculateNetWorth().bank_balance).toBe(28_000);   // never Ada's 20,000
  });

  it('leaves them everything they own, to the cent', () => {
    seed({ as: BO, households: [], members: [], ...rows() });
    // Their rows are un-stamped server-side; here they simply remain theirs.
    expect(accountsDS.getAll().map(a => a.id).sort()).toEqual(['bo-car', 'bo-secret']);
    expect(calculateNetWorth().bank_balance).toBe(28_000);
  });

  it('leaves the remaining member\'s household holding only what is still shared', () => {
    // Bo's rows have been un-stamped by the removal; Ada's are untouched.
    couple({
      as: ADA, scope: 'household',
      members: [member({ user_id: ADA })],
      accounts: [
        account({ id: 'joint', user_id: ADA, balance: 20_000, household_id: HH }),
        account({ id: 'bo-car', user_id: BO, balance: 25_000 }),
      ],
    });
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['joint']);
    expect(calculateNetWorth().bank_balance).toBe(20_000);
  });

  it('deletes nothing — the departed member\'s money is all still there', () => {
    const state = rows();
    seed({ as: BO, households: [], members: [], ...state });
    const total = useStore.getState().accounts.reduce((t, a) => t + a.balance, 0);
    expect(total).toBe(48_000);
    expect(useStore.getState().accounts).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Isolation between users
// ═════════════════════════════════════════════════════════════════════════════

describe('isolation between users', () => {
  it('shows a stranger only their own rows, whatever else is cached', () => {
    seed({
      as: CY,
      accounts: [
        account({ id: 'joint', user_id: ADA, balance: 20_000, household_id: HH }),
        account({ id: 'cy-own', user_id: CY, balance: 100 }),
      ],
    });
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['cy-own']);
    expect(calculateNetWorth().bank_balance).toBe(100);
  });

  it('does not let a household id alone buy a stranger access', () => {
    seed({
      as: CY,
      households: [household()],       // cached, but Cy is in no membership row
      members: COUPLE,
      scope: 'household',
      accounts: [account({ id: 'joint', user_id: ADA, balance: 20_000, household_id: HH })],
    });
    expect(householdContext().userId).toBe(CY);
    expect(accountsDS.getAll()).toEqual([]);
    expect(calculateNetWorth().bank_balance).toBe(0);
    expect(householdReportDS.build(HH)).toBeNull();
  });

  it('scopes every entity the same way, with no gaps', () => {
    seed({
      as: BO,
      accounts: [account({ user_id: ADA })],
      creditCards: [card({ user_id: ADA })],
      transactions: [txn({ user_id: ADA })],
      loans: [loan({ user_id: ADA })],
      properties: [property({ user_id: ADA })],
      budgets: [budget({ user_id: ADA })],
      goals: [goal({ user_id: ADA })],
    });
    expect(accountsDS.getAll()).toEqual([]);
    expect(creditCardsDS.getAll()).toEqual([]);
    expect(transactionsDS.getAll()).toEqual([]);
    expect(loansDS.getAll()).toEqual([]);
    expect(propertiesDS.getAll()).toEqual([]);
    expect(budgetsDS.active()).toEqual([]);
    expect(goalsDS.getAll()).toEqual([]);
  });
});
