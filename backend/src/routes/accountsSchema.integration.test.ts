/**
 * L2 (pre-market audit) — the API schema rejects a figure floats cannot hold.
 *
 * 9,007,199,254,740,993 stored as …992 and net worth inherited the corruption.
 * No real balance is within orders of magnitude of the IEEE safe-integer
 * bound, so the schema refuses it loudly (400) instead of storing it wrongly —
 * at the accounts route here, and via the same shared `money` schema on loans
 * and properties.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import { money, MAX_MONEY } from '../utils/moneySchema';

type Row = Record<string, unknown>;
const db = { tables: new Map<string, Row[]>() };
const tableOf = (name: string): Row[] => {
  if (!db.tables.has(name)) db.tables.set(name, []);
  return db.tables.get(name)!;
};

class FakeQuery {
  private eqs: [string, unknown][] = [];
  private inserted: Row | null = null;
  constructor(private table: string) {}
  select(_cols?: string) { return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  neq() { return this; }
  in() { return this; }
  order() { return this; }
  insert(row: Row) {
    this.inserted = { id: `row-${tableOf(this.table).length + 1}`, ...row };
    tableOf(this.table).push(this.inserted);
    return this;
  }
  private rows(): Row[] {
    if (this.inserted) return [this.inserted];
    return tableOf(this.table).filter(r => this.eqs.every(([c, v]) => r[c] === v));
  }
  single() { const rows = this.rows(); return Promise.resolve(rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } }); }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => void) { resolve({ data: this.rows(), error: null }); }
}

vi.mock('../utils/supabase', () => ({
  supabase: { from: (table: string) => new FakeQuery(table) },
  getSupabase: () => { throw new Error('not used here'); },
  upsertTolerant: () => { throw new Error('not used here'); },
}));
// The create path fires a net-worth snapshot in the background — irrelevant here.
vi.mock('../services/netWorthSnapshot', () => ({ recordNetWorthSnapshot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/currencyService', () => ({
  enrichWithDisplayAmounts: (rows: unknown[]) => Promise.resolve(rows),
}));

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-key';

import accountsRouter from './accounts';

const app = express();
app.use(express.json());
app.use('/api/accounts', accountsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/accounts`;

const USER = 'a0000000-0000-0000-0000-00000000000a';
const tokenFor = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@x.test`, plan: 'free' }, process.env.JWT_SECRET ?? 'dev-secret');

async function createAccount(balance: number): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(USER)}` },
    body: JSON.stringify({
      name: 'Everyday', institution: 'Test Bank', account_type: 'Everyday',
      balance, currency: 'AUD',
    }),
  });
}

beforeEach(() => { db.tables.clear(); });

describe('POST /api/accounts balance bounds', () => {
  it('rejects a balance beyond safe-integer precision with a 400', async () => {
    const res = await createAccount(9_007_199_254_740_993);
    expect(res.status).toBe(400);
  });

  it('rejects a negative balance beyond the bound', async () => {
    const res = await createAccount(-(2 ** 60));
    expect(res.status).toBe(400);
  });

  it('accepts an ordinary balance exactly as before', async () => {
    const res = await createAccount(1_234.56);
    expect(res.status).toBe(201);
    const row = await res.json() as Row;
    expect(row.balance).toBe(1_234.56);
  });

  it('accepts a large but storable balance ($41m estate)', async () => {
    const res = await createAccount(41_000_000);
    expect(res.status).toBe(201);
  });
});

describe('the shared money schema', () => {
  it('bounds at ±MAX_SAFE_INTEGER and refuses non-finite values', () => {
    expect(money.safeParse(MAX_MONEY).success).toBe(true);
    expect(money.safeParse(-MAX_MONEY).success).toBe(true);
    expect(money.safeParse(9_007_199_254_740_993).success).toBe(false);
    expect(money.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(money.safeParse(Number.NaN).success).toBe(false);
  });

  it('still chains route modifiers (.nonnegative, .int)', () => {
    expect(money.nonnegative().safeParse(-1).success).toBe(false);
    expect(money.int().safeParse(2.5).success).toBe(false);
    expect(money.nonnegative().safeParse(500).success).toBe(true);
  });
});
