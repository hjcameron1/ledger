/**
 * Phase 7.1 — the household engine.
 *
 * Pure functions over households, their members and the ordinary Ledger rows
 * those members share. No store, no React, no I/O: every question the Personal
 * and Household views ask is answered here, so the screens can only ever say
 * what the rules say.
 *
 * ── The one law ─────────────────────────────────────────────────────────────
 * SHARING CHANGES WHO CAN SEE A ROW. IT NEVER CHANGES HOW MANY ROWS THERE ARE.
 *
 * A shared account is the SAME single row its owner already had, recorded
 * against one or more households. There is no copy in the partner's data, no
 * mirrored balance, no second transaction, no household-side ledger. Nothing in
 * this file creates a row; every function here only ever SELECTS from rows that
 * already exist. That is what makes the arithmetic safe:
 *
 *   • the household total sums each shared row exactly once, however many
 *     members can see it — and a row shared with SEVERAL households is counted
 *     once in each of them, which is the same statement, not a contradiction:
 *     the two households are separate pictures, never added together;
 *   • a member's personal total is the rows they OWN, so the members' personal
 *     totals add up to the household total — nothing missing, nothing twice
 *     (`partitionByOwner` exists to make that provable);
 *   • removing a member removes their ACCESS, never anybody's money.
 *
 * ── The two views ───────────────────────────────────────────────────────────
 *   PERSONAL   the rows you own — your whole financial life, shared or not,
 *              because a joint account is still your money.
 *   HOUSEHOLD  the rows shared with the household, from every member, each
 *              counted once. Nobody's private rows appear here, ever. That is
 *              the entire privacy guarantee, and it is one line of code
 *              (`householdRows`) rather than a policy anyone has to remember.
 *
 * A user's private savings account is therefore invisible to their partner even
 * while the two of them share a mortgage, and no aggregate anywhere can leak it,
 * because no aggregate is ever computed from anything but the row's households
 * (`householdsOf`) — a row nobody shared is in none of them.
 *
 * ── Ownership survives sharing ──────────────────────────────────────────────
 * `user_id` never moves. Sharing a row does not transfer it, un-sharing does not
 * transfer it back, and removing a member does not hand their accounts to
 * anybody. The household is a lens, not an owner.
 *
 * For transactions there is a second, separate fact — `responsible_user_id`,
 * whose SPENDING a shared transaction is, which on a joint account routinely
 * differs from who imported it. It is a reporting attribution only: balances and
 * net worth are read from account rows, never by adding transactions up, so
 * attributing a transaction to a partner moves it between spending columns and
 * cannot move a dollar of anyone's net worth.
 */

import type {
  Household, HouseholdInvitation, HouseholdMember, HouseholdRole,
  InvitationStatus, FinanceScope, Shareable,
} from '../types';

// ═════════════════════════════════════════════════════════════════════════════
//  Roles and permissions
// ═════════════════════════════════════════════════════════════════════════════

/** Weakest first. Used for "can this role act on that one" comparisons. */
export const ROLE_ORDER: HouseholdRole[] = ['viewer', 'member', 'admin', 'owner'];

export function roleRank(role: HouseholdRole | null | undefined): number {
  const i = ROLE_ORDER.indexOf(role as HouseholdRole);
  return i < 0 ? -1 : i;
}

export const ROLE_LABEL: Record<HouseholdRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTION: Record<HouseholdRole, string> = {
  owner: 'Runs the household — roles, invitations and everything an admin can do.',
  admin: 'Invites and removes people, and edits the shared money.',
  member: 'Sees the shared money and edits it. Their own private data stays private.',
  viewer: 'Sees the shared money. Changes nothing.',
};

/** Everything a role can be asked to do. Names are the vocabulary the UI uses. */
export type HouseholdAction =
  | 'view_shared'      // see the household view at all
  | 'edit_shared'      // change a shared row somebody else owns
  | 'share_own'        // put one of your own rows into the household
  | 'invite_member'
  | 'remove_member'
  | 'change_role'
  | 'transfer_ownership'
  | 'rename_household'
  | 'delete_household';

/**
 * The permission matrix, written out in full rather than derived from rank —
 * a table you can read against the product decision is worth more than a clever
 * comparison that has to be reverse-engineered.
 *
 * Two rows deserve a note:
 *   `share_own` excludes viewer. A viewer is somebody trusted to look and not to
 *   act; letting them push their own accounts into the shared picture would be
 *   acting, and would put data in front of the household that the household
 *   never agreed to carry.
 *   `edit_shared` excludes viewer for the obvious reason, and includes member
 *   because a partner who cannot correct the joint account's balance is not
 *   really in the household.
 */
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

export function roleCan(role: HouseholdRole | null | undefined, action: HouseholdAction): boolean {
  if (!role) return false;
  return PERMISSIONS[action].includes(role);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Context — who is asking, and what are they a member of
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Everything the rules need to know about the signed-in user. Built once by the
 * caller and passed down, so no function here has to reach for global state and
 * every one of them can be tested with a literal.
 */
export interface HouseholdContext {
  /** The signed-in user. Null for a signed-out/demo session: they own nothing,
   *  so every rule below degrades to "your own rows only", which for a null user
   *  means rows with no owner stamped on them. */
  userId: string | null;
  households: Household[];
  members: HouseholdMember[];
  /** Which household the Household view is currently showing. Null falls back to
   *  the user's only household, which is the case for essentially everybody. */
  activeHouseholdId?: string | null;
}

export function buildContext(
  userId: string | null,
  households: Household[],
  members: HouseholdMember[],
  activeHouseholdId?: string | null,
): HouseholdContext {
  return { userId, households, members, activeHouseholdId: activeHouseholdId ?? null };
}

/** Members who are actually in the household right now. */
export function activeMembers(members: HouseholdMember[], householdId?: string | null): HouseholdMember[] {
  return members.filter(m =>
    m.status === 'active' && (!householdId || m.household_id === householdId));
}

/** A user's live membership of one household, or null. */
export function membershipOf(
  ctx: HouseholdContext, householdId: string, userId?: string | null,
): HouseholdMember | null {
  const who = userId ?? ctx.userId;
  if (!who) return null;
  return ctx.members.find(m =>
    m.household_id === householdId && m.user_id === who && m.status === 'active') ?? null;
}

/** A user's role in one household, or null when they aren't in it. */
export function roleIn(
  ctx: HouseholdContext, householdId: string, userId?: string | null,
): HouseholdRole | null {
  return membershipOf(ctx, householdId, userId)?.role ?? null;
}

export function isMemberOf(ctx: HouseholdContext, householdId: string, userId?: string | null): boolean {
  return membershipOf(ctx, householdId, userId) !== null;
}

/** Every household the user is an active member of, in stored order. */
export function myHouseholds(ctx: HouseholdContext): Household[] {
  if (!ctx.userId) return [];
  const ids = new Set(activeMembers(ctx.members).filter(m => m.user_id === ctx.userId).map(m => m.household_id));
  return ctx.households.filter(h => ids.has(h.id));
}

/**
 * The household the Household view means.
 *
 * `activeHouseholdId` when it is one the user is genuinely in — a stale id left
 * over from a household they were removed from must never keep resolving, or the
 * view would keep answering questions about a household they can no longer see.
 * Otherwise their first (usually only) household.
 */
export function activeHousehold(ctx: HouseholdContext): Household | null {
  const mine = myHouseholds(ctx);
  if (ctx.activeHouseholdId) {
    const picked = mine.find(h => h.id === ctx.activeHouseholdId);
    if (picked) return picked;
  }
  return mine[0] ?? null;
}

export function activeHouseholdId(ctx: HouseholdContext): string | null {
  return activeHousehold(ctx)?.id ?? null;
}

/** True when the user is in at least one household — what turns the view switch on. */
export function inAnyHousehold(ctx: HouseholdContext): boolean {
  return myHouseholds(ctx).length > 0;
}

/** Can the signed-in user do this, in the household the view is currently on. */
export function can(ctx: HouseholdContext, action: HouseholdAction, householdId?: string | null): boolean {
  const id = householdId ?? activeHouseholdId(ctx);
  if (!id) return false;
  return roleCan(roleIn(ctx, id), action);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Rows: who owns one, who may see it, who may change it
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The households a row is shared with.
 *
 * THE one accessor — every rule below is written against it, so the fact that a
 * row can now be in several households is stated in exactly one place.
 *
 * It also absorbs the old shape: a row cached by a client from before
 * multi-household sharing carries a single `household_id`, and reading it as a
 * one-element list means such a row keeps behaving correctly until the next load
 * replaces it. Nothing writes `household_id` any more.
 */
export function householdsOf(row: Shareable): string[] {
  if (row.household_ids) return row.household_ids;
  return row.household_id ? [row.household_id] : [];
}

/** True when this row is shared with any household at all. */
export function isShared(row: Shareable): boolean {
  return householdsOf(row).length > 0;
}

/**
 * True when the row belongs to this user.
 *
 * A row with no `user_id` counts as theirs. That is not a loophole: rows reach
 * the store from local-first creates and older caches without an owner stamped
 * on them, they are by construction the signed-in user's own, and treating them
 * as nobody's would make a user's own data vanish from their own screen.
 */
export function isOwnedBy(row: Shareable, userId: string | null): boolean {
  return !row.user_id || row.user_id === userId;
}

/**
 * May this user see this row?
 *
 * Exactly two ways, and there is no third: you own it, or it is shared with ANY
 * household you are an ACTIVE member of. Every filter below is built from this
 * one predicate, which is why a removed member loses sight of the shared rows
 * the moment their membership stops being active — no sweep, no cache to purge.
 */
export function canView(row: Shareable, ctx: HouseholdContext): boolean {
  if (isOwnedBy(row, ctx.userId)) return true;
  return householdsOf(row).some(id => isMemberOf(ctx, id));
}

/**
 * May this user CHANGE this row?
 *
 * Your own rows, always — sharing something never signs away your control of it.
 * Somebody else's, only when it is shared with a household where your role can
 * edit shared money. A viewer therefore sees the joint account and cannot touch
 * it, which is the whole point of the role.
 *
 * ANY of the row's households is enough: if you can edit shared money in one of
 * the households it sits in, you can edit the row — the fact that it is also in
 * a household where you're a viewer (or not a member) takes nothing away.
 */
export function canEdit(row: Shareable, ctx: HouseholdContext): boolean {
  if (isOwnedBy(row, ctx.userId)) return true;
  return householdsOf(row).some(id => roleCan(roleIn(ctx, id), 'edit_shared'));
}

/** Why an edit is refused, in words a screen can show. Null when it's allowed. */
export function editRefusal(row: Shareable, ctx: HouseholdContext): string | null {
  if (canEdit(row, ctx)) return null;
  const households = householdsOf(row);
  if (!households.length) return "This belongs to someone else's personal finances.";
  if (!households.some(id => isMemberOf(ctx, id))) {
    return "You're not a member of the household this belongs to.";
  }
  return 'Viewers can see shared money but not change it.';
}

/**
 * May this user SHARE this row into that household?
 *
 * Only its owner, and only into a household they can act in. Sharing somebody
 * else's account would be publishing data that was never yours to publish, so
 * ownership is checked before the role is.
 */
export function canShare(row: Shareable, ctx: HouseholdContext, householdId: string): boolean {
  if (!isOwnedBy(row, ctx.userId)) return false;
  return roleCan(roleIn(ctx, householdId), 'share_own');
}

export function shareRefusal(row: Shareable, ctx: HouseholdContext, householdId: string): string | null {
  if (canShare(row, ctx, householdId)) return null;
  if (!isOwnedBy(row, ctx.userId)) return 'Only the person this belongs to can share it.';
  if (!isMemberOf(ctx, householdId)) return "You're not a member of that household.";
  return 'Viewers can see shared money but not add to it.';
}

/**
 * May this user take the row back out of the household?
 *
 * Its owner, and only its owner. An admin removing somebody else's account from
 * the shared view would be reaching into that person's data to make a decision
 * that was theirs; the household-level lever for "I don't want this person's
 * money here" is removing the person, which un-shares their rows for them.
 */
export function canUnshare(row: Shareable, ctx: HouseholdContext): boolean {
  return isShared(row) && isOwnedBy(row, ctx.userId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  The two views
// ═════════════════════════════════════════════════════════════════════════════

/** Everything the user may legitimately see: their own rows plus shared ones. */
export function visibleRows<T extends Shareable>(rows: T[], ctx: HouseholdContext): T[] {
  return rows.filter(r => canView(r, ctx));
}

/**
 * PERSONAL view — the rows the user owns, shared or not.
 *
 * Note what this is NOT: it is not "rows that aren't shared". A joint account is
 * still your money and still belongs in your own totals; sharing it told your
 * partner about it, it didn't give it away. And because this is ownership and
 * nothing else, one member's personal view can never contain another member's
 * row — which is the property the isolation tests lean on.
 */
export function personalRows<T extends Shareable>(rows: T[], ctx: HouseholdContext): T[] {
  return rows.filter(r => isOwnedBy(r, ctx.userId));
}

/**
 * HOUSEHOLD view — the rows shared with the household, from every member.
 *
 * Each row appears once because each row IS one row: this is a filter over the
 * union of everything loaded, not a merge of per-member lists, so there is no
 * step at which the same account could be added twice.
 *
 * Nobody's personal rows are here — not even the caller's. The household view is
 * the shared picture, and a private savings account stays private inside it.
 */
export function householdRows<T extends Shareable>(
  rows: T[], ctx: HouseholdContext, householdId?: string | null,
): T[] {
  const id = householdId ?? activeHouseholdId(ctx);
  if (!id || !isMemberOf(ctx, id)) return [];
  // `includes`, not `===`: a row can be in several households at once. It still
  // appears exactly once HERE, because this is a filter over one list of rows —
  // being in two households doesn't put a row in this household twice.
  return dedupeById(rows.filter(r => householdsOf(r).includes(id)));
}

export function scopeRows<T extends Shareable>(
  rows: T[], ctx: HouseholdContext, scope: FinanceScope, householdId?: string | null,
): T[] {
  return scope === 'household'
    ? householdRows(rows, ctx, householdId)
    : personalRows(rows, ctx);
}

/**
 * Belt and braces against the one way a total could ever double-count: the same
 * row reaching the list twice (a merge that ran twice, a create reconciled to a
 * server id while the local copy lingers). The engine's guarantee is "counted
 * once", and it should hold against the data it is actually given rather than
 * against the data it hopes for.
 */
export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * The household's shared rows split by who owns them — the proof that the
 * household total is the members' totals added up.
 *
 * Every shared row lands in exactly one bucket, because every row has exactly
 * one owner. Sum the buckets and you have the household; take one bucket and you
 * have that member's contribution. Nothing is in two buckets, and nothing is in
 * none, which is precisely the invariant a shared-finances feature has to hold.
 */
export function partitionByOwner<T extends Shareable>(
  rows: T[], ctx: HouseholdContext, householdId?: string | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of householdRows(rows, ctx, householdId)) {
    const owner = row.user_id ?? ctx.userId ?? 'unknown';
    const bucket = out.get(owner);
    if (bucket) bucket.push(row); else out.set(owner, [row]);
  }
  return out;
}

/** One member's share of the shared rows — the rows they brought to the household. */
export function memberRows<T extends Shareable>(
  rows: T[], ctx: HouseholdContext, userId: string, householdId?: string | null,
): T[] {
  return householdRows(rows, ctx, householdId).filter(r => (r.user_id ?? ctx.userId) === userId);
}

/**
 * WHOSE SPENDING a transaction is: the explicit attribution when there is one,
 * otherwise whoever owns the record. Reporting only — see the file header for
 * why this cannot move a balance.
 */
export function responsibleFor(
  row: Shareable & { responsible_user_id?: string | null }, fallbackUserId?: string | null,
): string | null {
  return row.responsible_user_id ?? row.user_id ?? fallbackUserId ?? null;
}

/** Shared spending grouped by who is responsible for it. */
export function byResponsibility<T extends Shareable & { responsible_user_id?: string | null }>(
  rows: T[], ctx: HouseholdContext, householdId?: string | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of householdRows(rows, ctx, householdId)) {
    const who = responsibleFor(row, ctx.userId) ?? 'unknown';
    const bucket = out.get(who);
    if (bucket) bucket.push(row); else out.set(who, [row]);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Sharing a row
// ═════════════════════════════════════════════════════════════════════════════

export interface SharePlan {
  ok: boolean;
  error?: string;
  /** The patch to apply to the row: the COMPLETE list of households it should be
   *  in afterwards. Only ever this one field — sharing must not be able to change
   *  a balance, a date or an owner as a side effect. The server diffs it against
   *  what it has, so the patch says where the row should end up rather than
   *  describing a step, and re-sending it is harmless. */
  patch?: { household_ids: string[] };
}

/** Add one household to the row's list, leaving every other one it's in alone. */
export function planShare(row: Shareable, ctx: HouseholdContext, householdId: string): SharePlan {
  const refusal = shareRefusal(row, ctx, householdId);
  if (refusal) return { ok: false, error: refusal };
  const current = householdsOf(row);
  if (current.includes(householdId)) {
    return { ok: false, error: "That's already shared with this household." };
  }
  return { ok: true, patch: { household_ids: [...current, householdId] } };
}

/**
 * Take the row out of ONE household, or out of all of them.
 *
 * With `householdId` it leaves every other household the row is in untouched —
 * that is the whole point of being able to share to several. Without one it makes
 * the row personal again, which is what "Personal" in the Sharing panel means.
 */
export function planUnshare(
  row: Shareable, ctx: HouseholdContext, householdId?: string | null,
): SharePlan {
  const current = householdsOf(row);
  if (!current.length) return { ok: false, error: "That's already personal." };
  if (!isOwnedBy(row, ctx.userId)) {
    return { ok: false, error: 'Only the person this belongs to can make it personal again.' };
  }
  if (householdId && !current.includes(householdId)) {
    return { ok: false, error: "That isn't shared with this household." };
  }
  return {
    ok: true,
    patch: { household_ids: householdId ? current.filter(id => id !== householdId) : [] },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Invitations
// ═════════════════════════════════════════════════════════════════════════════

export const INVITE_TTL_DAYS = 14;

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** A stored `pending` that is past its expiry is really expired, whatever the
 *  column says — nothing sweeps the table, so the reading is what decides. */
export function invitationStatus(inv: HouseholdInvitation, nowIso: string): InvitationStatus {
  if (inv.status !== 'pending') return inv.status;
  return new Date(inv.expires_at).getTime() <= new Date(nowIso).getTime() ? 'expired' : 'pending';
}

export function isLiveInvitation(inv: HouseholdInvitation, nowIso: string): boolean {
  return invitationStatus(inv, nowIso) === 'pending';
}

export function liveInvitations(
  invitations: HouseholdInvitation[], householdId: string, nowIso: string,
): HouseholdInvitation[] {
  return invitations.filter(i => i.household_id === householdId && isLiveInvitation(i, nowIso));
}

/** Invitations waiting for THIS user, matched on their email address. */
export function invitationsFor(
  invitations: HouseholdInvitation[], email: string | null | undefined, nowIso: string,
): HouseholdInvitation[] {
  if (!email) return [];
  const want = normaliseEmail(email);
  return invitations.filter(i => normaliseEmail(i.email) === want && isLiveInvitation(i, nowIso));
}

export interface InvitePlan {
  ok: boolean;
  error?: string;
  invitation?: Omit<HouseholdInvitation, 'id' | 'created_at' | 'updated_at'>;
}

/**
 * Everything that has to be true before an invitation exists. Checked here so
 * the same answer comes back whether the request arrives from the UI, the API or
 * a replayed offline write.
 */
export function planInvitation(
  ctx: HouseholdContext,
  householdId: string,
  input: { email: string; role: Exclude<HouseholdRole, 'owner'> },
  existing: { members: HouseholdMember[]; invitations: HouseholdInvitation[]; emailOf?: (userId: string) => string | null },
  nowIso: string,
): InvitePlan {
  if (!can(ctx, 'invite_member', householdId)) {
    return { ok: false, error: 'Only an owner or admin can invite someone.' };
  }
  const email = normaliseEmail(input.email);
  if (!email || !email.includes('@')) return { ok: false, error: 'Enter a valid email address.' };
  // Inviting yourself is a no-op you would notice only after accepting.
  if (ctx.userId && existing.emailOf?.(ctx.userId) && normaliseEmail(existing.emailOf(ctx.userId)!) === email) {
    return { ok: false, error: "You're already in this household." };
  }
  const alreadyIn = activeMembers(existing.members, householdId)
    .some(m => existing.emailOf && normaliseEmail(existing.emailOf(m.user_id) ?? '') === email);
  if (alreadyIn) return { ok: false, error: 'They\'re already in this household.' };

  const pending = liveInvitations(existing.invitations, householdId, nowIso)
    .some(i => normaliseEmail(i.email) === email);
  if (pending) return { ok: false, error: "They've already been invited — the invitation is still open." };

  const expires = new Date(new Date(nowIso).getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString();
  return {
    ok: true,
    invitation: {
      household_id: householdId,
      email,
      role: input.role,
      code: '',            // minted by whoever persists it; never guessed here
      invited_by: ctx.userId,
      status: 'pending',
      expires_at: expires,
      accepted_by: null,
      accepted_at: null,
    },
  };
}

export interface AcceptPlan {
  ok: boolean;
  error?: string;
  /** The membership to mint. Accepting an invitation does exactly one thing:
   *  it makes a member. The invitation itself grants nothing. */
  member?: Omit<HouseholdMember, 'id' | 'created_at' | 'updated_at'>;
  invitationPatch?: { status: InvitationStatus; accepted_by: string; accepted_at: string };
}

/**
 * Accepting.
 *
 * The email has to match the account doing the accepting: an invitation code
 * that worked for whoever held it would make the address on it decorative, and
 * a leaked code would be an open door into a couple's finances.
 */
export function planAcceptance(
  inv: HouseholdInvitation,
  user: { id: string; email: string },
  members: HouseholdMember[],
  nowIso: string,
): AcceptPlan {
  const status = invitationStatus(inv, nowIso);
  if (status === 'expired') return { ok: false, error: 'That invitation has expired. Ask them to send another.' };
  if (status !== 'pending') return { ok: false, error: 'That invitation is no longer open.' };
  if (normaliseEmail(inv.email) !== normaliseEmail(user.email)) {
    return { ok: false, error: 'That invitation was sent to a different email address.' };
  }
  const already = members.find(m => m.household_id === inv.household_id && m.user_id === user.id);
  if (already?.status === 'active') return { ok: false, error: "You're already in this household." };

  return {
    ok: true,
    // A previously-removed person re-joins by reactivating their one membership
    // row (the unique index makes a second row impossible), at the role they
    // were invited back at — never at the role they used to hold.
    member: {
      household_id: inv.household_id,
      user_id: user.id,
      role: inv.role,
      status: 'active',
      joined_at: nowIso,
      removed_at: null,
    },
    invitationPatch: { status: 'accepted', accepted_by: user.id, accepted_at: nowIso },
  };
}

export function planDecline(inv: HouseholdInvitation, user: { email: string }, nowIso: string):
  { ok: boolean; error?: string; patch?: { status: InvitationStatus } } {
  const status = invitationStatus(inv, nowIso);
  if (status !== 'pending') return { ok: false, error: 'That invitation is no longer open.' };
  if (normaliseEmail(inv.email) !== normaliseEmail(user.email)) {
    return { ok: false, error: 'That invitation was sent to a different email address.' };
  }
  return { ok: true, patch: { status: 'declined' } };
}

export function planRevoke(inv: HouseholdInvitation, ctx: HouseholdContext, nowIso: string):
  { ok: boolean; error?: string; patch?: { status: InvitationStatus } } {
  if (!can(ctx, 'invite_member', inv.household_id)) {
    return { ok: false, error: 'Only an owner or admin can withdraw an invitation.' };
  }
  if (invitationStatus(inv, nowIso) !== 'pending') return { ok: false, error: 'That invitation is no longer open.' };
  return { ok: true, patch: { status: 'revoked' } };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Members: roles, removal, leaving, ownership
// ═════════════════════════════════════════════════════════════════════════════

export interface RolePlan {
  ok: boolean;
  error?: string;
  patch?: { role: HouseholdRole };
}

export function planRoleChange(
  ctx: HouseholdContext, member: HouseholdMember, role: HouseholdRole,
): RolePlan {
  if (!can(ctx, 'change_role', member.household_id)) {
    return { ok: false, error: 'Only the household owner can change roles.' };
  }
  if (member.status !== 'active') return { ok: false, error: "They're not in this household." };
  if (role === 'owner') {
    return { ok: false, error: 'Use "Make owner" to hand the household over — there is only ever one owner.' };
  }
  if (member.role === 'owner') {
    return { ok: false, error: 'Hand the household to someone else before changing your own role.' };
  }
  if (member.role === role) return { ok: false, error: `They're already a ${ROLE_LABEL[role].toLowerCase()}.` };
  return { ok: true, patch: { role } };
}

/**
 * What removing a member actually does.
 *
 * Three lists, and the point of the shape is that the first one is empty:
 *   `deletes`       — nothing. Ever. Removal takes access, not money.
 *   `unshare`       — the rows THEY own that were shared. They revert to
 *                     personal, still theirs, and leave the household view.
 *   `losesAccessTo` — rows other members own. They simply stop seeing them; the
 *                     rows are untouched and still shared with everyone else.
 *
 * The un-sharing is the part worth being deliberate about. A removed member's
 * accounts could be left stamped with the household — nobody would gain access,
 * since access is a membership question — but the household view would go on
 * counting the net worth of somebody who is no longer in it, which is exactly
 * the kind of quiet wrongness this phase exists to prevent.
 */
export interface RemovalPlan {
  ok: boolean;
  error?: string;
  memberId?: string;
  userId?: string;
  /** Ids of the removed member's own rows that revert to personal. */
  unshare: string[];
  /** Ids of rows they will stop being able to see. Untouched. */
  losesAccessTo: string[];
  /** Always empty — stated as a value so a test can assert on it. */
  deletes: string[];
}

const emptyPlan = (error: string): RemovalPlan =>
  ({ ok: false, error, unshare: [], losesAccessTo: [], deletes: [] });

export function planMemberRemoval(
  ctx: HouseholdContext,
  member: HouseholdMember,
  sharedRows: Shareable[],
): RemovalPlan {
  const householdId = member.household_id;
  if (!can(ctx, 'remove_member', householdId)) {
    return emptyPlan('Only an owner or admin can remove someone.');
  }
  if (member.status !== 'active') return emptyPlan("They're not in this household.");
  if (member.user_id === ctx.userId) {
    return emptyPlan('To remove yourself, leave the household.');
  }
  if (member.role === 'owner') {
    return emptyPlan('The household owner can\'t be removed. They have to hand it over first.');
  }
  // An admin removing another admin would let two equals eject each other; the
  // owner is the tie-breaker, and this is where that is decided.
  const actorRole = roleIn(ctx, householdId);
  if (actorRole === 'admin' && member.role === 'admin') {
    return emptyPlan('Only the owner can remove another admin.');
  }

  const inHousehold = sharedRows.filter(r => householdsOf(r).includes(householdId));
  return {
    ok: true,
    memberId: member.id,
    userId: member.user_id,
    unshare: inHousehold.filter(r => r.user_id === member.user_id).map(r => r.id),
    losesAccessTo: inHousehold.filter(r => r.user_id !== member.user_id).map(r => r.id),
    deletes: [],
  };
}

/**
 * Leaving under your own steam. Same consequences as being removed — your rows
 * come home with you — with one extra rule: the owner has to hand the household
 * over first, because a household with no owner has nobody who can ever invite,
 * remove or delete again.
 */
export function planLeave(ctx: HouseholdContext, householdId: string, sharedRows: Shareable[]): RemovalPlan {
  const me = membershipOf(ctx, householdId);
  if (!me) return emptyPlan("You're not in this household.");
  if (me.role === 'owner') {
    const others = activeMembers(ctx.members, householdId).filter(m => m.user_id !== ctx.userId);
    if (others.length > 0) {
      return emptyPlan('Hand the household to someone else before you leave it.');
    }
    // Last person out: leaving is the same as closing it, and the rows they own
    // revert to personal exactly as they would for anybody else.
  }
  const inHousehold = sharedRows.filter(r => householdsOf(r).includes(householdId));
  return {
    ok: true,
    memberId: me.id,
    userId: me.user_id,
    unshare: inHousehold.filter(r => isOwnedBy(r, ctx.userId)).map(r => r.id),
    losesAccessTo: inHousehold.filter(r => !isOwnedBy(r, ctx.userId)).map(r => r.id),
    deletes: [],
  };
}

export interface TransferPlan {
  ok: boolean;
  error?: string;
  /** Demote then promote, in this order: the database allows exactly one active
   *  owner, so the pair is not optional and not reorderable. */
  demote?: { memberId: string; role: HouseholdRole };
  promote?: { memberId: string; role: HouseholdRole };
}

export function planOwnershipTransfer(ctx: HouseholdContext, to: HouseholdMember): TransferPlan {
  const householdId = to.household_id;
  if (!can(ctx, 'transfer_ownership', householdId)) {
    return { ok: false, error: 'Only the household owner can hand it over.' };
  }
  if (to.status !== 'active') return { ok: false, error: "They're not in this household." };
  if (to.user_id === ctx.userId) return { ok: false, error: "You're already the owner." };
  const me = membershipOf(ctx, householdId);
  if (!me) return { ok: false, error: "You're not in this household." };
  return {
    ok: true,
    demote: { memberId: me.id, role: 'admin' },
    promote: { memberId: to.id, role: 'owner' },
  };
}

/**
 * Deleting the household.
 *
 * Every shared row reverts to personal, owned by whoever owned it all along.
 * Nothing is deleted but the household itself, its memberships and its
 * invitations — the money was never the household's to delete.
 */
export function planHouseholdDeletion(
  ctx: HouseholdContext, householdId: string, sharedRows: Shareable[],
): { ok: boolean; error?: string; unshare: string[]; deletes: string[] } {
  if (!can(ctx, 'delete_household', householdId)) {
    return { ok: false, error: 'Only the household owner can delete it.', unshare: [], deletes: [] };
  }
  return {
    ok: true,
    unshare: sharedRows.filter(r => householdsOf(r).includes(householdId)).map(r => r.id),
    deletes: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Summaries for the screen
// ═════════════════════════════════════════════════════════════════════════════

export interface SharingSummary {
  /** How many of the user's own rows are shared, and how many stay private. */
  sharedByMe: number;
  personalToMe: number;
  /** Rows in the household view that somebody else brought. */
  sharedByOthers: number;
  /** Total rows in the household view — always sharedByMe + sharedByOthers, and
   *  never the sum of any per-member list, because there is only one list. */
  householdTotal: number;
}

export function summariseSharing(
  rows: Shareable[], ctx: HouseholdContext, householdId?: string | null,
): SharingSummary {
  const mine = personalRows(rows, ctx);
  const shared = householdRows(rows, ctx, householdId);
  const sharedByMe = shared.filter(r => isOwnedBy(r, ctx.userId)).length;
  return {
    sharedByMe,
    personalToMe: mine.length - mine.filter(isShared).length,
    sharedByOthers: shared.length - sharedByMe,
    householdTotal: shared.length,
  };
}

export interface MemberView {
  member: HouseholdMember;
  role: HouseholdRole;
  isYou: boolean;
  /** What the signed-in user may do to this member, resolved once for the UI. */
  canRemove: boolean;
  canChangeRole: boolean;
  canMakeOwner: boolean;
}

export function memberViews(ctx: HouseholdContext, householdId: string): MemberView[] {
  return activeMembers(ctx.members, householdId).map(member => ({
    member,
    role: member.role,
    isYou: member.user_id === ctx.userId,
    canRemove: planMemberRemoval(ctx, member, []).ok,
    canChangeRole: planRoleChange(ctx, member, member.role === 'member' ? 'admin' : 'member').ok,
    canMakeOwner: planOwnershipTransfer(ctx, member).ok,
  }));
}
