/**
 * INVESTMENTS + NET WORTH — THE UI STRESS MARCH.
 *
 * A year of a deliberately awkward portfolio driven THROUGH THE SCREENS' OWN
 * CODE PATHS: every mutation goes through the handler the page calls (the Sell
 * modal's `handleSell` is transcribed here line for line), and every reading is
 * taken the way the page takes it — `investmentsDS.getAll()` summed by
 * `display_value` for Investments, `calculateNetWorth()` broken into tiles for
 * Overview, `propertyReportDS.build()` for Net Worth's property line, and
 * `taxYearDS.build()` for Tax.
 *
 * The portfolio: AUD and USD and GBP shares, crypto, a USD cash holding, a
 * regular super fund plus one switched out of net worth, an SMSF whose balance
 * carries a warehouse, a home and an investment property secured against ONE
 * mortgage, a foreign bank account, a credit card, and a household the user
 * flips in and out of.
 *
 * Against all of it stands an oracle that never reads app state: units × price
 * × FX, a FIFO parcel book of its own, and plain arithmetic for cash, super,
 * property and debt.
 *
 * What this hunts, beyond the arithmetic:
 *   • PAGE ORDER    — the four screens read in one order must equal the four
 *                     read in the reverse order.
 *   • STALE CACHE   — the Investments page writes enriched rows back into the
 *                     store. Doing that must not move a single figure anywhere.
 *   • RELOAD        — rehydrating from what `persist` actually wrote must
 *                     reproduce every screen to the cent.
 *   • CROSS-DEVICE  — a second device holding the same synced state, with its
 *                     own localStorage, must agree.
 *   • SCOPE         — personal → household → personal must land back exactly.
 *
 * Deterministic: same seed, same path, same failure. No Date.now() in the
 * market, no Math.random(), no network, and nothing here touches a real user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as never as { localStorage: unknown; __mem: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(), key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  (globalThis as never as { __mem: Map<string, string> }).__mem = mem;
});
const sync = vi.fn();
vi.mock('../services/syncQueue', () => ({
  syncWithRetry: (...a: unknown[]) => sync(...a),
  registerSyncSuccess: vi.fn(), retryPendingSync: vi.fn(),
}));

import {
  investmentsDS, superDS, salesDS, cgtDS, calculateNetWorth, moveOwnerBalance,
  propertyReportDS, propertiesDS, loansDS, taxYearDS, accountsDS,
} from '../services/dataService';
import { useStore } from '../store';
import type { BankAccount, CreditCard, Investment, Loan, Property, SmsfFund, SuperFund } from '../types';
import { pricePath, fxPath, FIVE_YEARS, FX_FIVE_YEARS, round2 } from './marketSim';

const LS = () => (globalThis as never as { __mem: Map<string, string> }).__mem;

// ═════════════════════════════════════════════════════════════════════════════
//  The synthetic investor
// ═════════════════════════════════════════════════════════════════════════════

const U = 'u-uistress';
const HH = 'hh-uistress';
const BANK_AUD = 'acc-ui-everyday';
const BANK_USD = 'acc-ui-usd';
const CARD = 'cc-ui-amex';
const L_HOME = 'loan-ui-home';       // secures BOTH houses — the shared-mortgage shape
const L_CAR = 'loan-ui-car';
const P_HOME = 'prop-ui-home';
const P_INV = 'prop-ui-inv';
const P_SMSF = 'prop-ui-warehouse';  // carried by the SMSF balance
const F_SUPER = 'sf-ui-main';
const F_LEGACY = 'sf-ui-legacy';     // switched OUT of net worth
const F_SMSF = 'smsf-ui-quinn';

const DAYS = 365;
const START = 0;

// Two independent FX paths — a USD book and a GBP book that move apart.
const FX_USD = fxPath(9101, 1.5200, 1.10, 1.95, FX_FIVE_YEARS);
const FX_GBP = fxPath(9102, 1.9100, 1.55, 2.40, FX_FIVE_YEARS);

interface Spec {
  key: string; name: string; ticker: string; market: string; asset_type: string;
  units: number; price0: number; seed: number; vol: number;
  ccy: 'AUD' | 'USD' | 'GBP'; costNative: number; acquired: string;
}

const SPECS: Spec[] = [
  { key: 'vas', name: 'Vanguard Australian Shares', ticker: 'VAS', market: 'ASX', asset_type: 'stock',
    units: 3_400, price0: 96.40, seed: 501, vol: 1, ccy: 'AUD', costNative: 291_040, acquired: '2023-03-14' },
  { key: 'vts', name: 'Vanguard Total US Market', ticker: 'VTS', market: 'NYSE', asset_type: 'stock',
    units: 1_250, price0: 288.10, seed: 502, vol: 1, ccy: 'USD', costNative: 241_500, acquired: '2022-11-02' },
  { key: 'lgen', name: 'Legal & General', ticker: 'LGEN', market: 'LSE', asset_type: 'stock',
    units: 18_000, price0: 2.4150, seed: 503, vol: 1, ccy: 'GBP', costNative: 39_600, acquired: '2024-06-21' },
  { key: 'btc', name: 'Bitcoin', ticker: 'BTC', market: 'CRYPTO', asset_type: 'crypto',
    units: 2.75, price0: 91_400, seed: 504, vol: 2.4, ccy: 'AUD', costNative: 168_000, acquired: '2021-09-09' },
];

/** Price paths, one per holding, at the spec's own volatility scale. */
const PATHS: Record<string, number[]> = Object.fromEntries(
  SPECS.map(s => [
    s.key,
    pricePath(s.seed, s.price0, FIVE_YEARS.map(r => ({ ...r, vol: r.vol * s.vol }))),
  ]),
);

const fxFor = (ccy: string, day: number): number =>
  ccy === 'USD' ? FX_USD[day] : ccy === 'GBP' ? FX_GBP[day] : 1;

// ── The oracle ───────────────────────────────────────────────────────────────

/** One acquisition, as the oracle books it. Cost is in AUD, locked at purchase. */
interface OracleParcel { units: number; costAud: number }

interface OracleHolding {
  id: string;
  key: string;         // '' for a fixed-price row (cash)
  ccy: string;
  units: number;
  fixedPrice: number | null;  // cash: price never moves
  parcels: OracleParcel[];    // FIFO
}

/**
 * What the user is worth, worked out from first principles. Nothing here reads
 * the store, the services or a display stamp — it is units, prices, rates and
 * balances, and it is the only thing the screens are ever measured against.
 */
class Oracle {
  day = 0;
  holdings = new Map<string, OracleHolding>();
  bankAud = 0;
  bankUsd = 0;          // native USD balance
  bankUsdRate = 1;      // the ONE rate that balance is carried at
  cardOwing = 0;
  superCounted = 0;     // funds that feed net worth (incl. the SMSF)
  superAll = 0;         // every fund, toggle or no toggle
  loans = new Map<string, { balance: number; counted: boolean }>();
  props = new Map<string, {
    value: number; share: number; loanId: string | null;
    inFund: boolean; included: boolean;
  }>();
  /** Realised disposals, as the oracle books them: FY → {proceeds, cost}. */
  disposals: { fy: string; proceeds: number; fees: number; costAud: number }[] = [];

  priceOf(h: OracleHolding): number {
    return h.fixedPrice != null ? h.fixedPrice : PATHS[h.key][this.day];
  }
  valueOf(h: OracleHolding): number {
    return round2(h.units * this.priceOf(h) * fxFor(h.ccy, this.day));
  }
  investments(): number {
    let t = 0;
    for (const h of this.holdings.values()) t += this.valueOf(h);
    return round2(t);
  }
  /** Cost of `units` taken oldest-first, and the book that remains. */
  takeFifo(h: OracleHolding, units: number): number {
    let left = units, cost = 0;
    while (left > 1e-9 && h.parcels.length > 0) {
      const p = h.parcels[0];
      const take = Math.min(left, p.units);
      const slice = p.units > 0 ? (p.costAud * take) / p.units : 0;
      cost += slice;
      p.units -= take; p.costAud -= slice; left -= take;
      if (p.units <= 1e-9) h.parcels.shift();
    }
    return round2(cost);
  }
  bank(): number {
    return round2(this.bankAud + round2(this.bankUsd * this.bankUsdRate));
  }
  loanDebt(): number {
    let t = 0;
    for (const l of this.loans.values()) if (l.counted) t += l.balance;
    return round2(t);
  }
  /** Property's contribution — value share, less any mortgage the loans term
   *  skipped, counted once across the whole portfolio. */
  property(): number {
    const netted = new Set<string>();
    let t = 0;
    for (const [, p] of this.props) {
      if (!p.included) continue;
      const asset = p.inFund ? 0 : round2(p.value * p.share);
      let debt = 0;
      if (p.loanId) {
        const l = this.loans.get(p.loanId);
        if (l && !l.counted && !netted.has(p.loanId)) { netted.add(p.loanId); debt = l.balance; }
      }
      t += round2(asset - debt);
    }
    return round2(t);
  }
  netWorth(): number {
    return round2(
      this.bank() + this.investments() + this.superCounted + this.property()
      - this.cardOwing - this.loanDebt(),
    );
  }
}

let oracle: Oracle;

// ── Seeding ──────────────────────────────────────────────────────────────────

function seed(): void {
  LS().clear();
  oracle = new Oracle();
  oracle.day = START;

  const accounts: BankAccount[] = [
    { id: BANK_AUD, user_id: U, name: 'Everyday', balance: 84_200, institution: 'CBA',
      account_type: 'transaction', currency: 'AUD', is_manual: true, household_ids: [HH] } as never,
    // A foreign account carried at ONE stamped rate — the client reads
    // display_balance and moves it by the row's own conversion_rate.
    { id: BANK_USD, user_id: U, name: 'US brokerage cash', balance: 61_500,
      institution: 'IBKR', account_type: 'savings', currency: 'USD', is_manual: true,
      household_ids: [], conversion_rate: FX_USD[START],
      display_balance: round2(61_500 * FX_USD[START]), display_currency: 'AUD' } as never,
    // Somebody else's account, shared into view. Visible, never counted as ours.
    { id: 'acc-other-shared', user_id: 'u-someone-else', name: "Co-owner's offset",
      balance: 415_000, institution: 'ING', account_type: 'savings', currency: 'AUD',
      is_manual: true, household_ids: [HH] } as never,
  ];
  const creditCards: CreditCard[] = [
    { id: CARD, user_id: U, name: 'Amex Platinum', balance_owing: 18_450, credit_limit: 60_000,
      institution: 'Amex', currency: 'AUD', is_manual: true, household_ids: [] } as never,
  ];
  const loans: Loan[] = [
    { id: L_HOME, user_id: U, name: 'Home + investment mortgage', loan_type: 'mortgage',
      current_balance: 812_000, original_amount: 980_000, interest_rate: 6.14,
      minimum_repayment: 5_600, repayment_frequency: 'monthly',
      include_in_net_worth: true, household_ids: [HH] } as never,
    { id: L_CAR, user_id: U, name: 'Car loan', loan_type: 'personal',
      current_balance: 27_400, original_amount: 45_000, interest_rate: 8.9,
      minimum_repayment: 780, repayment_frequency: 'monthly',
      include_in_net_worth: true, household_ids: [] } as never,
  ];
  const properties: Property[] = [
    { id: P_HOME, user_id: U, name: 'Balmain home', property_type: 'residential',
      current_value: 2_240_000, purchase_price: 1_650_000, ownership_percent: 100, loan_id: L_HOME,
      include_in_net_worth: true, household_ids: [] } as never,
    // Shared into the household, so flipping the scope is never a no-op.
    { id: P_INV, user_id: U, name: 'Newcastle unit', property_type: 'investment',
      current_value: 780_000, purchase_price: 610_000, ownership_percent: 60, loan_id: L_HOME,
      include_in_net_worth: true, household_ids: [HH] } as never,
    { id: P_SMSF, user_id: U, name: 'Warehouse (SMSF)', property_type: 'commercial',
      current_value: 1_180_000, purchase_price: 980_000, ownership_percent: 100, loan_id: null,
      held_by: 'smsf', smsf_fund_id: F_SMSF, counted_in_fund_balance: true,
      include_in_net_worth: true, household_ids: [] } as never,
  ];
  const superFunds: SuperFund[] = [
    { id: F_SUPER, user_id: U, fund_name: 'AustralianSuper', balance: 418_000,
      employer_contributions: 0, personal_contributions: 0,
      include_in_investments: true, include_in_net_worth: true } as never,
    { id: F_LEGACY, user_id: U, fund_name: 'Old fund — not in net worth', balance: 96_500,
      employer_contributions: 0, personal_contributions: 0,
      include_in_investments: false, include_in_net_worth: false } as never,
  ];
  const smsfFunds: SmsfFund[] = [
    { id: F_SMSF, user_id: U, name: 'Quinn SMSF', balance: 1_640_000, include_in_net_worth: true },
  ];

  useStore.setState({
    user: { id: U, email: 'ui@example.test', name: 'UI Stress', currency_preference: 'AUD',
      theme: 'system', plan: 'premium', onboarding_complete: true } as never,
    token: 'stress-token', dataOwnerId: U,
    households: [{ id: HH, name: 'Stress household', created_by: U, currency: 'AUD' }],
    householdMembers: [{ id: `m-${HH}-${U}`, household_id: HH, user_id: U, role: 'owner',
      status: 'active', email: 'ui@example.test', name: 'UI Stress' }],
    householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts, creditCards, loans, properties, superFunds, smsfFunds,
    transactions: [], subscriptions: [], investments: [], investmentSales: [],
    incomeEntries: [], bills: [], goals: [], goalContributions: [], loanEvents: [],
    insurancePolicies: [], insurancePremiumHistory: [], budgets: [],
    recordShares: [], shareCodes: [], recurringSeries: [], transactionSplits: [],
    creditCardStatements: [], pendingPayments: [], ccPaymentPrompts: [],
    alertStates: [], budgetSettings: null, budgetLines: [], customCategories: [],
    merchants: [], merchantAliases: [], transactionRules: [], billSubExclusions: [],
    hiddenCategories: [], selectedCategories: null, categoryAliases: {},
    notifications: [], netWorth: null, idMap: {}, pendingSyncQueue: [], basiqUserId: null,
  } as never);

  // Oracle mirror of everything above.
  oracle.bankAud = 84_200;
  oracle.bankUsd = 61_500;
  oracle.bankUsdRate = FX_USD[START];
  oracle.cardOwing = 18_450;
  oracle.loans.set(L_HOME, { balance: 812_000, counted: true });
  oracle.loans.set(L_CAR, { balance: 27_400, counted: true });
  oracle.props.set(P_HOME, { value: 2_240_000, share: 1, loanId: L_HOME, inFund: false, included: true });
  oracle.props.set(P_INV, { value: 780_000, share: 0.6, loanId: L_HOME, inFund: false, included: true });
  oracle.props.set(P_SMSF, { value: 1_180_000, share: 1, loanId: null, inFund: true, included: true });
  oracle.superCounted = 418_000 + 1_640_000;
  oracle.superAll = 418_000 + 96_500 + 1_640_000;

  // The holdings go in through the page's own Add path.
  for (const s of SPECS) {
    const rate = fxFor(s.ccy, START);
    const rec = investmentsDS.add({
      name: s.name, ticker: s.ticker, market: s.market, asset_type: s.asset_type,
      shares_owned: s.units, cost_basis: s.costNative, native_currency: s.ccy,
      cost_basis_currency: s.ccy, conversion_rate: rate,
      current_price: PATHS[s.key][START], acquired_date: s.acquired,
    });
    oracle.holdings.set(rec.id, {
      id: rec.id, key: s.key, ccy: s.ccy, units: s.units, fixedPrice: null,
      parcels: [{ units: s.units, costAud: round2(s.costNative * rate) }],
    });
  }
  // A USD cash holding: price is the balance, one unit, no gain.
  const cashRate = fxFor('USD', START);
  const cash = investmentsDS.add({
    name: 'USD settlement cash', market: 'CASH', asset_type: 'cash',
    shares_owned: 1, cost_basis: 24_000, native_currency: 'USD',
    cost_basis_currency: 'USD', conversion_rate: cashRate,
    current_price: 24_000, acquired_date: '2024-01-05',
  });
  oracle.holdings.set(cash.id, {
    id: cash.id, key: '', ccy: 'USD', units: 1, fixedPrice: 24_000,
    parcels: [{ units: 1, costAud: round2(24_000 * cashRate) }],
  });

  pageRefresh();
}

// ═════════════════════════════════════════════════════════════════════════════
//  The screens — each reads exactly as its page reads
// ═════════════════════════════════════════════════════════════════════════════

/** pages/Investments.tsx `refreshInvestments` — enrich everything, write back. */
function pageRefresh(): void {
  const { all } = investmentsDS.enrichAll();
  useStore.getState().setInvestments(all);
}

/** The Investments page's headline figures, summed the way the page sums them. */
function screenInvestments() {
  const investments = investmentsDS.getAll().investments;
  const portfolioTotal = investments.reduce((s, i) => s + (i.display_value ?? 0), 0);
  const totalPL = investments.reduce((s, i) => s + (i.verification?.profit_loss ?? 0), 0);
  const cashTotal = investments.filter(i => i.asset_type === 'cash')
    .reduce((s, i) => s + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0);
  return {
    total: round2(portfolioTotal),
    pl: round2(totalPL),
    cost: round2(portfolioTotal - totalPL - cashTotal),
    count: investments.length,
  };
}

/** pages/Overview.tsx — the headline and the tile row beneath it. */
function screenOverview() {
  const nw = calculateNetWorth();
  return {
    headline: nw.net_worth,
    tiles: round2(
      nw.bank_balance + nw.investments + nw.super_counted + nw.property
      - nw.credit_card_debt - nw.loans,
    ),
    bank: nw.bank_balance, investments: nw.investments,
    superCounted: nw.super_counted, superAll: nw.super,
    property: nw.property, cards: nw.credit_card_debt, loans: nw.loans,
  };
}

/** The Net Worth surface — the property report that stands behind the line. */
function screenNetWorth() {
  const nw = calculateNetWorth();
  const report = propertyReportDS.build();
  return {
    net: nw.net_worth,
    propertyLine: nw.property,
    reportEffect: report.totals.netWorthEffect,
    reportValue: report.totals.netWorthValue,
    debt: report.totals.debt,
    equity: report.totals.equity,
  };
}

/** pages/Tax.tsx — the FY position the whole screen is built from. */
function screenTax(fy: string) {
  const pos = taxYearDS.build({ fy });
  const cg = pos.capitalGains;
  return {
    taxable: pos.estimatedTaxableIncome,
    assessable: pos.assessableIncome,
    proceeds: cg?.proceeds ?? 0,
    costBase: cg?.costBase ?? 0,
    netGain: cg?.netCapitalGain ?? 0,
  };
}

/** All four, in one order or the other. */
function readForward() {
  return { inv: screenInvestments(), ovr: screenOverview(), nw: screenNetWorth(), tax: screenTax(FY) };
}
function readReverse() {
  const tax = screenTax(FY); const nw = screenNetWorth();
  const ovr = screenOverview(); const inv = screenInvestments();
  return { inv, ovr, nw, tax };
}

const FY = '2025-2026';

// ═════════════════════════════════════════════════════════════════════════════
//  Reload and cross-device
// ═════════════════════════════════════════════════════════════════════════════

/** What zustand's `persist` actually wrote — the bytes a reload would read. */
function persisted(): string {
  const raw = LS().get('ledger-store');
  if (!raw) throw new Error('nothing persisted — the store never wrote');
  return raw;
}

/** A cold start: the tab is closed and reopened, so only persisted slices come
 *  back and everything derived is built again from them. */
function reload(): void {
  const state = JSON.parse(persisted()).state as Record<string, unknown>;
  useStore.setState({ ...state, netWorth: null } as never);
}

/** A SECOND device: the same synced state, but its own localStorage — so
 *  anything the app keeps outside the store has to have travelled to get there. */
function otherDevice(): void {
  const state = JSON.parse(persisted()).state as Record<string, unknown>;
  const keep = new Map(LS());
  // The parcel book, the deduction list and the dividend statements live in
  // localStorage under their own per-user keys, NOT in the persisted store — so
  // this is the whole point of the check: they do not travel with the store, and
  // the second device has to be able to rebuild what it needs without them.
  const deviceLocal = [...keep.keys()].filter(k => k !== 'ledger-store');
  if (!deviceLocal.some(k => k.startsWith('ledger-cgt-'))) {
    throw new Error('cross-device check is vacuous: no device-local CGT book to leave behind');
  }
  LS().clear();
  LS().set('ledger-store', keep.get('ledger-store')!);
  useStore.setState({ ...state, netWorth: null } as never);
}

/** Put a device-local book back, so the march can carry on after a device check. */
function restoreDevice(snapshot: Map<string, string>): void {
  LS().clear();
  for (const [k, val] of snapshot) LS().set(k, val);
}

// ═════════════════════════════════════════════════════════════════════════════
//  The march
// ═════════════════════════════════════════════════════════════════════════════

/** pages/Investments.tsx `handleSell`, transcribed. This is the sell path the
 *  user actually takes; nothing here may be simplified or the march stops
 *  testing the screen. */
function pageSell(id: string, quantity: number, saleDate: string, depositAccountId?: string) {
  const inv = investmentsDS.getAll().investments.find(i => i.id === id);
  if (!inv) return null;
  const currency = 'AUD';
  const origQty = inv.shares_owned || 0;
  const qty = Math.min(quantity, origQty) || origQty;
  const fraction = origQty > 0 ? qty / origQty : 1;
  const proceeds = round2(qty * inv.current_price * (inv.conversion_rate ?? 1));
  const fees = round2(Math.min(29.95, proceeds * 0.001));
  const totalCostPref = inv.display_cost ?? inv.cost_basis;
  const costSold = parseFloat((totalCostPref * fraction).toFixed(2));

  salesDS.record({
    investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
    asset_type: inv.asset_type, market: inv.market, quantity: qty,
    proceeds, fees, cost_basis: costSold,
    acquired_date: inv.acquired_date ?? null, sale_date: saleDate,
    currency, native_currency: inv.native_currency ?? null,
  });

  if (qty >= origQty - 1e-9) {
    investmentsDS.remove(inv.id, true);
  } else {
    const remaining = cgtDS.remainingFor(inv.id);
    const scaled = parseFloat((inv.cost_basis * (1 - fraction)).toFixed(2));
    investmentsDS.update(inv.id, {
      shares_owned: parseFloat((origQty - qty).toFixed(8)),
      ...(remaining.parcels.length > 0
        ? { cost_basis: remaining.costBase, cost_basis_currency: currency }
        : { cost_basis: scaled }),
    }, { parcelIntent: 'sale' });
  }
  if (depositAccountId) {
    const net = parseFloat((proceeds - fees).toFixed(2));
    if (net !== 0) moveOwnerBalance(depositAccountId, 'bank', net);
  }
  pageRefresh();
  return { qty, proceeds, fees };
}

/** The oracle's own account of that sale. */
function oracleSell(id: string, quantity: number, fy: string, deposit: boolean) {
  const h = oracle.holdings.get(id)!;
  const qty = Math.min(quantity, h.units) || h.units;
  const proceeds = round2(qty * oracle.priceOf(h) * fxFor(h.ccy, oracle.day));
  const fees = round2(Math.min(29.95, proceeds * 0.001));
  const costAud = oracle.takeFifo(h, qty);
  h.units = parseFloat((h.units - qty).toFixed(8));
  if (h.units <= 1e-9) oracle.holdings.delete(id);
  oracle.disposals.push({ fy, proceeds, fees, costAud });
  if (deposit) oracle.bankAud = round2(oracle.bankAud + round2(proceeds - fees));
}

const isoFor = (day: number): string => {
  const d = new Date(Date.UTC(2025, 8, 1) + day * 86_400_000);
  return d.toISOString().slice(0, 10);
};
/** The Australian FY a date falls in, as Ledger labels them: "YYYY-YYYY". */
const fyOf = (iso: string): string => {
  const [y, m] = iso.split('-').map(Number);
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
};

/** Move every holding and every foreign balance onto `day`'s market. */
function repriceTo(day: number): void {
  oracle.day = day;
  for (const h of oracle.holdings.values()) {
    const patch: Partial<Investment> = { conversion_rate: fxFor(h.ccy, day) };
    if (h.fixedPrice == null) patch.current_price = PATHS[h.key][day];
    investmentsDS.update(h.id, patch);
  }
  // The foreign ACCOUNT is re-stamped the way the server's enrichment does it:
  // one rate for the day, written onto the row with the balance it produced.
  const rate = fxFor('USD', day);
  oracle.bankUsdRate = rate;
  accountsDS.update(BANK_USD, {
    conversion_rate: rate,
    display_balance: round2(oracle.bankUsd * rate),
    display_currency: 'AUD',
  } as never);
  pageRefresh();
}

// ═════════════════════════════════════════════════════════════════════════════
//  The invariants, checked every single day
// ═════════════════════════════════════════════════════════════════════════════

const TOL = 0.005;

/**
 * The first sighting of each distinct divergence. The march does NOT stop at
 * the first one: a two-cent rounding gap on day 120 must not be allowed to hide
 * a six-figure one on day 300, so every kind is recorded once, with the day it
 * first appeared and the numbers that made it.
 */
class FirstSightings {
  seen = new Map<string, { day: number; actual: number; expected: number; diff: number; detail: string }>();
  count = new Map<string, number>();
  check(day: number, kind: string, actual: number, expected: number, tol: number, detail = ''): void {
    const diff = actual - expected;
    if (!Number.isFinite(actual) || Math.abs(diff) > tol) {
      this.count.set(kind, (this.count.get(kind) ?? 0) + 1);
      if (!this.seen.has(kind)) {
        this.seen.set(kind, { day, actual, expected, diff: round2(diff), detail });
      }
    }
  }
  get all() { return [...this.seen.entries()]; }
  report(): string {
    return this.all
      .sort((a, b) => Math.abs(b[1].diff) - Math.abs(a[1].diff))
      .map(([kind, f]) =>
        `[${kind}] FIRST day ${f.day} — actual ${f.actual} vs expected ${f.expected} ` +
        `(diff ${f.diff}), recurred ${this.count.get(kind)}x ${f.detail}`)
      .join('\n');
  }
}

function checkDay(v: FirstSightings, day: number): void {
  const fwd = readForward();
  const rev = readReverse();

  // ── Against the oracle ───────────────────────────────────────────────────
  v.check(day, 'investments-vs-oracle', fwd.inv.total, oracle.investments(), TOL);
  v.check(day, 'overview-investments-vs-oracle', fwd.ovr.investments, oracle.investments(), TOL);
  v.check(day, 'bank-vs-oracle', fwd.ovr.bank, oracle.bank(), TOL);
  v.check(day, 'super-counted-vs-oracle', fwd.ovr.superCounted, oracle.superCounted, TOL);
  v.check(day, 'super-all-vs-oracle', fwd.ovr.superAll, oracle.superAll, TOL);
  v.check(day, 'property-vs-oracle', fwd.ovr.property, oracle.property(), TOL);
  v.check(day, 'loans-vs-oracle', fwd.ovr.loans, oracle.loanDebt(), TOL);
  v.check(day, 'net-worth-vs-oracle', fwd.ovr.headline, oracle.netWorth(), TOL);

  // ── Screen against screen ────────────────────────────────────────────────
  // The tile row directly under the headline must add up to it.
  v.check(day, 'tiles-vs-headline', fwd.ovr.tiles, fwd.ovr.headline, 0.02);
  // The portfolio the Investments page shows is the investments term the
  // Overview shows. Two screens, one number.
  v.check(day, 'investments-page-vs-overview', fwd.inv.total, fwd.ovr.investments, 0.02);
  // The property report behind the Net Worth screen is the property line above it.
  v.check(day, 'property-report-vs-line', fwd.nw.reportValue, fwd.ovr.property, 0.02);

  // ── Tax against the oracle's own book of disposals ───────────────────────
  // The Tax page costs a sale from the parcels it came out of; the oracle keeps
  // its own FIFO book and never looks at the app's. They have to agree on what
  // was sold, for how much, and what it cost.
  for (const fy of new Set(oracle.disposals.map(d => d.fy))) {
    const mine = oracle.disposals.filter(d => d.fy === fy);
    const tax = screenTax(fy);
    v.check(day, `tax-proceeds-vs-oracle:${fy}`, tax.proceeds,
      round2(mine.reduce((t, d) => t + d.proceeds, 0)), 0.05);
    v.check(day, `tax-cost-vs-oracle:${fy}`, tax.costBase,
      round2(mine.reduce((t, d) => t + d.costAud, 0)), 0.05);
  }

  // ── PAGE ORDER ───────────────────────────────────────────────────────────
  // Reading Tax first must not change what Investments then says.
  v.check(day, 'order-investments', rev.inv.total, fwd.inv.total, 0.001);
  v.check(day, 'order-net-worth', rev.ovr.headline, fwd.ovr.headline, 0.001);
  v.check(day, 'order-property', rev.ovr.property, fwd.ovr.property, 0.001);
  v.check(day, 'order-tax-taxable', rev.tax.taxable, fwd.tax.taxable, 0.001);
  v.check(day, 'order-tax-gain', rev.tax.netGain, fwd.tax.netGain, 0.001);

  // ── STALE CACHE ──────────────────────────────────────────────────────────
  // Visiting Investments stamps enriched rows back into the store. That is a
  // cache write, and a cache write must not be able to move a figure.
  pageRefresh();
  const after = readForward();
  v.check(day, 'stale-investments', after.inv.total, fwd.inv.total, 0.001);
  v.check(day, 'stale-net-worth', after.ovr.headline, fwd.ovr.headline, 0.001);
  v.check(day, 'stale-pl', after.inv.pl, fwd.inv.pl, 0.001);
  v.check(day, 'stale-tax-gain', after.tax.netGain, fwd.tax.netGain, 0.001);
}

/** The scheduled action for a day, or nothing. Deterministic by construction. */
function actOn(day: number, v: FirstSightings): void {
  const iso = isoFor(day);
  const fy = fyOf(iso);
  const ids = [...oracle.holdings.keys()];

  // Partial sell — the commonest thing a user does.
  if (day % 37 === 5 && ids.length > 0) {
    const id = ids[(day / 37 | 0) % ids.length];
    const h = oracle.holdings.get(id)!;
    if (h.units > 2 && h.fixedPrice == null) {
      const qty = parseFloat((h.units * 0.25).toFixed(6));
      pageSell(id, qty, iso, BANK_AUD);
      oracleSell(id, qty, fy, true);
    }
  }

  // A full disposal — the holding leaves, the gain stays.
  if (day % 97 === 40 && ids.length > 1) {
    const id = ids[ids.length - 1];
    const h = oracle.holdings.get(id)!;
    if (h.fixedPrice == null) {
      pageSell(id, h.units, iso, BANK_AUD);
      oracleSell(id, h.units, fy, true);
    }
  }

  // Buy more of something already held (a second parcel at today's price).
  if (day % 53 === 11 && ids.length > 0) {
    const id = ids[(day / 53 | 0) % ids.length];
    const h = oracle.holdings.get(id)!;
    if (h.fixedPrice == null) {
      const spec = SPECS.find(s => s.key === h.key)!;
      const addUnits = parseFloat((h.units * 0.1).toFixed(6));
      const priceNative = PATHS[h.key][day];
      const rate = fxFor(h.ccy, day);
      const costNative = round2(addUnits * priceNative);
      const before = useStore.getState().investments.find(i => i.id === id)!;
      // The Edit modal's "bought more" path: new unit count, cost grown by what
      // was paid, declared as a purchase so a parcel is opened for it.
      investmentsDS.update(id, {
        shares_owned: parseFloat((h.units + addUnits).toFixed(8)),
        cost_basis: round2((before.cost_basis ?? 0) + round2(costNative * rate)),
        cost_basis_currency: 'AUD',
      }, { parcelIntent: 'purchase', acquiredDate: iso });
      pageRefresh();
      h.units = parseFloat((h.units + addUnits).toFixed(8));
      h.parcels.push({ units: addUnits, costAud: round2(costNative * rate) });
      oracle.bankAud = round2(oracle.bankAud - round2(costNative * rate));
      moveOwnerBalance(BANK_AUD, 'bank', -round2(costNative * rate));
      void spec;
    }
  }

  // A brand-new foreign holding mid-life.
  if (day === 128) {
    const rate = fxFor('USD', day);
    // Its own price path — a scaled VTS, fixed before the row is created so the
    // app and the oracle are quoting the same number from the first tick.
    PATHS.nvda = PATHS.vts.map(p => round2(p * 0.62));
    const rec = investmentsDS.add({
      name: 'Nvidia', ticker: 'NVDA', market: 'NASDAQ', asset_type: 'stock',
      shares_owned: 240, cost_basis: 41_600, native_currency: 'USD',
      cost_basis_currency: 'USD', conversion_rate: rate,
      current_price: PATHS.nvda[day], acquired_date: iso,
    });
    pageRefresh();
    oracle.holdings.set(rec.id, {
      id: rec.id, key: 'nvda', ccy: 'USD', units: 240, fixedPrice: null,
      parcels: [{ units: 240, costAud: round2(41_600 * rate) }],
    });
    oracle.bankAud = round2(oracle.bankAud - round2(41_600 * rate));
    moveOwnerBalance(BANK_AUD, 'bank', -round2(41_600 * rate));
  }

  // Revalue a property; pay down a mortgage.
  if (day % 43 === 17) {
    const p = oracle.props.get(P_INV)!;
    const value = round2(p.value * 1.004);
    propertiesDS.update(P_INV, { current_value: value });
    p.value = value;
    const l = oracle.loans.get(L_HOME)!;
    const bal = round2(l.balance - 2_400);
    loansDS.update(L_HOME, { current_balance: bal });
    l.balance = bal;
  }

  // Switch the shared mortgage out of net worth, and back. While it is out the
  // two houses behind it owe it once BETWEEN them, not once each.
  if (day === 190) { loansDS.update(L_HOME, { include_in_net_worth: false }); oracle.loans.get(L_HOME)!.counted = false; }
  if (day === 262) { loansDS.update(L_HOME, { include_in_net_worth: true }); oracle.loans.get(L_HOME)!.counted = true; }

  // Switch the SMSF off — the warehouse must leave WITH it, not fall out of the
  // fund and start counting itself.
  if (day === 210) {
    const s = useStore.getState();
    s.setSmsfFunds(s.smsfFunds.map(f => f.id === F_SMSF ? { ...f, include_in_net_worth: false } : f));
    oracle.superCounted = round2(oracle.superCounted - 1_640_000);
  }
  if (day === 240) {
    const s = useStore.getState();
    s.setSmsfFunds(s.smsfFunds.map(f => f.id === F_SMSF ? { ...f, include_in_net_worth: true } : f));
    oracle.superCounted = round2(oracle.superCounted + 1_640_000);
  }

  // Delete a linked record: the car loan is paid out and removed.
  if (day === 300) {
    loansDS.remove(L_CAR);
    oracle.loans.delete(L_CAR);
  }

  // Super grows.
  if (day % 30 === 14) {
    const s = useStore.getState();
    const f = s.superFunds.find(x => x.id === F_SUPER)!;
    const bal = round2(f.balance + 1_950);
    superDS.update(F_SUPER, { balance: bal } as never);
    oracle.superCounted = round2(oracle.superCounted + 1_950);
    oracle.superAll = round2(oracle.superAll + 1_950);
  }

  // SCOPE: flip to the household and back. Nothing personal may move.
  if (day % 29 === 3) {
    const before = readForward();
    useStore.setState({ financeScope: 'household', activeHouseholdId: HH } as never);
    calculateNetWorth();
    screenInvestments();
    useStore.setState({ financeScope: 'personal', activeHouseholdId: null } as never);
    const after = readForward();
    v.check(day, 'scope-roundtrip-net-worth', after.ovr.headline, before.ovr.headline, 0.001);
    v.check(day, 'scope-roundtrip-investments', after.inv.total, before.inv.total, 0.001);
    v.check(day, 'scope-roundtrip-tax', after.tax.taxable, before.tax.taxable, 0.001);
  }
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Investments + Net Worth — a year through the screens', () => {
  beforeEach(() => { sync.mockClear(); });

  // ── FINDING U1 (Low) ──────────────────────────────────────────────────────
  // The Overview's investments term reads `current_value × conversion_rate`, and
  // `current_value` was already rounded to cents IN THE NATIVE CURRENCY by
  // verifyInvestment. The Investments page multiplies units × price × rate and
  // rounds once, at the end. So the two screens round on different bases and the
  // headline disagrees with the portfolio page by up to half a cent per foreign
  // holding, times that holding's FX rate. First seen on day 1; on 190 of 366
  // days the headline is off the true figure, and on 23 of them the two screens
  // visibly disagree. Pinned here stating the correct behaviour.
  it.fails('reconciles to the oracle every day, in every reading order', () => {
    seed();
    const v = new FirstSightings();
    for (let day = START; day <= DAYS; day++) {
      repriceTo(day);
      actOn(day, v);
      pageRefresh();
      checkDay(v, day);
    }
    expect(v.all.length, `\n${v.report()}\n`).toBe(0);
  });

  it.fails('survives a reload every 45 days with nothing moving', () => {
    seed();
    const v = new FirstSightings();
    for (let day = START; day <= DAYS; day++) {
      repriceTo(day);
      actOn(day, v);
      pageRefresh();
      if (day % 45 === 0) {
        const before = readForward();
        reload();
        const after = readForward();
        v.check(day, 'reload-investments', after.inv.total, before.inv.total, 0.001);
        v.check(day, 'reload-net-worth', after.ovr.headline, before.ovr.headline, 0.001);
        v.check(day, 'reload-property', after.ovr.property, before.ovr.property, 0.001);
        v.check(day, 'reload-super', after.ovr.superCounted, before.ovr.superCounted, 0.001);
        v.check(day, 'reload-pl', after.inv.pl, before.inv.pl, 0.001);
        v.check(day, 'reload-tax-gain', after.tax.netGain, before.tax.netGain, 0.001);
        v.check(day, 'reload-tax-taxable', after.tax.taxable, before.tax.taxable, 0.001);
      }
      checkDay(v, day);
    }
    expect(v.all.length, `\n${v.report()}\n`).toBe(0);
  });

  // ── FINDING U4 (High) ─────────────────────────────────────────────────────
  // The capital-gains book — parcels, splits and the allocations that record
  // what each disposal actually consumed — lives in localStorage under
  // `ledger-cgt-<uid>`, not in the persisted store. A device that has the
  // disposals but not the book re-costs the year from a parcel rebuilt out of
  // what is LEFT of each holding, and the holding's cost was rewritten by the
  // very sale being re-costed. Sell part of a holding and then buy more of it
  // and the two devices report different capital gains for the same year.
  it.fails('reads the same on a second device holding the same synced state', () => {
    seed();
    const v = new FirstSightings();
    for (let day = START; day <= DAYS; day++) {
      repriceTo(day);
      actOn(day, v);
      pageRefresh();
      if (day > 0 && day % 90 === 0) {
        const before = readForward();
        otherDevice();
        const after = readForward();
        v.check(day, 'device-investments', after.inv.total, before.inv.total, 0.001);
        v.check(day, 'device-net-worth', after.ovr.headline, before.ovr.headline, 0.001);
        v.check(day, 'device-property', after.ovr.property, before.ovr.property, 0.001);
        v.check(day, 'device-tax-gain', after.tax.netGain, before.tax.netGain, 0.001);
        v.check(day, 'device-tax-proceeds', after.tax.proceeds, before.tax.proceeds, 0.001);
        v.check(day, 'device-tax-cost', after.tax.costBase, before.tax.costBase, 0.001);
      }
    }
    expect(v.all.length, `\n${v.report()}\n`).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Reload MID-ACTION — the tab dies between the two writes a sale is made of
// ═════════════════════════════════════════════════════════════════════════════

describe('a reload in the middle of a sale', () => {
  // handleSell is THREE writes in a row — record the disposal, reduce (or
  // remove) the holding, bank the net proceeds — and `persist` commits each one
  // to disk as it happens. There is no transaction around them, so a tab that
  // dies between two legs reopens on a half-made sale that nothing ever
  // reconciles. Both windows are pinned below with the correct behaviour.

  // ── WINDOW 1: the disposal is written, the holding is not yet reduced. ────
  it.fails('never shows the same units as both held and disposed', () => {
    seed();
    repriceTo(60);
    const id = [...oracle.holdings.keys()][1];      // VTS, a foreign holding
    const inv = investmentsDS.getAll().investments.find(i => i.id === id)!;
    const unitsBefore = inv.shares_owned;
    const qty = parseFloat((unitsBefore * 0.4).toFixed(6));

    salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: qty,
      proceeds: round2(qty * inv.current_price * (inv.conversion_rate ?? 1)),
      fees: 29.95, cost_basis: round2((inv.display_cost ?? inv.cost_basis) * 0.4),
      acquired_date: inv.acquired_date ?? null, sale_date: isoFor(60),
      currency: 'AUD', native_currency: inv.native_currency ?? null,
    });
    reload();   // ← legs 2 and 3 never ran

    const held = investmentsDS.getAll().investments.find(i => i.id === id)!.shares_owned;
    const sold = salesDS.getAll()
      .filter(x => x.investment_id === id)
      .reduce((t, x) => t + x.quantity, 0);
    // The units still shown as held on Investments, plus the units the Tax page
    // has already assessed a gain on, cannot exceed what was ever owned.
    expect(held + sold).toBeLessThanOrEqual(unitsBefore + 1e-6);
  });

  // ── WINDOW 2: the holding is reduced, the cash leg has not run. ───────────
  it.fails('does not lose the proceeds of a sale the holding already gave up', () => {
    seed();
    repriceTo(60);
    const id = [...oracle.holdings.keys()][0];
    const inv = investmentsDS.getAll().investments.find(i => i.id === id)!;
    const before = calculateNetWorth().net_worth;
    const qty = parseFloat((inv.shares_owned * 0.3).toFixed(6));
    const proceeds = round2(qty * inv.current_price * (inv.conversion_rate ?? 1));

    // Legs 1 and 2, exactly as handleSell runs them…
    salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: qty,
      proceeds, fees: 0, cost_basis: round2((inv.display_cost ?? inv.cost_basis) * 0.3),
      acquired_date: inv.acquired_date ?? null, sale_date: isoFor(60),
      currency: 'AUD', native_currency: inv.native_currency ?? null,
    });
    const remaining = cgtDS.remainingFor(id);
    investmentsDS.update(id, {
      shares_owned: parseFloat((inv.shares_owned - qty).toFixed(8)),
      ...(remaining.parcels.length > 0
        ? { cost_basis: remaining.costBase, cost_basis_currency: 'AUD' }
        : { cost_basis: round2(inv.cost_basis * 0.7) }),
    }, { parcelIntent: 'sale' });
    // …and the tab dies before leg 3 banks the money.
    reload();

    // Selling at the market price is not a loss. The shares left net worth and
    // the cash never arrived, so the user is poorer by the whole proceeds for
    // no reason a screen can explain.
    expect(calculateNetWorth().net_worth).toBeCloseTo(before, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Away for months — the market moved while nobody was looking
// ═════════════════════════════════════════════════════════════════════════════

describe('reopening after months away', () => {
  it('shows the new market, not the one it was closed on', () => {
    seed();
    repriceTo(30);
    const closedOn = readForward();
    const snapshot = new Map(LS());

    // Nobody opens the app for four months. The store on disk is untouched;
    // when it comes back, the page enriches and the prices arrive from the feed.
    restoreDevice(snapshot);
    reload();
    // Nothing has refreshed yet: every figure must still be the one it was
    // closed on. A screen that moves before a price has arrived is inventing.
    const reopened = readForward();
    expect(reopened.inv.total).toBeCloseTo(closedOn.inv.total, 2);
    expect(reopened.ovr.headline).toBeCloseTo(closedOn.ovr.headline, 2);
    expect(reopened.tax.netGain).toBeCloseTo(closedOn.tax.netGain, 2);

    // Now the feed lands four months of movement in one go.
    repriceTo(150);
    const after = readForward();
    expect(after.inv.total).toBeCloseTo(oracle.investments(), 2);
    expect(after.ovr.tiles).toBeCloseTo(after.ovr.headline, 2);
  });

  it('a foreign balance reopened months later is carried at one rate, not two', () => {
    seed();
    repriceTo(30);
    const snapshot = new Map(LS());
    restoreDevice(snapshot);
    reload();
    repriceTo(150);

    const s = useStore.getState();
    const usd = s.accounts.find(a => a.id === BANK_USD)!;
    // The row's stamped rate and the balance stamped beside it have to be the
    // same reading. Two rates on one row is how a foreign balance drifts.
    expect(usd.display_balance).toBeCloseTo(round2(usd.balance * (usd.conversion_rate ?? 1)), 2);
    expect(calculateNetWorth().bank_balance)
      .toBeCloseTo(round2(84_200 + round2(61_500 * FX_USD[150])), 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Editing and deleting the records other records point at
// ═════════════════════════════════════════════════════════════════════════════

describe('linked records edited and deleted underneath the screens', () => {
  it('deleting one of two houses on a shared mortgage leaves the debt owed once', () => {
    seed();
    loansDS.update(L_HOME, { include_in_net_worth: false });
    oracle.loans.get(L_HOME)!.counted = false;
    const before = calculateNetWorth();
    // While the loans term skips it, the two houses owe it once between them.
    expect(before.property).toBeCloseTo(oracle.property(), 2);

    propertiesDS.remove(P_INV);
    oracle.props.delete(P_INV);
    const after = calculateNetWorth();
    // The surviving house must pick the whole debt up — not drop it, not halve it.
    expect(after.property).toBeCloseTo(oracle.property(), 2);
    expect(after.net_worth).toBeCloseTo(oracle.netWorth(), 2);
  });

  it('deleting the account a sale was banked into does not unmake the gain', () => {
    seed();
    repriceTo(45);
    const id = [...oracle.holdings.keys()][0];
    const h = oracle.holdings.get(id)!;
    const qty = parseFloat((h.units * 0.5).toFixed(6));
    pageSell(id, qty, isoFor(45), BANK_AUD);
    oracleSell(id, qty, fyOf(isoFor(45)), true);
    const gainBefore = screenTax(fyOf(isoFor(45))).netGain;

    accountsDS.remove(BANK_AUD);
    oracle.bankAud = 0;
    // The disposal is a fact about the year; where the money landed is not.
    expect(screenTax(fyOf(isoFor(45))).netGain).toBeCloseTo(gainBefore, 2);
    expect(calculateNetWorth().net_worth).toBeCloseTo(oracle.netWorth(), 2);
  });

  it('deleting a sold holding keeps the disposal costed the same', () => {
    seed();
    repriceTo(45);
    const id = [...oracle.holdings.keys()][1];
    const h = oracle.holdings.get(id)!;
    const fy = fyOf(isoFor(45));
    pageSell(id, parseFloat((h.units * 0.5).toFixed(6)), isoFor(45), BANK_AUD);
    const before = screenTax(fy);

    // The user tidies up and deletes the rump holding outright — a DELETE, not
    // a disposal. The gain already realised must not be re-costed by it.
    investmentsDS.remove(id);
    const after = screenTax(fy);
    expect(after.netGain).toBeCloseTo(before.netGain, 2);
    expect(after.costBase).toBeCloseTo(before.costBase, 2);
    expect(after.proceeds).toBeCloseTo(before.proceeds, 2);
  });

  it('switching the SMSF off takes the warehouse with it', () => {
    seed();
    const before = calculateNetWorth();
    const s = useStore.getState();
    s.setSmsfFunds(s.smsfFunds.map(f => f.id === F_SMSF ? { ...f, include_in_net_worth: false } : f));
    const after = calculateNetWorth();
    // The fund's balance leaves. The property it carries must NOT reappear as an
    // asset of its own — that would put $1.18m back on a net worth the user just
    // asked to take $1.64m off.
    expect(after.net_worth).toBeCloseTo(round2(before.net_worth - 1_640_000), 2);
    expect(after.property).toBeCloseTo(before.property, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The parcel book on a second device
// ═════════════════════════════════════════════════════════════════════════════

describe('the capital-gains book across devices', () => {
  /**
   * Sell part of two holdings, then buy more of one of them. That second step is
   * the whole trigger: it rewrites the holding's cost, and the holding's cost is
   * what a device without the written-down book rebuilds a parcel from.
   */
  function sellThenBuyMore() {
    seed();
    repriceTo(40);
    const ids = [...oracle.holdings.keys()];
    for (const id of [ids[0], ids[1]]) {
      const h = oracle.holdings.get(id)!;
      const qty = parseFloat((h.units * 0.35).toFixed(6));
      pageSell(id, qty, isoFor(40), BANK_AUD);
      oracleSell(id, qty, fyOf(isoFor(40)), true);
    }
    pageRefresh();

    // …and then the user tops one of them up, the way the Edit modal does.
    repriceTo(52);
    const id = [...oracle.holdings.keys()][0];
    const row = useStore.getState().investments.find(i => i.id === id)!;
    const h = oracle.holdings.get(id)!;
    const addUnits = parseFloat((h.units * 0.2).toFixed(6));
    const rate = fxFor(h.ccy, 52);
    const paid = round2(round2(addUnits * PATHS[h.key][52]) * rate);
    investmentsDS.update(id, {
      shares_owned: parseFloat((h.units + addUnits).toFixed(8)),
      cost_basis: round2((row.cost_basis ?? 0) + paid),
      cost_basis_currency: 'AUD',
    }, { parcelIntent: 'purchase', acquiredDate: isoFor(52) });
    pageRefresh();
    return screenTax(FY);
  }

  // ── The book travels, as the sync layer is meant to carry it. ────────────
  it('agrees when the parcels and allocations reached the other device', () => {
    const here = sellThenBuyMore();
    const book = LS().get(`ledger-cgt-${U}`)!;
    otherDevice();
    LS().set(`ledger-cgt-${U}`, book);   // what cgtParcel.save / cgtAllocations.save carry
    const there = screenTax(FY);
    expect(there.netGain).toBeCloseTo(here.netGain, 2);
    expect(there.costBase).toBeCloseTo(here.costBase, 2);
    expect(there.proceeds).toBeCloseTo(here.proceeds, 2);
  });

  // ── The book did NOT travel. ─────────────────────────────────────────────
  // Every reason this happens is ordinary: the CGT tables are absent, so
  // localStorage IS the whole book (the code says so in as many words); the
  // device read before the fetch landed; the queued write never drained; the
  // user cleared site data or opened a different browser. The disposals came
  // across in the store either way, so the year is re-costed from a parcel book
  // rebuilt out of what is LEFT of each holding — and the holding's cost was
  // rewritten by the very sale being re-costed.
  it.fails('reports the same capital gain when only the store crossed over', () => {
    const here = sellThenBuyMore();
    otherDevice();
    const there = screenTax(FY);
    expect(there.netGain).toBeCloseTo(here.netGain, 2);
    expect(there.costBase).toBeCloseTo(here.costBase, 2);
  });

  it.fails('reports the same taxable income when only the store crossed over', () => {
    sellThenBuyMore();
    const here = screenTax(FY).taxable;
    otherDevice();
    expect(screenTax(FY).taxable).toBeCloseTo(here, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Personal ↔ Household
// ═════════════════════════════════════════════════════════════════════════════

describe('flipping between personal and household', () => {
  it("never lets a co-owner's shared account into a personal total", () => {
    seed();
    repriceTo(20);
    // The store holds a $415k account owned by somebody else and shared into the
    // household. Personal net worth must not know it exists.
    expect(useStore.getState().accounts.some(a => a.id === 'acc-other-shared')).toBe(true);
    expect(calculateNetWorth('personal').bank_balance).toBeCloseTo(oracle.bank(), 2);
    // To the dollar, not the cent: the headline carries U1's rounding gap, which
    // is a separate finding and must not be smuggled into this one's verdict.
    expect(calculateNetWorth('personal').net_worth).toBeCloseTo(oracle.netWorth(), 0);
  });

  it('holds no personal investments or super in the household total', () => {
    seed();
    repriceTo(20);
    useStore.setState({ financeScope: 'household', activeHouseholdId: HH } as never);
    const hh = calculateNetWorth();
    // Holdings and super are personal by construction — a household total that
    // included them would be adding one member's portfolio to everyone's view.
    expect(hh.investments).toBe(0);
    expect(hh.super_counted).toBe(0);
    expect(hh.super).toBe(0);
  });

  it('returns to the exact personal figures after a round trip', () => {
    seed();
    repriceTo(20);
    const before = readForward();
    for (let i = 0; i < 5; i++) {
      useStore.setState({ financeScope: 'household', activeHouseholdId: HH } as never);
      readForward();
      pageRefresh();                       // the Investments page, visited in household scope
      useStore.setState({ financeScope: 'personal', activeHouseholdId: null } as never);
      readForward();
      pageRefresh();
    }
    const after = readForward();
    expect(after.inv.total).toBeCloseTo(before.inv.total, 2);
    expect(after.ovr.headline).toBeCloseTo(before.ovr.headline, 2);
    expect(after.ovr.property).toBeCloseTo(before.ovr.property, 2);
    expect(after.tax.taxable).toBeCloseTo(before.tax.taxable, 2);
    expect(after.tax.netGain).toBeCloseTo(before.tax.netGain, 2);
  });

  it('nets the shared mortgage once in the household, not once per house', () => {
    seed();
    // The mortgage secures the home (personal) and the unit (shared). In the
    // household scope only the unit is in view, so only its share of the
    // arrangement may appear — and the debt behind it exactly once.
    useStore.setState({ financeScope: 'household', activeHouseholdId: HH } as never);
    const hh = calculateNetWorth();
    expect(hh.loans).toBeCloseTo(812_000, 2);
    expect(hh.property).toBeCloseTo(round2(780_000 * 0.6), 2);
  });
});

