/**
 * FOREIGN-INVESTMENT TAX STRESS TEST — five financial years, five currencies.
 *
 * A single Australian taxpayer holding AUD, USD, GBP, EUR and JPY assets across
 * FY2022-23 → FY2025-26, driven through the REAL services the app uses (the
 * Investments page's own add/edit/sell path, salesDS, cgtDS, dividendsDS and
 * taxYearDS), and reconciled every step against an INDEPENDENT AUD cost/CGT
 * oracle written from the ATO's order of operations — never from
 * utils/capitalGains.ts.
 *
 * What the scenario deliberately contains:
 *   • multiple buys of one holding at different prices AND different FX rates
 *   • partial and full sales in four currencies
 *   • a disposal EXACTLY twelve months after acquisition, and one a day later
 *   • the 29-February acquisition, disposed on 28 Feb and 1 Mar of the next year
 *   • gains, losses, and a loss carried forward into a later year
 *   • dividends with franking credits, and a foreign dividend with withholding
 *   • pure FX gains and pure FX losses (native price flat, rate moved)
 *   • a 10:1 stock split, with a sale on the far side of it
 *
 * The oracle's convention is the doctrine the app itself adopted in the 2026-08
 * cost cleanup: every acquisition's AUD cost is fixed at the rate on the day it
 * was bought and never revalued; proceeds are converted at the rate on the day
 * of the disposal, so an FX move IS a capital gain and is taxed as one.
 *
 * Convention (same as the other files in this folder): correct behaviour is
 * asserted plainly, and a DEFECT found by this hunt is pinned with `it.fails`
 * stating the CORRECT behaviour, so the day it is fixed the pin turns green and
 * has to be promoted. Nothing here is weakened to make a suite pass.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

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
  investmentsDS, salesDS, cgtDS, dividendsDS, taxYearDS,
} from '../services/dataService';
import { buildOffsetPosition } from '../utils/taxOffsets';
import { emptyTaxProfile } from '../utils/taxProfile';
import { useStore } from '../store';
import type { BankAccount } from '../types';

// ─── Independent arithmetic ──────────────────────────────────────────────────

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const q8 = (n: number) => parseFloat(n.toFixed(8));

/** The Australian financial year a date falls in. Written here, not imported. */
function fyOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/**
 * Twelve months and a day, the ATO's test — the disposal must fall STRICTLY
 * after the first anniversary, and a 29 February acquisition has its
 * anniversary on 28 February. Implemented independently of the app: numeric
 * y/m/d comparison, with the month length taken from a UTC Date rollover.
 */
function heldTwelveMonthsAndADay(acquired: string, disposed: string): boolean {
  const [ay, am, ad] = acquired.split('-').map(Number);
  const [dy, dm, dd] = disposed.split('-').map(Number);
  const lastDayOfMonth = new Date(Date.UTC(ay + 1, am, 0)).getUTCDate();
  const annD = Math.min(ad, lastDayOfMonth);
  return dy * 10_000 + dm * 100 + dd > (ay + 1) * 10_000 + am * 100 + annD;
}

// ─── The oracle ──────────────────────────────────────────────────────────────

interface OParcel { units: number; costAud: number; date: string }

interface OSlice {
  units: number;
  costAud: number;
  proceedsAud: number;
  acquired: string;
  gain: number;
  discountable: boolean;
}

interface OEvent {
  key: string;
  saleDate: string;
  fy: string;
  units: number;
  grossProceeds: number;
  fees: number;
  netProceeds: number;
  costAud: number;
  gain: number;
  slices: OSlice[];
}

interface OYear {
  fy: string;
  proceeds: number;
  costBase: number;
  grossDiscountable: number;
  grossOther: number;
  currentYearLoss: number;
  broughtForward: number;
  lossesApplied: number;
  discount: number;
  netCapitalGain: number;
  carriedForward: number;
}

/**
 * A parcel book in AUD. Every purchase is converted ONCE, on its own day, and
 * carries its own acquisition date; a disposal consumes parcels oldest-first
 * (the ATO's fallback when parcels cannot be told apart) and each slice keeps
 * the date that decides its own discount.
 */
class AudTaxOracle {
  private book = new Map<string, OParcel[]>();
  events: OEvent[] = [];

  buy(key: string, units: number, costAud: number, date: string): void {
    const lots = this.book.get(key) ?? [];
    lots.push({ units: q8(units), costAud: r2(costAud), date });
    lots.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
    this.book.set(key, lots);
  }

  /** A split multiplies the units in every parcel. Cost and dates do not move. */
  split(key: string, ratio: number): void {
    for (const p of this.book.get(key) ?? []) p.units = q8(p.units * ratio);
  }

  unitsHeld(key: string): number {
    return q8((this.book.get(key) ?? []).reduce((s, p) => s + p.units, 0));
  }

  costHeld(key: string): number {
    return r2((this.book.get(key) ?? []).reduce((s, p) => s + p.costAud, 0));
  }

  sell(key: string, units: number, grossProceedsAud: number, feesAud: number, saleDate: string): OEvent {
    const net = r2(Math.max(0, grossProceedsAud - feesAud));
    const lots = this.book.get(key) ?? [];
    const taken: { units: number; costAud: number; acquired: string }[] = [];
    let left = q8(units);
    for (const p of lots) {
      if (left <= 1e-9) break;
      if (p.units <= 1e-9) continue;
      const take = Math.min(left, p.units);
      const whole = take >= p.units - 1e-9;
      const cost = whole ? p.costAud : r2(p.costAud * (take / p.units));
      p.units = q8(p.units - take);
      p.costAud = r2(p.costAud - cost);
      left = q8(left - take);
      taken.push({ units: take, costAud: cost, acquired: p.date });
    }
    if (left > 1e-9) throw new Error(`oracle: ${key} sold ${units} units but only ${units - left} were ever bought`);

    // Net proceeds pro-rata by units; the last slice absorbs the rounding.
    const totalUnits = taken.reduce((s, t) => s + t.units, 0);
    let assigned = 0;
    const slices: OSlice[] = taken.map((t, i) => {
      const p = i === taken.length - 1 ? r2(net - assigned) : r2((net * t.units) / totalUnits);
      assigned = r2(assigned + p);
      const gain = r2(p - t.costAud);
      return {
        units: t.units, costAud: t.costAud, proceedsAud: p, acquired: t.acquired,
        gain, discountable: gain > 0 && heldTwelveMonthsAndADay(t.acquired, saleDate),
      };
    });

    const event: OEvent = {
      key, saleDate, fy: fyOf(saleDate), units: q8(units),
      grossProceeds: r2(grossProceedsAud), fees: r2(feesAud), netProceeds: net,
      costAud: r2(taken.reduce((s, t) => s + t.costAud, 0)),
      gain: r2(slices.reduce((s, x) => s + x.gain, 0)),
      slices,
    };
    this.events.push(event);
    return event;
  }

  /** Every FY with a disposal, oldest first. */
  years(): string[] {
    return [...new Set(this.events.map(e => e.fy))].sort();
  }

  /**
   * The whole chain of years, each opening with what the last one could not
   * apply. Step order: losses reduce the NON-discountable gains first (the ATO
   * says plainly that this is the cheapest choice), then the 50% discount.
   */
  positions(openingLoss = 0): Map<string, OYear> {
    const out = new Map<string, OYear>();
    let carried = r2(openingLoss);
    for (const fy of this.years()) {
      const evs = this.events.filter(e => e.fy === fy);
      let discountable = 0, other = 0, loss = 0, proceeds = 0, costBase = 0;
      for (const e of evs) {
        proceeds = r2(proceeds + e.grossProceeds);
        costBase = r2(costBase + e.costAud);
        for (const s of e.slices) {
          if (s.gain > 0) {
            if (s.discountable) discountable = r2(discountable + s.gain);
            else other = r2(other + s.gain);
          } else if (s.gain < 0) loss = r2(loss - s.gain);
        }
      }
      const pool = r2(loss + carried);
      const toOther = r2(Math.min(pool, other));
      const afterOther = r2(other - toOther);
      const toDiscount = r2(Math.min(r2(pool - toOther), discountable));
      const afterDiscount = r2(discountable - toDiscount);
      const discount = r2(afterDiscount * 0.5);
      const net = r2(Math.max(0, r2(afterOther + afterDiscount) - discount));
      const leftOver = r2(pool - toOther - toDiscount);
      out.set(fy, {
        fy, proceeds, costBase,
        grossDiscountable: discountable, grossOther: other,
        currentYearLoss: loss, broughtForward: carried,
        lossesApplied: r2(toOther + toDiscount),
        discount, netCapitalGain: net, carriedForward: leftOver,
      });
      carried = leftOver;
    }
    return out;
  }
}

// ─── The taxpayer ────────────────────────────────────────────────────────────

const BANK = 'acc-tax-everyday';

function seedUser(id: string) {
  useStore.setState({
    user: {
      id, email: `${id}@example.test`, name: 'Fern Ex',
      currency_preference: 'AUD', theme: 'system', plan: 'premium',
      onboarding_complete: true,
    } as never,
    token: 'stress-token',
    dataOwnerId: id,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [{
      id: BANK, user_id: id, name: 'Everyday', balance: 50_000,
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
  localStorage.clear();
}

interface Holding {
  key: string; id: string; ticker: string; ccy: string;
}

/** One recorded disposal, as the app wrote it and as the oracle says it should be. */
interface SaleCheck {
  label: string;
  saleDate: string;
  app: { cost: number; gain: number; discount: boolean };
  oracle: { cost: number; gain: number; discountableGain: number; otherGain: number; loss: number };
}

interface World {
  oracle: AudTaxOracle;
  sales: SaleCheck[];
  holdings: Map<string, Holding>;
}

/**
 * The five-year story, told exactly the way the app lets a user tell it: a
 * holding is added with its native cost and the rate on the day, extra
 * purchases are recorded through the edit dialog (units up, AUD cost up), and
 * a sale goes through the same arithmetic pages/Investments.tsx `handleSell`
 * performs on the enriched row.
 */
function buildWorld(): World {
  seedUser('u-fxtax');
  sync.mockClear();
  const oracle = new AudTaxOracle();
  const holdings = new Map<string, Holding>();
  const sales: SaleCheck[] = [];

  /** The Add-holding dialog: native cost, native price, rate on the day. */
  const open = (key: string, o: {
    name: string; ticker: string; market: string; asset_type: string; ccy: string;
    units: number; priceNative: number; costNative: number; fx: number; date: string;
  }) => {
    const rec = investmentsDS.add({
      name: o.name, ticker: o.ticker, market: o.market, asset_type: o.asset_type,
      shares_owned: o.units, cost_basis: o.costNative,
      native_currency: o.ccy, cost_basis_currency: o.ccy,
      conversion_rate: o.fx, current_price: o.priceNative,
      is_dividend_paying: false, acquired_date: o.date,
    });
    holdings.set(key, { key, id: rec.id, ticker: o.ticker, ccy: o.ccy });
    oracle.buy(key, o.units, r2(o.costNative * o.fx), o.date);
  };

  /** A later purchase of a holding already owned — the edit dialog's own shape:
   *  units go up, and the AUD cost field goes up by what this parcel cost. */
  const buyMore = (key: string, units: number, priceNative: number, fx: number, date: string) => {
    const h = holdings.get(key)!;
    const row = useStore.getState().investments.find(i => i.id === h.id)!;
    const costAud = r2(units * priceNative * fx);
    investmentsDS.update(h.id, {
      shares_owned: q8(row.shares_owned + units),
      cost_basis: r2(row.cost_basis + costAud),
      cost_basis_currency: 'AUD',
      conversion_rate: fx,
      current_price: priceNative,
    });
    oracle.buy(key, units, costAud, date);
  };

  /** Today's quote and today's rate, as a price refresh writes them. */
  const mark = (key: string, priceNative: number, fx: number) => {
    const h = holdings.get(key)!;
    investmentsDS.update(h.id, { current_price: priceNative, conversion_rate: fx });
  };

  /** A split, recorded the only way the app allows: units × ratio, price ÷ ratio. */
  const split = (key: string, ratio: number, priceNative: number, fx: number) => {
    const h = holdings.get(key)!;
    const row = useStore.getState().investments.find(i => i.id === h.id)!;
    investmentsDS.update(h.id, {
      shares_owned: q8(row.shares_owned * ratio),
      current_price: priceNative / ratio,
      conversion_rate: fx,
    });
    oracle.split(key, ratio);
    void priceNative;
  };

  /**
   * pages/Investments.tsx handleSell, replayed against the enriched row — the
   * proceeds are the preferred-currency figure the dialog offers (units × price
   * × today's rate), and `acquiredEntered` is the date the user types into the
   * one acquisition-date field the dialog has.
   */
  const sell = (key: string, o: {
    label: string; units: number; priceNative: number; fx: number; fees: number;
    date: string; acquiredEntered: string;
  }) => {
    const h = holdings.get(key)!;
    mark(key, o.priceNative, o.fx);
    const inv = investmentsDS.getAll().investments.find(i => i.id === h.id)!;
    const origQty = inv.shares_owned || 0;
    const qty = Math.min(o.units, origQty) || origQty;
    const fraction = origQty > 0 ? qty / origQty : 1;
    const totalCostPref = inv.display_cost ?? inv.cost_basis;
    const costSold = r2(totalCostPref * fraction);
    const proceeds = r2(qty * o.priceNative * o.fx);

    const row = salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: qty,
      proceeds, fees: o.fees, cost_basis: costSold,
      acquired_date: o.acquiredEntered, sale_date: o.date, currency: 'AUD',
    });

    if (qty >= origQty - 1e-9) {
      investmentsDS.remove(inv.id, true);
    } else {
      investmentsDS.update(inv.id, {
        shares_owned: q8(origQty - qty),
        cost_basis: r2(inv.cost_basis * (1 - fraction)),
      });
    }

    const truth = oracle.sell(key, qty, proceeds, o.fees, o.date);
    sales.push({
      label: o.label,
      saleDate: o.date,
      app: { cost: row.cost_basis, gain: row.gain, discount: row.discount_eligible },
      oracle: {
        cost: truth.costAud,
        gain: truth.gain,
        discountableGain: r2(truth.slices.filter(s => s.gain > 0 && s.discountable).reduce((s, x) => s + x.gain, 0)),
        otherGain: r2(truth.slices.filter(s => s.gain > 0 && !s.discountable).reduce((s, x) => s + x.gain, 0)),
        loss: r2(truth.slices.filter(s => s.gain < 0).reduce((s, x) => s - x.gain, 0)),
      },
    });
  };

  // ── FY2022-23 — the portfolio is built. ───────────────────────────────────
  open('vas',  { name: 'Vanguard Australian Shares', ticker: 'VAS',  market: 'ASX',    asset_type: 'etf',   ccy: 'AUD', units: 500,  priceNative: 88,     costNative: 44_000,  fx: 1,      date: '2022-08-15' });
  open('aapl', { name: 'Apple',                      ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock', ccy: 'USD', units: 200,  priceNative: 150,    costNative: 30_000,  fx: 1.45,   date: '2022-09-01' });
  open('msft', { name: 'Microsoft',                  ticker: 'MSFT', market: 'NASDAQ', asset_type: 'stock', ccy: 'USD', units: 100,  priceNative: 250,    costNative: 25_000,  fx: 1.45,   date: '2022-09-01' });
  open('shel', { name: 'Shell plc',                  ticker: 'SHEL', market: 'LSE',    asset_type: 'stock', ccy: 'GBP', units: 300,  priceNative: 22,     costNative: 6_600,   fx: 1.72,   date: '2022-10-10' });
  open('asml', { name: 'ASML Holding',               ticker: 'ASML', market: 'AMS',    asset_type: 'stock', ccy: 'EUR', units: 20,   priceNative: 600,    costNative: 12_000,  fx: 1.55,   date: '2023-02-20' });
  open('tyo',  { name: 'Toyota Motor',               ticker: '7203', market: 'TSE',    asset_type: 'stock', ccy: 'JPY', units: 1_000, priceNative: 2_000, costNative: 2_000_000, fx: 0.0098, date: '2023-03-01' });
  open('sony', { name: 'Sony Group',                 ticker: '6758', market: 'TSE',    asset_type: 'stock', ccy: 'JPY', units: 100,  priceNative: 12_000, costNative: 1_200_000, fx: 0.0098, date: '2023-03-01' });

  // A loss ten months in — no discount is possible on a loss, and it becomes the
  // year's net capital loss, carried into FY2023-24.
  sell('vas', {
    label: 'S1 VAS 200 units at a loss (10 months held)',
    units: 200, priceNative: 75, fx: 1, fees: 19.95,
    date: '2023-06-15', acquiredEntered: '2022-08-15',
  });

  // ── FY2023-24 — the twelve-month boundary, from both sides. ───────────────
  // Bought 2022-09-01. The anniversary is 2023-09-01; the ATO excludes both the
  // acquisition day and the event day, so the discount starts on 2023-09-02.
  sell('msft', {
    label: 'S2 MSFT full, sold EXACTLY on the first anniversary — no discount',
    units: 100, priceNative: 300, fx: 1.50, fees: 20,
    date: '2023-09-01', acquiredEntered: '2022-09-01',
  });
  sell('aapl', {
    label: 'S3 AAPL half, sold one day past the anniversary — discountable',
    units: 100, priceNative: 190, fx: 1.50, fees: 20,
    date: '2023-09-02', acquiredEntered: '2022-09-01',
  });

  // A leap-day acquisition, for the anniversary clamp in FY2024-25.
  open('nvda', { name: 'NVIDIA', ticker: 'NVDA', market: 'NASDAQ', asset_type: 'stock', ccy: 'USD', units: 100, priceNative: 700, costNative: 70_000, fx: 1.52, date: '2024-02-29' });

  // ── FY2024-25 — second parcels, the clamp, a split, and pure FX. ──────────
  buyMore('aapl', 100, 230, 1.55, '2024-12-01');   // a second AAPL parcel, 4 months before the sale

  // 29 Feb 2024 + one year clamps to 28 Feb 2025. A disposal ON that date is not
  // twelve months and a day; the next day is.
  sell('nvda', {
    label: 'S4 NVDA half on 2025-02-28 — leap-day anniversary, no discount',
    units: 50, priceNative: 900, fx: 1.40, fees: 25,
    date: '2025-02-28', acquiredEntered: '2024-02-29',
  });
  sell('nvda', {
    label: 'S5 NVDA rest on 2025-03-01 — one day later, discountable',
    units: 50, priceNative: 910, fx: 1.40, fees: 25,
    date: '2025-03-01', acquiredEntered: '2024-02-29',
  });

  // Two parcels, one old and one four months old, sold together. FIFO says 100
  // units come from 2022 (discountable) and 50 from 2024-12-01 (not).
  sell('aapl', {
    label: 'S6 AAPL 150 of 200 across two parcels bought 27 months apart',
    units: 150, priceNative: 260, fx: 1.30, fees: 20,
    date: '2025-04-10', acquiredEntered: '2022-09-01',
  });

  // A 10:1 split, then half the (post-split) units sold with the yen 27% stronger
  // and the share price unchanged — a pure FX gain, which is a capital gain.
  split('tyo', 10, 2_000, 0.0125);
  sell('tyo', {
    label: 'S7 Toyota half, post 10:1 split, flat price, yen up — pure FX gain',
    units: 5_000, priceNative: 200, fx: 0.0125, fees: 12,
    date: '2025-06-10', acquiredEntered: '2023-03-01',
  });

  // The mirror image: price unchanged, yen weaker — a pure FX loss.
  sell('sony', {
    label: 'S8 Sony full, flat price, yen down — pure FX loss',
    units: 100, priceNative: 12_000, fx: 0.0080, fees: 12,
    date: '2025-06-25', acquiredEntered: '2023-03-01',
  });

  // ── FY2025-26 — a current-year loss against a gain, and the last holding. ──
  sell('asml', {
    label: 'S9 ASML full at a loss, held two and a half years',
    units: 20, priceNative: 500, fx: 1.60, fees: 15,
    date: '2025-08-20', acquiredEntered: '2023-02-20',
  });
  sell('shel', {
    label: 'S10 Shell full at a gain, sterling stronger',
    units: 300, priceNative: 30, fx: 1.95, fees: 15,
    date: '2025-09-15', acquiredEntered: '2022-10-10',
  });
  sell('vas', {
    label: 'S11 VAS rest at a gain',
    units: 300, priceNative: 105, fx: 1, fees: 20,
    date: '2026-03-01', acquiredEntered: '2022-08-15',
  });

  // ── Dividends: a fully franked ASX distribution and a US dividend that was
  //    taxed at source. Both are entered from the paper statement.
  dividendsDS.add({
    investmentId: null, label: 'Vanguard Australian Shares', ticker: 'VAS',
    paymentDate: '2025-03-15',
    frankedAmount: 1_400, unfrankedAmount: 0, frankingCredit: 600, withheld: 0,
    foreignTaxPaid: 0, sourceCountry: null,
  });
  // The US dividend, entered from the paper exactly as the return asks for it:
  // the GROSS dividend converted to Australian dollars, and the tax the US took
  // out of it recorded as FOREIGN tax — not as Australian withholding, which is
  // a different credit with different rules.
  dividendsDS.add({
    investmentId: null, label: 'Apple', ticker: 'AAPL',
    paymentDate: '2025-02-10',
    frankedAmount: 0, unfrankedAmount: 450, frankingCredit: 0, withheld: 0,
    foreignTaxPaid: 79.41, sourceCountry: 'United States',
  });

  return { oracle, sales, holdings };
}

// ─── The suite ───────────────────────────────────────────────────────────────

let W: World;
let ORACLE_FY: Map<string, OYear>;
const FYS = ['2022-2023', '2023-2024', '2024-2025', '2025-2026'];

beforeAll(() => {
  W = buildWorld();
  ORACLE_FY = W.oracle.positions();
});

describe('foreign investment tax — the disposals themselves', () => {
  it('records every disposal the scenario made, in order', () => {
    expect(W.sales.map(s => s.saleDate)).toEqual([
      '2023-06-15', '2023-09-01', '2023-09-02', '2025-02-28', '2025-03-01',
      '2025-04-10', '2025-06-10', '2025-06-25', '2025-08-20', '2025-09-15', '2026-03-01',
    ]);
    expect(salesDS.getAll()).toHaveLength(11);
  });

  it('locks each foreign holding\'s AUD cost at the rate on the day it was bought', () => {
    // A$43,500 for the 2022 Apple parcel (US$30,000 × 1.45), whatever the rate
    // does afterwards — the whole doctrine, checked at the source. 250 of the
    // 300 units have been sold, and what is left is half the 2024 parcel:
    // 50 × US$230 × 1.55 = A$17,825, unmoved by every rate since.
    expect(W.oracle.costHeld('aapl')).toBe(17_825);
    // Shell: £6,600 × 1.72 = A$11,352, and the disposal cost that exactly.
    const shell = W.sales.find(s => s.label.startsWith('S10'))!;
    expect(shell.oracle.cost).toBe(11_352);
    expect(shell.app.cost).toBe(11_352);
  });

  it('taxes a pure FX gain, and allows a pure FX loss', () => {
    const fxGain = W.sales.find(s => s.label.startsWith('S7'))!;
    const fxLoss = W.sales.find(s => s.label.startsWith('S8'))!;
    // Toyota: 5,000 × ¥200 × 0.0125 = A$12,500 against half of A$19,600.
    expect(fxGain.oracle.gain).toBe(2_688);
    expect(fxGain.app.gain).toBe(2_688);
    // Sony: ¥1,200,000 at 0.0080 = A$9,600 against A$11,760 paid at 0.0098.
    expect(fxLoss.oracle.loss).toBe(2_172);
    expect(fxLoss.app.gain).toBe(-2_172);
  });

  it('grants no discount on a disposal exactly twelve months after acquisition, and grants it one day later', () => {
    const exactly = W.sales.find(s => s.label.startsWith('S2'))!;
    const oneDayMore = W.sales.find(s => s.label.startsWith('S3'))!;
    expect(exactly.app.discount).toBe(false);
    expect(exactly.oracle.otherGain).toBeGreaterThan(0);
    expect(exactly.oracle.discountableGain).toBe(0);
    expect(oneDayMore.app.discount).toBe(true);
    expect(oneDayMore.oracle.discountableGain).toBeGreaterThan(0);
  });

  it('clamps a 29-February acquisition to 28 February, on both sides of the line', () => {
    const onTheDay = W.sales.find(s => s.label.startsWith('S4'))!;
    const dayAfter = W.sales.find(s => s.label.startsWith('S5'))!;
    expect(onTheDay.app.discount).toBe(false);
    expect(onTheDay.oracle.discountableGain).toBe(0);
    expect(dayAfter.app.discount).toBe(true);
    expect(dayAfter.oracle.discountableGain).toBe(10_475);
  });

  it('a split moves no cost and no acquisition date', () => {
    // 1,000 units at A$19,600 became 10,000 units at A$19,600; half of them cost
    // A$9,800 whichever side of the split you count from.
    const afterSplit = W.sales.find(s => s.label.startsWith('S7'))!;
    expect(afterSplit.oracle.cost).toBe(9_800);
    expect(afterSplit.app.cost).toBe(9_800);
  });

  /**
   * FINDING (Critical) — FIXED in the 2026-08 parcel cleanup. A partial sale of
   * a holding bought in more than one parcel used to be costed at the AVERAGE,
   * and stamped with ONE acquisition date, so both halves of the CGT answer were
   * wrong at once.
   *
   * First divergent transaction: S6, AAPL 150 units on 2025-04-10.
   *   parcels: 100 @ A$21,750 (2022-09-01, discountable)
   *            100 @ A$35,650 (2024-12-01, four months old)
   *   FIFO:    100 units cost A$21,750 → gain A$12,036.67, discountable
   *             50 units cost A$17,825 → LOSS  A$   931.67
   *   WAS:     150/200 × A$57,400 = A$43,050 → gain A$7,630, ALL discountable.
   *
   * The gain was understated by A$3,475, A$931.67 of capital loss disappeared,
   * and the discount was granted on units held four months. Every acquisition is
   * now written into the parcel book as it happens (investmentsDS.add/update) and
   * salesDS.record costs a disposal from the parcels the units actually came out
   * of, oldest first.
   */
  it('costs a partial sale from the parcels it actually came out of', () => {
    const s6 = W.sales.find(s => s.label.startsWith('S6'))!;
    expect(s6.app.cost).toBe(s6.oracle.cost);
    expect(s6.app.gain).toBe(s6.oracle.gain);
  });

  it('every single-parcel disposal agrees with the oracle to the cent', () => {
    const multiParcel = new Set(['S6']);
    const divergences = W.sales
      .filter(s => !multiParcel.has(s.label.slice(0, 2)))
      .filter(s => s.app.cost !== s.oracle.cost || s.app.gain !== s.oracle.gain)
      .map(s => `${s.label}: cost ${s.app.cost} vs ${s.oracle.cost}, gain ${s.app.gain} vs ${s.oracle.gain}`);
    expect(divergences).toEqual([]);
  });
});

describe('foreign investment tax — the financial-year position', () => {
  it('FY2022-23 is a net capital loss, carried forward and never touching other income', () => {
    const app = cgtDS.build('2022-2023');
    const truth = ORACLE_FY.get('2022-2023')!;
    expect(app.netCapitalGain).toBe(0);
    expect(app.netCapitalGain).toBe(truth.netCapitalGain);
    expect(app.carriedForward.ordinary).toBe(truth.carriedForward);
    expect(truth.carriedForward).toBe(2_619.95);
    expect(app.warnings.map(w => w.kind)).toContain('net-capital-loss');
  });

  it('FY2023-24 applies the brought-forward loss to the UNDISCOUNTED gain first', () => {
    const app = cgtDS.build('2023-2024');
    const truth = ORACLE_FY.get('2023-2024')!;
    expect(app.broughtForward.ordinary).toBe(2_619.95);
    // The loss lands on the exactly-twelve-months gain, where a dollar of loss
    // saves a whole dollar of tax rather than fifty cents.
    expect(app.gainsAfterLosses['other']).toBe(r2(truth.grossOther - truth.lossesApplied));
    expect(app.gainsAfterLosses['discount']).toBe(truth.grossDiscountable);
    expect(app.discount).toBe(truth.discount);
    expect(app.netCapitalGain).toBe(truth.netCapitalGain);
    expect(app.carriedForward.ordinary).toBe(0);
  });

  /**
   * FINDING (Critical, same root cause as S6) — FIXED. FY2024-25's assessable
   * capital gain was understated because the AAPL disposal was averaged.
   *   oracle: gross discountable 25,199.67 / other 9,775 / losses 3,103.67
   *           → net capital gain A$19,271.16
   *   WAS:    gross discountable 20,793    / other 9,775 / losses 2,172
   *           → net capital gain A$17,999.50
   * A$1,271.66 of assessable income never reached the return.
   */
  it('FY2024-25 assesses the same net capital gain as the oracle', () => {
    const app = cgtDS.build('2024-2025');
    const truth = ORACLE_FY.get('2024-2025')!;
    expect(app.netCapitalGain).toBe(truth.netCapitalGain);
  });

  it('FY2024-25 agrees on every disposal the averaging does not touch', () => {
    const app = cgtDS.build('2024-2025');
    const truth = ORACLE_FY.get('2024-2025')!;
    // Proceeds are recorded gross and are not affected by how cost is split.
    expect(app.proceeds).toBe(truth.proceeds);
    // The non-discountable side of the year (the leap-day disposal) is exact.
    expect(app.grossGains['other']).toBe(truth.grossOther);
  });

  it('FY2025-26 spends a current-year loss against a discountable gain and halves the rest', () => {
    const app = cgtDS.build('2025-2026');
    const truth = ORACLE_FY.get('2025-2026')!;
    expect(app.currentYearLosses.ordinary).toBe(truth.currentYearLoss);
    expect(app.discount).toBe(truth.discount);
    expect(app.netCapitalGain).toBe(truth.netCapitalGain);
    expect(app.carriedForwardTotal).toBe(0);
  });

  it('every year\'s gross proceeds and the rolled-forward chain agree with the oracle', () => {
    const divergences: string[] = [];
    for (const fy of FYS) {
      const app = cgtDS.build(fy);
      const truth = ORACLE_FY.get(fy);
      if (!truth) continue;
      if (app.proceeds !== truth.proceeds) divergences.push(`${fy} proceeds ${app.proceeds} vs ${truth.proceeds}`);
      if (app.broughtForward.ordinary !== truth.broughtForward) {
        divergences.push(`${fy} brought-forward ${app.broughtForward.ordinary} vs ${truth.broughtForward}`);
      }
    }
    expect(divergences).toEqual([]);
  });
});

describe('foreign investment tax — what reaches the Tax page', () => {
  it('carries the net capital gain into assessable income as exactly one line', () => {
    const position = taxYearDS.build({ fy: '2025-2026' });
    const cg = cgtDS.build('2025-2026');
    const lines = position.income.lines.filter(l => l.kind === 'capital-gain');
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(cg.netCapitalGain);
    expect(lines[0].excluded).toBe(false);
    expect(position.capitalGains?.netCapitalGain).toBe(cg.netCapitalGain);
  });

  it('puts no capital-gain line in a net-capital-loss year, and says why', () => {
    const position = taxYearDS.build({ fy: '2022-2023' });
    expect(position.income.lines.filter(l => l.kind === 'capital-gain')).toHaveLength(0);
    expect(position.notes.map(n => n.kind)).toContain('capital-loss');
  });

  it('counts a franked dividend once and carries its credit', () => {
    const position = taxYearDS.build({ fy: '2024-2025' });
    const div = position.income.dividends!;
    // A$1,400 franked at 30% carries exactly A$600 — the statement is at the cap,
    // not over it.
    expect(div.frankingCredit).toBe(600);
    expect(div.warnings.map(w => w.kind)).not.toContain('over-franked');
    expect(div.effectiveFrankingCredit).toBe(600);
    // No income entry stands behind either statement, so both add their cash.
    expect(div.additionalAssessableIncome).toBe(1_850);
  });

  /**
   * FINDING (Medium) — FIXED. A dividend statement had no foreign/domestic
   * distinction. The Apple dividend was paid in US dollars and taxed at source;
   * Ledger took the US withholding as if it were Australian TFN withholding and
   * credited it against the bill in full — refundable, uncapped — with no
   * foreign income tax offset, no limit and no warning.
   *
   * Fixed by keeping the two apart from the statement all the way to the
   * settlement: `foreignTaxPaid` never joins `withheld`, never reaches PAYG, and
   * becomes a foreign income tax offset (utils/foreignIncomeTax.ts) — capped at
   * the Australian tax the foreign income attracted, with the $1,000 floor, and
   * non-refundable. The country is asked for and never inferred.
   */
  it('separates foreign tax paid from Australian withholding', () => {
    const position = taxYearDS.build({ fy: '2024-2025' });
    const div = position.income.dividends!;
    const apple = div.lines.find(l => l.ticker === 'AAPL')!;

    // The statement says which tax is which, and says where it was paid.
    expect(apple.foreignTaxPaid).toBe(79.41);
    expect(apple.withheld).toBe(0);
    expect(apple.foreign).toBe(true);
    expect(apple.sourceCountry).toBe('United States');

    // The year's totals keep them apart too.
    expect(div.foreignTaxPaid).toBe(79.41);
    expect(div.withheld).toBe(0);
    // The gross dividend is the foreign income, not the net deposit.
    expect(div.foreignIncome).toBe(450);

    // AND THE CRUCIAL ONE: none of it is credited as Australian withholding.
    // The whole point of the finding was that $79.41 of US tax was coming
    // straight off an Australian bill as though the ATO were holding it.
    const appleLine = position.income.lines.find(l => l.id === apple.statementId)!;
    expect(appleLine.taxWithheld).toBe(0);
    expect(position.taxWithheld).toBe(0);
  });

  it('claims the foreign tax as a capped, non-refundable offset instead', () => {
    const position = taxYearDS.build({ fy: '2024-2025' });
    const div = position.income.dividends!;
    const offsets = buildOffsetPosition({
      fy: '2024-2025',
      taxableIncome: position.estimatedTaxableIncome,
      incomeTax: 20_000,
      profile: emptyTaxProfile(),
      foreignTax: { paid: div.foreignTaxPaid, foreignIncome: div.foreignIncome },
    });
    // Under $1,000 of foreign tax is claimable in full without working out a
    // limit — but as an OFFSET, which is where it differs from the old
    // behaviour: it sits against income tax and is lost if there is none.
    expect(offsets.foreignTax.offset).toBe(79.41);
    expect(offsets.foreignTax.underNoCalculationLimit).toBe(true);
    expect(offsets.foreignTax.unclaimable).toBe(0);
    expect(offsets.entitlements.map(o => o.key)).toContain('foreign-income-tax-offset');

    // No income tax to set it against and the relief is simply gone — the thing
    // a refundable PAYG credit would have handed back in cash.
    const noTax = buildOffsetPosition({
      fy: '2024-2025',
      taxableIncome: position.estimatedTaxableIncome,
      incomeTax: 0,
      profile: emptyTaxProfile(),
      foreignTax: { paid: div.foreignTaxPaid, foreignIncome: div.foreignIncome },
    });
    expect(noTax.appliedTotal).toBe(0);
    expect(noTax.unusedOffsets).toBeGreaterThanOrEqual(79.41);
  });

  it('caps foreign tax at the Australian tax the foreign income attracted', () => {
    // A big foreign dividend taxed abroad at 35% against Australian rates that
    // do not reach it: the excess is lost, not refunded.
    const offsets = buildOffsetPosition({
      fy: '2024-2025',
      taxableIncome: 60_000,
      incomeTax: 20_000,
      profile: emptyTaxProfile(),
      foreignTax: { paid: 14_000, foreignIncome: 40_000 },
    });
    const f = offsets.foreignTax;
    expect(f.underNoCalculationLimit).toBe(false);
    // The limit is Australian tax on $60,000 less Australian tax on $20,000.
    expect(f.limit).toBe(r2(f.taxWithForeignIncome! - f.taxWithoutForeignIncome!));
    expect(f.limit).toBeLessThan(14_000);
    expect(f.offset).toBe(f.limit);
    expect(r2(f.offset + f.unclaimable)).toBe(14_000);
    expect(offsets.warnings.map(w => w.kind)).toContain('foreign-tax-offset-capped');
  });

  it('never lets the $1,000 floor drop below itself', () => {
    // Foreign income small enough that the Australian tax on it is under $1,000:
    // the floor is a floor, so the whole $1,200 is not capped down to the tax.
    const offsets = buildOffsetPosition({
      fy: '2024-2025',
      taxableIncome: 25_000,
      incomeTax: 1_000,
      profile: emptyTaxProfile(),
      foreignTax: { paid: 1_200, foreignIncome: 1_000 },
    });
    expect(offsets.foreignTax.limit).toBe(1_000);
    expect(offsets.foreignTax.offset).toBe(1_000);
    expect(offsets.foreignTax.unclaimable).toBe(200);
  });

  it('never lets a disposal reach the return twice', () => {
    const position = taxYearDS.build({ fy: '2024-2025' });
    const cgLines = position.income.lines.filter(l => l.kind === 'capital-gain');
    expect(cgLines).toHaveLength(1);
    // Proceeds themselves are not income — only the net gain is.
    const proceeds = cgtDS.build('2024-2025').proceeds;
    expect(position.assessableIncome).toBeLessThan(proceeds);
  });
});

describe('foreign investment tax — parcels the user records by hand', () => {
  /**
   * FINDING (Critical) — FIXED. Parcels recorded on the Tax page could never be
   * matched to a sale recorded by the app.
   *
   * The parcel editor wrote `investmentId: null` and identified the holding by
   * ticker; every sale the Sell dialog records carries `investment_id`. The CGT
   * engine keyed a parcel as `tkr:AAPL` and the disposal as `inv:<uuid>`, and the
   * two keys could never meet — so the parcel was silently ignored, the disposal
   * fell back to its averaged cost base, and the acquisition dates the user typed
   * in were thrown away.
   *
   * Fixed at both ends: matching is now over EVERY identity a parcel and a
   * disposal answer to (assetKeysOf), so a ticker-only parcel reaches a sale that
   * knows a holding id; and the editor asks which holding the parcel belongs to,
   * prefilled from cgtDS.suggestParcel — which no screen used to call.
   */
  it('uses a hand-recorded parcel to cost a sale of the same holding', () => {
    seedUser('u-parcels');
    const rec = investmentsDS.add({
      name: 'Apple', ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock',
      shares_owned: 100, cost_basis: 20_000, native_currency: 'USD',
      cost_basis_currency: 'USD', conversion_rate: 1.50, current_price: 200,
    });
    // Exactly what the Tax page's ParcelEditor writes.
    cgtDS.addParcel({
      investmentId: null, label: 'Apple', ticker: 'AAPL', assetType: null,
      quantity: 100, costBase: 30_000, acquiredDate: '2021-05-04',
    });
    salesDS.record({
      investment_id: rec.id, name: 'Apple', ticker: 'AAPL', asset_type: 'stock',
      market: 'NASDAQ', quantity: 100, proceeds: 40_000, fees: 20,
      cost_basis: 30_000, acquired_date: null, sale_date: '2025-11-01', currency: 'AUD',
    });
    const built = cgtDS.build('2025-2026');
    expect(built.events[0].allocations[0].source).toBe('parcel');
    expect(built.events[0].allocations[0].acquiredDate).toBe('2021-05-04');
  });

  /**
   * FINDING (High) — FIXED. A parcel was not split-adjusted, so a sale after a
   * share split was costed as if the extra units had no cost base at all.
   *
   * With a parcel of 100 units at A$30,000 and a 4:1 split, selling all 400 units
   * drew 100 units from the parcel (the WHOLE A$30,000) and then fell back to the
   * sale's own recorded cost base for the other 300 — pro-rated to 75% of it. The
   * cost base came out at A$52,500 from a A$30,000 purchase. The engine did warn
   * ('over-disposed'), but the number beside the warning was already wrong.
   *
   * Fixed twice over: a split is now a recorded event that re-expresses every
   * parcel written before it in the new units (CgtSplit), and — for a book that
   * is simply stale, as here — a disposal's cost base can never exceed the cost
   * base recorded on the sale itself, so parcel and recorded cost can no longer
   * be counted twice for the same units.
   */
  it('costs a post-split sale from the split-adjusted parcel', () => {
    seedUser('u-split-parcel');
    const rec = investmentsDS.add({
      name: 'NVIDIA', ticker: 'NVDA', market: 'NASDAQ', asset_type: 'stock',
      shares_owned: 400, cost_basis: 30_000, native_currency: 'AUD',
      cost_basis_currency: 'AUD', conversion_rate: 1, current_price: 100,
    });
    cgtDS.addParcel({
      investmentId: rec.id, label: 'NVIDIA', ticker: 'NVDA', assetType: 'stock',
      quantity: 100, costBase: 30_000, acquiredDate: '2023-01-10',
    });
    salesDS.record({
      investment_id: rec.id, name: 'NVIDIA', ticker: 'NVDA', asset_type: 'stock',
      market: 'NASDAQ', quantity: 400, proceeds: 40_000, fees: 0,
      cost_basis: 30_000, acquired_date: '2023-01-10', sale_date: '2025-11-01', currency: 'AUD',
    });
    const built = cgtDS.build('2025-2026');
    expect(built.events[0].costBase).toBe(30_000);
    expect(built.netCapitalGain).toBe(5_000); // (40,000 − 30,000) halved
  });
});

describe('foreign investment tax — the acquisition date', () => {
  /**
   * FINDING (High) — FIXED. The purchase date the Add dialog collects never
   * reached the holding, so the Sell dialog could not offer it back.
   *
   * `investmentsDS.add` took `acquired_date` and forwarded it to the server, but
   * the local row it built had no such field (the `Investment` type had none
   * either), and the Sell dialog prefilled its one acquisition-date box from
   * `details.purchase_date`, which only exists for bonds and collectables. A
   * share bought with a purchase date recorded therefore came to be sold with the
   * date blank — and a disposal with no acquisition date gets NO discount and is
   * taxed on the whole gain (the test below this one).
   *
   * The date is now part of the row AND opens the holding's first parcel, and the
   * Sell dialog prefills from the parcels themselves.
   */
  it('keeps the purchase date entered when the holding was added', () => {
    seedUser('u-acqdate');
    const rec = investmentsDS.add({
      name: 'Woolworths', ticker: 'WOW', market: 'ASX', asset_type: 'stock',
      shares_owned: 100, cost_basis: 3_000, native_currency: 'AUD',
      cost_basis_currency: 'AUD', conversion_rate: 1, current_price: 35,
      acquired_date: '2021-04-06',
    });
    const stored = useStore.getState().investments.find(i => i.id === rec.id)! as
      unknown as Record<string, unknown>;
    const prefill = stored.acquired_date
      ?? (stored.details as Record<string, unknown> | null | undefined)?.purchase_date;
    expect(prefill).toBe('2021-04-06');
  });

  it('taxes the whole gain when the acquisition date is blank, and says so out loud', () => {
    // The conservative direction, chosen on purpose: an unknown date can only
    // cost the user money, never invent a discount. Worth pinning — it is the
    // exact consequence of the finding above.
    seedUser('u-nodate');
    const rec = investmentsDS.add({
      name: 'Woolworths', ticker: 'WOW', market: 'ASX', asset_type: 'stock',
      shares_owned: 100, cost_basis: 3_000, native_currency: 'AUD',
      cost_basis_currency: 'AUD', conversion_rate: 1, current_price: 60,
    });
    salesDS.record({
      investment_id: rec.id, name: 'Woolworths', ticker: 'WOW', asset_type: 'stock',
      market: 'ASX', quantity: 100, proceeds: 6_000, fees: 0, cost_basis: 3_000,
      acquired_date: null, sale_date: '2025-12-01', currency: 'AUD',
    });
    const built = cgtDS.build('2025-2026');
    expect(built.grossGains['discount']).toBe(0);
    expect(built.grossGains['other']).toBe(3_000);
    expect(built.netCapitalGain).toBe(3_000);   // not 1,500
    const warn = built.warnings.find(w => w.kind === 'acquisition-date-missing')!;
    expect(warn.amount).toBe(3_000);
  });
});

describe('foreign investment tax — losses brought in from a lodged return', () => {
  it('applies an opening loss to the first year it is measured at, and never backwards', () => {
    seedUser('u-opening');
    const inv = investmentsDS.add({
      name: 'BHP Group', ticker: 'BHP', market: 'ASX', asset_type: 'stock',
      shares_owned: 100, cost_basis: 10_000, native_currency: 'AUD',
      cost_basis_currency: 'AUD', conversion_rate: 1, current_price: 200,
    });
    salesDS.record({
      investment_id: inv.id, name: 'BHP Group', ticker: 'BHP', asset_type: 'stock',
      market: 'ASX', quantity: 100, proceeds: 30_000, fees: 0, cost_basis: 10_000,
      acquired_date: '2020-01-06', sale_date: '2025-10-01', currency: 'AUD',
    });
    cgtDS.setOpening({ fy: '2025-2026', ordinary: 6_000, collectable: 0 });

    const oracle = new AudTaxOracle();
    oracle.buy('bhp', 100, 10_000, '2020-01-06');
    oracle.sell('bhp', 100, 30_000, 0, '2025-10-01');
    const truth = oracle.positions(6_000).get('2025-2026')!;

    const app = cgtDS.build('2025-2026');
    expect(app.broughtForward.ordinary).toBe(6_000);
    // 20,000 gain − 6,000 loss = 14,000, halved = 7,000.
    expect(truth.netCapitalGain).toBe(7_000);
    expect(app.netCapitalGain).toBe(truth.netCapitalGain);
  });
});

// ─── Foreign currency itself, held as cash ───────────────────────────────────

/**
 * FINDING (Low) — FIXED, end to end. A US-dollar brokerage balance was a
 * holding like any other: disposing of it was assessed as an ordinary capital
 * gain and, held over a year, given the 50% discount. A foreign exchange gain is
 * ORDINARY INCOME under the forex rules and is taxed in full.
 *
 * Ledger does not assess Div 775 — it needs an election, a $250,000 balance test
 * and a per-withdrawal record Ledger does not hold — so the disposal stays where
 * it is counted (leaving it out would understate income, the one direction
 * Ledger never errs) with the discount refused and the treatment named.
 *
 * Driven through the REAL add/sell path, because the fact that makes it work —
 * the holding's own currency reaching the sale row — only exists there: a full
 * sale deletes the holding, and the disposal still has to know what it was.
 */
describe('foreign investment tax — a US-dollar cash balance', () => {
  /** The Investments page's own sell path for a cash holding. */
  function sellCash(inv: { id: string }, o: { units: number; proceeds: number; date: string }) {
    const row = useStore.getState().investments.find(i => i.id === inv.id)!;
    return salesDS.record({
      investment_id: row.id, name: row.name, ticker: row.ticker ?? null,
      asset_type: row.asset_type, market: row.market, quantity: o.units,
      proceeds: o.proceeds, fees: 0,
      cost_basis: r2(row.cost_basis * (o.units / row.shares_owned)),
      acquired_date: row.acquired_date ?? null, sale_date: o.date, currency: 'AUD',
      native_currency: row.native_currency ?? null,
    });
  }

  function usdCash() {
    seedUser('u-forex');
    // 10,000 US dollars bought at 0.70, so A$14,285.71 locked in at acquisition.
    return investmentsDS.add({
      name: 'US dollar balance', ticker: undefined, market: 'CASH', asset_type: 'cash',
      shares_owned: 10_000, cost_basis: 14_285.71, native_currency: 'USD',
      cost_basis_currency: 'AUD', conversion_rate: 1 / 0.62, current_price: 1,
      acquired_date: '2021-05-04',
    });
  }

  it('taxes the exchange gain in full — no discount, however long it sat there', () => {
    const inv = usdCash();
    // Sold four years later at 0.62: A$16,129.03 for the same 10,000 dollars.
    const sale = sellCash(inv, { units: 10_000, proceeds: 16_129.03, date: '2025-11-03' });
    investmentsDS.remove(inv.id, true); // fully sold: the holding is gone

    const built = cgtDS.build('2025-2026');
    const event = built.events.find(e => e.disposalId === sale.id)!;
    expect(event.forex).toBe(true);
    expect(event.gain).toBe(r2(16_129.03 - 14_285.71));
    expect(event.discountableGain).toBe(0);
    expect(event.otherGain).toBe(event.gain);
    // Held over four years, and not a cent of discount.
    expect(built.discount).toBe(0);
    expect(built.netCapitalGain).toBe(event.gain);
  });

  it('says the gain belongs on a different line, rather than leaving it out', () => {
    const inv = usdCash();
    sellCash(inv, { units: 10_000, proceeds: 16_129.03, date: '2025-11-03' });
    investmentsDS.remove(inv.id, true);

    const built = cgtDS.build('2025-2026');
    const w = built.warnings.find(x => x.kind === 'forex-not-capital');
    expect(w?.count).toBe(1);
    expect(w?.message).toContain('ordinary income');
    // Counted, not dropped: it is in the assessable income the return runs on.
    const position = taxYearDS.build({ fy: '2025-2026' });
    expect(position.assessableIncome).toBe(built.netCapitalGain);
  });

  it('remembers what the holding was, after the holding itself is deleted', () => {
    const inv = usdCash();
    const sale = sellCash(inv, { units: 10_000, proceeds: 16_129.03, date: '2025-11-03' });
    investmentsDS.remove(inv.id, true);
    expect(useStore.getState().investments.find(i => i.id === inv.id)).toBeUndefined();

    const disposal = cgtDS.disposals().find(d => d.id === sale.id)!;
    expect(disposal.nativeCurrency).toBe('USD');
  });

  it('leaves an Australian-dollar cash balance discountable, as it always was', () => {
    seedUser('u-forex-aud');
    const inv = investmentsDS.add({
      name: 'Brokerage cash', ticker: undefined, market: 'CASH', asset_type: 'cash',
      shares_owned: 14_285.71, cost_basis: 14_285.71, native_currency: 'AUD',
      cost_basis_currency: 'AUD', conversion_rate: 1, current_price: 1,
      acquired_date: '2021-05-04',
    });
    const sale = sellCash(inv, { units: 14_285.71, proceeds: 16_129.03, date: '2025-11-03' });
    const event = cgtDS.build('2025-2026').events.find(e => e.disposalId === sale.id)!;
    expect(event.forex).toBe(false);
    expect(event.discountableGain).toBe(event.gain);
  });

  it('leaves a US-listed SHARE discountable — it is priced in dollars, not dollars', () => {
    seedUser('u-forex-share');
    const inv = investmentsDS.add({
      name: 'Apple', ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock',
      shares_owned: 100, cost_basis: 14_285.71, native_currency: 'USD',
      cost_basis_currency: 'AUD', conversion_rate: 1 / 0.62, current_price: 200,
      acquired_date: '2021-05-04',
    });
    const sale = sellCash(inv, { units: 100, proceeds: 16_129.03, date: '2025-11-03' });
    const event = cgtDS.build('2025-2026').events.find(e => e.disposalId === sale.id)!;
    expect(event.forex).toBe(false);
    expect(event.discountableGain).toBe(event.gain);
  });
});
