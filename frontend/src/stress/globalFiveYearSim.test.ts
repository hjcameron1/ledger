/**
 * INVESTMENT / NET-WORTH STRESS TEST — five years, one global portfolio.
 *
 * Sixteen simultaneous holdings across the ASX, US markets, London, Europe,
 * Tokyo and crypto — priced in AUD, USD, GBP, EUR and JPY with their own
 * deterministic FX paths — plus brokerage cash and a super fund, marched
 * daily for five years (1825 steps) through two full crash/recovery cycles
 * and a 60-day FX shock. Buys, partial and full sales, 10:1 and 4:1 share
 * splits, quarterly dividends, salary, spending and large one-off deposits
 * and withdrawals are all simulated through the REAL data services.
 *
 * The oracle is an independent truth ledger (marketSim.ts): units × price ×
 * FX with its own running cost and realised-gain books — never the app's own
 * arithmetic. Every single day the suite reconciles:
 *
 *   • each holding's value          • the Investments page total
 *   • the Overview investments/bank/super figures and net worth
 *   • unrealised P&L and the cost base the page derives
 *   • realised P&L across all recorded sales
 *   • cash immediately after every sale
 *
 * Convention (same as regressions.test.ts / investmentNetWorthSim.test.ts):
 * correct behaviour is asserted plainly; a defect found by this hunt is
 * pinned with `it.fails` stating the CORRECT behaviour. F8/F9 (and the F2/F4
 * mirror-mode P&L divergence) were found by this hunt and FIXED in the 2026-08
 * cost source-of-truth cleanup: a foreign holding's cost is locked in the
 * preferred currency at acquisition and never revalued, and display stamps are
 * never authorities. Those blocks now assert plainly.
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
  investmentsDS, superDS, salesDS, cgtDS, calculateNetWorth, moveOwnerBalance,
} from '../services/dataService';
import { useStore } from '../store';
import type { BankAccount, Investment } from '../types';
import {
  pricePath, fxPath, FIVE_YEARS, FX_FIVE_YEARS, SIM_DAYS_5Y,
  round2, round4, TruthLedger, ViolationLog,
  type Regime, type TruthHolding,
} from './marketSim';

// ── The synthetic investor ───────────────────────────────────────────────────

const SIM = 'u-globe';
const BANK = 'acc-globe-everyday';
const BANK0 = 150_000;
const SUPER0 = 380_000;

function seedSim(bankBalance: number) {
  useStore.setState({
    user: {
      id: SIM, email: 'globe@example.test', name: 'Glo Balle',
      currency_preference: 'AUD', theme: 'system', plan: 'premium',
      onboarding_complete: true,
    } as never,
    token: 'stress-token',
    dataOwnerId: SIM,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [{
      id: BANK, user_id: SIM, name: 'Everyday', balance: bankBalance,
      institution: 'CBA', account_type: 'transaction', currency: 'AUD',
      is_manual: true, household_ids: [],
    } as unknown as BankAccount],
    creditCards: [], transactions: [], subscriptions: [],
    investments: [], investmentSales: [], superFunds: [], incomeEntries: [],
    bills: [], goals: [], goalContributions: [], loans: [], loanEvents: [],
    properties: [], insurancePolicies: [], insurancePremiumHistory: [],
    budgets: [], recordShares: [], shareCodes: [], recurringSeries: [],
    transactionSplits: [], creditCardStatements: [], pendingPayments: [],
    ccPaymentPrompts: [], alertStates: [], budgetSettings: null,
    budgetLines: [], customCategories: [], merchants: [], merchantAliases: [],
    transactionRules: [], billSubExclusions: [], hiddenCategories: [],
    selectedCategories: null, categoryAliases: {}, notifications: [],
    netWorth: null, idMap: {}, pendingSyncQueue: [],
    basiqUserId: null,
  } as never);
  // The parcel book, the opening loss and the dividend statements live in
  // localStorage under this user's key, so a fresh world has to clear it too —
  // otherwise each run inherits the last one's acquisitions and a sale draws on
  // parcels from a portfolio that no longer exists.
  localStorage.clear();
}

// ── The portfolio ────────────────────────────────────────────────────────────

type Ccy = 'AUD' | 'USD' | 'GBP' | 'EUR' | 'JPY';

interface Spec5 {
  key: string; name: string; ticker?: string; market: string; asset_type: string;
  units: number; price0: number; seed: number; ccy: Ccy;
  cost0: number;          // native currency
  divQ: number;           // quarterly dividend per unit, native currency
  volScale?: number;
  fixed?: boolean;        // cash: price never moves
}

const HOLDINGS: Spec5[] = [
  { key: 'vas',  name: 'Vanguard Australian Shares', ticker: 'VAS',  market: 'ASX',    asset_type: 'etf',    units: 900,  price0: 101.4,   seed: 501, ccy: 'AUD', cost0: 82_000,    divQ: 0.95 },
  { key: 'cba',  name: 'Commonwealth Bank',          ticker: 'CBA',  market: 'ASX',    asset_type: 'stock',  units: 250,  price0: 178.2,   seed: 502, ccy: 'AUD', cost0: 24_000,    divQ: 2.30 },
  { key: 'bhp',  name: 'BHP Group',                  ticker: 'BHP',  market: 'ASX',    asset_type: 'stock',  units: 800,  price0: 42.6,    seed: 503, ccy: 'AUD', cost0: 30_000,    divQ: 1.45 },
  { key: 'vts',  name: 'Vanguard Total US',          ticker: 'VTS',  market: 'NYSE',   asset_type: 'etf',    units: 300,  price0: 310.5,   seed: 504, ccy: 'USD', cost0: 52_000,    divQ: 0.85 },
  { key: 'aapl', name: 'Apple',                      ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock',  units: 150,  price0: 232.7,   seed: 505, ccy: 'USD', cost0: 21_000,    divQ: 0.26 },
  { key: 'msft', name: 'Microsoft',                  ticker: 'MSFT', market: 'NASDAQ', asset_type: 'stock',  units: 60,   price0: 428.1,   seed: 506, ccy: 'USD', cost0: 18_500,    divQ: 0.75 },
  { key: 'nvda', name: 'NVIDIA',                     ticker: 'NVDA', market: 'NASDAQ', asset_type: 'stock',  units: 80,   price0: 915.4,   seed: 507, ccy: 'USD', cost0: 31_000,    divQ: 0.01, volScale: 1.6 },
  { key: 'shel', name: 'Shell plc',                  ticker: 'SHEL', market: 'LSE',    asset_type: 'stock',  units: 400,  price0: 27.8,    seed: 508, ccy: 'GBP', cost0: 9_500,     divQ: 0.34 },
  { key: 'vuke', name: 'Vanguard FTSE 100',          ticker: 'VUKE', market: 'LSE',    asset_type: 'etf',    units: 350,  price0: 34.2,    seed: 509, ccy: 'GBP', cost0: 10_200,    divQ: 0.28 },
  { key: 'asml', name: 'ASML Holding',               ticker: 'ASML', market: 'AMS',    asset_type: 'stock',  units: 15,   price0: 680.5,   seed: 510, ccy: 'EUR', cost0: 8_800,     divQ: 1.60 },
  { key: 'sap',  name: 'SAP SE',                     ticker: 'SAP',  market: 'XETRA',  asset_type: 'stock',  units: 45,   price0: 182.3,   seed: 511, ccy: 'EUR', cost0: 7_400,     divQ: 1.10 },
  { key: 'tyo',  name: 'Toyota Motor',               ticker: '7203', market: 'TSE',    asset_type: 'stock',  units: 700,  price0: 2_850,   seed: 512, ccy: 'JPY', cost0: 1_700_000, divQ: 30 },
  { key: 'sony', name: 'Sony Group',                 ticker: '6758', market: 'TSE',    asset_type: 'stock',  units: 120,  price0: 13_400,  seed: 513, ccy: 'JPY', cost0: 1_450_000, divQ: 45 },
  { key: 'btc',  name: 'Bitcoin',                    ticker: 'BTC',  market: 'CRYPTO', asset_type: 'crypto', units: 0.6,  price0: 148_000, seed: 514, ccy: 'AUD', cost0: 61_000,    divQ: 0, volScale: 2.5 },
  { key: 'eth',  name: 'Ethereum',                   ticker: 'ETH',  market: 'CRYPTO', asset_type: 'crypto', units: 8,    price0: 5_200,   seed: 515, ccy: 'USD', cost0: 28_000,    divQ: 0, volScale: 2.2 },
  { key: 'cash', name: 'Brokerage cash',                             market: 'CASH',   asset_type: 'cash',   units: 1,    price0: 25_000,  seed: 516, ccy: 'AUD', cost0: 25_000,    divQ: 0, fixed: true },
];

// Native → AUD paths, one per foreign currency, each with its own band.
const FX_SPEC: Record<Exclude<Ccy, 'AUD'>, { seed: number; init: number; lo: number; hi: number }> = {
  USD: { seed: 601, init: 1.52,   lo: 1.10,  hi: 1.95 },
  GBP: { seed: 602, init: 1.92,   lo: 1.45,  hi: 2.60 },
  EUR: { seed: 603, init: 1.65,   lo: 1.25,  hi: 2.20 },
  JPY: { seed: 604, init: 0.0102, lo: 0.007, hi: 0.016 },
};

const scaleVol = (regimes: Regime[], k: number): Regime[] =>
  regimes.map(r => ({ ...r, vol: r.vol * k }));

// ── Truth with splits, cost books and realised gains ─────────────────────────

interface TH5 extends TruthHolding {
  divisor: number;      // cumulative split ratio; effective price = path/divisor
  ccy: Ccy;
  isCash: boolean;
  phase: number;        // staggers the quarterly dividend day per holding
  costAud: number;      // LOCKED AUD cost book: each purchase converted once, at
                        // that day's rate, and never revalued (the doctrine the
                        // 2026-08 cleanup made the app's single convention).
                        // Derived — always the sum of what `parcels` have left.
  /**
   * The purchases behind the holding, oldest first, each with the AUD it cost on
   * the day it was made. A sale consumes them in that order.
   *
   * RESTATED (2026-08, parcel cleanup): this book used to hold one averaged cost
   * and take a sale's cost as `costAud × fraction`. Averaging is not a method the
   * ATO allows for shares, and it was the very defect the cleanup fixed — so the
   * oracle now identifies parcels itself, independently of the app, rather than
   * modelling the behaviour under test.
   */
  parcels: { units: number; cost: number }[];
}

/** FIFO out of a parcel book: what `units` cost, and what is left behind. */
function consumeParcels(parcels: { units: number; cost: number }[], units: number): number {
  let left = units;
  let cost = 0;
  while (left > 1e-9 && parcels.length > 0) {
    const p = parcels[0];
    const take = Math.min(left, p.units);
    const share = take >= p.units - 1e-9 ? 1 : take / p.units;
    const slice = share === 1 ? p.cost : round2(p.cost * share);
    cost = round2(cost + slice);
    p.units = parseFloat((p.units - take).toFixed(8));
    p.cost = round2(p.cost - slice);
    left = parseFloat((left - take).toFixed(8));
    if (p.units <= 1e-9) parcels.shift();
  }
  return cost;
}

/**
 * The independent five-year model. Prices are divisor-aware (splits), and the
 * cost/realised books follow the doctrine the app now implements: the AUD
 * acquisition cost is LOCKED at each purchase's FX rate and never revalued —
 * computed here from this ledger's own numbers, never from app state.
 */
class Truth5 extends TruthLedger {
  realised = 0;

  priceOf(h: TruthHolding, day: number): number {
    const raw = h.path ? h.path[day] : h.fixedPrice;
    const d = (h as TH5).divisor || 1;
    return d === 1 ? raw : round4(raw / d);
  }

  costPrefOf(h: TruthHolding, day: number): number {
    const t = h as TH5;
    if (t.isCash) return this.holdingValue(h, day);
    return t.costAud;
  }

  unrealisedTotal(day: number): number {
    let s = 0;
    for (const h of this.holdings.values()) {
      const t = h as TH5;
      if (t.isCash) continue;
      s += round2(this.holdingValue(h, day) - this.costPrefOf(h, day));
    }
    return round2(s);
  }

  costBasisTotal(day: number): number {
    let s = 0;
    for (const h of this.holdings.values()) {
      const t = h as TH5;
      if (!t.isCash) s += this.costPrefOf(h, day);
    }
    return round2(s);
  }
}

// ── The march ────────────────────────────────────────────────────────────────

interface March5 {
  log: ViolationLog;      // values, totals, net worth, cash, splits
  plLog: ViolationLog;    // realised/unrealised P&L and the cost base
  truth: Truth5;
  finalAppNw: number;
  minBank: number;
  syncKinds: Set<string>;
}

// Sim day → calendar date. Day 0 = 2021-01-04, so day 1825 lands in Jan 2026.
const isoDay = (day: number) =>
  new Date(Date.UTC(2021, 0, 4) + day * 86_400_000).toISOString().slice(0, 10);

/**
 * Five years, day by day, through the real services. `pageMirrors` replays the
 * Investments page's own write-back (enrichAll → setInvestments) after every
 * day, exactly as pages/Investments.tsx does via refreshInvestments().
 */
function march5(pageMirrors: boolean): March5 {
  seedSim(BANK0);
  sync.mockClear();
  const truth = new Truth5();
  const log = new ViolationLog();
  const plLog = new ViolationLog();

  const fx: Record<Exclude<Ccy, 'AUD'>, number[]> = {
    USD: fxPath(FX_SPEC.USD.seed, FX_SPEC.USD.init, FX_SPEC.USD.lo, FX_SPEC.USD.hi, FX_FIVE_YEARS),
    GBP: fxPath(FX_SPEC.GBP.seed, FX_SPEC.GBP.init, FX_SPEC.GBP.lo, FX_SPEC.GBP.hi, FX_FIVE_YEARS),
    EUR: fxPath(FX_SPEC.EUR.seed, FX_SPEC.EUR.init, FX_SPEC.EUR.lo, FX_SPEC.EUR.hi, FX_FIVE_YEARS),
    JPY: fxPath(FX_SPEC.JPY.seed, FX_SPEC.JPY.init, FX_SPEC.JPY.lo, FX_SPEC.JPY.hi, FX_FIVE_YEARS),
  };

  truth.deposit(BANK, BANK0);
  let minBank = Infinity;

  // Day 0 — the whole portfolio through the real create path.
  HOLDINGS.forEach((h, idx) => {
    const path = h.fixed ? null : pricePath(h.seed, h.price0, scaleVol(FIVE_YEARS, h.volScale ?? 1));
    const fxArr = h.ccy === 'AUD' ? null : fx[h.ccy];
    const rec = investmentsDS.add({
      name: h.name, ticker: h.ticker, market: h.market, asset_type: h.asset_type,
      shares_owned: h.units, cost_basis: h.cost0,
      native_currency: h.ccy, cost_basis_currency: h.ccy,
      conversion_rate: fxArr ? fxArr[0] : 1,
      is_dividend_paying: h.divQ > 0, current_price: h.price0,
    });
    const t: TH5 = {
      id: rec.id, key: h.key, units: h.units, path, fixedPrice: h.price0,
      fx: fxArr, costNative: h.cost0, dividendPerUnit: h.divQ,
      divisor: 1, ccy: h.ccy, isCash: h.asset_type === 'cash', phase: idx * 7,
      // Locked at the day-0 rate — the AUD actually paid, forever.
      costAud: round2(h.cost0 * (fxArr ? fxArr[0] : 1)),
      parcels: [{ units: h.units, cost: round2(h.cost0 * (fxArr ? fxArr[0] : 1)) }],
    };
    truth.holdings.set(h.key, t);
  });

  let superBal = SUPER0;
  const superId = superDS.add({
    fund_name: 'Globe Super', balance: superBal,
    employer_contributions: 0, personal_contributions: 0,
    include_in_investments: true, include_in_net_worth: true,
  } as never).id;
  truth.superBalance = superBal;
  const superGrowth = pricePath(7001, 100, FIVE_YEARS);

  const mirror = () => {
    if (!pageMirrors) return;
    const { all } = investmentsDS.enrichAll();
    useStore.getState().setInvestments(all as never);
  };
  mirror();

  const bankBal = () => useStore.getState().accounts.find(a => a.id === BANK)!.balance;
  const th = (key: string) => truth.holdings.get(key) as TH5 | undefined;

  /** Buy `q` more units at today's price, brokerage $9.50, out of the bank.
   *  The purchase's AUD cost is locked at TODAY's rate and added to the AUD
   *  cost book — the row's cost_basis is the locked AUD total, never a
   *  native figure to be revalued later. */
  const buy = (key: string, q: number, day: number) => {
    const t = th(key);
    if (!t) return;
    const costNative = round2(q * truth.priceOf(t, day));
    const costAud = round2(costNative * truth.fxOf(t, day));
    t.units = parseFloat((t.units + q).toFixed(8));
    t.costNative = round2(t.costNative + costNative);
    t.costAud = round2(t.costAud + costAud);
    t.parcels.push({ units: q, cost: costAud });
    investmentsDS.update(t.id, { shares_owned: t.units, cost_basis: t.costAud });
    moveOwnerBalance(BANK, 'bank', -(costAud + 9.5));
    truth.deposit(BANK, -(costAud + 9.5));
  };

  /** A share split, recorded the only way the app allows: the user edits
   *  units × ratio and price ÷ ratio. Value and cost must not move. */
  const split = (key: string, ratio: number, day: number) => {
    const t = th(key);
    if (!t) return;
    const before = investmentsDS.getAll().investments.find(i => i.id === t.id)!;
    const v0 = before.display_value ?? NaN;
    t.divisor *= ratio;
    t.units = parseFloat((t.units * ratio).toFixed(8));
    // A split moves units and nothing else: every parcel keeps its cost.
    for (const p of t.parcels) p.units = parseFloat((p.units * ratio).toFixed(8));
    t.dividendPerUnit = t.dividendPerUnit / ratio;
    investmentsDS.update(t.id, { shares_owned: t.units, current_price: truth.priceOf(t, day) });
    const after = investmentsDS.getAll().investments.find(i => i.id === t.id)!;
    // ratio× units at price/ratio (4 dp) — continuity to within the quote tick.
    log.check(day, `split-continuity:${key}`, after.display_value ?? NaN, v0, 0.15, `${ratio}:1 split`);
  };

  /** Replays pages/Investments.tsx handleSell against the ENRICHED row —
   *  exactly what the page hands it — then banks the net proceeds as the
   *  faithful user does. Truth books its own realised gain from its own
   *  LOCKED AUD cost ledger — the historical acquisition cost of the sold
   *  slice, never a revaluation at the sale-day rate. */
  const sell = (key: string, qtyOf: (units: number) => number, fees: number, day: number) => {
    const t = th(key);
    if (!t) return;
    const inv = investmentsDS.getAll().investments.find(i => i.id === t.id)!;
    const origQty = inv.shares_owned || 0;
    const q = Math.min(qtyOf(t.units), origQty) || origQty;
    const fraction = origQty > 0 ? q / origQty : 1;
    const totalCostPref = inv.display_cost ?? inv.cost_basis;      // page handleSell
    const costSold = round2(totalCostPref * fraction);
    const proceeds = round2(q * truth.priceOf(t, day) * truth.fxOf(t, day));

    // Truth's own book: the units are taken out of the parcels they were bought
    // in, oldest first, at what those parcels actually cost — independent of
    // anything the app stored, and never an average of the holding.
    const truthCostSold = consumeParcels(t.parcels, q);
    truth.realised = round2(truth.realised + round2(proceeds - fees - truthCostSold));

    salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: q,
      proceeds, fees, cost_basis: costSold,
      acquired_date: isoDay(0), sale_date: isoDay(day), currency: 'AUD',
    });

    if (q >= origQty - 1e-9) {
      investmentsDS.remove(t.id, true);
      truth.holdings.delete(key);
    } else {
      // handleSell writes back what the PARCELS have left, not a pro-rata slice
      // of the whole cost — see pages/Investments.tsx.
      const remaining = cgtDS.remainingFor(t.id);
      investmentsDS.update(t.id, {
        shares_owned: parseFloat((origQty - q).toFixed(8)),
        ...(remaining.parcels.length > 0
          ? { cost_basis: remaining.costBase, cost_basis_currency: 'AUD' }
          : { cost_basis: round2(inv.cost_basis * (1 - fraction)) }),
      }, { parcelIntent: 'sale' });
      t.units = parseFloat((t.units - q).toFixed(8));
      t.costNative = round2(t.costNative * (1 - fraction));
      t.costAud = round2(t.parcels.reduce((s, p) => s + p.cost, 0));
    }
    const banked = round2(proceeds - fees);
    moveOwnerBalance(BANK, 'bank', banked);
    truth.deposit(BANK, banked);
    log.check(day, `cash-after-sale:${key}`, bankBal(), round2(truth.bankTotal()), 0.02, `sold ${q}`);
  };

  for (let day = 1; day <= SIM_DAYS_5Y; day++) {
    // ── Market: every priced holding gets today's close (divisor-aware) and,
    // for foreign rows, today's rate — through the same update the edit modal uses.
    for (const h of truth.holdings.values()) {
      const t = h as TH5;
      if (!t.path) continue;
      investmentsDS.update(t.id, {
        current_price: truth.priceOf(t, day),
        ...(t.fx ? { conversion_rate: t.fx[day] } : {}),
      });
    }

    // ── Cash flows: salary, spending, and life's lump sums.
    if (day % 14 === 6)  { moveOwnerBalance(BANK, 'bank', 4_200);  truth.deposit(BANK, 4_200); }
    if (day % 30 === 22) { moveOwnerBalance(BANK, 'bank', -3_300); truth.deposit(BANK, -3_300); }
    if (day === 420)  { moveOwnerBalance(BANK, 'bank', 25_000);  truth.deposit(BANK, 25_000); }   // bonus
    if (day === 1100) { moveOwnerBalance(BANK, 'bank', -38_000); truth.deposit(BANK, -38_000); }  // car
    if (day === 1300) { moveOwnerBalance(BANK, 'bank', 80_000);  truth.deposit(BANK, 80_000); }   // inheritance
    if (day === 1650) { moveOwnerBalance(BANK, 'bank', -45_000); truth.deposit(BANK, -45_000); }  // renovation

    // ── Quarterly dividends, staggered per holding, converted at today's FX.
    for (const h of truth.holdings.values()) {
      const t = h as TH5;
      if (t.dividendPerUnit <= 0 || (day + t.phase) % 91 !== 45) continue;
      const div = round2(t.units * t.dividendPerUnit * truth.fxOf(t, day));
      moveOwnerBalance(BANK, 'bank', div);
      truth.deposit(BANK, div);
    }

    // ── Super: monthly market growth, quarterly contribution.
    if (day % 30 === 15) {
      const g = superGrowth[day] / superGrowth[day - 30 < 0 ? 0 : day - 30];
      superBal = round2(superBal * g);
      superDS.update(superId, { balance: superBal });
      truth.superBalance = superBal;
    }
    if (day % 91 === 60) {
      superBal = round2(superBal + 3_400);
      superDS.update(superId, { balance: superBal });
      truth.superBalance = superBal;
    }

    // ── Buys.
    if (day === 200)  buy('vas', 50, day);
    if (day === 450)  buy('asml', 10, day);
    if (day === 700)  buy('vts', 20, day);     // into the crash
    if (day === 1250) buy('tyo', 100, day);    // after the FX shock
    if (day === 1600) buy('btc', 0.1, day);

    // ── Splits.
    if (day === 600) split('nvda', 10, day);
    if (day === 900) split('aapl', 4, day);

    // ── Sells: partial and full, across four currencies.
    if (day === 350)  sell('nvda', u => u * 0.3, 19.95, day);
    if (day === 800)  sell('vuke', u => u * 0.5, 14.50, day);
    if (day === 1000) sell('sap',  u => u,       12.00, day);
    if (day === 1400) sell('tyo',  u => u * 0.25, 9.95, day);
    if (day === 1500) sell('eth',  u => u,       25.00, day);

    mirror();

    // ── Invariants, every single day.
    const { investments: enriched, portfolio_total: pageTotal } = investmentsDS.getAll();

    for (const h of truth.holdings.values()) {
      const t = h as TH5;
      const row = enriched.find(i => i.id === t.id);
      if (!row) { log.all.push({ day, kind: 'missing-holding', detail: t.key, diff: 0 }); continue; }
      log.check(day, `value:${t.key}`, row.display_value ?? NaN, truth.holdingValue(t, day), 0.011, t.key);
    }
    if (enriched.length !== truth.holdings.size) {
      log.all.push({ day, kind: 'holding-count', detail: `app=${enriched.length} truth=${truth.holdings.size}`, diff: enriched.length - truth.holdings.size });
    }

    const truthInv = truth.investmentsTotal(day);
    log.check(day, 'page-total', pageTotal, truthInv, 0.25);

    const nw = calculateNetWorth();
    log.check(day, 'overview-investments', nw.investments, truthInv, 0.25);
    log.check(day, 'overview-bank', nw.bank_balance, round2(truth.bankTotal()), 0.02);
    log.check(day, 'overview-super', nw.super, truth.superBalance, 0.01);
    log.check(day, 'net-worth', nw.net_worth, round2(truth.netWorth(day)), 0.5);
    log.check(day, 'page-vs-overview', pageTotal, nw.investments, 0.25);

    if (bankBal() < minBank) minBank = bankBal();
    if (bankBal() < -0.005) {
      log.all.push({ day, kind: 'bank-negative', detail: `balance=${bankBal()}`, diff: bankBal() });
    }

    // ── P&L, every single day (separate log — see the mirror-mode pin).
    // Unrealised: what the Investments page header sums (Investments.tsx:219).
    const totalPL = enriched.reduce((s, i) => s + (i.verification?.profit_loss ?? 0), 0);
    plLog.check(day, 'unrealised-total', round2(totalPL), truth.unrealisedTotal(day), 0.05);

    // The cost base the page derives (Investments.tsx:222-225).
    const cashTotal = enriched
      .filter(i => i.asset_type === 'cash')
      .reduce((s, i) => s + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0);
    plLog.check(day, 'cost-basis', round2(pageTotal - totalPL - cashTotal), truth.costBasisTotal(day), 0.05);

    // Realised: the sum of every recorded sale's gain.
    const appRealised = salesDS.getAll().reduce((s, r) => s + r.gain, 0);
    plLog.check(day, 'realised-total', round2(appRealised), truth.realised, 0.02);
  }

  return {
    log, plLog, truth,
    finalAppNw: calculateNetWorth().net_worth,
    minBank,
    syncKinds: new Set(sync.mock.calls.map(c => c[0] as string)),
  };
}

// Marches are deterministic and expensive, so each mode runs once and every
// test reads the cached result. Determinism gets its own fresh run.
const cache = new Map<string, March5>();
const run = (mode: 'raw' | 'mirror'): March5 => {
  if (!cache.has(mode)) cache.set(mode, march5(mode === 'mirror'));
  return cache.get(mode)!;
};

// ── The runs ─────────────────────────────────────────────────────────────────

beforeEach(() => { sync.mockClear(); });

describe('five-year global march — user lives on Overview (no page write-back)', () => {
  it('every holding, every total, net worth, cash and splits reconcile all 1825 days', () => {
    const { log, minBank } = run('raw');
    expect(log.all, `\n${log.report()}`).toEqual([]);
    // The withdrawals were real but survivable — the scenario never went broke,
    // so every bank check above tested a live balance.
    expect(minBank).toBeGreaterThan(0);
  }, 300_000);

  it('realised + unrealised P&L and the cost base reconcile daily', () => {
    const { plLog } = run('raw');
    expect(plLog.all, `\n${plLog.report()}`).toEqual([]);
  }, 300_000);

  it('is deterministic — same seeds, same final net worth to the cent', () => {
    const fresh = march5(false);
    expect(fresh.finalAppNw).toBe(run('raw').finalAppNw);
  }, 300_000);
});

describe('five-year global march — the Investments page mirrors after each day', () => {
  it('every holding, every total, net worth, cash and splits reconcile all 1825 days', () => {
    const { log } = run('mirror');
    expect(log.all, `\n${log.report()}`).toEqual([]);
  }, 300_000);

  // F4/F2/F8 in the wild, FIXED: the write-back used to stamp display_cost at
  // that day's FX and enrichment trusted the stamp forever, so P&L — and every
  // later sale's cost basis — was priced at the first visit's rate (first
  // divergence day 1; realised followed on day 350's NVDA sale). Cost is now
  // locked at acquisition and stamps are never authorities, so five years of
  // daily mirroring changes nothing.
  it('P&L reconciles daily even after the page has stamped display_cost', () => {
    const { plLog } = run('mirror');
    expect(plLog.all, `\n${plLog.report()}`).toEqual([]);
  }, 300_000);
});

describe('every mutation the march made is durable (synced)', () => {
  it('creates, price updates, buys, sells, splits, cash moves and super all enqueue sync ops', () => {
    const kinds = run('raw').syncKinds;
    expect(kinds).toContain('investment.create');
    expect(kinds).toContain('investment.update');
    expect(kinds).toContain('investment.delete');
    expect(kinds).toContain('sale.create');
    expect(kinds).toContain('account.adjust');
    expect(kinds).toContain('super.create');
    expect(kinds).toContain('super.update');
  }, 300_000);
});

// ═════════════════════════════════════════════════════════════════════════════
//  FINDINGS — defects this hunt surfaced (F8, F9), both FIXED in the 2026-08
//  cost source-of-truth cleanup. F1–F7 live in investmentNetWorthSim.test.ts;
//  the numbering continues. Each block asserts the correct behaviour plainly.
// ═════════════════════════════════════════════════════════════════════════════

/** One enriched-in-store holding, the shape a server bootstrap (or the
 *  Investments page's own write-back) leaves behind. */
function addAndMirror(data: Parameters<typeof investmentsDS.add>[0]): Investment {
  const rec = investmentsDS.add(data);
  const { all } = investmentsDS.enrichAll();
  useStore.getState().setInvestments(all as never);
  return useStore.getState().investments.find(i => i.id === rec.id)!;
}

describe('F8 — a sale costs the sold units at their LOCKED acquisition cost', () => {
  // WAS: handleSell took the sold cost from a display_cost stamp frozen at
  // whatever rate applied when the page first wrote back — so the recorded
  // sale row (the number the CGT engine assesses) was priced at an arbitrary
  // visit's rate. FIXED — and the correct answer restated with the fix: the
  // doctrine is now that the AUD acquisition cost is LOCKED at purchase
  // (here 60,000 USD × 1.52 = A$91,200, the money actually paid) and a later
  // FX move changes the VALUE, never the historical cost. Selling at 1.30
  // yields proceeds A$161,460 against the locked A$91,200 → gain A$70,260 —
  // the same figure whether or not the page was ever visited, which is the
  // point. (The original pin asserted A$78,000 of cost at the sale-day rate,
  // the app's OLD stated convention — superseded by this cleanup.)
  it('selling a stamped USD holding books the gain against the locked cost', () => {
    seedSim(50_000);
    const row = addAndMirror({
      name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE',
      asset_type: 'etf', shares_owned: 400, cost_basis: 60_000,
      native_currency: 'USD', cost_basis_currency: 'USD',
      conversion_rate: 1.52, current_price: 310.5,
    });
    expect(row.display_cost).toBe(91_200); // locked at purchase: 60,000 × 1.52

    investmentsDS.update(row.id, { conversion_rate: 1.30 });

    // Replay handleSell for the full position at the new rate.
    const inv = investmentsDS.getAll().investments.find(i => i.id === row.id)!;
    const proceeds = round2(400 * 310.5 * 1.30);                 // 161,460.00
    const costSold = round2((inv.display_cost ?? inv.cost_basis) * 1);
    const sale = salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: 400,
      proceeds, fees: 0, cost_basis: costSold,
      acquired_date: '2021-03-01', sale_date: '2025-11-01', currency: 'AUD',
    });

    expect(costSold).toBe(91_200);
    expect(sale.gain).toBeCloseTo(70_260, 2);   // 161,460 − 91,200
    // Held well past the 2022-03-01 anniversary and a gain → discounted.
    expect(sale.discount_eligible).toBe(true);
  });
});

describe('F9 — P&L on a foreign holding must include the FX component', () => {
  // WAS: both enrichers converted a native-currency cost at the CURRENT rate,
  // so P&L was (value − cost) × today's rate and the FX gain or loss on the
  // money actually paid vanished entirely. FIXED: the cost is converted ONCE at
  // add time (the purchase rate) and stored locked in the preferred currency —
  // US$40,000 invested at 1.30 cost A$52,000, and when AUD falls to 1.60 the
  // position is worth A$64,000: the real A$12,000 gain now shows.
  it('an unchanged USD position shows the AUD gain when the currency moves', () => {
    seedSim(10_000);
    const rec = investmentsDS.add({
      name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE',
      asset_type: 'etf', shares_owned: 400, cost_basis: 40_000,
      native_currency: 'USD', cost_basis_currency: 'USD',
      conversion_rate: 1.30, current_price: 100,
    });

    investmentsDS.update(rec.id, { conversion_rate: 1.60 });

    const pl = investmentsDS.getAll().investments
      .find(i => i.id === rec.id)!.verification!.profit_loss;
    expect(pl).toBeCloseTo(12_000, 2);
  });
});
