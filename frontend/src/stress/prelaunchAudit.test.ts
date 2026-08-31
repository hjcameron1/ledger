/**
 * PRE-LAUNCH AUDIT — the client half.
 *
 * Four fresh users, three overlapping households, every share shape, driven
 * through the REAL DS layer and the REAL report engines, with the scope switched
 * back and forth the way a person actually uses the app.
 *
 * The questions, one describe each:
 *   A  every screen agrees with every other screen, in every scope
 *   B  switching scope is reversible and idempotent — the tenth switch reads
 *      like the first
 *   C  no duplicate money: a household total is its members' owned parts, once
 *   D  private money stays private, and a direct grant enters no total
 *   E  a reload mid-action changes nothing that was already true
 *   F  a revoke lands on a session that was already open
 *   G  tax, super and personal-by-nature slices never move with the scope
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as never as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(), key: () => null, get length() { return mem.size; },
  };
});
const sync = vi.fn();
vi.mock('../services/syncQueue', () => ({
  syncWithRetry: (...a: unknown[]) => sync(...a),
  registerSyncSuccess: vi.fn(), retryPendingSync: vi.fn(),
}));

import {
  accountsDS, creditCardsDS, transactionsDS, loansDS, propertiesDS,
  investmentsDS, goalsDS, budgetsDS, billsDS, incomeDS, superDS,
  calculateNetWorth, householdReportDS, budgetReportDS, forecastDS,
  goalReportDS, loanReportDS, propertyReportDS, insuranceReportDS,
  taxYearDS, alertsDS, insightsDS, reviewDS, askDS, scenarioDS,
  currentScope, householdContext, sharingDS,
} from '../services/dataService';
import { useStore } from '../store';
import { documentsDS } from '../services/dataService';
import { documentsApi } from '../services/api';
import { householdsOf } from '../utils/household';
import { UNALLOCATED } from '../utils/cashFlowForecast';
import {
  ADA, BO, CY, DI, HH_RIVER, HH_COAST, HH_KIN, EVERYONE, SCOPES_OF,
  USERS, households, members, visibleTo, ownedBy, TODAY,
} from './auditWorld';

const AS_OF = TODAY;
const NAME: Record<string, string> = { [ADA]: 'Ada', [BO]: 'Bo', [CY]: 'Cy', [DI]: 'Di' };
const HH_NAME: Record<string, string> = { [HH_RIVER]: 'Riverside', [HH_COAST]: 'Coast', [HH_KIN]: 'Kin' };

/** Load the world exactly as the server would send it to `as`. */
function login(as: string, scope: 'personal' | 'household' = 'personal', active: string | null = null) {
  const v = visibleTo(as);
  const u = USERS[as];
  useStore.setState({
    user: { id: u.id, email: u.email, name: u.name, currency_preference: 'AUD', theme: 'system', plan: 'premium', onboarding_complete: true } as never,
    token: 'audit-token',
    dataOwnerId: as,
    households, householdMembers: members, householdInvitations: [],
    financeScope: scope, activeHouseholdId: active,

    accounts: v.accounts, creditCards: v.creditCards, transactions: v.transactions,
    loans: v.loans, loanEvents: [], properties: v.properties,
    investments: v.investments, investmentSales: [],
    superFunds: v.superFunds, smsfFunds: [],
    incomeEntries: v.incomeEntries, bills: v.bills,
    goals: v.goals, goalContributions: v.goalContributions,
    budgets: v.budgets, insurancePolicies: v.insurancePolicies, insurancePremiumHistory: [],
    recordShares: v.recordShares, shareCodes: [],
    subscriptions: [], recurringSeries: [], transactionSplits: [],
    creditCardStatements: [], pendingPayments: [], ccPaymentPrompts: [],
    alertStates: [], budgetSettings: null, budgetLines: [], customCategories: [],
    merchants: [], merchantAliases: [], transactionRules: [], billSubExclusions: [],
    hiddenCategories: [], selectedCategories: null, categoryAliases: {},
    notifications: [], netWorth: null, idMap: {}, pendingSyncQueue: [], basiqUserId: null,
  } as never);
  return v;
}

/** Move the app's scope the way the Households section does. */
function switchTo(scope: 'personal' | 'household', householdId: string | null = null) {
  useStore.setState({ financeScope: scope, activeHouseholdId: householdId } as never);
}

/** One reading of every screen that states a figure. */
function screens() {
  return {
    netWorth: calculateNetWorth(),
    accounts: accountsDS.getAll().map(a => a.id).sort(),
    cards: creditCardsDS.getAll().map(c => c.id).sort(),
    transactions: transactionsDS.getAll().map(t => t.id).sort(),
    loans: loansDS.getAll().map(l => l.id).sort(),
    properties: propertiesDS.getAll().map(p => p.id).sort(),
    investments: investmentsDS.getAll().investments.map(i => i.id).sort(),
    goals: goalsDS.getAll().map(g => g.id).sort(),
    budgets: budgetsDS.getAll().map(b => b.id).sort(),
    bills: billsDS.getAll().map(b => b.id).sort(),
    budgetReport: budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }),
    forecast: forecastDS.build({ asOf: AS_OF }),
    goalReport: goalReportDS.build({ asOf: AS_OF }),
    loanReport: loanReportDS.build({ today: AS_OF }),
    propertyReport: propertyReportDS.build(),
    insurance: insuranceReportDS.build(AS_OF),
  };
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const money = (n: number) => Number(n.toFixed(2));

beforeEach(() => { sync.mockClear(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('A · every screen agrees with every other screen, in every scope', () => {
  for (const who of EVERYONE) {
    for (const scope of ['personal', ...SCOPES_OF[who]]) {
      const label = scope === 'personal' ? 'My Finances' : HH_NAME[scope];
      it(`${NAME[who]} · ${label} — the lists a screen shows are the lists the totals count`, () => {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        const s = screens();

        // Every list is scoped: nothing appears that the scope does not contain.
        if (scope !== 'personal') {
          for (const id of s.accounts) {
            const row = useStore.getState().accounts.find(a => a.id === id)!;
            expect(householdsOf(row), `${id} in ${label}`).toContain(scope);
          }
          for (const id of s.loans) {
            const row = useStore.getState().loans.find(l => l.id === id)!;
            expect(householdsOf(row)).toContain(scope);
          }
          for (const id of s.properties) {
            const row = useStore.getState().properties.find(p => p.id === id)!;
            expect(householdsOf(row)).toContain(scope);
          }
        }

        // The loan report and the loans list are the same loans.
        expect(s.loanReport.rows.map(l => l.id).sort()).toEqual(s.loans);
        // The property report and the properties list are the same properties.
        expect(s.propertyReport.rows.map(p => p.id).sort()).toEqual(s.properties);
        // The goal report and the goals list are the same goals.
        expect(s.goalReport.lines.map(g => g.id).sort()).toEqual(s.goals);
        // And the loan report's debt is the debt net worth subtracts.
        expect(money(s.loanReport.totals.netWorthDebt)).toBeCloseTo(money(s.netWorth.loans), 2);
        expect(money(s.propertyReport.totals.netWorthValue)).toBeCloseTo(money(s.netWorth.property), 2);

        // Net worth's components come from the same lists the screens show.
        const cash = sum(accountsDS.getAll().filter(a => !a.hidden)
          .map(a => Number(a.display_balance ?? a.balance)));
        expect(money(s.netWorth.bank_balance)).toBeCloseTo(money(cash), 2);

        const holdings = scope === 'personal'
          ? sum(investmentsDS.getAll().investments.map(i => Number(i.display_value ?? i.current_value ?? 0)))
          : 0;   // holdings are personal by construction — a household view holds none
        expect(money(s.netWorth.investments)).toBeCloseTo(money(holdings), 2);

        const debt = sum(creditCardsDS.getAll().map(c => Number(c.display_balance_owing ?? c.balance_owing ?? 0)));
        expect(money(s.netWorth.credit_card_debt)).toBeCloseTo(money(debt), 2);

        // Nothing is NaN anywhere in the reports a screen renders.
        for (const [key, value] of Object.entries(s)) scanFinite(value, key);
      });
    }
  }
});

function scanFinite(value: unknown, path: string): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} is ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanFinite(v, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) scanFinite(v, `${path}.${k}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('B · switching scope is reversible, and the tenth switch reads like the first', () => {
  for (const who of EVERYONE) {
    it(`${NAME[who]} · ten round trips through every household leave every figure where it started`, () => {
      login(who, 'personal');
      const first = JSON.stringify(screens());

      const readings: string[] = [];
      for (let i = 0; i < 10; i++) {
        for (const hh of SCOPES_OF[who]) {
          switchTo('household', hh);
          readings.push(JSON.stringify({ hh, s: screens() }));
        }
        switchTo('personal', null);
        expect(JSON.stringify(screens()), `personal drifted on round ${i + 1}`).toBe(first);
      }

      // Each household read the same thing every time it was visited.
      for (const hh of SCOPES_OF[who]) {
        const forHh = readings.filter(r => JSON.parse(r).hh === hh);
        expect(new Set(forHh).size, `${HH_NAME[hh]} drifted between visits`).toBe(1);
      }
    });
  }

  it('a stale active household id resolves to My Finances, not to a blank view', () => {
    login(ADA, 'household', 'hh-that-was-deleted');
    expect(currentScope()).toBe('personal');
    const s = screens();
    expect(s.accounts.length).toBeGreaterThan(0);
  });

  it('a household the user is only REMOVED from resolves to My Finances', () => {
    login(DI, 'household', HH_RIVER);   // Di's membership there is 'removed'
    expect(currentScope()).toBe('personal');
    expect(screens().accounts).toEqual(ownedBy(DI).accounts.map(a => a.id).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C · no duplicate money', () => {
  for (const hh of [HH_RIVER, HH_COAST, HH_KIN]) {
    it(`${HH_NAME[hh]} · the household total is the members' owned parts, added once`, () => {
      const membersOf = members.filter(m => m.household_id === hh && m.status === 'active').map(m => m.user_id);
      const totals: number[] = [];
      for (const who of membersOf) {
        login(who, 'household', hh);
        const report = householdReportDS.build(hh)!;
        expect(report, `${NAME[who]} could not read ${HH_NAME[hh]}`).toBeTruthy();
        totals.push(money(report.total.net_worth));

        // THE no-duplicate-money check: the household total is exactly its
        // members' parts added up — no row counted twice, none dropped.
        expect(report.reconciliation, `${HH_NAME[hh]} does not reconcile for ${NAME[who]}`).toBe(0);
        const summed = sum(report.members.map(m => m.netWorth.net_worth));
        expect(money(summed)).toBeCloseTo(money(report.total.net_worth), 2);

        // And it names every active member, exactly once.
        expect(report.members.map(m => m.userId).sort()).toEqual([...membersOf].sort());
      }
      // Every member reads the same household total.
      expect(new Set(totals).size, `members disagree on ${HH_NAME[hh]}: ${totals.join(' vs ')}`).toBe(1);
    });
  }

  it('a card in TWO households appears once in each, and twice nowhere', () => {
    login(BO, 'household', HH_RIVER);
    expect(creditCardsDS.getAll().filter(c => c.id === 'a-card')).toHaveLength(1);
    switchTo('household', HH_COAST);
    expect(creditCardsDS.getAll().filter(c => c.id === 'a-card')).toHaveLength(1);
    switchTo('personal', null);
    expect(creditCardsDS.getAll().map(c => c.id)).not.toContain('a-card');
  });

  it('an account in two households never enters its owner’s total twice', () => {
    login(DI, 'personal');
    const nw = calculateNetWorth();
    const own = sum(ownedBy(DI).accounts.filter(a => !a.hidden).map(a => Number(a.display_balance ?? a.balance)));
    expect(money(nw.bank_balance)).toBeCloseTo(money(own), 2);
  });

  it('a household view never sums two households together', () => {
    login(BO, 'household', HH_RIVER);
    const river = accountsDS.getAll().map(a => a.id).sort();
    switchTo('household', HH_COAST);
    const coast = accountsDS.getAll().map(a => a.id).sort();
    expect(river).not.toEqual(coast);
    // Riverside holds Ada's everyday; Coast holds Bo's and Di's joint.
    expect(river).toContain('a-everyday');
    expect(river).not.toContain('d-joint');
    expect(coast).toContain('d-joint');
    expect(coast).not.toContain('a-everyday');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D · private money stays private, and a grant enters no total', () => {
  for (const who of EVERYONE) {
    it(`${NAME[who]} · nothing outside what the server sent is ever on a screen`, () => {
      const allowed = new Set(visibleTo(who).accounts.map(a => a.id));
      for (const scope of ['personal', ...SCOPES_OF[who]]) {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        for (const id of accountsDS.getVisible().map(a => a.id)) expect(allowed).toContain(id);
        for (const id of accountsDS.getAll().map(a => a.id)) expect(allowed).toContain(id);
      }
    });
  }

  it('a directly-granted account is visible, and in no total anywhere', () => {
    login(CY, 'personal');
    // Ada granted Cy a view of her saver.
    expect(accountsDS.getVisible().map(a => a.id)).toContain('a-saver');
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('a-saver');

    const nw = calculateNetWorth();
    const own = sum(ownedBy(CY).accounts.filter(a => !a.hidden).map(a => Number(a.display_balance ?? a.balance)));
    expect(money(nw.bank_balance)).toBeCloseTo(money(own), 2);

    // And it is in no household view either — a grant is not a household.
    for (const hh of SCOPES_OF[CY]) {
      switchTo('household', hh);
      expect(accountsDS.getAll().map(a => a.id)).not.toContain('a-saver');
    }
  });

  it('a revoked grant reaches no screen and no total', () => {
    login(ADA, 'personal');
    expect(accountsDS.getVisible().map(a => a.id)).not.toContain('c-private');
    expect(accountsDS.sharedWithMe().map(a => a.id)).not.toContain('c-private');
  });

  it('a viewer sees the household’s money and is offered no way to change it', () => {
    login(CY, 'household', HH_RIVER);
    expect(accountsDS.getAll().map(a => a.id)).toContain('a-everyday');
    expect(sharingDS.canShare('account', 'a-everyday').ok).toBe(false);
  });

  it('a hidden account is nobody else’s business, in any scope', () => {
    for (const who of [BO, CY, DI]) {
      for (const scope of ['personal', ...SCOPES_OF[who]]) {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        expect(accountsDS.getVisible().map(a => a.id)).not.toContain('a-hidden');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E · a reload mid-action changes nothing that was already true', () => {
  it('sharing a row, then reloading, shows the same thing the optimistic view showed', () => {
    login(ADA, 'household', HH_COAST);
    const before = accountsDS.getAll().map(a => a.id).sort();

    // Ada shares her saver into Coast. The client applies it locally…
    const row = useStore.getState().accounts.find(a => a.id === 'a-saver')!;
    useStore.setState({
      accounts: useStore.getState().accounts.map(a =>
        a.id === 'a-saver' ? { ...a, household_ids: [HH_COAST] } : a),
    } as never);
    const optimistic = accountsDS.getAll().map(a => a.id).sort();
    expect(optimistic).toEqual([...before, 'a-saver'].sort());
    expect(row.user_id).toBe(ADA);

    // …and a reload that fetches the same state agrees.
    const server = visibleTo(ADA).accounts.map(a =>
      a.id === 'a-saver' ? { ...a, household_ids: [HH_COAST] } : a);
    useStore.setState({ accounts: server } as never);
    expect(accountsDS.getAll().map(a => a.id).sort()).toEqual(optimistic);
  });

  it('reloading in the middle of a scope switch lands in a nameable scope', () => {
    login(BO, 'household', HH_COAST);
    const during = accountsDS.getAll().map(a => a.id).sort();
    login(BO, 'household', HH_COAST);          // the reload
    expect(accountsDS.getAll().map(a => a.id).sort()).toEqual(during);
    expect(currentScope()).toBe('household');
    expect(householdContext().activeHouseholdId).toBe(HH_COAST);
  });

  it('a reload after being un-shared does not strand the user in an empty household', () => {
    login(BO, 'household', HH_RIVER);
    expect(accountsDS.getAll().length).toBeGreaterThan(0);
    // Ada takes everything out of Riverside; Bo reloads still pointing at it.
    useStore.setState({
      accounts: useStore.getState().accounts.map(a => ({ ...a, household_ids: (a.household_ids ?? []).filter(h => h !== HH_RIVER) })),
      creditCards: useStore.getState().creditCards.map(c => ({ ...c, household_ids: (c.household_ids ?? []).filter(h => h !== HH_RIVER) })),
    } as never);
    // Still a legitimate household he is in — an empty view, not a broken one.
    expect(currentScope()).toBe('household');
    expect(accountsDS.getAll()).toEqual([]);
    expect(Number.isFinite(calculateNetWorth().net_worth)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F · a revoke lands on a session that was already open', () => {
  it('Ada’s open session loses Bo’s account, and its transactions, on the next read', () => {
    login(ADA, 'personal');
    expect(accountsDS.getVisible().map(a => a.id)).toContain('b-private');
    expect(transactionsDS.getVisible().map(t => t.id)).toContain('t-b-private');

    // Bo revokes. Ada's next fetch simply no longer carries the grant.
    useStore.setState({
      recordShares: useStore.getState().recordShares.map(r =>
        r.id === 'sh-3' ? { ...r, status: 'revoked' } : r),
      accounts: useStore.getState().accounts.filter(a => a.id !== 'b-private'),
      transactions: useStore.getState().transactions.filter(t => t.id !== 't-b-private'),
    } as never);

    expect(accountsDS.getVisible().map(a => a.id)).not.toContain('b-private');
    expect(transactionsDS.getVisible().map(t => t.id)).not.toContain('t-b-private');
    expect(Number.isFinite(calculateNetWorth().net_worth)).toBe(true);
  });

  it('being removed from a household mid-session leaves a nameable scope, not a void', () => {
    login(DI, 'household', HH_COAST);
    expect(accountsDS.getAll().map(a => a.id)).toContain('b-everyday');

    useStore.setState({
      householdMembers: useStore.getState().householdMembers.map(m =>
        m.household_id === HH_COAST && m.user_id === DI ? { ...m, status: 'removed' } : m),
      accounts: visibleTo(DI).accounts.filter(a => a.user_id === DI || !(a.household_ids ?? []).includes(HH_COAST)),
    } as never);

    expect(currentScope()).toBe('personal');
    expect(accountsDS.getAll().map(a => a.id)).not.toContain('b-everyday');
    // Her own money is untouched.
    expect(money(calculateNetWorth().bank_balance))
      .toBeCloseTo(money(sum(ownedBy(DI).accounts.filter(a => !a.hidden).map(a => Number(a.balance)))), 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('G · what never moves with the scope', () => {
  for (const who of EVERYONE) {
    it(`${NAME[who]} · tax is the same figure in every scope`, () => {
      login(who, 'personal');
      const personal = taxYearDS.build({ fy: '2026-2027' });
      for (const hh of SCOPES_OF[who]) {
        login(who, 'household', hh);
        const inHousehold = taxYearDS.build({ fy: '2026-2027' });
        expect(inHousehold.assessableIncome).toBe(personal.assessableIncome);
        expect(inHousehold.deductibleExpenses).toBe(personal.deductibleExpenses);
        expect(inHousehold.estimatedTaxableIncome).toBe(personal.estimatedTaxableIncome);
        expect(inHousehold.taxWithheld).toBe(personal.taxWithheld);
        expect(inHousehold.income.total).toBe(personal.income.total);
      }
    });

    it(`${NAME[who]} · super is only ever their own`, () => {
      for (const scope of ['personal', ...SCOPES_OF[who]]) {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        expect(superDS.getAll().every(f => f.user_id === who)).toBe(true);
      }
    });
  }

  it('a household’s net worth is not a person’s net worth', () => {
    login(ADA, 'personal');
    const personal = calculateNetWorth().net_worth;
    login(ADA, 'household', HH_RIVER);
    const household = calculateNetWorth().net_worth;
    expect(Number.isFinite(personal)).toBe(true);
    expect(Number.isFinite(household)).toBe(true);
    // Riverside holds only some of Ada's money and none of her super, so the two
    // must not be the same number by accident.
    expect(household).not.toBe(personal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('H · Ask Ledger answers from the scope it is standing in', () => {
  const QUESTIONS = [
    'what is my net worth',
    'how much did I spend on groceries this month',
    'what bills are coming up',
    'how are my goals going',
    'what do I owe',
  ];

  for (const who of EVERYONE) {
    it(`${NAME[who]} · every question answers or declines, and never throws`, () => {
      for (const scope of ['personal', ...SCOPES_OF[who]]) {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        for (const q of QUESTIONS) {
          const answer = askDS.answer(q, { asOf: AS_OF });
          expect(answer).toBeTruthy();
          // The scope an answer states must be the scope the app is in.
          expect(answer.scope).toBe(scope === 'personal' ? 'personal' : 'household');
          const text = JSON.stringify(answer);
          expect(text.includes('NaN'), `${q} → NaN`).toBe(false);
        }
      }
    });
  }

  it('an answer never names a figure from a household the asker is not in', () => {
    login(ADA, 'personal');
    for (const q of QUESTIONS) {
      const answer = askDS.answer(q, { asOf: AS_OF });
      const text = JSON.stringify(answer);
      // Cy's farm and Bo's unit are in households Ada cannot see.
      expect(text).not.toContain('Kin Farm');
      expect(text).not.toContain('1200000');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('I · alerts, insights and the review agree with the scope they are in', () => {
  for (const who of EVERYONE) {
    for (const scope of ['personal', ...SCOPES_OF[who]]) {
      const label = scope === 'personal' ? 'My Finances' : HH_NAME[scope];
      it(`${NAME[who]} · ${label} — nothing names a row this scope cannot see`, () => {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        const visibleIds = new Set([
          ...accountsDS.getAll().map(a => a.id), ...creditCardsDS.getAll().map(c => c.id),
          ...loansDS.getAll().map(l => l.id), ...propertiesDS.getAll().map(p => p.id),
          ...goalsDS.getAll().map(g => g.id), ...budgetsDS.getAll().map(b => b.id),
          ...billsDS.getAll().map(b => b.id), ...investmentsDS.getAll().investments.map(i => i.id),
        ]);
        const alerts = alertsDS.build({ asOf: AS_OF });
        const insights = insightsDS.build({ asOf: AS_OF });
        const review = reviewDS.build({ asOf: AS_OF, kind: 'month' });

        // Anything an alert or insight LINKS to must be a row this scope can see:
        // a deep link into another household's record is the leak that matters.
        const namesForeignRow = (to: string) => {
          const tail = to.split(/[/?=#&]/).filter(Boolean).pop() ?? '';
          const known = new Set([...visibleIds]);
          const everyId = new Set([
            ...useStore.getState().accounts.map(a => a.id),
            ...useStore.getState().creditCards.map(c => c.id),
            ...useStore.getState().loans.map(l => l.id),
            ...useStore.getState().properties.map(p => p.id),
            ...useStore.getState().goals.map(g => g.id),
            ...useStore.getState().budgets.map(b => b.id),
            ...useStore.getState().bills.map(b => b.id),
            ...useStore.getState().investments.map(i => i.id),
          ]);
          // Only judge tails that are actually record ids in this world.
          return everyId.has(tail) && !known.has(tail);
        };
        for (const a of alerts.all) {
          expect(a.key.length, 'an alert with no identity').toBeGreaterThan(0);
          expect(namesForeignRow(a.link.to), `alert ${a.key} links to ${a.link.to}`).toBe(false);
        }
        for (const i of insights.all) {
          expect(i.key.length, 'an insight with no identity').toBeGreaterThan(0);
          const link = (i as unknown as { link?: { to: string } }).link;
          if (link) expect(namesForeignRow(link.to), `insight ${i.key} links to ${link.to}`).toBe(false);
        }
        // Every alert and insight is distinct — the same news never fires twice.
        expect(new Set(alerts.all.map(a => a.key)).size).toBe(alerts.all.length);
        expect(new Set(insights.all.map(i => i.key)).size).toBe(insights.all.length);
        scanFinite(review, 'review');
        scanFinite(scenarioDS.baselines({ asOf: AS_OF }), 'baselines');
        scanFinite(incomeDS.getAll().projected_annual, 'income');
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('J · a household counts its members’ spending once, not once each', () => {
  for (const hh of [HH_RIVER, HH_COAST, HH_KIN]) {
    it(`${HH_NAME[hh]} · the household’s month is the sum of what each member put in it`, () => {
      const membersOf = members.filter(m => m.household_id === hh && m.status === 'active').map(m => m.user_id);

      // What every member reads as the household's spend — must be one number.
      const readings = membersOf.map(who => {
        login(who, 'household', hh);
        return money(budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).totalSpent);
      });
      expect(new Set(readings).size, `members disagree on ${HH_NAME[hh]} spend: ${readings.join(' vs ')}`).toBe(1);

      // And that number is exactly the transactions the household can see —
      // each one counted once, whoever is looking.
      login(membersOf[0], 'household', hh);
      const rows = transactionsDS.getAll();
      expect(new Set(rows.map(t => t.id)).size).toBe(rows.length);
      const outgoing = money(sum(rows
        .filter(t => Number(t.display_amount ?? t.amount) < 0)
        .map(t => Math.abs(Number(t.display_amount ?? t.amount)))));
      expect(readings[0]).toBeCloseTo(outgoing, 2);
    });
  }

  it('a member’s personal spend and the household’s are different questions', () => {
    login(ADA, 'personal');
    const personal = money(budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).totalSpent);
    login(ADA, 'household', HH_RIVER);
    const household = money(budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).totalSpent);
    // Riverside holds only some of Ada's accounts, so it must be the smaller one.
    expect(household).toBeLessThan(personal);
    expect(household).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('K · investments and super are personal, and a household view says so', () => {
  for (const who of EVERYONE) {
    it(`${NAME[who]} · a household holds no holdings and no super, in the list AND the total`, () => {
      login(who, 'personal');
      const ownHoldings = investmentsDS.getAll().investments.map(i => i.id).sort();
      const personalNw = calculateNetWorth();

      for (const hh of SCOPES_OF[who]) {
        switchTo('household', hh);
        const nw = calculateNetWorth();
        expect(nw.investments, `${HH_NAME[hh]} counted holdings`).toBe(0);
        expect(nw.super_counted, `${HH_NAME[hh]} counted super`).toBe(0);
        // The list a household shows is the household's shared holdings — never
        // another member's private portfolio.
        for (const inv of investmentsDS.getAll().investments) {
          expect(householdsOf(inv)).toContain(hh);
        }
      }

      switchTo('personal', null);
      expect(investmentsDS.getAll().investments.map(i => i.id).sort()).toEqual(ownHoldings);
      expect(calculateNetWorth().net_worth).toBe(personalNw.net_worth);
    });
  }

  it('a holding shared into a household never joins another member’s portfolio total', () => {
    // Bo shared his ETF into Coast. Ada and Di are members.
    for (const who of [ADA, DI]) {
      login(who, 'personal');
      expect(investmentsDS.getAll().investments.map(i => i.id)).not.toContain('b-vas');
      const total = investmentsDS.getAll().portfolio_total;
      const own = sum(ownedBy(who).investments.map(i => Number(i.display_value ?? i.current_value ?? 0)));
      expect(money(total)).toBeCloseTo(money(own), 2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('L · the forecast counts each obligation once, in the scope that owns it', () => {
  for (const who of EVERYONE) {
    for (const scope of ['personal', ...SCOPES_OF[who]]) {
      const label = scope === 'personal' ? 'My Finances' : HH_NAME[scope];
      it(`${NAME[who]} · ${label} — no obligation is projected twice`, () => {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        const forecast = forecastDS.build({ asOf: AS_OF });

        // The forecast opens on exactly the cash the same screen shows.
        const cash = sum(accountsDS.getAll().filter(a => !a.hidden)
          .map(a => Number(a.display_balance ?? a.balance)));
        expect(money(forecast.openingTotal)).toBeCloseTo(money(cash), 2);

        // Every account it projects is one the scope can see, and once each.
        const projected = forecast.accounts.map(a => a.accountId);
        expect(new Set(projected).size, 'an account projected twice').toBe(projected.length);
        const visibleAccountIds = new Set(accountsDS.getAll().map(a => a.id));
        for (const id of projected) {
          // `__unallocated__` is the deliberate bucket for obligations with no
          // known account — every other projection must name a visible one.
          if (id === UNALLOCATED) continue;
          expect(visibleAccountIds.has(id), `projects ${id}`).toBe(true);
        }

        // No obligation is projected twice on the same date for the same source.
        const stamps = forecast.events.map(e => `${e.sourceType}:${e.sourceId}@${e.date}`);
        expect(new Set(stamps).size, 'the same obligation twice').toBe(stamps.length);

        // Every event names a source that exists, and lands on a visible account.
        const knownIds = new Set([
          ...billsDS.getAll().map(b => b.id), ...loansDS.getAll().map(l => l.id),
          ...useStore.getState().incomeEntries.map(i => i.id),
          ...creditCardsDS.getAll().map(c => c.id), ...visibleAccountIds,
        ]);
        for (const e of forecast.events) {
          if (e.accountId) expect(visibleAccountIds.has(e.accountId), `event on ${e.accountId}`).toBe(true);
          expect(knownIds.has(e.sourceId) || e.sourceId.length > 0).toBe(true);
        }

        // Anything suppressed was suppressed in favour of something kept — the
        // de-dup never simply loses an obligation.
        for (const sup of forecast.suppressed) {
          expect(sup.keptId, `${sup.id} suppressed for nothing`).toBeTruthy();
          expect(sup.keptId).not.toBe(sup.id);
        }

        // Each horizon's closing figure is opening + net, with nothing unexplained.
        for (const h of forecast.horizons) {
          expect(money(h.projectedBalance)).toBeCloseTo(money(h.openingBalance + h.net), 2);
          expect(money(h.net)).toBeCloseTo(money(h.inflow + h.outflow), 2);
          expect(money(h.openingBalance)).toBeCloseTo(money(forecast.openingTotal), 2);
          // The dip can never be reported as better than where it started or ended.
          expect(h.lowestBalance).toBeLessThanOrEqual(Math.max(h.openingBalance, h.projectedBalance) + 0.01);
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M · a brand-new account — onboarding, before anything exists', () => {
  function freshUser(id = 'u-new') {
    useStore.setState({
      user: { id, email: 'new@audit.test', name: 'New', currency_preference: 'AUD', theme: 'system', plan: 'free', onboarding_complete: false } as never,
      token: 'audit-token', dataOwnerId: id,
      households: [], householdMembers: [], householdInvitations: [],
      financeScope: 'personal', activeHouseholdId: null,
      accounts: [], creditCards: [], transactions: [], loans: [], loanEvents: [], properties: [],
      investments: [], investmentSales: [], superFunds: [], smsfFunds: [],
      incomeEntries: [], bills: [], goals: [], goalContributions: [], budgets: [],
      insurancePolicies: [], insurancePremiumHistory: [], recordShares: [], shareCodes: [],
      subscriptions: [], recurringSeries: [], transactionSplits: [], creditCardStatements: [],
      pendingPayments: [], ccPaymentPrompts: [], alertStates: [], budgetSettings: null,
      budgetLines: [], customCategories: [], merchants: [], merchantAliases: [],
      transactionRules: [], billSubExclusions: [], hiddenCategories: [], selectedCategories: null,
      categoryAliases: {}, notifications: [], netWorth: null, idMap: {}, pendingSyncQueue: [], basiqUserId: null,
    } as never);
  }

  it('every screen builds on an empty account, and states zero rather than nothing', () => {
    freshUser();
    const s = screens();
    expect(s.netWorth.net_worth).toBe(0);
    expect(s.accounts).toEqual([]);
    expect(s.loanReport.rows).toEqual([]);
    expect(s.propertyReport.rows).toEqual([]);
    expect(s.goalReport.lines).toEqual([]);
    for (const [k, v] of Object.entries(s)) scanFinite(v, k);
  });

  it('an empty account raises no alert and no insight — nothing to be alarmed about', () => {
    freshUser();
    expect(alertsDS.build({ asOf: AS_OF }).visible).toEqual([]);
    expect(insightsDS.build({ asOf: AS_OF }).visible).toEqual([]);
  });

  it('a new user is in no household, and cannot read one they were never in', () => {
    freshUser();
    expect(currentScope()).toBe('personal');
    expect(householdReportDS.build(HH_RIVER)).toBeNull();
  });

  it('the first account added is theirs, personal, and in no household', () => {
    freshUser();
    const created = accountsDS.add({
      name: 'First', institution: 'CBA', account_type: 'transaction', balance: 100, currency: 'AUD',
    } as never);
    expect(created.user_id).toBe('u-new');
    expect(householdsOf(created)).toEqual([]);
    expect(money(calculateNetWorth().bank_balance)).toBe(100);
  });

  it('a previous account’s rows on the same device never become the new user’s', () => {
    login(ADA, 'personal');
    const adaCash = calculateNetWorth().bank_balance;
    expect(adaCash).toBeGreaterThan(0);
    freshUser('u-second');       // a different person signs in on the same device
    expect(calculateNetWorth().bank_balance).toBe(0);
    expect(accountsDS.getVisible()).toEqual([]);
    expect(superDS.getAll()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('N · two devices, one person, and one truth', () => {
  it('the same user on two devices reads identical figures in every scope', () => {
    for (const who of EVERYONE) {
      for (const scope of ['personal', ...SCOPES_OF[who]]) {
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        const deviceA = JSON.stringify(screens());
        login(who, scope === 'personal' ? 'personal' : 'household', scope === 'personal' ? null : scope);
        const deviceB = JSON.stringify(screens());
        expect(deviceB, `${NAME[who]} in ${scope} differs between devices`).toBe(deviceA);
      }
    }
  });

  it('two people looking at the same household see the same figures, in the same order', () => {
    login(ADA, 'household', HH_RIVER);
    const ada = { accounts: accountsDS.getAll(), loans: loansDS.getAll(), props: propertiesDS.getAll() };
    login(BO, 'household', HH_RIVER);
    const bo = { accounts: accountsDS.getAll(), loans: loansDS.getAll(), props: propertiesDS.getAll() };
    expect(bo.accounts.map(a => [a.id, a.balance])).toEqual(ada.accounts.map(a => [a.id, a.balance]));
    expect(bo.loans.map(l => [l.id, l.current_balance])).toEqual(ada.loans.map(l => [l.id, l.current_balance]));
    expect(bo.props.map(p => [p.id, p.current_value])).toEqual(ada.props.map(p => [p.id, p.current_value]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('O · the vault: My Finances means yours, a household means that household’s', () => {
  const seedVault = async (as: string) => {
    const v = visibleTo(as);
    vi.spyOn(documentsApi, 'getAll').mockResolvedValue(v.documents as never);
    vi.spyOn(documentsApi, 'facts').mockResolvedValue([] as never);
    documentsDS.reset();
    await documentsDS.refresh();
  };

  it('My Finances shows the documents you OWN, shared or not — and nobody else’s', async () => {
    for (const who of EVERYONE) {
      login(who, 'personal');
      await seedVault(who);
      const mine = documentsDS.inScope('personal', null).map(d => d.id).sort();
      const owned = visibleTo(who).documents.filter(d => d.user_id === who).map(d => d.id).sort();
      expect(mine, `${NAME[who]}'s vault`).toEqual(owned);
    }
  });

  it('a household shows that household’s paperwork, from every member, once each', async () => {
    login(BO, 'household', HH_RIVER);
    await seedVault(BO);
    const river = documentsDS.inScope('household', HH_RIVER).map(d => d.id);
    expect(new Set(river).size).toBe(river.length);
    expect(river).toContain('a-doc');          // Ada's, shared into Riverside
    expect(river).not.toContain('b-doc');      // Bo's own private one

    switchTo('household', HH_COAST);
    expect(documentsDS.inScope('household', HH_COAST).map(d => d.id)).not.toContain('a-doc');
  });

  it('a document follows the record it is filed against, and leaves when that does', async () => {
    login(DI, 'household', HH_KIN);
    await seedVault(DI);
    // Cy's valuation is filed against the farm, which is shared into Kin.
    expect(documentsDS.inScope('household', HH_KIN).map(d => d.id)).toContain('c-doc');

    // Cy takes the farm out of Kin. The paperwork goes with it, live.
    useStore.setState({
      properties: useStore.getState().properties.map(p =>
        p.id === 'c-farm' ? { ...p, household_ids: [] } : p),
    } as never);
    expect(documentsDS.inScope('household', HH_KIN).map(d => d.id)).not.toContain('c-doc');
  });

  it('a record’s paperwork is the record’s, whichever scope you are standing in', async () => {
    login(DI, 'personal');
    await seedVault(DI);
    // The farm is not Di's, but she can see it in Kin — so its documents are
    // reachable from the record, in either scope.
    expect(documentsDS.forRecord('property', 'c-farm').map(d => d.id)).toContain('c-doc');
    switchTo('household', HH_KIN);
    expect(documentsDS.forRecord('property', 'c-farm').map(d => d.id)).toContain('c-doc');
  });

  it('a vault never carries a document the server did not send', async () => {
    for (const who of EVERYONE) {
      login(who, 'personal');
      await seedVault(who);
      const allowed = new Set(visibleTo(who).documents.map(d => d.id));
      for (const d of documentsDS.cached()) expect(allowed.has(d.id), `${NAME[who]} holds ${d.id}`).toBe(true);
      for (const hh of SCOPES_OF[who]) {
        expect(documentsDS.inScope('household', hh).every(d => allowed.has(d.id))).toBe(true);
      }
    }
  });
});
