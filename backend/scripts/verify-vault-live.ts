// Live end-to-end verification of the Phase 8.1 document vault against the
// DEPLOYED backend (Render) and the real Supabase DB + storage bucket.
// Seeds two disposable users directly (service key), runs the whole flow
// through the production API, then removes every trace. Untracked; run with:
//   cd backend && npx tsx scripts/verify-vault-live.ts
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import bcrypt from 'bcryptjs';
import { supabase } from '../src/utils/supabase';

const API = 'https://ledger-80d8.onrender.com/api';
const ALICE_EMAIL = 'vault-alice@ledger.local';
const BOB_EMAIL = 'vault-bob@ledger.local';
const PASSWORD = 'vault-test-password-1';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ''); }
}

async function seedUser(email: string, name: string): Promise<string> {
  const password_hash = await bcrypt.hash(PASSWORD, 12);
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existing) {
    await supabase.from('users').update({ password_hash, email_verified: true }).eq('id', existing.id);
    return existing.id as string;
  }
  const { data, error } = await supabase.from('users').insert({
    email, name, password_hash, currency_preference: 'AUD', theme: 'light',
    plan: 'free', onboarding_complete: true, email_verified: true,
  }).select('id').single();
  if (error) throw new Error(`seed ${email}: ${error.message}`);
  return data.id as string;
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json() as { token?: string; error?: string };
  if (!body.token) throw new Error(`login ${email}: ${res.status} ${body.error}`);
  return body.token;
}

const authed = (token: string, extra: Record<string, string> = {}) =>
  ({ Authorization: `Bearer ${token}`, ...extra });

function form(files: { name: string; content: string; type?: string }[], meta: Record<string, string>) {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([f.content], { type: f.type ?? 'application/pdf' }), f.name);
  for (const [k, v] of Object.entries(meta)) fd.append(k, v);
  return fd;
}

type Doc = Record<string, unknown>;

async function main() {
  console.log('Seeding users…');
  const aliceId = await seedUser(ALICE_EMAIL, 'Vault Alice');
  const bobId = await seedUser(BOB_EMAIL, 'Vault Bob');
  const alice = await login(ALICE_EMAIL);
  const bob = await login(BOB_EMAIL);
  console.log('Logged in via production API.');

  const cleanupDocIds: string[] = [];
  let householdId: string | null = null;

  try {
    // ── Empty vault ──────────────────────────────────────────────────────────
    console.log('\nList (empty):');
    let res = await fetch(`${API}/documents`, { headers: authed(alice) });
    check('GET /documents returns 200 with the table in place', res.status === 200);
    check('vault starts empty', ((await res.json()) as Doc[]).length === 0);

    // ── Single upload with metadata ──────────────────────────────────────────
    console.log('\nSingle upload:');
    res = await fetch(`${API}/documents`, {
      method: 'POST', headers: authed(alice),
      body: form([{ name: 'Oct statement.pdf', content: '%PDF-1.4 fake statement bytes' }], {
        document_type: 'statement', provider: 'CommBank',
        document_date: '2026-07-31', notes: 'live verification',
      }),
    });
    const single = (await res.json()) as { documents?: Doc[]; error?: string };
    check('upload returns 201', res.status === 201, single.error);
    const doc1 = single.documents?.[0] as Doc;
    cleanupDocIds.push(doc1?.id as string);
    check('metadata persisted (type/provider/date)',
      doc1?.document_type === 'statement' && doc1?.provider === 'CommBank'
      && doc1?.document_date === '2026-07-31');

    // ── Bytes round-trip ─────────────────────────────────────────────────────
    res = await fetch(`${API}/documents/${doc1.id}/file`, { headers: authed(alice) });
    check('download returns 200', res.status === 200);
    check('bytes round-trip exactly', (await res.text()) === '%PDF-1.4 fake statement bytes');
    check('content-type preserved', (res.headers.get('content-type') ?? '').includes('application/pdf'));

    // ── Multiple files in one act ────────────────────────────────────────────
    console.log('\nMulti-file upload:');
    res = await fetch(`${API}/documents`, {
      method: 'POST', headers: authed(alice),
      body: form([
        { name: 'July payslip.pdf', content: 'july' },
        { name: 'August payslip.pdf', content: 'august' },
      ], { document_type: 'payslip', linked_type: 'tax_year', linked_id: '2026-2027' }),
    });
    const multi = (await res.json()) as { documents?: Doc[]; error?: string };
    check('two files → two documents', res.status === 201 && multi.documents?.length === 2, multi.error);
    multi.documents?.forEach(d => cleanupDocIds.push(d.id as string));
    check('each keeps its own name',
      new Set(multi.documents?.map(d => d.name)).size === 2);
    check('tax-year link stored on both',
      multi.documents?.every(d => d.linked_type === 'tax_year' && d.linked_id === '2026-2027') === true);

    // ── Persistence: a fresh list sees all three ─────────────────────────────
    res = await fetch(`${API}/documents`, { headers: authed(alice) });
    check('fresh GET lists all 3 (persistence)', ((await res.json()) as Doc[]).length === 3);

    // ── Rename / edit ────────────────────────────────────────────────────────
    console.log('\nEdit:');
    res = await fetch(`${API}/documents/${doc1.id}`, {
      method: 'PATCH', headers: authed(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'October statement (renamed)', user_id: bobId }),
    });
    const renamed = (await res.json()) as Doc;
    check('rename lands', res.status === 200 && renamed.name === 'October statement (renamed)');
    check('smuggled user_id ignored', renamed.user_id === aliceId);

    // ── User isolation ───────────────────────────────────────────────────────
    console.log('\nIsolation:');
    res = await fetch(`${API}/documents`, { headers: authed(bob) });
    check("Bob's vault is empty of Alice's papers", ((await res.json()) as Doc[]).length === 0);
    res = await fetch(`${API}/documents/${doc1.id}/file`, { headers: authed(bob) });
    check("Bob can't fetch Alice's file even with the id (404)", res.status === 404);
    res = await fetch(`${API}/documents/${doc1.id}`, { method: 'DELETE', headers: authed(bob) });
    check("Bob can't delete Alice's document (404)", res.status === 404);
    // Tax-year docs exist and stay invisible cross-user regardless of households below.

    // ── Household sharing ────────────────────────────────────────────────────
    console.log('\nSharing:');
    const hh = await supabase.from('households')
      .insert({ name: 'Vault Test Household', created_by: aliceId }).select('id').single();
    if (hh.error) throw new Error(`household: ${hh.error.message}`);
    householdId = hh.data.id as string;
    const members = await supabase.from('household_members').insert([
      { household_id: householdId, user_id: aliceId, role: 'owner', status: 'active' },
      { household_id: householdId, user_id: bobId, role: 'member', status: 'active' },
    ]);
    if (members.error) throw new Error(`members: ${members.error.message}`);

    res = await fetch(`${API}/documents`, {
      method: 'POST', headers: authed(alice),
      body: form([{ name: 'home policy.pdf', content: 'policy bytes' }], {
        document_type: 'insurance', linked_type: 'household', linked_id: householdId,
      }),
    });
    const sharedUp = (await res.json()) as { documents?: Doc[]; error?: string };
    check('household-linked upload accepted', res.status === 201, sharedUp.error);
    const sharedDoc = sharedUp.documents?.[0] as Doc;
    cleanupDocIds.push(sharedDoc?.id as string);

    res = await fetch(`${API}/documents`, { headers: authed(bob) });
    const bobList = (await res.json()) as Doc[];
    check('Bob (member) sees the household document', bobList.some(d => d.id === sharedDoc.id));
    check("…and ONLY that one — Alice's personal + tax docs stay hers", bobList.length === 1);
    res = await fetch(`${API}/documents/${sharedDoc.id}/file`, { headers: authed(bob) });
    check('Bob can download the shared document', res.status === 200 && (await res.text()) === 'policy bytes');
    res = await fetch(`${API}/documents/${sharedDoc.id}`, {
      method: 'PATCH', headers: authed(bob, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'mine now' }),
    });
    check('Bob cannot rename it (403 — visible, not his)', res.status === 403);
    res = await fetch(`${API}/documents/${sharedDoc.id}`, { method: 'DELETE', headers: authed(bob) });
    check('Bob cannot delete it (403)', res.status === 403);

    // Un-link → gone from Bob in the same instant.
    res = await fetch(`${API}/documents/${sharedDoc.id}`, {
      method: 'PATCH', headers: authed(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ linked_type: null, linked_id: null }),
    });
    check('owner un-links (back to personal)', res.status === 200);
    res = await fetch(`${API}/documents`, { headers: authed(bob) });
    check('un-linked → invisible to Bob again', ((await res.json()) as Doc[]).length === 0);

    // ── Deletion removes row AND bytes ───────────────────────────────────────
    console.log('\nDeletion:');
    const storagePath = doc1 && (await supabase.from('documents')
      .select('storage_path').eq('id', doc1.id).single()).data?.storage_path as string;
    res = await fetch(`${API}/documents/${doc1.id}`, { method: 'DELETE', headers: authed(alice) });
    check('owner delete returns 200', res.status === 200);
    res = await fetch(`${API}/documents`, { headers: authed(alice) });
    check('row gone from the list', ((await res.json()) as Doc[]).every(d => d.id !== doc1.id));
    const gone = await supabase.storage.from('documents').download(storagePath);
    check('stored bytes gone from the bucket', !!gone.error);
  } finally {
    // ── Leave no trace ───────────────────────────────────────────────────────
    console.log('\nCleaning up…');
    const { data: leftovers } = await supabase.from('documents')
      .select('id, storage_path').in('user_id', [aliceId, bobId]);
    for (const d of leftovers ?? []) {
      await supabase.storage.from('documents').remove([d.storage_path as string]);
    }
    await supabase.from('documents').delete().in('user_id', [aliceId, bobId]);
    if (householdId) {
      await supabase.from('household_members').delete().eq('household_id', householdId);
      await supabase.from('households').delete().eq('id', householdId);
    }
    await supabase.from('users').delete().in('id', [aliceId, bobId]);
    console.log('Removed test users, household, documents and stored files.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
