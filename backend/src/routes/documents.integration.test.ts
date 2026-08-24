/**
 * Phase 8.1 — the vault end to end through the REAL router.
 *
 * The unit tests (services/documentVault.test.ts) prove the decisions; these
 * prove the wiring: real Express, real multer multipart parsing, real JWTs,
 * real route handlers — over an in-memory Supabase fake whose `.or()` filter
 * actually evaluates PostgREST syntax, so the visibility filter is tested
 * against the semantics it will meet in production, not against a stub that
 * agrees with it by construction.
 *
 * What the user asked to be sure of, each pinned below:
 *   uploads · links · multiple files · deletion · sharing · persistence ·
 *   user isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

// ── The in-memory Supabase ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface FakeDB { tables: Map<string, Row[]> }
interface FakeStorage { objects: Map<string, { buffer: Buffer; contentType: string }> }

const db: FakeDB = { tables: new Map() };
const storage: FakeStorage = { objects: new Map() };

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

class FakeQuery {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private eqs: [string, unknown][] = [];
  private ins: [string, unknown[]][] = [];
  private orExpr: string | null = null;
  private payload: Row | Row[] | null = null;

  constructor(private table: string) {}

  select(_cols?: string) { if (this.op === 'select' && !this.payload) this.op = 'select'; return this; }
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
      const stamped = rows.map(r => ({ created_at: new Date().toISOString(), ...r }));
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
  supabase: {
    from: (table: string) => new FakeQuery(table),
    storage: {
      createBucket: async () => ({ error: null }),
      from: (_bucket: string) => ({
        upload: async (path: string, buffer: Buffer, opts: { contentType: string }) => {
          if (storage.objects.has(path)) return { error: { message: 'The resource already exists' } };
          storage.objects.set(path, { buffer, contentType: opts.contentType });
          return { data: { path }, error: null };
        },
        download: async (path: string) => {
          const hit = storage.objects.get(path);
          if (!hit) return { data: null, error: { message: 'Object not found' } };
          return {
            data: { arrayBuffer: async () => hit.buffer.buffer.slice(hit.buffer.byteOffset, hit.buffer.byteOffset + hit.buffer.byteLength) },
            error: null,
          };
        },
        remove: async (paths: string[]) => { paths.forEach(p => storage.objects.delete(p)); return { data: null, error: null }; },
      }),
    },
  },
  getSupabase: () => { throw new Error('not used here'); },
  upsertTolerant: () => { throw new Error('not used here'); },
}));

// The model, faked. Every test below decides what the "document" appears to
// say, so what is being proven is the GATE and the wiring around it — never
// Claude's reading.
const modelSays = vi.hoisted(() => ({ value: null as unknown, fail: null as string | null }));
vi.mock('../services/claudeService', () => ({
  extractDocumentFacts: async () => {
    if (modelSays.fail) throw new Error(modelSays.fail);
    return modelSays.value;
  },
}));

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-key';

import documentsRouter from './documents';

// ── A real server on a real port ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/documents', documentsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/documents`;

const ALICE = 'a0000000-0000-0000-0000-00000000000a';
const BOB   = 'b0000000-0000-0000-0000-00000000000b';
const HH    = 'h0000000-0000-0000-0000-00000000000h';

const tokenFor = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@x.test`, plan: 'free' }, process.env.JWT_SECRET ?? 'dev-secret');

const auth = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });

async function uploadAs(userId: string, files: { name: string; content: string; type?: string }[], meta: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.content], { type: f.type ?? 'application/pdf' }), f.name);
  for (const [k, v] of Object.entries(meta)) form.append(k, v);
  const res = await fetch(base, { method: 'POST', headers: auth(userId), body: form });
  return { status: res.status, body: await res.json() as { documents?: Row[]; error?: string } };
}

async function listAs(userId: string): Promise<Row[]> {
  const res = await fetch(base, { headers: auth(userId) });
  expect(res.status).toBe(200);
  return await res.json() as Row[];
}

beforeEach(() => {
  db.tables.clear();
  storage.objects.clear();
});

// ── Uploads, multiple files, persistence ─────────────────────────────────────

describe('uploads', () => {
  it('a single upload persists its metadata AND its bytes, and comes back on the next read', async () => {
    const { status, body } = await uploadAs(ALICE, [{ name: 'Oct statement.pdf', content: '%PDF-fake' }], {
      document_type: 'statement', provider: 'CommBank', document_date: '2026-07-31', notes: 'joint',
    });
    expect(status).toBe(201);
    const doc = body.documents![0];
    expect(doc.document_type).toBe('statement');
    expect(doc.provider).toBe('CommBank');
    expect(doc.document_date).toBe('2026-07-31');
    expect(doc.user_id).toBe(ALICE);

    // Persistence: a fresh GET (a "new device") sees the same document…
    const listed = await listAs(ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(doc.id);

    // …and the bytes round-trip through the authenticated file endpoint.
    const file = await fetch(`${base}/${doc.id}/file`, { headers: auth(ALICE) });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('%PDF-fake');
    expect(file.headers.get('content-type')).toContain('application/pdf');
  });

  it('several files in one act become individually-owned documents', async () => {
    const { status, body } = await uploadAs(ALICE, [
      { name: 'July payslip.pdf', content: 'a' },
      { name: 'August payslip.pdf', content: 'b' },
      { name: 'September payslip.pdf', content: 'c' },
    ], { document_type: 'payslip' });
    expect(status).toBe(201);
    expect(body.documents).toHaveLength(3);
    const names = body.documents!.map(d => d.name);
    expect(names).toContain('July payslip.pdf');
    expect(names).toContain('September payslip.pdf');
    // Three separate storage objects, each under the owner's prefix.
    expect(storage.objects.size).toBe(3);
    for (const path of storage.objects.keys()) expect(path.startsWith(`${ALICE}/`)).toBe(true);
  });

  it('refuses a file that is not financial paperwork', async () => {
    const { status, body } = await uploadAs(ALICE,
      [{ name: 'totally-a-statement.exe', content: 'MZ', type: 'application/x-msdownload' }]);
    expect(status).toBe(400);
    expect(body.error).toContain('x-msdownload');
    expect(storage.objects.size).toBe(0);
  });

  it('refuses to file against a record that does not exist', async () => {
    const { status } = await uploadAs(ALICE, [{ name: 'x.pdf', content: 'x' }],
      { linked_type: 'loan', linked_id: 'no-such-loan' });
    expect(status).toBe(404);
    // Nothing half-created: no row, no orphaned object.
    expect(await listAs(ALICE)).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });
});

// ── Links ────────────────────────────────────────────────────────────────────

describe('links', () => {
  it('files against your own loan, and the link survives the round trip', async () => {
    tableOf('loans').push({ id: 'loan-1', user_id: ALICE });
    const { status, body } = await uploadAs(ALICE, [{ name: 'contract.pdf', content: 'x' }],
      { document_type: 'loan', linked_type: 'loan', linked_id: 'loan-1' });
    expect(status).toBe(201);
    expect(body.documents![0].linked_type).toBe('loan');
    expect(body.documents![0].linked_id).toBe('loan-1');
  });

  it("refuses a stranger's record with NOT FOUND — ids can't be probed", async () => {
    tableOf('loans').push({ id: 'loan-bob', user_id: BOB });
    const { status } = await uploadAs(ALICE, [{ name: 'x.pdf', content: 'x' }],
      { linked_type: 'loan', linked_id: 'loan-bob' });
    expect(status).toBe(404);
  });

  it('re-links via PATCH, and the smuggled server-owned columns never land', async () => {
    tableOf('properties').push({ id: 'prop-1', user_id: ALICE });
    const { body } = await uploadAs(ALICE, [{ name: 'rates.pdf', content: 'x' }]);
    const doc = body.documents![0];

    const res = await fetch(`${base}/${doc.id}`, {
      method: 'PATCH',
      headers: { ...auth(ALICE), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Rates notice 2026', linked_type: 'property', linked_id: 'prop-1',
        user_id: BOB, storage_path: 'stolen', size_bytes: 1,
      }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as Row;
    expect(updated.name).toBe('Rates notice 2026');
    expect(updated.linked_type).toBe('property');
    expect(updated.user_id).toBe(ALICE);          // not BOB
    expect(updated.storage_path).not.toBe('stolen');
  });
});

// ── Sharing ──────────────────────────────────────────────────────────────────

describe('sharing', () => {
  const joinHousehold = (userId: string, role = 'member') =>
    tableOf('household_members').push({ household_id: HH, user_id: userId, role, status: 'active' });

  it('a household-filed document reaches every member — to look at, never to change', async () => {
    joinHousehold(ALICE, 'owner');
    joinHousehold(BOB, 'member');

    const { status, body } = await uploadAs(ALICE, [{ name: 'home policy.pdf', content: 'policy' }],
      { document_type: 'insurance', linked_type: 'household', linked_id: HH });
    expect(status).toBe(201);
    const doc = body.documents![0];

    // Bob sees it and can read the bytes…
    const bobList = await listAs(BOB);
    expect(bobList.map(d => d.id)).toContain(doc.id);
    const file = await fetch(`${base}/${doc.id}/file`, { headers: auth(BOB) });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('policy');

    // …but cannot rename or delete what is not his: visible → an honest 403.
    const patch = await fetch(`${base}/${doc.id}`, {
      method: 'PATCH', headers: { ...auth(BOB), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mine now' }),
    });
    expect(patch.status).toBe(403);
    const del = await fetch(`${base}/${doc.id}`, { method: 'DELETE', headers: auth(BOB) });
    expect(del.status).toBe(403);
  });

  it('a document follows its record: shared account → shared paperwork; un-share → gone', async () => {
    joinHousehold(ALICE, 'owner');
    joinHousehold(BOB, 'member');
    tableOf('bank_accounts').push({ id: 'acc-1', user_id: ALICE });
    tableOf('record_households').push({
      record_type: 'account', record_id: 'acc-1', household_id: HH, owner_user_id: ALICE,
    });

    const { body } = await uploadAs(ALICE, [{ name: 'acc statement.pdf', content: 's' }],
      { document_type: 'statement', linked_type: 'account', linked_id: 'acc-1' });
    const doc = body.documents![0];

    expect((await listAs(BOB)).map(d => d.id)).toContain(doc.id);

    // Un-share the ACCOUNT — its paperwork goes back in the same instant.
    db.tables.set('record_households', []);
    expect((await listAs(BOB)).map(d => d.id)).not.toContain(doc.id);
    const file = await fetch(`${base}/${doc.id}/file`, { headers: auth(BOB) });
    expect(file.status).toBe(404);
  });

  it('an outsider must not file documents INTO the household', async () => {
    joinHousehold(ALICE, 'owner');
    const { status } = await uploadAs(BOB, [{ name: 'x.pdf', content: 'x' }],
      { linked_type: 'household', linked_id: HH });
    expect(status).toBe(403);
  });

  it('a tax-year document stays personal even inside a shared household', async () => {
    joinHousehold(ALICE, 'owner');
    joinHousehold(BOB, 'member');
    const { body } = await uploadAs(ALICE, [{ name: 'notice of assessment.pdf', content: 'noa' }],
      { document_type: 'tax', linked_type: 'tax_year', linked_id: '2025-2026' });
    expect((await listAs(BOB)).map(d => d.id)).not.toContain(body.documents![0].id);
  });
});

// ── Deletion ─────────────────────────────────────────────────────────────────

describe('deletion', () => {
  it('the owner deletes: the row AND the stored bytes both go', async () => {
    const { body } = await uploadAs(ALICE, [{ name: 'old.pdf', content: 'x' }]);
    const doc = body.documents![0];
    expect(storage.objects.size).toBe(1);

    const del = await fetch(`${base}/${doc.id}`, { method: 'DELETE', headers: auth(ALICE) });
    expect(del.status).toBe(200);
    expect(await listAs(ALICE)).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });
});

// ── User isolation ───────────────────────────────────────────────────────────

describe('user isolation', () => {
  it("one user's vault never shows, serves, edits or deletes another's documents", async () => {
    const { body } = await uploadAs(ALICE, [{ name: 'private.pdf', content: 'secret' }]);
    const doc = body.documents![0];

    // Not in Bob's list…
    expect(await listAs(BOB)).toHaveLength(0);

    // …and unreachable even with the id in hand: uniformly NOT FOUND, so an id
    // is never an oracle for someone else's paperwork.
    for (const attempt of [
      fetch(`${base}/${doc.id}/file`, { headers: auth(BOB) }),
      fetch(`${base}/${doc.id}`, {
        method: 'PATCH', headers: { ...auth(BOB), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'taken' }),
      }),
      fetch(`${base}/${doc.id}`, { method: 'DELETE', headers: auth(BOB) }),
    ]) {
      expect((await attempt).status).toBe(404);
    }

    // Alice's document is untouched by all of it.
    const still = await listAs(ALICE);
    expect(still).toHaveLength(1);
    expect(still[0].name).toBe('private.pdf');
  });

  it('no token, no vault', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(401);
  });
});

// ── Phase 8.3: reading what a document says ──────────────────────────────────

describe('reading a document', () => {
  const extract = (userId: string, docId: string) =>
    fetch(`${base}/${docId}/extract`, { method: 'POST', headers: auth(userId) });

  const factsFor = async (userId: string): Promise<Row[]> => {
    const res = await fetch(`${base}/facts`, { headers: auth(userId) });
    expect(res.status).toBe(200);
    return await res.json() as Row[];
  };

  const uploadPolicy = async (userId: string, meta: Record<string, string> = {}) => {
    const { body } = await uploadAs(userId, [{ name: 'NRMA policy.pdf', content: '%PDF-policy' }],
      { document_type: 'insurance', provider: 'NRMA', ...meta });
    return body.documents![0];
  };

  beforeEach(() => { modelSays.value = null; modelSays.fail = null; });

  it('stores what the document says, with the words it said it in', async () => {
    const doc = await uploadPolicy(ALICE);
    modelSays.value = { fields: [
      { field: 'renewal_date', value: '3 March 2027', quote: 'Period of cover ends 3 March 2027', page: 1, confidence: 0.94 },
      { field: 'premium_amount', value: '1240.50', quote: 'Total premium $1,240.50', page: 1, confidence: 0.91 },
      { field: 'excess', value: '750', quote: 'Excess payable per claim: $750', page: 2, confidence: 0.88 },
    ] };

    const res = await extract(ALICE, doc.id as string);
    expect(res.status).toBe(200);
    const body = await res.json() as { facts: Row[]; discarded: Row[]; status: string };
    expect(body.status).toBe('read');
    expect(body.discarded).toEqual([]);

    const byField = Object.fromEntries(body.facts.map(f => [f.field, f]));
    expect(byField.renewal_date).toMatchObject({
      value_date: '2027-03-03', quote: 'Period of cover ends 3 March 2027', page: 1,
      source: 'model', status: 'unconfirmed',
    });
    expect(Number(byField.premium_amount.value_number)).toBe(1240.5);
    expect(Number(byField.excess.value_number)).toBe(750);

    // The document itself now remembers that it has been read — "nothing
    // found" and "never looked" must never look the same afterwards.
    const listed = await listAs(ALICE);
    expect(listed[0].extraction_status).toBe('read');
  });

  it('throws away a value the quote does not support, and says it did', async () => {
    const doc = await uploadPolicy(ALICE);
    modelSays.value = { fields: [
      { field: 'premium_amount', value: '1240', quote: 'Total premium $1,420.00', confidence: 0.99 },
      { field: 'coverage_amount', value: '650000', confidence: 0.99 },
    ] };

    const res = await extract(ALICE, doc.id as string);
    const body = await res.json() as { facts: Row[]; discarded: { field: string; reason: string }[]; status: string };
    expect(body.facts).toHaveLength(0);
    expect(body.status).toBe('nothing-found');
    expect(body.discarded.map(d => d.field).sort()).toEqual(['coverage_amount', 'premium_amount']);
    expect(await factsFor(ALICE)).toHaveLength(0);
  });

  it('only reads the kinds of document it says it reads', async () => {
    const { body } = await uploadAs(ALICE, [{ name: 'coffee.jpg', content: 'x', type: 'image/jpeg' }],
      { document_type: 'receipt' });
    const res = await extract(ALICE, body.documents![0].id as string);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/insurance, loan, statement/);
    expect(await factsFor(ALICE)).toHaveLength(0);
  });

  it('lets a household member look, and only the owner have it read', async () => {
    tableOf('household_members').push({ household_id: HH, user_id: ALICE, role: 'owner', status: 'active' });
    tableOf('household_members').push({ household_id: HH, user_id: BOB, role: 'member', status: 'active' });
    const doc = await uploadPolicy(ALICE, { linked_type: 'household', linked_id: HH });

    modelSays.value = { fields: [
      { field: 'insurer', value: 'NRMA Insurance', quote: 'Insurer: NRMA Insurance', confidence: 0.96 },
    ] };

    // Bob can see the file (Phase 8.1) but cannot make Ledger read it aloud.
    expect((await extract(BOB, doc.id as string)).status).toBe(403);

    await extract(ALICE, doc.id as string);
    // …and once it is read, Bob sees the facts, because the facts follow the
    // document and the document is filed to his household.
    expect((await factsFor(BOB)).map(f => f.field)).toEqual(['insurer']);
  });

  it('keeps one user\'s facts out of another user\'s reach', async () => {
    const doc = await uploadPolicy(ALICE);
    modelSays.value = { fields: [
      { field: 'insurer', value: 'NRMA', quote: 'Insurer: NRMA', confidence: 0.96 },
    ] };
    await extract(ALICE, doc.id as string);

    expect(await factsFor(ALICE)).toHaveLength(1);
    expect(await factsFor(BOB)).toHaveLength(0);
    expect((await extract(BOB, doc.id as string)).status).toBe(404);
  });

  it('takes the user\'s word over the model\'s, and refuses a value it cannot read', async () => {
    const doc = await uploadPolicy(ALICE);
    modelSays.value = { fields: [
      { field: 'renewal_date', value: '3 March 2027', quote: 'Cover ends 3 March 2027', confidence: 0.6 },
    ] };
    await extract(ALICE, doc.id as string);
    const fact = (await factsFor(ALICE))[0];

    const bad = await fetch(`${base}/facts/${fact.id}`, {
      method: 'PATCH', headers: { ...auth(ALICE), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'next autumn' }),
    });
    expect(bad.status).toBe(400);

    const good = await fetch(`${base}/facts/${fact.id}`, {
      method: 'PATCH', headers: { ...auth(ALICE), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: '2027-04-03' }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({
      value_date: '2027-04-03', source: 'user', status: 'confirmed', confidence: 1,
    });
  });

  it('does not overturn a verdict by re-reading the file', async () => {
    const doc = await uploadPolicy(ALICE);
    modelSays.value = { fields: [
      { field: 'excess', value: '750', quote: 'Excess: $750', confidence: 0.9 },
    ] };
    await extract(ALICE, doc.id as string);
    const fact = (await factsFor(ALICE))[0];

    await fetch(`${base}/facts/${fact.id}`, {
      method: 'PATCH', headers: { ...auth(ALICE), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });

    // A second reading, more confident and differently wrong.
    modelSays.value = { fields: [
      { field: 'excess', value: '1000', quote: 'Excess: $1,000', confidence: 0.99 },
    ] };
    await extract(ALICE, doc.id as string);

    const after = await factsFor(ALICE);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: fact.id, status: 'rejected', value_text: '750' });
  });

  it('records a failed reading as a failure, and stores nothing', async () => {
    const doc = await uploadPolicy(ALICE);
    modelSays.fail = 'upstream is down';
    const res = await extract(ALICE, doc.id as string);
    expect(res.status).toBe(502);
    expect(await factsFor(ALICE)).toHaveLength(0);
    expect((await listAs(ALICE))[0].extraction_status).toBe('failed');
  });
});
