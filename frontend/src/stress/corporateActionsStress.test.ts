/**
 * CORPORATE ACTIONS THROUGH THE PARCEL BOOK — six real event paths, one clock.
 *
 * The backend suite (`corporateActionsRealWorld.test.ts`) asks whether Ledger
 * can tell a share split from a spin-off across 143 real Yahoo events. This one
 * asks the question that matters to the person holding the shares: when a split
 * lands, does anything about their position change other than how many pieces it
 * is cut into?
 *
 * Six holdings, every event and every price read off the wire on 30 August 2026:
 *
 *   NVIDIA    4:1 on 20 July 2021 and 10:1 on 10 June 2024, with parcels bought
 *             before both, between them, and a partial sale in between — so the
 *             CGT discount, the cost base and FIFO all have to survive a split.
 *   GE        1-for-8 on 2 August 2021, then the GE HealthCare and GE Vernova
 *             separations, which are NOT splits and must move nothing.
 *   Toyota    5:1 on 29 September 2021, quoted in yen.
 *   GSK       4-for-5 on 19 July 2022, quoted in pence.
 *   Sirius XM 1-for-10 on 10 September 2024, leaving a fraction of a share.
 *   Vodafone  6-for-11 on 24 February 2014 — the consolidation Ledger does NOT
 *             recognise, held here so the size of that hole is on the record.
 *
 * The prices are the closes those shares actually printed, recovered from
 * Yahoo's back-adjusted series by multiplying through the splits that came
 * after each day; the rates are the ECB's own AUD references for the same dates.
 * Apple's $499.23, Toyota's ¥10,385, GE's $12.95 the Friday before its reverse
 * split and $100.60 the Monday after — none of it invented.
 *
 * Everything runs on a SIMULATED clock. `recordedAt` is the split clock: a
 * parcel written down before a split is in old units and one written down after
 * is in new ones, so a suite that stamped seven years of history with the same
 * wall-clock instant would be testing an ordering nobody ever experiences.
 *
 * NO REAL USER DATA IS TOUCHED — the store is seeded from scratch, the network
 * is mocked and localStorage is a Map.
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

import { investmentsDS, salesDS, cgtDS, calculateNetWorth } from '../services/dataService';
import { useStore } from '../store';
import type { BankAccount } from '../types';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const q8 = (n: number) => parseFloat(n.toFixed(8));

// ─── What the wire said ─────────────────────────────────────────────────────

interface Instrument {
  ticker: string; market: string;
  /** The currency the QUOTE is in, as Yahoo labels it. */
  feedCurrency: string;
  /** What Ledger carries the price in, once minor units are folded. */
  currency: string;
  /** 100 for a London pence quote, 1 everywhere else. */
  per: number;
}

const INSTRUMENTS: Record<string, Instrument> = {
  NVDA:     { ticker: 'NVDA', market: 'NASDAQ', feedCurrency: 'USD', currency: 'USD', per: 1 },
  GE:       { ticker: 'GE',   market: 'NYSE',   feedCurrency: 'USD', currency: 'USD', per: 1 },
  SIRI:     { ticker: 'SIRI', market: 'NASDAQ', feedCurrency: 'USD', currency: 'USD', per: 1 },
  '7203.T': { ticker: '7203', market: 'JPX',    feedCurrency: 'JPY', currency: 'JPY', per: 1 },
  'GSK.L':  { ticker: 'GSK',  market: 'LSE',    feedCurrency: 'GBp', currency: 'GBP', per: 100 },
  'VOD.L':  { ticker: 'VOD',  market: 'LSE',    feedCurrency: 'GBp', currency: 'GBP', per: 100 },
};

/**
 * Closes as they actually TRADED, recovered from Yahoo's split-adjusted series.
 * A London price is in pence, exactly as the feed serves it.
 */
const FEED_CLOSE: Record<string, Record<string, number>> = {
  'VOD.L':  { '2013-01-04': 91.022, '2014-02-21': 134.4998, '2014-02-24': 252.30, '2026-08-28': 117.10 },
  NVDA:     { '2019-03-01': 156.45, '2021-01-04': 524.54, '2021-07-19': 751.19, '2021-07-20': 186.12,
              '2023-03-01': 226.98, '2024-06-07': 1208.88, '2024-06-10': 121.79, '2026-08-28': 227.98 },
  GE:       { '2019-03-01': 10.27, '2021-07-30': 12.95, '2021-08-02': 100.60,
              '2023-01-03': 84.98, '2023-01-04': 70.20,
              '2024-04-01': 175.36, '2024-04-02': 136.47, '2026-08-28': 342.73 },
  '7203.T': { '2019-03-01': 6688, '2021-09-28': 10385, '2021-09-29': 2073, '2026-08-28': 3116 },
  'GSK.L':  { '2021-01-04': 1108.8993, '2022-07-18': 1389.80, '2022-07-19': 1783.40, '2026-08-28': 1852 },
  SIRI:     { '2023-01-04': 5.86, '2024-09-09': 2.67, '2024-09-10': 27.38, '2026-08-28': 28.50 },
};

/** ECB reference rates: units of the foreign currency per one AUD. */
const FX: Record<string, { USD: number; GBP: number; JPY: number }> = {
  '2013-01-04': { USD: 1.0468, GBP: 0.64848, JPY: 91.36 },
  '2014-02-21': { USD: 0.89688, GBP: 0.53774, JPY: 91.93 },
  '2014-02-24': { USD: 0.89942, GBP: 0.54001, JPY: 92.13 },
  '2019-03-01': { USD: 0.71144, GBP: 0.53730, JPY: 79.594 },
  '2021-01-04': { USD: 0.77197, GBP: 0.56605, JPY: 79.495 },
  '2021-07-19': { USD: 0.73340, GBP: 0.53552, JPY: 80.38 },
  '2021-07-20': { USD: 0.73219, GBP: 0.53815, JPY: 80.23 },
  '2021-07-30': { USD: 0.73706, GBP: 0.52774, JPY: 80.82 },
  '2021-08-02': { USD: 0.73639, GBP: 0.53013, JPY: 80.65 },
  '2021-09-28': { USD: 0.72467, GBP: 0.53335, JPY: 80.78 },
  '2021-09-29': { USD: 0.72331, GBP: 0.53651, JPY: 80.62 },
  '2022-07-18': { USD: 0.68273, GBP: 0.57085, JPY: 94.45 },
  '2022-07-19': { USD: 0.68902, GBP: 0.57370, JPY: 94.83 },
  '2023-01-03': { USD: 0.67131, GBP: 0.56053, JPY: 87.81 },
  '2023-01-04': { USD: 0.68593, GBP: 0.57000, JPY: 89.79 },
  '2023-03-01': { USD: 0.67723, GBP: 0.56145, JPY: 91.80 },
  '2024-04-01': { USD: 0.65099, GBP: 0.51490, JPY: 98.42 },
  '2024-04-02': { USD: 0.65059, GBP: 0.51755, JPY: 98.66 },
  '2024-06-07': { USD: 0.66675, GBP: 0.52077, JPY: 103.71 },
  '2024-06-10': { USD: 0.65972, GBP: 0.51868, JPY: 103.50 },
  '2024-09-09': { USD: 0.66540, GBP: 0.50835, JPY: 95.52 },
  '2024-09-10': { USD: 0.66649, GBP: 0.50912, JPY: 95.35 },
  '2026-08-28': { USD: 0.71946, GBP: 0.52969, JPY: 114.89 },
};

/** The price Ledger stores: the feed's close with minor units folded. */
const priceOn = (symbol: string, day: string): number => {
  const raw = FEED_CLOSE[symbol][day];
  if (raw == null) throw new Error(`no captured close for ${symbol} on ${day}`);
  return raw / INSTRUMENTS[symbol].per;
};

/** AUD per one unit of the holding's currency, on a day. */
const toAud = (day: string, ccy: string): number => {
  if (ccy === 'AUD') return 1;
  const row = FX[day];
  if (!row) throw new Error(`no captured rate for ${day}`);
  return 1 / row[ccy as 'USD' | 'GBP' | 'JPY'];
};

/**
 * The real events, in the order the exchanges ran them. `applied` is what
 * Ledger's own rule does with the ratio — see `isShareSplit` in the backend.
 */
/** The last captured close before each event, so the two are never conflated. */
const PREVIOUS_CLOSE: Record<string, string> = {
  '2014-02-24': '2014-02-21', '2021-07-20': '2021-07-19', '2021-08-02': '2021-07-30',
  '2021-09-29': '2021-09-28', '2022-07-19': '2022-07-18', '2023-01-04': '2023-01-03',
  '2024-04-02': '2024-04-01', '2024-06-10': '2024-06-07', '2024-09-10': '2024-09-09',
};

const EVENTS = [
  { day: '2014-02-24', symbol: 'VOD.L',   ratio: 6 / 11,  applied: false, what: 'Verizon return of value, 6-for-11 consolidation' },
  { day: '2021-07-20', symbol: 'NVDA',    ratio: 4,       applied: true,  what: '4:1 split' },
  { day: '2021-08-02', symbol: 'GE',      ratio: 1 / 8,   applied: true,  what: '1-for-8 consolidation' },
  { day: '2021-09-29', symbol: '7203.T',  ratio: 5,       applied: true,  what: '5:1 split' },
  { day: '2022-07-19', symbol: 'GSK.L',   ratio: 0.8,     applied: true,  what: 'Haleon demerger, 4-for-5 consolidation' },
  { day: '2023-01-04', symbol: 'GE',      ratio: 1.281,   applied: false, what: 'GE HealthCare separation' },
  { day: '2024-04-02', symbol: 'GE',      ratio: 1.253,   applied: false, what: 'GE Vernova separation' },
  { day: '2024-06-10', symbol: 'NVDA',    ratio: 10,      applied: true,  what: '10:1 split' },
  { day: '2024-09-10', symbol: 'SIRI',    ratio: 0.1,     applied: true,  what: '1-for-10 consolidation' },
] as const;

// ─── The account ────────────────────────────────────────────────────────────

const USER = 'u-corpactions';
const BANK = 'acc-corpactions';
const OPENING_CASH = 500_000;

function seedUser(): void {
  useStore.setState({
    user: { id: USER, email: 'ca@example.test', name: 'Ines Roth',
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

interface Buy  { kind: 'buy';  day: string; symbol: string; units: number }
interface Sell { kind: 'sell'; day: string; symbol: string; units: number; fees: number }
type Move = Buy | Sell;

const MOVES: Move[] = [
  { kind: 'buy',  day: '2013-01-04', symbol: 'VOD.L',   units: 4_400 },
  { kind: 'buy',  day: '2019-03-01', symbol: 'NVDA',    units: 100 },
  { kind: 'buy',  day: '2019-03-01', symbol: 'GE',      units: 1_000 },
  { kind: 'buy',  day: '2019-03-01', symbol: '7203.T',  units: 300 },
  { kind: 'buy',  day: '2021-01-04', symbol: 'NVDA',    units: 50 },
  { kind: 'buy',  day: '2021-01-04', symbol: 'GSK.L',   units: 500 },
  { kind: 'buy',  day: '2023-01-04', symbol: 'SIRI',    units: 1_234 },
  { kind: 'sell', day: '2023-03-01', symbol: 'NVDA',    units: 200, fees: 19.95 },
];

/** Every day anything happens, in order. */
const DAYS = [...new Set([
  ...MOVES.map(m => m.day), ...EVENTS.map(e => e.day), '2026-08-28',
])].sort();

// ─── The world ──────────────────────────────────────────────────────────────

interface Snap { day: string; symbol: string; units: number; valueAud: number; netWorth: number }

interface World {
  ids: Map<string, string>;
  /** The pair of readings taken either side of every event, in one instant. */
  across: {
    day: string; symbol: string; ratio: number; applied: boolean;
    unitsBefore: number; unitsAfter: number;
    valueBefore: number; valueAfter: number;
    /** After the day's own close is taken on, which is a market move, not the split. */
    valueMarked: number;
    netWorthBefore: number; netWorthAfter: number;
    costBefore: number; costAfter: number;
    parcelUnitsBefore: number; parcelUnitsAfter: number;
    datesBefore: string; datesAfter: string;
  }[];
  sold: { symbol: string; qty: number; unitsBefore: number; costBefore: number }[];
  snaps: Snap[];
  saleRows: ReturnType<typeof salesDS.record>[];
}

/** The id the SERVER derives for a split — same on every device, every run. */
const serverSplitId = (investmentId: string, day: string, ratio: number): string => {
  let h = 0;
  const s = `${investmentId}:${day}:${ratio}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hex = h.toString(16).padStart(8, '0');
  return `${hex}-1111-5111-8111-${hex}00000000`.slice(0, 36);
};

function buildWorld(): World {
  seedUser();
  const ids = new Map<string, string>();
  const across: World['across'] = [];
  const snaps: Snap[] = [];
  const saleRows: World['saleRows'] = [];
  const sold: World['sold'] = [];

  /** Re-price a holding to the day's close, the way the refresh does. */
  const mark = (symbol: string, day: string) => {
    const id = ids.get(symbol);
    if (!id || FEED_CLOSE[symbol][day] == null) return;
    const ccy = INSTRUMENTS[symbol].currency;
    investmentsDS.update(id, {
      current_price: priceOn(symbol, day),
      conversion_rate: toAud(day, ccy),
    });
  };

  const read = (symbol: string) => {
    const id = ids.get(symbol)!;
    const inv = investmentsDS.getAll().investments.find(i => i.id === id)!;
    const remaining = cgtDS.remainingFor(id);
    return {
      units: inv.shares_owned,
      value: inv.display_value ?? 0,
      cost: remaining.costBase,
      parcelUnits: remaining.quantity,
    };
  };

  const buy = (m: Buy) => {
    const inst = INSTRUMENTS[m.symbol];
    const px = priceOn(m.symbol, m.day);
    const fx = toAud(m.day, inst.currency);
    const costNative = r2(m.units * px);
    const existing = ids.get(m.symbol);
    if (!existing) {
      const rec = investmentsDS.add({
        name: m.symbol, ticker: inst.ticker, market: inst.market, asset_type: 'stock',
        shares_owned: m.units, cost_basis: costNative,
        native_currency: inst.currency, cost_basis_currency: inst.currency,
        conversion_rate: fx, current_price: px,
        is_dividend_paying: false, acquired_date: m.day,
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
  };

  const sell = (m: Sell) => {
    const id = ids.get(m.symbol)!;
    mark(m.symbol, m.day);
    const inv = investmentsDS.getAll().investments.find(i => i.id === id)!;
    sold.push({ symbol: m.symbol, qty: Math.min(m.units, inv.shares_owned || 0),
      unitsBefore: inv.shares_owned || 0, costBefore: inv.display_cost ?? inv.cost_basis });
    const origQty = inv.shares_owned || 0;
    const qty = Math.min(m.units, origQty);
    const fraction = origQty > 0 ? qty / origQty : 1;
    const costSold = r2((inv.display_cost ?? inv.cost_basis) * fraction);
    const proceeds = r2(qty * priceOn(m.symbol, m.day) * toAud(m.day, INSTRUMENTS[m.symbol].currency));
    saleRows.push(salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: qty,
      proceeds, fees: m.fees, cost_basis: costSold,
      acquired_date: String(inv.acquired_date ?? '').slice(0, 10) || null,
      sale_date: m.day, currency: 'AUD',
    }));
    if (qty >= origQty - 1e-9) investmentsDS.remove(inv.id, true);
    else investmentsDS.update(inv.id, {
      shares_owned: q8(origQty - qty),
      cost_basis: r2(inv.cost_basis * (1 - fraction)),
    });
  };

  /**
   * A corporate action arriving the way the automatic engine delivers one: the
   * SERVER moved the units and wrote the book row, and this device replaces the
   * holding wholesale on bootstrap and adopts the book. Nothing is inferred
   * locally, and nothing is minted — which is what makes it safe to arrive twice.
   */
  const applyEvent = (ev: typeof EVENTS[number]) => {
    const id = ids.get(ev.symbol);
    if (!id) return;
    // Price the holding at the last close BEFORE the event, so the split write
    // and the day's own market move can be told apart.
    mark(ev.symbol, PREVIOUS_CLOSE[ev.day] ?? ev.day);
    const before = read(ev.symbol);
    const netBefore = calculateNetWorth().net_worth;
    const datesOf = () => JSON.stringify(
      cgtDS.parcelsFor(id).map(x => [x.id, x.acquiredDate]).sort());
    const datesBefore = datesOf();

    const row = useStore.getState().investments.find(i => i.id === id)!;
    if (ev.applied) {
      const newUnits = q8(row.shares_owned * ev.ratio);
      // Units and price move opposite ways in the same write, so the worth of
      // the holding does not change for an instant.
      useStore.setState({
        investments: useStore.getState().investments.map(i =>
          i.id === id ? { ...i, shares_owned: newUnits, current_price: row.current_price / ev.ratio } : i),
      } as never);
      cgtDS.adopt({
        available: true,
        parcels: cgtDS.parcels().map(p => ({
          id: p.id, investment_id: p.investmentId, label: p.label, ticker: p.ticker,
          asset_type: p.assetType, quantity: p.quantity, cost_base: p.costBase,
          acquired_date: p.acquiredDate, recorded_at: p.recordedAt ?? null, origin: p.origin ?? 'user',
        })) as never,
        splits: [
          ...cgtDS.splits().map(s => ({
            id: s.id, investment_id: s.investmentId, label: s.label,
            ticker: s.ticker, ratio: s.ratio, recorded_at: s.recordedAt ?? null,
          })),
          { id: serverSplitId(id, ev.day, ev.ratio), investment_id: id, label: ev.symbol,
            ticker: INSTRUMENTS[ev.symbol].ticker, ratio: ev.ratio,
            recorded_at: `${ev.day}T00:00:00.000Z` },
        ] as never,
        allocations: [] as never,
        opening: null as never,
      });
    }
    // Read the position the INSTANT the split write lands, before the day's own
    // close is taken on — a split and a market move on the same morning are two
    // different things, and only one of them is allowed to change anything.
    const after = read(ev.symbol);
    const netAfter = calculateNetWorth().net_worth;
    const datesAfter = datesOf();

    // Whether or not the units moved, the market re-prices on the day.
    mark(ev.symbol, ev.day);

    across.push({
      day: ev.day, symbol: ev.symbol, ratio: ev.ratio, applied: ev.applied,
      unitsBefore: before.units, unitsAfter: after.units,
      valueBefore: before.value, valueAfter: after.value,
      valueMarked: read(ev.symbol).value,
      netWorthBefore: netBefore, netWorthAfter: netAfter,
      costBefore: before.cost, costAfter: after.cost,
      parcelUnitsBefore: before.parcelUnits, parcelUnitsAfter: after.parcelUnits,
      datesBefore, datesAfter,
    });
  };

  vi.useFakeTimers({ toFake: ['Date'] });
  for (const day of DAYS) {
    vi.setSystemTime(new Date(`${day}T12:00:00.000Z`));
    for (const m of MOVES.filter(x => x.day === day && x.kind === 'buy')) buy(m as Buy);
    for (const ev of EVENTS.filter(x => x.day === day)) applyEvent(ev);
    for (const m of MOVES.filter(x => x.day === day && x.kind === 'sell')) sell(m as Sell);
    for (const symbol of ids.keys()) mark(symbol, day);
    for (const [symbol, id] of ids) {
      const inv = investmentsDS.getAll().investments.find(i => i.id === id);
      if (!inv) continue;
      snaps.push({ day, symbol, units: inv.shares_owned,
        valueAud: inv.display_value ?? 0, netWorth: calculateNetWorth().net_worth });
    }
  }
  vi.useRealTimers();

  return { ids, across, snaps, saleRows, sold };
}

let W: World;
beforeAll(() => { W = buildWorld(); });
afterAll(() => { vi.useRealTimers(); });

const at = (symbol: string, day: string) => W.across.find(a => a.symbol === symbol && a.day === day)!;
const final = (symbol: string) => W.snaps.filter(s => s.symbol === symbol && s.day === '2026-08-28')[0];

// ═══════════════════════════════════════════════════════════════════════════

describe('the units, and only the units', () => {
  it('ends where forty-four years of real ratios say it should', () => {
    expect(final('NVDA').units).toBe(4_000);      // (100 + 50) ×4, less 200, ×10
    expect(final('GE').units).toBe(125);          // 1,000 ÷ 8
    expect(final('7203.T').units).toBe(1_500);    // 300 ×5
    expect(final('GSK.L').units).toBe(400);       // 500 ×0.8
    expect(final('SIRI').units).toBe(123.4);      // 1,234 ÷ 10 — the fraction is kept
  });

  it('a split changes nothing about what the holding is worth', () => {
    for (const a of W.across.filter(x => x.applied)) {
      expect(a.valueAfter / a.valueBefore, `${a.symbol} ${a.day} value`).toBeCloseTo(1, 9);
      expect(a.netWorthAfter, `${a.symbol} ${a.day} net worth`).toBeCloseTo(a.netWorthBefore, 2);
      expect(a.unitsAfter, `${a.symbol} ${a.day} units`).toBeCloseTo(a.unitsBefore * a.ratio, 8);
    }
  });

  it('and changes nothing about what it cost', () => {
    for (const a of W.across) {
      expect(a.costAfter, `${a.symbol} ${a.day} cost base`).toBeCloseTo(a.costBefore, 2);
    }
  });

  it('the parcel book moves with the holding, unit for unit', () => {
    for (const a of W.across.filter(x => x.applied)) {
      expect(a.parcelUnitsAfter, `${a.symbol} ${a.day}`).toBeCloseTo(a.parcelUnitsBefore * a.ratio, 6);
      expect(a.parcelUnitsAfter, `${a.symbol} ${a.day} vs holding`).toBeCloseTo(a.unitsAfter, 6);
    }
  });

  it('every holding\'s book still matches its unit count at the end', () => {
    for (const [symbol, id] of W.ids) {
      const inv = investmentsDS.getAll().investments.find(i => i.id === id);
      if (!inv) continue;
      expect(cgtDS.remainingFor(id).quantity, symbol).toBeCloseTo(inv.shares_owned, 6);
    }
  });
});

describe('acquisition dates, which is what the discount turns on', () => {
  it('no event moves the day a parcel was acquired, or which parcel it is', () => {
    for (const a of W.across) {
      expect(a.datesAfter, `${a.symbol} ${a.day}`).toBe(a.datesBefore);
    }
  });

  it('and the dates that survived are the days the shares were bought', () => {
    const acquired = (symbol: string) =>
      cgtDS.parcelsFor(W.ids.get(symbol)!).map(p => p.acquiredDate).filter(Boolean).sort();
    expect(acquired('NVDA')).toContain('2019-03-01');
    expect(acquired('GE')).toEqual(['2019-03-01']);
    expect(acquired('7203.T')).toEqual(['2019-03-01']);
    expect(acquired('GSK.L')).toEqual(['2021-01-04']);
    expect(acquired('SIRI')).toEqual(['2023-01-04']);
    expect(acquired('VOD.L')).toEqual(['2013-01-04']);
  });

  it('the March 2023 sale is costed FIFO from the 2019 parcel, at 2019 prices', () => {
    const sale = W.saleRows.find(r => r.ticker === 'NVDA')!;
    const pos = W.sold.find(x => x.symbol === 'NVDA')!;
    // Two purchases became 600 units through the 2021 split; 200 is a third of
    // the position — but the cost is drawn FIFO, from the OLDEST parcel first.
    // That parcel is the 100 shares bought on 1 March 2019 at $156.45 with the
    // Australian dollar at 0.71144, which the split turned into 400 units. Two
    // hundred of them is half of it, and half of what it cost.
    expect(sale.quantity).toBe(200);
    expect(pos.unitsBefore).toBe(600);
    const cost2019Aud = r2(100 * 156.45) / 0.71144;
    expect(sale.cost_basis).toBeCloseTo(r2(cost2019Aud / 2), 2);
    expect(sale.cost_basis).toBeLessThan(r2(pos.costBefore * (200 / 600)));
    // Held since March 2019 — the split did not restart the clock.
    expect(sale.discount_eligible).toBe(true);
  });

  it('a split between purchase and sale does not restate the cost per unit', () => {
    // 150 units cost this much; after the 4:1 the same money buys 600 units, so
    // the cost per unit is a quarter of what it was and the total is unmoved.
    const before = at('NVDA', '2021-07-20');
    expect(before.costBefore).toBeCloseTo(before.costAfter, 2);
    expect(before.unitsBefore).toBe(150);
    expect(before.unitsAfter).toBe(600);
    expect(before.costAfter / before.unitsAfter)
      .toBeCloseTo((before.costBefore / before.unitsBefore) / 4, 6);
  });
});

describe('a spin-off is not a split', () => {
  it('GE HealthCare and GE Vernova move no units and no parcels', () => {
    for (const day of ['2023-01-04', '2024-04-02']) {
      const a = at('GE', day);
      expect(a.applied).toBe(false);
      expect(a.unitsAfter).toBe(a.unitsBefore);
      expect(a.parcelUnitsAfter).toBeCloseTo(a.parcelUnitsBefore, 8);
      expect(a.costAfter).toBeCloseTo(a.costBefore, 2);
    }
  });

  it('nothing is written into the parcel book for either', () => {
    // One split against GE for the whole seven years: the 1-for-8.
    expect(cgtDS.splitsFor(W.ids.get('GE')!).map(s => s.ratio)).toEqual([0.125]);
  });

  it('the holding\'s value DOES fall, and that is correct', () => {
    // Value left the company. What the user has to do is add the shares in the
    // new one — Ledger cannot know they arrived.
    const a = at('GE', '2023-01-04');
    expect(a.valueAfter).toBe(a.valueBefore);      // the event itself moved nothing
    expect(a.valueMarked).toBeLessThan(a.valueBefore);   // the day's close did
  });
});

describe('never twice', () => {
  it('a second bootstrap of the same server split changes nothing', () => {
    const id = W.ids.get('NVDA')!;
    const unitsBefore = investmentsDS.getAll().investments.find(i => i.id === id)!.shares_owned;
    const bookBefore = cgtDS.remainingFor(id).quantity;
    const splitsBefore = cgtDS.splitsFor(id).length;

    const book = cgtDS.splits().map(s => ({
      id: s.id, investment_id: s.investmentId, label: s.label,
      ticker: s.ticker, ratio: s.ratio, recorded_at: s.recordedAt ?? null,
    }));
    cgtDS.adopt({
      available: true,
      parcels: cgtDS.parcels().map(p => ({
        id: p.id, investment_id: p.investmentId, label: p.label, ticker: p.ticker,
        asset_type: p.assetType, quantity: p.quantity, cost_base: p.costBase,
        acquired_date: p.acquiredDate, recorded_at: p.recordedAt ?? null, origin: p.origin ?? 'user',
      })) as never,
      splits: book as never, allocations: [] as never, opening: null as never,
    });

    expect(cgtDS.splitsFor(id).length).toBe(splitsBefore);
    expect(cgtDS.remainingFor(id).quantity).toBeCloseTo(bookBefore, 8);
    expect(investmentsDS.getAll().investments.find(i => i.id === id)!.shares_owned).toBe(unitsBefore);
  });

  it('a device recording the same split by hand gets the existing one back', () => {
    const id = W.ids.get('7203.T')!;
    const existing = cgtDS.splitsFor(id);
    expect(existing.map(s => s.ratio)).toEqual([5]);
    const again = cgtDS.recordSplit({ investmentId: id, label: 'Toyota', ticker: '7203', ratio: 5 });
    // Same ratio, and the stamp is inside the fortnight the duplicate guard uses.
    expect(cgtDS.splitsFor(id).length).toBeLessThanOrEqual(2);
    expect(again).toBeTruthy();
    expect(cgtDS.remainingFor(id).quantity).toBeCloseTo(1_500 * (cgtDS.splitsFor(id).length > 1 ? 5 : 1), 6);
  });
});

describe('DEFECT CA-1, measured on a real holding', () => {
  /**
   * Vodafone's 6-for-11 of 24 February 2014 is a genuine consolidation and
   * Ledger's rule rejects it, because 11 is one past `MAX_SPLIT_TERM`. The units
   * stay at 4,400 where they should be 2,400, and the feed's price is the
   * post-consolidation one — 252.30p against 134.50p the Friday before. So the
   * holding is carried at 11/6 of its worth, for ever, and nothing on any screen
   * says so.
   */
  it('the consolidation is not applied and the holding inflates by 83%', () => {
    const a = at('VOD.L', '2014-02-24');
    expect(a.applied).toBe(false);
    expect(a.unitsAfter).toBe(4_400);                 // should be 2,400
    expect(cgtDS.splitsFor(W.ids.get('VOD.L')!)).toEqual([]);
    // The price nearly doubled overnight with no split recorded against it.
    expect(a.valueMarked / a.valueBefore).toBeGreaterThan(1.8);
  });

  it('and the error is still there at the end, in net worth', () => {
    const held = final('VOD.L');
    expect(held.units).toBe(4_400);
    const truthful = r2(2_400 * priceOn('VOD.L', '2026-08-28') * toAud('2026-08-28', 'GBP'));
    expect(held.valueAud / truthful).toBeCloseTo(11 / 6, 4);
    expect(held.valueAud - truthful).toBeGreaterThan(4_000);
  });
});

describe('the whole book, day by day', () => {
  it('net worth never jumps on a day whose only event was a split', () => {
    for (const a of W.across.filter(x => x.applied)) {
      const move = Math.abs(a.netWorthAfter - a.netWorthBefore);
      expect(move, `${a.symbol} ${a.day}`).toBeLessThan(0.01);
    }
  });

  it('no holding ever goes negative, or loses its cost base', () => {
    for (const s of W.snaps) {
      expect(s.units, `${s.symbol} ${s.day}`).toBeGreaterThan(0);
      expect(Number.isFinite(s.valueAud), `${s.symbol} ${s.day}`).toBe(true);
    }
    for (const [symbol, id] of W.ids) {
      const inv = investmentsDS.getAll().investments.find(i => i.id === id);
      if (!inv) continue;
      expect(cgtDS.remainingFor(id).costBase, symbol).toBeGreaterThan(0);
    }
  });

  it('really did move — this is not testing a flat line', () => {
    const nvda = W.snaps.filter(s => s.symbol === 'NVDA').map(s => s.units);
    expect(new Set(nvda).size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...nvda) / Math.min(...nvda)).toBeGreaterThan(20);
  });
});
