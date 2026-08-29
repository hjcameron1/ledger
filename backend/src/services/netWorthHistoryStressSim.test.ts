/**
 * NET WORTH HISTORY UNDER YEARS OF SHOCKS — a stress simulation.
 *
 * Three years of a real portfolio, day by day, with the events that actually break
 * a history chart: market crashes and recoveries, an inheritance, huge deposits and
 * withdrawals, a property bought and later sold, an FX shock, a loan paid off, and
 * major assets added and removed. Around each shock the hourly cron cadence is
 * simulated properly, because the 25% / 2-hour outlier guard only ever bites when a
 * snapshot was taken recently — a shock a day after the last snapshot sails through.
 *
 * Three numbers are compared at every step, and they must agree:
 *
 *   • the ORACLE      — this file's own sum of the world, written independently of
 *                       the engine, so a mistake inside computeNetWorth cannot hide
 *                       by being made twice;
 *   • the LIVE figure — computeNetWorth, what the headline shows right now;
 *   • the RECORDED    — what actually landed in net_worth_history, i.e. what the
 *                       chart can still say about that moment tomorrow.
 *
 * The third is the one this file exists for. A chart that has silently dropped a
 * snapshot does not look broken — it looks calm. So the run keeps a ledger of every
 * day the engine declined to record, and the assertions are about coverage and
 * explicability, not just arithmetic.
 *
 * This file first ran as a diagnosis, with every finding pinned by an `it.fails`
 * whose body stated the correct behaviour. All of them are now plain `it`s: the
 * truncated readers, the 25% threshold, the torn snapshots, the unrecorded
 * liquidation, the negative baseline and the UTC day boundaries have each been
 * fixed, and the assertions that used to describe the damage now describe the rule.
 * The bar the run has to clear is zero unexplained missing or stale points — every
 * ordinary day recorded, every shock recorded within the cron interval, every chart
 * reaching today, and every recorded number equal to what the portfolio was worth.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// ─── the world ───────────────────────────────────────────────────────────────
// Plain mutable rows. Events mutate these; the fake supabase reads them; the
// oracle sums them. One source, three readers.

interface BankRow { id: string; name: string; balance: number; currency: string; hidden?: boolean; user_id: string }
interface InvRow {
  id: string; name: string; user_id: string;
  shares_owned: number; current_price: number; current_value: number;
  native_currency: string; asset_type: string; conversion_rate: number | null; display_currency: string;
  day_change_percent?: number | null;
}
interface CcRow { id: string; name: string; balance_owing: number; currency: string; user_id: string }
interface SuperRow { id: string; fund_name: string; balance: number; include_in_net_worth: boolean | null; user_id: string }
interface LoanRow { id: string; name: string; current_balance: number; include_in_net_worth: boolean | null; user_id: string }
interface PropRow {
  id: string; name: string; current_value: number; ownership_percent: number;
  include_in_net_worth: boolean | null; loan_id: string | null; held_by: string | null;
  smsf_fund_id: string | null; super_fund_id: string | null; counted_in_fund_balance: boolean | null;
  user_id: string;
}

const USER = 'u-history-stress';

/** Every simulated owner, with the timezone the day-bucketing must respect. */
const USERS: { id: string; currency_preference: string; timezone: string | null }[] = [
  { id: USER, currency_preference: 'AUD', timezone: 'Australia/Sydney' },
];

const W = {
  bank: [] as BankRow[],
  inv: [] as InvRow[],
  cc: [] as CcRow[],
  sup: [] as SuperRow[],
  loans: [] as LoanRow[],
  props: [] as PropRow[],
};

/** Live FX, in AUD per unit of the foreign currency. Mutated by the FX-shock event. */
const FX: Record<string, number> = { AUD: 1, USD: 1.52, GBP: 1.94 };

// ─── the fake database ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const tableOf = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
/** Seeding writes straight into `db`; tell the fake its memo is stale. */
const bumpDb = () => { dbVersion++; sortMemo.clear(); };

/** Live tables are views over the world; history tables are really stored. */
function liveRows(table: string): Row[] | null {
  switch (table) {
    case 'users': return USERS as unknown as Row[];
    case 'bank_accounts': return W.bank as unknown as Row[];
    case 'investments': return W.inv as unknown as Row[];
    case 'credit_cards': return W.cc as unknown as Row[];
    case 'super_funds': return W.sup as unknown as Row[];
    case 'smsf_funds': return [];
    case 'smsf_assets': return [];
    case 'loans': return W.loans as unknown as Row[];
    case 'properties': return W.props as unknown as Row[];
    case 'transactions': return [];
    default: return null;
  }
}

const cmpVals = (a: unknown, b: unknown) =>
  String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

/**
 * Paging reads the same ordered result over and over — 200 pages of a 200,000-row
 * table means 200 identical sorts if nothing remembers. Memoise the ordered rows per
 * (table, filters, order) and throw the memo away whenever the table is written to,
 * so the fake stays a fake and three simulated years still fit in a test run.
 */
const sortMemo = new Map<string, Row[]>();
let dbVersion = 0;

class FakeQuery {
  private eqs: [string, unknown][] = [];
  private neqs: [string, unknown][] = [];
  private cmps: [string, string, unknown][] = [];
  private orders: [string, boolean][] = [];
  private cap: number | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  neq(col: string, val: unknown) { this.neqs.push([col, val]); return this; }
  gte(col: string, val: unknown) { this.cmps.push([col, '>=', val]); return this; }
  lte(col: string, val: unknown) { this.cmps.push([col, '<=', val]); return this; }
  gt(col: string, val: unknown) { this.cmps.push([col, '>', val]); return this; }
  lt(col: string, val: unknown) { this.cmps.push([col, '<', val]); return this; }
  /** Several .order() calls compose, exactly as PostgREST composes them — the second
   *  is the tie-breaker that makes paging over one snapshot's many rows stable. */
  order(col: string, o?: { ascending?: boolean }) { this.orders.push([col, o?.ascending !== false]); return this; }
  limit(n: number) { this.cap = n; return this; }
  /** No transfer legs are seeded — the movers' transfer stripping is tested elsewhere. */
  or() { return this; }
  in() { return this; }
  range(from: number, to: number) {
    return Promise.resolve({ data: this.ordered().slice(from, to + 1), error: null });
  }
  insert(rows: Row | Row[]) {
    for (const r of ([] as Row[]).concat(rows)) tableOf(this.table).push(r);
    dbVersion++;
    return Promise.resolve({ data: null, error: null });
  }
  private filtered(): Row[] {
    const src = liveRows(this.table) ?? tableOf(this.table);
    if (!this.eqs.length && !this.neqs.length && !this.cmps.length) return src;
    return src.filter(r =>
      this.eqs.every(([c, v]) => r[c] === v) &&
      this.neqs.every(([c, v]) => r[c] !== v) &&
      this.cmps.every(([c, op, v]) => {
        const d = cmpVals(r[c], v);
        return op === '>=' ? d >= 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d < 0;
      }));
  }
  /** The query's signature — everything that decides its ordered result. */
  private key(): string {
    return JSON.stringify([dbVersion, this.table, this.eqs, this.neqs, this.cmps, this.orders]);
  }
  private compare(a: Row, b: Row): number {
    for (const [col, asc] of this.orders) {
      const d = (asc ? 1 : -1) * cmpVals(a[col], b[col]);
      if (d !== 0) return d;
    }
    return 0;
  }
  /** Filtered and ordered, memoised. No limit applied — that is `rows()`. */
  private ordered(): Row[] {
    if (!this.orders.length) return this.filtered();
    const k = this.key();
    const hit = sortMemo.get(k);
    if (hit) return hit;
    let out = this.filtered();
    let sorted = true;
    for (let i = 1; i < out.length; i++) {
      if (this.compare(out[i - 1], out[i]) > 0) { sorted = false; break; }
    }
    if (!sorted) out = [...out].sort((a, b) => this.compare(a, b));
    if (sortMemo.size > 32) sortMemo.clear();
    sortMemo.set(k, out);
    return out;
  }
  private rows(): Row[] {
    // Hot path: `.order(x, desc).limit(1)` runs on every snapshot over a history that
    // grows to six figures. Selecting the top-k linearly beats sorting, and beats
    // memoising too, because the table has just been written to.
    if (this.orders.length && this.cap != null && this.cap <= 4) {
      const out = this.filtered();
      const top: Row[] = [];
      for (const r of out) {
        let i = top.length;
        while (i > 0 && this.compare(top[i - 1], r) > 0) i--;
        if (i < this.cap) { top.splice(i, 0, r); if (top.length > this.cap) top.pop(); }
      }
      return top;
    }
    const out = this.ordered();
    return this.cap == null ? out : out.slice(0, this.cap);
  }
  single() {
    const r = this.rows();
    return Promise.resolve(r.length ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } });
  }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => void) { resolve({ data: this.rows(), error: null }); }
}

vi.mock('../utils/supabase', () => ({
  supabase: { from: (table: string) => new FakeQuery(table) },
  getSupabase: () => { throw new Error('not used here'); },
  upsertTolerant: () => { throw new Error('not used here'); },
}));

vi.mock('./currencyService', () => ({
  convertAmount: (amount: number, from: string) =>
    Promise.resolve({ converted: r2(amount * (FX[from] ?? 1)), rate: FX[from] ?? 1 }),
  convertBalance: (amount: number, from: string) =>
    Promise.resolve({ converted: r2(amount * (FX[from] ?? 1)), rate: FX[from] ?? 1 }),
  getRate: (from: string) => Promise.resolve(FX[from] ?? 1),
  getRateOn: (from: string) => Promise.resolve(FX[from] ?? 1),
}));

import { supabase } from '../utils/supabase';
import {
  computeNetWorth, recordNetWorthSnapshot, getAdjustedNwSeries, getItemChanges,
} from './netWorthSnapshot';
import { readPctHistory } from './netWorthPctSeries';
import { HISTORY_PAGE, latestSnapshotAtOrBefore } from './netWorthHistoryReader';

const r2 = (x: number) => parseFloat(x.toFixed(2));

// ─── the independent oracle ──────────────────────────────────────────────────
/**
 * What the portfolio is worth, written from the RULES rather than from the engine:
 * cash at the day's rate; a holding at units × price × the rate pinned on the row
 * (live rate for cash holdings, which carry no usable pin); super at face; property
 * at the owned share; cards and loans subtracted. Deliberately not a call into
 * anything under test.
 */
function oracleNetWorth(): number {
  let nw = 0;
  for (const a of W.bank) { if (a.hidden === true) continue; nw += r2(a.balance * (FX[a.currency] ?? 1)); }
  for (const i of W.inv) {
    const pinUsable =
      i.native_currency !== 'AUD' && i.asset_type !== 'cash' &&
      i.conversion_rate != null && Number.isFinite(i.conversion_rate) &&
      i.conversion_rate > 0 && i.conversion_rate !== 1 && i.display_currency === 'AUD';
    const rate = i.native_currency === 'AUD' ? 1 : pinUsable ? i.conversion_rate! : (FX[i.native_currency] ?? 1);
    nw += r2(i.shares_owned * i.current_price * rate);
  }
  for (const c of W.cc) nw -= r2(c.balance_owing * (FX[c.currency] ?? 1));
  for (const s of W.sup) if (s.include_in_net_worth !== false) nw += s.balance;
  for (const l of W.loans) if (l.include_in_net_worth !== false) nw -= l.current_balance;
  for (const p of W.props) {
    if (p.include_in_net_worth === false) continue;
    nw += (p.current_value * p.ownership_percent) / 100;
    const loan = p.loan_id ? W.loans.find(l => l.id === p.loan_id) : undefined;
    if (loan && loan.include_in_net_worth === false) nw -= loan.current_balance;
  }
  return r2(nw);
}

// ─── the clock ───────────────────────────────────────────────────────────────
const START = Date.UTC(2023, 0, 2, 9, 0, 0);   // Monday 2 Jan 2023, 09:00 UTC
const HOUR = 3600_000;
const DAY = 24 * HOUR;
let now = START;
const setClock = (ms: number) => { now = ms; vi.setSystemTime(new Date(ms)); };

// Deterministic noise — a seeded LCG, never Math.random.
let seed = 20260829;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const drift = (pct: number) => 1 + (rnd() - 0.5) * 2 * pct;

// ─── the run's ledger ────────────────────────────────────────────────────────
interface Tick {
  ms: number; day: number; hour: boolean;
  live: number; oracle: number; recorded: boolean; note: string;
}
const ticks: Tick[] = [];
const historyRows = () => tableOf('net_worth_history').filter(r => r.user_id === USER);

/** One snapshot attempt at the current clock, logged. Returns whether it landed. */
async function snap(day: number, note = '', hour = false): Promise<boolean> {
  const before = historyRows().length;
  const nw = await recordNetWorthSnapshot(USER);
  const recorded = historyRows().length > before;
  ticks.push({ ms: now, day, hour, live: nw.netWorth, oracle: oracleNetWorth(), recorded, note });
  return recorded;
}

/** The hourly cron cadence, for `hours` hours from the current clock. */
async function hourlyBurst(day: number, hours: number, note: string) {
  for (let h = 0; h < hours; h++) {
    setClock(now + HOUR);
    await snap(day, `${note}+${h + 1}h`, true);
  }
}

function seedWorld() {
  W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
  W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
  W.bank.push(
    { id: 'b-sav', name: 'Everyday Saver', balance: 85_000, currency: 'AUD', user_id: USER },
    { id: 'b-off', name: 'Offset', balance: 42_000, currency: 'AUD', user_id: USER },
    { id: 'b-usd', name: 'US dollar account', balance: 20_000, currency: 'USD', user_id: USER },
  );
  W.inv.push(
    { id: 'i-vas', name: 'VAS', user_id: USER, shares_owned: 4_000, current_price: 92.5, current_value: 370_000,
      native_currency: 'AUD', asset_type: 'stock', conversion_rate: 1, display_currency: 'AUD', day_change_percent: 0 },
    { id: 'i-aapl', name: 'AAPL', user_id: USER, shares_owned: 300, current_price: 210.4, current_value: 63_120,
      native_currency: 'USD', asset_type: 'stock', conversion_rate: 1.52, display_currency: 'AUD', day_change_percent: 0 },
    { id: 'i-btc', name: 'Bitcoin', user_id: USER, shares_owned: 1.5, current_price: 95_000, current_value: 142_500,
      native_currency: 'USD', asset_type: 'crypto', conversion_rate: 1.52, display_currency: 'AUD', day_change_percent: 0 },
    { id: 'i-usdcash', name: 'USD cash holding', user_id: USER, shares_owned: 1, current_price: 12_000, current_value: 12_000,
      native_currency: 'USD', asset_type: 'cash', conversion_rate: null, display_currency: 'AUD', day_change_percent: 0 },
  );
  W.cc.push({ id: 'c-amex', name: 'Amex', balance_owing: 4_200, currency: 'AUD', user_id: USER });
  W.sup.push({ id: 's-aus', fund_name: 'AustralianSuper', balance: 210_000, include_in_net_worth: null, user_id: USER });
  W.loans.push(
    { id: 'l-home', name: 'Home loan', current_balance: 640_000, include_in_net_worth: null, user_id: USER },
    { id: 'l-car', name: 'Car loan', current_balance: 28_000, include_in_net_worth: null, user_id: USER },
  );
  W.props.push({
    id: 'p-home', name: 'Home', current_value: 1_150_000, ownership_percent: 100,
    include_in_net_worth: null, loan_id: 'l-home', held_by: null,
    smsf_fund_id: null, super_fund_id: null, counted_in_fund_balance: null, user_id: USER,
  });
}

/** An ordinary day: prices wobble, salary lands, the card is used, the loans amortise. */
function ordinaryDay(day: number) {
  for (const i of W.inv) {
    if (i.asset_type === 'cash') continue;
    i.current_price = r2(i.current_price * drift(i.asset_type === 'crypto' ? 0.04 : 0.012));
    i.current_value = r2(i.shares_owned * i.current_price);
  }
  W.bank[0].balance = r2(W.bank[0].balance + (day % 14 === 0 ? 4_800 : -160 * drift(0.5)));
  W.cc[0].balance_owing = r2(Math.max(0, W.cc[0].balance_owing + 120 * drift(0.8) - (day % 30 === 0 ? 3_600 : 0)));
  W.sup[0].balance = r2(W.sup[0].balance * 1.0002);
  for (const l of W.loans) l.current_balance = r2(Math.max(0, l.current_balance - (l.id === 'l-home' ? 380 : 60)));
  for (const p of W.props) p.current_value = r2(p.current_value * 1.00012);
}

// ─── the events ──────────────────────────────────────────────────────────────
/** day → [label, mutation, hours of hourly cron to run around it]. */
const EVENTS: Record<number, [string, () => void, number]> = {
  45:  ['market crash', () => { for (const i of W.inv) if (i.asset_type !== 'cash') { i.current_price = r2(i.current_price * (i.asset_type === 'crypto' ? 0.2 : 0.3)); i.current_value = r2(i.shares_owned * i.current_price); } }, 8],
  120: ['market recovery', () => { for (const i of W.inv) if (i.asset_type !== 'cash') { i.current_price = r2(i.current_price * 3.2); i.current_value = r2(i.shares_owned * i.current_price); } }, 8],
  200: ['inheritance into an existing account', () => { W.bank[0].balance = r2(W.bank[0].balance + 850_000); }, 8],
  260: ['huge withdrawal', () => { W.bank[0].balance = r2(W.bank[0].balance - 900_000); }, 6],
  300: ['investment property purchased', () => {
    W.bank[0].balance = r2(W.bank[0].balance - 200_000);
    W.loans.push({ id: 'l-ip', name: 'Investment loan', current_balance: 780_000, include_in_net_worth: null, user_id: USER });
    W.props.push({ id: 'p-ip', name: 'Investment property', current_value: 980_000, ownership_percent: 100,
      include_in_net_worth: null, loan_id: 'l-ip', held_by: null, smsf_fund_id: null, super_fund_id: null,
      counted_in_fund_balance: null, user_id: USER });
  }, 8],
  420: ['FX shock', () => {
    FX.USD = 1.98;
    for (const i of W.inv) if (i.native_currency === 'USD' && i.conversion_rate != null) i.conversion_rate = 1.98;
  }, 8],
  500: ['large loan payoff', () => {
    W.bank[0].balance = r2(W.bank[0].balance - 28_000 - 300_000);
    const car = W.loans.find(l => l.id === 'l-car')!; car.current_balance = 0;
    const home = W.loans.find(l => l.id === 'l-home')!; home.current_balance = r2(home.current_balance - 300_000);
  }, 8],
  // Structural AND huge: an item appears and net worth jumps by half. This is the
  // case the guard's item-set escape hatch exists for.
  640: ['inherited share parcel', () => {
    W.inv.push({ id: 'i-inh', name: 'Inherited parcel', user_id: USER, shares_owned: 2_000, current_price: 300,
      current_value: 600_000, native_currency: 'USD', asset_type: 'stock', conversion_rate: 1.98,
      display_currency: 'AUD', day_change_percent: 0 });
  }, 6],
  700: ['inherited parcel sold and distributed', () => {
    const p = W.inv.find(i => i.id === 'i-inh')!;
    W.inv.splice(W.inv.indexOf(p), 1);
  }, 6],
  800: ['big withdrawal', () => { W.bank[0].balance = r2(W.bank[0].balance - 250_000); }, 6],
  900: ['investment property sold', () => {
    const p = W.props.find(x => x.id === 'p-ip')!;
    const loan = W.loans.find(l => l.id === 'l-ip')!;
    W.bank[0].balance = r2(W.bank[0].balance + p.current_value - loan.current_balance);
    W.props.splice(W.props.indexOf(p), 1);
    W.loans.splice(W.loans.indexOf(loan), 1);
  }, 8],
  1000: ['second crash', () => { for (const i of W.inv) if (i.asset_type !== 'cash') { i.current_price = r2(i.current_price * 0.42); i.current_value = r2(i.shares_owned * i.current_price); } }, 10],
};

const DAYS = 1095; // three years

interface EventReport {
  day: number; label: string;
  before: number; after: number; movePct: number;
  blindHours: number | null;   // hours from the event to the first snapshot that recorded it
  skipped: number;             // snapshot attempts declined inside the burst
}
const eventReports: EventReport[] = [];

beforeAll(async () => {
  vi.useFakeTimers();
  seedWorld();
  setClock(START);
  await snap(0, 'first');

  for (let day = 1; day <= DAYS; day++) {
    setClock(START + day * DAY);
    ordinaryDay(day);
    const ev = EVENTS[day];
    if (!ev) { await snap(day); continue; }

    const [label, mutate, hours] = ev;
    // Production runs the cron hourly, so the snapshot before a shock is minutes-to-
    // an-hour old, not a day. Warm the cadence up first — otherwise the guard is
    // never armed and the shock records trivially.
    await hourlyBurst(day, 3, `${label} pre`);
    const before = (await computeNetWorth(USER)).netWorth;
    mutate();
    const after = (await computeNetWorth(USER)).netWorth;
    const eventMs = now;

    const firstBurstTick = ticks.length;
    await hourlyBurst(day, hours, label);
    const burst = ticks.slice(firstBurstTick);
    const landed = burst.find(t => t.recorded);
    eventReports.push({
      day, label, before, after,
      movePct: Math.abs(before) > 1 ? Math.abs(after - before) / Math.abs(before) : 0,
      blindHours: landed ? Math.round((landed.ms - eventMs) / HOUR) : null,
      skipped: burst.filter(t => !t.recorded).length,
    });
  }
}, 300_000);

afterAll(() => { vi.useRealTimers(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('three years of shocks: the live figure', () => {
  it('agrees with the independent oracle on every single tick', () => {
    const off = ticks.filter(t => Math.abs(t.live - t.oracle) > 0.005);
    expect(off.map(t => ({ day: t.day, note: t.note, live: t.live, oracle: t.oracle }))).toEqual([]);
  });

  it('really was stressed — the events moved the number hard', () => {
    expect(eventReports.length).toBe(Object.keys(EVENTS).length);
    const big = eventReports.filter(e => e.movePct > 0.25);
    expect(big.length).toBeGreaterThanOrEqual(5);
  });

  it('ran for three years of daily ticks plus the hourly bursts', () => {
    expect(ticks.length).toBeGreaterThan(DAYS);
    expect(new Set(ticks.map(t => t.day)).size).toBe(DAYS + 1);
  });
});

describe('three years of shocks: what the chart kept', () => {
  it('records a snapshot on every ordinary day', () => {
    const missed = ticks.filter(t => !t.hour && !t.recorded);
    expect(missed.map(t => ({ day: t.day, live: t.live }))).toEqual([]);
  });

  it('the newest recorded point equals the live net worth', async () => {
    const rows = historyRows();
    const newest = rows[rows.length - 1];
    const live = await computeNetWorth(USER);
    expect(Number(newest.total_value)).toBeCloseTo(live.netWorth, 2);
  });

  it('every recorded point equals the ORACLE at the moment it was taken', () => {
    // The strongest form of the comparison: not "the engine agreed with itself",
    // but "what the chart will say tomorrow is what the portfolio was worth".
    const byMs = new Map(ticks.map(t => [t.ms, t]));
    const off: { at: string; recorded: number; oracle: number }[] = [];
    for (const r of historyRows()) {
      const t = byMs.get(new Date(String(r.recorded_at)).getTime());
      if (!t) continue;
      if (Math.abs(Number(r.total_value) - t.oracle) > 0.005) {
        off.push({ at: String(r.recorded_at), recorded: Number(r.total_value), oracle: t.oracle });
      }
    }
    expect(off).toEqual([]);
  });

  it('every recorded point is a value the portfolio really had', () => {
    const seen = new Set(ticks.map(t => t.live.toFixed(2)));
    const invented = historyRows().filter(r => !seen.has(Number(r.total_value).toFixed(2)));
    expect(invented.map(r => r.total_value)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the outlier guard, after the confirming re-read replaced the 25% rule', () => {
  const STRUCTURAL = [
    'investment property purchased', 'inherited share parcel',
    'inherited parcel sold and distributed', 'investment property sold',
  ];

  it('lets a structural change (an item appearing or disappearing) through at once', () => {
    const structural = eventReports.filter(e => STRUCTURAL.includes(e.label));
    expect(structural.length).toBe(4);
    expect(structural.filter(e => e.movePct > 0.25).length).toBeGreaterThanOrEqual(2);
    for (const e of structural) expect(e.blindHours).toBe(1);
  });

  it('records every same-item-set shock within the hour too', () => {
    // This is the fix. Each of these is a REAL movement — a crash, a recovery, an
    // inheritance paid into an account the user already had, a huge withdrawal —
    // that the old 25% rule refused to record for three hours because the items
    // were unchanged. A settled portfolio reads the same twice, so it lands.
    const sameSet = eventReports.filter(e => e.movePct > 0.25 && !STRUCTURAL.includes(e.label));
    expect(sameSet.length).toBeGreaterThan(0);
    for (const e of sameSet) expect(e.blindHours).toBe(1);
  });

  it('records a genuine market crash within the hour, like every other day', () => {
    const crash = eventReports.find(e => e.label === 'market crash')!;
    expect(crash.blindHours).toBe(1);
  });

  it('records an inheritance paid into an existing account within the hour', () => {
    const inh = eventReports.find(e => e.label === 'inheritance into an existing account')!;
    expect(inh.blindHours).toBe(1);
  });

  it('declines nothing at all across three years of shocks', () => {
    const declined = ticks.filter(t => !t.recorded);
    expect(declined.map(t => ({ day: t.day, note: t.note, live: t.live }))).toEqual([]);
  });

  it('does not gate an ordinary transaction just because net worth is small', async () => {
    // A student: a $4,000 net worth and a $1,200 rent payment. Nothing here is a
    // corrupt read — it is a Tuesday — but 30% > 25%, so the old threshold treated
    // it as one every month. The absolute floor is why it no longer can.
    const OTHER = 'u-small';
    const small = { id: 'b-small', name: 'Savings', balance: 4_000, currency: 'AUD', user_id: OTHER };
    const keep = { bank: [...W.bank], inv: [...W.inv], cc: [...W.cc], sup: [...W.sup], loans: [...W.loans], props: [...W.props] };
    try {
      // The guard reads the user's own last snapshot, so borrow the same user id.
      small.user_id = USER;
      W.bank.length = 0; W.bank.push(small as BankRow);
      W.inv.length = 0; W.cc.length = 0; W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
      setClock(now + 6 * HOUR);
      await recordNetWorthSnapshot(USER);       // anchor at $4,000
      small.balance = 2_800;                    // rent goes out: a 30% move
      setClock(now + HOUR);
      const before = historyRows().length;
      await recordNetWorthSnapshot(USER);
      expect(historyRows().length).toBe(before + 1);
      expect(Number(historyRows()[historyRows().length - 1].total_value)).toBe(2_800);
    } finally {
      W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
      W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
      W.bank.push(...keep.bank); W.inv.push(...keep.inv); W.cc.push(...keep.cc);
      W.sup.push(...keep.sup); W.loans.push(...keep.loans); W.props.push(...keep.props);
    }
  });

  it('keeps every hour of a violently volatile account', async () => {
    // A crypto-heavy position where an ordinary hour moves the total by more than a
    // quarter. Half of this series used to be dropped on the grounds that it was
    // "too big to be real". It is real, it reads the same twice, and it is kept.
    const keep = {
      bank: [...W.bank], inv: [...W.inv], cc: [...W.cc],
      sup: [...W.sup], loans: [...W.loans], props: [...W.props],
    };
    W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
    W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
    W.inv.push({ id: 'v-coin', name: 'Volatile', user_id: USER, shares_owned: 10, current_price: 4_000,
      current_value: 40_000, native_currency: 'AUD', asset_type: 'crypto', conversion_rate: 1,
      display_currency: 'AUD', day_change_percent: 0 });
    let landed = 0;
    const truths: number[] = [];
    const HOURS = 48;
    try {
      setClock(now + 12 * HOUR);
      for (let h = 0; h < HOURS; h++) {
        W.inv[0].current_price = r2(W.inv[0].current_price * (h % 2 === 0 ? 1.45 : 0.7));
        W.inv[0].current_value = r2(W.inv[0].shares_owned * W.inv[0].current_price);
        setClock(now + HOUR);
        const before = historyRows().length;
        await recordNetWorthSnapshot(USER);
        if (historyRows().length > before) landed++;
        truths.push(oracleNetWorth());
      }
    } finally {
      W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
      W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
      W.bank.push(...keep.bank); W.inv.push(...keep.inv); W.cc.push(...keep.cc);
      W.sup.push(...keep.sup); W.loans.push(...keep.loans); W.props.push(...keep.props);
    }
    // eslint-disable-next-line no-console
    console.log(`[MEASURED] sustained volatility: ${landed}/${HOURS} hourly snapshots recorded`);
    expect(landed).toBe(HOURS);
    // …and each of them is the value the account really had that hour.
    const tail = historyRows().slice(-HOURS).map(r => Number(r.total_value));
    expect(tail).toEqual(truths);
  });

  it('still refuses a reading that does not reproduce — data caught mid-write', async () => {
    // The one thing the guard is actually for. A bulk import has half-written the
    // balances, so the portfolio reads differently from one moment to the next; the
    // engine must not write down a number the portfolio was never worth.
    const keep = { bank: [...W.bank], inv: [...W.inv], cc: [...W.cc], sup: [...W.sup], loans: [...W.loans], props: [...W.props] };
    const acct = { id: 'b-flux', name: 'Importing', balance: 200_000, currency: 'AUD', user_id: USER };
    W.bank.length = 0; W.bank.push(acct as BankRow);
    W.inv.length = 0; W.cc.length = 0; W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
    try {
      setClock(now + 6 * HOUR);
      await recordNetWorthSnapshot(USER);            // settled at $200,000
      // Now the row moves BETWEEN the two reads, which is what a half-written
      // import looks like from here and what a real crash never does.
      let reads = 0;
      const original = Object.getOwnPropertyDescriptor(acct, 'balance');
      Object.defineProperty(acct, 'balance', {
        configurable: true,
        get: () => (++reads === 1 ? 10_000 : 60_000),
      });
      setClock(now + HOUR);
      const before = historyRows().length;
      await recordNetWorthSnapshot(USER);
      expect(historyRows().length).toBe(before);     // deferred, nothing written
      if (original) Object.defineProperty(acct, 'balance', original);
      // …and the very next snapshot, once it has settled, records normally.
      acct.balance = 60_000;
      setClock(now + HOUR);
      await recordNetWorthSnapshot(USER);
      expect(historyRows().length).toBe(before + 1);
      expect(Number(historyRows()[historyRows().length - 1].total_value)).toBe(60_000);
    } finally {
      W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
      W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
      W.bank.push(...keep.bank); W.inv.push(...keep.inv); W.cc.push(...keep.cc);
      W.sup.push(...keep.sup); W.loans.push(...keep.loans); W.props.push(...keep.props);
    }
  });

  it('nothing is ever blind for more than the cron interval', () => {
    for (const e of eventReports) expect(e.blindHours).not.toBeNull();
    expect(Math.max(...eventReports.map(e => e.blindHours ?? 0))).toBe(1);
  });
});

describe('a snapshot is whole or it is not there', () => {
  it('never leaves a total on the chart with no items behind it', () => {
    // Items are written first and the total row is the commit marker, so every
    // recorded total has a complete breakdown under it at the same instant.
    const items = tableOf('net_worth_item_history').filter(r => r.user_id === USER);
    const byAt = new Map<string, number>();
    for (const r of items) byAt.set(String(r.recorded_at), (byAt.get(String(r.recorded_at)) ?? 0) + 1);
    const orphans = historyRows()
      .filter(r => Number(r.total_value) !== 0 && !byAt.has(String(r.recorded_at)));
    expect(orphans.map(r => r.recorded_at)).toEqual([]);
  });

  it('every recorded total is exactly the items written beside it', async () => {
    // A torn snapshot is one where the total and its breakdown disagree, so sum the
    // items at each recorded_at and hold the pair to the cent — across all three
    // years, every shock, and both FX paths.
    const items = tableOf('net_worth_item_history').filter(r => r.user_id === USER);
    const sums = new Map<string, number>();
    for (const r of items) {
      const at = String(r.recorded_at);
      const signed = (r.is_debt ? -1 : 1) * Number(r.value);
      sums.set(at, (sums.get(at) ?? 0) + signed);
    }
    const off = historyRows().filter(r => {
      const at = String(r.recorded_at);
      const total = Number(r.total_value);
      if (total === 0 && !sums.has(at)) return false;   // a genuine liquidation
      return Math.abs((sums.get(at) ?? NaN) - total) > 0.005;
    });
    expect(off.map(r => ({ at: r.recorded_at, total: r.total_value }))).toEqual([]);
  });
});

describe('repeated hourly snapshots', () => {
  /** A year and more of the real cron cadence, written straight into history. */
  const HOURLY_USER = 'u-hourly';
  const HOURLY_DAYS = 400;
  const TZ = 'Australia/Sydney';
  const sydneyDay = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));

  beforeAll(() => {
    USERS.push({ id: HOURLY_USER, currency_preference: 'AUD', timezone: TZ });
    const rows = tableOf('net_worth_history');
    const items = tableOf('net_worth_item_history');
    let v = 500_000;
    for (let h = 0; h < HOURLY_DAYS * 24; h++) {
      const at = new Date(START + h * HOUR).toISOString();
      v = r2(v * 1.00004);
      rows.push({ user_id: HOURLY_USER, total_value: v, recorded_at: at, recorded_date: at.split('T')[0] });
      items.push({ user_id: HOURLY_USER, recorded_at: at, item_type: 'bank', item_id: 'h-b', name: 'Bank', value: v, is_debt: false });
    }
    bumpDb();
    setClock(START + HOURLY_DAYS * DAY);
  });

  it('a year of hourly snapshots really is more than 2000 rows', () => {
    expect(tableOf('net_worth_history').filter(r => r.user_id === HOURLY_USER).length).toBe(HOURLY_DAYS * 24);
  });

  it('the "all" chart reaches today after more than a year of hourly snapshots', async () => {
    const { points } = await readPctHistory(HOURLY_USER, 'all');
    const last = points[points.length - 1];
    const ageDays = (Date.now() - new Date(last.recorded_at).getTime()) / DAY;
    // eslint-disable-next-line no-console
    console.log(`[MEASURED] all-time chart: ${points.length} points from ${HOURLY_DAYS} days of hourly snapshots, newest is ${ageDays.toFixed(2)} days old`);
    expect(ageDays).toBeLessThan(1);
  });

  it('the "yearly" chart reaches today too', async () => {
    const { points } = await readPctHistory(HOURLY_USER, 'yearly');
    const last = points[points.length - 1];
    expect((Date.now() - new Date(last.recorded_at).getTime()) / DAY).toBeLessThan(1);
  });

  it('the short windows are unaffected', async () => {
    for (const tf of ['daily', 'weekly', 'monthly']) {
      const { points } = await readPctHistory(HOURLY_USER, tf);
      const last = points[points.length - 1];
      expect((Date.now() - new Date(last.recorded_at).getTime()) / DAY).toBeLessThan(1);
    }
  });

  it('draws one point per day with no day missing anywhere in the series', async () => {
    // The whole point of the fix: not just "it reaches today" but "every day between
    // the first snapshot and today is on the line, exactly once".
    const { points, truncated } = await readPctHistory(HOURLY_USER, 'all');
    expect(truncated).toBe(false);
    const days = points.map(p => sydneyDay(p.recorded_at));
    expect(new Set(days).size).toBe(days.length);          // one point per day
    for (let i = 1; i < days.length; i++) {
      const gap = (Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) / DAY;
      expect(gap).toBe(1);                                 // and no day skipped
    }
    // 400 days of hourly rows spanning 401 local calendar days.
    expect(points.length).toBe(new Set(
      tableOf('net_worth_history').filter(r => r.user_id === HOURLY_USER)
        .map(r => sydneyDay(String(r.recorded_at))),
    ).size);
  });

  it('closes each day at the owner\'s midnight, not at UTC midnight', async () => {
    // January in Sydney is UTC+11, so a Sydney day ends at 13:00Z and its last
    // hourly snapshot is the one stamped 12:00Z. Bucketing by UTC picked 23:00Z
    // instead — eleven hours into the next local day, and the middle of the user's
    // morning presented as the close of their day.
    const { points } = await readPctHistory(HOURLY_USER, 'all');
    const jan = points.find(p => sydneyDay(p.recorded_at) === '2023-01-10')!;
    expect(jan).toBeDefined();
    expect(new Date(jan.recorded_at).toISOString()).toBe('2023-01-10T12:00:00.000Z');
    expect(new Date(jan.recorded_at).getUTCHours()).not.toBe(23);
  });

  it('measures the percentage against the size of the baseline', async () => {
    const { baseline, points } = await readPctHistory(HOURLY_USER, 'all');
    expect(baseline).toBeGreaterThan(0);
    const first = points[0];
    expect(first.pct).toBeCloseTo(((first.value - baseline) / Math.abs(baseline)) * 100, 4);
  });
});

describe('the per-item history behind the chart, at scale', () => {
  const DEEP = 'u-deep';
  const ITEMS = 12;
  const SNAPS = 16_700;            // ~1.9 years of hourly snapshots on 12 items
  beforeAll(() => {
    USERS.push({ id: DEEP, currency_preference: 'AUD', timezone: 'Australia/Sydney' });
    const items = tableOf('net_worth_item_history');
    const hist = tableOf('net_worth_history');
    for (let s = 0; s < SNAPS; s++) {
      const at = new Date(START + s * HOUR).toISOString();
      let total = 0;
      for (let k = 0; k < ITEMS; k++) {
        const value = r2(10_000 + k * 1_000 + s * 0.5);
        total += value;
        items.push({ user_id: DEEP, recorded_at: at, item_type: 'bank', item_id: `d-${k}`, name: `Acct ${k}`, value, is_debt: false });
      }
      hist.push({ user_id: DEEP, total_value: r2(total), recorded_at: at, recorded_date: at.split('T')[0] });
    }
    bumpDb();
    setClock(START + SNAPS * HOUR);
  });

  it('has far more per-item rows than any single request can return', () => {
    expect(tableOf('net_worth_item_history').filter(r => r.user_id === DEEP).length).toBeGreaterThan(200_000);
  });

  it('the adjusted series reaches today after two years of hourly snapshots', async () => {
    const series = await getAdjustedNwSeries(DEEP);
    const last = series.points[series.points.length - 1];
    expect((Date.now() - new Date(last.recorded_at).getTime()) / DAY).toBeLessThan(1);
  });

  it('keeps every snapshot — the reader no longer stops part way through', async () => {
    const series = await getAdjustedNwSeries(DEEP);
    expect(series.truncated).toBe(false);
    expect(series.points.length).toBe(SNAPS);
    const last = series.points[series.points.length - 1];
    expect(Math.round((new Date(last.recorded_at).getTime() - START) / HOUR)).toBe(SNAPS - 1);
  });

  it('every point of the series is a whole snapshot, never a torn one', async () => {
    // 200,000 rows is not a multiple of twelve items, so the old page budget ran out
    // PART WAY THROUGH a snapshot and the final point was assembled from 8 of 12
    // accounts — a snapshot that was never taken. `activeValue` is the sum of the
    // items present at each point, so comparing it to the recorded total catches a
    // torn point anywhere in the series, not just at the end.
    const series = await getAdjustedNwSeries(DEEP);
    const byAt = new Map(
      tableOf('net_worth_history').filter(r => r.user_id === DEEP)
        .map(r => [String(r.recorded_at), Number(r.total_value)]),
    );
    const torn = series.points.filter(p => {
      const total = byAt.get(p.recorded_at);
      return total == null || Math.abs(total - p.activeValue) > 0.005;
    });
    expect(torn.map(p => p.recorded_at)).toEqual([]);
  });

  it('the movers list is measured against the newest snapshot, not a stale one', async () => {
    const { items } = await getItemChanges(DEEP, 'daily');
    const acct = items.find(i => i.item_id === 'd-0');
    expect(acct).toBeDefined();
    const truth = r2(10_000 + (SNAPS - 1) * 0.5);
    // eslint-disable-next-line no-console
    console.log(`[MEASURED] movers: account d-0 reported at ${acct!.current_value}, really worth ${truth}, change ${acct!.change}`);
    expect(acct!.current_value).toBeCloseTo(truth, 2);
    // Every account grows 0.50 an hour. The window opens on the snapshot 24h back
    // and the newest snapshot is an hour old, so 23 steps: 11.50. What matters is
    // that it is the real movement at all — a stale read reported 0.00 for every
    // item, forever, no matter how much they had moved.
    expect(acct!.change).toBeCloseTo(11.5, 2);
  });

  it('answers a windowed question out of a single page of rows', async () => {
    // What makes this scalable rather than merely correct: "what moved today" now
    // reads from the snapshot the window opened on, so it is a day of rows — where
    // the previous reader took two hundred pages to answer the same question and
    // still got it wrong.
    const anchor = await latestSnapshotAtOrBefore('net_worth_item_history', DEEP, Date.now() - DAY);
    expect(anchor).not.toBeNull();
    const toRead = tableOf('net_worth_item_history')
      .filter(r => r.user_id === DEEP && String(r.recorded_at) >= anchor!).length;
    expect(toRead).toBeLessThan(HISTORY_PAGE);
  });
});

describe('the percentage the chart actually draws', () => {
  const DEBT = 'u-indebted';
  beforeAll(() => {
    // Someone who starts tracking while in the red — a student loan and a card,
    // before any assets are entered — then climbs steadily out of it.
    USERS.push({ id: DEBT, currency_preference: 'AUD', timezone: 'Australia/Sydney' });
    const hist = tableOf('net_worth_history');
    const items = tableOf('net_worth_item_history');
    const path = [-40_000, -30_000, -18_000, -6_000, 5_000, 22_000, 48_000];
    path.forEach((v, d) => {
      const at = new Date(START + d * DAY).toISOString();
      hist.push({ user_id: DEBT, total_value: v, recorded_at: at, recorded_date: at.split('T')[0] });
      items.push({ user_id: DEBT, recorded_at: at, item_type: 'loan', item_id: 'sl', name: 'Student loan', value: Math.abs(Math.min(v, 0)) + 40_000, is_debt: true });
      items.push({ user_id: DEBT, recorded_at: at, item_type: 'bank', item_id: 'sb', name: 'Savings', value: v + Math.abs(Math.min(v, 0)) + 40_000, is_debt: false });
    });
    bumpDb();
  });

  it('the baseline really is negative for this user', async () => {
    const { baseline } = await readPctHistory(DEBT, 'all');
    expect(baseline).toBe(-40_000);
  });

  it('paying off debt draws a RISING percentage line', async () => {
    const { baseline, points } = await readPctHistory(DEBT, 'all');
    const pcts = points.map(p => p.pct);
    // eslint-disable-next-line no-console
    console.log(`[MEASURED] baseline ${baseline}, pct series ${pcts.map(x => x.toFixed(1)).join(' → ')}`);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    // Back to level is 0%, not −200%.
    const level = points.find(p => p.value === 0);
    if (level) expect(level.pct).toBe(100);
  });

  it('the percentage always carries the sign of the dollar movement', async () => {
    const { points } = await readPctHistory(DEBT, 'all');
    for (let i = 1; i < points.length; i++) {
      const dollars = points[i].value - points[i - 1].value;
      const pct = points[i].pct - points[i - 1].pct;
      expect(Math.sign(pct)).toBe(Math.sign(dollars));
    }
  });

  it('the adjusted series works while the base is negative', async () => {
    const series = await getAdjustedNwSeries(DEBT);
    // eslint-disable-next-line no-console
    console.log(`[MEASURED] underwater user: currentBase ${series.currentBase}, adjusted pct ${series.points.map(p => p.pct).join(' → ')}`);
    expect(series.currentBase).toBeLessThan(0);
    const pcts = series.points.map(p => p.pct);
    expect(new Set(pcts).size).toBeGreaterThan(1);          // not a flat line of zeroes
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
  });
});

describe('a portfolio that goes to nothing', () => {
  const GONE = 'u-liquidated';
  it('a full liquidation is recorded, not left at yesterday\'s value', async () => {
    const acc = { id: 'g-b', name: 'Savings', balance: 300_000, currency: 'AUD', user_id: GONE };
    const keep = [...W.bank];
    W.bank.length = 0; W.bank.push(acc as BankRow);
    const keepInv = [...W.inv], keepCc = [...W.cc], keepSup = [...W.sup], keepLoans = [...W.loans], keepProps = [...W.props];
    W.inv.length = 0; W.cc.length = 0; W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
    try {
      setClock(START + 2000 * DAY);
      await recordNetWorthSnapshot(GONE);
      W.bank.length = 0;                       // everything closed and withdrawn
      setClock(now + 6 * HOUR);
      await recordNetWorthSnapshot(GONE);
      const rows = tableOf('net_worth_history').filter(r => r.user_id === GONE);
      // eslint-disable-next-line no-console
      console.log(`[MEASURED] after full liquidation, history holds ${rows.length} row(s), last = ${rows[rows.length - 1].total_value}`);
      expect(Number(rows[rows.length - 1].total_value)).toBe(0);
      // …and it is a second row, not an overwrite: the $300,000 that really was
      // there yesterday is still on the chart where it belongs.
      expect(rows.length).toBe(2);
      expect(Number(rows[0].total_value)).toBe(300_000);
    } finally {
      W.bank.length = 0; W.bank.push(...keep);
      W.inv.push(...keepInv); W.cc.push(...keepCc); W.sup.push(...keepSup);
      W.loans.push(...keepLoans); W.props.push(...keepProps);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a wipeout that is not real', () => {
  const FLAKY = 'u-flaky';
  it('does not write a zero that a second read cannot reproduce', async () => {
    // The other half of recording a liquidation. A read that returns nothing looks
    // exactly like a portfolio that holds nothing, and only one of them should end
    // up on the chart — so an empty result is confirmed before it is believed.
    const keep = { bank: [...W.bank], inv: [...W.inv], cc: [...W.cc], sup: [...W.sup], loans: [...W.loans], props: [...W.props] };
    W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
    W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
    const acct = { id: 'f-b', name: 'Savings', balance: 150_000, currency: 'AUD', user_id: FLAKY };
    W.bank.push(acct as BankRow);
    try {
      setClock(now + 6 * HOUR);
      await recordNetWorthSnapshot(FLAKY);                    // settled at $150,000
      const before = tableOf('net_worth_history').filter(r => r.user_id === FLAKY).length;
      expect(before).toBe(1);

      // The account is invisible to the FIRST read of the pair and visible to the
      // second — one query reads user_id once per row, which is what a flaky read
      // looks like from in here.
      let reads = 0;
      const original = Object.getOwnPropertyDescriptor(acct, 'user_id')!;
      Object.defineProperty(acct, 'user_id', {
        configurable: true,
        get: () => (++reads === 1 ? 'someone-else' : FLAKY),
      });
      setClock(now + HOUR);
      await recordNetWorthSnapshot(FLAKY);
      Object.defineProperty(acct, 'user_id', original);
      acct.user_id = FLAKY;

      const rows = tableOf('net_worth_history').filter(r => r.user_id === FLAKY);
      expect(rows.length).toBe(before);                       // no phantom zero
      expect(Number(rows[rows.length - 1].total_value)).toBe(150_000);
    } finally {
      W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
      W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
      W.bank.push(...keep.bank); W.inv.push(...keep.inv); W.cc.push(...keep.cc);
      W.sup.push(...keep.sup); W.loans.push(...keep.loans); W.props.push(...keep.props);
    }
  });
});

describe('the two lines on the same chart', () => {
  it('the recorded total is exactly the sum of the items behind it, every time', async () => {
    // `activeValue` is the point's active items with no carry — the same sum the
    // recorded total is. They must agree to the cent at every snapshot, all three
    // years, or the breakdown is describing a different net worth from the headline.
    // This is what would catch a real valuation drift between the two.
    const series = await getAdjustedNwSeries(USER);
    const byAt = new Map(historyRows().map(r => [String(r.recorded_at), Number(r.total_value)]));
    const off = series.points.filter(p => {
      const raw = byAt.get(p.recorded_at);
      return raw != null && Math.abs(raw - p.activeValue) > 0.005;
    });
    expect(off.map(p => p.recorded_at)).toEqual([]);
  });

  it('`value` is the adjusted axis, and says so — activeValue plus the carry', async () => {
    // The field's comment used to claim it was "raw net worth at the snapshot". It is
    // not, and the difference is the frozen value of everything the user has removed —
    // $3.1M by the end of this run. The contract now names both, and this holds them
    // to it, so a future consumer that wants the recorded total has one to read.
    const series = await getAdjustedNwSeries(USER);
    const withCarry = series.points.filter(p => Math.abs(p.value - p.activeValue) > 0.005);
    expect(withCarry.length).toBeGreaterThan(0);            // removals really happened
    const worst = Math.max(...series.points.map(p => Math.abs(p.value - p.activeValue)));
    // eslint-disable-next-line no-console
    console.log(`[MEASURED] value − activeValue: worst ${worst.toFixed(2)}, carry ${series.carryValue}`);
    expect(worst).toBeCloseTo(Math.abs(series.carryValue), 2);
  });
});

describe('the report', () => {
  it('prints the measured numbers', () => {
    const skipped = ticks.filter(t => !t.recorded).length;
    expect(skipped).toBe(0);
    /* eslint-disable no-console */
    console.log('\n──── NET WORTH HISTORY STRESS: measured ────');
    console.log(`ticks ${ticks.length}, recorded ${ticks.length - skipped}, declined ${skipped}`);
    for (const e of eventReports) {
      console.log(
        `day ${String(e.day).padStart(4)}  ${e.label.padEnd(38)} ` +
        `${e.before.toFixed(0).padStart(10)} → ${e.after.toFixed(0).padStart(10)}  ` +
        `${(e.movePct * 100).toFixed(1).padStart(6)}%  blind ${String(e.blindHours).padStart(2)}h  ` +
        `declined ${e.skipped}`,
      );
    }
    console.log('────────────────────────────────────────────\n');
    /* eslint-enable no-console */
    expect(eventReports.length).toBeGreaterThan(0);
  });
});
