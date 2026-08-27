/**
 * NET-WORTH STABILITY AUDIT — several years across every asset class.
 *
 * The question this file asks, once per simulated day, is the only one that
 * matters about a net worth:
 *
 *     yesterday's net worth  +  the changes we can NAME  =  today's net worth
 *
 * Nothing else is allowed to move it. Every event the march makes carries the
 * dollar effect it is ENTITLED to have (a price move is worth units × Δprice ×
 * fx; a transfer is worth nothing; a repayment is worth the interest and not a
 * cent more), and the day's arithmetic has to land on that figure exactly. An
 * unexplained movement, a double count and a stale value all fail the same
 * assertion, from opposite directions.
 *
 * Alongside it runs an INDEPENDENT ORACLE: a second model of the same money,
 * built from units, prices, rates and balances the simulation controls, that
 * never reads app state. The step check catches drift; the oracle catches a
 * whole component being wrong in a way that drifts consistently.
 *
 * And every day, the screens are made to agree with each other:
 *
 *   Overview headline        vs  its own breakdown, added up
 *   Overview bank            vs  the Accounts page total
 *   Overview investments     vs  the Investments page total  vs  the store total
 *   Overview loans           vs  the Loans page debt total
 *   Overview property        vs  the Property report's net-worth line
 *
 * The march covers buys, sells, dividends, salary, spending, internal
 * transfers, card spend and repayment, scheduled/extra/redraw loan movements,
 * a rate change, property revaluation, super growth and contributions, FX on
 * both a foreign holding and a foreign bank account, sharing a row into a
 * household and taking it back, a bootstrap-shaped reload, and the deletion of
 * a record other rows still point at.
 *
 * AUDIT MODE. Findings are RECORDED, not fixed: the divergence log keeps the
 * FIRST event that caused each kind of divergence, so the report can name the
 * exact step where the figures parted company. Everything is deterministic —
 * same seed, same day, same cent.
 *
 * NOTHING HERE TOUCHES A REAL USER. Every id is `nw-` prefixed and invented.
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
  accountsDS, creditCardsDS, investmentsDS, superDS, salesDS, loansDS,
  propertiesDS, propertyReportDS, transactionsDS, calculateNetWorth,
  moveOwnerBalance, householdsDS, householdReportDS,
} from '../services/dataService';
import { useStore } from '../store';
import { periodInterest } from '../utils/loanEngine';
import { buildNetWorthSeries } from '../utils/netWorthSeries';
import { propertyNetWorthTotal } from '../utils/property';
import type {
  BankAccount, CreditCard, Loan, Property, SuperFund, Household, HouseholdMember,
} from '../types';
import { pricePath, fxPath, FIVE_YEARS, FX_FIVE_YEARS, round2 } from './marketSim';

// ── Identities ───────────────────────────────────────────────────────────────

const U = 'u-nwaudit';
const PARTNER = 'u-nwpartner';
const HH = 'hh-nwaudit';

const A_MAIN = 'nw-acc-main';       // AUD everyday
const A_SAVE = 'nw-acc-save';       // AUD savings, offsets the mortgage
const A_USD = 'nw-acc-usd';         // USD brokerage cash
const A_HIDE = 'nw-acc-hidden';     // hidden — in no total, ever
const CC_MAIN = 'nw-cc-main';
const CC_BIZ = 'nw-cc-biz';
const L_HOME = 'nw-loan-home';
const L_CAR = 'nw-loan-car';
const L_HECS = 'nw-loan-hecs';      // indexed: no interest, ever
const A_USD2 = 'nw-acc-usd2';
const SMSF = 'nw-smsf-1';
const P_SMSF = 'nw-prop-smsf-fund';
const P_HOME = 'nw-prop-home';
const P_INV = 'nw-prop-inv';        // 50% owned
const S_MAIN = 'nw-super-main';

/** Two calendar years and a bit, so two full drawdowns land inside the march. */
const DAYS = 900;
const DAY0_MS = Date.UTC(2024, 0, 2);
const isoDay = (day: number) => new Date(DAY0_MS + day * 86_400_000).toISOString().slice(0, 10);

// ── The independent oracle ───────────────────────────────────────────────────

interface OracleAccount { native: number; rate: number; hidden: boolean }
interface OracleCard { owing: number; rate: number }
interface OracleLoan { balance: number; counted: boolean }
interface OracleProp {
  value: number; share: number; counted: boolean; loanId: string | null;
  /** A fund the DEVICE holds is carrying this value, so the property adds none
   *  of it — but it still nets a mortgage the loans term skips. */
  inFund?: boolean;
}
interface OracleHolding { units: number; price: number; fx: number }

/**
 * A second model of the same money, built only from what the simulation itself
 * decided — never from app state. Where the app derives a figure, this derives
 * it a different way, so the two can only agree by both being right.
 */
class Oracle {
  accounts = new Map<string, OracleAccount>();
  cards = new Map<string, OracleCard>();
  loans = new Map<string, OracleLoan>();
  props = new Map<string, OracleProp>();
  holdings = new Map<string, OracleHolding>();
  superCounted = 0;
  superExcluded = 0;

  bank(): number {
    let t = 0;
    for (const a of this.accounts.values()) if (!a.hidden) t += a.native * a.rate;
    return round2(t);
  }

  cardDebt(): number {
    let t = 0;
    for (const c of this.cards.values()) t += c.owing * c.rate;
    return round2(t);
  }

  loanDebt(): number {
    let t = 0;
    for (const l of this.loans.values()) if (l.counted) t += l.balance;
    return round2(t);
  }

  investments(): number {
    let t = 0;
    for (const h of this.holdings.values()) t += round2(h.units * h.price * h.fx);
    return round2(t);
  }

  /**
   * The property line, worked out from the rule rather than from the engine:
   * a counted property adds its owned share, and nets its own mortgage only
   * when the loans term is not going to subtract it — and only if no other
   * property has netted that same balance already, because a debt is owed once
   * however many houses stand behind it.
   */
  property(): number {
    let t = 0;
    const netted = new Set<string>();
    for (const p of this.props.values()) {
      if (!p.counted) continue;
      let v = p.inFund ? 0 : p.value * p.share;
      if (p.loanId) {
        const l = this.loans.get(p.loanId);
        // No loan row at all → nothing to net; the debt left with the row.
        if (l && !l.counted && !netted.has(p.loanId)) {
          netted.add(p.loanId);
          v -= l.balance;
        }
      }
      t += round2(v);
    }
    return round2(t);
  }

  netWorth(): number {
    return round2(
      this.bank() + this.investments() + this.superCounted + this.property()
      - this.cardDebt() - this.loanDebt(),
    );
  }
}

// ── The divergence log ───────────────────────────────────────────────────────

interface Finding {
  kind: string;
  firstDay: number;
  firstEvent: string;
  actual: number;
  expected: number;
  diff: number;
  occurrences: number;
  worst: number;
}

/**
 * Records the FIRST event that caused each kind of divergence and keeps
 * counting after it, so the report can say both where a defect starts and how
 * far it eventually goes. Deliberately non-fatal: one bad component must not
 * hide the four hundred days behind it.
 */
class DivergenceLog {
  findings = new Map<string, Finding>();

  check(kind: string, actual: number, expected: number, tol: number, day: number, event: string): void {
    const diff = round2(actual - expected);
    if (Number.isFinite(actual) && Math.abs(diff) <= tol) return;
    const seen = this.findings.get(kind);
    if (seen) {
      seen.occurrences++;
      if (Math.abs(diff) > Math.abs(seen.worst)) seen.worst = diff;
      return;
    }
    this.findings.set(kind, {
      kind, firstDay: day, firstEvent: event, actual, expected, diff,
      occurrences: 1, worst: diff,
    });
  }

  get list(): Finding[] {
    return [...this.findings.values()].sort((a, b) => a.firstDay - b.firstDay);
  }

  report(): string {
    if (this.findings.size === 0) return 'no divergences';
    return this.list.map(f =>
      `[${f.kind}] first at day ${f.firstDay} (${isoDay(f.firstDay)}) on "${f.firstEvent}"\n`
      + `    actual=${f.actual} expected=${f.expected} diff=${f.diff}`
      + ` — recurred ${f.occurrences}×, worst ${f.worst}`,
    ).join('\n');
  }
}

// ── The world ────────────────────────────────────────────────────────────────

const acc = (o: Partial<BankAccount> & Pick<BankAccount, 'id' | 'name' | 'balance'>): BankAccount => ({
  user_id: U, institution: 'CBA', account_type: 'transaction', currency: 'AUD',
  is_manual: true, household_ids: [], ...o,
} as BankAccount);

const card = (o: Partial<CreditCard> & Pick<CreditCard, 'id' | 'name' | 'balance_owing'>): CreditCard => ({
  user_id: U, institution: 'Amex', credit_limit: 25_000, currency: 'AUD',
  is_manual: true, household_ids: [], ...o,
} as CreditCard);

const loan = (o: Partial<Loan> & Pick<Loan, 'id' | 'name' | 'current_balance'>): Loan => ({
  user_id: U, loan_type: 'mortgage', original_amount: 900_000, interest_rate: 6.04,
  minimum_repayment: 4_800, repayment_frequency: 'monthly', next_due_date: null,
  include_in_net_worth: true, household_ids: [], start_date: '2019-03-01',
  term_months: 360, redraw_available: 0, ...o,
} as Loan);

const prop = (o: Partial<Property> & Pick<Property, 'id' | 'current_value'>): Property => ({
  user_id: U, name: null, address_unit: null, address_street: '1 Audit St',
  address_suburb: 'Bondi', address_state: 'NSW', address_postcode: '2026',
  address_country: 'Australia', property_type: 'home', held_by: 'personal',
  purchase_price: 800_000, ownership_percent: 100, include_in_net_worth: true,
  household_ids: [], loan_id: null, ...o,
} as Property);

/** The store as a fresh bootstrap would leave it — one user, no households. */
function seedWorld(): void {
  useStore.setState({
    user: {
      id: U, email: 'audit@example.test', name: 'Audit Subject',
      currency_preference: 'AUD', theme: 'system', plan: 'premium',
      onboarding_complete: true,
    } as never,
    token: 'stress-token',
    dataOwnerId: U,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [
      acc({ id: A_MAIN, name: 'Everyday', balance: 18_400 }),
      acc({ id: A_SAVE, name: 'Offset saver', balance: 120_000, account_type: 'savings' }),
      acc({
        id: A_USD, name: 'US brokerage cash', balance: 25_000, currency: 'USD',
        display_balance: 38_000, display_currency: 'AUD', conversion_rate: 1.52,
        institution: 'Interactive Brokers',
      }),
      acc({ id: A_HIDE, name: 'Closed 2019 account', balance: 91_000, hidden: true }),
    ] as BankAccount[],
    creditCards: [
      card({ id: CC_MAIN, name: 'Amex Platinum', balance_owing: 4_210.55, minimum_payment: 200 }),
      card({ id: CC_BIZ, name: 'Business Visa', balance_owing: 0, credit_limit: 15_000 }),
    ] as CreditCard[],
    loans: [
      loan({
        id: L_HOME, name: 'Home mortgage', current_balance: 742_300,
        offset_account_id: A_SAVE, redraw_available: 12_000,
      }),
      loan({
        id: L_CAR, name: 'Car loan', loan_type: 'car', current_balance: 21_800,
        original_amount: 34_000, interest_rate: 9.45, minimum_repayment: 640,
        term_months: 60, start_date: '2023-02-01',
      }),
      loan({
        id: L_HECS, name: 'HECS-HELP', loan_type: 'hecs', current_balance: 38_900,
        original_amount: 52_000, interest_rate: null as unknown as number,
        minimum_repayment: 0, repayment_frequency: 'fortnightly',
      }),
    ] as Loan[],
    loanEvents: [],
    properties: [
      prop({
        id: P_HOME, name: 'Home', current_value: 1_640_000, purchase_price: 1_100_000,
        purchase_date: '2019-03-01', loan_id: L_HOME, property_type: 'home',
      }),
      prop({
        id: P_INV, name: 'Coastal unit', current_value: 880_000, purchase_price: 610_000,
        purchase_date: '2021-09-15', ownership_percent: 50, property_type: 'investment',
        address_street: '12 Ocean Pde', address_suburb: 'Coolangatta',
      }),
    ] as Property[],
    investments: [], investmentSales: [], superFunds: [], smsfFunds: [],
    transactions: [], subscriptions: [], incomeEntries: [],
    bills: [], goals: [], goalContributions: [],
    insurancePolicies: [], insurancePremiumHistory: [],
    budgets: [], recordShares: [], shareCodes: [], recurringSeries: [],
    transactionSplits: [], creditCardStatements: [], pendingPayments: [],
    ccPaymentPrompts: [], alertStates: [], budgetSettings: null,
    budgetLines: [], customCategories: [], merchants: [], merchantAliases: [],
    transactionRules: [], billSubExclusions: [], hiddenCategories: [],
    selectedCategories: null, categoryAliases: {}, notifications: [],
    netWorth: null, idMap: {}, pendingSyncQueue: [],
    basiqUserId: null,
  } as never);
}

// ── Holdings the march builds on day 0 ───────────────────────────────────────

interface HoldingSpec {
  key: string; name: string; ticker?: string; market: string; asset_type: string;
  units: number; price0: number; seed: number; currency: 'AUD' | 'USD';
  cost0: number; divPerUnitQ: number; volScale?: number; fixed?: boolean;
}

const HOLDINGS: HoldingSpec[] = [
  { key: 'vas', name: 'Vanguard Australian Shares', ticker: 'VAS', market: 'ASX', asset_type: 'etf', units: 1_400, price0: 101.4, seed: 4101, currency: 'AUD', cost0: 112_000, divPerUnitQ: 0.95 },
  { key: 'vts', name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE', asset_type: 'etf', units: 400, price0: 310.5, seed: 4102, currency: 'USD', cost0: 91_200, divPerUnitQ: 0.85 },
  { key: 'btc', name: 'Bitcoin', ticker: 'BTC', market: 'CRYPTO', asset_type: 'crypto', units: 0.85, price0: 148_000, seed: 4103, currency: 'AUD', cost0: 42_000, divPerUnitQ: 0, volScale: 2.4 },
  { key: 'cash', name: 'Brokerage cash', market: 'CASH', asset_type: 'cash', units: 1, price0: 9_000, seed: 4104, currency: 'AUD', cost0: 9_000, divPerUnitQ: 0, fixed: true },
];

const SUPER0 = 386_500;
/** The SMSF's assets, summed — the balance the API reports for the fund. */
const SMSF0 = 1_480_000;

// ── The march ────────────────────────────────────────────────────────────────

interface StepEvent { label: string; nwDelta: number }

interface MarchOptions {
  /** Replay the Investments page's own write-back after every mutating day. */
  pageMirrors?: boolean;
  /** Reload (bootstrap-shaped round trip) every N days. 0 = never. */
  reloadEvery?: number;
}

interface MarchResult {
  log: DivergenceLog;
  finalNw: number;
  minNw: number;
  maxNw: number;
  days: number;
}

/**
 * A bootstrap-shaped reload.
 *
 * The server hands back the STORED columns and re-stamps the display fields it
 * owns; everything the client derived in memory (enriched investment rows, the
 * running portfolio total, the net-worth snapshot) is gone. If a figure only
 * survives because something recomputed it on a page visit, this is where it
 * disappears.
 */
function reload(): void {
  const s = useStore.getState();
  s.setInvestments(s.investments.map(i => {
    const row = { ...i } as Record<string, unknown>;
    delete row.display_value;
    delete row.display_cost;
    delete row.verification;
    delete row.profit_loss;
    return row;
  }) as never);
  // Server re-stamps a foreign account's display balance at the CURRENT rate.
  s.setAccounts(s.accounts.map(a => (
    a.currency && a.currency !== 'AUD'
      ? { ...a, display_balance: round2((a.balance ?? 0) * (a.conversion_rate ?? 1)) }
      : a
  )));
  s.setCreditCards(s.creditCards.map(c => (
    c.currency && c.currency !== 'AUD'
      ? { ...c, display_balance_owing: round2((c.balance_owing ?? 0) * (c.conversion_rate ?? 1)) }
      : c
  )));
  // The net-worth snapshot is not persisted, so a reload clears it. (There used
  // to be a persisted `portfolioTotal` to reason about here too; it was a second
  // total nothing read, and it is gone — finding L2.)
  useStore.setState({ netWorth: null } as never);
}

function march(opts: MarchOptions = {}): MarchResult {
  seedWorld();
  const log = new DivergenceLog();
  const oracle = new Oracle();

  const fx = fxPath(4200, 1.52, 1.10, 1.95, FX_FIVE_YEARS);
  const superPath = pricePath(4300, 100, FIVE_YEARS);
  const smsfPath = pricePath(4302, 100, FIVE_YEARS);
  const homePath = pricePath(4400, 1_640_000, [{ days: 1_900, drift: 0.00035, vol: 0.0015 }]);
  const invPath = pricePath(4401, 880_000, [{ days: 1_900, drift: 0.00025, vol: 0.0022 }]);

  // Oracle: opening positions, in the same units the app stores.
  oracle.accounts.set(A_MAIN, { native: 18_400, rate: 1, hidden: false });
  oracle.accounts.set(A_SAVE, { native: 120_000, rate: 1, hidden: false });
  oracle.accounts.set(A_USD, { native: 25_000, rate: 1.52, hidden: false });
  oracle.accounts.set(A_HIDE, { native: 91_000, rate: 1, hidden: true });
  oracle.cards.set(CC_MAIN, { owing: 4_210.55, rate: 1 });
  oracle.cards.set(CC_BIZ, { owing: 0, rate: 1 });
  oracle.loans.set(L_HOME, { balance: 742_300, counted: true });
  oracle.loans.set(L_CAR, { balance: 21_800, counted: true });
  oracle.loans.set(L_HECS, { balance: 38_900, counted: true });
  oracle.props.set(P_HOME, { value: 1_640_000, share: 1, counted: true, loanId: L_HOME });
  oracle.props.set(P_INV, { value: 880_000, share: 0.5, counted: true, loanId: null });
  // The warehouse the SMSF holds: worth 1.2m, adds none of it here, because the
  // fund's balance below is carrying it. Counted exactly once, for 900 days.
  oracle.props.set(P_SMSF, {
    value: 1_200_000, share: 1, counted: true, loanId: null, inFund: true,
  });

  // Day 0 — build the portfolio and the super fund through the real services.
  const paths = new Map<string, number[] | null>();
  const ids = new Map<string, string>();
  for (const h of HOLDINGS) {
    const path = h.fixed ? null : pricePath(
      h.seed, h.price0,
      FIVE_YEARS.map(r => ({ ...r, vol: r.vol * (h.volScale ?? 1) })),
    );
    paths.set(h.key, path);
    const rec = investmentsDS.add({
      name: h.name, ticker: h.ticker, market: h.market, asset_type: h.asset_type,
      shares_owned: h.units, cost_basis: h.cost0,
      native_currency: h.currency, cost_basis_currency: h.currency,
      conversion_rate: h.currency === 'USD' ? fx[0] : 1,
      is_dividend_paying: h.divPerUnitQ > 0, current_price: h.price0,
    } as never);
    ids.set(h.key, rec.id);
    oracle.holdings.set(h.key, {
      units: h.units, price: h.price0, fx: h.currency === 'USD' ? fx[0] : 1,
    });
  }

  const superId = superDS.add({
    fund_name: 'Audit Super', balance: SUPER0,
    employer_contributions: 0, personal_contributions: 0,
    include_in_investments: true, include_in_net_worth: true,
  } as never).id;
  // The SMSF: a fund the device actually holds, its balance the assets summed —
  // which is what lets the warehouse below defer to it instead of vanishing.
  useStore.getState().setSmsfFunds([{
    id: SMSF, user_id: U, name: 'Audit Family SMSF',
    include_in_net_worth: true, balance: SMSF0,
  }]);
  propertiesDS.add(prop({
    id: P_SMSF, current_value: 1_200_000, name: 'Warehouse',
    property_type: 'commercial', held_by: 'smsf', smsf_fund_id: SMSF,
    counted_in_fund_balance: true, purchase_price: 900_000,
  }) as never);
  // Two funds, tracked apart: the regular one grows on its own path and the
  // SMSF on another. `oracle.superCounted` is what net worth should show for
  // both together — the sum the app has to arrive at from two slices.
  let superBal = SUPER0;
  oracle.superCounted = SUPER0 + SMSF0;

  const priceOf = (key: string, day: number) => {
    const p = paths.get(key);
    return p ? p[day] : HOLDINGS.find(h => h.key === key)!.price0;
  };
  const fxOf = (key: string, day: number) =>
    HOLDINGS.find(h => h.key === key)!.currency === 'USD' ? fx[day] : 1;

  const mirror = () => {
    if (!opts.pageMirrors) return;
    const { all } = investmentsDS.enrichAll();
    useStore.getState().setInvestments(all as never);
  };
  mirror();

  let minNw = Infinity;
  let maxNw = -Infinity;
  let prevNw = calculateNetWorth().net_worth;

  for (let day = 1; day <= DAYS; day++) {
    const events: StepEvent[] = [];
    const date = isoDay(day);
    const push = (label: string, nwDelta: number) => events.push({ label, nwDelta: round2(nwDelta) });

    // ── Markets. Prices and FX move on the same day, through the same update
    //    the edit modal uses.
    for (const h of HOLDINGS) {
      const o = oracle.holdings.get(h.key);
      if (!o) continue;
      const px = priceOf(h.key, day);
      const rate = fxOf(h.key, day);
      const before = round2(o.units * o.price * o.fx);
      const after = round2(o.units * px * rate);
      if (before !== after) push(`price:${h.key}`, after - before);
      o.price = px; o.fx = rate;
      if (paths.get(h.key) || h.currency === 'USD') {
        investmentsDS.update(ids.get(h.key)!, {
          current_price: px,
          ...(h.currency === 'USD' ? { conversion_rate: rate } : {}),
        });
      }
    }

    // ── FX on the foreign BANK account. The rate the row carries is the rate the
    //    server last stamped, so moving it is an economic change of exactly the
    //    same kind as moving a foreign holding's rate.
    if (day % 7 === 3) {
      const rate = fx[day];
      // Every foreign account, not just the seeded one — a fetch re-stamps them
      // all on one basis, so an account created mid-march moves with the rest.
      for (const [id, o] of oracle.accounts) {
        const row = useStore.getState().accounts.find(a => a.id === id);
        if (!row || (row.currency ?? 'AUD') === 'AUD' || rate === o.rate) continue;
        push(`fx:${id}`, o.native * rate - o.native * o.rate);
        o.rate = rate;
        accountsDS.update(id, {
          conversion_rate: rate,
          display_balance: round2(o.native * rate),
        });
      }
    }

    // ── A foreign account opened ON THE DEVICE, with no rate of its own. It is
    //    worth its converted value from the moment it exists (finding N2): the
    //    rate comes from the USD account this device already holds.
    if (day === 150) {
      const usdRate = oracle.accounts.get(A_USD)!.rate;
      accountsDS.add({
        id: A_USD2, name: 'Second USD account', institution: 'Wise',
        account_type: 'transaction', currency: 'USD', balance: 12_000,
        household_ids: [],
      } as never);
      const created = useStore.getState().accounts.find(a => a.name === 'Second USD account')!;
      oracle.accounts.set(created.id, { native: 12_000, rate: usdRate, hidden: false });
      push('open-usd-account', 12_000 * usdRate);
    }

    // ── The SMSF's assets revalue. Super moves; the warehouse inside it does
    //    not move the property line by a cent, and is never counted twice.
    if (day % 45 === 21) {
      const funds = useStore.getState().smsfFunds;
      const cur = funds[0]?.balance ?? 0;
      const next = round2(cur * (smsfPath[day] / smsfPath[Math.max(0, day - 45)]));
      push('smsf-growth', next - cur);
      oracle.superCounted = round2(oracle.superCounted + (next - cur));
      useStore.getState().setSmsfFunds(funds.map(f => ({ ...f, balance: next })));
    }

    // ── TWO houses against ONE mortgage the loans term skips (finding N4).
    //    The investment property is re-linked to the home loan and the loan is
    //    switched out of net worth, so the property line has to net 742k-ish
    //    once between them — not once each. Restored later, both ways round.
    if (day === 500) {
      propertiesDS.update(P_INV, { loan_id: L_HOME });
      oracle.props.get(P_INV)!.loanId = L_HOME;
      push('relink-second-house', 0);
    }
    if (day === 505) {
      loansDS.update(L_HOME, { include_in_net_worth: false });
      oracle.loans.get(L_HOME)!.counted = false;
      // The debt moves from the loans term to the property term. Both are inside
      // net worth, so the total must not move at all.
      push('mortgage-out-of-net-worth', 0);
    }
    if (day === 660) {
      loansDS.update(L_HOME, { include_in_net_worth: true });
      oracle.loans.get(L_HOME)!.counted = true;
      push('mortgage-back-in-net-worth', 0);
    }
    if (day === 665) {
      propertiesDS.update(P_INV, { loan_id: null });
      oracle.props.get(P_INV)!.loanId = null;
      push('unlink-second-house', 0);
    }

    // ── Salary in, living costs out, both as real transactions.
    if (day % 14 === 4) {
      transactionsDS.add({
        account_id: A_MAIN, account_type: 'bank', date, merchant: 'Aurora Health',
        amount: 6_900, category: 'Income', transaction_type: 'income',
        currency: 'AUD', is_duplicate_flagged: false, is_subscription: false,
        household_ids: [],
      } as never);
      moveOwnerBalance(A_MAIN, 'bank', 6_900);
      oracle.accounts.get(A_MAIN)!.native += 6_900;
      push('salary', 6_900);
    }
    if (day % 3 === 1) {
      const spend = round2(120 + (day % 17) * 9.35);
      transactionsDS.add({
        account_id: CC_MAIN, account_type: 'credit_card', date, merchant: 'Woolworths',
        amount: -spend, category: 'Groceries', currency: 'AUD',
        is_duplicate_flagged: false, is_subscription: false, household_ids: [],
      } as never);
      moveOwnerBalance(CC_MAIN, 'credit_card', -spend);
      oracle.cards.get(CC_MAIN)!.owing += spend;
      push('card-spend', -spend);
    }

    // ── Internal transfer, both legs. Worth exactly nothing.
    if (day % 30 === 9) {
      transactionsDS.createTransfer({
        fromId: A_MAIN, fromType: 'bank', toId: A_SAVE, toType: 'bank',
        amount: 2_500, date, note: 'To offset',
      } as never);
      oracle.accounts.get(A_MAIN)!.native -= 2_500;
      oracle.accounts.get(A_SAVE)!.native += 2_500;
      push('transfer', 0);
    }

    // ── Card repayment from the bank. One debt movement, not two spends.
    if (day % 30 === 20) {
      const owing = oracle.cards.get(CC_MAIN)!.owing;
      const pay = round2(Math.min(owing, 3_000));
      if (pay > 0) {
        moveOwnerBalance(A_MAIN, 'bank', -pay);
        moveOwnerBalance(CC_MAIN, 'credit_card', pay);
        oracle.accounts.get(A_MAIN)!.native -= pay;
        oracle.cards.get(CC_MAIN)!.owing -= pay;
        push('card-repayment', 0);
      }
    }

    // ── Scheduled loan repayments. The cash leaves in full; only the PRINCIPAL
    //    comes off the debt, so net worth falls by the interest and nothing else.
    if (day % 30 === 12) {
      for (const id of [L_HOME, L_CAR]) {
        const row = useStore.getState().loans.find(l => l.id === id);
        if (!row) continue;                       // deleted earlier in the march
        const offsetBal = row.offset_account_id
          ? (useStore.getState().accounts.find(a => a.id === row.offset_account_id)?.balance ?? 0)
          : 0;
        // Interest worked out here, from the rate and the offset — not read back
        // from the split the app computed.
        const ppy = row.repayment_frequency === 'fortnightly' ? 26 : 12;
        const charged = Math.max(0, oracle.loans.get(id)!.balance - Math.max(0, offsetBal));
        const interest = round2(charged * ((row.interest_rate ?? 0) / 100 / ppy));
        const paid = row.minimum_repayment ?? 0;
        const payoff = round2(oracle.loans.get(id)!.balance + interest);
        const applied = round2(Math.min(paid, payoff));
        const principal = round2(Math.max(0, applied - interest));

        loansDS.markPaid(id, paid);
        moveOwnerBalance(A_MAIN, 'bank', -applied);
        oracle.accounts.get(A_MAIN)!.native -= applied;
        oracle.loans.get(id)!.balance = round2(oracle.loans.get(id)!.balance - principal);
        push(`repayment:${id}`, -(applied - principal));
      }
    }

    // ── Extra repayment: cash out, debt down by the same amount. Worth nothing.
    if (day === 210 || day === 640) {
      loansDS.recordExtraRepayment(L_HOME, 15_000, { date });
      moveOwnerBalance(A_MAIN, 'bank', -15_000);
      oracle.accounts.get(A_MAIN)!.native -= 15_000;
      oracle.loans.get(L_HOME)!.balance = round2(oracle.loans.get(L_HOME)!.balance - 15_000);
      push('extra-repayment', 0);
    }

    // ── Redraw: re-borrowing. Cash in, debt up. Also worth nothing.
    if (day === 400) {
      const before = useStore.getState().loans.find(l => l.id === L_HOME)!;
      const taken = Math.min(8_000, Math.max(0, before.redraw_available ?? 0));
      loansDS.recordRedraw(L_HOME, 8_000, { date });
      moveOwnerBalance(A_MAIN, 'bank', taken);
      oracle.accounts.get(A_MAIN)!.native += taken;
      oracle.loans.get(L_HOME)!.balance = round2(oracle.loans.get(L_HOME)!.balance + taken);
      push('redraw', 0);
    }

    // ── A rate change. Changes what future interest costs; changes no balance.
    if (day === 300) {
      loansDS.recordRateChange(L_HOME, 6.79, { date });
      push('rate-change', 0);
    }

    // ── Quarterly dividends, converted at the day's rate and banked.
    if (day % 91 === 45) {
      for (const h of HOLDINGS) {
        const o = oracle.holdings.get(h.key);
        if (!o || h.divPerUnitQ <= 0) continue;
        const div = round2(o.units * h.divPerUnitQ * fxOf(h.key, day));
        moveOwnerBalance(A_MAIN, 'bank', div);
        oracle.accounts.get(A_MAIN)!.native += div;
        push(`dividend:${h.key}`, div);
      }
    }

    // ── Super: monthly growth, quarterly contribution.
    if (day % 30 === 15) {
      const g = superPath[day] / superPath[Math.max(0, day - 30)];
      const next = round2(superBal * g);
      push('super-growth', next - superBal);
      oracle.superCounted = round2(oracle.superCounted + (next - superBal));
      superBal = next;
      superDS.update(superId, { balance: next });
    }
    if (day % 91 === 60) {
      superBal = round2(superBal + 3_400);
      push('super-contribution', 3_400);
      oracle.superCounted = round2(oracle.superCounted + 3_400);
      superDS.update(superId, { balance: superBal });
    }

    // ── Property revaluations. Only the OWNED share moves net worth.
    if (day % 60 === 25) {
      for (const [id, path] of [[P_HOME, homePath], [P_INV, invPath]] as const) {
        const o = oracle.props.get(id)!;
        const value = round2(path[day]);
        push(`revalue:${id}`, (value - o.value) * o.share);
        o.value = value;
        propertiesDS.update(id, { current_value: value });
      }
    }

    // ── Buys and sells, through the paths the pages use.
    if (day === 120 || day === 520) {
      const key = 'vas';
      const o = oracle.holdings.get(key)!;
      const q = 40;
      const costAud = round2(q * priceOf(key, day) * fxOf(key, day));
      const fee = 9.5;
      const row = useStore.getState().investments.find(i => i.id === ids.get(key))!;
      investmentsDS.update(row.id, {
        shares_owned: round2(o.units + q),
        cost_basis: round2((row.cost_basis ?? 0) + costAud),
      });
      o.units = round2(o.units + q);
      moveOwnerBalance(A_MAIN, 'bank', -(costAud + fee));
      oracle.accounts.get(A_MAIN)!.native -= (costAud + fee);
      push('buy:vas', -fee);
    }
    if (day === 330 || day === 700) {
      const key = 'btc';
      const o = oracle.holdings.get(key);
      if (o && o.units > 0.05) {
        const q = round2(o.units * 0.4);
        const inv = investmentsDS.getAll().investments.find(i => i.id === ids.get(key))!;
        const fraction = q / o.units;
        const proceeds = round2(q * priceOf(key, day) * fxOf(key, day));
        const fee = 19.95;
        salesDS.record({
          investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
          asset_type: inv.asset_type, market: inv.market, quantity: q,
          proceeds, fees: fee, cost_basis: round2((inv.cost_basis ?? 0) * fraction),
          acquired_date: isoDay(0), sale_date: date, currency: 'AUD',
        } as never);
        investmentsDS.update(inv.id, {
          shares_owned: round2(o.units - q),
          cost_basis: round2((inv.cost_basis ?? 0) * (1 - fraction)),
        });
        o.units = round2(o.units - q);
        const banked = round2(proceeds - fee);
        moveOwnerBalance(A_MAIN, 'bank', banked);
        oracle.accounts.get(A_MAIN)!.native += banked;
        push('sell:btc', -fee);
      }
    }

    // ── Share the investment property into a household, then take it back.
    //    Neither is an economic event: the personal total must not move.
    if (day === 450) {
      useStore.setState({
        households: [{ id: HH, name: 'Audit Household', created_by: U, currency: 'AUD' }] as Household[],
        householdMembers: [
          { id: `m-${HH}-${U}`, household_id: HH, user_id: U, role: 'owner', status: 'active', email: 'audit@example.test', name: 'Audit Subject' },
          { id: `m-${HH}-${PARTNER}`, household_id: HH, user_id: PARTNER, role: 'member', status: 'active', email: 'partner@example.test', name: 'Partner' },
        ] as HouseholdMember[],
      } as never);
      propertiesDS.update(P_INV, { household_ids: [HH] });
      accountsDS.update(A_MAIN, { household_ids: [HH] });
      push('share-into-household', 0);
    }
    if (day === 600) {
      propertiesDS.update(P_INV, { household_ids: [] });
      accountsDS.update(A_MAIN, { household_ids: [] });
      push('unshare', 0);
    }

    // ── Delete a loan other rows still point at. The debt really does go, and
    //    the house it was secured against must not silently absorb it.
    if (day === 760) {
      const gone = oracle.loans.get(L_CAR)!;
      push('delete-loan', gone.counted ? gone.balance : 0);
      oracle.loans.delete(L_CAR);
      loansDS.remove(L_CAR);
    }

    mirror();
    if (opts.reloadEvery && day % opts.reloadEvery === 0) {
      const before = calculateNetWorth().net_worth;
      reload();
      const after = calculateNetWorth().net_worth;
      log.check('reload-changes-net-worth', after, before, 0.005, day, 'bootstrap reload');
      push('reload', 0);
    }

    // ── The step identity: yesterday + what we can name = today.
    const nw = calculateNetWorth();
    const named = round2(events.reduce((t, e) => t + e.nwDelta, 0));
    const labels = events.map(e => e.label).join(' + ') || 'nothing';
    log.check('step-identity', nw.net_worth, round2(prevNw + named), 0.02, day, labels);

    // ── The oracle: every component, independently derived.
    log.check('oracle-bank', nw.bank_balance, oracle.bank(), 0.02, day, labels);
    log.check('oracle-cards', nw.credit_card_debt, oracle.cardDebt(), 0.02, day, labels);
    log.check('oracle-loans', nw.loans, oracle.loanDebt(), 0.02, day, labels);
    log.check('oracle-investments', nw.investments, oracle.investments(), 0.05, day, labels);
    log.check('oracle-property', nw.property, oracle.property(), 0.02, day, labels);
    log.check('oracle-super', nw.super, oracle.superCounted, 0.02, day, labels);
    log.check('oracle-net-worth', nw.net_worth, oracle.netWorth(), 0.10, day, labels);

    // ── The screens must agree with each other and with the headline.
    // `super_counted`, as the Overview tiles print it — see overviewLines.
    const breakdown = round2(
      nw.bank_balance + nw.investments + nw.super_counted + nw.property
      - nw.credit_card_debt - nw.loans,
    );
    log.check('breakdown-sums-to-headline', breakdown, nw.net_worth, 0.02, day, labels);
    // …and with nothing switched off, the two super figures are the same one.
    log.check('super-all-vs-counted', nw.super, nw.super_counted, 0.02, day, labels);

    const pageAccounts = accountsDS.getAll().filter(a => !a.hidden)
      .reduce((t, a) => t + (a.display_balance ?? a.balance), 0);
    log.check('accounts-page-vs-overview', round2(pageAccounts), nw.bank_balance, 0.02, day, labels);

    const pageCards = creditCardsDS.getAll()
      .reduce((t, c) => t + (c.display_balance_owing ?? c.balance_owing), 0);
    log.check('cards-page-vs-overview', round2(pageCards), nw.credit_card_debt, 0.02, day, labels);

    const { portfolio_total: pageTotal } = investmentsDS.getAll();
    log.check('investments-page-vs-overview', pageTotal, nw.investments, 0.05, day, labels);

    const loanTotal = loansDS.getAll()
      .filter(l => l.include_in_net_worth !== false)
      .reduce((t, l) => t + (l.current_balance || 0), 0);
    log.check('loans-page-vs-overview', round2(loanTotal), nw.loans, 0.02, day, labels);

    const report = propertyReportDS.build(date);
    log.check('property-report-vs-overview', report.totals.netWorthValue, nw.property, 0.02, day, labels);

    // A loan must never be netted twice. The portfolio's effect on net worth is
    // the property line LESS the mortgages the loans term subtracts for those
    // properties — each distinct loan once, counted loans only. (Restated: this
    // measured against `totals.debt`, every mortgage behind the portfolio, which
    // only equals the right answer while every one of them is opted IN. From
    // day 505 the home loan is switched out and the property line nets it
    // itself, so subtracting it here as well was the harness double-counting.)
    const propLoanIds = new Set(
      propertiesDS.getAll()
        .filter(p => p.include_in_net_worth !== false && p.loan_id)
        .map(p => p.loan_id as string),
    );
    const nettedByLoansTerm = round2(
      loansDS.getAll()
        .filter(l => propLoanIds.has(l.id) && l.include_in_net_worth !== false)
        .reduce((t, l) => t + (l.current_balance || 0), 0),
    );
    log.check(
      'property-effect-double-count',
      round2(report.totals.netWorthEffect),
      round2(nw.property - nettedByLoansTerm),
      0.02, day, labels,
    );


    prevNw = nw.net_worth;
    if (nw.net_worth < minNw) minNw = nw.net_worth;
    if (nw.net_worth > maxNw) maxNw = nw.net_worth;
  }

  return { log, finalNw: calculateNetWorth().net_worth, minNw, maxNw, days: DAYS };
}

// ═════════════════════════════════════════════════════════════════════════════
//  The runs
// ═════════════════════════════════════════════════════════════════════════════

beforeEach(() => { sync.mockClear(); });

describe(`net-worth stability — ${DAYS} days across every asset class`, () => {
  it('every day reconciles: yesterday + named changes = today, and no screen disagrees', () => {
    const { log } = march();
    expect(log.list, `\n${log.report()}`).toEqual([]);
  });

  it('holds when the Investments page mirrors after every day', () => {
    const { log } = march({ pageMirrors: true });
    expect(log.list, `\n${log.report()}`).toEqual([]);
  });

  it('holds across repeated reloads — nothing survives only in memory', () => {
    const { log } = march({ reloadEvery: 45 });
    expect(log.list, `\n${log.report()}`).toEqual([]);
  });

  it('is deterministic — same seed, same final net worth to the cent', () => {
    expect(march().finalNw).toBe(march().finalNw);
  });

  it('really did move: the march is not testing a flat line', () => {
    const { minNw, maxNw } = march();
    // If the world barely moves, the reconciliation above proves nothing.
    expect(maxNw - minNw).toBeGreaterThan(200_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Targeted scenarios — the switches, the links and the scopes
// ═════════════════════════════════════════════════════════════════════════════

/** The headline, and the breakdown as the Overview screen adds it up.
 *
 *  `super_counted`, mirroring pages/Overview.tsx after finding N1 was fixed:
 *  the tile row prints the super that FED the headline, not every fund the user
 *  holds. This helper exists to be the screen, so when the screen's field
 *  changed this followed it — the assertion below, that the tiles equal the
 *  number above them, is untouched and is the whole point. */
function overviewLines() {
  const nw = calculateNetWorth();
  return {
    nw,
    breakdown: round2(
      nw.bank_balance + nw.investments + nw.super_counted + nw.property
      - nw.credit_card_debt - nw.loans,
    ),
  };
}

describe('a super fund switched out of net worth', () => {
  // ── FINDING N1 (Critical) — FIXED ─────────────────────────────────────────
  // `netWorthFrom` reports TWO super figures and the Overview read the wrong
  // one. `net_worth` is built from `superBalCounted` (funds opted in), while the
  // snapshot's `super` field is `superBalAll` (every fund, toggle or no toggle)
  // — and pages/Overview.tsx printed `netWorth?.super` in the breakdown list
  // that sits directly beneath the headline, so one switched-off fund made the
  // tiles overstate themselves by its whole balance. The snapshot now also
  // carries `super_counted`, the term that actually fed the headline, and every
  // screen that re-states net worth as its parts reads that one.
  it('the breakdown the Overview prints still adds up to the headline', () => {
    seedWorld();
    superDS.add({
      fund_name: 'Counted', balance: 300_000, employer_contributions: 0,
      personal_contributions: 0, include_in_investments: true, include_in_net_worth: true,
    } as never);
    superDS.add({
      fund_name: 'Legacy fund — not in net worth', balance: 260_000,
      employer_contributions: 0, personal_contributions: 0,
      include_in_investments: false, include_in_net_worth: false,
    } as never);

    const { nw, breakdown } = overviewLines();
    expect(breakdown).toBeCloseTo(nw.net_worth, 2);
  });
});

describe('a mortgage switched out of net worth', () => {
  it('the debt is netted exactly once — by the property, since the loans term skips it', () => {
    seedWorld();
    const before = calculateNetWorth().net_worth;
    loansDS.update(L_HOME, { include_in_net_worth: false });
    const after = calculateNetWorth();

    // Switching a debt off does not make the money stop being owed: the property
    // it secures nets it instead, so the total must not move at all.
    expect(after.net_worth).toBeCloseTo(before, 2);
    // The car loan and HECS are still counted; only the mortgage left the term.
    expect(after.loans).toBeCloseTo(21_800 + 38_900, 2);
  });

  it('and the property report agrees with the Overview property line', () => {
    seedWorld();
    loansDS.update(L_HOME, { include_in_net_worth: false });
    const nw = calculateNetWorth();
    const report = propertyReportDS.build();
    expect(report.totals.netWorthValue).toBeCloseTo(nw.property, 2);
  });
});

describe('a property switched out of net worth', () => {
  it('drops the asset and leaves the debt owed', () => {
    seedWorld();
    const before = calculateNetWorth();
    propertiesDS.update(P_HOME, { include_in_net_worth: false });
    const after = calculateNetWorth();
    // The house leaves at its owned value; the mortgage stays on the loans side.
    expect(round2(before.net_worth - after.net_worth)).toBeCloseTo(1_640_000, 2);
    expect(after.loans).toBeCloseTo(before.loans, 2);
  });
});

describe('deleting a loan a property points at', () => {
  it('removes the debt once and leaves the house standing at its value', () => {
    seedWorld();
    const before = calculateNetWorth();
    loansDS.remove(L_HOME);
    const after = calculateNetWorth();
    expect(round2(after.net_worth - before.net_worth)).toBeCloseTo(742_300, 2);
    expect(after.property).toBeCloseTo(before.property, 2);
  });

  it('the orphaned link is cleared, so the report cannot resurrect the debt', () => {
    seedWorld();
    loansDS.remove(L_HOME);
    const report = propertyReportDS.build();
    expect(report.totals.debt).toBeCloseTo(0, 2);
    expect(report.totals.netWorthValue).toBeCloseTo(calculateNetWorth().property, 2);
  });
});

describe('a property pointing at a loan that never existed', () => {
  it('is worth its value and nothing is invented against it', () => {
    seedWorld();
    propertiesDS.update(P_INV, { loan_id: 'nw-loan-deleted' });
    const nw = calculateNetWorth();
    const expected = round2(1_640_000 + 880_000 * 0.5);
    expect(nw.property).toBeCloseTo(expected, 2);
  });
});

describe('a hidden account', () => {
  it('is in no total, on either screen', () => {
    seedWorld();
    const nw = calculateNetWorth();
    const pageTotal = accountsDS.getAll().filter(a => !a.hidden)
      .reduce((t, a) => t + (a.display_balance ?? a.balance), 0);
    expect(nw.bank_balance).toBeCloseTo(pageTotal, 2);
    // 18,400 + 120,000 + 38,000 (USD at 1.52). The hidden 91,000 is absent.
    expect(nw.bank_balance).toBeCloseTo(176_400, 2);
  });

  it('unhiding it adds exactly its balance, once', () => {
    seedWorld();
    const before = calculateNetWorth().net_worth;
    accountsDS.update(A_HIDE, { hidden: false });
    expect(round2(calculateNetWorth().net_worth - before)).toBeCloseTo(91_000, 2);
  });
});

describe('a foreign-currency bank account', () => {
  it('is counted at its converted value, not its native one', () => {
    seedWorld();
    const nw = calculateNetWorth();
    expect(nw.bank_balance).toBeCloseTo(18_400 + 120_000 + 38_000, 2);
  });

  it('a rate move changes what the cash is worth', () => {
    seedWorld();
    const before = calculateNetWorth().bank_balance;
    // The rate the row carries is the rate the server last stamped. Move it the
    // way a refresh would, and the AUD value of 25,000 USD must move with it.
    accountsDS.update(A_USD, { conversion_rate: 1.40, display_balance: round2(25_000 * 1.40) });
    const after = calculateNetWorth().bank_balance;
    expect(round2(after - before)).toBeCloseTo(round2(25_000 * (1.40 - 1.52)), 2);
  });

  it('a deposit in the native currency is converted before it reaches net worth', () => {
    seedWorld();
    const before = calculateNetWorth().bank_balance;
    moveOwnerBalance(A_USD, 'bank', 1_000);          // 1,000 USD
    const after = calculateNetWorth().bank_balance;
    expect(round2(after - before)).toBeCloseTo(1_520, 2);
  });
});

describe('sharing a row into a household', () => {
  function joinHousehold() {
    useStore.setState({
      households: [{ id: HH, name: 'Audit Household', created_by: U, currency: 'AUD' }] as Household[],
      householdMembers: [
        { id: `m-${HH}-${U}`, household_id: HH, user_id: U, role: 'owner', status: 'active', email: 'audit@example.test', name: 'Audit Subject' },
        { id: `m-${HH}-${PARTNER}`, household_id: HH, user_id: PARTNER, role: 'member', status: 'active', email: 'partner@example.test', name: 'Partner' },
      ] as HouseholdMember[],
    } as never);
  }

  it('changes nothing about the personal total, and taking it back changes nothing either', () => {
    seedWorld();
    joinHousehold();
    const before = calculateNetWorth().net_worth;

    accountsDS.update(A_MAIN, { household_ids: [HH] });
    propertiesDS.update(P_HOME, { household_ids: [HH] });
    loansDS.update(L_HOME, { household_ids: [HH] });
    expect(calculateNetWorth('personal').net_worth).toBeCloseTo(before, 2);

    accountsDS.update(A_MAIN, { household_ids: [] });
    propertiesDS.update(P_HOME, { household_ids: [] });
    loansDS.update(L_HOME, { household_ids: [] });
    expect(calculateNetWorth('personal').net_worth).toBeCloseTo(before, 2);
  });

  it('a house shared without its mortgage still nets the debt in the household view', () => {
    seedWorld();
    joinHousehold();
    propertiesDS.update(P_HOME, { household_ids: [HH] });  // the loan stays private
    householdsDS.switchTo(HH);

    const nw = calculateNetWorth('household');
    // The household sees the house and, one way or another, the debt against it:
    // a mortgaged home must never read as owned outright.
    expect(nw.property + (-nw.loans)).toBeCloseTo(1_640_000 - 742_300, 2);
  });

  it('the household total is exactly the sum of its members — no row counted twice', () => {
    seedWorld();
    joinHousehold();
    accountsDS.update(A_MAIN, { household_ids: [HH] });
    accountsDS.update(A_SAVE, { household_ids: [HH] });
    propertiesDS.update(P_HOME, { household_ids: [HH] });
    loansDS.update(L_HOME, { household_ids: [HH] });
    householdsDS.switchTo(HH);

    const report = householdReportDS.build(HH);
    expect(report).not.toBeNull();
    expect(report!.reconciliation).toBe(0);
  });
});

describe('the same rows, read twice', () => {
  it('net worth is a pure function of the store — calling it again changes nothing', () => {
    seedWorld();
    const a = calculateNetWorth();
    const b = calculateNetWorth();
    expect(b).toEqual(a);
  });

  it('a bootstrap-shaped reload lands on the same figure', () => {
    seedWorld();
    investmentsDS.add({
      name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE', asset_type: 'etf',
      shares_owned: 400, cost_basis: 91_200, native_currency: 'USD',
      cost_basis_currency: 'USD', conversion_rate: 1.52, current_price: 310.5,
    } as never);
    const { all } = investmentsDS.enrichAll();
    useStore.getState().setInvestments(all as never);

    const before = calculateNetWorth();
    reload();
    const after = calculateNetWorth();
    expect(after.net_worth).toBeCloseTo(before.net_worth, 2);
    expect(after.investments).toBeCloseTo(before.investments, 2);
  });
});

describe('the property term and the loans term, together', () => {
  it('a mortgaged house moves net worth by its equity, however the switches are set', () => {
    const combos: { loanCounted: boolean; propCounted: boolean; expected: number }[] = [
      { loanCounted: true, propCounted: true, expected: 1_640_000 - 742_300 },
      { loanCounted: false, propCounted: true, expected: 1_640_000 - 742_300 },
      // The asset is switched off; the debt is still owed.
      { loanCounted: true, propCounted: false, expected: -742_300 },
      // Both off: nothing counted at all.
      { loanCounted: false, propCounted: false, expected: 0 },
    ];

    for (const c of combos) {
      seedWorld();
      // Strip everything but the home and its mortgage so the effect is readable.
      const s = useStore.getState();
      s.setProperties(s.properties.filter(p => p.id === P_HOME));
      s.setLoans(s.loans.filter(l => l.id === L_HOME));
      s.setAccounts([]);
      s.setCreditCards([]);
      loansDS.update(L_HOME, { include_in_net_worth: c.loanCounted });
      propertiesDS.update(P_HOME, { include_in_net_worth: c.propCounted });

      const nw = calculateNetWorth();
      expect(
        nw.net_worth,
        `loan counted=${c.loanCounted} property counted=${c.propCounted}`,
      ).toBeCloseTo(c.expected, 2);
    }
  });

  it('propertyNetWorthTotal and the Overview property line are the same call', () => {
    seedWorld();
    const s = useStore.getState();
    const direct = propertyNetWorthTotal(s.properties, s.loans, s.loans);
    expect(calculateNetWorth().property).toBeCloseTo(direct, 2);
  });
});

describe('a property the SMSF balance already carries', () => {
  // Restated (N3): this linked `smsf_fund_id` to a row in `superFunds`, which is
  // a super fund, not an SMSF — the link never resolved and the property was
  // zeroed anyway, because the old rule never looked. It looks now, so the
  // fixture has to be the thing it claims to be.
  it('adds nothing of its own — the fund is counting it', () => {
    seedWorld();
    useStore.getState().setSmsfFunds([{
      id: 'smsf-1', user_id: U, name: 'Quinn Family SMSF',
      include_in_net_worth: true, balance: 1_400_000,
    }]);
    const before = calculateNetWorth();
    propertiesDS.add(prop({
      id: 'nw-prop-smsf', current_value: 900_000, name: 'Warehouse',
      held_by: 'smsf', smsf_fund_id: 'smsf-1', counted_in_fund_balance: true,
      property_type: 'commercial',
    }) as never);
    const after = calculateNetWorth();
    expect(after.property).toBeCloseTo(before.property, 2);
    // …and the fund's own balance is what carries it, on both tiers.
    expect(after.super).toBeCloseTo(1_400_000, 2);
    expect(after.net_worth).toBeCloseTo(before.net_worth, 2);
  });
});

describe('a property held in a real SMSF', () => {
  // ── FINDING N3 (Critical) — FIXED ─────────────────────────────────────────
  // `countedInFund` dropped an SMSF-held property's value on the grounds that
  // "the fund's balance is already carrying it" — but it never resolved the
  // fund, and the client store had NO SMSF slice at all (SMSFSection.tsx fetched
  // smsfApi straight into local component state). So on the client the fund's
  // balance was in net worth nowhere and the value was counted nowhere either:
  // the house simply vanished, while the backend snapshot counted it, leaving
  // the recorded history and the live headline on two different bases.
  //
  // Both halves are closed. SMSFs are a store slice, loaded at bootstrap and
  // summed into super exactly as the server sums smsf_assets; and a property
  // defers to its fund only when that fund is there to defer to. Below: no fund
  // on this device, so the property carries its own value.
  it('is counted somewhere — by the fund if not by the property', () => {
    seedWorld();
    const bare = calculateNetWorth().net_worth;

    // An SMSF fund is an `smsf_funds` row. Nothing puts one in the client store,
    // so this is the whole of what the client knows about it: the property.
    propertiesDS.add(prop({
      id: 'nw-prop-smsf-real', current_value: 1_200_000, name: 'Warehouse',
      held_by: 'smsf', smsf_fund_id: 'smsf-fund-1', counted_in_fund_balance: true,
      property_type: 'commercial',
    }) as never);

    // The warehouse is worth $1.2m and the user's net worth has not moved a cent.
    expect(round2(calculateNetWorth().net_worth - bare)).toBeCloseTo(1_200_000, 2);
  });

  it('and the Property screen agrees with the headline about who is counting it', () => {
    // Restated (N3). This used to record the disagreement: the report said a
    // fund was carrying $1.2m while no fund balance on the device carried
    // anything. Now the two answer the same question the same way.
    seedWorld();
    propertiesDS.add(prop({
      id: 'nw-prop-smsf-real', current_value: 1_200_000, name: 'Warehouse',
      held_by: 'smsf', smsf_fund_id: 'smsf-fund-1', counted_in_fund_balance: true,
      property_type: 'commercial',
    }) as never);

    const report = propertyReportDS.build();
    // The portfolio owns it…
    expect(report.totals.ownedValue).toBeCloseTo(1_640_000 + 440_000 + 1_200_000, 2);
    // …no fund on this device is carrying it…
    expect(report.totals.countedInFunds).toBe(0);
    expect(useStore.getState().smsfFunds).toHaveLength(0);
    expect(calculateNetWorth().super).toBe(0);
    // …so the property line counts it, and the report's line is the same one.
    expect(report.totals.netWorthValue).toBeCloseTo(calculateNetWorth().property, 2);
  });

  it('and defers to the fund once the fund is actually there', () => {
    seedWorld();
    useStore.getState().setSmsfFunds([{
      id: 'smsf-fund-1', user_id: U, name: 'Quinn Family SMSF',
      include_in_net_worth: true, balance: 1_200_000,
    }]);
    const withFund = calculateNetWorth();
    propertiesDS.add(prop({
      id: 'nw-prop-smsf-real', current_value: 1_200_000, name: 'Warehouse',
      held_by: 'smsf', smsf_fund_id: 'smsf-fund-1', counted_in_fund_balance: true,
      property_type: 'commercial',
    }) as never);
    const after = calculateNetWorth();

    // Counted ONCE, by the fund: the house adds nothing on top of it.
    expect(after.net_worth).toBeCloseTo(withFund.net_worth, 2);
    expect(after.super).toBeCloseTo(1_200_000, 2);
    expect(after.property).toBeCloseTo(withFund.property, 2);
  });
});

describe('two properties pointing at one loan', () => {
  // ── FINDING N4 (Medium) — FIXED ───────────────────────────────────────────
  // `uncountedMortgage` was asked per property and kept no record of what had
  // already been netted, so when the loans term skips a mortgage — because it is
  // opted out, or in the household view because it was not shared — EVERY
  // property pointing at it subtracted the full balance. The picker refuses to
  // link one loan to two properties (availableLoansForProperty), but nothing
  // stops the shape reaching the store: a loan re-linked on a second device, or
  // a row written before that guard. `propertyNetWorthTotal` now keeps one book
  // of netted mortgages across the whole portfolio, on both tiers.
  it('never subtracts the same mortgage twice', () => {
    seedWorld();
    propertiesDS.update(P_INV, { loan_id: L_HOME });      // both now point at it
    loansDS.update(L_HOME, { include_in_net_worth: false }); // so the property must net it

    const nw = calculateNetWorth();
    // Owned value 1,640,000 + 440,000 = 2,080,000, less ONE mortgage of 742,300.
    expect(nw.property).toBeCloseTo(round2(2_080_000 - 742_300), 2);
  });
});

describe('one mortgage secured against two houses', () => {
  // The Property screen's side of finding N4. A row's own `debt` is the whole
  // balance that house stands behind — right on a card, wrong in a total: one
  // loan added once per house reported the portfolio as owing double and left
  // its equity and LVR describing a debt that does not exist.
  it('is one debt in the portfolio totals, not one per house', () => {
    seedWorld();
    propertiesDS.update(P_INV, { loan_id: L_HOME });
    const { totals, rows } = propertyReportDS.build();

    // Each card still names the whole mortgage behind it…
    const linked = rows.filter(r => r.loan?.id === L_HOME);
    expect(linked).toHaveLength(2);
    for (const r of linked) expect(r.debt).toBeCloseTo(742_300, 2);
    // …and the portfolio owes it once.
    expect(totals.debt).toBeCloseTo(742_300, 2);
    expect(totals.equity).toBeCloseTo(round2(totals.ownedValue - 742_300), 2);
    expect(totals.lvr).toBeCloseTo(round2((742_300 / totals.ownedValue) * 100), 2);
  });

  it('and the portfolio\u2019s effect on net worth is the property line less that one debt', () => {
    seedWorld();
    propertiesDS.update(P_INV, { loan_id: L_HOME });
    const nw = calculateNetWorth();
    const { totals } = propertyReportDS.build();
    expect(totals.netWorthValue).toBeCloseTo(nw.property, 2);
    expect(totals.netWorthEffect).toBeCloseTo(round2(nw.property - 742_300), 2);
  });

  it('and with the loan switched off the property line nets it once, not twice', () => {
    seedWorld();
    propertiesDS.update(P_INV, { loan_id: L_HOME });
    const before = calculateNetWorth();
    loansDS.update(L_HOME, { include_in_net_worth: false });
    const after = calculateNetWorth();

    // The debt moved from the loans term to the property term. Nothing else.
    expect(after.net_worth).toBeCloseTo(before.net_worth, 2);
    expect(after.property).toBeCloseTo(round2(before.property - 742_300), 2);
    expect(propertyReportDS.build().totals.netWorthValue).toBeCloseTo(after.property, 2);
  });
});

describe('an ownership percentage outside 0–100', () => {
  it('is clamped, so a typo cannot multiply the house', () => {
    seedWorld();
    propertiesDS.update(P_INV, { ownership_percent: 1_000 });
    const nw = calculateNetWorth();
    expect(nw.property).toBeCloseTo(1_640_000 + 880_000, 2);
  });
});

describe('a foreign-currency account created on the device', () => {
  // ── FINDING N2 (High) — FIXED ─────────────────────────────────────────────
  // The Add-account modal takes a free-text currency and a parsed statement can
  // set one too, but `accountsDS.add` stored only the native `balance` — no
  // `conversion_rate`, no `display_balance`. Net worth and the Accounts total
  // both read `display_balance ?? balance`, so 10,000 USD was counted as
  // A$10,000 from the moment the account was created until the next full
  // bootstrap re-stamped it server-side. `add` now stamps the row on the same
  // basis every other row carries: its own rate if it has one, else the rate
  // this device already holds for that currency (see knownRate).
  it('is worth its converted value, not its face value', () => {
    seedWorld();
    const before = calculateNetWorth().bank_balance;
    accountsDS.add({
      name: 'New USD account', institution: 'Wise', account_type: 'transaction',
      currency: 'USD', balance: 10_000, conversion_rate: 1.52, household_ids: [],
    } as never);
    const after = calculateNetWorth().bank_balance;
    expect(round2(after - before)).toBeCloseTo(15_200, 2);
  });

  it('and the bootstrap that follows does not move it', () => {
    // Restated (N2). This used to record the gap: face value while the row lived
    // only on this device, converted once a bootstrap had been through it. There
    // is no gap now — the row is on the right basis from the moment it exists,
    // and the server's re-stamp agrees rather than corrects.
    seedWorld();
    const before = calculateNetWorth().bank_balance;
    accountsDS.add({
      name: 'New USD account', institution: 'Wise', account_type: 'transaction',
      currency: 'USD', balance: 10_000, conversion_rate: 1.52, household_ids: [],
    } as never);
    expect(round2(calculateNetWorth().bank_balance - before)).toBeCloseTo(15_200, 2);
    reload();
    expect(round2(calculateNetWorth().bank_balance - before)).toBeCloseTo(15_200, 2);
  });

  it('takes the rate from the accounts it already has when none is given', () => {
    // The Add-account form has a free-text currency box and no rate at all, so
    // this is the ordinary path, not the exotic one: the device already holds a
    // USD account the server stamped, and the new one is counted on that rate.
    seedWorld();
    const before = calculateNetWorth().bank_balance;
    const usd = useStore.getState().accounts.find(a => a.id === A_USD)!;
    accountsDS.add({
      name: 'Second USD account', institution: 'Wise', account_type: 'transaction',
      currency: 'USD', balance: 4_000, household_ids: [],
    } as never);
    expect(round2(calculateNetWorth().bank_balance - before))
      .toBeCloseTo(round2(4_000 * (usd.conversion_rate ?? 1)), 2);
  });
});

describe('a credit card with a credit balance', () => {
  it('counts as money held, not as debt', () => {
    seedWorld();
    const before = calculateNetWorth().net_worth;
    creditCardsDS.update(CC_BIZ, { balance_owing: -430.25 });
    expect(round2(calculateNetWorth().net_worth - before)).toBeCloseTo(430.25, 2);
  });
});

describe('paying a card by transfer', () => {
  it('reduces the owing exactly once', () => {
    seedWorld();
    const before = calculateNetWorth();
    transactionsDS.createTransfer({
      fromId: A_MAIN, fromType: 'bank', toId: CC_MAIN, toType: 'credit_card',
      amount: 1_000, date: '2024-06-01', note: 'Card payment',
    });
    const after = calculateNetWorth();
    expect(round2(before.credit_card_debt - after.credit_card_debt)).toBeCloseTo(1_000, 2);
    expect(round2(before.bank_balance - after.bank_balance)).toBeCloseTo(1_000, 2);
    expect(after.net_worth).toBeCloseTo(before.net_worth, 2);
  });
});

describe('deleting a transaction that moved a balance', () => {
  it('puts the money back exactly once', () => {
    seedWorld();
    const before = calculateNetWorth();
    const t = transactionsDS.add({
      account_id: CC_MAIN, account_type: 'credit_card', date: '2024-06-02',
      merchant: 'JB Hi-Fi', amount: -1_299, category: 'Electronics',
      currency: 'AUD', is_duplicate_flagged: false, is_subscription: false,
      household_ids: [],
    } as never);
    moveOwnerBalance(CC_MAIN, 'credit_card', -1_299);
    expect(round2(calculateNetWorth().net_worth)).toBeCloseTo(round2(before.net_worth - 1_299), 2);

    // The user-initiated delete — the one that undoes the balance move too.
    transactionsDS.removeAndReverseBalance(t.id);
    expect(calculateNetWorth().net_worth).toBeCloseTo(before.net_worth, 2);
  });
});

describe('deleting an account', () => {
  it('removes its balance once and takes its transactions with it', () => {
    seedWorld();
    const before = calculateNetWorth();
    accountsDS.remove(A_SAVE);
    const after = calculateNetWorth();
    expect(round2(before.net_worth - after.net_worth)).toBeCloseTo(120_000, 2);
  });
});

describe('selling a holding outright', () => {
  it('the proceeds replace the holding, so only the fee is lost', () => {
    seedWorld();
    const rec = investmentsDS.add({
      name: 'Commonwealth Bank', ticker: 'CBA', market: 'ASX', asset_type: 'stock',
      shares_owned: 300, cost_basis: 28_500, native_currency: 'AUD',
      conversion_rate: 1, current_price: 178.2,
    } as never);
    const before = calculateNetWorth().net_worth;
    const proceeds = round2(300 * 178.2);
    const fee = 19.95;

    salesDS.record({
      investment_id: rec.id, name: rec.name, ticker: rec.ticker ?? null,
      asset_type: rec.asset_type, market: rec.market, quantity: 300,
      proceeds, fees: fee, cost_basis: 28_500,
      acquired_date: '2021-02-10', sale_date: '2024-06-03', currency: 'AUD',
    } as never);
    investmentsDS.remove(rec.id, true);
    moveOwnerBalance(A_MAIN, 'bank', round2(proceeds - fee));

    expect(calculateNetWorth().net_worth).toBeCloseTo(round2(before - fee), 2);
  });
});

describe('the portfolio total after a bootstrap', () => {
  // FINDING L2, fixed. There used to be a SECOND portfolio total in the store:
  // persisted, written from five places, read by no screen, and 0 after a cold
  // bootstrap until something happened to write it. A figure that is only ever
  // consulted to check whether it agrees with the real one is a figure that can
  // only ever be wrong, so it is gone. This is what is left — the total every
  // screen already derives, correct the moment the rows land.
  it('is right the moment the holdings land, with nothing to write it', () => {
    seedWorld();
    useStore.getState().setInvestments([{
      id: 'nw-inv-boot', user_id: U, name: 'Bootstrapped', ticker: 'VAS',
      market: 'ASX', asset_type: 'etf', shares_owned: 100, cost_basis: 8_000,
      current_price: 100, current_value: 10_000, currency: 'AUD',
      native_currency: 'AUD', conversion_rate: 1, is_dividend_paying: false,
      household_ids: [],
    }] as never);
    expect(investmentsDS.getAll().portfolio_total).toBeCloseTo(10_000, 2);
    expect(calculateNetWorth().investments).toBeCloseTo(10_000, 2);
  });
});

describe('the Overview net-worth chart', () => {
  const nowMs = Date.parse('2026-08-28T00:00:00Z');

  it('ends on the live figure, so the line and the headline are one statement', () => {
    seedWorld();
    const live = calculateNetWorth().net_worth;
    const s = buildNetWorthSeries({
      adjusted: null,
      history: [
        { recorded_at: '2026-07-01T00:00:00Z', value: 1_400_000 },
        { recorded_at: '2026-08-01T00:00:00Z', value: 1_500_000 },
      ],
      liveNetWorth: live, excludeStructural: false, nowMs,
    });
    expect(s.points[s.points.length - 1].y).toBe(live);
    expect(s.amount).toBeCloseTo(live - 1_400_000, 2);
  });

  it('the % change and the $ change tell the same story', () => {
    seedWorld();
    const s = buildNetWorthSeries({
      adjusted: null,
      history: [{ recorded_at: '2026-08-01T00:00:00Z', value: 1_400_000 }],
      liveNetWorth: calculateNetWorth().net_worth, excludeStructural: false, nowMs,
    });
    expect(Math.sign(s.pct ?? 0)).toBe(Math.sign(s.amount));
  });

  it('adding an account is added capital, not a gain, in the adjusted view', () => {
    seedWorld();
    const before = calculateNetWorth().net_worth;
    const plain = buildNetWorthSeries({
      adjusted: {
        points: [
          { recorded_at: '2026-07-01T00:00:00Z', value: before, base: before },
          { recorded_at: '2026-08-01T00:00:00Z', value: before, base: before },
        ],
        currentBase: before, currentValue: before, carryValue: 0,
      },
      history: [], liveNetWorth: before, excludeStructural: true, nowMs,
    });
    expect(plain.amount).toBeCloseTo(0, 2);

    // A brand-new account with $250,000 in it. The organic line must not read
    // that as a quarter-million-dollar gain.
    accountsDS.add({
      name: 'Inheritance', institution: 'ING', account_type: 'savings',
      currency: 'AUD', balance: 250_000, household_ids: [],
    } as never);
    const after = calculateNetWorth().net_worth;
    const withNew = buildNetWorthSeries({
      adjusted: {
        points: [
          { recorded_at: '2026-07-01T00:00:00Z', value: before, base: before },
          { recorded_at: '2026-08-01T00:00:00Z', value: before, base: before },
        ],
        currentBase: before, currentValue: before, carryValue: 0,
      },
      history: [], liveNetWorth: after, excludeStructural: true, nowMs,
    });
    expect(withNew.amount).toBeCloseTo(0, 2);
    expect(withNew.points[withNew.points.length - 1].y).toBeCloseTo(after, 2);
  });
});

describe('deleting things other rows point at', () => {
  it('deleting a mortgaged property leaves the mortgage owed', () => {
    seedWorld();
    const before = calculateNetWorth();
    propertiesDS.remove(P_HOME);
    const after = calculateNetWorth();
    expect(round2(before.net_worth - after.net_worth)).toBeCloseTo(1_640_000, 2);
    expect(after.loans).toBeCloseTo(before.loans, 2);
  });

  it('deleting the offset account removes its cash once and raises the interest charged', () => {
    seedWorld();
    const before = calculateNetWorth();
    const loanRow = useStore.getState().loans.find(l => l.id === L_HOME)!;
    const offsetInterest = periodInterest({ ...loanRow, offset_balance: 120_000 });

    accountsDS.remove(A_SAVE);
    const after = calculateNetWorth();
    expect(round2(before.net_worth - after.net_worth)).toBeCloseTo(120_000, 2);
    // The debt itself is untouched — an offset was never a repayment.
    expect(after.loans).toBeCloseTo(before.loans, 2);
    expect(periodInterest({ ...loanRow, offset_balance: 0 })).toBeGreaterThan(offsetInterest);
  });

  it('deleting a holding removes its value once', () => {
    seedWorld();
    const rec = investmentsDS.add({
      name: 'Bitcoin', ticker: 'BTC', market: 'CRYPTO', asset_type: 'crypto',
      shares_owned: 0.85, cost_basis: 42_000, native_currency: 'AUD',
      conversion_rate: 1, current_price: 148_000,
    } as never);
    const before = calculateNetWorth();
    investmentsDS.remove(rec.id);
    const after = calculateNetWorth();
    expect(round2(before.net_worth - after.net_worth)).toBeCloseTo(round2(0.85 * 148_000), 2);
    expect(after.investments).toBeCloseTo(investmentsDS.getAll().portfolio_total, 2);
  });
});

describe('the household view, while rows are shared', () => {
  function joinAndShare() {
    seedWorld();
    useStore.setState({
      households: [{ id: HH, name: 'Audit Household', created_by: U, currency: 'AUD' }] as Household[],
      householdMembers: [
        { id: `m-${HH}-${U}`, household_id: HH, user_id: U, role: 'owner', status: 'active', email: 'audit@example.test', name: 'Audit Subject' },
        { id: `m-${HH}-${PARTNER}`, household_id: HH, user_id: PARTNER, role: 'member', status: 'active', email: 'partner@example.test', name: 'Partner' },
      ] as HouseholdMember[],
    } as never);
    accountsDS.update(A_MAIN, { household_ids: [HH] });
    accountsDS.update(A_USD, { household_ids: [HH] });
    creditCardsDS.update(CC_MAIN, { household_ids: [HH] });
    propertiesDS.update(P_HOME, { household_ids: [HH] });
    propertiesDS.update(P_INV, { household_ids: [HH] });
    loansDS.update(L_HOME, { household_ids: [HH] });
    householdsDS.switchTo(HH);
  }

  it('the household breakdown adds up to the household headline', () => {
    joinAndShare();
    const nw = calculateNetWorth('household');
    const breakdown = round2(
      nw.bank_balance + nw.investments + nw.super + nw.property
      - nw.credit_card_debt - nw.loans,
    );
    expect(breakdown).toBeCloseTo(nw.net_worth, 2);
  });

  it('counts each shared row exactly once — the members partition the total', () => {
    joinAndShare();
    const report = householdReportDS.build(HH)!;
    expect(report.reconciliation).toBe(0);
    expect(report.total.net_worth).toBeCloseTo(
      round2(report.members.reduce((t, m) => t + m.netWorth.net_worth, 0)), 2,
    );
  });

  it('the household total never exceeds the personal one when every row is the same person\'s', () => {
    joinAndShare();
    const personal = calculateNetWorth('personal');
    const household = calculateNetWorth('household');
    // Every shared row is this user's, so the household is a SUBSET of the
    // personal picture: it can never be worth more.
    expect(household.net_worth).toBeLessThanOrEqual(personal.net_worth + 0.005);
  });

  it('switching back to personal restores the personal figure exactly', () => {
    joinAndShare();
    const personalWhileShared = calculateNetWorth('personal').net_worth;
    householdsDS.switchTo(null);
    expect(calculateNetWorth().net_worth).toBeCloseTo(personalWhileShared, 2);
  });
});

describe('an offset account', () => {
  it('reduces the interest charged without reducing the debt', () => {
    seedWorld();
    const loanRow = useStore.getState().loans.find(l => l.id === L_HOME)!;
    const withOffset = periodInterest({ ...loanRow, offset_balance: 120_000 });
    const without = periodInterest({ ...loanRow, offset_balance: 0 });
    expect(withOffset).toBeLessThan(without);
    // and the balance itself is untouched by the offset
    expect(calculateNetWorth().loans).toBeCloseTo(742_300 + 21_800 + 38_900, 2);
  });
});
