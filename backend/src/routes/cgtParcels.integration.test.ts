/**
 * Phase 5.7 — the parcel-book routes, end to end through the REAL router.
 *
 * The client (frontend/src/stress/cgtParcelDurabilitySim.test.ts) is tested
 * against a fake server that mirrors this contract; these tests are the other
 * half of that handshake, so the two can't drift apart in opposite directions:
 *
 *   • an id is MINTED BY THE CLIENT and the write is an upsert on it, so a
 *     replayed sync converges rather than recording an acquisition twice;
 *   • a disposal's allocation is replaced as one SET, never merged slice by
 *     slice — half of an old set beside half of a new one is a cost nobody paid;
 *   • rows are user-scoped, and one user can never read or delete another's;
 *   • before the migration is run the routes say `available: false` instead of
 *     answering with empty lists, because "not migrated" and "you have no
 *     parcels" are different facts and only one of them may delete anything.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

// ── The in-memory Supabase ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
const db = {
  tables: new Map<string, Row[]>(),
  /** Tables the migration has NOT created yet — see `available: false`. */
  missing: new Set<string>(),
};

const tableOf = (name: string): Row[] => {
  if (!db.tables.has(name)) db.tables.set(name, []);
  return db.tables.get(name)!;
};

const MISSING = { message: 'relation "public.x" does not exist', code: '42P01' };

class FakeQuery {
  private op: 'select' | 'insert' | 'upsert' | 'delete' = 'select';
  private eqs: [string, unknown][] = [];
  private payload: Row | Row[] | null = null;

  constructor(private table: string) {}

  select(_cols?: string) { return this; }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows: Row | Row[]) { this.op = 'upsert'; this.payload = rows; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  order(_col: string, _o?: unknown) { return this; }

  private rows(): Row[] {
    return tableOf(this.table).filter(r => this.eqs.every(([c, v]) => r[c] === v));
  }

  private run(): { data: unknown; error: null | { message: string; code?: string } } {
    if (db.missing.has(this.table)) return { data: null, error: MISSING };
    const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];

    if (this.op === 'insert') {
      tableOf(this.table).push(...rows.map(r => ({ created_at: new Date().toISOString(), ...r })));
      return { data: rows, error: null };
    }
    if (this.op === 'upsert') {
      // Keyed on the primary key the client supplied: `id` everywhere except
      // cgt_settings, which is one row per user.
      const key = this.table === 'cgt_settings' ? 'user_id' : 'id';
      for (const r of rows) {
        const existing = tableOf(this.table).find(x => x[key] === r[key]);
        if (existing) Object.assign(existing, r);
        else tableOf(this.table).push({ created_at: new Date().toISOString(), ...r });
      }
      return { data: rows.map(r => tableOf(this.table).find(x => x[key] === r[key])!), error: null };
    }
    if (this.op === 'delete') {
      const hit = new Set(this.rows());
      db.tables.set(this.table, tableOf(this.table).filter(r => !hit.has(r)));
      return { data: null, error: null };
    }
    return { data: this.rows(), error: null };
  }

  single() {
    const { data, error } = this.run();
    if (error) return Promise.resolve({ data: null, error });
    const rows = data as Row[] | null;
    return Promise.resolve(rows?.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } });
  }
  maybeSingle() {
    const { data, error } = this.run();
    return Promise.resolve({ data: (data as Row[] | null)?.[0] ?? null, error });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
    try { resolve(this.run()); } catch (err) { reject?.(err); }
  }
}

vi.mock('../utils/supabase', () => ({
  supabase: { from: (table: string) => new FakeQuery(table) },
  getSupabase: () => { throw new Error('not used here'); },
  upsertTolerant: () => { throw new Error('not used here'); },
}));

// Price/FX/snapshot work belongs to the other routes in this router and must not
// reach the network here.
vi.mock('../services/priceService', () => ({
  fetchCurrentPrice: async () => null, searchTicker: async () => [], isMetal: () => false,
  fetchMetalSpotPerUnit: async () => null, fetchDealerPricePerUnit: async () => null,
  refreshStaleHoldings: async () => undefined,
}));
vi.mock('../services/currencyService', () => ({ getRate: async () => 1, getRateOn: async () => 1 }));
vi.mock('../services/portfolioSnapshot', () => ({
  recordPortfolioSnapshot: async () => undefined, purgeInvestmentFromHistory: async () => undefined,
}));
vi.mock('../services/netWorthSnapshot', () => ({ recordNetWorthSnapshot: async () => undefined }));

import investmentsRouter from './investments';

// ── A real server on a real port ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/investments', investmentsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/investments`;

const ALICE = 'a0000000-0000-0000-0000-00000000000a';
const BOB   = 'b0000000-0000-0000-0000-00000000000b';
const HOLDING = 'c0000000-0000-0000-0000-00000000000c';
const SALE    = 'd0000000-0000-0000-0000-00000000000d';

const auth = (userId: string) => ({
  Authorization: `Bearer ${jwt.sign(
    { userId, email: `${userId}@x.test`, plan: 'free' },
    process.env.JWT_SECRET ?? 'dev-secret',
  )}`,
});
const json = (userId: string) => ({ ...auth(userId), 'Content-Type': 'application/json' });

async function send(method: string, path: string, userId: string, body?: Row) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? json(userId) : auth(userId),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Row & { error?: string } };
}

const readBook = (userId: string) => send('GET', '/cgt', userId) as Promise<{
  status: number;
  body: { available: boolean; parcels: Row[]; splits: Row[]; allocations: Row[]; opening: Row | null };
}>;

const parcel = (id: string, over: Row = {}): Row => ({
  id,
  investment_id: HOLDING,
  label: 'Ledger Ltd',
  ticker: 'ldg',
  asset_type: 'stock',
  quantity: 100,
  cost_base: 4_000,
  acquired_date: '2020-03-01',
  origin: 'holding',
  recorded_at: '2026-08-27T00:00:00.000Z#000000001',
  ...over,
});

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const A1 = '44444444-4444-4444-8444-444444444444';
const A2 = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  db.tables.clear();
  db.missing.clear();
});

describe('parcels', () => {
  it('stores what it was told, under the id the client minted', async () => {
    const { status } = await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    expect(status).toBe(201);

    const { body } = await readBook(ALICE);
    expect(body.available).toBe(true);
    expect(body.parcels).toHaveLength(1);
    expect(body.parcels[0]).toMatchObject({
      id: P1, investment_id: HOLDING, quantity: 100, cost_base: 4_000,
      acquired_date: '2020-03-01', origin: 'holding', ticker: 'LDG',
    });
  });

  it('is idempotent: the same parcel written twice is still one acquisition', async () => {
    await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    const { body } = await readBook(ALICE);
    expect(body.parcels).toHaveLength(1);
  });

  it('updates in place when the same id comes back with a correction', async () => {
    await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    await send('POST', '/cgt/parcels', ALICE, parcel(P1, { acquired_date: '2019-11-04' }));
    const { body } = await readBook(ALICE);
    expect(body.parcels).toHaveLength(1);
    expect(body.parcels[0].acquired_date).toBe('2019-11-04');
  });

  it('refuses a parcel with no real id, rather than failing in a way that retries', async () => {
    const { status, body } = await send('POST', '/cgt/parcels', ALICE, parcel('not-a-uuid'));
    expect(status).toBe(400);
    expect(body.error).toMatch(/uuid/i);
  });

  it('refuses a parcel of no units — it is not an acquisition', async () => {
    const { status } = await send('POST', '/cgt/parcels', ALICE, parcel(P1, { quantity: 0 }));
    expect(status).toBe(400);
  });

  it('never shows one person the other\'s book', async () => {
    await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    const { body } = await readBook(BOB);
    expect(body.parcels).toHaveLength(0);
  });

  it('never lets one person delete the other\'s parcel', async () => {
    await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    await send('DELETE', `/cgt/parcels/${P1}`, BOB);
    expect((await readBook(ALICE)).body.parcels).toHaveLength(1);

    await send('DELETE', `/cgt/parcels/${P1}`, ALICE);
    expect((await readBook(ALICE)).body.parcels).toHaveLength(0);
  });

  it('forgets everything recorded against one holding when it is genuinely deleted', async () => {
    await send('POST', '/cgt/parcels', ALICE, parcel(P1));
    await send('POST', '/cgt/parcels', ALICE, parcel(P2, { investment_id: null }));
    await send('POST', '/cgt/splits', ALICE, { id: S1, investment_id: HOLDING, label: 'Ledger Ltd', ratio: 2 });

    await send('DELETE', `/cgt/holdings/${HOLDING}`, ALICE);
    const { body } = await readBook(ALICE);
    expect(body.parcels.map(p => p.id)).toEqual([P2]);
    expect(body.splits).toHaveLength(0);
  });
});

describe('splits', () => {
  it('stores a ratio and reads it back', async () => {
    const { status } = await send('POST', '/cgt/splits', ALICE, {
      id: S1, investment_id: HOLDING, label: 'Ledger Ltd', ticker: 'LDG', ratio: 10,
    });
    expect(status).toBe(201);
    const { body } = await readBook(ALICE);
    expect(body.splits[0]).toMatchObject({ id: S1, ratio: 10, investment_id: HOLDING });
  });

  it('refuses a ratio of 1, which moves nothing, and a negative one, which is not a split', async () => {
    for (const ratio of [1, 0, -2]) {
      const { status } = await send('POST', '/cgt/splits', ALICE, { id: S1, ratio });
      expect(status).toBe(400);
    }
  });
});

describe('what a disposal consumed', () => {
  const slices = [
    { id: A1, parcel_id: P1, quantity: 100, cost_base: 4_000, acquired_date: '2020-03-01', source: 'parcel' },
    { id: A2, parcel_id: P2, quantity: 20, cost_base: 1_200, acquired_date: '2024-06-01', source: 'parcel' },
  ];

  it('stores the whole allocation for a sale', async () => {
    const { status } = await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: slices });
    expect(status).toBe(200);
    const { body } = await readBook(ALICE);
    expect(body.allocations).toHaveLength(2);
    expect(body.allocations.map(a => a.sale_id)).toEqual([SALE, SALE]);
    expect(body.allocations[0]).toMatchObject({ parcel_id: P1, cost_base: 4_000 });
  });

  it('REPLACES it, so a re-settled sale is never half old and half new', async () => {
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: slices });
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, {
      allocations: [{ ...slices[0], quantity: 120, cost_base: 5_200 }],
    });
    const { body } = await readBook(ALICE);
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({ quantity: 120, cost_base: 5_200 });
  });

  it('clears it when an empty set is written — the disposal was withdrawn', async () => {
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: slices });
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: [] });
    expect((await readBook(ALICE)).body.allocations).toHaveLength(0);
  });

  it('accepts a derived parcel id, which is not a uuid but is the same on every device', async () => {
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, {
      allocations: [{ ...slices[0], parcel_id: `derived:${HOLDING}` }],
    });
    expect((await readBook(ALICE)).body.allocations[0].parcel_id).toBe(`derived:${HOLDING}`);
  });

  it('keeps the audit trail: when a slice was frozen, and by what', async () => {
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, {
      allocations: [
        { ...slices[0], settled_at: '2026-08-27T04:00:00.000Z', settled_by: 'backfill' },
        { ...slices[1], settled_at: '2024-06-02T00:00:00.000Z', settled_by: 'sale' },
      ],
    });
    const { body } = await readBook(ALICE);
    expect(body.allocations.map(a => a.settled_by)).toEqual(['backfill', 'sale']);
    expect(body.allocations[0].settled_at).toBe('2026-08-27T04:00:00.000Z');
  });

  it('treats a slice with no stamp as one the sale itself settled', async () => {
    // Everything written before the audit columns existed was written by a sale
    // — the backfill is the only other author and has always stamped itself.
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: slices });
    const { body } = await readBook(ALICE);
    expect(body.allocations[0].settled_by).toBe('sale');
    expect(body.allocations[0].settled_at).toBeNull();
  });

  it('refuses a made-up author rather than storing it', async () => {
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, {
      allocations: [{ ...slices[0], settled_by: 'whatever' }],
    });
    expect((await readBook(ALICE)).body.allocations[0].settled_by).toBe('sale');
  });

  it('takes the allocation with the sale when the sale is deleted', async () => {
    await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: slices });
    await send('DELETE', `/sales/${SALE}`, ALICE);
    expect((await readBook(ALICE)).body.allocations).toHaveLength(0);
  });
});

describe('the carried-forward loss', () => {
  it('stores one row per user and overwrites it', async () => {
    await send('PUT', '/cgt/opening', ALICE, { fy: '2023-2024', ordinary: 7_000, collectable: 250 });
    expect((await readBook(ALICE)).body.opening).toMatchObject({
      fy: '2023-2024', ordinary: 7_000, collectable: 250,
    });

    await send('PUT', '/cgt/opening', ALICE, { fy: '2023-2024', ordinary: 5_000, collectable: 0 });
    expect((await readBook(ALICE)).body.opening).toMatchObject({ ordinary: 5_000 });
    expect((await readBook(BOB)).body.opening).toBeNull();
  });

  it('clears it when the user says there is none', async () => {
    await send('PUT', '/cgt/opening', ALICE, { fy: '2023-2024', ordinary: 7_000 });
    await send('PUT', '/cgt/opening', ALICE, { fy: null, ordinary: 0, collectable: 0 });
    expect((await readBook(ALICE)).body.opening).toBeNull();
  });
});

describe('before the migration has been run', () => {
  it('says so, instead of answering with an empty book the client would act on', async () => {
    db.missing.add('cgt_parcels');
    const { status, body } = await readBook(ALICE);
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.parcels).toEqual([]);
  });

  it('answers a write with 404, not 500 — there is nothing to retry into', async () => {
    db.missing.add('cgt_parcels');
    db.missing.add('cgt_disposal_allocations');
    expect((await send('POST', '/cgt/parcels', ALICE, parcel(P1))).status).toBe(404);
    expect((await send('PUT', `/cgt/allocations/${SALE}`, ALICE, { allocations: [] })).status).toBe(404);
  });

  it('still deletes a sale when the allocation table is absent', async () => {
    db.missing.add('cgt_disposal_allocations');
    const { status } = await send('DELETE', `/sales/${SALE}`, ALICE);
    expect(status).toBe(200);
  });
});
