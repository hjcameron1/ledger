/**
 * The shared-splits read, end to end through the REAL router.
 *
 * A split transaction shared into a household is only honest if its LINES
 * travel with it: a member who can see the $600 Costco shop must see the
 * 380/150/70 it actually was, not the parent amount with no explanation. This
 * pins GET /api/overview/transaction-splits — the fix the frontend stress
 * harness exercises through its own world — at the HTTP layer: real Express,
 * real JWTs, the real loadScope, over an in-memory Supabase fake.
 *
 * What is pinned:
 *   • your own splits, always;
 *   • splits on a transaction STAMPED into your household;
 *   • splits riding a household-shared account, and a directly-granted one;
 *   • nothing for an outsider, and nothing from an unshared transaction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

// ── The in-memory Supabase ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
const db = { tables: new Map<string, Row[]>() };
const tableOf = (name: string): Row[] => {
  if (!db.tables.has(name)) db.tables.set(name, []);
  return db.tables.get(name)!;
};

class FakeQuery {
  private eqs: [string, unknown][] = [];
  private neqs: [string, unknown][] = [];
  private ins: [string, unknown[]][] = [];
  constructor(private table: string) {}

  select(_cols?: string) { return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  neq(col: string, val: unknown) { this.neqs.push([col, val]); return this; }
  in(col: string, vals: unknown[]) { this.ins.push([col, vals]); return this; }
  order(_col: string, _o?: unknown) { return this; }

  private rows(): Row[] {
    return tableOf(this.table).filter(r =>
      this.eqs.every(([c, v]) => r[c] === v) &&
      this.neqs.every(([c, v]) => r[c] !== v) &&
      this.ins.every(([c, vs]) => vs.includes(r[c])));
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

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-key';

import overviewRouter from './overview';

// ── A real server on a real port ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/overview', overviewRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/overview/transaction-splits`;

const MARA = 'a0000000-0000-0000-0000-00000000000a';
const DEV  = 'b0000000-0000-0000-0000-00000000000b';
const NINA = 'c0000000-0000-0000-0000-00000000000c';
const THEO = 'd0000000-0000-0000-0000-00000000000d';
const HH   = 'h0000000-0000-0000-0000-00000000000h';

const tokenFor = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@x.test`, plan: 'free' }, process.env.JWT_SECRET ?? 'dev-secret');

async function listAs(userId: string): Promise<Row[]> {
  const res = await fetch(base, { headers: { Authorization: `Bearer ${tokenFor(userId)}` } });
  expect(res.status).toBe(200);
  return await res.json() as Row[];
}

beforeEach(() => {
  db.tables.clear();

  // Mara and Dev share HH; Theo is in no household; Nina holds a direct grant.
  tableOf('household_members').push(
    { household_id: HH, user_id: MARA, role: 'owner', status: 'active' },
    { household_id: HH, user_id: DEV, role: 'member', status: 'active' },
  );

  // A $600 shop on Mara's joint account, split three ways; the account is
  // shared into the household, so the transaction rides it into view.
  tableOf('record_households').push(
    { record_type: 'account', record_id: 'acc-joint', household_id: HH, owner_user_id: MARA },
  );
  tableOf('transactions').push(
    { id: 'tx-split', user_id: MARA, account_id: 'acc-joint', amount: -600 },
    { id: 'tx-private-split', user_id: MARA, account_id: 'acc-private', amount: -90 },
  );
  tableOf('transaction_splits').push(
    { id: 'sp-1', user_id: MARA, transaction_id: 'tx-split', category: 'Groceries', amount: 380 },
    { id: 'sp-2', user_id: MARA, transaction_id: 'tx-split', category: 'Home', amount: 150 },
    { id: 'sp-3', user_id: MARA, transaction_id: 'tx-split', category: 'Health', amount: 70 },
    // Splits on a transaction Mara did NOT share — visible to nobody else.
    { id: 'sp-private', user_id: MARA, transaction_id: 'tx-private-split', category: 'Gifts', amount: 90 },
  );
});

describe('GET /transaction-splits', () => {
  it('returns the owner her own splits, shared or not', async () => {
    const ids = (await listAs(MARA)).map(r => r.id).sort();
    expect(ids).toEqual(['sp-1', 'sp-2', 'sp-3', 'sp-private']);
  });

  it('a household member sees the lines of a split riding a shared account', async () => {
    const rows = await listAs(DEV);
    expect(rows.map(r => r.id).sort()).toEqual(['sp-1', 'sp-2', 'sp-3']);
    // …and never the split of the unshared transaction.
    expect(rows.map(r => r.id)).not.toContain('sp-private');
  });

  it('a transaction stamped into the household carries its splits too', async () => {
    // Re-file the split transaction as directly shared, off the shared account.
    db.tables.set('record_households', [
      { record_type: 'transaction', record_id: 'tx-split', household_id: HH, owner_user_id: MARA },
    ]);
    expect((await listAs(DEV)).map(r => r.id).sort()).toEqual(['sp-1', 'sp-2', 'sp-3']);
  });

  it('a direct account grant carries the splits of its transactions', async () => {
    tableOf('record_shares').push({
      record_type: 'account', record_id: 'acc-joint',
      shared_with_user_id: NINA, permission: 'view', status: 'active',
    });
    expect((await listAs(NINA)).map(r => r.id).sort()).toEqual(['sp-1', 'sp-2', 'sp-3']);
  });

  it('an outsider gets only their own splits — here, none', async () => {
    expect(await listAs(THEO)).toEqual([]);
  });

  it('a revoked grant grants nothing', async () => {
    tableOf('record_shares').push({
      record_type: 'account', record_id: 'acc-joint',
      shared_with_user_id: NINA, permission: 'view', status: 'revoked',
    });
    expect(await listAs(NINA)).toEqual([]);
  });
});
