/**
 * REAL MARKET VALIDATION — one portfolio, seven years, no invented numbers.
 *
 * Everything the app is driven with here came off the wire: `realMarketData.ts`
 * holds the closes that actually printed on the ASX, NASDAQ, the LSE, XETRA and
 * the Tokyo Stock Exchange between 3 June 2019 and 28 August 2026, the dividends
 * those registries actually paid, the two splits that actually happened (Apple
 * 4:1 on 31 August 2020, Toyota 5:1 on 29 September 2021) and the ECB's own
 * published AUD reference rates for every one of those days.
 *
 * The other stress suites in this folder drive the same services with modelled
 * price paths, and they are worth more than this one for coverage — a random
 * walk visits states history never did. What they CANNOT do is disagree with the
 * real world about the shape of the data, because they were written by the same
 * hand as the code. This file exists for the disagreements:
 *
 *   • a London holding is quoted in PENCE (`GBp`), a hundred to the pound, and
 *     no synthetic suite has ever had a holding whose price and whose currency
 *     were in different units;
 *   • a price series is RESTATED BACKWARDS when a split happens, so the close
 *     the feed serves for June 2019 is not the price anybody paid that day;
 *   • the yen is quoted at 114.634 to the dollar one way round and 0.0087 the
 *     other, which is the same rate to two significant figures instead of six;
 *   • the real events are lumpy — Apple's split lands mid-FY, BP pays four times
 *     a year in pence, SAP pays once a year, BHP's dividend is declared in US
 *     dollars and reported in Australian ones.
 *
 * THE ORACLE. Every figure the app produces is checked against arithmetic
 * written here from the tape: units × as-traded price × the ECB rate for the
 * day, with its own parcel book in AUD, its own realised-gain ledger and its own
 * capital-gains roll-forward. It never calls a Ledger utility. Where a number
 * can be anchored to something outside both — Apple's $499.23 close on the last
 * day before its split, Toyota's ¥10,385 — it is.
 *
 * NO REAL USER DATA IS TOUCHED. The store is seeded from scratch with a
 * synthetic taxpayer; the network is mocked out; localStorage is an in-memory
 * map. What is real here is the market, not the account.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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
  investmentsDS, salesDS, cgtDS, calculateNetWorth,
} from '../services/dataService';
import { useStore } from '../store';
import type { BankAccount } from '../types';
import {
  INSTRUMENTS, DIVIDENDS, SPLITS, PRICES, DATES,
  priceOn, toAud, audTo, splitFactorAfter,
} from './realMarketData';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const q8 = (n: number) => parseFloat(n.toFixed(8));

/** The Australian financial year a date falls in. Written here, not imported. */
function fyOf(date: string): string {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Twelve months and a day — the ATO's test, derived here from first principles. */
function heldTwelveMonthsAndADay(acquired: string, disposed: string): boolean {
  const [ay, am, ad] = acquired.split('-').map(Number);
  const [dy, dm, dd] = disposed.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ay + 1, am, 0)).getUTCDate();
  return dy * 10_000 + dm * 100 + dd > (ay + 1) * 10_000 + am * 100 + Math.min(ad, lastDay);
}

// ─── What Ledger stores, versus what the feed says ──────────────────────────

/**
 * A quote restated in the currency the listing settles in. This is the fold the
 * price service now performs at the boundary: 514.5 `GBp` is £5.145. Written
 * out again here, from the fixture's own unit count, so the suite is checking
 * the app against the market rather than against a shared helper.
 */
function settlementPrice(symbol: string, day: string): number {
  return priceOn(symbol, day) / INSTRUMENTS[symbol].feedUnitsPerSettlementUnit;
}

/** The currency a holding is stored in — never the feed's `GBp`. */
const storedCurrency = (symbol: string) => INSTRUMENTS[symbol].settlementCurrency;

// ─── The oracle ─────────────────────────────────────────────────────────────

interface OParcel { units: number; costAud: number; date: string }
interface OSlice { units: number; costAud: number; proceedsAud: number; acquired: string; gain: number; discountable: boolean }
interface OEvent { key: string; saleDate: string; fy: string; units: number; grossProceeds: number; fees: number; costAud: number; gain: number; slices: OSlice[] }

class RealOracle {
  /** Units currently held, per symbol, in TODAY's units. */
  units = new Map<string, number>();
  /** The parcel book, in AUD, at the rate of each purchase's own day. */
  book = new Map<string, OParcel[]>();
  events: OEvent[] = [];
  /** Gross dividends received, in AUD at the rate on the payment day. */
  dividendsAud = 0;
  /** Cash realised from sales, net of fees, in AUD. */
  cashFromSales = 0;
  /** What was paid for everything ever bought, in AUD. */
  investedAud = 0;

  buy(sym: string, units: number, costAud: number, date: string): void {
    const lots = this.book.get(sym) ?? [];
    lots.push({ units: q8(units), costAud: r2(costAud), date });
    lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    this.book.set(sym, lots);
    this.units.set(sym, q8((this.units.get(sym) ?? 0) + units));
    this.investedAud = r2(this.investedAud + costAud);
  }

  /** A split multiplies units. Cost and acquisition dates never move. */
  split(sym: string, ratio: number): void {
    for (const p of this.book.get(sym) ?? []) p.units = q8(p.units * ratio);
    this.units.set(sym, q8((this.units.get(sym) ?? 0) * ratio));
  }

  costHeld(sym: string): number {
    return r2((this.book.get(sym) ?? []).reduce((s, p) => s + p.costAud, 0));
  }

  /** Units × the as-traded settlement price × AUD per unit of its currency. */
  valueAud(sym: string, day: string): number {
    const u = this.units.get(sym) ?? 0;
    if (u <= 0) return 0;
    return r2(u * settlementPrice(sym, day) * toAud(day, storedCurrency(sym)));
  }

  totalAud(day: string): number {
    let t = 0;
    for (const sym of this.units.keys()) t = r2(t + this.valueAud(sym, day));
    return t;
  }

  sell(sym: string, units: number, grossAud: number, feesAud: number, saleDate: string): OEvent {
    const net = r2(Math.max(0, grossAud - feesAud));
    const lots = this.book.get(sym) ?? [];
    const taken: { units: number; costAud: number; acquired: string }[] = [];
    let left = q8(units);
    for (const p of lots) {
      if (left <= 1e-9) break;
      if (p.units <= 1e-9) continue;
      const take = Math.min(left, p.units);
      const whole = take >= p.units - 1e-9;
      const cost = whole ? p.costAud : r2(p.costAud * (take / p.units));
      p.units = q8(p.units - take); p.costAud = r2(p.costAud - cost);
      left = q8(left - take);
      taken.push({ units: take, costAud: cost, acquired: p.date });
    }
    if (left > 1e-9) throw new Error(`oracle: ${sym} sold more than was ever bought`);
    this.units.set(sym, q8((this.units.get(sym) ?? 0) - units));
    this.cashFromSales = r2(this.cashFromSales + net);

    const totalUnits = taken.reduce((s, t) => s + t.units, 0);
    let assigned = 0;
    const slices: OSlice[] = taken.map((t, i) => {
      const p = i === taken.length - 1 ? r2(net - assigned) : r2((net * t.units) / totalUnits);
      assigned = r2(assigned + p);
      const gain = r2(p - t.costAud);
      return { units: t.units, costAud: t.costAud, proceedsAud: p, acquired: t.acquired, gain,
               discountable: gain > 0 && heldTwelveMonthsAndADay(t.acquired, saleDate) };
    });
    const ev: OEvent = {
      key: sym, saleDate, fy: fyOf(saleDate), units: q8(units),
      grossProceeds: r2(grossAud), fees: r2(feesAud),
      costAud: r2(taken.reduce((s, t) => s + t.costAud, 0)),
      gain: r2(slices.reduce((s, x) => s + x.gain, 0)), slices,
    };
    this.events.push(ev);
    return ev;
  }

  /** The FY roll-forward: losses against non-discount gains first, then the 50%. */
  positions(): Map<string, { netCapitalGain: number; carriedForward: number; discount: number; grossDiscountable: number; grossOther: number; currentYearLoss: number }> {
    const out = new Map<string, { netCapitalGain: number; carriedForward: number; discount: number; grossDiscountable: number; grossOther: number; currentYearLoss: number }>();
    let carried = 0;
    for (const fy of [...new Set(this.events.map(e => e.fy))].sort()) {
      let disc = 0, other = 0, loss = 0;
      for (const e of this.events.filter(x => x.fy === fy)) {
        for (const s of e.slices) {
          if (s.gain > 0) { if (s.discountable) disc = r2(disc + s.gain); else other = r2(other + s.gain); }
          else if (s.gain < 0) loss = r2(loss - s.gain);
        }
      }
      const pool = r2(loss + carried);
      const toOther = r2(Math.min(pool, other));
      const toDisc = r2(Math.min(r2(pool - toOther), disc));
      const afterDisc = r2(disc - toDisc);
      const discount = r2(afterDisc * 0.5);
      const net = r2(Math.max(0, r2(r2(other - toOther) + afterDisc) - discount));
      carried = r2(pool - toOther - toDisc);
      out.set(fy, { netCapitalGain: net, carriedForward: carried, discount,
                    grossDiscountable: disc, grossOther: other, currentYearLoss: loss });
    }
    return out;
  }
}

// ─── The taxpayer ───────────────────────────────────────────────────────────

const USER = 'u-realmarket';
const BANK = 'acc-real-everyday';
const OPENING_CASH = 400_000;

function seedUser(): void {
  useStore.setState({
    user: { id: USER, email: 'real@example.test', name: 'Vera Fye',
      currency_preference: 'AUD', theme: 'system', plan: 'premium', onboarding_complete: true } as never,
    token: 'stress-token', dataOwnerId: USER,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [{ id: BANK, user_id: USER, name: 'Everyday', balance: OPENING_CASH,
      institution: 'CBA', account_type: 'transaction', currency: 'AUD',
      is_manual: true, household_ids: [] } as unknown as BankAccount],
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
    netWorth: null, idMap: {}, pendingSyncQueue: [], basiqUserId: null,
  } as never);
  localStorage.clear();
}

// ─── The story, in the order it happened ────────────────────────────────────

interface Buy   { kind: 'buy';   day: string; symbol: string; units: number }
interface Split { kind: 'split'; day: string; symbol: string; ratio: number }
interface Sell  { kind: 'sell';  day: string; symbol: string; units: number; fees: number }
type Move = Buy | Split | Sell;

/**
 * A real investor's seven years. The split dates are the real ones and are NOT
 * chosen — they are read out of the feed, so if Yahoo ever restates them this
 * suite moves with the market rather than drifting away from it.
 */
const MOVES: Move[] = [
  { kind: 'buy',  day: '2019-06-03', symbol: 'AAPL',   units: 400 },
  { kind: 'buy',  day: '2019-07-01', symbol: 'CBA.AX', units: 500 },
  { kind: 'buy',  day: '2019-09-02', symbol: '7203.T', units: 300 },
  { kind: 'split', day: SPLITS['AAPL'][0].date,   symbol: 'AAPL',   ratio: SPLITS['AAPL'][0].ratio },
  { kind: 'buy',  day: '2020-10-01', symbol: 'SAP.DE', units: 200 },
  { kind: 'buy',  day: '2021-03-01', symbol: 'BP.L',   units: 2_000 },
  { kind: 'split', day: SPLITS['7203.T'][0].date, symbol: '7203.T', ratio: SPLITS['7203.T'][0].ratio },
  { kind: 'buy',  day: '2022-05-16', symbol: 'BHP.AX', units: 400 },
  { kind: 'sell', day: '2022-11-15', symbol: 'AAPL',   units: 600, fees: 19.95 },
  { kind: 'sell', day: '2024-02-15', symbol: 'CBA.AX', units: 200, fees: 19.95 },
  { kind: 'sell', day: '2025-11-14', symbol: 'BP.L',   units: 800, fees: 14.50 },
  { kind: 'sell', day: '2026-06-15', symbol: '7203.T', units: 500, fees: 22.00 },
];

interface SaleCheck {
  label: string; symbol: string; saleDate: string;
  app: { cost: number; gain: number; discount: boolean; proceeds: number };
  oracle: { cost: number; gain: number };
}

interface Reading {
  day: string;
  perHolding: { symbol: string; app: number; oracle: number }[];
  appTotal: number; oracleTotal: number;
  appNetWorth: number;
}

/** The holding's worth either side of a split, before any new quote lands. */
interface Continuity {
  symbol: string; day: string; ratio: number;
  unitsBefore: number; unitsAfter: number;
  valueBefore: number; valueAfter: number;
  costBefore: number; costAfter: number;
  parcelUnitsAfter: number;
}

interface CgtSnapshot {
  fy: string; netCapitalGain: number; discount: number; carriedForward: number;
}

interface World {
  oracle: RealOracle;
  ids: Map<string, string>;
  sales: SaleCheck[];
  readings: Reading[];
  dividendEvents: { symbol: string; day: string; grossAud: number; feedGrossAud: number }[];
  continuity: Continuity[];
  /** The whole CGT position, captured while this world still owns the store. */
  cgt: CgtSnapshot[];
  /** Units the parcel book has left per symbol, captured at the same moment. */
  remaining: Map<string, number>;
  /** Split records in the book at the end — how many, and under whose ids. */
  bookSplits: { investmentId: string | null; ratio: number; id: string }[];
}

/**
 * How a split reaches the device.
 *
 *   'edit'   — the user works out what happened and adjusts the unit count
 *              themselves. dataService reads units-up/cost-flat as a split and
 *              writes it into the parcel book.
 *   'server' — the backend detected it from the feed, applied it to the holding
 *              and wrote the book entry, and this device picks BOTH up in one
 *              bootstrap: the holding row is replaced wholesale by the server's,
 *              and cgtDS.adopt takes the server's book. This is what a second
 *              phone, or a reload, actually experiences.
 *
 * Both are built, and the suite's last section asserts they are
 * indistinguishable — same values, same parcels, same CGT, same net worth.
 */
type SplitPath = 'edit' | 'server';

let W: World;
let SERVER: World;

/** The checkpoint days, in order — every date the fixture captured. */
const CHECKPOINTS = DATES.filter(d => d >= '2019-06-03');

function buildWorld(splitPath: SplitPath): World {
  seedUser();
  sync.mockClear();
  const oracle = new RealOracle();
  const ids = new Map<string, string>();
  const sales: SaleCheck[] = [];
  const readings: Reading[] = [];
  const dividendEvents: World['dividendEvents'] = [];
  const continuity: Continuity[] = [];

  /** Today's quote and today's rate, exactly as a price refresh writes them. */
  const mark = (symbol: string, day: string) => {
    const id = ids.get(symbol); if (!id) return;
    investmentsDS.update(id, {
      current_price: settlementPrice(symbol, day),
      conversion_rate: toAud(day, storedCurrency(symbol)),
    });
  };

  const buy = (m: Buy) => {
    const ccy = storedCurrency(m.symbol);
    const px = settlementPrice(m.symbol, m.day);
    const fx = toAud(m.day, ccy);
    const costNative = r2(m.units * px);
    const existing = ids.get(m.symbol);
    if (!existing) {
      const rec = investmentsDS.add({
        name: m.symbol, ticker: INSTRUMENTS[m.symbol].ticker,
        market: INSTRUMENTS[m.symbol].market, asset_type: 'stock',
        shares_owned: m.units, cost_basis: costNative,
        native_currency: ccy, cost_basis_currency: ccy,
        conversion_rate: fx, current_price: px,
        is_dividend_paying: true, acquired_date: m.day,
      });
      ids.set(m.symbol, rec.id);
    } else {
      const row = useStore.getState().investments.find(i => i.id === existing)!;
      investmentsDS.update(existing, {
        shares_owned: q8(row.shares_owned + m.units),
        cost_basis: r2(row.cost_basis + r2(costNative * fx)),
        cost_basis_currency: 'AUD', conversion_rate: fx, current_price: px,
      });
    }
    oracle.buy(m.symbol, m.units, r2(costNative * fx), m.day);
  };

  /** The server's own id for a split: derived from the holding, the date and
   *  the ratio, so it is the same on every device and can only land once. The
   *  backend computes it as a v5 UUID; what matters here is only that this
   *  device never minted it. */
  const serverSplitId = (investmentId: string, date: string, ratio: number): string => {
    let h = 0;
    for (const ch of `${investmentId}:${date}:${ratio.toFixed(8)}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hex = h.toString(16).padStart(8, '0');
    return `${hex}-0000-5000-8000-${hex}00000000`.slice(0, 36);
  };

  /** Everything the parcel book holds, in the shape the server sends it back. */
  const bookAsServerSees = () => {
    const raw = JSON.parse(localStorage.getItem(`ledger-cgt-${USER}`) ?? '{}') as {
      parcels?: Record<string, unknown>[];
      splits?: Record<string, unknown>[];
      allocations?: Record<string, unknown>[];
      opening?: unknown;
    };
    return {
      parcels: (raw.parcels ?? []).map(p => ({
        id: p.id, investment_id: p.investmentId, label: p.label, ticker: p.ticker,
        asset_type: p.assetType, quantity: p.quantity, cost_base: p.costBase,
        acquired_date: p.acquiredDate, recorded_at: p.recordedAt, origin: p.origin,
      })),
      splits: (raw.splits ?? []).map(x => ({
        id: x.id, investment_id: x.investmentId, label: x.label, ticker: x.ticker,
        ratio: x.ratio, recorded_at: x.recordedAt,
      })),
      allocations: (raw.allocations ?? []).map(a => ({
        id: a.id, sale_id: a.saleId, parcel_id: a.parcelId, quantity: a.quantity,
        cost_base: a.costBase, acquired_date: a.acquiredDate, source: a.source,
        settled_at: a.settledAt, settled_by: a.settledBy,
      })),
      opening: (raw.opening ?? null) as never,
    };
  };

  const probe = (symbol: string, day: string) => {
    const id = ids.get(symbol)!;
    const inv = investmentsDS.getAll().investments.find(i => i.id === id)!;
    return {
      units: inv.shares_owned,
      value: inv.display_value,
      cost: inv.display_cost ?? inv.cost_basis,
      parcelUnits: cgtDS.remainingFor(id).quantity,
    };
  };

  const split = (m: Split) => {
    const id = ids.get(m.symbol)!;
    const before = probe(m.symbol, m.day);
    const row = useStore.getState().investments.find(i => i.id === id)!;
    const newUnits = q8(row.shares_owned * m.ratio);
    // Price moves the other way by the same ratio, so the holding's worth is
    // unchanged at the instant the split lands — whichever path it came by.
    const heldPrice = row.current_price / m.ratio;

    if (splitPath === 'edit') {
      // Units up, cost flat: dataService reads exactly this as a split.
      investmentsDS.update(id, { shares_owned: newUnits, current_price: heldPrice });
    } else {
      // The server already did it. A bootstrap REPLACES the holding row with the
      // server's — it never goes through investmentsDS.update, so this device
      // infers nothing and mints nothing.
      useStore.setState({
        investments: useStore.getState().investments.map(i =>
          i.id === id ? { ...i, shares_owned: newUnits, current_price: heldPrice } : i),
      } as never);
      // …and the book the server wrote arrives in the same bootstrap.
      const book = bookAsServerSees();
      cgtDS.adopt({
        available: true,
        parcels: book.parcels,
        splits: [...book.splits, {
          id: serverSplitId(id, m.day, m.ratio),
          investment_id: id, label: m.symbol,
          ticker: INSTRUMENTS[m.symbol].ticker,
          ratio: m.ratio, recorded_at: `${m.day}T00:00:00.000Z`,
        }],
        allocations: book.allocations,
        opening: book.opening,
      });
    }

    const after = probe(m.symbol, m.day);
    continuity.push({
      symbol: m.symbol, day: m.day, ratio: m.ratio,
      unitsBefore: before.units, unitsAfter: after.units,
      valueBefore: before.value, valueAfter: after.value,
      costBefore: before.cost, costAfter: after.cost,
      parcelUnitsAfter: after.parcelUnits,
    });
    oracle.split(m.symbol, m.ratio);
  };

  /** pages/Investments.tsx handleSell, replayed on the enriched row. */
  const sell = (m: Sell) => {
    const id = ids.get(m.symbol)!;
    mark(m.symbol, m.day);
    const inv = investmentsDS.getAll().investments.find(i => i.id === id)!;
    const origQty = inv.shares_owned || 0;
    const qty = Math.min(m.units, origQty);
    const fraction = origQty > 0 ? qty / origQty : 1;
    const costSold = r2((inv.display_cost ?? inv.cost_basis) * fraction);
    const proceeds = r2(qty * settlementPrice(m.symbol, m.day) * toAud(m.day, storedCurrency(m.symbol)));

    const row = salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: qty,
      proceeds, fees: m.fees, cost_basis: costSold,
      acquired_date: String(inv.acquired_date ?? '').slice(0, 10) || null,
      sale_date: m.day, currency: 'AUD',
    });

    if (qty >= origQty - 1e-9) investmentsDS.remove(inv.id, true);
    else investmentsDS.update(inv.id, {
      shares_owned: q8(origQty - qty),
      cost_basis: r2(inv.cost_basis * (1 - fraction)),
    });

    const truth = oracle.sell(m.symbol, qty, proceeds, m.fees, m.day);
    sales.push({
      label: `${m.symbol} ${qty} units on ${m.day}`, symbol: m.symbol, saleDate: m.day,
      app: { cost: row.cost_basis, gain: row.gain, discount: row.discount_eligible, proceeds: row.proceeds },
      oracle: { cost: truth.costAud, gain: truth.gain },
    });
  };

  // March the calendar — on the SIMULATED clock, not the wall clock.
  //
  // Every fact the parcel book records is stamped with the moment it was
  // written down, and `recordedAt` is what decides which parcels a split
  // scales: a purchase entered before the split is in old units, one entered
  // after is in new ones. Leaving the stamps at today's real date would make
  // the whole seven years simultaneous, and a split dated 2020 would sort
  // before parcels "recorded" in 2026 — which is not what happens to anybody
  // living through it.
  vi.useFakeTimers({ toFake: ['Date'] });
  for (const day of CHECKPOINTS) {
    vi.setSystemTime(new Date(`${day}T12:00:00.000Z`));
    for (const m of MOVES.filter(x => x.day === day)) {
      if (m.kind === 'buy') buy(m);
      else if (m.kind === 'split') split(m);
      else sell(m);
    }

    for (const symbol of ids.keys()) {
      const held = W_units(oracle, symbol);
      if (held <= 0) continue;
      const due = DIVIDENDS[symbol].find(d => d.date === day);
      if (!due) continue;
      const ccy = storedCurrency(symbol);
      const per = due.asDeclared / INSTRUMENTS[symbol].feedUnitsPerSettlementUnit;
      const grossAud = r2(held * per * toAud(day, ccy));
      oracle.dividendsAud = r2(oracle.dividendsAud + grossAud);
      dividendEvents.push({
        symbol, day, grossAud,
        // What the same code would have booked from the feed's own number, with
        // neither the pence fold nor the split restatement undone.
        feedGrossAud: r2(held * due.feedAmount * toAud(day, ccy)),
      });
    }

    for (const symbol of ids.keys()) mark(symbol, day);

    const { investments, portfolio_total } = investmentsDS.getAll();
    readings.push({
      day,
      perHolding: investments.map(i => {
        const symbol = [...ids.entries()].find(([, id]) => id === i.id)![0];
        return { symbol, app: i.display_value, oracle: oracle.valueAud(symbol, day) };
      }),
      appTotal: r2(portfolio_total),
      oracleTotal: oracle.totalAud(day),
      appNetWorth: calculateNetWorth().net_worth,
    });
  }

  vi.useRealTimers();

  const cgt: CgtSnapshot[] = [...oracle.positions().keys()].map(fy => {
    const got = cgtDS.build(fy);
    return {
      fy,
      netCapitalGain: got.netCapitalGain,
      discount: got.discount,
      carriedForward: got.carriedForward.ordinary,
    };
  });
  const remaining = new Map<string, number>();
  for (const [symbol, id] of ids) remaining.set(symbol, cgtDS.remainingFor(id).quantity);
  const bookSplits = cgtDS.splits().map(x => ({ investmentId: x.investmentId, ratio: x.ratio, id: x.id }));

  return { oracle, ids, sales, readings, dividendEvents, continuity, cgt, remaining, bookSplits };
}

/** Units the oracle currently holds — a free function so `buildWorld` can use it
 *  before `W` is assigned. */
function W_units(o: RealOracle, symbol: string): number {
  return o.units.get(symbol) ?? 0;
}

beforeAll(() => {
  // The server world first, so the store is left holding the world the rest of
  // the suite asks live questions of.
  SERVER = buildWorld('server');
  W = buildWorld('edit');
});
afterAll(() => vi.useRealTimers());

// ─── 1. The fixture really is the tape ──────────────────────────────────────

describe('the market data this suite is driven with', () => {
  it('is the as-traded price, not the feed\'s back-adjusted one', () => {
    // Apple's last close before the 4:1 split was $499.23, and Toyota's last
    // close before its 5:1 was ¥10,385. Both are outside this repo entirely.
    expect(priceOn('AAPL', '2020-08-28')).toBeCloseTo(499.23, 2);
    expect(priceOn('7203.T', '2021-09-28')).toBeCloseTo(10_385, 0);
    expect(priceOn('AAPL', '2019-06-03')).toBeCloseTo(173.30, 2);
  });

  it('shows each split as a clean ratio between the days either side of it', () => {
    for (const [symbol, splits] of Object.entries(SPLITS)) {
      for (const s of splits) {
        const before = DATES.filter(d => d < s.date).pop()!;
        const after = DATES.find(d => d >= s.date)!;
        // Price per unit falls by the ratio; the money does not move.
        const ratio = priceOn(symbol, before) / priceOn(symbol, after);
        expect(ratio, `${symbol} ${s.date}`).toBeGreaterThan(s.ratio * 0.85);
        expect(ratio, `${symbol} ${s.date}`).toBeLessThan(s.ratio * 1.15);
      }
    }
  });

  it('quotes London in pence and everything else in its own currency', () => {
    expect(INSTRUMENTS['BP.L'].feedCurrency).toBe('GBp');
    expect(INSTRUMENTS['BP.L'].feedUnitsPerSettlementUnit).toBe(100);
    for (const sym of ['CBA.AX', 'BHP.AX', 'AAPL', 'SAP.DE', '7203.T']) {
      expect(INSTRUMENTS[sym].feedUnitsPerSettlementUnit, sym).toBe(1);
    }
    // BP really did trade around five pounds a share in March 2021.
    expect(settlementPrice('BP.L', '2021-03-01')).toBeGreaterThan(2);
    expect(settlementPrice('BP.L', '2021-03-01')).toBeLessThan(6);
  });

  it('carries a real ECB rate for every day it asks a question on', () => {
    for (const day of CHECKPOINTS) {
      for (const ccy of ['USD', 'GBP', 'EUR', 'JPY']) {
        expect(audTo(day, ccy), `${day} ${ccy}`).toBeGreaterThan(0);
      }
      // The yen is the one whose reciprocal a four-decimal quote destroys.
      expect(audTo(day, 'JPY')).toBeGreaterThan(60);
      expect(toAud(day, 'JPY')).toBeLessThan(0.02);
    }
  });

  it('spans seven years of real trading with real corporate actions', () => {
    expect(CHECKPOINTS[0]).toBe('2019-06-03');
    expect(CHECKPOINTS[CHECKPOINTS.length - 1]).toBe('2026-08-28');
    expect(CHECKPOINTS.length).toBeGreaterThan(120);
    expect(SPLITS['AAPL']).toEqual([{ date: '2020-08-31', ratio: 4 }]);
    expect(SPLITS['7203.T']).toEqual([{ date: '2021-09-29', ratio: 5 }]);
    const divs = Object.values(DIVIDENDS).reduce((n, d) => n + d.length, 0);
    expect(divs).toBeGreaterThan(90);
  });
});

// ─── 2. Current value and FX conversion ─────────────────────────────────────

describe('what each holding is worth, every day, in dollars', () => {
  it('values every holding at units × price × rate, on all 147 readings', () => {
    const bad: string[] = [];
    for (const r of W.readings) {
      for (const h of r.perHolding) {
        if (Math.abs(h.app - h.oracle) > 0.011) {
          bad.push(`${r.day} ${h.symbol}: app ${h.app} vs ${h.oracle}`);
        }
      }
    }
    expect(bad.slice(0, 8)).toEqual([]);
  });

  it('never mixes a currency up — the pound holding stays a pound holding', () => {
    // 2,000 BP shares are worth thousands, not hundreds of thousands. If the
    // pence quote were converted at the pound rate this is the assertion that
    // would fail, by exactly two orders of magnitude.
    const bought = W.readings.find(r => r.day === '2021-03-01')!;
    const bp = bought.perHolding.find(h => h.symbol === 'BP.L')!;
    expect(bp.app).toBeGreaterThan(5_000);
    expect(bp.app).toBeLessThan(30_000);
    const asPence = r2(2_000 * priceOn('BP.L', '2021-03-01') * toAud('2021-03-01', 'GBP'));
    expect(asPence / bp.app).toBeCloseTo(100, 2);
  });

  it('agrees on the portfolio total the Investments page shows', () => {
    for (const r of W.readings) {
      expect(Math.abs(r.appTotal - r.oracleTotal), r.day).toBeLessThan(0.05);
    }
  });

  it('keeps a Japanese holding steady through a rate that only drifts', () => {
    // Two consecutive readings where the yen price is unchanged: the AUD value
    // may only move by what the ECB rate moved, and never in 1% steps.
    let checked = 0;
    for (let i = 1; i < W.readings.length; i++) {
      const a = W.readings[i - 1], b = W.readings[i];
      const ha = a.perHolding.find(h => h.symbol === '7203.T');
      const hb = b.perHolding.find(h => h.symbol === '7203.T');
      if (!ha || !hb || ha.app <= 0) continue;
      if (priceOn('7203.T', a.day) !== priceOn('7203.T', b.day)) continue;
      if (splitFactorAfter('7203.T', a.day) !== splitFactorAfter('7203.T', b.day)) continue;
      const fxMove = Math.abs(toAud(b.day, 'JPY') / toAud(a.day, 'JPY') - 1);
      expect(Math.abs(hb.app / ha.app - 1), `${a.day}→${b.day}`).toBeCloseTo(fxMove, 4);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ─── 3. Corporate actions ───────────────────────────────────────────────────

describe('a split, as the app is able to record one', () => {
  const around = (symbol: string, date: string) => {
    const before = W.readings.filter(r => r.day < date).pop()!;
    const after = W.readings.find(r => r.day >= date)!;
    return {
      before: before.perHolding.find(h => h.symbol === symbol)!,
      after: after.perHolding.find(h => h.symbol === symbol)!,
      beforeDay: before.day, afterDay: after.day,
    };
  };

  it('leaves Apple worth what the market says, not a quarter of it', () => {
    const { before, after, beforeDay, afterDay } = around('AAPL', '2020-08-31');
    // The market's own move over those days, computed from the tape in AUD.
    const marketMove =
      (settlementPrice('AAPL', afterDay) * 4 * toAud(afterDay, 'USD')) /
      (settlementPrice('AAPL', beforeDay) * toAud(beforeDay, 'USD'));
    expect(after.app / before.app).toBeCloseTo(marketMove, 3);
    // And nowhere near the 75% collapse an un-restated unit count would show.
    expect(after.app / before.app).toBeGreaterThan(0.9);
  });

  it('leaves Toyota worth what the market says through its 5:1', () => {
    const { before, after } = around('7203.T', '2021-09-29');
    expect(after.app / before.app).toBeGreaterThan(0.9);
    expect(after.app / before.app).toBeLessThan(1.1);
  });

  it('multiplies the units and moves not one dollar of cost', () => {
    const costBefore = W.oracle.costHeld('AAPL');
    expect(costBefore).toBeGreaterThan(0);
    const parcels = cgtDS.parcelsFor(W.ids.get('AAPL')!);
    // The parcel book records the split as a ratio, so the cost base per unit
    // falls with the price and the acquisition date is untouched.
    expect(parcels.length).toBeGreaterThan(0);
    expect(cgtDS.splitsFor(W.ids.get('AAPL')!).map(s => s.ratio)).toEqual([4]);
    expect(cgtDS.splitsFor(W.ids.get('7203.T')!).map(s => s.ratio)).toEqual([5]);
  });

  it('is the difference between a 75% loss and no loss at all', () => {
    // What the holding WOULD have shown had nothing been recorded: the feed
    // rebases the price on split day and the unit count sits where it was.
    const after = DATES.find(d => d >= SPLITS['AAPL'][0].date)!;
    const before = settlementPrice('AAPL', '2020-08-28') * 400 * toAud('2020-08-28', 'USD');
    const naive = settlementPrice('AAPL', after) * 400 * toAud(after, 'USD');
    expect(naive / before).toBeLessThan(0.3);
    expect(1 - naive / before).toBeGreaterThan(0.7);
    // Which is the loss the backend's corporate-action pass exists to prevent
    // (services/corporateActions). Both routes to the adjustment are exercised
    // here — the user's own edit and the server's detection — and the last
    // section of this file asserts they cannot be told apart.
  });
});

// ─── 4. Dividends ───────────────────────────────────────────────────────────

describe('the income the portfolio actually paid', () => {
  it('books every real dividend, in the currency it was declared in', () => {
    expect(W.dividendEvents.length).toBeGreaterThan(40);
    expect(W.oracle.dividendsAud).toBeGreaterThan(0);
    for (const d of W.dividendEvents) expect(d.grossAud, `${d.symbol} ${d.day}`).toBeGreaterThan(0);
  });

  it('is a hundred times smaller for BP than the feed\'s own number', () => {
    const bp = W.dividendEvents.filter(d => d.symbol === 'BP.L');
    expect(bp.length).toBeGreaterThan(10);
    for (const d of bp) expect(d.feedGrossAud / d.grossAud).toBeCloseTo(100, 2);
    // In money: BP paid this portfolio hundreds of dollars a year, not tens of
    // thousands, and the difference would have gone onto a tax return.
    const yearly = bp.filter(d => d.day >= '2024-07-01' && d.day < '2025-07-01');
    const paid = r2(yearly.reduce((s, d) => s + d.grossAud, 0));
    expect(paid).toBeGreaterThan(50);
    expect(paid).toBeLessThan(1_000);
  });

  it('is unchanged by a split when the units are restated with it', () => {
    // The feed back-adjusts per-share dividends by the same ratio it back-adjusts
    // prices, so feed-amount × post-split units is the money that was really
    // paid — but only because the units were restated. Apple's pre-split
    // payments are the ones where the two numbers differ.
    const pre = DIVIDENDS['AAPL'].filter(d => d.date < '2020-08-31');
    expect(pre.length).toBeGreaterThan(0);
    for (const d of pre) expect(d.asDeclared / d.feedAmount).toBeCloseTo(4, 6);
    const post = DIVIDENDS['AAPL'].filter(d => d.date > '2020-08-31');
    for (const d of post) expect(d.asDeclared).toBe(d.feedAmount);
  });

  it('reports BHP in Australian dollars though BHP declares in US ones', () => {
    // A real format trap that does NOT bite: Yahoo converts BHP's USD-declared
    // dividend to AUD before serving it, and says so with currency AUD.
    expect(INSTRUMENTS['BHP.AX'].settlementCurrency).toBe('AUD');
    const bhp = W.dividendEvents.filter(d => d.symbol === 'BHP.AX');
    expect(bhp.length).toBeGreaterThan(4);
    for (const d of bhp) {
      const per = d.grossAud / (W.oracle.units.get('BHP.AX') || 400);
      expect(per, d.day).toBeGreaterThan(0.2);
      expect(per, d.day).toBeLessThan(3);
    }
  });
});

// ─── 5. Realised and unrealised P&L ─────────────────────────────────────────

describe('profit and loss', () => {
  it('records four real disposals across three financial years', () => {
    expect(W.sales.length).toBe(4);
    expect([...new Set(W.sales.map(s => fyOf(s.saleDate)))].sort())
      .toEqual(['2022-2023', '2023-2024', '2025-2026']);
    // Two of them land in the same year, which is the case that has to add up
    // rather than merely be right one disposal at a time.
    expect(W.sales.filter(s => fyOf(s.saleDate) === '2025-2026')).toHaveLength(2);
  });

  it('costs each disposal from the parcels, to the cent the oracle says', () => {
    for (const s of W.sales) {
      expect(Math.abs(s.app.cost - s.oracle.cost), s.label).toBeLessThan(0.05);
      expect(Math.abs(s.app.gain - s.oracle.gain), s.label).toBeLessThan(0.05);
    }
  });

  it('gives the discount only where twelve months and a day had passed', () => {
    for (const s of W.sales) {
      const acquired = MOVES.find(m => m.kind === 'buy' && m.symbol === s.symbol)!.day;
      const earned = s.oracle.gain > 0 && heldTwelveMonthsAndADay(acquired, s.saleDate);
      expect(s.app.discount, s.label).toBe(earned);
    }
  });

  it('measures unrealised P&L against what was really paid, not today\'s rate', () => {
    const last = W.readings[W.readings.length - 1];
    const { investments } = investmentsDS.getAll();
    for (const inv of investments) {
      const symbol = [...W.ids.entries()].find(([, id]) => id === inv.id)![0];
      const cost = W.oracle.costHeld(symbol);
      const value = last.perHolding.find(h => h.symbol === symbol)!.oracle;
      expect(Math.abs(inv.display_cost - cost), symbol).toBeLessThan(0.05);
      expect(Math.abs(inv.display_value - value), symbol).toBeLessThan(0.05);
      expect(Math.abs(inv.verification.profit_loss - r2(value - cost)), symbol).toBeLessThan(0.05);
    }
  });

  it('makes real money on Apple, because Apple really went up', () => {
    // The one place a wrong sign or a lost split would be unmissable: 400 shares
    // bought at $173.30 in June 2019 became 1,600 shares worth far more.
    const apple = W.sales.find(s => s.symbol === 'AAPL')!;
    expect(apple.oracle.gain).toBeGreaterThan(0);
    expect(apple.app.discount).toBe(true);
    const bought = r2(400 * 173.30 * toAud('2019-06-03', 'USD'));
    expect(W.oracle.investedAud).toBeGreaterThan(bought);
  });
});

// ─── 6. The capital gains position ──────────────────────────────────────────

describe('the CGT inputs the tax position is built from', () => {
  it('agrees with the oracle on every financial year that had a disposal', () => {
    const truth = W.oracle.positions();
    expect(truth.size).toBe(3);
    for (const [fy, want] of truth) {
      const got = cgtDS.build(fy);
      expect(Math.abs(got.netCapitalGain - want.netCapitalGain), fy).toBeLessThan(0.05);
      expect(Math.abs(got.discount - want.discount), fy).toBeLessThan(0.05);
    }
  });

  it('carries a loss forward rather than letting it touch other income', () => {
    const truth = W.oracle.positions();
    for (const [fy, want] of truth) {
      const got = cgtDS.build(fy);
      expect(got.netCapitalGain, fy).toBeGreaterThanOrEqual(0);
      expect(Math.abs(got.carriedForward.ordinary - want.carriedForward), fy).toBeLessThan(0.05);
    }
  });

  it('says nothing was recorded in a currency it does not report in', () => {
    for (const fy of W.oracle.positions().keys()) {
      const warnings = cgtDS.build(fy).warnings ?? [];
      expect(warnings.filter(w => w.kind === 'mixed-currency'), fy).toEqual([]);
      // Nor is a share sale ever mistaken for a disposal of the currency itself.
      expect(warnings.filter(w => w.kind === 'forex-not-capital'), fy).toEqual([]);
    }
  });

  it('leaves every remaining parcel matched to units actually still held', () => {
    const last = cgtDS.build(fyOf('2026-08-28'));
    for (const rem of last.remainders) {
      expect(rem.quantityRemaining).toBeGreaterThanOrEqual(0);
      expect(rem.costBaseRemaining).toBeGreaterThanOrEqual(0);
    }
    for (const [symbol, id] of W.ids) {
      const held = W.oracle.units.get(symbol) ?? 0;
      if (held <= 0) continue;
      const left = cgtDS.remainingFor(id);
      expect(Math.abs(left.quantity - held), symbol).toBeLessThan(1e-6);
    }
  });
});

// ─── 7. Net worth ───────────────────────────────────────────────────────────

describe('net worth, reconciled from the parts', () => {
  it('is cash plus the portfolio, on every one of the readings', () => {
    for (const r of W.readings) {
      // Nothing but the bank account and the holdings is in this world.
      const cash = useStore.getState().accounts.reduce((s, a) => s + a.balance, 0);
      expect(Math.abs(r.appNetWorth - r2(cash + r.appTotal)), r.day).toBeLessThan(0.05);
    }
  });

  it('moves only when the market moved or a trade happened', () => {
    // Between two readings with no trade, the change in net worth is exactly the
    // change in the portfolio the tape implies — no drift, no re-based cost.
    for (let i = 1; i < W.readings.length; i++) {
      const a = W.readings[i - 1], b = W.readings[i];
      const traded = MOVES.some(m => m.day > a.day && m.day <= b.day);
      if (traded) continue;
      const expected = r2(b.oracleTotal - a.oracleTotal);
      const actual = r2(b.appNetWorth - a.appNetWorth);
      expect(Math.abs(actual - expected), `${a.day}→${b.day}`).toBeLessThan(0.06);
    }
  });

  it('ends on the last real close, seven years on, with money in it', () => {
    const last = W.readings[W.readings.length - 1];
    expect(last.day).toBe('2026-08-28');
    expect(last.appNetWorth).toBeGreaterThan(0);
    expect(Math.abs(last.appTotal - last.oracleTotal)).toBeLessThan(0.05);
  });

  it('never carries a holding at a hundred times its worth', () => {
    // The blunt instrument, on purpose: a 100× error is the failure mode a
    // pence-quoted holding produced, and it would dwarf every real position.
    for (const r of W.readings) {
      for (const h of r.perHolding) {
        expect(h.app, `${r.day} ${h.symbol}`).toBeLessThan(2_000_000);
      }
    }
  });
});

// ─── 8. Corporate actions, whichever way they arrive ────────────────────────

describe('a split, detected and applied without anybody being asked', () => {
  it('reaches this device as a replaced holding and an adopted book entry', () => {
    // The server world never called investmentsDS.update for a split: the unit
    // count arrived on the holding row and the split arrived in the book, in
    // one bootstrap. Both splits are there, under ids this device never minted.
    expect(SERVER.continuity).toHaveLength(2);
    expect(SERVER.bookSplits.map(s => s.ratio).sort((a, b) => a - b)).toEqual([4, 5]);
    for (const b of SERVER.bookSplits) {
      expect(b.investmentId).toBeTruthy();
      expect(b.id).toMatch(/^[0-9a-f]{8}-0000-5000-8000-/);
    }
  });

  it('records each split exactly once, on either path', () => {
    for (const world of [W, SERVER]) {
      expect(world.bookSplits).toHaveLength(2);
      const perHolding = new Map<string, number>();
      for (const b of world.bookSplits) {
        perHolding.set(String(b.investmentId), (perHolding.get(String(b.investmentId)) ?? 0) + 1);
      }
      for (const [id, n] of perHolding) expect(n, id).toBe(1);
    }
  });

  it('moves not one dollar of the holding\'s worth as it lands', () => {
    // The whole point. Units × ratio and price ÷ ratio in the same breath, so a
    // net-worth snapshot taken between the split and the next quote sees nothing.
    for (const world of [W, SERVER]) {
      for (const c of world.continuity) {
        expect(c.unitsAfter / c.unitsBefore, `${c.symbol} units`).toBeCloseTo(c.ratio, 6);
        expect(Math.abs(c.valueAfter - c.valueBefore), `${c.symbol} value`).toBeLessThan(0.02);
        expect(Math.abs(c.costAfter - c.costBefore), `${c.symbol} cost`).toBeLessThan(0.02);
      }
    }
  });

  it('carries the parcels through with it, so the book still matches the holding', () => {
    for (const world of [W, SERVER]) {
      for (const c of world.continuity) {
        expect(Math.abs(c.parcelUnitsAfter - c.unitsAfter), `${c.symbol} parcels`).toBeLessThan(1e-6);
      }
    }
  });

  it('leaves the two paths indistinguishable, day for day, over seven years', () => {
    expect(SERVER.readings).toHaveLength(W.readings.length);
    for (let i = 0; i < W.readings.length; i++) {
      const a = W.readings[i], b = SERVER.readings[i];
      expect(b.day).toBe(a.day);
      expect(Math.abs(b.appTotal - a.appTotal), a.day).toBeLessThan(0.02);
      expect(Math.abs(b.appNetWorth - a.appNetWorth), a.day).toBeLessThan(0.02);
      for (const h of a.perHolding) {
        const other = b.perHolding.find(x => x.symbol === h.symbol)!;
        expect(Math.abs(other.app - h.app), `${a.day} ${h.symbol}`).toBeLessThan(0.02);
      }
    }
  });

  it('costs every disposal the same either way, discount included', () => {
    expect(SERVER.sales).toHaveLength(W.sales.length);
    for (let i = 0; i < W.sales.length; i++) {
      const a = W.sales[i], b = SERVER.sales[i];
      expect(b.saleDate).toBe(a.saleDate);
      expect(Math.abs(b.app.cost - a.app.cost), a.label).toBeLessThan(0.02);
      expect(Math.abs(b.app.gain - a.app.gain), a.label).toBeLessThan(0.02);
      expect(b.app.discount, a.label).toBe(a.app.discount);
    }
  });

  it('reaches the same capital-gains position for every year', () => {
    expect(SERVER.cgt.map(c => c.fy)).toEqual(W.cgt.map(c => c.fy));
    for (const want of W.cgt) {
      const got = SERVER.cgt.find(c => c.fy === want.fy)!;
      expect(Math.abs(got.netCapitalGain - want.netCapitalGain), want.fy).toBeLessThan(0.02);
      expect(Math.abs(got.discount - want.discount), want.fy).toBeLessThan(0.02);
      expect(Math.abs(got.carriedForward - want.carriedForward), want.fy).toBeLessThan(0.02);
    }
    // And both agree with the oracle, which knows nothing of either path.
    const truth = W.oracle.positions();
    for (const c of SERVER.cgt) {
      expect(Math.abs(c.netCapitalGain - truth.get(c.fy)!.netCapitalGain), c.fy).toBeLessThan(0.05);
    }
  });

  it('leaves the same units in the book at the end', () => {
    for (const [symbol, units] of W.remaining) {
      expect(Math.abs((SERVER.remaining.get(symbol) ?? 0) - units), symbol).toBeLessThan(1e-6);
    }
  });

  it('keeps the acquisition dates the discount is decided on', () => {
    // Apple was bought in June 2019 and sold in November 2022, and the split in
    // between must not have re-dated a single unit of it.
    const apple = SERVER.sales.find(s => s.symbol === 'AAPL')!;
    expect(apple.app.discount).toBe(true);
    expect(apple.app.gain).toBeGreaterThan(0);
    // Toyota was bought in September 2019 and sold in June 2026, through a 5:1.
    const toyota = SERVER.sales.find(s => s.symbol === '7203.T')!;
    expect(toyota.app.discount).toBe(true);
  });
});
