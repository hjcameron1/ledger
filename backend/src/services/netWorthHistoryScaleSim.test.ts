/**
 * TWENTY YEARS, TWENTY-FIVE-PLUS ASSETS, AND AN ASSET SET THAT KEEPS CHANGING.
 *
 * The three-year simulation next door proved the history chart cannot lose the
 * PRESENT. This one asks the opposite question: what happens to the PAST when a
 * portfolio is tracked for two decades — long enough that the raw row count stops
 * being a detail and becomes the thing that breaks the feature.
 *
 * At three snapshots a day on twenty-five items, twenty years is ~22,000 totals and
 * ~550,000 item rows. "All time" then needs more rows than any request can return,
 * and the reader's budget starts silently dropping the oldest history — the part
 * that makes it all-time at all. So history is compacted: full detail for a
 * fortnight, one bucket per local day for a year and a bit, one per local month
 * beyond that, and every bucket keeps its CLOSE, its HIGH and its LOW.
 *
 * That is a claim about money, so the run checks it as one. Every snapshot ever
 * taken is remembered here, in this file, independently of the database — so the
 * series the chart draws after compaction can be compared, point for point, with
 * the series it would have drawn if nothing had ever been deleted. The bar:
 *
 *   • every value that survives is a value the portfolio really had, at the
 *     instant it says — nothing averaged, nothing resampled, nothing invented;
 *   • the line the chart draws is a SUBSET of the line it drew before, never a
 *     different line;
 *   • no day is missing inside a year, no month is missing inside twenty;
 *   • the extremes survive — every compacted month still shows its own high and
 *     its own low, so a crash and its recovery cannot be flattened away;
 *   • Overview, the movers, the adjusted series and All Time all still reach
 *     today, still agree with the live figures, and are answered out of a handful
 *     of pages rather than hundreds.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// ─── the world ───────────────────────────────────────────────────────────────
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

const USER = 'u-twenty-years';
const TZ = 'Australia/Sydney';
const USERS = [{ id: USER, currency_preference: 'AUD', timezone: TZ }];

const W = {
  bank: [] as BankRow[], inv: [] as InvRow[], cc: [] as CcRow[],
  sup: [] as SuperRow[], loans: [] as LoanRow[], props: [] as PropRow[],
};
const FX: Record<string, number> = { AUD: 1, USD: 1.35, GBP: 1.85 };

// ─── the fake database ───────────────────────────────────────────────────────
// Same shape as the three-year sim's, with two things it did not need: rows can be
// DELETED (compaction is the feature under test), and the history tables are read
// through a binary search on `recorded_at`. Twenty years of daily compaction is
// tens of thousands of range reads and deletes; a fake that scans the whole table
// for each of them turns a test run into a coffee break.

type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const tableOf = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};
/** Tables stored in `recorded_at` order — which is the order they are written in. */
const CHRONO = new Set(['net_worth_history', 'net_worth_item_history']);

/** What the run cost, so "performant" can be asserted rather than asserted-to. */
const stats = { pages: 0, deletes: 0, deleted: 0 };
const resetStats = () => { stats.pages = 0; stats.deletes = 0; stats.deleted = 0; };

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

/** First index whose recorded_at is >= iso (rows ascending). */
function lowerBound(rows: Row[], iso: string): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (String(rows[m].recorded_at) < iso) lo = m + 1; else hi = m; }
  return lo;
}
/** First index whose recorded_at is > iso. */
function upperBound(rows: Row[], iso: string): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (String(rows[m].recorded_at) <= iso) lo = m + 1; else hi = m; }
  return lo;
}

const sortMemo = new Map<string, Row[]>();
let dbVersion = 0;
const bumpDb = () => { dbVersion++; sortMemo.clear(); };

class FakeQuery {
  private eqs: [string, unknown][] = [];
  private neqs: [string, unknown][] = [];
  private cmps: [string, string, unknown][] = [];
  private notIn: [string, Set<string>][] = [];
  private orders: [string, boolean][] = [];
  private cap: number | null = null;
  private deleting = false;
  constructor(private table: string) {}
  select() { return this; }
  delete() { this.deleting = true; return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  neq(col: string, val: unknown) { this.neqs.push([col, val]); return this; }
  gte(col: string, val: unknown) { this.cmps.push([col, '>=', val]); return this; }
  lte(col: string, val: unknown) { this.cmps.push([col, '<=', val]); return this; }
  gt(col: string, val: unknown) { this.cmps.push([col, '>', val]); return this; }
  lt(col: string, val: unknown) { this.cmps.push([col, '<', val]); return this; }
  /** PostgREST's `not(col,'in','("a","b")')`, quoted values and all. */
  not(col: string, op: string, list: string) {
    if (op !== 'in') throw new Error(`fake supabase: not(${op}) not modelled`);
    const inner = list.replace(/^\(|\)$/g, '');
    const vals = inner ? inner.split(',').map(v => v.replace(/^"|"$/g, '')) : [];
    this.notIn.push([col, new Set(vals)]);
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) { this.orders.push([col, o?.ascending !== false]); return this; }
  limit(n: number) { this.cap = n; return this; }
  or() { return this; }
  in() { return this; }
  range(from: number, to: number) {
    stats.pages++;
    return Promise.resolve({ data: this.ordered().slice(from, to + 1), error: null });
  }
  insert(rows: Row | Row[]) {
    for (const r of ([] as Row[]).concat(rows)) tableOf(this.table).push(r);
    dbVersion++;
    return Promise.resolve({ data: null, error: null });
  }

  /** The stored slice a range filter can possibly match, found without scanning. */
  private window(src: Row[]): { rows: Row[]; lo: number; hi: number } {
    if (!CHRONO.has(this.table)) return { rows: src, lo: 0, hi: src.length };
    let lo = 0, hi = src.length;
    for (const [c, op, v] of this.cmps) {
      if (c !== 'recorded_at') continue;
      const iso = String(v);
      if (op === '>=') lo = Math.max(lo, lowerBound(src, iso));
      else if (op === '>') lo = Math.max(lo, upperBound(src, iso));
      else if (op === '<') hi = Math.min(hi, lowerBound(src, iso));
      else if (op === '<=') hi = Math.min(hi, upperBound(src, iso));
    }
    if (hi < lo) hi = lo;
    return { rows: src.slice(lo, hi), lo, hi };
  }

  private matches(r: Row): boolean {
    return this.eqs.every(([c, v]) => r[c] === v)
      && this.neqs.every(([c, v]) => r[c] !== v)
      && this.notIn.every(([c, s]) => !s.has(String(r[c])))
      && this.cmps.every(([c, op, v]) => {
        if (CHRONO.has(this.table) && c === 'recorded_at') return true; // already windowed
        const d = cmpVals(r[c], v);
        return op === '>=' ? d >= 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d < 0;
      });
  }

  private filtered(): Row[] {
    const src = liveRows(this.table) ?? tableOf(this.table);
    const { rows } = this.window(src);
    return rows.filter(r => this.matches(r));
  }

  private compare(a: Row, b: Row): number {
    for (const [col, asc] of this.orders) {
      const d = (asc ? 1 : -1) * cmpVals(a[col], b[col]);
      if (d !== 0) return d;
    }
    return 0;
  }

  private ordered(): Row[] {
    if (!this.orders.length) return this.filtered();
    // A chronological table is ALREADY in `recorded_at` order, so the commonest
    // ordering in this codebase costs a reverse rather than a sort.
    if (CHRONO.has(this.table) && this.orders[0][0] === 'recorded_at' && this.orders.length === 1) {
      const out = this.filtered();
      return this.orders[0][1] ? out : out.reverse();
    }
    const k = JSON.stringify([dbVersion, this.table, this.eqs, this.neqs, this.cmps, this.orders]);
    const hit = sortMemo.get(k);
    if (hit) return hit;
    const out = [...this.filtered()].sort((a, b) => this.compare(a, b));
    if (sortMemo.size > 32) sortMemo.clear();
    sortMemo.set(k, out);
    return out;
  }

  /** Newest/oldest-few reads walk from the right end and stop, rather than sorting. */
  private rows(): Row[] {
    if (CHRONO.has(this.table) && this.cap != null && this.orders.length === 1
        && this.orders[0][0] === 'recorded_at') {
      const src = liveRows(this.table) ?? tableOf(this.table);
      const { rows } = this.window(src);
      const asc = this.orders[0][1];
      const out: Row[] = [];
      for (let i = 0; i < rows.length && out.length < this.cap; i++) {
        const r = rows[asc ? i : rows.length - 1 - i];
        if (this.matches(r)) out.push(r);
      }
      return out;
    }
    const out = this.ordered();
    return this.cap == null ? out : out.slice(0, this.cap);
  }

  private runDelete(): { data: null; error: null } {
    const src = tableOf(this.table);
    const { lo, hi } = this.window(src);
    const keep: Row[] = [];
    let removed = 0;
    for (let i = lo; i < hi; i++) {
      if (this.matches(src[i])) removed++;
      else keep.push(src[i]);
    }
    if (removed) src.splice(lo, hi - lo, ...keep);
    stats.deletes++; stats.deleted += removed;
    bumpDb();
    return { data: null, error: null };
  }

  single() {
    const r = this.rows();
    return Promise.resolve(r.length ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } });
  }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => void) {
    resolve(this.deleting ? this.runDelete() : { data: this.rows(), error: null });
  }
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

import {
  computeNetWorth, recordNetWorthSnapshot, getAdjustedNwSeries, getItemChanges,
} from './netWorthSnapshot';
import { readPctHistory } from './netWorthPctSeries';
import { localDayKey, localBucketKey, HISTORY_PAGE } from './netWorthHistoryReader';
import {
  compactNetWorthHistory, FULL_RESOLUTION_MS, DAILY_RESOLUTION_MS,
} from './netWorthHistoryRetention';

const r2 = (x: number) => parseFloat(x.toFixed(2));

// ─── the independent oracle ──────────────────────────────────────────────────
/**
 * What the portfolio is worth, summed from the RULES rather than from the engine:
 * cash at the day's rate, a holding at units × price × the rate pinned on the row
 * (live rate for cash holdings, which carry no usable pin), super at face, property
 * at the owned share, cards and loans subtracted.
 *
 * Totalled category by category for one reason only: floating-point addition is not
 * associative, so summing the same terms in a different ORDER can land a hair either
 * side of a half-cent and round to a different cent. That is arithmetic, not
 * valuation — every rule above is still written out here independently of the code
 * under test, which is the whole point of having an oracle at all.
 */
function oracleNetWorth(): number {
  let bank = 0, inv = 0, cards = 0, sup = 0, loans = 0, prop = 0;
  for (const a of W.bank) { if (a.hidden === true) continue; bank += r2(a.balance * (FX[a.currency] ?? 1)); }
  for (const i of W.inv) {
    const pinUsable =
      i.native_currency !== 'AUD' && i.asset_type !== 'cash' &&
      i.conversion_rate != null && Number.isFinite(i.conversion_rate) &&
      i.conversion_rate > 0 && i.conversion_rate !== 1 && i.display_currency === 'AUD';
    const rate = i.native_currency === 'AUD' ? 1 : pinUsable ? i.conversion_rate! : (FX[i.native_currency] ?? 1);
    inv += r2(i.shares_owned * i.current_price * rate);
  }
  for (const c of W.cc) cards += r2(c.balance_owing * (FX[c.currency] ?? 1));
  for (const s of W.sup) if (s.include_in_net_worth !== false) sup += s.balance;
  for (const l of W.loans) if (l.include_in_net_worth !== false) loans += l.current_balance;
  for (const p of W.props) {
    if (p.include_in_net_worth === false) continue;
    const loan = p.loan_id ? W.loans.find(l => l.id === p.loan_id) : undefined;
    const netted = loan && loan.include_in_net_worth === false ? loan.current_balance : 0;
    prop += (p.current_value * p.ownership_percent) / 100 - netted;
  }
  return r2(bank + inv + sup + prop - cards - loans);
}
const liveItemCount = () =>
  W.bank.filter(b => b.hidden !== true).length + W.inv.length + W.cc.length +
  W.sup.length + W.loans.length + W.props.length;

// ─── the clock ───────────────────────────────────────────────────────────────
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2006, 0, 3, 21, 0, 0); // 08:00 Wed 4 Jan 2006, Sydney
let now = START;
const setClock = (ms: number) => { now = ms; vi.setSystemTime(new Date(ms)); };

let seed = 20260830;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const drift = (pct: number) => 1 + (rnd() - 0.5) * 2 * pct;

// ─── the run's ledger ────────────────────────────────────────────────────────
/** Every snapshot the engine took, remembered outside the database, so the
 *  compacted series can be compared with the series that was never compacted. */
interface Taken { iso: string; ms: number; value: number; items: number }
const taken: Taken[] = [];
const takenAt = new Map<string, Taken>();
let declined = 0;

async function snap(): Promise<void> {
  const before = tableOf('net_worth_history').length;
  const nw = await recordNetWorthSnapshot(USER);
  if (tableOf('net_worth_history').length === before) { declined++; return; }
  const rows = tableOf('net_worth_history');
  const iso = String(rows[rows.length - 1].recorded_at);
  const t: Taken = { iso, ms: now, value: nw.netWorth, items: nw.items.length };
  taken.push(t);
  takenAt.set(iso, t);
  // The engine's own figure is checked against the oracle on every single tick —
  // a recorded series is only worth auditing if the numbers in it were right.
  if (Math.abs(nw.netWorth - oracleNetWorth()) > 0.005) {
    throw new Error(`live ${nw.netWorth} != oracle ${oracleNetWorth()} at ${iso}`);
  }
}

function seedWorld() {
  W.bank.length = 0; W.inv.length = 0; W.cc.length = 0;
  W.sup.length = 0; W.loans.length = 0; W.props.length = 0;
  W.bank.push(
    { id: 'b-sav', name: 'Everyday Saver', balance: 62_000, currency: 'AUD', user_id: USER },
    { id: 'b-off', name: 'Offset', balance: 38_000, currency: 'AUD', user_id: USER },
    { id: 'b-usd', name: 'USD account', balance: 15_000, currency: 'USD', user_id: USER },
    { id: 'b-gbp', name: 'GBP account', balance: 9_000, currency: 'GBP', user_id: USER },
  );
  const inv = (id: string, name: string, units: number, price: number, cur: string, type: string) => {
    const rate = cur === 'AUD' ? 1 : FX[cur];
    W.inv.push({
      id, name, user_id: USER, shares_owned: units, current_price: price,
      current_value: r2(units * price), native_currency: cur, asset_type: type,
      conversion_rate: type === 'cash' ? null : rate, display_currency: 'AUD', day_change_percent: 0,
    });
  };
  inv('i-vas', 'VAS', 3_000, 62.4, 'AUD', 'stock');
  inv('i-vgs', 'VGS', 2_200, 48.9, 'AUD', 'stock');
  inv('i-cba', 'CBA', 900, 41.2, 'AUD', 'stock');
  inv('i-bhp', 'BHP', 1_400, 27.6, 'AUD', 'stock');
  inv('i-aapl', 'AAPL', 400, 71.9, 'USD', 'stock');
  inv('i-msft', 'MSFT', 300, 26.4, 'USD', 'stock');
  inv('i-brk', 'BRK.B', 60, 58.3, 'USD', 'stock');
  inv('i-lse', 'Lloyds', 5_000, 5.6, 'GBP', 'stock');
  inv('i-gold', 'Gold ETF', 800, 21.4, 'AUD', 'stock');
  inv('i-btc', 'Bitcoin', 2.5, 4_100, 'USD', 'crypto');
  inv('i-eth', 'Ethereum', 40, 180, 'USD', 'crypto');
  inv('i-usdcash', 'USD cash holding', 1, 8_000, 'USD', 'cash');
  W.cc.push(
    { id: 'c-amex', name: 'Amex', balance_owing: 3_100, currency: 'AUD', user_id: USER },
    { id: 'c-visa', name: 'Visa', balance_owing: 1_450, currency: 'AUD', user_id: USER },
  );
  W.sup.push(
    { id: 's-aus', fund_name: 'AustralianSuper', balance: 96_000, include_in_net_worth: null, user_id: USER },
    { id: 's-host', fund_name: 'HostPlus', balance: 41_000, include_in_net_worth: null, user_id: USER },
  );
  W.loans.push(
    { id: 'l-home', name: 'Home loan', current_balance: 520_000, include_in_net_worth: null, user_id: USER },
    { id: 'l-car', name: 'Car loan', current_balance: 24_000, include_in_net_worth: null, user_id: USER },
    { id: 'l-hecs', name: 'HECS', current_balance: 31_000, include_in_net_worth: null, user_id: USER },
  );
  W.props.push(
    { id: 'p-home', name: 'Home', current_value: 690_000, ownership_percent: 100,
      include_in_net_worth: null, loan_id: 'l-home', held_by: null, smsf_fund_id: null,
      super_fund_id: null, counted_in_fund_balance: null, user_id: USER },
    { id: 'p-land', name: 'Block of land', current_value: 145_000, ownership_percent: 50,
      include_in_net_worth: null, loan_id: null, held_by: null, smsf_fund_id: null,
      super_fund_id: null, counted_in_fund_balance: null, user_id: USER },
  );
}

/** Between snapshots: prices move, salary lands, cards are used, loans amortise. */
function wobble(strength: number) {
  for (const i of W.inv) {
    if (i.asset_type === 'cash') continue;
    i.current_price = r2(Math.max(0.01, i.current_price * drift(i.asset_type === 'crypto' ? 0.05 : 0.011) ** strength));
    i.current_value = r2(i.shares_owned * i.current_price);
  }
}
function ordinaryDay(day: number) {
  W.bank[0].balance = r2(W.bank[0].balance + (day % 14 === 0 ? 5_200 : -175 * drift(0.6)));
  W.cc[0].balance_owing = r2(Math.max(0, W.cc[0].balance_owing + 95 * drift(0.9) - (day % 30 === 0 ? 2_900 : 0)));
  for (const s of W.sup) s.balance = r2(s.balance * 1.00022 + 42);
  for (const l of W.loans) l.current_balance = r2(Math.max(0, l.current_balance - (l.id === 'l-home' ? 190 : 22)));
  for (const p of W.props) p.current_value = r2(p.current_value * 1.00013);
}

// ─── two decades of events, and an asset set that never stops changing ───────
const YEAR = 365;
const addInv = (id: string, name: string, units: number, price: number, cur: string, type: string) => {
  const rate = cur === 'AUD' ? 1 : FX[cur];
  W.inv.push({ id, name, user_id: USER, shares_owned: units, current_price: price,
    current_value: r2(units * price), native_currency: cur, asset_type: type,
    conversion_rate: type === 'cash' ? null : rate, display_currency: 'AUD', day_change_percent: 0 });
};
const dropInv = (id: string) => { const i = W.inv.findIndex(x => x.id === id); if (i >= 0) W.inv.splice(i, 1); };
const equities = (mult: number) => {
  for (const i of W.inv) {
    if (i.asset_type === 'cash') continue;
    i.current_price = r2(i.current_price * mult);
    i.current_value = r2(i.shares_owned * i.current_price);
  }
};

/** day → [label, mutation]. Every one of these changes what the chart must show. */
const EVENTS: Record<number, [string, () => void]> = {
  [1 * YEAR + 40]: ['investment property bought', () => {
    W.bank[0].balance = r2(W.bank[0].balance - 90_000);
    W.loans.push({ id: 'l-ip', name: 'Investment loan', current_balance: 430_000, include_in_net_worth: null, user_id: USER });
    W.props.push({ id: 'p-ip', name: 'Investment property', current_value: 505_000, ownership_percent: 100,
      include_in_net_worth: null, loan_id: 'l-ip', held_by: null, smsf_fund_id: null,
      super_fund_id: null, counted_in_fund_balance: null, user_id: USER });
  }],
  [2 * YEAR + 250]: ['the crash', () => equities(0.42)],
  [3 * YEAR + 120]: ['the recovery', () => equities(2.15)],
  [4 * YEAR + 60]: ['Lloyds sold', () => {
    const l = W.inv.find(i => i.id === 'i-lse')!;
    W.bank[3].balance = r2(W.bank[3].balance + l.shares_owned * l.current_price);
    dropInv('i-lse');
  }],
  [5 * YEAR + 15]: ['inherited share parcel', () => addInv('i-inh', 'Inherited parcel', 1_800, 240, 'USD', 'stock')],
  [6 * YEAR + 200]: ['car loan paid off', () => {
    const car = W.loans.find(l => l.id === 'l-car')!;
    W.bank[0].balance = r2(W.bank[0].balance - car.current_balance);
    W.loans.splice(W.loans.indexOf(car), 1);
  }],
  [7 * YEAR + 90]: ['three new holdings', () => {
    addInv('i-nvda', 'NVDA', 500, 39.4, 'USD', 'stock');
    addInv('i-goog', 'GOOG', 120, 52.8, 'USD', 'stock');
    addInv('i-a200', 'A200', 1_100, 96.2, 'AUD', 'stock');
  }],
  [8 * YEAR + 130]: ['FX shock', () => {
    FX.USD = 1.92; FX.GBP = 2.35;
    for (const i of W.inv) if (i.conversion_rate != null && i.native_currency !== 'AUD') i.conversion_rate = FX[i.native_currency];
  }],
  [9 * YEAR + 300]: ['investment property sold', () => {
    const p = W.props.find(x => x.id === 'p-ip')!;
    const loan = W.loans.find(l => l.id === 'l-ip')!;
    W.bank[0].balance = r2(W.bank[0].balance + p.current_value - loan.current_balance);
    W.props.splice(W.props.indexOf(p), 1);
    W.loans.splice(W.loans.indexOf(loan), 1);
  }],
  [10 * YEAR + 20]: ['crypto boom', () => {
    for (const i of W.inv) if (i.asset_type === 'crypto') { i.current_price = r2(i.current_price * 7.5); i.current_value = r2(i.shares_owned * i.current_price); }
  }],
  [10 * YEAR + 210]: ['crypto bust', () => {
    for (const i of W.inv) if (i.asset_type === 'crypto') { i.current_price = r2(i.current_price * 0.24); i.current_value = r2(i.shares_owned * i.current_price); }
  }],
  [11 * YEAR + 45]: ['two accounts opened', () => {
    W.bank.push({ id: 'b-mort', name: 'Mortgage offset 2', balance: 74_000, currency: 'AUD', user_id: USER });
    W.bank.push({ id: 'b-emrg', name: 'Emergency fund', balance: 31_000, currency: 'AUD', user_id: USER });
  }],
  [12 * YEAR + 160]: ['an account closed', () => {
    const a = W.bank.find(b => b.id === 'b-gbp')!;
    W.bank[0].balance = r2(W.bank[0].balance + a.balance * FX.GBP);
    W.bank.splice(W.bank.indexOf(a), 1);
  }],
  [13 * YEAR + 75]: ['inheritance', () => { W.bank[0].balance = r2(W.bank[0].balance + 640_000); }],
  [14 * YEAR + 100]: ['holiday house bought', () => {
    W.bank[0].balance = r2(W.bank[0].balance - 380_000);
    W.props.push({ id: 'p-hol', name: 'Holiday house', current_value: 520_000, ownership_percent: 100,
      include_in_net_worth: null, loan_id: null, held_by: null, smsf_fund_id: null,
      super_fund_id: null, counted_in_fund_balance: null, user_id: USER });
  }],
  [15 * YEAR + 240]: ['the second crash', () => equities(0.51)],
  [16 * YEAR + 80]: ['the second recovery', () => equities(1.95)],
  [17 * YEAR + 30]: ['two holdings sold', () => {
    for (const id of ['i-gold', 'i-brk']) {
      const h = W.inv.find(i => i.id === id)!;
      W.bank[0].balance = r2(W.bank[0].balance + h.shares_owned * h.current_price * (h.native_currency === 'AUD' ? 1 : FX[h.native_currency]));
      dropInv(id);
    }
  }],
  [18 * YEAR + 190]: ['super funds consolidated', () => {
    const host = W.sup.find(s => s.id === 's-host')!;
    W.sup[0].balance = r2(W.sup[0].balance + host.balance);
    W.sup.splice(W.sup.indexOf(host), 1);
  }],
  [19 * YEAR + 320]: ['a share parcel arrives 45 days before the end', () =>
    addInv('i-late', 'Late parcel', 2_000, 210, 'USD', 'stock')],
  [19 * YEAR + 60]: ['home loan paid off', () => {
    const home = W.loans.find(l => l.id === 'l-home')!;
    W.bank[0].balance = r2(W.bank[0].balance - home.current_balance);
    W.loans.splice(W.loans.indexOf(home), 1);
    const p = W.props.find(x => x.id === 'p-home')!; p.loan_id = null;
  }],
};

const DAYS = 20 * YEAR;               // twenty years, to the day
const HOURLY_TAIL = 30;               // …the last month of which runs at cron cadence
const minItems = { seen: Number.MAX_SAFE_INTEGER };
const eventLog: { day: number; label: string; before: number; after: number }[] = [];
let compactions = 0;

beforeAll(async () => {
  vi.useFakeTimers();
  seedWorld();
  setClock(START);
  await snap();

  for (let day = 1; day <= DAYS; day++) {
    const base = START + day * DAY;
    ordinaryDay(day);
    minItems.seen = Math.min(minItems.seen, liveItemCount());

    const ev = EVENTS[day];
    if (ev) {
      setClock(base);
      wobble(1); await snap();
      const before = (await computeNetWorth(USER)).netWorth;
      ev[1]();
      const after = (await computeNetWorth(USER)).netWorth;
      eventLog.push({ day, label: ev[0], before, after });
      // The cron cadence around a shock, exactly as production runs it.
      for (let h = 1; h <= 6; h++) { setClock(base + h * HOUR); wobble(0.3); await snap(); }
    } else if (day > DAYS - HOURLY_TAIL) {
      for (let h = 0; h < 24; h++) { setClock(base + h * HOUR); wobble(0.4); await snap(); }
    } else {
      for (const h of [0, 4, 8]) { setClock(base + h * HOUR); wobble(1); await snap(); }
    }

    // The retention cron. In production it runs hourly; once a day is the same
    // work, and it is what makes twenty years of this fit in a database at all.
    setClock(base + 23 * HOUR);
    await compactNetWorthHistory(USER, now);
    compactions++;
  }
  // Leave the clock at the end of the run: every assertion below reads the history
  // as the app would read it at that moment.
  setClock(START + DAYS * DAY + 23 * HOUR);
}, 900_000);

afterAll(() => { vi.useRealTimers(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('the run itself', () => {
  it('really did run twenty years at 25+ assets with a changing asset set', () => {
    expect(taken.length).toBeGreaterThan(20_000);
    expect(minItems.seen).toBeGreaterThanOrEqual(25);
    expect(eventLog.length).toBe(Object.keys(EVENTS).length);
    expect(compactions).toBe(DAYS);
  });
});

// ─── what the run left behind, read the way the app reads it ─────────────────
const totalsTable = () => tableOf('net_worth_history').filter(r => r.user_id === USER);
const itemsTable = () => tableOf('net_worth_item_history').filter(r => r.user_id === USER);
const dayOf = (iso: string) => localDayKey(iso, TZ);
const monthOf = (iso: string) => localBucketKey(iso, TZ, 'month');

/** The series the chart WOULD have drawn if nothing had ever been deleted: one
 *  point per local day, the last reading of that day. Built from this file's own
 *  record of every snapshot taken, never from the database. */
function uncompactedDayCloses(): Map<string, Taken> {
  const byDay = new Map<string, Taken>();
  for (const t of taken) byDay.set(dayOf(t.iso), t); // ascending ⇒ last wins
  return byDay;
}
function groupTaken(key: (iso: string) => string): Map<string, Taken[]> {
  const out = new Map<string, Taken[]>();
  for (const t of taken) {
    const k = key(t.iso);
    const list = out.get(k);
    if (list) list.push(t); else out.set(k, [t]);
  }
  return out;
}

describe('twenty years of readings, and what survived them', () => {
  it('never invents a value: every retained row is a reading really taken, unchanged', () => {
    const wrong = totalsTable().filter(r => {
      const t = takenAt.get(String(r.recorded_at));
      return !t || Math.abs(Number(r.total_value) - t.value) > 0.005;
    });
    expect(wrong.map(r => r.recorded_at)).toEqual([]);
  });

  it('keeps the two tables in lockstep — no total without its breakdown', () => {
    const totals = new Set(totalsTable().map(r => String(r.recorded_at)));
    const items = new Set(itemsTable().map(r => String(r.recorded_at)));
    // Every item snapshot has its total…
    expect([...items].filter(i => !totals.has(i))).toEqual([]);
    // …and every total has its items (no snapshot in this run is item-less).
    expect([...totals].filter(t => !items.has(t))).toEqual([]);
  });

  it('collapses two decades into a number of rows a request can actually return', () => {
    expect(totalsTable().length).toBeLessThan(HISTORY_PAGE * 3);
    expect(taken.length / totalsTable().length).toBeGreaterThan(8); // ≥8× compression
  });

  it('holds the full-resolution window at full resolution', () => {
    const cutoff = now - FULL_RESOLUTION_MS;
    const kept = taken.filter(t => t.ms >= cutoff).map(t => t.iso);
    const have = new Set(totalsTable().map(r => String(r.recorded_at)));
    expect(kept.filter(iso => !have.has(iso))).toEqual([]);
    expect(kept.length).toBeGreaterThan(300); // a fortnight of hourly readings
  });

  it('keeps one bucket per day for the year-plus behind that', () => {
    const from = now - DAILY_RESOLUTION_MS, to = now - FULL_RESOLUTION_MS;
    const days = new Set(taken.filter(t => t.ms >= from && t.ms < to).map(t => dayOf(t.iso)));
    const have = new Set(totalsTable().map(r => dayOf(String(r.recorded_at))));
    expect([...days].filter(d => !have.has(d))).toEqual([]);
    expect(days.size).toBeGreaterThan(370);
  });

  it('keeps one bucket per month for everything older', () => {
    const to = now - DAILY_RESOLUTION_MS;
    const months = new Set(taken.filter(t => t.ms < to).map(t => monthOf(t.iso)));
    const have = new Set(totalsTable().map(r => monthOf(String(r.recorded_at))));
    expect([...months].filter(m => !have.has(m))).toEqual([]);
    expect(months.size).toBeGreaterThan(220); // ~19 years of months
  });

  it('preserves the highest and lowest points the chart ever DREW in each month', () => {
    // The two grains cascade: a day is reduced to its close long before its month is
    // reduced at all, so a month's high and low are the extremes of its day CLOSES —
    // not of every reading ever taken inside it. That is the right extreme to keep,
    // because a day close is exactly what the chart drew for that day: every peak and
    // trough a user could ever have SEEN in a month is still there to see. What is
    // gone is the spike that came and went inside one day, which no view but the
    // last-24-hours one has drawn since the fortnight it happened in.
    const to = now - DAILY_RESOLUTION_MS;
    const closes = uncompactedDayCloses();
    const drawnByMonth = new Map<string, Taken[]>();
    for (const t of closes.values()) {
      const m = monthOf(t.iso);
      (drawnByMonth.get(m) ?? drawnByMonth.set(m, []).get(m)!).push(t);
    }
    const keptByMonth = new Map<string, number[]>();
    for (const r of totalsTable()) {
      const m = monthOf(String(r.recorded_at));
      (keptByMonth.get(m) ?? keptByMonth.set(m, []).get(m)!).push(Number(r.total_value));
    }
    const off: string[] = [];
    for (const [month, list] of drawnByMonth) {
      if (list[list.length - 1].ms >= to) continue; // still at daily grain
      const kept = keptByMonth.get(month) ?? [];
      const hi = Math.max(...list.map(t => t.value)), lo = Math.min(...list.map(t => t.value));
      if (Math.abs(Math.max(...kept) - hi) > 0.005) off.push(`${month} high ${Math.max(...kept)} != ${hi}`);
      if (Math.abs(Math.min(...kept) - lo) > 0.005) off.push(`${month} low ${Math.min(...kept)} != ${lo}`);
    }
    expect(off).toEqual([]);
    expect(drawnByMonth.size).toBeGreaterThan(220);
  });

  it('keeps a compacted month\'s crash visible, not flattened into its close', () => {
    // The month equities halved, nineteen years ago. Its close says little; its low
    // is the event. Both are still in the history, and both are still on the chart.
    const crash = eventLog.find(e => e.label === 'the crash')!;
    const month = monthOf(new Date(START + crash.day * DAY).toISOString());
    const kept = totalsTable()
      .filter(r => monthOf(String(r.recorded_at)) === month)
      .map(r => Number(r.total_value));
    expect(kept.length).toBeGreaterThanOrEqual(2);
    // The month still holds a reading from before the crash and one from after it,
    // so the fall is on the chart rather than averaged out of existence.
    expect(Math.max(...kept)).toBeGreaterThan(crash.before * 0.98);
    expect(Math.min(...kept)).toBeLessThan(crash.after * 1.02);
    expect((Math.max(...kept) - Math.min(...kept)) / Math.max(...kept)).toBeGreaterThan(0.1);
  });

  it('preserves every compacted month\'s close', () => {
    const to = now - DAILY_RESOLUTION_MS;
    const trueByMonth = groupTaken(monthOf);
    const have = new Set(totalsTable().map(r => String(r.recorded_at)));
    const missing: string[] = [];
    for (const [month, list] of trueByMonth) {
      const close = list[list.length - 1];
      if (close.ms >= to) continue;
      if (!have.has(close.iso)) missing.push(`${month} close ${close.iso}`);
    }
    expect(missing).toEqual([]);
  });

  it('pins the first reading ever taken, so no percentage is ever re-based', () => {
    const rows = totalsTable();
    expect(String(rows[0].recorded_at)).toBe(taken[0].iso);
    expect(Number(rows[0].total_value)).toBeCloseTo(taken[0].value, 2);
  });
});

describe('the Overview chart, after twenty years', () => {
  it('All Time reaches today and ends on the live net worth', async () => {
    resetStats();
    const all = await readPctHistory(USER, 'all', now);
    const live = await computeNetWorth(USER);
    const last = all.points[all.points.length - 1];
    expect(all.truncated).toBe(false);
    expect(now - new Date(last.recorded_at).getTime()).toBeLessThan(2 * HOUR);
    expect(last.value).toBeCloseTo(live.netWorth, 2);
  });

  it('All Time still starts at the first reading, twenty years back', async () => {
    const all = await readPctHistory(USER, 'all', now);
    expect(all.points[0].recorded_at).toBe(taken[0].iso);
    expect(all.points[0].pct).toBe(0);
    const span = new Date(all.points[all.points.length - 1].recorded_at).getTime()
      - new Date(all.points[0].recorded_at).getTime();
    expect(span / (365 * DAY)).toBeGreaterThan(19.9);
  });

  it('draws only values the portfolio really had, at instants it really had them', async () => {
    const all = await readPctHistory(USER, 'all', now);
    const wrong = all.points.filter(p => {
      const t = takenAt.get(p.recorded_at);
      return !t || Math.abs(t.value - p.value) > 0.005;
    });
    expect(wrong).toEqual([]);
  });

  it('draws EXACTLY the line it would have drawn uncompacted, for the last year', async () => {
    // Inside the daily tier the compacted chart is not merely similar to the
    // uncompacted one — it is identical. The chart reduces a day to its last
    // reading, and the last reading of a day is precisely what compaction keeps.
    const all = await readPctHistory(USER, 'all', now);
    const drawn = new Map(all.points.map(p => [dayOf(p.recorded_at), p]));
    const truth = uncompactedDayCloses();
    const from = now - DAILY_RESOLUTION_MS;
    const off: string[] = [];
    for (const [day, t] of truth) {
      if (t.ms < from) continue;
      const p = drawn.get(day);
      if (!p) { off.push(`${day} missing`); continue; }
      if (p.recorded_at !== t.iso) off.push(`${day} drew ${p.recorded_at}, close was ${t.iso}`);
      if (Math.abs(p.value - t.value) > 0.005) off.push(`${day} drew ${p.value}, close was ${t.value}`);
    }
    expect(off).toEqual([]);
  });

  it('leaves no month of the older history without a point', async () => {
    const all = await readPctHistory(USER, 'all', now);
    const drawn = new Set(all.points.map(p => monthOf(p.recorded_at)));
    const months = new Set(taken.map(t => monthOf(t.iso)));
    expect([...months].filter(m => !drawn.has(m))).toEqual([]);
  });

  it('answers All Time out of a handful of pages, not hundreds', async () => {
    resetStats();
    await readPctHistory(USER, 'all', now);
    expect(stats.pages).toBeLessThanOrEqual(4);
  });

  it('the windowed timeframes are unaffected and still current', async () => {
    const live = await computeNetWorth(USER);
    for (const tf of ['daily', 'weekly', 'monthly', 'yearly']) {
      resetStats();
      const h = await readPctHistory(USER, tf, now);
      expect(h.truncated).toBe(false);
      expect(h.points.length).toBeGreaterThan(1);
      const last = h.points[h.points.length - 1];
      expect(last.value).toBeCloseTo(live.netWorth, 2);
      // One page. A windowed question reads its window, not twenty years.
      expect(stats.pages).toBe(1);
    }
  });
});

describe('the movers, after twenty years', () => {
  it('reports every live item at what it is really worth right now', async () => {
    const live = await computeNetWorth(USER);
    const { items } = await getItemChanges(USER, 'yearly');
    const byKey = new Map(items.map(i => [`${i.item_type}:${i.item_id}`, i]));
    const off: string[] = [];
    for (const it of live.items) {
      const m = byKey.get(`${it.item_type}:${it.item_id}`);
      if (!m) { off.push(`${it.item_type}:${it.item_id} missing`); continue; }
      if (Math.abs(m.current_value - it.value) > 0.005) off.push(`${it.name} ${m.current_value} != ${it.value}`);
    }
    expect(off).toEqual([]);
  });

  it('measures a year\'s movement from a year ago, not from a stale row', async () => {
    const { items } = await getItemChanges(USER, 'yearly');
    // The home is worth measurably more than it was a year ago: 0.013%/day compounded.
    const home = items.find(i => i.item_id === 'p-home')!;
    const prop = W.props.find(p => p.id === 'p-home')!;
    const expected = prop.current_value / Math.pow(1.00013, 365);
    expect(home.start_value).toBeCloseTo(expected, -2);
    expect(home.change).toBeGreaterThan(0);
  });

  it('reads its window, not its history', async () => {
    // Per-item rows are the item count times the snapshot count, so these caps are
    // set by the WINDOW's cadence and nothing else: a day of hourly readings on 26
    // items is ~624 rows, a week ~4,400, a month ~10,000 — and twenty years of
    // history behind them adds not one row to any of the three.
    const caps: Record<string, number> = { daily: 1, weekly: 8, monthly: 12 };
    const over: string[] = [];
    for (const [tf, cap] of Object.entries(caps)) {
      resetStats();
      await getItemChanges(USER, tf);
      if (stats.pages > cap) over.push(`${tf}: ${stats.pages} pages > ${cap}`);
    }
    expect(over).toEqual([]);
  });

  it('can still answer the all-time movers question at all', async () => {
    resetStats();
    const { items } = await getItemChanges(USER, 'all');
    const live = await computeNetWorth(USER);
    expect(items.length).toBeGreaterThanOrEqual(live.items.length);
    // Items that left over twenty years are reported as removed, not as losses.
    expect(items.some(i => i.removed)).toBe(true);
  });
});

describe('the adjusted series, after twenty years', () => {
  it('reaches today and reconciles with the live net worth', async () => {
    resetStats();
    const live = await computeNetWorth(USER);
    const adj = await getAdjustedNwSeries(USER, undefined, live.items,
      live.excludedItems.map(it => `${it.item_type}:${it.item_id}`));
    expect(adj.truncated).toBe(false);
    const last = adj.points[adj.points.length - 1];
    expect(now - new Date(last.recorded_at).getTime()).toBeLessThan(2 * HOUR);
    expect(last.activeValue).toBeCloseTo(live.netWorth, 2);
  });

  it('has a point wherever the raw series has one', async () => {
    const live = await computeNetWorth(USER);
    const adj = await getAdjustedNwSeries(USER, undefined, live.items);
    const raw = await readPctHistory(USER, 'all', now);
    const adjAt = new Set(adj.points.map(p => p.recorded_at));
    expect(raw.points.filter(p => !adjAt.has(p.recorded_at))).toEqual([]);
  });

  it('still neutralises an item that appeared inside the compacted history', async () => {
    // A $560K parcel arrived 45 days before the end. Raw net worth jumps by it;
    // the organic line must not, because nothing was earned — capital was added.
    const live = await computeNetWorth(USER);
    const adj = await getAdjustedNwSeries(USER, now - 60 * DAY, live.items);
    // The mutation lands after that day's first snapshot, so the parcel first shows
    // up in the hourly burst that follows it.
    const arrivalMs = START + (19 * YEAR + 320) * DAY;
    const before = adj.points.filter(p => new Date(p.recorded_at).getTime() <= arrivalMs).pop()!;
    const after = adj.points.find(p => new Date(p.recorded_at).getTime() > arrivalMs)!;
    const parcel = W.inv.find(i => i.id === 'i-late')!;
    const parcelValue = parcel.shares_owned * parcel.current_price * FX.USD;
    expect(after.activeValue - before.activeValue).toBeGreaterThan(parcelValue * 0.5);
    // …while the organic movement across the same step is ordinary.
    expect(Math.abs(after.organic - before.organic)).toBeLessThan(parcelValue * 0.1);
  });

  it('answers a windowed adjusted question out of a few pages', async () => {
    resetStats();
    const live = await computeNetWorth(USER);
    await getAdjustedNwSeries(USER, now - 30 * DAY, live.items);
    // A fortnight of hourly readings plus a fortnight of daily ones, on 26 items.
    expect(stats.pages).toBeLessThanOrEqual(12);
  });
});

describe('running the retention cron again', () => {
  it('drops nothing more — compaction is idempotent', async () => {
    const before = totalsTable().length;
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await compactNetWorthHistory(USER, now));
    for (const r of runs) expect(r.dropped).toBe(0);
    expect(totalsTable().length).toBe(before);
  });

  it('costs a handful of queries when there is nothing to do', async () => {
    resetStats();
    await compactNetWorthHistory(USER, now);
    expect(stats.pages).toBeLessThanOrEqual(8);
    expect(stats.deleted).toBe(0);
  });
});

describe('the report', () => {
  it('prints the measured numbers', async () => {
    const totals = totalsTable().length, items = itemsTable().length;
    resetStats();
    const all = await readPctHistory(USER, 'all', now);
    const allPages = stats.pages;
    resetStats();
    const live = await computeNetWorth(USER);
    const adj = await getAdjustedNwSeries(USER, undefined, live.items);
    const adjPages = stats.pages;
    resetStats();
    await getItemChanges(USER, 'daily');
    const moverPages = stats.pages;
    const years = (now - taken[0].ms) / (365 * DAY);
    const writtenItems = taken.reduce((n, t) => n + t.items, 0);
    const fresh = totalsTable().filter(r => Date.parse(String(r.recorded_at)) >= now - FULL_RESOLUTION_MS).length;
    const lines = [
      `span ${years.toFixed(1)} years, ${taken.length} snapshots taken, ${declined} declined`,
      `assets: ${liveItemCount()} live now, never fewer than ${minItems.seen}, ${eventLog.length} structural/market events`,
      `totals: ${taken.length} written → ${totals} retained (${(taken.length / totals).toFixed(1)}× compression)`,
      `item rows: ${writtenItems} written → ${items} retained (${(writtenItems / items).toFixed(1)}× compression)`,
      `grain: ${fresh} readings in the last fortnight, ${new Set(totalsTable().map(r => dayOf(String(r.recorded_at)))).size} days, ${new Set(totalsTable().map(r => monthOf(String(r.recorded_at)))).size} months`,
      `all-time chart: ${all.points.length} points, ${allPages} page read(s), truncated=${all.truncated}`,
      `adjusted series: ${adj.points.length} points, ${adjPages} page read(s), truncated=${adj.truncated}`,
      `a day's movers: ${moverPages} page read(s) — the same as on day one`,
      `newest point is ${((now - new Date(all.points[all.points.length - 1].recorded_at).getTime()) / HOUR).toFixed(2)}h old`,
      `live net worth ${live.netWorth.toFixed(2)}, oracle ${oracleNetWorth().toFixed(2)}`,
    ];
    for (const l of lines) console.log('[MEASURED]', l);
    expect(lines.length).toBe(10);
  });
});

// ─── the history that already exists ─────────────────────────────────────────
/**
 * Everything above compacts as it goes, one day at a time, because that is what the
 * cron will do from the moment this ships. But every user who is already recording
 * has YEARS of uncompacted rows behind them, written before the policy existed, and
 * a compaction that only ever looks at the day that just aged out would never reach
 * any of it.
 *
 * So the backlog gets its own user: two years of history dropped in whole, with no
 * compaction ever having run, and then the cron started. The bar is that it drains
 * on its own — no cursor, no migration, no manual backfill — while never once
 * touching the newest rows, and that the line the chart draws survives the drain.
 */
const OLD = 'u-backlog';
const backlog = {
  firstIso: '', dayCloses: new Map<string, number>(), byIso: new Map<string, number>(),
  snapshots: 0, itemRows: 0,
};

function seedBacklog(nowMs: number) {
  USERS.push({ id: OLD, currency_preference: 'AUD', timezone: TZ });
  const totals = tableOf('net_worth_history');
  const items = tableOf('net_worth_item_history');
  const startMs = nowMs - 730 * DAY;
  let value = 240_000;
  for (let d = 0; d < 730; d++) {
    // The last month at cron cadence, everything before it three times a day —
    // the shape a real history has.
    const hours = d >= 700 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : [1, 9, 17];
    for (const h of hours) {
      const ms = startMs + d * DAY + h * HOUR;
      if (ms > nowMs) continue;
      value = r2(value * drift(0.004) + 60);
      const iso = new Date(ms).toISOString();
      totals.push({ user_id: OLD, recorded_at: iso, total_value: value, recorded_date: iso.split('T')[0] });
      for (let n = 0; n < 8; n++) {
        items.push({ user_id: OLD, recorded_at: iso, item_type: 'bank', item_id: `o-${n}`,
          name: `Account ${n}`, value: r2(value / 8), is_debt: false });
        backlog.itemRows++;
      }
      backlog.snapshots++;
      if (!backlog.firstIso) backlog.firstIso = iso;
      backlog.byIso.set(iso, value);
      backlog.dayCloses.set(localDayKey(iso, TZ), value);
    }
  }
  // The fake stores history in recorded_at order; two users interleaved need one sort.
  totals.sort((a, b) => String(a.recorded_at) < String(b.recorded_at) ? -1 : 1);
  items.sort((a, b) => String(a.recorded_at) < String(b.recorded_at) ? -1 : 1);
  bumpDb();
}

describe('a history that was never compacted, meeting the policy for the first time', () => {
  let runs = 0;
  let beforeRows = 0;

  beforeAll(async () => {
    seedBacklog(now);
    beforeRows = tableOf('net_worth_history').filter(r => r.user_id === OLD).length;
    // The cron, hour after hour. Each pass is bounded; the question is whether the
    // bound converges without anyone having to go and finish the job by hand.
    for (let i = 0; i < 12; i++) {
      const res = await compactNetWorthHistory(OLD, now);
      runs++;
      if (res.dropped === 0) break;
    }
  }, 120_000);

  it('drains a two-year backlog on its own, in a handful of bounded passes', () => {
    const after = tableOf('net_worth_history').filter(r => r.user_id === OLD).length;
    expect(beforeRows).toBeGreaterThan(2_500);
    expect(after).toBeLessThan(beforeRows / 2);
    expect(runs).toBeLessThanOrEqual(12);
    console.log('[MEASURED] backlog:', beforeRows, '→', after, 'rows in', runs, 'passes');
  });

  it('reaches a fixed point and then stops working', async () => {
    const res = await compactNetWorthHistory(OLD, now);
    expect(res.dropped).toBe(0);
  });

  it('never touched the newest rows while it was draining', () => {
    const rows = tableOf('net_worth_history').filter(r => r.user_id === OLD);
    const newest = rows[rows.length - 1];
    const recent = rows.filter(r => Date.parse(String(r.recorded_at)) >= now - FULL_RESOLUTION_MS);
    expect(now - Date.parse(String(newest.recorded_at))).toBeLessThan(2 * HOUR);
    expect(recent.length).toBeGreaterThan(300); // the fortnight is still hourly
  });

  it('kept the first reading, so the percentages still mean what they meant', () => {
    const rows = tableOf('net_worth_history').filter(r => r.user_id === OLD);
    expect(String(rows[0].recorded_at)).toBe(backlog.firstIso);
  });

  it('draws only readings that were really taken, and never a value that was not', async () => {
    const h = await readPctHistory(OLD, 'all', now);
    const off = h.points.filter(p => {
      const real = backlog.byIso.get(p.recorded_at);
      return real == null || Math.abs(real - p.value) > 0.005;
    });
    expect(off).toEqual([]);
    expect(h.truncated).toBe(false);
  });

  it('draws the same line it drew before, day for day, inside the daily tier', async () => {
    // Older than that the line is the monthly summary, whose points are the month's
    // close and its two extremes — real readings, but deliberately not every day's.
    const h = await readPctHistory(OLD, 'all', now);
    const drawn = new Map(h.points.map(p => [dayOf(p.recorded_at), p.value]));
    const off: string[] = [];
    for (const [day, close] of backlog.dayCloses) {
      if (Date.parse(`${day}T12:00:00Z`) < now - DAILY_RESOLUTION_MS) continue;
      const v = drawn.get(day);
      if (v == null) { off.push(`${day} missing`); continue; }
      if (Math.abs(v - close) > 0.005) off.push(`${day} drew ${v}, closed at ${close}`);
    }
    expect(off).toEqual([]);
  });

  it('summarises the compacted years by month rather than dropping them', async () => {
    const h = await readPctHistory(OLD, 'all', now);
    const drawn = new Set(h.points.map(p => monthOf(p.recorded_at)));
    const months = new Set([...backlog.dayCloses.keys()].map(d => d.slice(0, 7)));
    expect([...months].filter(m => !drawn.has(m))).toEqual([]);
  });

  it('left no item row behind whose snapshot is gone', () => {
    const totals = new Set(tableOf('net_worth_history').filter(r => r.user_id === OLD).map(r => String(r.recorded_at)));
    const strays = tableOf('net_worth_item_history')
      .filter(r => r.user_id === OLD && !totals.has(String(r.recorded_at)));
    expect(strays.length).toBe(0);
  });
});
