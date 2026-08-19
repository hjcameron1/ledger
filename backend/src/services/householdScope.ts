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
 */

import { supabase } from '../utils/supabase';

export type HouseholdRole = 'owner' | 'admin' | 'member' | 'viewer';

/** Tables whose rows may be personal or shared. Every one of them already
 *  existed; households added a nullable pointer, not a table. */
export const SHAREABLE_TABLES = [
  'bank_accounts', 'credit_cards', 'transactions', 'loans',
  'properties', 'budgets', 'goals',
] as const;
export type ShareableTable = (typeof SHAREABLE_TABLES)[number];

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

/** The households a user is an ACTIVE member of, and at what role. */
export interface HouseholdScope {
  userId: string;
  /** household_id → role. Empty for the overwhelming majority of users, and the
   *  empty case is the one that must behave exactly as it did before 7.1. */
  roles: Map<string, HouseholdRole>;
}

export async function loadScope(userId: string): Promise<HouseholdScope> {
  const { data, error } = await supabase
    .from('household_members')
    .select('household_id, role')
    .eq('user_id', userId)
    .eq('status', 'active');

  const roles = new Map<string, HouseholdRole>();
  // A failure here (not least the window between deploying this and running the
  // migration) must not lock anybody out of their own data: with no households
  // resolved, every query below falls back to "your own rows", which is exactly
  // the behaviour that shipped for years before households existed.
  if (error) {
    console.warn('[household] scope lookup failed, falling back to personal-only:', error.message);
    return { userId, roles };
  }
  for (const row of data ?? []) roles.set(row.household_id as string, row.role as HouseholdRole);
  return { userId, roles };
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
export function visibilityFilter(scope: HouseholdScope): string | null {
  const ids = householdIds(scope);
  if (ids.length === 0) return null;
  return `user_id.eq.${scope.userId},household_id.in.(${ids.join(',')})`;
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
export function scopedQuery<T extends { eq: any; or: any }>(query: T, scope: HouseholdScope): T {
  const filter = visibilityFilter(scope);
  return filter ? query.or(filter) : query.eq('user_id', scope.userId);
}

/** What a write was refused for, or null when it is allowed. */
export type WriteRefusal = { status: number; error: string } | null;

/**
 * The columns a write check needs to read.
 *
 * For a user in no household — nearly everybody — ownership is the ONLY rule
 * that can apply, so `household_id` is never consulted and is not asked for.
 * That keeps the common path a two-column read, and it is also what makes this
 * code safe to deploy BEFORE the migration adds that column: without a
 * household nobody can reach a query that names it.
 */
function ownershipColumns(scope: HouseholdScope): string {
  return scope.roles.size === 0 ? 'id, user_id' : 'id, user_id, household_id';
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
  const { data, error } = await supabase
    .from(table).select(ownershipColumns(scope)).eq('id', id).maybeSingle();

  // The select list is chosen at runtime, so PostgREST's inferred row type can't
  // be relied on here — the shape is asserted instead.
  const row = data as { user_id?: string; household_id?: string | null } | null;
  if (error || !row) return { status: 404, error: 'Not found' };
  if (row.user_id === scope.userId) return null;

  const role = roleIn(scope, row.household_id ?? null);
  if (!role) return { status: 404, error: 'Not found' };
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
  const row = data as { user_id?: string; household_id?: string | null } | null;
  if (error || !row) return { status: 404, error: 'Not found' };
  if (row.user_id === scope.userId) return null;
  if (!roleIn(scope, row.household_id ?? null)) return { status: 404, error: 'Not found' };
  return { status: 403, error: 'Only the person this belongs to can delete it. You can remove it from the household instead.' };
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
  for (const table of SHAREABLE_TABLES) {
    const { error } = await supabase
      .from(table)
      .update({ household_id: null })
      .eq('user_id', userId)
      .eq('household_id', householdId);
    if (error) console.warn(`[household] un-share ${table} failed:`, error.message);
  }
}

/** Every shared row in a household, for the plan a removal or deletion reports. */
export async function sharedRowCounts(householdId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SHAREABLE_TABLES) {
    const { count } = await supabase
      .from(table).select('id', { count: 'exact', head: true }).eq('household_id', householdId);
    counts[table] = count ?? 0;
  }
  return counts;
}
