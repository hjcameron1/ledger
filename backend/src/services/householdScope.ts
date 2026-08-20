/**
 * Phase 7.1 — household scope and permissions, server side.
 *
 * The law, unchanged from the client engine (frontend/src/utils/household.ts):
 * SHARING CHANGES WHO CAN SEE A ROW, NEVER HOW MANY ROWS THERE ARE. A shared
 * account is the same single row its owner already had, carrying a
 * `household_id`. Nothing here copies a row, and nothing here changes a
 * `user_id` — ownership survives sharing, removal and deletion alike.
 *
 * ── Why this exists as well as the client engine ────────────────────────────
 * The client engine decides what to SHOW. This decides what a request is
 * ALLOWED to see and change, which is a different job with a different failure
 * mode: a bug there shows the wrong number, a bug here shows the wrong person's
 * money. So the rules are enforced again, from the token, over the real rows —
 * the same posture the rest of this backend takes (service-role key, every query
 * scoped, RLS denying direct access). The two files are deliberately parallel;
 * the client one is the canonical statement of the product rules.
 *
 * ── Phase 7.2 ───────────────────────────────────────────────────────────────
 * There are now TWO grants, and this file enforces both:
 *
 *   HOUSEHOLD SHARE  a `record_households` row beside it. Puts it into a shared
 *                    view with totals of its own, where it is counted exactly
 *                    once. A row may be shared with SEVERAL households at once —
 *                    it appears, and counts, once in each of them.
 *   DIRECT GRANT     a `record_shares` row beside it. Lets ONE named person see
 *                    ONE row that stays entirely its owner's, and that enters no
 *                    view and no total anywhere.
 *
 * Both are now join tables beside the row rather than columns on it. The old
 * single `household_id` column still exists but is no longer read or written —
 * one column could only ever name one household.
 *
 * Neither copies a row and neither touches `user_id`, so the second half of the
 * law holds here too: SHARING NEVER CHANGES WHOSE ROW IT IS.
 */

import { supabase } from '../utils/supabase';

export type HouseholdRole = 'owner' | 'admin' | 'member' | 'viewer';

/** Tables whose rows may be personal or shared. Every one of them already
 *  existed; households added a nullable pointer, not a table. */
export const SHAREABLE_TABLES = [
  'bank_accounts', 'credit_cards', 'transactions', 'loans',
  'properties', 'budgets', 'goals', 'investments',
] as const;
export type ShareableTable = (typeof SHAREABLE_TABLES)[number];

/** The product's word for each of those tables — what `record_shares` stores,
 *  what the API speaks, and what both client engines call things. */
export type ShareRecordType =
  | 'account' | 'card' | 'transaction' | 'loan' | 'property' | 'budget' | 'goal'
  | 'investment';

export type SharePermission = 'view' | 'edit';

/** The one place the two vocabularies meet. Kept as a pair of total maps rather
 *  than a pile of switch statements, so adding an eighth shareable thing is one
 *  edit the compiler checks. */
export const TABLE_OF_RECORD: Record<ShareRecordType, ShareableTable> = {
  account: 'bank_accounts',
  card: 'credit_cards',
  transaction: 'transactions',
  loan: 'loans',
  property: 'properties',
  budget: 'budgets',
  goal: 'goals',
  investment: 'investments',
};

export const RECORD_OF_TABLE: Record<ShareableTable, ShareRecordType> = {
  bank_accounts: 'account',
  credit_cards: 'card',
  transactions: 'transaction',
  loans: 'loan',
  properties: 'property',
  budgets: 'budget',
  goals: 'goal',
  investments: 'investment',
};

export type HouseholdAction =
  | 'view_shared' | 'edit_shared' | 'share_own'
  | 'invite_member' | 'remove_member' | 'change_role'
  | 'transfer_ownership' | 'rename_household' | 'delete_household';

const PERMISSIONS: Record<HouseholdAction, HouseholdRole[]> = {
  view_shared:        ['owner', 'admin', 'member', 'viewer'],
  edit_shared:        ['owner', 'admin', 'member'],
  share_own:          ['owner', 'admin', 'member'],
  invite_member:      ['owner', 'admin'],
  remove_member:      ['owner', 'admin'],
  change_role:        ['owner'],
  transfer_ownership: ['owner'],
  rename_household:   ['owner', 'admin'],
  delete_household:   ['owner'],
};

export function roleCan(role: HouseholdRole | null, action: HouseholdAction): boolean {
  return !!role && PERMISSIONS[action].includes(role);
}

/** Everything a request may see beyond its own rows: the households the user is
 *  an active member of, and every row granted to them directly. */
export interface HouseholdScope {
  userId: string;
  /** household_id → role. Empty for the overwhelming majority of users, and the
   *  empty case is the one that must behave exactly as it did before 7.1. */
  roles: Map<string, HouseholdRole>;
  /** record_type → (record_id → what they may do with it). Rows other people
   *  have shared with this user DIRECTLY. Empty for nearly everybody, and the
   *  empty case must behave exactly as it did before 7.2. */
  grants: Map<ShareRecordType, Map<string, SharePermission>>;
  /** record_type → the record ids shared with ANY household this user is in.
   *  Built from `record_households`, the many-to-many join that replaced the
   *  single `household_id` column: one row can now be shared to several
   *  households, so household visibility is an id-set (like a direct grant),
   *  not a column match. Empty for everyone not in a household. */
  householdRecords: Map<ShareRecordType, Set<string>>;
}

const emptyScope = (userId: string): HouseholdScope =>
  ({ userId, roles: new Map(), grants: new Map(), householdRecords: new Map() });

export async function loadScope(userId: string): Promise<HouseholdScope> {
  const scope = emptyScope(userId);

  const [memberships, shares] = await Promise.all([
    supabase.from('household_members')
      .select('household_id, role').eq('user_id', userId).eq('status', 'active'),
    supabase.from('record_shares')
      .select('record_type, record_id, permission')
      .eq('shared_with_user_id', userId).eq('status', 'active'),
  ]);

  // A failure on either side (not least the window between deploying this and
  // running the migration) must not lock anybody out of their own data: with
  // nothing resolved, every query below falls back to "your own rows", which is
  // exactly the behaviour that shipped for years before any of this existed.
  if (memberships.error) {
    console.warn('[sharing] household lookup failed, falling back to personal-only:',
      memberships.error.message);
  } else {
    for (const row of memberships.data ?? []) {
      scope.roles.set(row.household_id as string, row.role as HouseholdRole);
    }
  }

  if (shares.error) {
    console.warn('[sharing] grant lookup failed, falling back to personal-only:',
      shares.error.message);
  } else {
    for (const row of shares.data ?? []) {
      const type = row.record_type as ShareRecordType;
      const byId = scope.grants.get(type) ?? new Map<string, SharePermission>();
      byId.set(row.record_id as string, row.permission as SharePermission);
      scope.grants.set(type, byId);
    }
  }

  // Which rows are shared with a household this user is in. This is what the
  // single `household_id` column used to answer with a column match; now that a
  // row can be in several households it is an id-set per record type, resolved
  // once here and consulted like a direct grant. Only queried when the user is
  // actually in a household — the common (personal-only) path never touches it,
  // and a failure (e.g. before the migration runs) leaves it empty, which is the
  // same safe personal-only fallback the rest of this function takes.
  const householdIdList = householdIds(scope);
  if (householdIdList.length) {
    const memberships = await supabase
      .from('record_households')
      .select('record_type, record_id')
      .in('household_id', householdIdList);
    if (memberships.error) {
      console.warn('[sharing] household-record lookup failed, personal + direct only:',
        memberships.error.message);
    } else {
      for (const row of memberships.data ?? []) {
        const type = row.record_type as ShareRecordType;
        const set = scope.householdRecords.get(type) ?? new Set<string>();
        set.add(row.record_id as string);
        scope.householdRecords.set(type, set);
      }
    }
  }

  return scope;
}

/** Rows of one kind granted to this user directly. */
export function grantedIds(scope: HouseholdScope, type: ShareRecordType): string[] {
  return [...(scope.grants.get(type)?.keys() ?? [])];
}

export function grantedPermission(
  scope: HouseholdScope, type: ShareRecordType, id: string,
): SharePermission | null {
  return scope.grants.get(type)?.get(id) ?? null;
}

/**
 * The accounts and cards somebody granted this user.
 *
 * One job: deciding which transactions come with them. Sharing an account shares
 * what happened on it, because an account without its transactions is a number
 * with no explanation — and the cascade is derived here at read time rather than
 * stamped on the rows, so revoking the account takes them all back in the same
 * instant, with the same single write.
 */
export function grantedAccountIds(scope: HouseholdScope): string[] {
  return [...grantedIds(scope, 'account'), ...grantedIds(scope, 'card')];
}

/** True when this user has no sharing of any kind — the fast path, and the one
 *  that must behave exactly as it did before either phase shipped. */
export function isPersonalOnly(scope: HouseholdScope): boolean {
  return scope.roles.size === 0 && scope.grants.size === 0;
}

export function householdIds(scope: HouseholdScope): string[] {
  return [...scope.roles.keys()];
}

export function roleIn(scope: HouseholdScope, householdId: string | null | undefined): HouseholdRole | null {
  if (!householdId) return null;
  return scope.roles.get(householdId) ?? null;
}

export function isMemberOf(scope: HouseholdScope, householdId: string | null | undefined): boolean {
  return roleIn(scope, householdId) !== null;
}

/**
 * The PostgREST filter for "rows this user may see": their own, plus rows shared
 * with a household they are in. Applied with `.or(...)` in place of the usual
 * `.eq('user_id', …)`.
 *
 * Returns null when the user is in no household — the caller then uses the plain
 * `.eq('user_id', …)` it always used, so the common path gains no `or`, no extra
 * index work and no new way to be wrong.
 */
export function visibilityFilter(
  scope: HouseholdScope, table?: ShareableTable,
): string | null {
  const parts = [`user_id.eq.${scope.userId}`];

  if (table) {
    const type = RECORD_OF_TABLE[table];

    // Rows the user may see by id: those shared with a household they are in
    // (the many-to-many join — was the single `household_id` column) AND those
    // granted to them directly. Both resolve to "this row's id is in a set", so
    // they merge into one `id.in.(...)` — a row reachable both ways is still one
    // row, matched once.
    const ids = new Set<string>([
      ...(scope.householdRecords.get(type) ?? []),
      ...grantedIds(scope, type),
    ]);
    if (ids.size) parts.push(`id.in.(${[...ids].join(',')})`);

    // The transaction cascade: a granted ACCOUNT brings what happened on it.
    // Derived here rather than stamped on the rows, so revoking the account
    // takes every one of them back in the same instant.
    if (table === 'transactions') {
      const accounts = grantedAccountIds(scope);
      if (accounts.length) parts.push(`account_id.in.(${accounts.join(',')})`);
    }
  }

  // Only ownership applies — return null so the caller uses the plain
  // `.eq('user_id', …)` it always used. The common path gains no `or`, no extra
  // index work and no new way to be wrong.
  return parts.length === 1 ? null : parts.join(',');
}

/**
 * Apply that filter to a query builder.
 *
 * The `.or()` form has to name `user_id` itself, so this replaces the caller's
 * `.eq('user_id', …)` rather than adding to it — combining the two would AND
 * them together and hide every row the user does not own, which is the precise
 * opposite of the intent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scopedQuery<T extends { eq: any; or: any }>(
  query: T, scope: HouseholdScope, table?: ShareableTable,
): T {
  const filter = visibilityFilter(scope, table);
  return filter ? query.or(filter) : query.eq('user_id', scope.userId);
}

/** What a write was refused for, or null when it is allowed. */
export type WriteRefusal = { status: number; error: string } | null;

/**
 * The columns a write check needs to read.
 *
 * Ownership is all the ROW itself can tell us now: which households it is shared
 * with lives in the join table, not on the row. So this is a two-column read for
 * everybody, and it names no column the migration might not have added yet.
 */
function ownershipColumns(_scope: HouseholdScope): string {
  return 'id, user_id';
}

/** The columns a transaction's write check needs — `account_id` as well, because
 *  a transaction can be writable through the account it sits on. */
function transactionColumns(scope: HouseholdScope): string {
  return isPersonalOnly(scope) ? 'id, user_id' : 'id, user_id, account_id';
}

interface OwnershipRow {
  user_id?: string;
  account_id?: string | null;
}

/**
 * What a DIRECT grant lets this user do with this row, or null when there is no
 * grant. A transaction inherits the permission of the account it arrived with,
 * because it arrived as part of that account and not as a decision of its own.
 */
function directPermission(
  table: ShareableTable, row: OwnershipRow, id: string, scope: HouseholdScope,
): SharePermission | null {
  const direct = grantedPermission(scope, RECORD_OF_TABLE[table], id);
  if (direct) return direct;
  if (table !== 'transactions' || !row.account_id) return null;
  return grantedPermission(scope, 'account', row.account_id)
      ?? grantedPermission(scope, 'card', row.account_id);
}

/**
 * The households a single row is shared with, read from the join. One row can be
 * in several now, so this replaces the old "read the row's `household_id` column"
 * — the write checks below ask it whether the caller has an editing role in ANY
 * of the households a shared row belongs to.
 */
export async function householdsOfRecord(
  recordType: ShareRecordType, recordId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('record_households')
    .select('household_id')
    .eq('record_type', recordType).eq('record_id', recordId);
  if (error) {
    console.warn(`[sharing] household lookup for ${recordType} failed:`, error.message);
    return [];
  }
  return (data ?? []).map(r => r.household_id as string);
}

/** The most-privileged role the caller holds in any household this row is shared
 *  with, or null when the row is in none of their households. */
async function roleForSharedRow(
  table: ShareableTable, id: string, scope: HouseholdScope,
): Promise<HouseholdRole | null> {
  const households = await householdsOfRecord(RECORD_OF_TABLE[table], id);
  let best: HouseholdRole | null = null;
  for (const h of households) {
    const role = roleIn(scope, h);
    if (role && (!best || roleCan(role, 'edit_shared'))) best = role;
  }
  return best;
}

/**
 * May this user write to this row?
 *
 * Their own row, always — sharing something never signs away control of it.
 * Somebody else's, only when it is shared with a household where their role can
 * edit shared money. A viewer therefore sees the joint account and cannot touch
 * it, which is the whole point of the role.
 *
 * A row nobody can see returns 404 rather than 403: "you may not edit this" and
 * "this is not yours to know about" are different answers, and only the first
 * should ever be given about a row the caller can legitimately see.
 */
export async function refuseWrite(
  table: ShareableTable, id: string, scope: HouseholdScope,
): Promise<WriteRefusal> {
  const columns = table === 'transactions' ? transactionColumns(scope) : ownershipColumns(scope);
  const { data, error } = await supabase
    .from(table).select(columns).eq('id', id).maybeSingle();

  // The select list is chosen at runtime, so PostgREST's inferred row type can't
  // be relied on here — the shape is asserted instead.
  const row = data as OwnershipRow | null;
  if (error || !row) return { status: 404, error: 'Not found' };
  if (row.user_id === scope.userId) return null;

  // A direct grant, when there is one: `edit` may correct the row, `view` may
  // not. Checked before the household rule because a row can be reachable both
  // ways and the more specific grant is the one the owner actually made.
  const granted = directPermission(table, row, id, scope);
  if (granted === 'edit') return null;

  // The best role the caller has across every household this row is shared with.
  // A row in two households where they can edit in one is editable; a row only
  // in households where they are a viewer is not.
  const role = await roleForSharedRow(table, id, scope);
  if (!role) {
    // Visible only because somebody shared it to LOOK at. "You may not change
    // this" is the honest answer; 404 would deny a row they can plainly see.
    if (granted === 'view') {
      return { status: 403, error: 'This was shared with you to look at, not to change.' };
    }
    return { status: 404, error: 'Not found' };
  }
  if (!roleCan(role, 'edit_shared')) {
    return { status: 403, error: 'Viewers can see shared money but not change it.' };
  }
  return null;
}

/**
 * May this user DELETE this row?
 *
 * Its owner, and only its owner — deliberately stricter than editing.
 *
 * Deleting a shared account does not remove it from the household view; it
 * removes it from its OWNER's finances as well, which is not a shared-view
 * decision to make on somebody else's behalf. The household-level lever for "I
 * don't want this in here" is un-sharing, which is reversible and touches
 * nothing. So a partner may correct the joint account's balance and may not
 * delete the account, and that asymmetry is the point.
 */
export async function refuseDelete(
  table: ShareableTable, id: string, scope: HouseholdScope,
): Promise<WriteRefusal> {
  const { data, error } = await supabase
    .from(table).select(ownershipColumns(scope)).eq('id', id).maybeSingle();

  // The select list is chosen at runtime, so PostgREST's inferred row type can't
  // be relied on here — the shape is asserted instead.
  const row = data as OwnershipRow | null;
  if (error || !row) return { status: 404, error: 'Not found' };
  if (row.user_id === scope.userId) return null;
  const granted = directPermission(table, row, id, scope);
  const inMyHousehold = (await householdsOfRecord(RECORD_OF_TABLE[table], id))
    .some(h => isMemberOf(scope, h));
  if (!inMyHousehold && !granted) {
    return { status: 404, error: 'Not found' };
  }
  return {
    status: 403,
    error: granted
      ? 'Only the person this belongs to can delete it. You can stop sharing it instead.'
      : 'Only the person this belongs to can delete it. You can remove it from the household instead.',
  };
}

/**
 * May this user stamp this household onto a row they are creating or updating?
 *
 * Only into a household they can act in. `null` (making something personal
 * again) is always allowed for a row they own — the ownership half of that is
 * checked by refuseWrite before this is reached.
 */
export function refuseShare(householdId: string | null | undefined, scope: HouseholdScope): WriteRefusal {
  if (!householdId) return null;
  const role = roleIn(scope, householdId);
  if (!role) return { status: 403, error: "You're not a member of that household." };
  if (!roleCan(role, 'share_own')) {
    return { status: 403, error: 'Viewers can see shared money but not add to it.' };
  }
  return null;
}

/**
 * Take every row a departing member shared back out of the household.
 *
 * Their rows revert to personal — still theirs, still every cent of them, simply
 * no longer part of a household they have left. Nothing is deleted: removal
 * takes access, not money. Leaving them stamped would be quietly worse than it
 * looks, because the household view would go on counting the net worth of
 * somebody who is no longer in it.
 */
export async function unshareRowsOf(userId: string, householdId: string): Promise<void> {
  // One delete against the join, not seven column updates. Only THIS household's
  // memberships go — a row they also shared with another household stays in that
  // one, which is the whole point of the many-to-many.
  const { error } = await supabase
    .from('record_households')
    .delete()
    .eq('owner_user_id', userId)
    .eq('household_id', householdId);
  if (error) console.warn('[household] un-share on leave failed:', error.message);
}

/**
 * End every direct grant on a row that has just been deleted.
 *
 * `record_shares.record_id` has no foreign key — one grant table across seven
 * entity tables cannot have one — so nothing in the database cleans this up.
 * Left alone the grant is harmless (the row is gone, so it resolves to nothing
 * on every screen), but the owner's Sharing list would keep offering to stop
 * sharing something that no longer exists, which is exactly the kind of quiet
 * wrongness this phase exists to prevent.
 *
 * Marked 'revoked' rather than deleted, like every other ending: the history
 * should still be able to say who could once see what.
 */
export async function revokeGrantsFor(table: ShareableTable, recordId: string): Promise<void> {
  const type = RECORD_OF_TABLE[table];
  const { error } = await supabase.from('record_shares')
    .update({ status: 'revoked', ended_at: new Date().toISOString() })
    .eq('record_type', type).eq('record_id', recordId).eq('status', 'active');
  if (error) console.warn(`[sharing] grant cleanup for ${type} failed:`, error.message);

  // Unredeemed links to it are dead too — there is nothing left to redeem them
  // for, and a code that resolves to a missing row is a confusing failure.
  const { error: codeError } = await supabase.from('share_codes')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('record_type', type).eq('record_id', recordId).eq('status', 'active');
  if (codeError) console.warn(`[sharing] code cleanup for ${type} failed:`, codeError.message);
}

/** Every shared row in a household, for the plan a removal or deletion reports.
 *  Keyed by TABLE (what the callers report on), counted from the join. */
export async function sharedRowCounts(householdId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SHAREABLE_TABLES) counts[table] = 0;

  const { data, error } = await supabase
    .from('record_households')
    .select('record_type')
    .eq('household_id', householdId);
  if (error) {
    console.warn('[household] shared-row count failed:', error.message);
    return counts;
  }
  for (const row of data ?? []) {
    const table = TABLE_OF_RECORD[row.record_type as ShareRecordType];
    if (table) counts[table] += 1;
  }
  return counts;
}

/**
 * Put a row into exactly the households asked for, and no others.
 *
 * The one write path for household sharing. It diffs rather than replaces so
 * that re-saving an unchanged row touches nothing, and every ADDITION is checked
 * against `refuseShare` — a member can only ever put a row into a household they
 * may act in. Removals need no such check: taking your own row back out of a
 * household is always yours to do.
 *
 * Only the row's OWNER may call this (the caller checks ownership first): sharing
 * somebody else's account would be publishing data that was never yours.
 */
export async function reconcileRecordHouseholds(
  recordType: ShareRecordType,
  recordId: string,
  ownerUserId: string,
  desired: string[],
  scope: HouseholdScope,
): Promise<WriteRefusal> {
  const current = await householdsOfRecord(recordType, recordId);
  const wanted = [...new Set(desired)];

  const added = wanted.filter(h => !current.includes(h));
  const removed = current.filter(h => !wanted.includes(h));

  for (const householdId of added) {
    const refusal = refuseShare(householdId, scope);
    if (refusal) return refusal;
  }

  if (added.length) {
    const { error } = await supabase.from('record_households').insert(
      added.map(householdId => ({
        record_type: recordType, record_id: recordId,
        household_id: householdId, owner_user_id: ownerUserId,
      })),
    );
    // A duplicate is not a failure: the unique index means "already shared there",
    // which is the state the caller asked for anyway.
    if (error && error.code !== '23505') {
      console.warn(`[sharing] share ${recordType} failed:`, error.message);
      return { status: 500, error: 'Could not share that.' };
    }
  }

  if (removed.length) {
    const { error } = await supabase.from('record_households')
      .delete()
      .eq('record_type', recordType).eq('record_id', recordId)
      .in('household_id', removed);
    if (error) {
      console.warn(`[sharing] un-share ${recordType} failed:`, error.message);
      return { status: 500, error: 'Could not change that.' };
    }
  }

  return null;
}

/**
 * The whole of "this row should now be in these households", for a route.
 *
 * One call per PUT: it does nothing at all unless the request actually carried
 * `household_ids` (so an ordinary edit never touches sharing), and it enforces
 * the one rule the row itself decides — ONLY THE OWNER MAY SHARE IT. A household
 * member who can edit the joint account still cannot put it into a household of
 * their own, because that would be publishing somebody else's data.
 */
export async function applyHouseholdShare(
  table: ShareableTable, id: string, scope: HouseholdScope, body: unknown,
): Promise<WriteRefusal> {
  const desired = (body as { household_ids?: unknown } | null)?.household_ids;
  if (!Array.isArray(desired)) return null;

  const { data, error } = await supabase
    .from(table).select('user_id').eq('id', id).maybeSingle();
  if (error || !data) return { status: 404, error: 'Not found' };
  if ((data as { user_id?: string }).user_id !== scope.userId) {
    return { status: 403, error: 'Only the person this belongs to can share it.' };
  }

  return reconcileRecordHouseholds(
    RECORD_OF_TABLE[table], id, scope.userId, desired.map(String), scope,
  );
}

/**
 * Attach `household_ids` to rows on their way out to the client.
 *
 * The client engine needs to know which households each row sits in — to draw
 * the Sharing panel, and to narrow a list to the household being viewed. It is
 * one batched read for the whole page of rows rather than one per row, and it is
 * skipped entirely when the response is empty.
 */
export async function attachHouseholds<T extends { id: string }>(
  recordType: ShareRecordType, rows: T[],
): Promise<(T & { household_ids: string[] })[]> {
  if (!rows.length) return [];

  const { data, error } = await supabase
    .from('record_households')
    .select('record_id, household_id')
    .eq('record_type', recordType)
    .in('record_id', rows.map(r => r.id));

  const byRecord = new Map<string, string[]>();
  if (error) {
    // Never fatal: the rows themselves are the important part of the response,
    // and an empty array simply reads as "not in any household" until the next
    // load. This is also what makes the code safe to deploy before the migration.
    console.warn(`[sharing] household attach for ${recordType} failed:`, error.message);
  } else {
    for (const row of data ?? []) {
      const id = row.record_id as string;
      byRecord.set(id, [...(byRecord.get(id) ?? []), row.household_id as string]);
    }
  }

  return rows.map(r => ({ ...r, household_ids: byRecord.get(r.id) ?? [] }));
}
