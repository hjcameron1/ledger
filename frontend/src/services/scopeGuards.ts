/**
 * The scope and ownership guard layer — pulled out of dataService.ts.
 *
 * Every defect in the pre-market audit that involved a scope or an owner filter
 * came from one accessor in that 13,000-line file quietly diverging from its
 * neighbours. This module is the whole rulebook in one reviewable place: every
 * total narrows through `scoped()`, everything personal-by-nature through
 * `ownRows()`, every list screen through `visible()` / `sharedWithMeOnly()`,
 * and every local write through the two refusal checks. A gatherer that reads
 * the store raw instead of through one of these is wrong by definition.
 */

import { useStore } from '../store';
import type { FinanceScope, Shareable, ShareRecordType } from '../types';
import {
  buildContext, scopeRows, activeHousehold, isShared,
  type HouseholdContext,
} from '../utils/household';
import {
  buildSharingContext, visibleRecords, sharedWithMeRecords,
  editRecordRefusal, canDeleteRecord,
  type SharingContext,
} from '../utils/sharing';

// The store now holds rows the user does not own — the ones their household
// shares with them — so "everything in the store" stopped being an answer to any
// question. `scoped()` is the answer instead, and every DS getAll() goes through
// it:
//
//   personal   the rows you OWN. Identical to what getAll() returned before 7.1
//              for anyone not in a household, because for them every row is
//              theirs. That equivalence is deliberate: a solo user's totals must
//              not move by a cent because this phase shipped.
//   household  the rows SHARED with the household, from every member, each
//              counted once. Nobody's private rows.
//
// Because the switch lives here rather than in each screen, the Personal and
// Household views are the same code reading a different slice — there is no
// second net-worth path that could drift from the first.

/** The signed-in user's household context, rebuilt from the store on demand. */
export function householdContext(): HouseholdContext {
  const s = useStore.getState();
  return buildContext(s.user?.id ?? null, s.households, s.householdMembers, s.activeHouseholdId);
}

/**
 * Phase 7.2 — the same context plus every direct grant the user is either side
 * of. Used wherever the question is "may I LOOK at this", which now has two
 * more answers than it did (see utils/sharing.ts).
 *
 * It is deliberately NOT used by anything that adds money up. Totals are
 * computed from `scoped()` below, which is ownership and household stamps and
 * nothing else — so a direct grant physically cannot reach a net worth, a budget
 * or a forecast, however many rows it puts on screen.
 */
export function sharingContext(): SharingContext {
  const s = useStore.getState();
  return buildSharingContext(
    s.user?.id ?? null, s.households, s.householdMembers,
    s.recordShares, s.activeHouseholdId, s.shareCodes,
  );
}

/** The scope the screens are currently on. Household is only ever honoured when
 *  it RESOLVES to a household the user is actually in: no memberships at all,
 *  or a stale/deep-linked active id naming a household they've since left,
 *  both fall back to personal. Checking mere membership was not enough — a
 *  user still in OTHER households could be stranded on a nameless, empty
 *  household view by one stale id (found by the Aug 2026 defect hunt). */
export function currentScope(): FinanceScope {
  const s = useStore.getState();
  return s.financeScope === 'household' && activeHousehold(householdContext()) !== null
    ? 'household'
    : 'personal';
}

/**
 * Narrow any list of shareable rows to the current scope — the ONE function
 * every total in this file is computed from.
 *
 * Ownership and household stamps only. Rows somebody granted this user directly
 * are not here and must never be: they are somebody else's money, visible but
 * not owned, and the moment they entered this function they would start being
 * counted. `visible()` below is where those rows appear instead.
 */
export function scoped<T extends Shareable>(rows: T[], scope?: FinanceScope): T[] {
  return scopeRows(rows, householdContext(), scope ?? currentScope());
}

/**
 * ONLY the signed-in user's rows, in every scope. The store is a visible
 * SUPERSET — it holds rows other people shared into view — so anything personal
 * by nature (tax, the user's own annual income figure) must narrow through
 * here, never read the store raw. A missing user_id is a local-first own row.
 */
export function ownRows<T extends { user_id?: string }>(rows: T[]): T[] {
  const u = useStore.getState().user?.id ?? null;
  return rows.filter(r => !u || !r.user_id || r.user_id === u);
}

/**
 * Everything the user may LOOK at, of one kind: their own rows, their
 * household's shared ones, and the ones granted to them directly. What a list
 * screen renders — never what a total sums.
 */
export function visible<T extends Shareable>(kind: ShareRecordType, rows: T[]): T[] {
  return visibleRecords(kind, rows, sharingContext());
}

/**
 * Only the rows granted directly, which are by definition not the user's. The
 * "Shared with you" section: shown clearly, badged as somebody else's, and
 * counted nowhere.
 *
 * SCOPE-AWARE. A direct grant is somebody showing you ONE account of theirs — it
 * belongs to no household, so it appears only in "My Finances", the view that
 * means "everything I can see". When the ledger is pointed at a specific
 * household, that view is that household's shared picture and nothing else, so a
 * personal grant must not appear in it. Returning [] here is the whole-app fix:
 * every screen reads its "Shared with you" list through this one door, so the
 * Accounts tab, the Cards tab and the transaction lists all obey it at once.
 */
export function sharedWithMeOnly<T extends Shareable>(kind: ShareRecordType, rows: T[]): T[] {
  if (currentScope() === 'household') return [];
  return sharedWithMeRecords(kind, rows, sharingContext());
}

// ═════════════════════════════════════════════════════════════════════════════
//  Local writes obey the same rules the server does
// ═════════════════════════════════════════════════════════════════════════════
//
// The store is a visible SUPERSET — it holds rows other people shared into view
// — so a mutator that simply writes what it was given can change somebody else's
// money on this device. The server refuses those writes (refuseWrite /
// refuseDelete in backend/src/services/householdScope.ts), which used to mean
// the local copy silently disagreed with the truth until the next full load: the
// row looked edited, or gone, and it never was.
//
// So the same two questions are asked HERE, before anything is written or
// queued. A screen that forgets to disable a control can no longer corrupt the
// local picture, and a refusal is a refusal on every path into the data.
//
// EDIT follows the sharing engine: the owner always, a household member with
// `edit_shared`, or a direct grant marked `edit`. (A member's edit of an owner's
// row still travels — the server turns it into a household change request — so
// this gate is about VIEWERS and strangers, not about members.)
//
// DELETE is owner-only, everywhere, for both kinds of sharing: removing a shared
// row removes it from its owner's finances too, which is never a viewer's or a
// member's call.

/** Why this local edit is refused, in words a screen can show. Null = allowed.
 *
 *  With no signed-in user there is nobody to judge against — before bootstrap,
 *  and in the local-only paths that predate sharing — so nothing is refused.
 *  That is the same rule `ownRows` follows, and it keeps a solo user's writes
 *  behaving exactly as they did before either sharing phase shipped. */
export function refuseLocalEdit(kind: ShareRecordType, row: Shareable | undefined): string | null {
  if (!row) return null;                       // nothing there to protect
  const ctx = sharingContext();
  if (!ctx.userId) return null;
  return editRecordRefusal(kind, row, ctx);
}

/** Why this local delete is refused. Null = allowed. */
export function refuseLocalDelete(row: Shareable | undefined): string | null {
  if (!row) return null;
  const ctx = sharingContext();
  if (!ctx.userId) return null;
  if (canDeleteRecord(row, ctx)) return null;
  return isShared(row)
    ? 'Only the person who owns this can delete it.'
    : "This belongs to someone else's personal finances.";
}