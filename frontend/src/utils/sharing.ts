/**
 * Phase 7.2 — the direct-sharing engine.
 *
 * Pure functions, no store, no React, no I/O. Households live next door in
 * `household.ts` and are untouched by this file; what is added here is the other
 * way one person can see another's money.
 *
 * ── The law, now in two halves ──────────────────────────────────────────────
 * 7.1 said: SHARING CHANGES WHO CAN SEE A ROW, NEVER HOW MANY ROWS THERE ARE.
 * 7.2 adds:                        AND IT NEVER CHANGES WHOSE ROW IT IS.
 *
 * Ownership decides every total; sharing decides only sight. So there are two
 * grants, and they do deliberately different jobs:
 *
 *   HOUSEHOLD SHARE   a `record_households` row beside it (a row may be in
 *                     several households at once). Puts it into a shared VIEW
 *                     that has totals of its own, where it is counted once
 *                     however many members are looking.
 *
 *   DIRECT GRANT      a `RecordShare` beside the row. Lets ONE named person see
 *                     it. It enters no view and no total — not the recipient's
 *                     net worth, not their budgets, not their forecast. It shows
 *                     up on their screen badged as somebody else's, and that is
 *                     the entirety of what it does.
 *
 * That asymmetry is the whole point, and it is what makes the arithmetic safe by
 * construction rather than by vigilance. When a partner shares their offset
 * account with you, your net worth does not move. You can see it. It is theirs.
 *
 * ── What a direct grant reaches ─────────────────────────────────────────────
 * Sharing an account shares the account AND the transactions on it, because an
 * account without its transactions is a number with no explanation, and "both of
 * us see the same account" plainly means both of us see what happened on it.
 * That cascade is derived at read time from `account_id` — no transaction is
 * stamped, copied or rewritten, so un-sharing the account takes the transactions
 * back with it in the same instant and with the same single write.
 *
 * Households work the other way round: a household shares an account and only
 * the transactions deliberately put into it. A household is a standing group
 * with a shared picture people build on purpose; a direct grant is one person
 * showing one other person one thing.
 */

import type {
  Household, HouseholdMember, RecordShare, ShareCode,
  ShareRecordType, SharePermission, Shareable,
} from '../types';
import {
  type HouseholdContext, buildContext, canEdit as householdCanEdit,
  canView as householdCanView, isOwnedBy, isShared, myHouseholds,
  roleCan, roleIn, dedupeById, householdsOf,
} from './household';

// ═════════════════════════════════════════════════════════════════════════════
//  Vocabulary
// ═════════════════════════════════════════════════════════════════════════════

/** Every kind of row that can be shared, in the order screens list them. */
export const SHARE_RECORD_TYPES: ShareRecordType[] = [
  'account', 'card', 'transaction', 'loan', 'property', 'budget', 'goal',
  'investment', 'income',
];

export const RECORD_LABEL: Record<ShareRecordType, string> = {
  account: 'Bank account',
  card: 'Credit card',
  transaction: 'Transaction',
  loan: 'Loan',
  property: 'Property',
  budget: 'Budget',
  goal: 'Goal',
  investment: 'Investment',
  income: 'Income entry',
};

export const RECORD_LABEL_PLURAL: Record<ShareRecordType, string> = {
  account: 'Bank accounts',
  card: 'Credit cards',
  transaction: 'Transactions',
  loan: 'Loans',
  property: 'Properties',
  budget: 'Budgets',
  goal: 'Goals',
  investment: 'Investments',
  income: 'Income',
};

export const PERMISSION_LABEL: Record<SharePermission, string> = {
  view: 'Can view',
  edit: 'Can edit',
};

export const PERMISSION_DESCRIPTION: Record<SharePermission, string> = {
  view: 'They see it and change nothing.',
  edit: 'They see it and can correct it. They can never delete it — only you can.',
};

/** A code is a bearer token for sight of a bank account, so it expires. */
export const SHARE_CODE_TTL_DAYS = 14;

// ═════════════════════════════════════════════════════════════════════════════
//  Context
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Everything the rules need: who is asking, what households they are in, and
 * every live direct grant they are either side of.
 *
 * A superset of `HouseholdContext`, so every 7.1 function still takes it
 * unchanged — the household rules are not re-stated here, they are re-used.
 */
export interface SharingContext extends HouseholdContext {
  /** Grants this user is either side of: rows they have shared out, and rows
   *  shared with them. Ended grants may be present; nothing here trusts the
   *  list to be pre-filtered. */
  shares: RecordShare[];
  /** Codes this user has minted. Only ever used to render the Sharing screen —
   *  a code grants nothing, so no visibility rule reads this. */
  codes?: ShareCode[];
}

export function buildSharingContext(
  userId: string | null,
  households: Household[],
  members: HouseholdMember[],
  shares: RecordShare[],
  activeHouseholdId?: string | null,
  codes?: ShareCode[],
): SharingContext {
  return {
    ...buildContext(userId, households, members, activeHouseholdId),
    shares: shares ?? [],
    codes: codes ?? [],
  };
}

/** Widen a plain household context when there are no grants to consider. */
export function withoutShares(ctx: HouseholdContext): SharingContext {
  return { ...ctx, shares: [], codes: [] };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Reading the grants
// ═════════════════════════════════════════════════════════════════════════════

const isLive = (s: RecordShare): boolean => s.status === 'active';

/** Every live grant, either direction. */
export function activeGrants(ctx: SharingContext): RecordShare[] {
  return ctx.shares.filter(isLive);
}

/** Rows OTHER PEOPLE have shared with this user. */
export function grantsIHold(ctx: SharingContext): RecordShare[] {
  if (!ctx.userId) return [];
  return activeGrants(ctx).filter(s => s.shared_with_user_id === ctx.userId);
}

/** Rows this user has shared with other people. */
export function grantsIGave(ctx: SharingContext): RecordShare[] {
  if (!ctx.userId) return [];
  return activeGrants(ctx).filter(s => s.owner_user_id === ctx.userId);
}

/** The live grant letting THIS user see THIS row, or null. */
export function grantFor(
  ctx: SharingContext, type: ShareRecordType, recordId: string,
): RecordShare | null {
  return grantsIHold(ctx)
    .find(s => s.record_type === type && s.record_id === recordId) ?? null;
}

/** Everyone this row is shared with directly, for the row's own menu. */
export function sharedWith(
  ctx: SharingContext, type: ShareRecordType, recordId: string,
): RecordShare[] {
  return grantsIGave(ctx).filter(s => s.record_type === type && s.record_id === recordId);
}

/** True when this user has shared this row with at least one person directly. */
export function isDirectlyShared(
  ctx: SharingContext, type: ShareRecordType, recordId: string,
): boolean {
  return sharedWith(ctx, type, recordId).length > 0;
}

/**
 * The accounts and cards somebody else has shared with this user.
 *
 * Used for one thing: deciding which transactions come with them. Kept as a set
 * so the transaction filter stays a lookup rather than a scan per row.
 */
export function sharedAccountIds(ctx: SharingContext): Set<string> {
  return new Set(
    grantsIHold(ctx)
      .filter(s => s.record_type === 'account' || s.record_type === 'card')
      .map(s => s.record_id),
  );
}

/** Anything with an account behind it — what the transaction cascade reads. */
interface HasAccount extends Shareable {
  account_id?: string | null;
}

/** True when a transaction is visible only because its ACCOUNT was shared. */
export function onSharedAccount(row: HasAccount, ctx: SharingContext): boolean {
  return !!row.account_id && sharedAccountIds(ctx).has(row.account_id);
}

// ═════════════════════════════════════════════════════════════════════════════
//  May this user see it, and may they change it
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The complete visibility rule. Four ways, and there is no fifth:
 *
 *   1. you own it;
 *   2. it is shared with a household you are an active member of;
 *   3. somebody granted it to you directly;
 *   4. it is a transaction on an account somebody granted you directly.
 *
 * Every list on every screen is filtered through this one predicate, which is
 * why a revoked grant takes effect the moment it is revoked, with no sweep and
 * no cache to purge.
 */
export function canViewRecord(
  type: ShareRecordType, row: Shareable, ctx: SharingContext,
): boolean {
  if (householdCanView(row, ctx)) return true;
  if (grantFor(ctx, type, row.id)) return true;
  return type === 'transaction' && onSharedAccount(row as HasAccount, ctx);
}

/**
 * May this user CHANGE it?
 *
 * Their own row always; a household row when their role there can edit shared
 * money; a directly granted row only when the grant says `edit`. A transaction
 * inherits the permission of the account it arrived with, because it arrived as
 * part of that account and not as a decision of its own.
 */
export function canEditRecord(
  type: ShareRecordType, row: Shareable, ctx: SharingContext,
): boolean {
  if (householdCanEdit(row, ctx)) return true;
  const grant = grantFor(ctx, type, row.id);
  if (grant) return grant.permission === 'edit';
  if (type === 'transaction') {
    const accountId = (row as HasAccount).account_id;
    if (!accountId) return false;
    const via = grantsIHold(ctx).find(s =>
      (s.record_type === 'account' || s.record_type === 'card') && s.record_id === accountId);
    return via?.permission === 'edit';
  }
  return false;
}

/** Why a change is refused, in words a screen can show. Null when allowed. */
export function editRecordRefusal(
  type: ShareRecordType, row: Shareable, ctx: SharingContext,
): string | null {
  if (canEditRecord(type, row, ctx)) return null;
  if (grantFor(ctx, type, row.id) || onSharedAccount(row as HasAccount, ctx)) {
    return 'This was shared with you to look at, not to change.';
  }
  if (!isShared(row)) return "This belongs to someone else's personal finances.";
  return 'Viewers can see shared money but not change it.';
}

/**
 * DELETING is owner-only, everywhere, for both kinds of sharing.
 *
 * Deleting a shared row does not remove it from the shared view; it removes it
 * from its OWNER's finances too, which is never a viewer's decision to make. The
 * lever for "I don't want this in front of me" is leaving the grant — reversible
 * and touching nothing.
 */
export function canDeleteRecord(row: Shareable, ctx: SharingContext): boolean {
  return isOwnedBy(row, ctx.userId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  The three lists a screen wants
// ═════════════════════════════════════════════════════════════════════════════

/** Everything this user may legitimately look at, of one kind. */
export function visibleRecords<T extends Shareable>(
  type: ShareRecordType, rows: T[], ctx: SharingContext,
): T[] {
  return dedupeById(rows.filter(r => canViewRecord(type, r, ctx)));
}

/**
 * Rows shared with this user DIRECTLY — the "Shared with you" list.
 *
 * Defined by exclusion from ownership, which is what keeps it out of every
 * total: these rows are not the user's, so `personalRows` (which every figure in
 * the app is computed from) has already dropped them. This function exists to
 * put them back on the SCREEN, clearly badged, and nowhere near a sum.
 */
export function sharedWithMeRecords<T extends Shareable>(
  type: ShareRecordType, rows: T[], ctx: SharingContext,
): T[] {
  if (!ctx.userId) return [];
  return dedupeById(rows.filter(r =>
    !isOwnedBy(r, ctx.userId) &&
    (!!grantFor(ctx, type, r.id) ||
     (type === 'transaction' && onSharedAccount(r as HasAccount, ctx)))));
}

/** True when anything at all has been shared with this user directly. */
export function hasIncomingShares(ctx: SharingContext): boolean {
  return grantsIHold(ctx).length > 0;
}

/** True when this user has any sharing configured at all — a household, a grant
 *  they gave, or a grant they hold. What decides whether sharing UI appears. */
export function hasAnySharing(ctx: SharingContext): boolean {
  return myHouseholds(ctx).length > 0 || activeGrants(ctx).length > 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  How a row is assigned: personal, household, or directly shared
// ═════════════════════════════════════════════════════════════════════════════

export interface Assignment {
  /** Personal until it's in at least one household. Direct grants do NOT make a
   *  row "shared" in this sense — they are an additional, orthogonal fact,
   *  reported separately below, because a row can be personal AND shown to one
   *  named person without belonging to any group. */
  scope: 'personal' | 'household';
  /** EVERY household this row is in — it can be in several at once, appearing
   *  and counting once in each. Empty means personal. */
  households: { id: string; name: string }[];
  /** Just their ids, for a membership test without a map. */
  householdIds: string[];
  /** How many people can see it directly. */
  directCount: number;
  /** The grants themselves, for a list of names. */
  direct: RecordShare[];
  /** Whether the signed-in user may change any of this. */
  mine: boolean;
}

export function assignmentOf(
  type: ShareRecordType, row: Shareable, ctx: SharingContext,
): Assignment {
  const direct = sharedWith(ctx, type, row.id);
  const householdIds = householdsOf(row);
  // A household whose record hasn't loaded yet still counts — the row IS in it,
  // and dropping it here would quietly offer to share it there a second time.
  const households = householdIds.map(id => ({
    id,
    name: ctx.households.find(h => h.id === id)?.name ?? 'A household',
  }));
  return {
    scope: isShared(row) ? 'household' : 'personal',
    households,
    householdIds,
    directCount: direct.length,
    direct,
    mine: isOwnedBy(row, ctx.userId),
  };
}

/** The households this row could be ADDED to — the ones the user may share into,
 *  minus every one it is already in. */
export function shareTargets(ctx: SharingContext, row: Shareable): Household[] {
  const already = householdsOf(row);
  return myHouseholds(ctx)
    .filter(h => roleCan(roleIn(ctx, h.id), 'share_own'))
    .filter(h => !already.includes(h.id));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Making, redeeming and ending a direct grant
// ═════════════════════════════════════════════════════════════════════════════

export interface CodePlan {
  ok: boolean;
  error?: string;
  code?: Omit<ShareCode, 'id' | 'code' | 'created_at' | 'updated_at'>;
}

/**
 * Minting a code.
 *
 * Only the OWNER of a row may hand out sight of it. A household member who can
 * edit the joint account still cannot mint a link to it — editing somebody's
 * account and publishing it to a stranger are not the same permission, and a
 * grant made by a non-owner would be access the owner never agreed to and cannot
 * see in their own list.
 */
export function planShareCode(
  type: ShareRecordType,
  row: Shareable,
  ctx: SharingContext,
  nowIso: string,
  permission: SharePermission = 'view',
): CodePlan {
  if (!ctx.userId) return { ok: false, error: 'Sign in to share something.' };
  if (!isOwnedBy(row, ctx.userId)) {
    return { ok: false, error: 'Only the person this belongs to can share it.' };
  }
  const expires = new Date(new Date(nowIso).getTime() + SHARE_CODE_TTL_DAYS * 86_400_000).toISOString();
  return {
    ok: true,
    code: {
      record_type: type,
      record_id: row.id,
      owner_user_id: ctx.userId,
      permission,
      max_uses: 1,
      uses: 0,
      status: 'active',
      expires_at: expires,
    },
  };
}

/** A stored `active` past its expiry is really expired, whatever the column
 *  says — nothing sweeps the table, so the reading is what decides. */
export function codeStatus(code: ShareCode, nowIso: string): ShareCode['status'] | 'expired' {
  if (code.status !== 'active') return code.status;
  if (new Date(code.expires_at).getTime() <= new Date(nowIso).getTime()) return 'expired';
  if (code.max_uses != null && code.uses >= code.max_uses) return 'used';
  return 'active';
}

export function isLiveCode(code: ShareCode, nowIso: string): boolean {
  return codeStatus(code, nowIso) === 'active';
}

export function liveCodes(ctx: SharingContext, nowIso: string): ShareCode[] {
  return (ctx.codes ?? []).filter(c => isLiveCode(c, nowIso));
}

/** Live codes minted for one specific row. */
export function liveCodesFor(
  ctx: SharingContext, type: ShareRecordType, recordId: string, nowIso: string,
): ShareCode[] {
  return liveCodes(ctx, nowIso).filter(c => c.record_type === type && c.record_id === recordId);
}

export interface RedeemPlan {
  ok: boolean;
  error?: string;
  /** The grant to mint. Redeeming does exactly one thing: it makes a grant. The
   *  code itself grants nothing. */
  grant?: Omit<RecordShare, 'id' | 'created_at' | 'updated_at'>;
}

/**
 * Redeeming a code.
 *
 * Two refusals worth stating out loud:
 *
 *   Your own code does nothing. You already own the row; a grant would put your
 *   own account into your own "shared with you" list, which is nonsense a user
 *   would have to un-pick by hand.
 *
 *   A code for something you can already see does nothing EITHER, and returns
 *   `already` rather than an error so the screen can say "you already have this"
 *   instead of failing. Together with the database's one-live-grant-per-person
 *   index, that is the whole of duplicate prevention: no amount of link-passing
 *   can make a row appear on one screen twice.
 */
export function planRedeem(
  code: ShareCode,
  user: { id: string },
  existing: RecordShare[],
  nowIso: string,
): RedeemPlan & { already?: boolean } {
  const status = codeStatus(code, nowIso);
  if (status === 'expired') return { ok: false, error: 'That code has expired. Ask them for a new one.' };
  if (status === 'revoked') return { ok: false, error: 'That code was withdrawn.' };
  if (status === 'used') return { ok: false, error: 'That code has already been used.' };
  if (code.owner_user_id === user.id) {
    return { ok: false, error: "That's your own share code — this already belongs to you." };
  }
  const live = existing.find(s =>
    s.status === 'active' &&
    s.record_type === code.record_type &&
    s.record_id === code.record_id &&
    s.shared_with_user_id === user.id);
  if (live) {
    return { ok: false, already: true, error: 'You already have access to this.' };
  }
  return {
    ok: true,
    grant: {
      record_type: code.record_type,
      record_id: code.record_id,
      owner_user_id: code.owner_user_id,
      shared_with_user_id: user.id,
      permission: code.permission,
      status: 'active',
      via_code: code.code,
      ended_at: null,
    },
  };
}

export interface EndPlan {
  ok: boolean;
  error?: string;
  patch?: { status: 'revoked' | 'left'; ended_at: string };
  /** Stated as a value so a test can assert on it: ending a grant deletes
   *  nothing, for either person. */
  deletes: string[];
}

/**
 * Ending a grant — from either side, and it is the same safe operation.
 *
 * The owner REVOKES; the recipient LEAVES. Both stop the access completely and
 * neither touches the row: the account keeps its balance, its transactions and
 * its owner, and disappears from exactly one screen. Which side ended it is kept
 * because it is the only thing the two cases differ by, and because "they took
 * it back" and "I gave it back" are not the same story.
 */
export function planEndGrant(grant: RecordShare, ctx: SharingContext, nowIso: string): EndPlan {
  if (grant.status !== 'active') {
    return { ok: false, error: 'That access has already ended.', deletes: [] };
  }
  if (grant.owner_user_id === ctx.userId) {
    return { ok: true, patch: { status: 'revoked', ended_at: nowIso }, deletes: [] };
  }
  if (grant.shared_with_user_id === ctx.userId) {
    return { ok: true, patch: { status: 'left', ended_at: nowIso }, deletes: [] };
  }
  return { ok: false, error: "That isn't yours to end.", deletes: [] };
}

/**
 * What un-sharing an ACCOUNT takes with it.
 *
 * The transactions, because they were never granted in their own right — they
 * were visible because the account was, and the moment it isn't they aren't.
 * Nothing in this list is written to: it is what the recipient's screen stops
 * showing, reported so a confirmation can say so honestly.
 */
export function cascadeOfEnding<T extends HasAccount>(
  grant: RecordShare, transactions: T[],
): { transactions: string[]; deletes: string[] } {
  if (grant.record_type !== 'account' && grant.record_type !== 'card') {
    return { transactions: [], deletes: [] };
  }
  return {
    transactions: transactions.filter(t => t.account_id === grant.record_id).map(t => t.id),
    deletes: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Summaries for the Sharing screen
// ═════════════════════════════════════════════════════════════════════════════

export interface SharedRecordView {
  type: ShareRecordType;
  recordId: string;
  label: string;
  /** The people it is shared with, and what each may do. */
  people: { userId: string; name: string; email: string | null; permission: SharePermission; grantId: string }[];
  /** Live codes minted for it that nobody has redeemed yet. */
  pendingCodes: ShareCode[];
}

const nameOf = (s: RecordShare, side: 'owner' | 'recipient'): string => {
  const name = side === 'owner' ? s.owner_name : s.shared_with_name;
  const email = side === 'owner' ? s.owner_email : s.shared_with_email;
  return name || email || 'Someone';
};

/**
 * "What have I shared, and who with?" — one entry per ROW, not per person, so a
 * bank account shared with two people is one line with two names rather than two
 * lines that look like two accounts.
 */
export function sharedByMe(
  ctx: SharingContext,
  labelOf: (type: ShareRecordType, id: string) => string | null,
  nowIso: string,
): SharedRecordView[] {
  const byRecord = new Map<string, SharedRecordView>();

  const entry = (type: ShareRecordType, recordId: string, fallback?: string | null): SharedRecordView => {
    const key = `${type}:${recordId}`;
    let view = byRecord.get(key);
    if (!view) {
      view = {
        type, recordId,
        label: labelOf(type, recordId) ?? fallback ?? RECORD_LABEL[type],
        people: [], pendingCodes: [],
      };
      byRecord.set(key, view);
    }
    return view;
  };

  for (const grant of grantsIGave(ctx)) {
    entry(grant.record_type, grant.record_id, grant.record_label).people.push({
      userId: grant.shared_with_user_id,
      name: nameOf(grant, 'recipient'),
      email: grant.shared_with_email ?? null,
      permission: grant.permission,
      grantId: grant.id,
    });
  }
  // A code with nobody on the other end yet is still something the owner shared
  // and can withdraw, so it belongs on this screen rather than nowhere.
  for (const code of liveCodes(ctx, nowIso)) {
    entry(code.record_type, code.record_id, code.record_label).pendingCodes.push(code);
  }

  return [...byRecord.values()];
}

export interface IncomingShareView {
  grant: RecordShare;
  type: ShareRecordType;
  label: string;
  from: string;
  permission: SharePermission;
}

/** "What has been shared with me, and by whom?" */
export function sharedWithMe(
  ctx: SharingContext,
  labelOf: (type: ShareRecordType, id: string) => string | null,
): IncomingShareView[] {
  return grantsIHold(ctx).map(grant => ({
    grant,
    type: grant.record_type,
    label: labelOf(grant.record_type, grant.record_id) ?? grant.record_label ?? RECORD_LABEL[grant.record_type],
    from: nameOf(grant, 'owner'),
    permission: grant.permission,
  }));
}

/** The one-line headline for the Sharing screen. */
export interface SharingOverview {
  households: number;
  recordsIShare: number;
  peopleISharewith: number;
  recordsSharedWithMe: number;
  pendingCodes: number;
}

export function sharingOverview(ctx: SharingContext, nowIso: string): SharingOverview {
  const given = grantsIGave(ctx);
  return {
    households: myHouseholds(ctx).length,
    recordsIShare: new Set(given.map(g => `${g.record_type}:${g.record_id}`)).size,
    peopleISharewith: new Set(given.map(g => g.shared_with_user_id)).size,
    recordsSharedWithMe: grantsIHold(ctx).length,
    pendingCodes: liveCodes(ctx, nowIso).length,
  };
}
