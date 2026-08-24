/**
 * Phase 8.2 — insurance end to end through the REAL router.
 *
 * The unit tests (services/insurancePolicies.test.ts) prove the decisions;
 * these prove the wiring: real Express, real JWTs, real route handlers — over an
 * in-memory Supabase whose `.or()` actually evaluates PostgREST syntax, so the
 * visibility filter is tested against the semantics it will meet in production
 * rather than against a stub that agrees with it by construction. (Same fake as
 * the vault's suite next door, minus the storage half: a policy is rows.)
 *
 * What the user asked to be sure of, each pinned below:
 *   renewals · premium changes · linked documents and assets · expired
 *   policies · sharing.
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

/** Split on commas that sit at paren depth 0 — `a,and(b,c)` → ['a','and(b,c)']. */
function splitTop(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Evaluate one PostgREST condition (`col.eq.v`, `col.in.(a,b)`, `and(…)`). */
function matches(row: Row, cond: string): boolean {
  if (cond.startsWith('and(') && cond.endsWith(')')) {
    return splitTop(cond.slice(4, -1)).every(c => matches(row, c));
  }
  const inMatch = cond.match(/^([\w.]+)\.in\.\((.*)\)$/);
  if (inMatch) {
    const [, col, list] = inMatch;
    return list.split(',').includes(String(row[col] ?? ''));
  }
  const eqMatch = cond.match(/^([\w.]+)\.eq\.(.*)$/);
  if (eqMatch) return String(row[eqMatch[1]] ?? '') === eqMatch[2];
  throw new Error(`fake supabase can't evaluate: ${cond}`);
}

let idSeq = 0;

class FakeQuery {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private eqs: [string, unknown][] = [];
  private ins: [string, unknown[]][] = [];
  private orExpr: string | null = null;
  private payload: Row | Row[] | null = null;

  constructor(private table: string) {}

  select(_cols?: string) { return this; }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  in(col: string, vals: unknown[]) { this.ins.push([col, vals]); return this; }
  or(expr: string) { this.orExpr = expr; return this; }
  order(_col: string, _o?: unknown) { return this; }

  private rows(): Row[] {
    return tableOf(this.table).filter(r =>
      this.eqs.every(([c, v]) => r[c] === v) &&
      this.ins.every(([c, vs]) => vs.includes(r[c])) &&
      (this.orExpr === null || splitTop(this.orExpr).some(cond => matches(r, cond))));
  }

  private run(): { data: unknown; error: null | { message: string; code?: string } } {
    if (this.op === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      // Postgres mints the id, as it does in production — which is exactly what
      // makes the client's temp→server id mapping necessary.
      const stamped = rows.map(r => ({
        id: `srv-${++idSeq}`, created_at: new Date().toISOString(), ...r,
      }));
      tableOf(this.table).push(...stamped);
      return { data: stamped, error: null };
    }
    if (this.op === 'update') {
      const hit = this.rows();
      for (const r of hit) Object.assign(r, this.payload);
      return { data: hit, error: null };
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
    const rows = data as Row[] | null;
    return Promise.resolve(rows?.length
      ? { data: rows[0], error }
      : { data: null, error: { message: 'no rows' } });
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

import insuranceRouter from './insurance';

// ── A real server on a real port ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/insurance', insuranceRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/insurance`;

const ALICE = 'a0000000-0000-0000-0000-00000000000a';
const BOB   = 'b0000000-0000-0000-0000-00000000000b';
const HH    = 'h0000000-0000-0000-0000-00000000000h';

const auth = (userId: string) => ({
  Authorization: `Bearer ${jwt.sign(
    { userId, email: `${userId}@x.test`, plan: 'free' },
    process.env.JWT_SECRET ?? 'dev-secret',
  )}`,
});

const json = (userId: string) => ({ ...auth(userId), 'Content-Type': 'application/json' });

async function createAs(userId: string, body: Row) {
  const res = await fetch(base, { method: 'POST', headers: json(userId), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Row & { error?: string } };
}

async function listAs(userId: string) {
  const res = await fetch(base, { headers: auth(userId) });
  expect(res.status).toBe(200);
  return await res.json() as { policies: Row[]; history: Row[] };
}

async function updateAs(userId: string, id: string, body: Row) {
  const res = await fetch(`${base}/${id}`, {
    method: 'PUT', headers: json(userId), body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Row & { error?: string } };
}

async function deleteAs(userId: string, id: string) {
  const res = await fetch(`${base}/${id}`, { method: 'DELETE', headers: auth(userId) });
  return { status: res.status, body: await res.json() as Row & { error?: string } };
}

/** Bob and Alice in one household, with `record` shared into it. */
function shareIntoHousehold(recordType: string, recordId: string, ownerId: string) {
  tableOf('household_members').push(
    { household_id: HH, user_id: ALICE, role: 'owner', status: 'active' },
    { household_id: HH, user_id: BOB, role: 'member', status: 'active' },
  );
  tableOf('record_households').push({
    record_type: recordType, record_id: recordId, household_id: HH, owner_user_id: ownerId,
  });
}

beforeEach(() => {
  db.tables.clear();
  idSeq = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
//  The basics: create, read, persist
// ═════════════════════════════════════════════════════════════════════════════
describe('policies', () => {
  it('creates one, stores what it was told, and reads it back', async () => {
    const { status, body } = await createAs(ALICE, {
      name: 'House — NRMA', policy_type: 'home', insurer: 'NRMA', policy_number: 'H-1',
      premium_amount: 1800, premium_frequency: 'annually',
      renewal_date: '2026-12-01', excess: 500, coverage_amount: 900_000,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      name: 'House — NRMA', policy_type: 'home', insurer: 'NRMA',
      premium_amount: 1800, renewal_date: '2026-12-01', excess: 500,
      coverage_amount: 900_000, user_id: ALICE, active: true,
    });

    const { policies } = await listAs(ALICE);
    expect(policies).toHaveLength(1);
    expect(policies[0].id).toBe(body.id);
  });

  it('refuses a policy with no name, and one with a nonsense type', async () => {
    expect((await createAs(ALICE, { name: '  ' })).status).toBe(400);
    expect((await createAs(ALICE, { name: 'X', policy_type: 'spaceship' })).status).toBe(400);
  });

  it('ignores forged server-owned columns on the way in', async () => {
    const { body } = await createAs(ALICE, {
      name: 'House', user_id: BOB, active: true,
    });
    expect(body.user_id).toBe(ALICE);
  });

  it('edits land, and an edit cannot smuggle an owner change', async () => {
    const { body: created } = await createAs(ALICE, { name: 'House', premium_amount: 1200 });
    const { status, body } = await updateAs(ALICE, created.id as string, {
      name: 'House — renamed', premium_amount: 1500, user_id: BOB,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'House — renamed', premium_amount: 1500, user_id: ALICE });
  });

  it('deletes a policy', async () => {
    const { body } = await createAs(ALICE, { name: 'House' });
    expect((await deleteAs(ALICE, body.id as string)).status).toBe(200);
    expect((await listAs(ALICE)).policies).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Renewals and expiry
// ═════════════════════════════════════════════════════════════════════════════
describe('renewal dates', () => {
  it('stores the renewal date verbatim — expiry is derived, never written', async () => {
    // The server keeps no "expired" flag: the client's engine compares the date
    // to today, which is why cover cannot be stale-marked as current.
    const { body } = await createAs(ALICE, { name: 'Car', renewal_date: '2020-01-01' });
    expect(body.renewal_date).toBe('2020-01-01');
    expect('status' in body).toBe(false);
    expect('expired' in body).toBe(false);
  });

  it('accepts a renewal being moved forward — the renewal itself', async () => {
    const { body } = await createAs(ALICE, { name: 'Car', renewal_date: '2026-08-01' });
    const { body: renewed } = await updateAs(ALICE, body.id as string, {
      renewal_date: '2027-08-01', premium_amount: 1400,
    });
    expect(renewed.renewal_date).toBe('2027-08-01');
  });

  it('refuses a renewal date that is not a date', async () => {
    const res = await createAs(ALICE, { name: 'Car', renewal_date: 'soon' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('YYYY-MM-DD');
  });

  it('takes an empty date as "no date" rather than failing the write', async () => {
    const { status, body } = await createAs(ALICE, { name: 'Life', renewal_date: '', start_date: '' });
    expect(status).toBe(201);
    expect(body.renewal_date).toBeNull();
  });

  it('keeps an ended policy rather than deleting it', async () => {
    const { body } = await createAs(ALICE, { name: 'Old car', renewal_date: '2024-01-01' });
    const { body: ended } = await updateAs(ALICE, body.id as string, { active: false });
    expect(ended.active).toBe(false);
    // Still there, still answerable — which is the point of `active`.
    expect((await listAs(ALICE)).policies).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Premium history
// ═════════════════════════════════════════════════════════════════════════════
describe('premium history', () => {
  const record = (userId: string, body: Row) =>
    fetch(`${base}/history`, { method: 'POST', headers: json(userId), body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() as Row & { error?: string } }));

  it('records what the premium became, and returns it beside the policy', async () => {
    const { body: policy } = await createAs(ALICE, { name: 'House', premium_amount: 1500 });
    const first = await record(ALICE, {
      policy_id: policy.id, premium_amount: 1200,
      premium_frequency: 'annually', effective_date: '2025-12-01', note: 'Opening premium',
    });
    expect(first.status).toBe(201);

    const { history } = await listAs(ALICE);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      policy_id: policy.id, premium_amount: 1200, effective_date: '2025-12-01', user_id: ALICE,
    });
  });

  it('refuses a record against somebody else\'s policy', async () => {
    const { body: policy } = await createAs(ALICE, { name: 'House' });
    const res = await record(BOB, {
      policy_id: policy.id, premium_amount: 999, effective_date: '2026-01-01',
    });
    expect(res.status).toBe(404);
    expect((await listAs(ALICE)).history).toEqual([]);
  });

  it('refuses an incomplete record', async () => {
    const { body: policy } = await createAs(ALICE, { name: 'House' });
    expect((await record(ALICE, { policy_id: policy.id, premium_amount: 100 })).status).toBe(400);
    expect((await record(ALICE, { premium_amount: 100, effective_date: '2026-01-01' })).status).toBe(400);
  });

  it('never hands one person\'s price history to another', async () => {
    // Membership first: a policy can only be filed to a household you are in.
    shareIntoHousehold('property', 'prop-x', ALICE);
    const { body: policy } = await createAs(ALICE, { name: 'House', linked_type: 'household', linked_id: HH });
    await record(ALICE, {
      policy_id: policy.id, premium_amount: 1200, effective_date: '2025-12-01',
    });

    // Bob sees the household policy…
    const bobView = await listAs(BOB);
    expect(bobView.policies.map(p => p.id)).toEqual([policy.id]);
    // …and none of what Alice has paid for it over the years.
    expect(bobView.history).toEqual([]);
  });

  it('a deleted record goes, and the premium on the policy stays', async () => {
    const { body: policy } = await createAs(ALICE, { name: 'House', premium_amount: 1500 });
    const { body: rec } = await record(ALICE, {
      policy_id: policy.id, premium_amount: 1200, effective_date: '2025-12-01',
    });
    const res = await fetch(`${base}/history/${rec.id}`, { method: 'DELETE', headers: auth(ALICE) });
    expect(res.status).toBe(200);
    const after = await listAs(ALICE);
    expect(after.history).toEqual([]);
    expect(after.policies[0].premium_amount).toBe(1500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Linking to assets and documents
// ═════════════════════════════════════════════════════════════════════════════
describe('what a policy covers', () => {
  it('covers a property the user owns', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE, name: 'Home' });
    const { status, body } = await createAs(ALICE, {
      name: 'House', linked_type: 'property', linked_id: 'prop-1',
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ linked_type: 'property', linked_id: 'prop-1' });
  });

  it('cannot cover a stranger\'s property — and is told 404, not 403', async () => {
    tableOf('properties').push({ id: 'prop-9', user_id: BOB, name: 'Their house' });
    const res = await createAs(ALICE, { name: 'Cheeky', linked_type: 'property', linked_id: 'prop-9' });
    expect(res.status).toBe(404);
    expect((await listAs(ALICE)).policies).toEqual([]);
  });

  it('cannot be filed to a household the user is not in', async () => {
    const res = await createAs(ALICE, { name: 'Family health', linked_type: 'household', linked_id: HH });
    expect(res.status).toBe(403);
  });

  it('refuses half a link', async () => {
    expect((await createAs(ALICE, { name: 'X', linked_type: 'property' })).status).toBe(400);
  });

  it('attaches a document the user owns', async () => {
    tableOf('documents').push({ id: 'doc-1', user_id: ALICE, name: 'Policy PDF' });
    const { status, body } = await createAs(ALICE, { name: 'House', document_id: 'doc-1' });
    expect(status).toBe(201);
    expect(body.document_id).toBe('doc-1');
  });

  it('refuses a document belonging to somebody else', async () => {
    tableOf('documents').push({ id: 'doc-2', user_id: BOB, name: 'Their PDF' });
    const res = await createAs(ALICE, { name: 'House', document_id: 'doc-2' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('your own documents');
  });

  it('refuses a document that does not exist', async () => {
    expect((await createAs(ALICE, { name: 'House', document_id: 'doc-nope' })).status).toBe(404);
  });

  it('un-linking is allowed and takes the policy back to personal', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE, name: 'Home' });
    const { body } = await createAs(ALICE, {
      name: 'House', linked_type: 'property', linked_id: 'prop-1',
    });
    const { body: unlinked } = await updateAs(ALICE, body.id as string, {
      linked_type: null, linked_id: null,
    });
    expect(unlinked.linked_type).toBeNull();
    expect(unlinked.household_ids).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Sharing — the whole point of the link
// ═════════════════════════════════════════════════════════════════════════════
describe('sharing', () => {
  it('a policy on a shared property is visible to the household, and carries its households', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE, name: 'Home' });
    shareIntoHousehold('property', 'prop-1', ALICE);

    const { body: policy } = await createAs(ALICE, {
      name: 'House cover', linked_type: 'property', linked_id: 'prop-1',
    });
    // The household ids come from the PROPERTY, not from the policy — which is
    // what lets the client scope it with no special case.
    expect(policy.household_ids).toEqual([HH]);

    const bobView = await listAs(BOB);
    expect(bobView.policies.map(p => p.id)).toEqual([policy.id]);
    expect(bobView.policies[0].household_ids).toEqual([HH]);
  });

  it('a personal policy stays personal even between household members', async () => {
    shareIntoHousehold('property', 'prop-1', ALICE);
    await createAs(ALICE, { name: 'Private life cover' });
    expect((await listAs(BOB)).policies).toEqual([]);
  });

  it('un-sharing the property revokes its cover in the same instant', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE, name: 'Home' });
    shareIntoHousehold('property', 'prop-1', ALICE);
    await createAs(ALICE, { name: 'House cover', linked_type: 'property', linked_id: 'prop-1' });
    expect((await listAs(BOB)).policies).toHaveLength(1);

    // One delete against the sharing join. Nothing touches the policy at all.
    db.tables.set('record_households', []);
    expect((await listAs(BOB)).policies).toEqual([]);
  });

  it('a member can SEE the shared cover and cannot change it (403)', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE, name: 'Home' });
    shareIntoHousehold('property', 'prop-1', ALICE);
    const { body } = await createAs(ALICE, {
      name: 'House cover', linked_type: 'property', linked_id: 'prop-1', premium_amount: 1200,
    });

    const edit = await updateAs(BOB, body.id as string, { premium_amount: 1 });
    expect(edit.status).toBe(403);
    const del = await deleteAs(BOB, body.id as string);
    expect(del.status).toBe(403);
    // Untouched.
    expect((await listAs(ALICE)).policies[0].premium_amount).toBe(1200);
  });

  it('a household-linked policy is visible to every member', async () => {
    tableOf('household_members').push(
      { household_id: HH, user_id: ALICE, role: 'owner', status: 'active' },
      { household_id: HH, user_id: BOB, role: 'member', status: 'active' },
    );
    const { body } = await createAs(ALICE, {
      name: 'Family health', policy_type: 'health', linked_type: 'household', linked_id: HH,
    });
    expect(body.household_ids).toEqual([HH]);
    expect((await listAs(BOB)).policies.map(p => p.id)).toEqual([body.id]);
  });

  it('a member whose membership ends stops seeing the cover', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE, name: 'Home' });
    shareIntoHousehold('property', 'prop-1', ALICE);
    await createAs(ALICE, { name: 'House cover', linked_type: 'property', linked_id: 'prop-1' });
    expect((await listAs(BOB)).policies).toHaveLength(1);

    // Membership is checked by STATUS on every request — no sweep, no cache.
    for (const m of tableOf('household_members')) {
      if (m.user_id === BOB) m.status = 'removed';
    }
    expect((await listAs(BOB)).policies).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('user isolation', () => {
  it('one user never sees another\'s policies', async () => {
    await createAs(ALICE, { name: 'Alice house' });
    await createAs(BOB, { name: 'Bob car' });
    expect((await listAs(ALICE)).policies.map(p => p.name)).toEqual(['Alice house']);
    expect((await listAs(BOB)).policies.map(p => p.name)).toEqual(['Bob car']);
  });

  it('holding the id is not enough: edit and delete both answer 404', async () => {
    const { body } = await createAs(ALICE, { name: 'Alice house' });
    expect((await updateAs(BOB, body.id as string, { name: 'mine now' })).status).toBe(404);
    expect((await deleteAs(BOB, body.id as string)).status).toBe(404);
    expect((await listAs(ALICE)).policies[0].name).toBe('Alice house');
  });

  it('a missing policy answers 404, exactly like an invisible one', async () => {
    expect((await updateAs(ALICE, 'no-such-id', { name: 'x' })).status).toBe(404);
    expect((await deleteAs(ALICE, 'no-such-id')).status).toBe(404);
  });

  it('needs a token at all', async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { method: 'POST' })).status).toBe(401);
  });
});
