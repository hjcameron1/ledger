/**
 * D-CONC-1 regression — concurrent balance adjustments must not lose updates.
 *
 * The old /adjust-balance did an app-level read-modify-write: SELECT the current
 * balance, then UPDATE it to current + delta. Under concurrency both writers read
 * the same base and the second clobbered the first — a live repro of ten
 * simultaneous +1s landed on a final balance of 1–3, losing 7–9 updates.
 *
 * The fix is an atomic in-database increment (RPC `balance = balance + delta`),
 * with a guarded compare-and-swap fallback for before the migration is applied.
 * This test proves BOTH paths retain every one of ten concurrent adjustments,
 * and — as a control — that the fake DB used here really does reproduce the
 * lost-update when a naive read-modify-write runs against it, so the test would
 * actually fail if the bug came back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

// ── A concurrency-accurate in-memory Postgres stand-in ────────────────────────
// Reads yield to the event loop (a real network round-trip), so concurrent
// reads all observe the same pre-write value — that is what makes a
// read-modify-write lose updates. Writes commit synchronously at the await
// point, modelling a single UPDATE's row-level atomicity: a guarded
// UPDATE … WHERE col = <expected> either lands whole or matches nothing.
type Row = Record<string, unknown>;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class Db {
  tables = new Map<string, Row[]>();
  seed(table: string, rows: Row[]) { this.tables.set(table, rows.map((r) => ({ ...r }))); }
  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }
}
let db = new Db();
// Flip to false to force the RPC to look "not yet migrated" and exercise the
// CAS fallback through the exact same HTTP path.
let rpcEnabled = true;

class FakeQuery {
  private eqs: [string, unknown][] = [];
  private op: 'read' | 'update' | 'insert' = 'read';
  private patch: Row | null = null;
  constructor(private table: string) {}
  select() { return this; }
  update(patch: Row) { this.op = 'update'; this.patch = patch; return this; }
  insert(row: Row) { this.op = 'insert'; this.patch = row; return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  neq() { return this; }
  in() { return this; }
  order() { return this; }
  private match(r: Row): boolean { return this.eqs.every(([c, v]) => r[c] === v); }

  // Read: yields first (concurrent reads see the same snapshot), then answers.
  private async read(): Promise<{ data: Row | null; error: null }> {
    await tick();
    const found = db.rows(this.table).find((r) => this.match(r));
    return { data: found ? { ...found } : null, error: null };
  }
  // A write is a network delay (await tick — where concurrency happens) followed
  // by the statement executing atomically at the "server": the guard check and
  // the mutation run synchronously in one step, so two concurrent commits can
  // never interleave. That models Postgres row-level atomicity — a guarded
  // UPDATE … WHERE col = <expected> either lands whole or matches nothing —
  // while still leaving the read/write gap that makes a naive RMW lose updates.
  private async write(): Promise<{ data: Row | null; error: null }> {
    await tick();
    if (this.op === 'insert') {
      const row = { id: `row-${db.rows(this.table).length + 1}`, ...this.patch };
      db.rows(this.table).push(row);
      return { data: { ...row }, error: null };
    }
    const target = db.rows(this.table).find((r) => this.match(r)); // includes any value guard
    if (!target) return { data: null, error: null };
    Object.assign(target, this.patch);
    return { data: { ...target }, error: null };
  }
  private run() { return this.op === 'read' ? this.read() : this.write(); }

  maybeSingle() { return this.run(); }
  async single() {
    const res = await this.run();
    return res.data ? res : { data: null, error: { message: 'no rows' } };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => void) {
    this.run().then((res) => resolve({ data: res.data ? [res.data] : [], error: null }));
  }
}

// Atomic increment RPC — the whole read+write is one synchronous step, so it is
// immune to interleaving regardless of how many callers race it.
function rpc(fn: string, args: { p_id: string; p_delta: number }) {
  if (!rpcEnabled) {
    return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
  }
  const table = fn === 'adjust_bank_account_balance' ? 'bank_accounts' : 'credit_cards';
  const col = table === 'bank_accounts' ? 'balance' : 'balance_owing';
  return tick().then(() => {
    const row = db.rows(table).find((r) => r.id === args.p_id);
    if (!row) return { data: null, error: null };
    row[col] = (Number(row[col]) || 0) + args.p_delta; // single atomic step
    return { data: { ...row }, error: null };
  });
}

vi.mock('../utils/supabase', () => ({
  supabase: { from: (t: string) => new FakeQuery(t), rpc },
  getSupabase: () => { throw new Error('not used'); },
  upsertTolerant: () => { throw new Error('not used'); },
}));
// Isolate the concurrency behaviour: sharing/permission checks pass, snapshots
// and currency enrichment are no-ops.
vi.mock('../services/householdScope', () => ({
  loadScope: vi.fn().mockResolvedValue({ userId: 'u1', memberships: [], grants: [] }),
  refuseWrite: vi.fn().mockResolvedValue(null),
  attachHouseholdsToOne: (_type: string, row: unknown) => Promise.resolve(row),
  attachHouseholds: (_type: string, rows: unknown) => Promise.resolve(rows),
  scopedQuery: (q: unknown) => q,
  applyHouseholdShare: vi.fn().mockResolvedValue(null),
  refuseDelete: vi.fn().mockResolvedValue(null),
  revokeGrantsFor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/householdChangeRequests', () => ({
  divertMemberEdit: vi.fn().mockResolvedValue(null),
  divertMemberDelete: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/netWorthSnapshot', () => ({ recordNetWorthSnapshot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/currencyService', () => ({
  enrichWithDisplayAmounts: (rows: unknown[]) => Promise.resolve(rows),
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-key';

import accountsRouter from './accounts';

// Spin up the real router on an ephemeral port and return its base URL.
async function serve(): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}/api/accounts`, close: () => server.close() });
    });
  });
}

const token = () => jwt.sign({ userId: 'u1', email: 'u1@test', plan: 'free' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

async function adjust(base: string, path: string, delta: number): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ delta }),
  });
  return res.status;
}

describe('D-CONC-1 — concurrent balance adjustment', () => {
  beforeEach(() => {
    db = new Db();
    db.seed('bank_accounts', [{ id: 'acc1', user_id: 'u1', balance: 0 }]);
    db.seed('credit_cards', [{ id: 'card1', user_id: 'u1', balance_owing: 0 }]);
    rpcEnabled = true;
  });

  it('CONTROL: a naive read-modify-write against this fake really does lose updates', async () => {
    // Proves the fake models the hazard — if it didn't, the tests below prove nothing.
    const naive = async () => {
      const { data } = await new FakeQuery('bank_accounts').select().eq('id', 'acc1').maybeSingle();
      const current = Number((data as Row).balance) || 0;
      await new FakeQuery('bank_accounts').update({ balance: current + 1 }).eq('id', 'acc1').select().single();
    };
    await Promise.all(Array.from({ length: 10 }, naive));
    expect(Number(db.rows('bank_accounts')[0].balance)).toBeLessThan(10);
  });

  it('atomic RPC path: 10 concurrent +1 on a bank account all retained', async () => {
    const { base, close } = await serve();
    try {
      const codes = await Promise.all(Array.from({ length: 10 }, () => adjust(base, '/acc1/adjust-balance', 1)));
      expect(codes.every((c) => c === 200)).toBe(true);
      expect(Number(db.rows('bank_accounts')[0].balance)).toBe(10);
    } finally { close(); }
  });

  it('CAS fallback path (RPC not yet migrated): 10 concurrent +1 all retained', async () => {
    rpcEnabled = false; // force PGRST202 → guarded compare-and-swap
    const { base, close } = await serve();
    try {
      const codes = await Promise.all(Array.from({ length: 10 }, () => adjust(base, '/acc1/adjust-balance', 1)));
      expect(codes.every((c) => c === 200)).toBe(true);
      expect(Number(db.rows('bank_accounts')[0].balance)).toBe(10);
    } finally { close(); }
  });

  it('credit card adjust-balance is atomic too', async () => {
    const { base, close } = await serve();
    try {
      await Promise.all(Array.from({ length: 10 }, () => adjust(base, '/credit-cards/card1/adjust-balance', 1)));
      expect(Number(db.rows('credit_cards')[0].balance_owing)).toBe(10);
    } finally { close(); }
  });

  it('mixed adds and deletes (transaction add/delete paths) net out exactly', async () => {
    // A transaction add fires +delta; deleting it fires the opposite. Interleave
    // 20 concurrent moves — twelve +5 adds and eight -5 deletes — and the balance
    // must equal the arithmetic sum, 20, with nothing lost either way.
    db.seed('bank_accounts', [{ id: 'acc1', user_id: 'u1', balance: 100 }]);
    const ops = [
      ...Array.from({ length: 12 }, () => 5),
      ...Array.from({ length: 8 }, () => -5),
    ];
    const { base, close } = await serve();
    try {
      await Promise.all(ops.map((d) => adjust(base, '/acc1/adjust-balance', d)));
      // 100 + 12*5 - 8*5 = 100 + 60 - 40 = 120
      expect(Number(db.rows('bank_accounts')[0].balance)).toBe(120);
    } finally { close(); }
  });

  it('same run under the CAS fallback nets out exactly', async () => {
    rpcEnabled = false;
    db.seed('bank_accounts', [{ id: 'acc1', user_id: 'u1', balance: 100 }]);
    const ops = [...Array.from({ length: 12 }, () => 5), ...Array.from({ length: 8 }, () => -5)];
    const { base, close } = await serve();
    try {
      await Promise.all(ops.map((d) => adjust(base, '/acc1/adjust-balance', d)));
      expect(Number(db.rows('bank_accounts')[0].balance)).toBe(120);
    } finally { close(); }
  });

  it('unknown account id returns 404', async () => {
    const { base, close } = await serve();
    try {
      const res = await fetch(`${base}/nope/adjust-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ delta: 1 }),
      });
      expect(res.status).toBe(404);
    } finally { close(); }
  });
});
