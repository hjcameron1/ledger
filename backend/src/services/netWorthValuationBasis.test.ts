/**
 * ONE VALUATION BASIS, ACROSS EVERY TIER.
 *
 * A holding is worth `units × current price × FX`, rounded ONCE at the end. That
 * sentence has to be true in four places at the same time or the app contradicts
 * itself in ways no screen can explain:
 *
 *   • the Investments page          (routes/investments enrichInvestment)
 *   • the live Net Worth headline   (frontend calculateNetWorth → netWorthFrom)
 *   • the Overview breakdown        (computeNetWorth here, and its items)
 *   • the recorded snapshot history (the same computeNetWorth, written down)
 *
 * Two bases have been wrong here before, and both surfaced the same way — a
 * "change today" that was partly just two methods disagreeing, which no item in
 * the breakdown could account for. First the snapshot converted at a LIVE rate
 * while the screen used the rate pinned on the row. Then it multiplied the
 * `current_value` STAMP — already rounded to native cents, and only rewritten by
 * the paths that remember to — instead of deriving the value from the units and
 * the price the way every screen does.
 *
 * The cases below are written out, and the SAME numbers are written out again in
 * `frontend/src/stress/valuationBasis.test.ts`. A change to either tier that
 * moves an answer fails on its own side, loudly, instead of quietly opening a
 * gap between the headline and the history behind it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const tableOf = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};

/** Every write the snapshot writer makes, so "history is append-only" is provable. */
const writes: { table: string; op: string }[] = [];

class FakeQuery {
  private eqs: [string, unknown][] = [];
  private cmps: [string, string, unknown][] = [];
  private asc = true;
  private orderCol = 'recorded_at';
  private cap: number | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  gte(col: string, val: unknown) { this.cmps.push([col, '>=', val]); return this; }
  lte(col: string, val: unknown) { this.cmps.push([col, '<=', val]); return this; }
  gt(col: string, val: unknown) { this.cmps.push([col, '>', val]); return this; }
  lt(col: string, val: unknown) { this.cmps.push([col, '<', val]); return this; }
  order(col: string, o?: { ascending?: boolean }) {
    this.orderCol = col; this.asc = o?.ascending !== false; return this;
  }
  limit(n: number) { this.cap = n; return this; }
  /** Transfer legs are irrelevant here — no transactions are seeded. */
  or() { return this; }
  in() { return this; }
  range(from: number, to: number) {
    return Promise.resolve({ data: this.rows().slice(from, to + 1), error: null });
  }
  insert(rows: Row | Row[]) {
    writes.push({ table: this.table, op: 'insert' });
    for (const r of ([] as Row[]).concat(rows)) tableOf(this.table).push(r);
    return Promise.resolve({ data: null, error: null });
  }
  update() { writes.push({ table: this.table, op: 'update' }); return this; }
  delete() { writes.push({ table: this.table, op: 'delete' }); return this; }
  private rows(): Row[] {
    const cmp = (a: unknown, b: unknown) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    let out = tableOf(this.table)
      .filter(r => this.eqs.every(([c, v]) => r[c] === v))
      .filter(r => this.cmps.every(([c, op, v]) => {
        const d = cmp(r[c], v);
        return op === '>=' ? d >= 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d < 0;
      }));
    out = [...out].sort((a, b) => (this.asc ? 1 : -1) * cmp(a[this.orderCol], b[this.orderCol]));
    return this.cap == null ? out : out.slice(0, this.cap);
  }
  single() {
    const rows = this.rows();
    return Promise.resolve(rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } });
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

/** Fixed quotes, so a difference in the ANSWER is never a difference in the rate.
 *  The rate RULES themselves are tested in investmentValue.test.ts. */
const LIVE: Record<string, number> = { USD: 1.9, GBP: 2.4, AUD: 1 };
vi.mock('./currencyService', () => ({
  convertAmount: (amount: number, from: string) =>
    Promise.resolve({ converted: parseFloat((amount * (LIVE[from] ?? 1)).toFixed(2)), rate: LIVE[from] ?? 1 }),
  convertBalance: (amount: number, from: string) =>
    Promise.resolve({ converted: parseFloat((amount * (LIVE[from] ?? 1)).toFixed(2)), rate: LIVE[from] ?? 1 }),
  getRate: (from: string) => Promise.resolve(LIVE[from] ?? 1),
  getRateOn: (from: string) => Promise.resolve(LIVE[from] ?? 1),
}));

import { computeNetWorth, recordNetWorthSnapshot, getItemChanges } from './netWorthSnapshot';
import { investmentValueInPreferred, investmentValueNative } from './investmentValue';
// The Investments page's own enrichment — the fourth tier. Imported from the
// route it actually serves, not re-implemented, so this compares the real thing.
import { enrichInvestment } from '../routes/investments';

const USER = 'u-basis';
const round2 = (x: number) => parseFloat(x.toFixed(2));

/** How the value used to be reached: the native stamp, rounded, then converted. */
const stampBasis = (units: number, price: number, rate: number) => round2(round2(units * price) * rate);

interface Case {
  id: string; name: string; units: number; price: number; rate: number; native: string;
  /** units × price × rate, rounded once. */ canonical: number;
  /** What the old `current_value × rate` produced for the same holding. */ stamp: number;
}

/**
 * MIRRORED IN frontend/src/stress/valuationBasis.test.ts — same holdings, same
 * expected figures. Three of the four are cases where rounding the native value
 * FIRST gives a different answer, which is the whole point.
 */
const CASES: Case[] = [
  { id: 'i-usd', name: 'US tech', units: 634.4256, price: 211.97, rate: 1.7693, native: 'USD', canonical: 237_934.04, stamp: 237_934.03 },
  { id: 'i-gbp', name: 'UK insurer', units: 2151.37, price: 414.29, rate: 1.1676, native: 'GBP', canonical: 1_040_671.46, stamp: 1_040_671.47 },
  { id: 'i-usd2', name: 'US index', units: 2906.6596, price: 201.36, rate: 1.9774, native: 'USD', canonical: 1_157_342.51, stamp: 1_157_342.52 },
  { id: 'i-aud', name: 'ASX index', units: 4200, price: 96.31, rate: 1, native: 'AUD', canonical: 404_502, stamp: 404_502 },
];

/** A holding row as the database holds it, stamp and all. */
const row = (c: Case, o: Row = {}): Row => ({
  id: c.id, name: c.name, user_id: USER,
  shares_owned: c.units, current_price: c.price,
  // The stamp the price cron last wrote: the native value, rounded to cents.
  current_value: round2(c.units * c.price),
  native_currency: c.native, asset_type: 'stock',
  conversion_rate: c.native === 'AUD' ? 1 : c.rate,
  display_currency: 'AUD',
  cost_basis: 1, cost_basis_currency: 'AUD',
  ...o,
});

function seed(investments: Row[]): void {
  db.clear();
  writes.length = 0;
  tableOf('users').push({ id: USER, currency_preference: 'AUD' });
  for (const r of investments) tableOf('investments').push(r);
}

beforeEach(() => { db.clear(); writes.length = 0; });

// ═════════════════════════════════════════════════════════════════════════════
//  The arithmetic itself
// ═════════════════════════════════════════════════════════════════════════════

describe('what a holding is worth', () => {
  it('is units × price × rate, rounded once at the end', async () => {
    for (const c of CASES) {
      expect(investmentValueNative(row(c))).toBeCloseTo(c.units * c.price, 6);
      expect(await investmentValueInPreferred(row(c), 'AUD')).toBe(c.canonical);
    }
  });

  it('is NOT the native value rounded first and converted afterwards', () => {
    // Three of the four differ by a cent. If this ever stops being true the
    // cases have gone stale and the test below proves nothing.
    const differing = CASES.filter(c => stampBasis(c.units, c.price, c.rate) !== c.canonical);
    expect(differing.length).toBeGreaterThanOrEqual(3);
    for (const c of CASES) expect(stampBasis(c.units, c.price, c.rate)).toBe(c.stamp);
  });

  it('reads through a `current_value` stamp that has gone stale', async () => {
    const c = CASES[0];
    // Half the units were sold and the price cron has not run since, so the
    // stamp still says what the whole holding used to be worth.
    const stale = row(c, { shares_owned: c.units / 2 });
    expect(await investmentValueInPreferred(stale, 'AUD')).toBe(round2((c.units / 2) * c.price * c.rate));
  });

  it('falls back to the stamp only when the row carries no units and price', async () => {
    const c = CASES[0];
    const bare = { native_currency: 'USD', asset_type: 'stock', conversion_rate: c.rate, display_currency: 'AUD', current_value: 1_000 };
    expect(await investmentValueInPreferred(bare, 'AUD')).toBe(round2(1_000 * c.rate));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The tiers agree
// ═════════════════════════════════════════════════════════════════════════════

describe('every tier values the portfolio the same way', () => {
  it('the snapshot total is the sum of the canonical per-holding figures', async () => {
    seed(CASES.map(c => row(c)));
    const nw = await computeNetWorth(USER);
    expect(nw.investments).toBeCloseTo(CASES.reduce((t, c) => t + c.canonical, 0), 2);
  });

  it('the snapshot ITEM for each holding is that holding’s canonical value', async () => {
    seed(CASES.map(c => row(c)));
    const nw = await computeNetWorth(USER);
    for (const c of CASES) {
      const item = nw.items.find(i => i.item_type === 'investment' && i.item_id === c.id);
      expect(item, `no snapshot item for ${c.id}`).toBeTruthy();
      expect(item!.value).toBe(c.canonical);
    }
  });

  it('and none of them is the figure the old stamp basis produced', async () => {
    seed(CASES.map(c => row(c)));
    const nw = await computeNetWorth(USER);
    for (const c of CASES.filter(x => x.canonical !== x.stamp)) {
      const item = nw.items.find(i => i.item_id === c.id)!;
      expect(item.value).not.toBe(c.stamp);
    }
  });

  it('a sale that the price cron has not caught up with is worth what is LEFT', async () => {
    const c = CASES[0];
    // The stamp says the whole holding; the row says half the units are gone.
    seed([row(c, { shares_owned: c.units / 2 })]);
    const nw = await computeNetWorth(USER);
    expect(nw.investments).toBeCloseTo(round2((c.units / 2) * c.price * c.rate), 2);
    // The stale stamp would have carried the sold half in net worth forever.
    expect(nw.investments).not.toBeCloseTo(c.canonical, 2);
  });

  it('the Investments page shows exactly what the snapshot records', async () => {
    seed(CASES.map(c => row(c)));
    const nw = await computeNetWorth(USER);
    for (const c of CASES) {
      const shown = await enrichInvestment(row(c), 'AUD');
      const recorded = nw.items.find(i => i.item_id === c.id)!;
      expect(shown.display_value).toBe(c.canonical);
      expect(shown.display_value).toBe(recorded.value);
    }
  });

  it("the movers list measures against the same base the series is recorded on", async () => {
    seed(CASES.map(c => row(c, { day_change_percent: 1 })));
    // One recorded point, so the daily window has a baseline to measure from.
    await recordNetWorthSnapshot(USER);
    const { items } = await getItemChanges(USER, 'daily');
    for (const c of CASES) {
      const item = items.find(i => i.item_type === 'investment' && i.item_id === c.id);
      expect(item, `no mover row for ${c.id}`).toBeTruthy();
      expect(item!.current_value).toBe(c.canonical);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  History is preserved, not restated
// ═════════════════════════════════════════════════════════════════════════════

describe('recorded history', () => {
  it('is only ever appended to — a snapshot never rewrites what was recorded before', async () => {
    seed(CASES.map(c => row(c)));
    await recordNetWorthSnapshot(USER);
    await recordNetWorthSnapshot(USER);

    const touched = writes.filter(w => w.table.startsWith('net_worth'));
    expect(touched.length).toBeGreaterThan(0);
    // Not one update, not one delete. Points taken on the old basis keep the
    // basis they were taken on: the series carries one small step at the
    // changeover rather than a silent restatement of what the user was shown.
    expect(touched.filter(w => w.op !== 'insert')).toEqual([]);
  });

  it('records the canonical figure from the first snapshot after the change', async () => {
    seed(CASES.map(c => row(c)));
    await recordNetWorthSnapshot(USER);
    const recorded = tableOf('net_worth_item_history')
      .filter(r => r.item_type === 'investment');
    for (const c of CASES) {
      const r = recorded.find(x => x.item_id === c.id)!;
      expect(r.value).toBe(c.canonical);
    }
  });
});
