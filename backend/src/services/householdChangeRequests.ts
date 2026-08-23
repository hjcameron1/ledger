/**
 * Household change requests — the guard between a household's shared view and
 * its members' own finances.
 *
 * A member with an editing role can change or remove shared rows they don't
 * own. Before this file, an edit wrote straight onto the owner's real record
 * and a delete was refused outright. Now both are DIVERTED:
 *
 *   EDIT    lands here as a patch. The household view merges it over the row at
 *           read time (see `attachHouseholds` in householdScope.ts), so the
 *           member's change appears in the household immediately — and the
 *           owner's own record hasn't moved. The owner is asked (in-app on next
 *           load, and on Telegram with Apply/Keep buttons). Approving applies
 *           the patch to the real row and removes the overlay — converged.
 *           Declining keeps the overlay: the household sees its version, the
 *           owner keeps theirs, and that divergence is the point.
 *
 *   DELETE  un-shares the row from the member's household on the spot (gone
 *           from the household view, untouched for the owner) and asks the
 *           owner whether to delete it from their account too.
 *
 * The one law underneath: NOBODY BUT THE OWNER EVER WRITES THE OWNER'S ROW.
 * A member's edit is a proposal that happens to render; only the owner's
 * explicit yes turns it into the record.
 */

import { supabase } from '../utils/supabase';
import {
  HouseholdScope, ShareableTable, ShareRecordType,
  RECORD_OF_TABLE, TABLE_OF_RECORD,
  householdsOfRecord, roleIn, roleCan, grantedPermission, revokeGrantsFor,
} from './householdScope';
import { recordNetWorthSnapshot } from './netWorthSnapshot';
import { purgeInvestmentFromHistory } from './portfolioSnapshot';

export interface ChangeRequestRow {
  id: string;
  record_type: ShareRecordType;
  record_id: string;
  household_id: string;
  owner_user_id: string;
  requested_by: string;
  kind: 'edit' | 'delete';
  patch: Record<string, unknown> | null;
  previous: Record<string, unknown> | null;
  record_label: string | null;
  status: 'pending' | 'declined';
  created_at?: string;
}

/** Keys that must never live in an overlay patch: they aren't the member's
 *  values to propose. Everything else the route allowlisted is fair game. */
const NON_PATCH_KEYS = new Set([
  'id', 'user_id', 'created_at', 'updated_at',
  'household_ids', 'household_id', 'household_overlay_resolutions',
]);

interface OwnedRow {
  id: string;
  user_id?: string;
  account_id?: string | null;
  [key: string]: unknown;
}

/** A human name for the row, for "Bo changed 'Car loan'". Best-effort. */
function labelOf(row: OwnedRow): string | null {
  for (const key of ['name', 'title', 'description', 'category', 'symbol', 'source']) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  return null;
}

/**
 * The households through which this caller's editing right over somebody
 * else's row arrives — the ones a diverted change belongs to. A transaction is
 * also reachable through the account it sits on (same rule as its visibility
 * and its write check).
 */
async function editableHouseholdsOf(
  table: ShareableTable, id: string, row: OwnedRow, scope: HouseholdScope,
): Promise<string[]> {
  const ids = new Set(await householdsOfRecord(RECORD_OF_TABLE[table], id));
  if (table === 'transactions' && row.account_id) {
    for (const h of await householdsOfRecord('account', row.account_id)) ids.add(h);
    for (const h of await householdsOfRecord('card', row.account_id)) ids.add(h);
  }
  return [...ids].filter(h => roleCan(roleIn(scope, h), 'edit_shared'));
}

/** True when the owner explicitly granted THIS person edit on THIS row — a
 *  direct grant keeps writing the real row, because that is what the owner
 *  personally agreed to when they minted an edit code. */
function hasDirectEditGrant(
  table: ShareableTable, id: string, row: OwnedRow, scope: HouseholdScope,
): boolean {
  if (grantedPermission(scope, RECORD_OF_TABLE[table], id) === 'edit') return true;
  if (table !== 'transactions' || !row.account_id) return false;
  return grantedPermission(scope, 'account', row.account_id) === 'edit'
      || grantedPermission(scope, 'card', row.account_id) === 'edit';
}

async function loadRow(table: ShareableTable, id: string): Promise<OwnedRow | null> {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error || !data) return null;
  return data as OwnedRow;
}

/**
 * Divert a non-owner's EDIT into a change request instead of the row.
 *
 * Called by every shareable PUT/PATCH after `refuseWrite` has allowed the write
 * and after the route has reduced the body to real columns. Returns null when
 * the write should proceed normally (the caller owns the row, or holds a
 * direct edit grant); otherwise it records the patch, alerts the owner, and
 * returns the UNTOUCHED row for the route to respond with — the client's
 * household view picks the change up from the overlay, not the row.
 */
export async function divertMemberEdit(
  table: ShareableTable, id: string, scope: HouseholdScope,
  fields: Record<string, unknown>,
): Promise<OwnedRow | null> {
  const row = await loadRow(table, id);
  if (!row) return null;                                   // let the route 404 its own way
  if (!row.user_id || row.user_id === scope.userId) return null;
  if (hasDirectEditGrant(table, id, row, scope)) return null;

  const households = await editableHouseholdsOf(table, id, row, scope);
  if (!households.length) return null;                     // refuseWrite already vouched; be safe

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!NON_PATCH_KEYS.has(key) && value !== undefined) patch[key] = value;
  }
  if (!Object.keys(patch).length) return row;              // sharing-only request: nothing to ask

  const type = RECORD_OF_TABLE[table];
  for (const householdId of households) {
    // Merge over any live request rather than stacking a queue: the household
    // view shows ONE current version, so the ask is "this version, yes or no?"
    const { data: existing } = await supabase.from('household_change_requests')
      .select('id, patch, previous')
      .eq('record_type', type).eq('record_id', id)
      .eq('household_id', householdId).eq('kind', 'edit')
      .maybeSingle();

    const mergedPatch = { ...(existing?.patch as Record<string, unknown> ?? {}), ...patch };
    // `previous` keeps the owner's value from the FIRST time each column was
    // touched — the honest "before" even after three member edits.
    const previous = { ...(existing?.previous as Record<string, unknown> ?? {}) };
    for (const key of Object.keys(patch)) {
      if (!(key in previous)) previous[key] = row[key] ?? null;
    }

    const stamp = {
      patch: mergedPatch, previous,
      requested_by: scope.userId,
      record_label: labelOf(row),
      status: 'pending', resolved_at: null,
      updated_at: new Date().toISOString(),
    };
    const { error } = existing
      ? await supabase.from('household_change_requests').update(stamp).eq('id', existing.id)
      : await supabase.from('household_change_requests').insert({
          record_type: type, record_id: id, household_id: householdId,
          owner_user_id: row.user_id, ...stamp,
        });
    if (error) {
      console.warn('[hcr] recording member edit failed:', error.message);
      // The one thing worse than a lost proposal would be falling through to
      // write the owner's row after all — so the route still gets the divert.
    }
  }

  notifyOwner(row.user_id, type, id, households[0], scope.userId, 'edit', patch, row)
    .catch(err => console.warn('[hcr] telegram alert failed:', err));
  return row;
}

/**
 * Divert a non-owner's DELETE: un-share the row from the member's household(s)
 * — it leaves the household view right now — and ask the owner whether it
 * should leave their account too. Returns true when handled; false means the
 * caller proceeds to `refuseDelete` exactly as before (owners delete normally,
 * viewers and direct grantees are still refused).
 */
export async function divertMemberDelete(
  table: ShareableTable, id: string, scope: HouseholdScope,
): Promise<boolean> {
  const row = await loadRow(table, id);
  if (!row) return false;
  if (!row.user_id || row.user_id === scope.userId) return false;

  const type = RECORD_OF_TABLE[table];
  // Only households the ROW ITSELF is stamped to: a transaction that is only
  // visible through its shared account can't be taken out of the household on
  // its own, so its delete stays refused rather than half-working.
  const stamped = await householdsOfRecord(type, id);
  const households = stamped.filter(h => roleCan(roleIn(scope, h), 'edit_shared'));
  if (!households.length) return false;

  const { error: unshareError } = await supabase.from('record_households')
    .delete()
    .eq('record_type', type).eq('record_id', id)
    .in('household_id', households);
  if (unshareError) {
    console.warn('[hcr] un-share on member delete failed:', unshareError.message);
    return false;                                          // nothing happened; let refuseDelete answer
  }

  for (const householdId of households) {
    const { error } = await supabase.from('household_change_requests').upsert({
      record_type: type, record_id: id, household_id: householdId,
      owner_user_id: row.user_id, requested_by: scope.userId,
      kind: 'delete', patch: null, previous: null,
      record_label: labelOf(row),
      status: 'pending', resolved_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'record_type,record_id,household_id,kind' });
    if (error) console.warn('[hcr] recording member delete failed:', error.message);
  }

  notifyOwner(row.user_id, type, id, households[0], scope.userId, 'delete', null, row)
    .catch(err => console.warn('[hcr] telegram alert failed:', err));
  return true;
}

// ─── The owner's answer ───────────────────────────────────────────────────────

export interface RespondResult {
  ok: boolean;
  status: number;
  error?: string;
  /** What happened, for the caller's copy. */
  outcome?: 'applied' | 'deleted' | 'kept';
}

/**
 * The owner's yes or no. Yes on an edit applies the member's patch to the real
 * row and removes the overlay (household and owner see the same thing again).
 * Yes on a delete performs the real delete, with the same cascades the owner's
 * own delete button runs. No on an edit keeps the overlay alive as `declined` —
 * the household goes on seeing its version. No on a delete simply closes the
 * request; the row was already un-shared, so there is nothing left to show.
 */
export async function respondToChangeRequest(
  requestId: string, ownerUserId: string, accept: boolean,
): Promise<RespondResult> {
  const { data, error } = await supabase.from('household_change_requests')
    .select('*').eq('id', requestId).maybeSingle();
  const request = data as ChangeRequestRow | null;
  if (error || !request) return { ok: false, status: 404, error: 'That request is no longer open.' };
  if (request.owner_user_id !== ownerUserId) {
    // Not this caller's to answer — and not theirs to know about.
    return { ok: false, status: 404, error: 'That request is no longer open.' };
  }

  const table = TABLE_OF_RECORD[request.record_type];

  if (request.kind === 'edit') {
    if (!accept) {
      await supabase.from('household_change_requests')
        .update({ status: 'declined', resolved_at: new Date().toISOString() })
        .eq('id', requestId);
      return { ok: true, status: 200, outcome: 'kept' };
    }
    const patch = { ...(request.patch ?? {}), updated_at: new Date().toISOString() };
    const { error: applyError } = await supabase.from(table)
      .update(patch).eq('id', request.record_id).eq('user_id', ownerUserId);
    if (applyError) {
      console.warn('[hcr] applying approved edit failed:', applyError.message);
      return { ok: false, status: 500, error: 'Could not apply that change.' };
    }
    await supabase.from('household_change_requests').delete().eq('id', requestId);
    snapshotSoon(ownerUserId);
    return { ok: true, status: 200, outcome: 'applied' };
  }

  // kind === 'delete'
  if (!accept) {
    await supabase.from('household_change_requests').delete().eq('id', requestId);
    return { ok: true, status: 200, outcome: 'kept' };
  }
  await deleteRecordAsOwner(table, request.record_id, ownerUserId);
  return { ok: true, status: 200, outcome: 'deleted' };
}

/** The real delete, with the same cascades each entity's own DELETE route runs
 *  for its owner — approving from a Telegram button must not delete less. */
async function deleteRecordAsOwner(
  table: ShareableTable, id: string, ownerUserId: string,
): Promise<void> {
  if (table === 'bank_accounts' || table === 'credit_cards') {
    await supabase.from('transactions').delete().eq('account_id', id).eq('user_id', ownerUserId);
  }
  if (table === 'loans') {
    await supabase.from('bills').delete().eq('user_id', ownerUserId).eq('loan_id', id);
  }
  await revokeGrantsFor(table, id);
  const type = RECORD_OF_TABLE[table];
  await supabase.from('record_households').delete()
    .eq('record_type', type).eq('record_id', id);
  await supabase.from('household_change_requests').delete()
    .eq('record_type', type).eq('record_id', id);
  const { error } = await supabase.from(table).delete()
    .eq('id', id).eq('user_id', ownerUserId);
  if (error) console.warn('[hcr] approved delete failed:', error.message);
  if (table === 'investments') {
    purgeInvestmentFromHistory(ownerUserId, id)
      .catch(err => console.error('[hcr] purge investment history failed:', err));
  }
  snapshotSoon(ownerUserId);
}

function snapshotSoon(userId: string): void {
  recordNetWorthSnapshot(userId)
    .catch(err => console.error('[nw] post-approval snapshot failed:', err));
}

// ─── The owner's inbox ────────────────────────────────────────────────────────

export interface PendingChangeRequest extends ChangeRequestRow {
  requested_by_name: string | null;
  household_name: string | null;
}

/** Everything waiting for this owner's answer, with the names the prompt needs.
 *  Declined edits are settled — only `pending` is an ask. */
export async function pendingRequestsFor(ownerUserId: string): Promise<PendingChangeRequest[]> {
  const { data, error } = await supabase.from('household_change_requests')
    .select('*')
    .eq('owner_user_id', ownerUserId).eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[hcr] pending lookup failed:', error.message);
    return [];
  }
  const requests = (data ?? []) as ChangeRequestRow[];
  if (!requests.length) return [];

  const userIds = [...new Set(requests.map(r => r.requested_by))];
  const householdIds = [...new Set(requests.map(r => r.household_id))];
  const [users, households] = await Promise.all([
    supabase.from('users').select('id, name, email').in('id', userIds),
    supabase.from('households').select('id, name').in('id', householdIds),
  ]);
  const nameOf = new Map((users.data ?? []).map(u => [u.id as string, (u.name || u.email) as string]));
  const householdName = new Map((households.data ?? []).map(h => [h.id as string, h.name as string]));

  return requests.map(r => ({
    ...r,
    requested_by_name: nameOf.get(r.requested_by) ?? null,
    household_name: householdName.get(r.household_id) ?? null,
  }));
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
//
// Self-contained calls to api.telegram.org (no import of telegramService — that
// file wires ITS inbound handlers to THIS one, and a cycle helps nobody). The
// alert carries inline Apply/Keep buttons whose callback_data round-trips the
// request id; both the webhook route and the local-dev polling bot hand
// callback presses to `handleTelegramCallback` below.

async function tgApi(
  botToken: string, method: string, body: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

const NOUN: Record<ShareRecordType, string> = {
  account: 'bank account', card: 'credit card', transaction: 'transaction',
  loan: 'loan', property: 'property', budget: 'budget', goal: 'goal',
  investment: 'investment', income: 'income entry',
};

function describeChange(patch: Record<string, unknown>, previous: OwnedRow): string {
  return Object.entries(patch).slice(0, 6).map(([key, value]) => {
    const before = previous[key];
    const pretty = key.replace(/_/g, ' ');
    return before === undefined || before === null
      ? `${pretty} → ${String(value)}`
      : `${pretty}: ${String(before)} → ${String(value)}`;
  }).join('\n');
}

async function notifyOwner(
  ownerUserId: string, type: ShareRecordType, recordId: string,
  householdId: string, requestedBy: string,
  kind: 'edit' | 'delete', patch: Record<string, unknown> | null, row: OwnedRow,
): Promise<void> {
  const [{ data: owner }, { data: requester }, { data: household }] = await Promise.all([
    supabase.from('users').select('telegram_bot_token, telegram_chat_id').eq('id', ownerUserId).single(),
    supabase.from('users').select('name, email').eq('id', requestedBy).single(),
    supabase.from('households').select('name').eq('id', householdId).single(),
  ]);
  if (!owner?.telegram_bot_token || !owner?.telegram_chat_id) return;

  const who = requester?.name || requester?.email || 'A household member';
  const where = household?.name ?? 'your household';
  const what = `${NOUN[type]}${labelOf(row) ? ` "${labelOf(row)}"` : ''}`;

  // Look up the live request id(s) so the buttons answer the right ask.
  const { data: request } = await supabase.from('household_change_requests')
    .select('id')
    .eq('record_type', type).eq('record_id', recordId)
    .eq('household_id', householdId).eq('kind', kind)
    .maybeSingle();
  if (!request) return;

  const text = kind === 'edit'
    ? `✏️ ${who} changed the ${what} in ${where}:\n\n${describeChange(patch ?? {}, row)}\n\n` +
      `The household now sees this version. Apply it to your own account too?`
    : `🗑 ${who} removed the ${what} from ${where} and asked to delete it from your account as well. ` +
      `It's already out of the household view — your own copy is untouched until you say so.`;

  await tgApi(owner.telegram_bot_token, 'sendMessage', {
    chat_id: owner.telegram_chat_id,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: kind === 'edit' ? '✅ Apply to my account' : '🗑 Delete it for me too', callback_data: `hcr:y:${request.id}` },
        { text: kind === 'edit' ? '✋ Keep mine' : '✋ Keep it', callback_data: `hcr:n:${request.id}` },
      ]],
    },
  });
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

/**
 * An Apply/Keep button pressed on the alert. The webhook is per-user, so the
 * presser IS the owner the request belongs to — `respondToChangeRequest` still
 * verifies that, because a button press is not an identity.
 */
export async function handleTelegramCallback(
  userId: string, botToken: string, callback: TelegramCallbackQuery,
): Promise<void> {
  const match = /^hcr:(y|n):(.+)$/.exec(callback.data ?? '');
  if (!match) {
    await tgApi(botToken, 'answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const accept = match[1] === 'y';
  const result = await respondToChangeRequest(match[2], userId, accept);

  const note = !result.ok
    ? result.error ?? 'That request is no longer open.'
    : result.outcome === 'applied' ? 'Applied to your account.'
    : result.outcome === 'deleted' ? 'Deleted from your account too.'
    : 'Kept your version — the household keeps seeing theirs.';
  await tgApi(botToken, 'answerCallbackQuery', {
    callback_query_id: callback.id, text: note,
  });

  if (callback.message) {
    await tgApi(botToken, 'editMessageText', {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: `${callback.message.text ?? ''}\n\n— ${note}`,
    });
  }
}
