/**
 * AUTOMATIC SPLIT DETECTION.
 *
 * The events here are real and were read off Yahoo's v8 chart API on
 * 30 August 2026: Apple's 4:1 of 31 August 2020, Toyota's 5:1 of
 * 29 September 2021, NVIDIA's 4:1 and 10:1, Sirius XM's 1-for-10 consolidation
 * of 10 September 2024, General Electric's 1-for-8 of 2 August 2021 — and, in
 * the same field and the same shape, GE's spin-off adjustment factors of
 * 1281:1000 (HealthCare, January 2023) and 1253:1000 (Vernova, April 2024),
 * which are not splits at all and would have inflated a GE holding by 28% and
 * then another 25% if they had been treated as ones.
 *
 * What every test here is really about is the one mistake that must never
 * happen: applying a split twice. A 4:1 applied twice is sixteen times the
 * shares, on a screen with nothing on it that would contradict the number.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── A database, small enough to reason about ───────────────────────────────

interface InvRow {
  id: string; user_id: string; name: string; ticker: string; market: string;
  asset_type: string; shares_owned: number; cost_basis: number;
  current_price: number; split_checked_through: string | null;
}
interface SplitRow {
  id: string; user_id: string; investment_id: string; label: string;
  ticker: string | null; ratio: number; recorded_at: string | null;
}

const db = {
  investments: [] as InvRow[],
  cgt_splits: [] as SplitRow[],
  /** Pretend the migration has not been run. */
  splitColumn: true,
  /** Pretend cgt_splits does not exist. */
  bookTable: true,
  writes: 0,
};

const UNKNOWN_COLUMN = { code: '42703', message: 'column investments.split_checked_through does not exist' };
const MISSING_TABLE = { code: '42P01', message: 'relation "cgt_splits" does not exist' };

/** A `.or('a.is.null,a.lt.X')` filter, which is the only one this code writes. */
function passesOr(row: Record<string, unknown>, expr: string): boolean {
  return expr.split(',').some(term => {
    const [col, op, val] = term.split('.');
    const v = row[col];
    if (op === 'is' && val === 'null') return v == null;
    if (op === 'lt') return v != null && String(v) < String(val);
    return false;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function builder(table: string): any {
  const filters: ((r: Record<string, unknown>) => boolean)[] = [];
  let mode: 'select' | 'update' | 'upsert' = 'select';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any = null;

  const rows = (): Record<string, unknown>[] =>
    (db[table as 'investments' | 'cgt_splits'] as unknown as Record<string, unknown>[])
      .filter(r => filters.every(f => f(r)));

  const run = () => {
    if (table === 'investments' && !db.splitColumn) return { data: null, error: UNKNOWN_COLUMN };
    if (table === 'cgt_splits' && !db.bookTable) return { data: null, error: MISSING_TABLE };
    if (mode === 'update') {
      const hit = rows();
      db.writes += hit.length;
      for (const r of hit) Object.assign(r, payload);
      return { data: hit.map(r => ({ id: r.id })), error: null };
    }
    if (mode === 'upsert') {
      db.writes += 1;
      const list = db.cgt_splits;
      const i = list.findIndex(x => x.id === payload.id);
      if (i >= 0) list[i] = { ...list[i], ...payload };
      else list.push(payload as SplitRow);
      return { data: [payload], error: null };
    }
    return { data: rows().map(r => ({ ...r })), error: null };
  };

  const api = {
    select() { return api; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(p: any) { mode = 'update'; payload = p; return api; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(p: any) { mode = 'upsert'; payload = p; return api; },
    eq(col: string, val: unknown) { filters.push(r => String(r[col]) === String(val)); return api; },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals.map(String));
      filters.push(r => set.has(String(r[col])));
      return api;
    },
    or(expr: string) { filters.push(r => passesOr(r, expr)); return api; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
  };
  return api;
}

vi.mock('../utils/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }));

const {
  isShareSplit, splitRatio, parseSplitEvents, splitRecordId, splitRecordedAt,
  isSplitEligible, syncSplits,
} = await import('./corporateActions');
const { getYahooTicker } = await import('./marketSymbols');

// ─── Real events, as the feed serves them ───────────────────────────────────

const AT = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

/** Real numerator/denominator pairs, straight off the wire. */
const REAL = {
  aapl4to1:   { date: '2020-08-31', numerator: 4, denominator: 1 },
  toyota5to1: { date: '2021-09-29', numerator: 5, denominator: 1 },
  nvda4to1:   { date: '2021-07-20', numerator: 4, denominator: 1 },
  nvda10to1:  { date: '2024-06-10', numerator: 10, denominator: 1 },
  siri1for10: { date: '2024-09-10', numerator: 1, denominator: 10 },
  ge1for8:    { date: '2021-08-02', numerator: 1, denominator: 8 },
  // NOT splits — spin-off price factors, in the same field.
  geHealth:   { date: '2023-01-04', numerator: 1281, denominator: 1000 },
  geVernova:  { date: '2024-04-02', numerator: 1253, denominator: 1000 },
  ge2019:     { date: '2019-02-26', numerator: 104, denominator: 100 },
};

const chartBody = (events: { date: string; numerator: number; denominator: number }[]) => ({
  chart: { result: [{
    meta: { symbol: 'X', currency: 'USD' },
    events: {
      splits: Object.fromEntries(events.map(e => [
        String(AT(e.date)),
        { date: AT(e.date), numerator: e.numerator, denominator: e.denominator,
          splitRatio: `${e.numerator}:${e.denominator}` },
      ])),
    },
  }] },
});

/** The feed, under our control. `null` bodies stand for a failed request. */
let feed: Record<string, unknown> | null = chartBody([]);
let feedCalls = 0;

beforeEach(() => {
  db.investments = []; db.cgt_splits = []; db.writes = 0;
  db.splitColumn = true; db.bookTable = true;
  feed = chartBody([]); feedCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    feedCalls += 1;
    if (feed === null) return { ok: false, json: async () => ({}) } as never;
    return { ok: true, json: async () => feed } as never;
  }));
});
afterEach(() => vi.unstubAllGlobals());

const holding = (over: Partial<InvRow> = {}): InvRow => ({
  id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', name: 'Apple',
  ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock',
  shares_owned: 400, cost_basis: 69_320, current_price: 499.23,
  split_checked_through: null, ...over,
});

/** The rows the engine is given, as the price refresh hands them over. */
const candidates = () => db.investments.map(r => ({ ...r }));

const run = (now: string) => syncSplits(candidates(), getYahooTicker, `${now}T06:00:00.000Z`);

// ─── Telling a split from something that merely looks like one ──────────────

describe('what counts as a share split', () => {
  it('accepts every real split the feed reported', () => {
    for (const k of ['aapl4to1', 'toyota5to1', 'nvda4to1', 'nvda10to1', 'siri1for10', 'ge1for8'] as const) {
      const e = REAL[k];
      expect(isShareSplit(e.numerator, e.denominator), k).toBe(true);
    }
    // And the less common whole-number forms.
    expect(isShareSplit(3, 2)).toBe(true);
    expect(isShareSplit(2, 3)).toBe(true);
    expect(isShareSplit(1, 20)).toBe(true);
  });

  it('rejects the spin-off factors the feed serves in the same field', () => {
    // GE HealthCare (2023) and GE Vernova (2024). A GE holder's share count did
    // not change on either day; the price did, because value left the company.
    for (const k of ['geHealth', 'geVernova', 'ge2019'] as const) {
      const e = REAL[k];
      expect(isShareSplit(e.numerator, e.denominator), k).toBe(false);
    }
  });

  it('measures the damage those two would have done', () => {
    // 1000 GE shares, held through both. Treated as splits they become 1,605.
    const after = 1000 * (1281 / 1000) * (1253 / 1000);
    expect(after).toBeCloseTo(1605.1, 1);
    expect(after / 1000 - 1).toBeGreaterThan(0.6);
  });

  it('rejects the degenerate ratios outright', () => {
    expect(isShareSplit(1, 1)).toBe(false);
    expect(isShareSplit(0, 1)).toBe(false);
    expect(isShareSplit(4, 0)).toBe(false);
    expect(isShareSplit(2.5, 1)).toBe(false);
    expect(isShareSplit(NaN, 1)).toBe(false);
  });

  it('turns a pair into new-units-per-old, forwards and in reverse', () => {
    expect(splitRatio(4, 1)).toBe(4);
    expect(splitRatio(5, 1)).toBe(5);
    expect(splitRatio(1, 10)).toBe(0.1);
    expect(splitRatio(1, 8)).toBe(0.125);
    expect(splitRatio(3, 2)).toBe(1.5);
  });
});

describe('reading the feed', () => {
  it('parses a real body with two splits, oldest first', () => {
    const out = parseSplitEvents(chartBody([REAL.nvda10to1, REAL.nvda4to1]));
    expect(out.map(s => s.date)).toEqual(['2021-07-20', '2024-06-10']);
    expect(out.map(s => s.ratio)).toEqual([4, 10]);
  });

  it('reports a spin-off factor rather than hiding it — the caller decides', () => {
    const out = parseSplitEvents(chartBody([REAL.geHealth]));
    expect(out).toHaveLength(1);
    expect(out[0].ratio).toBeCloseTo(1.281, 6);
  });

  it('reads nothing out of a body with no events, and does not throw on rubbish', () => {
    expect(parseSplitEvents(chartBody([]))).toEqual([]);
    expect(parseSplitEvents({})).toEqual([]);
    expect(parseSplitEvents(null)).toEqual([]);
    expect(parseSplitEvents({ chart: { result: [{ events: { splits: 'nope' } }] } })).toEqual([]);
  });
});

describe('the id a split is recorded under', () => {
  const inv = '11111111-1111-4111-8111-111111111111';

  it('is the same everywhere, because it is derived and never minted', () => {
    expect(splitRecordId(inv, '2020-08-31', 4)).toBe(splitRecordId(inv, '2020-08-31', 4));
    expect(splitRecordId(inv, '2020-08-31', 4)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is different for a different date, ratio or holding', () => {
    const a = splitRecordId(inv, '2020-08-31', 4);
    expect(splitRecordId(inv, '2020-09-01', 4)).not.toBe(a);
    expect(splitRecordId(inv, '2020-08-31', 2)).not.toBe(a);
    expect(splitRecordId('22222222-2222-4222-8222-222222222222', '2020-08-31', 4)).not.toBe(a);
  });

  it('stamps the book entry at midnight on the effective date', () => {
    // The CGT engine scales what was written down BEFORE this instant, so a
    // parcel bought on the day of the split — already in new units — is left
    // alone, and everything bought before it is scaled.
    expect(splitRecordedAt('2020-08-31')).toBe('2020-08-31T00:00:00.000Z');
  });
});

describe('what can split', () => {
  it('is a listed security on a market the feed reports actions for', () => {
    expect(isSplitEligible('NASDAQ', 'stock')).toBe(true);
    expect(isSplitEligible('ASX', 'etf')).toBe(true);
    expect(isSplitEligible('JPX', 'stock')).toBe(true);
    expect(isSplitEligible('LSE', 'stock')).toBe(true);
  });

  it('is not cash, metal, crypto or anything unpriced', () => {
    for (const t of ['cash', 'crypto', 'precious_metal', 'art', 'wine', 'jewellery', 'bond']) {
      expect(isSplitEligible('NASDAQ', t), t).toBe(false);
    }
    expect(isSplitEligible('Private Investment', 'stock')).toBe(false);
    expect(isSplitEligible('Crypto', 'crypto')).toBe(false);
  });
});

// ─── The whole pass, against the little database ────────────────────────────

describe('the first time a holding is seen', () => {
  it('applies nothing, whatever history the feed reports', async () => {
    // Apple, added today by somebody who typed in 1,600 post-split shares.
    db.investments = [holding({ shares_owned: 1_600, current_price: 129.04 })];
    feed = chartBody([REAL.aapl4to1]);

    const out = await run('2026-08-30');
    expect(out.firstSeen).toBe(1);
    expect(out.applied).toBe(0);
    expect(db.investments[0].shares_owned).toBe(1_600);
    // It did not even ask the feed: there is nothing a first sighting could do
    // with the answer.
    expect(feedCalls).toBe(0);
    expect(db.investments[0].split_checked_through).toBe('2026-08-30');
  });

  it('starts the clock so the next split IS caught', async () => {
    db.investments = [holding({ shares_owned: 400, current_price: 499.23 })];
    await run('2020-08-28');
    expect(db.investments[0].split_checked_through).toBe('2020-08-28');

    feed = chartBody([REAL.aapl4to1]);
    const out = await run('2020-08-31');
    expect(out.applied).toBe(1);
    expect(db.investments[0].shares_owned).toBe(1_600);
  });
});

describe('applying a split', () => {
  beforeEach(async () => {
    db.investments = [holding({ shares_owned: 400, current_price: 499.23 })];
    await run('2020-08-28');            // first sighting: watermark only
    feed = chartBody([REAL.aapl4to1]);
  });

  it('multiplies the units and leaves the money exactly where it was', async () => {
    const costBefore = db.investments[0].cost_basis;
    const worthBefore = db.investments[0].shares_owned * db.investments[0].current_price;

    const out = await run('2020-08-31');

    expect(out.applied).toBe(1);
    expect(db.investments[0].shares_owned).toBe(1_600);
    expect(db.investments[0].cost_basis).toBe(costBefore);
    // Price moves the other way by the same ratio, in the same write, so not a
    // cent of the holding's worth changes at the moment of the split.
    expect(db.investments[0].current_price).toBeCloseTo(124.8075, 6);
    expect(db.investments[0].shares_owned * db.investments[0].current_price)
      .toBeCloseTo(worthBefore, 6);
  });

  it('writes the split into the parcel book, dated the day it took effect', async () => {
    await run('2020-08-31');
    expect(db.cgt_splits).toHaveLength(1);
    const rec = db.cgt_splits[0];
    expect(rec.investment_id).toBe(db.investments[0].id);
    expect(rec.ratio).toBe(4);
    expect(rec.recorded_at).toBe('2020-08-31T00:00:00.000Z');
    expect(rec.id).toBe(splitRecordId(db.investments[0].id, '2020-08-31', 4));
  });

  it('never applies it twice, however many times the refresh runs', async () => {
    await run('2020-08-31');
    expect(db.investments[0].shares_owned).toBe(1_600);

    for (const d of ['2020-08-31', '2020-09-01', '2020-09-02', '2020-12-01', '2021-06-30']) {
      feed = chartBody([REAL.aapl4to1]);
      const again = await run(d);
      expect(again.applied, d).toBe(0);
      expect(db.investments[0].shares_owned, d).toBe(1_600);
    }
    expect(db.cgt_splits).toHaveLength(1);
  });

  it('never applies it twice when two refreshes race each other', async () => {
    // The cron and a user opening the app, in the same second.
    const results = await Promise.all([run('2020-08-31'), run('2020-08-31')]);
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(1);
    expect(db.investments[0].shares_owned).toBe(1_600);
    expect(db.cgt_splits).toHaveLength(1);
  });

  it('asks the feed once a day per holding and no more', async () => {
    await run('2020-08-31');
    const afterFirst = feedCalls;
    await run('2020-08-31');
    await run('2020-08-31');
    expect(feedCalls).toBe(afterFirst);
  });

  it('leaves the units alone if somebody moved them mid-flight', async () => {
    // The optimistic guard: the update only lands on the count we read.
    const stale = candidates();
    db.investments[0].shares_owned = 450;         // a user edit, after our read
    const out = await syncSplits(stale, getYahooTicker, '2020-08-31T06:00:00.000Z');
    expect(out.applied).toBe(0);
    expect(db.investments[0].shares_owned).toBe(450);
    // And the watermark did not move, so the next run tries again.
    expect(db.investments[0].split_checked_through).toBe('2020-08-28');
  });
});

describe('a split the user got to first', () => {
  it('is not applied again — their unit count already reflects it', async () => {
    db.investments = [holding({ shares_owned: 400, current_price: 499.23 })];
    await run('2020-08-28');

    // The user sees the price halve, works it out, and doubles up themselves.
    db.investments[0].shares_owned = 1_600;
    db.investments[0].current_price = 129.04;
    db.cgt_splits.push({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: 'u1',
      investment_id: db.investments[0].id, label: 'Apple', ticker: 'AAPL',
      ratio: 4, recorded_at: '2020-09-02T09:15:00.000Z',
    });

    feed = chartBody([REAL.aapl4to1]);
    const out = await run('2020-09-02');

    expect(out.applied).toBe(0);
    expect(db.investments[0].shares_owned).toBe(1_600);   // NOT 6,400
    expect(db.cgt_splits).toHaveLength(1);                // and not duplicated
    // The watermark still moves, so it is never re-considered.
    expect(db.investments[0].split_checked_through).toBe('2020-09-02');
  });

  it('recognises a hand-divided ratio that is not quite round', async () => {
    db.investments = [holding({ ticker: 'SIRI', shares_owned: 1_000, current_price: 2.5 })];
    await run('2024-09-06');
    db.investments[0].shares_owned = 100;
    db.cgt_splits.push({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: 'u1',
      investment_id: db.investments[0].id, label: 'Sirius', ticker: 'SIRI',
      ratio: 0.09999995, recorded_at: '2024-09-11T00:00:00.000Z',
    });
    feed = chartBody([REAL.siri1for10]);
    const out = await run('2024-09-11');
    expect(out.applied).toBe(0);
    expect(db.investments[0].shares_owned).toBe(100);
  });
});

describe('a consolidation', () => {
  it('divides the units and multiplies the price, keeping the fraction', async () => {
    // Sirius XM's 1-for-10 of 10 September 2024, on an odd lot.
    db.investments = [holding({ ticker: 'SIRI', name: 'Sirius XM',
      shares_owned: 1_234, current_price: 3.2, cost_basis: 5_000 })];
    await run('2024-09-06');
    feed = chartBody([REAL.siri1for10]);

    const worthBefore = 1_234 * 3.2;
    const out = await run('2024-09-11');

    expect(out.applied).toBe(1);
    expect(db.investments[0].shares_owned).toBeCloseTo(123.4, 8);
    expect(db.investments[0].current_price).toBeCloseTo(32, 6);
    expect(db.investments[0].cost_basis).toBe(5_000);
    expect(db.investments[0].shares_owned * db.investments[0].current_price)
      .toBeCloseTo(worthBefore, 6);
    // The 0.4 of a share is KEPT. A broker pays cash in lieu; Ledger does not
    // invent a deposit that will never appear in the bank feed.
    expect(db.investments[0].shares_owned % 1).toBeGreaterThan(0);
    expect(db.cgt_splits[0].ratio).toBe(0.1);
  });

  it('handles General Electric\'s 1-for-8 the same way', async () => {
    db.investments = [holding({ ticker: 'GE', name: 'General Electric',
      shares_owned: 800, current_price: 13, cost_basis: 9_000 })];
    await run('2021-07-30');
    feed = chartBody([REAL.ge1for8]);
    await run('2021-08-02');
    expect(db.investments[0].shares_owned).toBe(100);
    expect(db.investments[0].current_price).toBe(104);
    expect(db.investments[0].cost_basis).toBe(9_000);
  });
});

describe('a spin-off wearing a split\'s clothes', () => {
  it('moves not one unit, and is not recorded as a split', async () => {
    db.investments = [holding({ ticker: 'GE', name: 'General Electric',
      shares_owned: 1_000, current_price: 65, cost_basis: 50_000 })];
    await run('2022-12-30');
    feed = chartBody([REAL.geHealth]);

    const out = await run('2023-01-05');
    expect(out.applied).toBe(0);
    expect(out.ignored).toBe(1);
    expect(db.investments[0].shares_owned).toBe(1_000);
    expect(db.investments[0].current_price).toBe(65);
    expect(db.cgt_splits).toHaveLength(0);
    // But the watermark still moves past it, or it is reconsidered every day.
    expect(db.investments[0].split_checked_through).toBe('2023-01-05');
  });

  it('still applies a real split that arrives in the same response', async () => {
    db.investments = [holding({ ticker: 'GE', name: 'General Electric',
      shares_owned: 800, current_price: 13, cost_basis: 9_000 })];
    await run('2021-07-30');
    feed = chartBody([REAL.ge1for8, REAL.geHealth]);

    const out = await run('2023-01-05');
    expect(out.applied).toBe(1);
    expect(out.ignored).toBe(1);
    expect(db.investments[0].shares_owned).toBe(100);
  });
});

describe('two splits on one holding', () => {
  it('applies them in order and lands on the product of the ratios', async () => {
    // NVIDIA: 4:1 in July 2021, 10:1 in June 2024. 100 shares become 4,000.
    db.investments = [holding({ ticker: 'NVDA', name: 'NVIDIA',
      shares_owned: 100, current_price: 800, cost_basis: 20_000 })];
    await run('2021-07-01');
    feed = chartBody([REAL.nvda4to1, REAL.nvda10to1]);

    const out = await run('2024-06-11');
    expect(out.applied).toBe(2);
    expect(db.investments[0].shares_owned).toBe(4_000);
    expect(db.investments[0].current_price).toBeCloseTo(20, 6);
    expect(db.investments[0].cost_basis).toBe(20_000);
    expect(db.cgt_splits.map(s => s.ratio).sort((a, b) => a - b)).toEqual([4, 10]);
    // Both dated when they happened, so the parcel book scales the right
    // parcels for each — a 2023 purchase must feel the 10:1 and not the 4:1.
    expect(db.cgt_splits.map(s => s.recorded_at).sort())
      .toEqual(['2021-07-20T00:00:00.000Z', '2024-06-10T00:00:00.000Z']);
  });
});

describe('when things go wrong', () => {
  it('leaves the watermark alone if the feed does not answer', async () => {
    db.investments = [holding()];
    await run('2020-08-28');
    feed = null;                                   // the request fails

    const out = await run('2020-08-31');
    expect(out.applied).toBe(0);
    expect(db.investments[0].split_checked_through).toBe('2020-08-28');

    // …and the split is found on the next attempt.
    feed = chartBody([REAL.aapl4to1]);
    expect((await run('2020-08-31')).applied).toBe(1);
  });

  it('does nothing at all until the migration has been run', async () => {
    db.splitColumn = false;
    db.investments = [holding()];
    feed = chartBody([REAL.aapl4to1]);
    db.writes = 0;

    const out = await run('2020-08-31');
    expect(out).toEqual({ checked: 0, applied: 0, ignored: 0, firstSeen: 0 });
    expect(db.investments[0].shares_owned).toBe(400);
    expect(db.writes).toBe(0);
    expect(feedCalls).toBe(0);
  });

  it('repairs a book entry that never landed, without touching the units again', async () => {
    db.investments = [holding({ shares_owned: 400 })];
    await run('2020-08-28');
    feed = chartBody([REAL.aapl4to1]);
    await run('2020-08-31');
    expect(db.investments[0].shares_owned).toBe(1_600);

    // The row is lost — a crash between the two writes, or a failed sync.
    db.cgt_splits = [];
    feed = chartBody([REAL.aapl4to1]);
    const out = await run('2020-09-03');

    expect(out.applied).toBe(0);
    expect(db.investments[0].shares_owned).toBe(1_600);   // units untouched
    expect(db.cgt_splits).toHaveLength(1);                // book restored
    expect(db.cgt_splits[0].id).toBe(splitRecordId(db.investments[0].id, '2020-08-31', 4));
  });

  it('declines to apply anything when it cannot read the book', async () => {
    db.investments = [holding()];
    await run('2020-08-28');
    db.bookTable = false;                          // cgt_splits is not migrated
    feed = chartBody([REAL.aapl4to1]);
    // A missing table is not evidence of a duplicate, so the split still lands;
    // it simply cannot be written down.
    const out = await run('2020-08-31');
    expect(out.applied).toBe(1);
    expect(db.investments[0].shares_owned).toBe(1_600);
  });

  it('watermarks a holding with no units instead of asking about it for ever', async () => {
    db.investments = [holding({ shares_owned: 0, current_price: 0 })];
    await run('2020-08-28');
    feed = chartBody([REAL.aapl4to1]);
    await run('2020-08-31');
    expect(db.investments[0].shares_owned).toBe(0);
    expect(db.investments[0].split_checked_through).toBe('2020-08-31');
  });

  it('skips a holding that cannot split, without spending a request', async () => {
    db.investments = [
      holding({ id: '33333333-3333-4333-8333-333333333333', ticker: 'BTC', market: 'Crypto', asset_type: 'crypto' }),
      holding({ id: '44444444-4444-4444-8444-444444444444', ticker: 'Gold', market: 'Physical Precious Metals', asset_type: 'precious_metal' }),
    ];
    const out = await run('2020-08-31');
    expect(out).toEqual({ checked: 0, applied: 0, ignored: 0, firstSeen: 0 });
    expect(feedCalls).toBe(0);
  });
});

describe('the symbol the feed is asked about', () => {
  it('is built from the holding\'s own market', async () => {
    db.investments = [holding({ id: '55555555-5555-4555-8555-555555555555',
      ticker: '7203', name: 'Toyota', market: 'JPX', shares_owned: 300, current_price: 10_385 })];
    await run('2021-09-27');
    feed = chartBody([REAL.toyota5to1]);
    await run('2021-09-30');

    const url = String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0]);
    expect(url).toContain('7203.T');
    expect(url).toContain('events=split');
    expect(db.investments[0].shares_owned).toBe(1_500);
    expect(db.investments[0].current_price).toBe(2_077);
  });
});
