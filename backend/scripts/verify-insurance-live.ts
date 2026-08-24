// Live end-to-end verification of Phase 8.2 (insurance) against the DEPLOYED
// backend (Render) and the real Supabase database. Seeds two disposable users
// directly (service key), runs the whole flow through the production API, then
// removes every trace.
//   cd backend && npx tsx scripts/verify-insurance-live.ts
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import bcrypt from 'bcryptjs';
import { supabase } from '../src/utils/supabase';

const API = 'https://ledger-80d8.onrender.com/api';
const ALICE_EMAIL = 'ins-alice@ledger.local';
const BOB_EMAIL = 'ins-bob@ledger.local';
const PASSWORD = 'insurance-test-password-1';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ''); }
}

/** `days` from today, as YYYY-MM-DD. */
function dateIn(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) =>
  ({ ...authed(token), 'Content-Type': 'application/json' });

type Row = Record<string, unknown>;

const post = async (token: string, path: string, body: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Row & { error?: string } };
};
const put = async (token: string, path: string, body: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT', headers: jsonHeaders(token), body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Row & { error?: string } };
};
const del = async (token: string, path: string) => {
  const res = await fetch(`${API}${path}`, { method: 'DELETE', headers: authed(token) });
  return { status: res.status };
};
const list = async (token: string) => {
  const res = await fetch(`${API}/insurance`, { headers: authed(token) });
  return await res.json() as { policies: Row[]; history: Row[] };
};

async function main() {
  console.log('Seeding users…');
  const aliceId = await seedUser(ALICE_EMAIL, 'Insurance Alice');
  const bobId = await seedUser(BOB_EMAIL, 'Insurance Bob');
  const alice = await login(ALICE_EMAIL);
  const bob = await login(BOB_EMAIL);
  console.log('Logged in via production API.');

  let householdId: string | null = null;
  let propertyId: string | null = null;
  let bobPropertyId: string | null = null;
  let aliceDocId: string | null = null;
  let bobDocId: string | null = null;

  try {
    // ── Fixtures the API cannot make for us (a house, a household, a document) ──
    const prop = await supabase.from('properties').insert({
      user_id: aliceId, name: 'Verify House', property_type: 'home',
      purchase_price: 0, current_value: 800000, ownership_percent: 100,
    }).select('id').single();
    if (prop.error) throw new Error(`property: ${prop.error.message}`);
    propertyId = prop.data.id as string;

    const bobProp = await supabase.from('properties').insert({
      user_id: bobId, name: "Bob's House", property_type: 'home',
      purchase_price: 0, current_value: 500000, ownership_percent: 100,
    }).select('id').single();
    if (bobProp.error) throw new Error(`bob property: ${bobProp.error.message}`);
    bobPropertyId = bobProp.data.id as string;

    const docs = await supabase.from('documents').insert([
      {
        user_id: aliceId, name: 'Policy schedule', original_filename: 'policy.pdf',
        storage_path: `${aliceId}/verify/policy.pdf`, mime_type: 'application/pdf',
        size_bytes: 10, document_type: 'insurance',
      },
      {
        user_id: bobId, name: "Bob's policy", original_filename: 'bob.pdf',
        storage_path: `${bobId}/verify/bob.pdf`, mime_type: 'application/pdf',
        size_bytes: 10, document_type: 'insurance',
      },
    ]).select('id, user_id');
    if (docs.error) throw new Error(`documents: ${docs.error.message}`);
    aliceDocId = (docs.data ?? []).find(d => d.user_id === aliceId)?.id as string;
    bobDocId = (docs.data ?? []).find(d => d.user_id === bobId)?.id as string;

    // ── Empty ────────────────────────────────────────────────────────────────
    console.log('\nAn empty shelf:');
    let res = await fetch(`${API}/insurance`, { headers: authed(alice) });
    check('GET /insurance returns 200 with the tables in place', res.status === 200);
    const empty = await res.json() as { policies: Row[]; history: Row[] };
    check('no policies yet', empty.policies.length === 0);
    check('no premium history yet', empty.history.length === 0);

    // ── Create, with everything a policy can say ─────────────────────────────
    console.log('\nAdding cover:');
    const renewal = dateIn(20); // inside the reminder window
    let created = await post(alice, '/insurance', {
      name: 'House — NRMA', policy_type: 'home', insurer: 'NRMA', policy_number: 'H-4471',
      premium_amount: 1800, premium_frequency: 'annually',
      start_date: dateIn(-345), renewal_date: renewal,
      excess: 500, coverage_amount: 900_000, notes: 'live verification',
      linked_type: 'property', linked_id: propertyId,
      document_id: aliceDocId,
    });
    check('create returns 201', created.status === 201, created.body.error);
    const houseId = created.body.id as string;
    check('every field persisted',
      created.body.insurer === 'NRMA' && created.body.policy_number === 'H-4471'
      && Number(created.body.premium_amount) === 1800 && created.body.renewal_date === renewal
      && Number(created.body.excess) === 500 && Number(created.body.coverage_amount) === 900_000);
    check('linked to the property it covers',
      created.body.linked_type === 'property' && created.body.linked_id === propertyId);
    check('policy document attached', created.body.document_id === aliceDocId);
    check('born active, owned by its creator',
      created.body.active === true && created.body.user_id === aliceId);

    // ── Renewals and expiry ──────────────────────────────────────────────────
    console.log('\nRenewals and expiry:');
    const expiredCreate = await post(alice, '/insurance', {
      name: 'Corolla — AAMI', policy_type: 'car', insurer: 'AAMI',
      premium_amount: 90, premium_frequency: 'monthly',
      renewal_date: dateIn(-14), // lapsed a fortnight ago
    });
    const expiredId = expiredCreate.body.id as string;
    check('a lapsed policy is stored as-is — expiry is derived, never written',
      expiredCreate.status === 201
      && expiredCreate.body.renewal_date === dateIn(-14)
      && !('status' in expiredCreate.body) && !('expired' in expiredCreate.body));

    const renewed = await put(alice, `/insurance/${expiredId}`, {
      renewal_date: dateIn(351), premium_amount: 99,
    });
    check('renewing moves the date forward', renewed.body.renewal_date === dateIn(351));

    const badDate = await post(alice, '/insurance', { name: 'X', renewal_date: 'soon' });
    check('a renewal date that is not a date is refused (400)', badDate.status === 400);

    const ended = await put(alice, `/insurance/${expiredId}`, { active: false });
    check('cover can be marked as no longer held', ended.body.active === false);
    const reinstated = await put(alice, `/insurance/${expiredId}`, { active: true });
    check('…and reinstated', reinstated.body.active === true);

    // ── Premium history and premium changes ──────────────────────────────────
    console.log('\nPremium history:');
    const opening = await post(alice, '/insurance/history', {
      policy_id: houseId, premium_amount: 1500, premium_frequency: 'annually',
      effective_date: dateIn(-345), note: 'Opening premium',
    });
    check('the opening premium is recorded (201)', opening.status === 201, opening.body.error);

    const rise = await post(alice, '/insurance/history', {
      policy_id: houseId, premium_amount: 1800, premium_frequency: 'annually',
      effective_date: dateIn(-10), note: 'Renewal',
    });
    check('a price rise is recorded', rise.status === 201, rise.body.error);

    const withHistory = await list(alice);
    const houseHistory = withHistory.history.filter(h => h.policy_id === houseId);
    check('both prices come back, oldest first',
      houseHistory.length === 2
      && Number(houseHistory[0].premium_amount) === 1500
      && Number(houseHistory[1].premium_amount) === 1800);
    check('the policy still holds the CURRENT price',
      Number(withHistory.policies.find(p => p.id === houseId)?.premium_amount) === 1800);

    const foreignHistory = await post(bob, '/insurance/history', {
      policy_id: houseId, premium_amount: 1, effective_date: dateIn(0),
    });
    check("nobody can write history onto somebody else's policy (404)", foreignHistory.status === 404);

    const incomplete = await post(alice, '/insurance/history', { policy_id: houseId, premium_amount: 10 });
    check('a record with no effective date is refused (400)', incomplete.status === 400);

    // ── Links: assets and documents ──────────────────────────────────────────
    console.log('\nWhat a policy may cover:');
    const strangerProp = await post(alice, '/insurance', {
      name: 'Cheeky', linked_type: 'property', linked_id: bobPropertyId,
    });
    check("cannot cover a stranger's property, and is told 404 not 403", strangerProp.status === 404);

    const strangerDoc = await post(alice, '/insurance', {
      name: 'Cheeky doc', document_id: bobDocId,
    });
    check("cannot attach somebody else's document (403)", strangerDoc.status === 403);

    const halfLink = await post(alice, '/insurance', { name: 'Half', linked_type: 'property' });
    check('half a link is refused (400)', halfLink.status === 400);

    // ── Sharing ──────────────────────────────────────────────────────────────
    console.log('\nSharing — a policy follows what it covers:');
    const hh = await supabase.from('households')
      .insert({ name: 'Insurance Test Household', created_by: aliceId }).select('id').single();
    if (hh.error) throw new Error(`household: ${hh.error.message}`);
    householdId = hh.data.id as string;
    const members = await supabase.from('household_members').insert([
      { household_id: householdId, user_id: aliceId, role: 'owner', status: 'active' },
      { household_id: householdId, user_id: bobId, role: 'member', status: 'active' },
    ]);
    if (members.error) throw new Error(`members: ${members.error.message}`);

    // Before the house is shared, Bob sees nothing of Alice's.
    let bobView = await list(bob);
    check("Bob's shelf is empty of Alice's cover", bobView.policies.length === 0);

    const shareRow = await supabase.from('record_households').insert({
      record_type: 'property', record_id: propertyId,
      household_id: householdId, owner_user_id: aliceId,
    });
    if (shareRow.error) throw new Error(`share: ${shareRow.error.message}`);

    bobView = await list(bob);
    check('sharing the HOUSE brings its cover with it', bobView.policies.some(p => p.id === houseId));
    check('…and only that one — the car stays personal', bobView.policies.length === 1);
    check('the policy carries the households of what it covers',
      JSON.stringify(bobView.policies[0]?.household_ids) === JSON.stringify([householdId]));
    check("Bob sees none of Alice's premium history", bobView.history.length === 0);

    const memberEdit = await put(bob, `/insurance/${houseId}`, { premium_amount: 1 });
    check('a member cannot re-price cover that is not theirs (403)', memberEdit.status === 403);
    const memberDelete = await del(bob, `/insurance/${houseId}`);
    check('a member cannot delete it either (403)', memberDelete.status === 403);
    const stillOurs = await list(alice);
    check('…and the policy is untouched',
      Number(stillOurs.policies.find(p => p.id === houseId)?.premium_amount) === 1800);

    // A family policy filed to the household directly.
    const familyHealth = await post(alice, '/insurance', {
      name: 'Family health', policy_type: 'health', insurer: 'Medibank',
      premium_amount: 220, premium_frequency: 'monthly',
      linked_type: 'household', linked_id: householdId,
    });
    check('a household-linked policy is accepted', familyHealth.status === 201, familyHealth.body.error);
    bobView = await list(bob);
    check('every member sees it', bobView.policies.some(p => p.id === familyHealth.body.id));

    // Un-share the house: its cover goes back in the same instant.
    await supabase.from('record_households').delete()
      .eq('record_type', 'property').eq('record_id', propertyId);
    bobView = await list(bob);
    check('un-sharing the house revokes its cover instantly',
      !bobView.policies.some(p => p.id === houseId));
    check('…while the household policy stays visible', bobView.policies.length === 1);

    // ── Isolation ────────────────────────────────────────────────────────────
    console.log('\nIsolation:');
    const bobEdit = await put(bob, `/insurance/${expiredId}`, { name: 'mine now' });
    check("holding the id of an invisible policy gets 404 on edit", bobEdit.status === 404);
    const bobDelete = await del(bob, `/insurance/${expiredId}`);
    check('…and 404 on delete', bobDelete.status === 404);

    const smuggled = await put(alice, `/insurance/${houseId}`, {
      name: 'House — NRMA (renamed)', user_id: bobId,
    });
    check('an edit lands', smuggled.body.name === 'House — NRMA (renamed)');
    check('a smuggled user_id is ignored', smuggled.body.user_id === aliceId);

    // ── Deletion ─────────────────────────────────────────────────────────────
    console.log('\nDeletion:');
    const removed = await del(alice, `/insurance/${houseId}`);
    check('the owner can delete their policy', removed.status === 200);
    const after = await list(alice);
    check('it is gone from the list', !after.policies.some(p => p.id === houseId));
    check('its premium history went with it (cascade)',
      !after.history.some(h => h.policy_id === houseId));
    check('the document it pointed at is untouched',
      !!(await supabase.from('documents').select('id').eq('id', aliceDocId).maybeSingle()).data);
  } finally {
    // ── Leave no trace ───────────────────────────────────────────────────────
    console.log('\nCleaning up…');
    await supabase.from('insurance_premium_history').delete().in('user_id', [aliceId, bobId]);
    await supabase.from('insurance_policies').delete().in('user_id', [aliceId, bobId]);
    await supabase.from('documents').delete().in('user_id', [aliceId, bobId]);
    await supabase.from('properties').delete().in('user_id', [aliceId, bobId]);
    if (householdId) {
      await supabase.from('record_households').delete().eq('household_id', householdId);
      await supabase.from('household_members').delete().eq('household_id', householdId);
      await supabase.from('households').delete().eq('id', householdId);
    }
    await supabase.from('users').delete().in('id', [aliceId, bobId]);
    console.log('Removed test users, household, property, documents and policies.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
