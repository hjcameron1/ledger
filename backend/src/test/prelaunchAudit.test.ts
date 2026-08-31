/**
 * PRE-LAUNCH AUDIT — four users, three overlapping households, every share
 * shape, driven through the REAL routers.
 *
 * This is the server half of the audit. It exists because the client engines
 * decide what to SHOW and this decides what a request is ALLOWED to see: a bug
 * in the first shows the wrong number, a bug here shows the wrong person's
 * money.
 *
 * What is proven, per the audit brief:
 *   · no duplicate money                 — a row in two households arrives once
 *   · no cross-user/household leakage    — every list matches an INDEPENDENT oracle
 *   · every member sees the same figures — byte-for-byte across members
 *   · private money stays private        — and is not even acknowledged (404, not 403)
 *   · sharing never moves ownership      — user_id and net worth are untouched
 *   · revoked access disappears at once  — a second live session loses it on its next read
 *
 * The oracle in `visibleOracle()` is written from the product rules and reads
 * only the raw tables. It never calls `visibilityFilter`, so the two cannot
 * agree by construction.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

import {
  db, resetDb, resetIds, seed, table, uniqueOn, fakeSupabase, upsertTolerant, type Row,
} from './fakeSupabase';
import * as W from './prelaunchAudit.world';

// ── The world's dependencies, stubbed at the edges only ──────────────────────

vi.mock('../utils/supabase', async () => {
  const mod = await import('./fakeSupabase');
  return { supabase: mod.fakeSupabase, getSupabase: () => mod.fakeSupabase, upsertTolerant: mod.upsertTolerant };
});

// Prices and the market are not what this audit is about; freezing them keeps
// every figure below deterministic and keeps the suite off the network.
vi.mock('../services/priceService', () => ({
  fetchCurrentPrice: async () => null,
  searchTicker: async () => [],
  isMetal: () => false,
  fetchMetalSpotPerUnit: async () => null,
  fetchDealerPricePerUnit: async () => null,
  refreshStaleHoldings: async () => undefined,
  updateAllInvestmentPrices: async () => undefined,
  fetchDividends: async () => [],
  getYahooTicker: (t: string) => t,
}));
vi.mock('../services/metalScraper', () => ({ scrapeAllDealers: async () => undefined }));
vi.mock('../services/claudeService', () => ({
  extractDocumentFacts: async () => null,
  parseTransactionText: async () => null,
}));
vi.mock('../services/telegramService', () => ({
  sendTelegramMessage: async () => undefined,
  notifyUser: async () => undefined,
}));

// Any real HTTP would mean an un-seeded FX pair; make that loud rather than slow.
vi.mock('axios', () => ({
  default: { get: async () => { throw new Error('audit: no network'); },
             post: async () => { throw new Error('audit: no network'); } },
}));

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'audit-secret';

import accountsRouter from '../routes/accounts';
import loansRouter from '../routes/loans';
import propertiesRouter from '../routes/properties';
import investmentsRouter from '../routes/investments';
import overviewRouter from '../routes/overview';
import householdsRouter from '../routes/households';
import sharesRouter from '../routes/shares';
import documentsRouter from '../routes/documents';
import incomeRouter from '../routes/income';
import insuranceRouter from '../routes/insurance';
import smsfRouter from '../routes/smsf';
import settingsRouter from '../routes/settings';
import { computeNetWorth } from '../services/netWorthSnapshot';

// ── A real server on a real port ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/accounts', accountsRouter);
app.use('/api/loans', loansRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/investments', investmentsRouter);
app.use('/api/overview', overviewRouter);
app.use('/api/households', householdsRouter);
app.use('/api/shares', sharesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/income', incomeRouter);
app.use('/api/insurance', insuranceRouter);
app.use('/api/smsf', smsfRouter);
app.use('/api/settings', settingsRouter);

let base = '';
beforeAll(() => {
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

const tokenFor = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@audit.test`, plan: 'free' }, process.env.JWT_SECRET!);

/** One "session" — a device holding a token. Two sessions for the same user are
 *  two independent readers, which is what the revoke-while-open cases need. */
const auth = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });

async function GET(userId: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: auth(userId) });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as never };
}

async function SEND(userId: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...auth(userId), 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as never };
}

const ids = (rows: { id?: unknown }[] | undefined) => (rows ?? []).map(r => String(r.id)).sort();

// ── The world ────────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().split('T')[0];

function buildWorld(): void {
  resetDb();
  resetIds();

  // The unique indexes duplicate prevention actually rests on.
  uniqueOn('record_households', ['record_type', 'record_id', 'household_id']);

  seed('users', W.USERS.map(u => ({ ...u, theme: 'light', plan: 'free', onboarding_complete: true, email_verified: true })));
  seed('households', W.HOUSEHOLDS);
  seed('household_members', W.MEMBERSHIPS.map((m, i) => ({
    id: `m0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ...m,
  })));
  seed('bank_accounts', W.ACCOUNTS);
  seed('credit_cards', W.CARDS);
  seed('loans', W.LOANS);
  seed('properties', W.PROPERTIES);
  seed('investments', W.INVESTMENTS);
  seed('goals', W.GOALS);
  seed('budgets', W.BUDGETS);
  seed('bills', W.BILLS);
  seed('documents', W.DOCUMENTS);
  seed('income_entries', W.INCOME);
  seed('transactions', W.TRANSACTIONS);
  seed('super_funds', W.SUPER_FUNDS);
  seed('insurance_policies', W.INSURANCE);
  seed('record_households', W.RECORD_HOUSEHOLDS);
  seed('record_shares', W.RECORD_SHARES);
  seed('exchange_rates', W.EXCHANGE_RATES(TODAY));

  for (const d of W.DOCUMENTS) db.storage.set(String(d.storage_path), { buffer: Buffer.from('%PDF-audit'), contentType: 'application/pdf' });
}

beforeEach(buildWorld);

// ── The oracle ───────────────────────────────────────────────────────────────
//
// "What may this user see?", derived from the raw tables and the stated product
// rules — never from the application's own filter.

const TABLE_OF: Record<string, string> = {
  account: 'bank_accounts', card: 'credit_cards', transaction: 'transactions',
  loan: 'loans', property: 'properties', budget: 'budgets', goal: 'goals',
  investment: 'investments', income: 'income_entries', bill: 'bills', document: 'documents',
};

function activeHouseholdsOf(userId: string): string[] {
  return W.MEMBERSHIPS.filter(m => m.user_id === userId && m.status === 'active').map(m => m.household_id);
}

function roleOf(userId: string, householdId: string): string | null {
  return W.MEMBERSHIPS.find(m => m.user_id === userId && m.household_id === householdId && m.status === 'active')?.role ?? null;
}

/** Rows of `type` shared into ANY household this user is actively in. */
function householdVisibleIds(userId: string, type: string): Set<string> {
  const mine = new Set(activeHouseholdsOf(userId));
  return new Set(table('record_households')
    .filter(r => r.record_type === type && mine.has(String(r.household_id)))
    .map(r => String(r.record_id)));
}

/** Rows of `type` granted to this user directly and still live. */
function grantedIds(userId: string, type: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of table('record_shares')) {
    if (s.record_type === type && s.shared_with_user_id === userId && s.status === 'active') {
      out.set(String(s.record_id), String(s.permission));
    }
  }
  return out;
}

/** THE oracle: every id of `type` this user may see, and why. */
function visibleOracle(userId: string, type: string): Set<string> {
  const rows = table(TABLE_OF[type]);
  const hh = householdVisibleIds(userId, type);
  const direct = grantedIds(userId, type);
  const out = new Set<string>();

  for (const r of rows) {
    const id = String(r.id);
    if (r.user_id === userId) { out.add(id); continue; }
    if (hh.has(id) || direct.has(id)) { out.add(id); continue; }
    // A document FOLLOWS THE RECORD IT IS FILED AGAINST — the vault's stated law.
    if (type === 'document' && r.linked_type && r.linked_id) {
      const lt = String(r.linked_type);
      const lid = String(r.linked_id);
      if (lt === 'household' && activeHouseholdsOf(userId).includes(lid)) { out.add(id); continue; }
      if (TABLE_OF[lt] && visibleOracle(userId, lt).has(lid)) { out.add(id); continue; }
    }
    // The one derived cascade: an account brings what happened on it, however it
    // was shared. Household shares of ACCOUNTS cascade too (visibilityFilter
    // includes householdRecords for account/card), direct grants likewise.
    if (type === 'transaction' && r.account_id) {
      const acct = String(r.account_id);
      const reachable =
        householdVisibleIds(userId, 'account').has(acct) ||
        householdVisibleIds(userId, 'card').has(acct) ||
        grantedIds(userId, 'account').has(acct) ||
        grantedIds(userId, 'card').has(acct);
      if (reachable) out.add(id);
    }
  }
  return out;
}

const ALL = [W.ADA, W.BO, W.CY, W.DI];
const NAME: Record<string, string> = { [W.ADA]: 'Ada', [W.BO]: 'Bo', [W.CY]: 'Cy', [W.DI]: 'Di' };

// The endpoints that answer with a shareable list, and how to reach the rows.
const LISTS: { type: string; path: string; pick: (b: never) => Row[] }[] = [
  { type: 'account', path: '/accounts', pick: b => b as unknown as Row[] },
  { type: 'card', path: '/accounts/credit-cards', pick: b => b as unknown as Row[] },
  { type: 'transaction', path: '/accounts/transactions?limit=500', pick: b => b as unknown as Row[] },
  { type: 'loan', path: '/loans', pick: b => b as unknown as Row[] },
  { type: 'property', path: '/properties', pick: b => b as unknown as Row[] },
  { type: 'investment', path: '/investments', pick: b => (b as unknown as { investments: Row[] }).investments },
  { type: 'goal', path: '/overview/goals', pick: b => b as unknown as Row[] },
  { type: 'budget', path: '/overview/budget', pick: b => b as unknown as Row[] },
  { type: 'bill', path: '/overview/bills', pick: b => b as unknown as Row[] },
  { type: 'document', path: '/documents', pick: b => b as unknown as Row[] },
  { type: 'income', path: '/income', pick: b => (b as unknown as { entries: Row[] }).entries },
];

// ─────────────────────────────────────────────────────────────────────────────
describe('A · what each user may see, against an independent oracle', () => {
  for (const user of ALL) {
    for (const list of LISTS) {
      it(`${NAME[user]} · ${list.type}s — exactly the rows the rules allow, no more and no fewer`, async () => {
        const res = await GET(user, list.path);
        expect(res.status).toBe(200);
        const rows = list.pick(res.body);
        expect(Array.isArray(rows)).toBe(true);
        expect(ids(rows)).toEqual([...visibleOracle(user, list.type)].sort());
      });
    }
  }
});

describe('B · no duplicate money', () => {
  it('a card shared into TWO households reaches a member of both exactly once', async () => {
    // A_CARD is in RIVER and COAST; Bo is a member of both.
    expect(activeHouseholdsOf(W.BO).sort()).toEqual([W.HH_RIVER, W.HH_COAST].sort());
    const { body } = await GET(W.BO, '/accounts/credit-cards');
    const hits = (body as unknown as Row[]).filter(c => c.id === W.A_CARD);
    expect(hits).toHaveLength(1);
  });

  it('an account shared into two households reaches its own owner once, not twice', async () => {
    const { body } = await GET(W.DI, '/accounts');
    expect((body as unknown as Row[]).filter(a => a.id === W.D_JOINT)).toHaveLength(1);
  });

  it('a row reachable BOTH by household share and by direct grant arrives once', async () => {
    // Grant Cy the account he can already see through KIN.
    await SEND(W.CY, 'POST', '/shares/codes', { record_type: 'account', record_id: W.C_EVERYDAY, permission: 'view' });
    // Di can see D_JOINT (owner). Give Cy a direct grant to it as well as the KIN share.
    const code = await SEND(W.DI, 'POST', '/shares/codes', { record_type: 'account', record_id: W.D_JOINT, permission: 'view' });
    expect(code.status).toBe(201);
    const redeem = await SEND(W.CY, 'POST', '/shares/redeem', { code: (code.body as never as { code: Row }).code.code });
    expect(redeem.status).toBe(201);

    const { body } = await GET(W.CY, '/accounts');
    expect((body as unknown as Row[]).filter(a => a.id === W.D_JOINT)).toHaveLength(1);
  });

  it('a shared account is counted in exactly one net worth — its owner’s', async () => {
    const ada = await computeNetWorth(W.ADA);
    const bo = await computeNetWorth(W.BO);
    // A_EVERYDAY (12,000) is shared into RIVER, where Bo is a member.
    expect(ada.bankBalance).toBeGreaterThanOrEqual(12_000);
    // Bo's cash is his own two accounts only: 8,000 + 1,500.
    expect(bo.bankBalance).toBeCloseTo(9_500, 2);
  });
});

describe('C · private money stays private', () => {
  it('an account nobody shared is invisible to all three others', async () => {
    for (const other of [W.BO, W.CY, W.DI]) {
      const { body } = await GET(other, '/accounts');
      expect(ids(body as unknown as Row[])).not.toContain(W.A_HIDDEN);
    }
  });

  it('a REVOKED grant grants nothing — Cy’s private account never reaches Ada', async () => {
    const { body } = await GET(W.ADA, '/accounts');
    expect(ids(body as unknown as Row[])).not.toContain(W.C_PRIVATE);
  });

  it('a REMOVED membership grants nothing — Di sees none of Riverside', async () => {
    const { body } = await GET(W.DI, '/accounts');
    expect(ids(body as unknown as Row[])).not.toContain(W.A_EVERYDAY);
    const loans = await GET(W.DI, '/loans');
    expect(ids(loans.body as unknown as Row[])).not.toContain(W.A_MORTGAGE);
  });

  it('a stranger’s row is not even acknowledged: 404, never 403', async () => {
    // Di is in no household with Ada's hidden account and holds no grant on it.
    const put = await SEND(W.DI, 'PUT', `/accounts/${W.A_HIDDEN}`, { name: 'renamed' });
    expect(put.status).toBe(404);
    const del = await SEND(W.DI, 'DELETE', `/accounts/${W.A_HIDDEN}`);
    expect(del.status).toBe(404);
  });

  it('a household-shared account brings its transactions, and no others', async () => {
    // Stated in both engines: "an account brings what happened on it, however it
    // was shared". A_EVERYDAY is in RIVER, so its rows reach Bo — but nothing
    // sitting on Ada's UNSHARED accounts may come with them.
    const { body } = await GET(W.BO, '/accounts/transactions?limit=500');
    const seen = ids(body as unknown as Row[]);
    expect(seen).toContain(W.T_A_EVERYDAY_1);
    expect(seen).toContain(W.T_A_LOOSE);          // shared on its own
    expect(seen).not.toContain(W.T_A_SAVER_1);    // Ada's saver is not in RIVER
    expect(seen).not.toContain(W.T_A_HIDDEN_1);
    expect(seen).not.toContain(W.T_C_EVERYDAY_1); // Kin, which Bo is not in
  });

  it('a DIRECT account grant does cascade its transactions, and only that account’s', async () => {
    const { body } = await GET(W.CY, '/accounts/transactions?limit=500');
    const seen = ids(body as unknown as Row[]);
    expect(seen).toContain(W.T_A_SAVER_1);       // via the view grant on A_SAVER
    expect(seen).not.toContain(W.T_A_USD_1);     // Di's grant, not Cy's
    expect(seen).not.toContain(W.T_A_HIDDEN_1);
  });
});

describe('D · every household member sees the same shared figures', () => {
  const same = (rows: Row[][], id: string, fields: string[]) => {
    const found = rows.map(list => list.find(r => r.id === id));
    expect(found.every(Boolean)).toBe(true);
    for (const f of fields) {
      const values = found.map(r => (r as Row)[f]);
      expect(new Set(values.map(v => JSON.stringify(v))).size).toBe(1);
    }
  };

  it('Riverside: owner, member and viewer read the same joint account', async () => {
    const lists = await Promise.all([W.ADA, W.BO, W.CY].map(async u =>
      (await GET(u, '/accounts')).body as unknown as Row[]));
    same(lists, W.A_EVERYDAY, ['balance', 'display_balance', 'currency', 'user_id', 'name']);
  });

  it('Riverside: the same mortgage balance, property value, goal and budget', async () => {
    const loans = await Promise.all([W.ADA, W.BO, W.CY].map(async u => (await GET(u, '/loans')).body as unknown as Row[]));
    same(loans, W.A_MORTGAGE, ['current_balance', 'interest_rate', 'minimum_repayment', 'user_id']);

    const props = await Promise.all([W.ADA, W.BO, W.CY].map(async u => (await GET(u, '/properties')).body as unknown as Row[]));
    same(props, W.A_HOUSE, ['current_value', 'purchase_price', 'loan_id', 'user_id']);

    const goals = await Promise.all([W.ADA, W.BO, W.CY].map(async u => (await GET(u, '/overview/goals')).body as unknown as Row[]));
    same(goals, W.A_GOAL, ['target_amount', 'current_amount', 'user_id']);

    const budgets = await Promise.all([W.ADA, W.BO, W.CY].map(async u => (await GET(u, '/overview/budget')).body as unknown as Row[]));
    same(budgets, W.A_BUDGET, ['limit_amount', 'rollover_enabled', 'user_id']);
  });

  it('Kin: owner and member read the same farm and the same USD holding', async () => {
    const props = await Promise.all([W.CY, W.DI].map(async u => (await GET(u, '/properties')).body as unknown as Row[]));
    same(props, W.C_FARM, ['current_value', 'user_id']);

    const invs = await Promise.all([W.CY, W.DI].map(async u =>
      ((await GET(u, '/investments')).body as unknown as { investments: Row[] }).investments));
    same(invs, W.D_USD_STOCK, ['units', 'current_price', 'current_value', 'display_value', 'currency', 'user_id']);
  });

  it('a member’s edit of a shared figure is the same for everyone once accepted', async () => {
    // Bo (member of RIVER) corrects the joint account balance. Direct balance
    // edits divert into a change request; the owner accepts it.
    const put = await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 11_000 });
    expect(put.status).toBe(200);

    const pending = await GET(W.ADA, '/households/change-requests');
    expect(pending.status).toBe(200);
    const reqs = (pending.body as unknown as { requests: Row[] }).requests;
    expect(reqs.length).toBeGreaterThan(0);
    // Until the owner answers, the OWNER's row must not have moved.
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(12_000);
    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${reqs[0].id}/respond`, { accept: true });
    expect(accept.status).toBe(200);

    const lists = await Promise.all([W.ADA, W.BO, W.CY].map(async u => (await GET(u, '/accounts')).body as unknown as Row[]));
    same(lists, W.A_EVERYDAY, ['balance']);
    expect(lists[0].find(a => a.id === W.A_EVERYDAY)!.balance).toBe(11_000);
  });
});

describe('E · sharing never changes whose row it is', () => {
  it('every row still carries its original owner after all the sharing above', async () => {
    for (const [type, tableName] of Object.entries(TABLE_OF)) {
      void type;
      for (const row of table(tableName)) {
        expect(row.user_id, `${tableName}/${row.id} lost its owner`).toBeTruthy();
      }
    }
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.user_id).toBe(W.ADA);
    expect(table('credit_cards').find(c => c.id === W.A_CARD)!.user_id).toBe(W.ADA);
  });

  it('receiving a direct grant does not raise the recipient’s net worth', async () => {
    const before = await computeNetWorth(W.CY);
    const code = await SEND(W.ADA, 'POST', '/shares/codes', { record_type: 'account', record_id: W.A_HIDDEN, permission: 'view' });
    await SEND(W.CY, 'POST', '/shares/redeem', { code: (code.body as never as { code: Row }).code.code });
    const after = await computeNetWorth(W.CY);
    expect(after.netWorth).toBeCloseTo(before.netWorth, 2);
    expect(after.bankBalance).toBeCloseTo(before.bankBalance, 2);
  });

  it('joining a row to a household does not move it into anybody else’s net worth', async () => {
    const before = await computeNetWorth(W.BO);
    // Ada shares her saver into Riverside, where Bo is a member.
    const put = await SEND(W.ADA, 'PUT', `/accounts/${W.A_SAVER}`, { household_ids: [W.HH_RIVER] });
    expect(put.status).toBe(200);
    const after = await computeNetWorth(W.BO);
    expect(after.netWorth).toBeCloseTo(before.netWorth, 2);
  });

  it('un-sharing gives nothing back and takes nothing away from the owner', async () => {
    const before = await computeNetWorth(W.ADA);
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [] });
    const after = await computeNetWorth(W.ADA);
    expect(after.netWorth).toBeCloseTo(before.netWorth, 2);
  });
});

describe('F · roles: who may change what', () => {
  it('a VIEWER may read the shared account and may not change it', async () => {
    const list = await GET(W.CY, '/accounts');
    expect(ids(list.body as unknown as Row[])).toContain(W.A_EVERYDAY);
    const put = await SEND(W.CY, 'PUT', `/accounts/${W.A_EVERYDAY}`, { name: 'Viewer rename' });
    expect(put.status).toBe(403);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.name).toBe('Ada Everyday');
  });

  it('a VIEW-ONLY direct grant refuses the write and says so honestly', async () => {
    const put = await SEND(W.CY, 'PUT', `/accounts/${W.A_SAVER}`, { name: 'nope' });
    expect(put.status).toBe(403);
  });

  it('an EDIT direct grant may correct the row, and it lands on the real row', async () => {
    const put = await SEND(W.DI, 'PUT', `/accounts/${W.A_USD}`, { name: 'Ada USD (corrected)' });
    expect(put.status).toBe(200);
    expect(table('bank_accounts').find(a => a.id === W.A_USD)!.name).toBe('Ada USD (corrected)');
    expect(table('bank_accounts').find(a => a.id === W.A_USD)!.user_id).toBe(W.ADA);
  });

  it('a viewer’s delete is refused outright', async () => {
    const res = await SEND(W.CY, 'DELETE', `/accounts/${W.A_EVERYDAY}`);
    expect(res.status).toBe(403);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)).toBeTruthy();
  });

  it('a direct EDIT grant still may not delete', async () => {
    const res = await SEND(W.DI, 'DELETE', `/accounts/${W.A_USD}`);
    expect(res.status).toBe(403);
    expect(table('bank_accounts').find(a => a.id === W.A_USD)).toBeTruthy();
  });

  it('an editing member’s delete un-shares and asks — it never destroys the owner’s row', async () => {
    const res = await SEND(W.BO, 'DELETE', `/accounts/${W.A_EVERYDAY}`);
    expect(res.status).toBe(200);
    expect((res.body as unknown as { diverted?: boolean }).diverted).toBe(true);

    // The money is untouched and still Ada's, and its transactions survive.
    const row = table('bank_accounts').find(a => a.id === W.A_EVERYDAY);
    expect(row).toBeTruthy();
    expect(row!.user_id).toBe(W.ADA);
    expect(row!.balance).toBe(12_000);
    expect(table('transactions').filter(t => t.account_id === W.A_EVERYDAY).length).toBe(2);

    // Out of the household, and Ada is asked.
    expect(table('record_households').filter(r => r.record_id === W.A_EVERYDAY)).toHaveLength(0);
    expect(ids((await GET(W.BO, '/accounts')).body as unknown as Row[])).not.toContain(W.A_EVERYDAY);
    expect(ids((await GET(W.ADA, '/accounts')).body as unknown as Row[])).toContain(W.A_EVERYDAY);
    const pending = (await GET(W.ADA, '/households/change-requests')).body as unknown as { requests: Row[] };
    expect(pending.requests.some(r => r.record_id === W.A_EVERYDAY && r.kind === 'delete')).toBe(true);
  });

  it('only the OWNER may share a row — an editing member cannot re-publish it', async () => {
    const put = await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [W.HH_RIVER, W.HH_COAST] });
    expect(put.status).toBeGreaterThanOrEqual(400);
    const stamps = table('record_households').filter(r => r.record_id === W.A_EVERYDAY);
    expect(stamps.map(s => s.household_id)).toEqual([W.HH_RIVER]);
  });

  it('a member cannot mint a share code for a row they merely see', async () => {
    const code = await SEND(W.BO, 'POST', '/shares/codes', { record_type: 'account', record_id: W.A_EVERYDAY, permission: 'edit' });
    expect(code.status).toBe(403);
  });

  it('a viewer cannot put their own row into the household they only watch', async () => {
    const put = await SEND(W.CY, 'PUT', `/accounts/${W.C_PRIVATE}`, { household_ids: [W.HH_RIVER] });
    expect(put.status).toBe(403);
  });
});

describe('G · revoking, live, while another session is open', () => {
  it('a revoked DIRECT grant is gone from the other session’s very next read', async () => {
    // Ada's session can see Bo's private account through an edit grant.
    const before = await GET(W.ADA, '/accounts');
    expect(ids(before.body as unknown as Row[])).toContain(W.B_PRIVATE);

    // Bo revokes from his own session while Ada's is still open.
    const del = await SEND(W.BO, 'DELETE', `/shares/${W.S_BO_ADA_PRIVATE}`);
    expect(del.status).toBe(200);

    const after = await GET(W.ADA, '/accounts');
    expect(ids(after.body as unknown as Row[])).not.toContain(W.B_PRIVATE);
    // And the transactions that came with it go in the same instant.
    const tx = await GET(W.ADA, '/accounts/transactions?limit=500');
    expect(ids(tx.body as unknown as Row[])).not.toContain(W.T_B_PRIVATE_1);
  });

  it('a revoked grant’s write is refused immediately, not merely hidden', async () => {
    await SEND(W.BO, 'DELETE', `/shares/${W.S_BO_ADA_PRIVATE}`);
    const put = await SEND(W.ADA, 'PUT', `/accounts/${W.B_PRIVATE}`, { name: 'after revoke' });
    expect(put.status).toBe(404);
    expect(table('bank_accounts').find(a => a.id === W.B_PRIVATE)!.name).toBe('Bo Private');
  });

  it('un-sharing from a household disappears from every member at once', async () => {
    const before = await GET(W.BO, '/loans');
    expect(ids(before.body as unknown as Row[])).toContain(W.A_MORTGAGE);

    const put = await SEND(W.ADA, 'PUT', `/loans/${W.A_MORTGAGE}`, { household_ids: [] });
    expect(put.status).toBe(200);

    for (const u of [W.BO, W.CY]) {
      const after = await GET(u, '/loans');
      expect(ids(after.body as unknown as Row[])).not.toContain(W.A_MORTGAGE);
    }
    // Still entirely Ada's.
    expect(table('loans').find(l => l.id === W.A_MORTGAGE)!.user_id).toBe(W.ADA);
  });

  it('removing a member takes their shared rows back out of that household only', async () => {
    // Di shares D_JOINT into COAST and KIN. Bo (COAST owner) removes Di.
    const members = await GET(W.BO, `/households/${W.HH_COAST}/members`);
    expect(members.status).toBe(200);
    const diRow = (members.body as unknown as Row[]).find(m => m.user_id === W.DI);
    expect(diRow).toBeTruthy();
    const removal = await SEND(W.BO, 'DELETE', `/households/${W.HH_COAST}/members/${diRow!.id}`);
    expect(removal.status).toBe(200);

    const stamps = table('record_households')
      .filter(r => r.record_id === W.D_JOINT).map(r => r.household_id);
    expect(stamps).toEqual([W.HH_KIN]);

    // Cy (KIN) still sees it; Bo (COAST) no longer does.
    expect(ids((await GET(W.CY, '/accounts')).body as unknown as Row[])).toContain(W.D_JOINT);
    expect(ids((await GET(W.BO, '/accounts')).body as unknown as Row[])).not.toContain(W.D_JOINT);
    // And Di keeps every cent.
    expect(table('bank_accounts').find(a => a.id === W.D_JOINT)!.balance).toBe(700);
  });

  it('a removed member loses the household’s rows on their next read', async () => {
    const members = await GET(W.BO, `/households/${W.HH_COAST}/members`);
    const diRow = (members.body as unknown as Row[]).find(m => m.user_id === W.DI)!;
    await SEND(W.BO, 'DELETE', `/households/${W.HH_COAST}/members/${diRow.id}`);

    const after = await GET(W.DI, '/accounts');
    expect(ids(after.body as unknown as Row[])).not.toContain(W.B_EVERYDAY);
    // Her OWN goal stays hers — removal takes access, not money — but it has
    // left the household, so the household's other members lose sight of it.
    const goals = await GET(W.DI, '/overview/goals');
    expect(ids(goals.body as unknown as Row[])).toContain(W.D_GOAL);
    expect(ids((await GET(W.BO, '/overview/goals')).body as unknown as Row[])).not.toContain(W.D_GOAL);
  });

  it('deleting a shared row ends every grant on it', async () => {
    const del = await SEND(W.ADA, 'DELETE', `/accounts/${W.A_USD}`);
    expect(del.status).toBe(200);
    const grant = table('record_shares').find(s => s.id === W.S_ADA_DI_USD)!;
    expect(grant.status).toBe('revoked');
    expect(ids((await GET(W.DI, '/accounts')).body as unknown as Row[])).not.toContain(W.A_USD);
  });
});

describe('H · reload mid-action, and repeated switching', () => {
  it('a share applied and immediately re-read is stable across ten reads', async () => {
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_SAVER}`, { household_ids: [W.HH_COAST] });
    const seen: string[][] = [];
    for (let i = 0; i < 10; i++) {
      seen.push(ids((await GET(W.BO, '/accounts')).body as unknown as Row[]));
    }
    expect(new Set(seen.map(s => s.join(','))).size).toBe(1);
    expect(seen[0]).toContain(W.A_SAVER);
  });

  it('sharing and un-sharing the same row twenty times leaves exactly one stamp', async () => {
    for (let i = 0; i < 20; i++) {
      await SEND(W.ADA, 'PUT', `/accounts/${W.A_SAVER}`, { household_ids: [W.HH_RIVER] });
      await SEND(W.ADA, 'PUT', `/accounts/${W.A_SAVER}`, { household_ids: [] });
    }
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_SAVER}`, { household_ids: [W.HH_RIVER] });
    expect(table('record_households').filter(r => r.record_id === W.A_SAVER)).toHaveLength(1);
    expect((await GET(W.BO, '/accounts')).body as unknown as Row[]).toHaveLength(
      visibleOracle(W.BO, 'account').size);
  });

  it('the same share code cannot be redeemed twice into two grants', async () => {
    const code = await SEND(W.ADA, 'POST', '/shares/codes', { record_type: 'account', record_id: W.A_HIDDEN, permission: 'view' });
    const raw = (code.body as never as { code: Row }).code.code as string;
    const first = await SEND(W.BO, 'POST', '/shares/redeem', { code: raw });
    expect(first.status).toBe(201);
    const second = await SEND(W.CY, 'POST', '/shares/redeem', { code: raw });
    expect(second.status).toBe(400);
    expect(table('record_shares').filter(s => s.record_id === W.A_HIDDEN && s.status === 'active')).toHaveLength(1);
  });

  it('redeeming the same code twice as the same person yields one grant, not two', async () => {
    const code = await SEND(W.ADA, 'POST', '/shares/codes', { record_type: 'account', record_id: W.A_HIDDEN, permission: 'view' });
    const raw = (code.body as never as { code: Row }).code.code as string;
    await SEND(W.BO, 'POST', '/shares/redeem', { code: raw });
    await SEND(W.BO, 'POST', '/shares/redeem', { code: raw });
    expect(table('record_shares').filter(s => s.record_id === W.A_HIDDEN && s.shared_with_user_id === W.BO && s.status === 'active')).toHaveLength(1);
    expect((await GET(W.BO, '/accounts')).body as unknown as Row[])
      .toHaveLength(new Set(ids((await GET(W.BO, '/accounts')).body as unknown as Row[])).size);
  });

  it('a transaction added to a shared account by a member lands once, on the owner’s row', async () => {
    const before = table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance as number;
    const post = await SEND(W.BO, 'POST', '/accounts/transactions', {
      account_id: W.A_EVERYDAY, date: '2026-08-20', merchant: 'Hardware', amount: -50, category: 'home',
    });
    expect(post.status).toBe(201);
    const adjust = await SEND(W.BO, 'POST', `/accounts/${W.A_EVERYDAY}/adjust-balance`, { delta: -50 });
    expect(adjust.status).toBe(200);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBeCloseTo(before - 50, 2);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.user_id).toBe(W.ADA);
    // The transaction is Bo's own row, on Ada's account — no copy was made.
    expect(table('transactions').filter(t => t.merchant === 'Hardware')).toHaveLength(1);
  });
});

describe('I · net worth is ownership, and nothing else', () => {
  it('each user’s net worth counts only rows they own', async () => {
    for (const u of ALL) {
      const nw = await computeNetWorth(u);
      const ownCash = table('bank_accounts')
        .filter(a => a.user_id === u && !a.hidden)
        .reduce((s, a) => s + Number(a.balance) * (a.currency === 'USD' ? 1.5 : 1), 0);
      const hiddenCash = table('bank_accounts')
        .filter(a => a.user_id === u && a.hidden)
        .reduce((s, a) => s + Number(a.balance) * (a.currency === 'USD' ? 1.5 : 1), 0);
      // Whether hidden accounts count is a product decision; the audit only
      // requires the answer be ONE of the two honest ones, never a foreign row.
      const acceptable = [ownCash, ownCash + hiddenCash].map(v => Number(v.toFixed(2)));
      expect(acceptable, `${NAME[u]} bank balance ${nw.bankBalance}`)
        .toContain(Number(nw.bankBalance.toFixed(2)));
    }
  });

  it('net worth does not move when a row is shared, only when money moves', async () => {
    const before = await computeNetWorth(W.ADA);
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_SAVER}`, { household_ids: [W.HH_RIVER, W.HH_COAST] });
    await SEND(W.ADA, 'PUT', `/properties/${W.A_HOUSE}`, { household_ids: [W.HH_COAST] });
    await SEND(W.ADA, 'PUT', `/loans/${W.A_MORTGAGE}`, { household_ids: [] });
    const after = await computeNetWorth(W.ADA);
    expect(after.netWorth).toBeCloseTo(before.netWorth, 2);
    expect(after.property).toBeCloseTo(before.property, 2);
    expect(after.loans).toBeCloseTo(before.loans, 2);
  });

  it('the net-worth endpoint agrees with the engine it is built on', async () => {
    const engine = await computeNetWorth(W.ADA);
    const { status, body } = await GET(W.ADA, '/overview/net-worth');
    expect(status).toBe(200);
    const api = body as unknown as Record<string, number>;
    expect(api.net_worth).toBeCloseTo(engine.netWorth, 2);
    expect(api.bank_balance).toBeCloseTo(engine.bankBalance, 2);
    expect(api.property).toBeCloseTo(engine.property, 2);
    expect(api.loans).toBeCloseTo(engine.loans, 2);
  });

  it('a mortgage shared into a household still belongs to its owner’s liabilities', async () => {
    const bo = await computeNetWorth(W.BO);
    expect(bo.loans).toBeCloseTo(20_000, 2);   // Bo's car loan only, not Ada's 400k
  });
});

describe('J · the wire itself: what a response reveals', () => {
  // ── WAS FINDING A-1 (Low) — FIXED, now a regression ────────────────────────
  // `attachHouseholds` once returned EVERY household a row sits in, unfiltered
  // by the reader's own memberships, so a response named the id of a household
  // the reader is not in. Nothing rendered it (the client only ever asks
  // `.includes(activeHouseholdId)`) — but it was on the wire, and "the screen
  // doesn't show it" is a weaker promise than "the server didn't send it".
  it('a row’s household_ids do not name households the reader is not in', async () => {
    // D_JOINT sits in COAST and KIN. Ada is in COAST and NOT in KIN.
    const { body } = await GET(W.ADA, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.D_JOINT);
    expect(row, 'Ada should see Di’s COAST-shared account').toBeTruthy();
    expect(row!.household_ids).toEqual([W.HH_COAST]);
  });

  // ── WAS FINDING A-2 (Medium) — FIXED, now a regression ─────────────────────
  // The same call once attached `household_overlays` for every household too, so
  // a member's PROPOSED FIGURE from a household the reader is not in crossed the
  // wire keyed by that household's id. The overlay is the half that carries
  // money, which is why this one was Medium and its `household_ids` twin Low.
  it('a pending change request from another household is not attached to the row', async () => {
    // Di proposes a change to her own row in KIN via a member edit… use Cy, a
    // KIN member who is not the owner, so the edit diverts into an overlay.
    const put = await SEND(W.CY, 'PUT', `/accounts/${W.D_JOINT}`, { balance: 999_999 });
    expect(put.status).toBe(200);

    // Ada is in COAST (where D_JOINT also sits) but NOT in KIN. The KIN proposal
    // must not ride along on her copy of the row.
    const { body } = await GET(W.ADA, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.D_JOINT)!;
    const overlays = (row.household_overlays ?? {}) as Record<string, unknown>;
    expect(Object.keys(overlays)).not.toContain(W.HH_KIN);
  });

  it('a shared row does not carry the owner’s private identifiers', async () => {
    const { body } = await GET(W.CY, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.A_SAVER)!;
    expect(row.shared_password_hash).toBeUndefined();
  });
});

describe('K · households, invitations and codes', () => {
  it('a household lists only its own members, and only to a member', async () => {
    const mine = await GET(W.ADA, `/households/${W.HH_RIVER}/members`);
    expect(mine.status).toBe(200);
    expect((mine.body as unknown as Row[]).filter(m => m.status === 'active').map(m => m.user_id).sort())
      .toEqual([W.ADA, W.BO, W.CY].sort());

    const stranger = await GET(W.DI, `/households/${W.HH_RIVER}/members`);
    expect(stranger.status).toBeGreaterThanOrEqual(400);
  });

  it('GET /households answers with the households the caller is actively in', async () => {
    for (const u of ALL) {
      const { body } = await GET(u, '/households');
      const listed = (body as unknown as { households?: Row[] }).households ?? (body as unknown as Row[]);
      expect(listed.map(h => String(h.id)).sort()).toEqual(activeHouseholdsOf(u).sort());
    }
  });

  it('a viewer cannot change a role or remove anybody', async () => {
    const members = await GET(W.ADA, `/households/${W.HH_RIVER}/members`);
    const boRow = (members.body as unknown as Row[]).find(m => m.user_id === W.BO)!;
    const promote = await SEND(W.CY, 'PATCH', `/households/${W.HH_RIVER}/members/${boRow.id}`, { role: 'owner' });
    expect(promote.status).toBeGreaterThanOrEqual(400);
    const remove = await SEND(W.CY, 'DELETE', `/households/${W.HH_RIVER}/members/${boRow.id}`);
    expect(remove.status).toBeGreaterThanOrEqual(400);
    expect(roleOf(W.BO, W.HH_RIVER)).toBe('member');
  });

  it('leaving a household takes your rows out of it and leaves the others alone', async () => {
    const leave = await SEND(W.DI, 'POST', `/households/${W.HH_KIN}/leave`);
    expect(leave.status).toBe(200);
    expect(table('record_households').filter(r => r.record_id === W.D_JOINT).map(r => r.household_id))
      .toEqual([W.HH_COAST]);
    expect(ids((await GET(W.DI, '/properties')).body as unknown as Row[])).not.toContain(W.C_FARM);
    expect(table('bank_accounts').find(a => a.id === W.D_JOINT)!.user_id).toBe(W.DI);
  });
});

describe('L · documents follow what they are filed against', () => {
  it('a document linked to a shared property reaches that household', async () => {
    // C_DOC is filed against C_FARM, which is shared into KIN. Di is in KIN.
    expect(ids((await GET(W.DI, '/documents')).body as unknown as Row[])).toContain(W.C_DOC);
  });

  it('un-sharing the record takes its documents with it, immediately', async () => {
    await SEND(W.CY, 'PUT', `/properties/${W.C_FARM}`, { household_ids: [] });
    expect(ids((await GET(W.DI, '/documents')).body as unknown as Row[])).not.toContain(W.C_DOC);
  });

  it('a document nobody shared reaches nobody, and its bytes are refused', async () => {
    for (const u of [W.ADA, W.CY, W.DI]) {
      expect(ids((await GET(u, '/documents')).body as unknown as Row[])).not.toContain(W.B_DOC);
      const file = await fetch(`${base}/documents/${W.B_DOC}/file`, { headers: auth(u) });
      expect(file.status).toBe(404);
    }
  });

  it('a member may read a shared document’s bytes and may not rename it', async () => {
    const file = await fetch(`${base}/documents/${W.A_DOC}/file`, { headers: auth(W.BO) });
    expect(file.status).toBe(200);
    const rename = await SEND(W.BO, 'PATCH', `/documents/${W.A_DOC}`, { name: 'not yours' });
    expect(rename.status).toBe(403);
  });
});

describe('M · insurance, super and income stay with their owner', () => {
  it('a policy FOLLOWS what it covers — into that household, and no further', async () => {
    // Ada's home policy is filed against A_HOUSE, shared into RIVER.
    const bo = ((await GET(W.BO, '/insurance')).body as unknown as { policies: Row[] }).policies;
    expect(bo.map(p => String(p.id))).toContain(W.INSURANCE[0].id);   // member of RIVER
    const cy = ((await GET(W.CY, '/insurance')).body as unknown as { policies: Row[] }).policies;
    expect(cy.map(p => String(p.id))).toContain(W.INSURANCE[0].id);   // viewer of RIVER
    const di = ((await GET(W.DI, '/insurance')).body as unknown as { policies: Row[] }).policies;
    expect(di.map(p => String(p.id))).not.toContain(W.INSURANCE[0].id); // in neither
    // Bo's unlinked car policy stays entirely his.
    for (const who of [W.ADA, W.CY, W.DI]) {
      const list = ((await GET(who, '/insurance')).body as unknown as { policies: Row[] }).policies;
      expect(list.map(p => String(p.id))).not.toContain(W.INSURANCE[1].id);
    }
  });

  it('un-sharing the property takes its policy out of the household immediately', async () => {
    expect((((await GET(W.BO, '/insurance')).body as unknown as { policies: Row[] }).policies)
      .map(p => String(p.id))).toContain(W.INSURANCE[0].id);
    await SEND(W.ADA, 'PUT', `/properties/${W.A_HOUSE}`, { household_ids: [] });
    expect((((await GET(W.BO, '/insurance')).body as unknown as { policies: Row[] }).policies)
      .map(p => String(p.id))).not.toContain(W.INSURANCE[0].id);
  });

  it('a member may look at a shared policy and may not change or delete it', async () => {
    const put = await SEND(W.BO, 'PUT', `/insurance/${W.INSURANCE[0].id}`, { premium_amount: 1 });
    expect(put.status).toBeGreaterThanOrEqual(400);
    expect(table('insurance_policies').find(p => p.id === W.INSURANCE[0].id)!.premium_amount).toBe(1_800);
    const del = await SEND(W.BO, 'DELETE', `/insurance/${W.INSURANCE[0].id}`);
    expect(del.status).toBeGreaterThanOrEqual(400);
  });

  it('premium history is never another user’s', async () => {
    for (const u of ALL) {
      const { body } = await GET(u, '/insurance');
      const hist = (body as unknown as { history: Row[] }).history;
      expect(hist.every(h => h.user_id === u)).toBe(true);
    }
  });

  it('super is personal — no share of any kind reaches it', async () => {
    for (const u of ALL) {
      const { body } = await GET(u, '/investments/super');
      const funds = (body as unknown as Row[]);
      expect(funds.every(f => f.user_id === u)).toBe(true);
    }
  });

  it('the income projection is the caller’s own recurring money only', async () => {
    const { body } = await GET(W.BO, '/income');
    const { entries, projected_annual } = body as unknown as { entries: Row[]; projected_annual: number };
    expect(entries.map(e => String(e.id))).toContain(W.A_INCOME);   // shared into RIVER
    expect(projected_annual).toBeCloseTo(4_000 * 12, 2);            // Bo's only
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('N · what a hostile client cannot do', () => {
  it('a smuggled user_id in a create does not mint a row under somebody else', async () => {
    const res = await SEND(W.BO, 'POST', '/accounts', {
      name: 'Smuggled', institution: 'X', account_type: 'transaction', balance: 1,
      user_id: W.ADA,
    });
    expect(res.status).toBe(201);
    expect((res.body as unknown as Row).user_id).toBe(W.BO);
    expect(table('bank_accounts').filter(a => a.name === 'Smuggled')[0].user_id).toBe(W.BO);
  });

  it('a smuggled user_id in an edit does not move a row to a new owner', async () => {
    const res = await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { name: 'Renamed', user_id: W.BO });
    expect(res.status).toBe(200);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.user_id).toBe(W.ADA);
  });

  it('a member’s proposal cannot carry identity fields into the owner’s row', async () => {
    const put = await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, {
      balance: 1, user_id: W.BO, id: 'something-else',
    });
    expect(put.status).toBe(200);
    const req = table('household_change_requests').find(r => r.record_id === W.A_EVERYDAY)!;
    const patch = req.patch as Record<string, unknown>;
    expect(patch).not.toHaveProperty('user_id');
    expect(patch).not.toHaveProperty('id');
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.user_id).toBe(W.ADA);
  });

  it('a recipient cannot promote their own view grant to edit', async () => {
    const res = await SEND(W.CY, 'PATCH', `/shares/${W.S_ADA_CY_SAVER}`, { permission: 'edit' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(table('record_shares').find(s => s.id === W.S_ADA_CY_SAVER)!.permission).toBe('view');
    // …and still cannot write.
    expect((await SEND(W.CY, 'PUT', `/accounts/${W.A_SAVER}`, { name: 'nope' })).status).toBe(403);
  });

  it('a share code for a row you do not own is refused, and one for nothing at all', async () => {
    expect((await SEND(W.CY, 'POST', '/shares/codes', {
      record_type: 'account', record_id: W.A_SAVER, permission: 'edit',
    })).status).toBe(403);
    expect((await SEND(W.CY, 'POST', '/shares/codes', {
      record_type: 'account', record_id: 'f0000000-0000-4000-8000-999999999999', permission: 'view',
    })).status).toBeGreaterThanOrEqual(400);
  });

  it('your own code grants you nothing', async () => {
    const code = await SEND(W.ADA, 'POST', '/shares/codes', { record_type: 'account', record_id: W.A_SAVER, permission: 'view' });
    const res = await SEND(W.ADA, 'POST', '/shares/redeem', { code: (code.body as never as { code: Row }).code.code });
    expect(res.status).toBe(400);
    expect(table('record_shares').filter(s => s.shared_with_user_id === W.ADA && s.record_id === W.A_SAVER)).toHaveLength(0);
  });

  it('a household join code does not let a joiner grant themselves a role', async () => {
    const made = await SEND(W.ADA, 'POST', `/households/${W.HH_RIVER}/code`, { role: 'viewer' });
    expect(made.status).toBeLessThan(300);
    const raw = (made.body as unknown as { household: Row }).household.join_code as string;
    expect(raw).toBeTruthy();
    const join = await SEND(W.DI, 'POST', '/households/join', { code: raw, role: 'owner' });
    expect(join.status).toBeLessThan(300);
    const membership = table('household_members')
      .find(m => m.household_id === W.HH_RIVER && m.user_id === W.DI && m.status === 'active');
    expect(membership?.role, 'a joiner chose their own role').toBe('viewer');
    // A viewer still cannot change the household's money.
    expect((await SEND(W.DI, 'PUT', `/accounts/${W.A_EVERYDAY}`, { name: 'nope' })).status).toBe(403);
  });

  it('there is exactly one active owner of a household, whatever is attempted', async () => {
    const members = (await GET(W.ADA, `/households/${W.HH_RIVER}/members`)).body as unknown as Row[];
    const bo = members.find(m => m.user_id === W.BO)!;
    await SEND(W.ADA, 'PATCH', `/households/${W.HH_RIVER}/members/${bo.id}`, { role: 'owner' });
    const owners = table('household_members')
      .filter(m => m.household_id === W.HH_RIVER && m.status === 'active' && m.role === 'owner');
    expect(owners.length, 'two owners of one household').toBe(1);
  });

  it('an idempotent create replayed is one row, not two', async () => {
    const payload = {
      name: 'Replayed', institution: 'CBA', account_type: 'transaction', balance: 5,
      client_id: 'c0ffee00-0000-4000-8000-000000000001',
    };
    const first = await SEND(W.CY, 'POST', '/accounts', payload);
    const second = await SEND(W.CY, 'POST', '/accounts', payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(table('bank_accounts').filter(a => a.name === 'Replayed')).toHaveLength(1);
  });

  it('a member may tick off a shared bill, and a viewer may not', async () => {
    const pay = await SEND(W.BO, 'PATCH', `/overview/bills/${W.A_BILL}/pay`, {});
    expect(pay.status).toBe(200);
    expect(table('bills').find(b => b.id === W.A_BILL)!.user_id).toBe(W.ADA);

    buildWorld();
    const viewer = await SEND(W.CY, 'PATCH', `/overview/bills/${W.A_BILL}/pay`, {});
    expect(viewer.status).toBe(403);
  });

  it('a member may not delete another member’s row out of a household they share', async () => {
    // Cy (viewer in Riverside) tries to remove Ada's goal.
    const res = await SEND(W.CY, 'DELETE', `/overview/goals/${W.A_GOAL}`);
    expect(res.status).toBe(403);
    expect(table('goals').find(g => g.id === W.A_GOAL)).toBeTruthy();
  });

  it('a stranger cannot read a household’s change requests', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 5 });
    const strangers = await GET(W.DI, '/households/change-requests');
    const list = (strangers.body as unknown as { requests: Row[] }).requests;
    expect(list.every(r => r.owner_user_id === W.DI)).toBe(true);
  });

  it('the data export is the caller’s own rows, and nobody else’s', async () => {
    const { status, body } = await GET(W.BO, '/settings/export');
    expect(status).toBe(200);
    const dump = body as unknown as Record<string, Row[] | string>;
    for (const key of ['accounts', 'transactions', 'investments', 'income', 'bills', 'goals']) {
      const rows = (dump[key] ?? []) as Row[];
      expect(rows.every(r => r.user_id === W.BO), `${key} carried a foreign row`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('P · proposals: only the owner answers them', () => {
  it('a non-owner cannot accept a proposal about somebody else’s row', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const req = table('household_change_requests').find(r => r.record_id === W.A_EVERYDAY)!;
    expect(req).toBeTruthy();

    for (const who of [W.BO, W.CY, W.DI]) {
      const res = await SEND(who, 'POST', `/households/change-requests/${req.id}/respond`, { accept: true });
      expect(res.status, `${who} answered Ada's proposal`).toBeGreaterThanOrEqual(400);
    }
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(12_000);
  });

  it('declining leaves the owner’s row alone and the household’s version standing', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const req = table('household_change_requests').find(r => r.record_id === W.A_EVERYDAY)!;
    const res = await SEND(W.ADA, 'POST', `/households/change-requests/${req.id}/respond`, { accept: false });
    expect(res.status).toBe(200);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(12_000);
  });

  it('a row in two households collects one proposal per household, and each is answered on its own', async () => {
    // A_CARD is in RIVER and COAST. Bo can edit in both.
    const put = await SEND(W.BO, 'PATCH', `/accounts/credit-cards/${W.A_CARD}`, { balance_owing: 3_500 });
    expect(put.status).toBe(200);
    const reqs = table('household_change_requests').filter(r => r.record_id === W.A_CARD && r.kind === 'edit');
    expect(reqs.map(r => r.household_id).sort()).toEqual([W.HH_RIVER, W.HH_COAST].sort());
    expect(table('credit_cards').find(c => c.id === W.A_CARD)!.balance_owing).toBe(2_000);

    // Ada accepts ONE of them. Her row moves once, and the other request is not
    // left proposing a change that has already happened.
    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${reqs[0].id}/respond`, { accept: true });
    expect(accept.status).toBe(200);
    expect(table('credit_cards').find(c => c.id === W.A_CARD)!.balance_owing).toBe(3_500);
    const stillPending = table('household_change_requests')
      .filter(r => r.record_id === W.A_CARD && r.kind === 'edit' && r.status === 'pending');
    for (const r of stillPending) {
      const patch = r.patch as Record<string, unknown>;
      expect(patch.balance_owing, 'a stale proposal would re-propose what is already true')
        .not.toBe(2_000);
    }
  });

  // ── WAS FINDING B-1 (Medium) — FIXED, now a regression ─────────────────────
  // Nothing removed `household_change_requests` when the row left the household
  // they belonged to, so the owner's inbox kept a live-looking proposal about a
  // row nobody shares any more. The ask is now DERIVED (`requestIsLive`) rather
  // than trusted from when it was written — note that the overlay ROW is still
  // expected to survive, because re-sharing asks the owner "their version or
  // mine?" and that question is made from it. What ends is the ASK.
  it('a proposal about a row you no longer share disappears with the sharing', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    expect(table('household_change_requests').filter(r => r.record_id === W.A_EVERYDAY)).toHaveLength(1);

    await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [] });
    const inbox = (await GET(W.ADA, '/households/change-requests')).body as unknown as { requests: Row[] };
    const stale = inbox.requests.filter(r => r.record_id === W.A_EVERYDAY);
    expect(stale, 'a proposal survives the household it belonged to').toHaveLength(0);
  });

  // ── WAS FINDING B-2 (Medium) — FIXED, now a regression ─────────────────────
  // `respondToChangeRequest` re-checked only the OWNER, never whether the
  // proposal's grounds still existed — so accepting wrote a departed member's
  // figure onto the owner's row. The Telegram Apply button is the same call and
  // never expires on its own, which is what made a stale ask dangerous rather
  // than merely untidy.
  it('a proposal from somebody who has LEFT the household cannot still be applied', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const req = table('household_change_requests').find(r => r.record_id === W.A_EVERYDAY)!;

    // Bo leaves Riverside — he can no longer see the account at all.
    const leave = await SEND(W.BO, 'POST', `/households/${W.HH_RIVER}/leave`);
    expect(leave.status).toBe(200);
    expect(ids((await GET(W.BO, '/accounts')).body as unknown as Row[])).not.toContain(W.A_EVERYDAY);

    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${req.id}/respond`, { accept: true });
    expect(accept.status, 'a departed member’s proposal was still applicable')
      .toBeGreaterThanOrEqual(400);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance,
      'a departed member’s figure was written onto the owner’s row').toBe(12_000);
  });

  // ── WAS FINDING B-3 (Medium) — FIXED — the un-share half of B-2. ───────────
  it('an un-shared row’s stale proposal cannot be applied either', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const req = table('household_change_requests').find(r => r.record_id === W.A_EVERYDAY)!;
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [] });

    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${req.id}/respond`, { accept: true });
    expect(accept.status, 'a proposal about a row nobody shares any more was applied')
      .toBeGreaterThanOrEqual(400);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(12_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Q · the same wire question, on the endpoints that answer it differently', () => {
  // ── WAS FINDING A-1 (Low) on the linked-visibility path — FIXED ────────────
  // `householdsOfLinks` (documents + insurance) had the same shape as
  // `attachHouseholds`: it reported every household the LINKED record sits in,
  // whether or not the reader is in it. Same reader-side filter, same rule.
  it('a policy’s household_ids name only households the reader is in', async () => {
    // Ada puts the house into Coast as well. Cy is in Riverside only.
    const put = await SEND(W.ADA, 'PUT', `/properties/${W.A_HOUSE}`, {
      household_ids: [W.HH_RIVER, W.HH_COAST],
    });
    expect(put.status).toBe(200);

    const { body } = await GET(W.CY, '/insurance');
    const policy = (body as unknown as { policies: Row[] }).policies
      .find(p => p.id === W.INSURANCE[0].id)!;
    expect(policy, 'Cy should still see the policy through Riverside').toBeTruthy();
    expect(policy.household_ids).toEqual([W.HH_RIVER]);
  });

  it('a document’s household_ids name only households the reader is in', async () => {
    // Di files a document against her joint account, which is in Coast AND Kin.
    seed('documents', [{
      id: 'f0000000-0000-4000-8000-0000000000dd', user_id: W.DI, name: 'Joint statement.pdf',
      original_filename: 'Joint statement.pdf', storage_path: `${W.DI}/doc/joint.pdf`,
      mime: 'application/pdf', size: 10, document_type: 'statement',
      linked_type: 'account', linked_id: W.D_JOINT, extraction_status: 'unread',
    }]);
    // Ada is in Coast and NOT in Kin.
    const { body } = await GET(W.ADA, '/documents');
    const doc = (body as unknown as Row[]).find(d => d.id === 'f0000000-0000-4000-8000-0000000000dd')!;
    expect(doc, 'Ada should see it through Coast').toBeTruthy();
    expect(doc.household_ids).toEqual([W.HH_COAST]);
  });

  it('the leak is metadata only — no figure of a foreign household rides along', async () => {
    // Stated so the finding's BOUNDS are pinned too: what crosses is the id,
    // never the other household's money.
    const { body } = await GET(W.ADA, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.D_JOINT)!;
    expect(row.balance).toBe(700);           // Di's real figure, which Ada may see
    expect(row).not.toHaveProperty('household_names');
    expect(row).not.toHaveProperty('household_members');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R · the fixes: a proposal borrows its authority, and a stamp has a reader', () => {
  /** The membership row id the routes address a member by. */
  const memberIdOf = (userId: string, householdId: string) =>
    String(table('household_members')
      .find(m => m.user_id === userId && m.household_id === householdId)!.id);

  const inboxOf = async (userId: string) =>
    ((await GET(userId, '/households/change-requests')).body as unknown as { requests: Row[] }).requests;

  // ── The half that must NOT change: a live proposal is still a proposal ──────
  //
  // Every test below takes something away. This one is the control: with the
  // sharing intact, the owner's Accept still does exactly what it always did.
  // A fix that refused everything would pass all the others and fail this.
  it('a proposal whose sharing is intact still applies on Accept', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const [ask] = await inboxOf(W.ADA);
    expect(ask, 'the owner was never asked').toBeTruthy();

    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status).toBe(200);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(1);
  });

  it('the household still sees the overlay of a proposal made in ITS household', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const { body } = await GET(W.ADA, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.A_EVERYDAY)!;
    const overlays = (row.household_overlays ?? {}) as Record<string, Record<string, unknown>>;
    expect(overlays[W.HH_RIVER], 'the reader IS in Riverside; over-filtering would hide this').toBeTruthy();
    expect(overlays[W.HH_RIVER].balance).toBe(1);
  });

  // ── Un-sharing ends the ASK without destroying the OVERLAY ─────────────────
  //
  // The two are deliberately different things. The ask is derived, so it ends
  // the instant the sharing does. The overlay row survives, because re-sharing
  // asks the owner "their version or mine?" and that question is made from it —
  // a fix that deleted the row would have silently removed a feature.
  it('un-sharing closes the ask but keeps the household’s last-seen version', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [] });

    expect(await inboxOf(W.ADA), 'a lapsed ask was still offered').toHaveLength(0);
    const kept = table('household_change_requests').filter(r => r.record_id === W.A_EVERYDAY);
    expect(kept, 'the re-share choice has nothing left to be made from').toHaveLength(1);
    expect((kept[0].patch as Record<string, unknown>).balance).toBe(1);
  });

  it('re-sharing with ‘reset’ still clears that kept version', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [] });
    const back = await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, {
      household_ids: [W.HH_RIVER],
      household_overlay_resolutions: { [W.HH_RIVER]: 'reset' },
    });
    expect(back.status).toBe(200);
    expect(table('household_change_requests').filter(r => r.record_id === W.A_EVERYDAY)).toHaveLength(0);
  });

  // ── The proposer stops being one ───────────────────────────────────────────
  it('a member demoted to viewer stops proposing, in the inbox and in the view', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const [ask] = await inboxOf(W.ADA);

    const demote = await SEND(W.ADA, 'PATCH',
      `/households/${W.HH_RIVER}/members/${memberIdOf(W.BO, W.HH_RIVER)}`, { role: 'viewer' });
    expect(demote.status).toBe(200);

    expect(await inboxOf(W.ADA)).toHaveLength(0);
    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status, 'a viewer’s figure was applied to the owner’s row').toBeGreaterThanOrEqual(400);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(12_000);

    // …and Riverside is back to seeing Ada's own number, not a viewer's.
    const { body } = await GET(W.ADA, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.A_EVERYDAY)!;
    expect((row.household_overlays ?? {}) as Record<string, unknown>).not.toHaveProperty(W.HH_RIVER);
  });

  it('a member REMOVED by the owner stops proposing too', async () => {
    await SEND(W.BO, 'PUT', `/accounts/${W.A_EVERYDAY}`, { balance: 1 });
    const [ask] = await inboxOf(W.ADA);

    const removed = await SEND(W.ADA, 'DELETE',
      `/households/${W.HH_RIVER}/members/${memberIdOf(W.BO, W.HH_RIVER)}`);
    expect(removed.status).toBe(200);

    expect(await inboxOf(W.ADA)).toHaveLength(0);
    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    expect(table('bank_accounts').find(a => a.id === W.A_EVERYDAY)!.balance).toBe(12_000);
  });

  // ── The cascade, on both sides ─────────────────────────────────────────────
  //
  // A transaction is shared through the account it sits on, so a proposal about
  // one has to lapse when the ACCOUNT leaves the household — checking only the
  // transaction's own `record_households` rows would call it stale from birth.
  it('a proposal about a transaction is live while its account is shared', async () => {
    const put = await SEND(W.BO, 'PATCH', `/accounts/transactions/${W.T_A_EVERYDAY_1}`, { merchant: 'Woolies' });
    expect(put.status).toBe(200);
    const [ask] = await inboxOf(W.ADA);
    expect(ask, 'a proposal reached through the account was called stale immediately').toBeTruthy();

    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status).toBe(200);
    expect(table('transactions').find(t => t.id === W.T_A_EVERYDAY_1)!.merchant).toBe('Woolies');
  });

  it('…and lapses when that account leaves the household', async () => {
    await SEND(W.BO, 'PATCH', `/accounts/transactions/${W.T_A_EVERYDAY_1}`, { merchant: 'Woolies' });
    const [ask] = await inboxOf(W.ADA);
    await SEND(W.ADA, 'PUT', `/accounts/${W.A_EVERYDAY}`, { household_ids: [] });

    expect(await inboxOf(W.ADA)).toHaveLength(0);
    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    expect(table('transactions').find(t => t.id === W.T_A_EVERYDAY_1)!.merchant).toBe('Woolworths');
  });

  // ── The exemption ─────────────────────────────────────────────────────────
  //
  // A DELETE proposal un-shares the row as its opening move. "No longer shared"
  // is therefore the state it CREATED, not evidence that it expired — so it must
  // survive its own side effect, or a member's delete could never be approved.
  it('a delete proposal survives the un-share it performs itself', async () => {
    const gone = await SEND(W.BO, 'DELETE', `/overview/goals/${W.A_GOAL}`);
    expect(gone.status).toBe(200);
    expect(table('goals').find(g => g.id === W.A_GOAL), 'the owner’s row was taken from her').toBeTruthy();

    const [ask] = await inboxOf(W.ADA);
    expect(ask, 'the owner was never asked about a delete she must approve').toBeTruthy();
    expect(ask.kind).toBe('delete');

    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status).toBe(200);
    expect(table('goals').find(g => g.id === W.A_GOAL)).toBeFalsy();
  });

  it('but not the proposer leaving', async () => {
    await SEND(W.BO, 'DELETE', `/overview/goals/${W.A_GOAL}`);
    const [ask] = await inboxOf(W.ADA);
    await SEND(W.BO, 'POST', `/households/${W.HH_RIVER}/leave`);

    const accept = await SEND(W.ADA, 'POST', `/households/change-requests/${ask.id}/respond`, { accept: true });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    expect(table('goals').find(g => g.id === W.A_GOAL), 'a departed member’s delete still ran').toBeTruthy();
  });

  // ── Narrowing the stamps costs the owner nothing ──────────────────────────
  //
  // The whole safety of the `household_ids` filter rests on one claim: an owner
  // is a member of every household their own row sits in, so their own list is
  // never narrowed — and the client can therefore go on echoing the list back as
  // the desired set without silently un-sharing anything.
  it('an owner still sees every household their own row sits in', async () => {
    const { body } = await GET(W.DI, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.D_JOINT)!;
    expect([...(row.household_ids as string[])].sort()).toEqual([W.HH_COAST, W.HH_KIN].sort());
  });

  it('echoing the list back leaves the sharing exactly where it was', async () => {
    const before = (((await GET(W.DI, '/accounts')).body as unknown as Row[])
      .find(a => a.id === W.D_JOINT)!.household_ids) as string[];
    const put = await SEND(W.DI, 'PUT', `/accounts/${W.D_JOINT}`, { household_ids: before });
    expect(put.status).toBe(200);

    const stamps = table('record_households')
      .filter(r => r.record_type === 'account' && r.record_id === W.D_JOINT)
      .map(r => String(r.household_id)).sort();
    expect(stamps).toEqual([W.HH_COAST, W.HH_KIN].sort());
  });

  // A DIRECT grantee is in none of the owner's households, so the correct answer
  // for them is an empty list — not the owner's household topology, which used to
  // ride along on a row shared with one named person for one named reason.
  it('a direct grantee is told nothing about the owner’s households', async () => {
    const shared = await SEND(W.ADA, 'PUT', `/accounts/${W.A_USD}`, { household_ids: [W.HH_RIVER] });
    expect(shared.status).toBe(200);

    // Di holds an edit grant on A_USD and is in Coast and Kin — never Riverside.
    const { body } = await GET(W.DI, '/accounts');
    const row = (body as unknown as Row[]).find(a => a.id === W.A_USD)!;
    expect(row, 'Di should still see it through her grant').toBeTruthy();
    expect(row.household_ids).toEqual([]);
    expect((row.household_overlays ?? {}) as Record<string, unknown>).not.toHaveProperty(W.HH_RIVER);
  });

  it('a document’s shared_household_ids are narrowed to the reader as well', async () => {
    const shared = await SEND(W.ADA, 'PATCH', `/documents/${W.A_DOC}`, {
      household_ids: [W.HH_RIVER, W.HH_COAST],
    });
    expect(shared.status).toBe(200);

    // Cy is in Riverside and Kin — never Coast.
    const { body } = await GET(W.CY, '/documents');
    const doc = (body as unknown as Row[]).find(d => d.id === W.A_DOC)!;
    expect(doc, 'Cy should see it through Riverside').toBeTruthy();
    expect(doc.household_ids).toEqual([W.HH_RIVER]);
    expect(doc.shared_household_ids, 'the sharing control leaked a foreign household')
      .toEqual([W.HH_RIVER]);

    // …and Ada, who owns it and is in both, still sees both.
    const mine = ((await GET(W.ADA, '/documents')).body as unknown as Row[])
      .find(d => d.id === W.A_DOC)!;
    expect([...(mine.shared_household_ids as string[])].sort())
      .toEqual([W.HH_RIVER, W.HH_COAST].sort());
  });
});
