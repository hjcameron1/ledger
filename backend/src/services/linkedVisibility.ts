/**
 * Phase 8 — "this row follows the thing it is linked to", stated ONCE.
 *
 * Two features now hang their visibility on a `linked_type` + `linked_id` pair
 * rather than on sharing machinery of their own: the document vault (8.1) and
 * insurance policies (8.2). The rule they share is the transaction↔account
 * cascade of householdScope.ts, generalised:
 *
 *   A LINKED ROW IS VISIBLE TO WHOEVER CAN SEE WHAT IT IS LINKED TO.
 *
 *   linked to nothing   personal — its owner and nobody else.
 *   linked to household every ACTIVE member of that household.
 *   linked to a record  exactly the people who may see that record, whether by
 *                       household share or by direct grant.
 *   linked to anything  personal. (The document vault's `tax_year` is the one
 *   else                such link, and tax is ownership, never scope.)
 *
 * Derived at READ time from the caller's HouseholdScope — nothing is stamped on
 * the row — so un-sharing the account takes its paperwork and its insurance back
 * in the same instant, with the same single write and nothing to clean up.
 *
 * This module owns the RULE. It owns no table, no columns and no writes: the two
 * features keep their own field whitelists, their own routes and their own
 * tests, and share only the one decision that must never differ between them.
 */

import { supabase } from '../utils/supabase';
import {
  HouseholdScope, ShareRecordType, grantedIds, householdIds, isMemberOf,
  visibleHouseholds,
} from './householdScope';

/** The link targets whose visibility cascades. Exactly the shareable entities a
 *  household can already see — a linked row can therefore never reach an
 *  audience the record it names could not already reach. */
export const RECORD_LINK_TYPES: ShareRecordType[] =
  ['account', 'card', 'loan', 'property', 'investment'];

/** Where each linkable record kind lives, for a route's ownership lookup. */
export const TABLE_OF_LINK: Record<string, string> = {
  account: 'bank_accounts',
  card: 'credit_cards',
  loan: 'loans',
  property: 'properties',
  investment: 'investments',
};

export function isRecordLinkType(type: string | null | undefined): type is ShareRecordType {
  return !!type && (RECORD_LINK_TYPES as string[]).includes(type);
}

/** The ids of one record kind this scope may see beyond its own rows —
 *  household-shared and directly-granted merged, exactly as `visibilityFilter`
 *  in householdScope.ts merges them. */
export function visibleRecordIds(scope: HouseholdScope, type: ShareRecordType): Set<string> {
  return new Set<string>([
    ...(scope.householdRecords.get(type) ?? []),
    ...grantedIds(scope, type),
  ]);
}

/**
 * The PostgREST `.or(...)` filter for "rows this user may see": their own, plus
 * rows linked to a household they are in, plus rows linked to a record they can
 * see. Null when only ownership applies — the caller then uses the plain
 * `.eq('user_id', …)`, so the personal-only path (nearly everybody) gains no
 * `or`, no extra index work and no new way to be wrong.
 */
export function linkedVisibilityFilter(scope: HouseholdScope): string | null {
  const parts = [`user_id.eq.${scope.userId}`];

  const households = householdIds(scope);
  if (households.length) {
    parts.push(`and(linked_type.eq.household,linked_id.in.(${households.join(',')}))`);
  }

  for (const type of RECORD_LINK_TYPES) {
    const ids = visibleRecordIds(scope, type);
    if (ids.size) {
      parts.push(`and(linked_type.eq.${type},linked_id.in.(${[...ids].join(',')}))`);
    }
  }

  return parts.length === 1 ? null : parts.join(',');
}

export interface LinkedRow {
  user_id: string;
  linked_type?: string | null;
  linked_id?: string | null;
}

/**
 * The single-row form of the filter above, for endpoints that have already
 * fetched one row — one row, one answer, provably the same rule.
 */
export function canSeeLinked(row: LinkedRow, scope: HouseholdScope): boolean {
  if (row.user_id === scope.userId) return true;
  if (!row.linked_type || !row.linked_id) return false;
  if (row.linked_type === 'household') return isMemberOf(scope, row.linked_id);
  if (isRecordLinkType(row.linked_type)) {
    return visibleRecordIds(scope, row.linked_type).has(row.linked_id);
  }
  // Any other link kind (the vault's tax_year) is personal: owner only.
  return false;
}

export type LinkRefusal = { status: number; error: string } | null;

/**
 * May this user file a row against this target?
 *
 * A household: only one they are a member of. A record: only one they can SEE —
 * their own, or one shared with them — because linking is FILING, not
 * publishing: the row's audience follows the target's audience, so linking to
 * something you can see can never show your row to anyone who could not already
 * see that something. Any other link kind needs no lookup: it is the caller's
 * own by construction.
 *
 * `targetOwnerId` is the fetched owner of the record (null = not found); the
 * route does the one-row read, this decides.
 */
export function linkTargetRefusal(
  linkedType: string,
  linkedId: string,
  targetOwnerId: string | null,
  scope: HouseholdScope,
): LinkRefusal {
  if (linkedType === 'household') {
    return isMemberOf(scope, linkedId)
      ? null
      : { status: 403, error: "You're not a member of that household." };
  }

  if (!isRecordLinkType(linkedType)) return null;

  // Not-found and not-visible give the same answer — "this is not yours to know
  // about" must not become an oracle for guessing other people's ids.
  if (!targetOwnerId) return { status: 404, error: 'That record was not found.' };
  if (targetOwnerId === scope.userId) return null;
  if (visibleRecordIds(scope, linkedType).has(linkedId)) return null;
  return { status: 404, error: 'That record was not found.' };
}

/**
 * Which households each linked row's TARGET is shared with — the `household_ids`
 * a row carries out to the client.
 *
 * Note whose households these are: the LINKED RECORD's, never the row's own. A
 * policy on a house shared with "Home" belongs in the Home household view for
 * exactly as long as the house does, and the client's existing scope machinery
 * (utils/household.ts) then needs no special case for it at all.
 *
 * One batched read per record kind, and it fails soft: an empty list reads as
 * "personal", which is the same safe fallback every other sharing lookup takes.
 *
 * Narrowed to the READER's own households, exactly as `attachHouseholds` narrows
 * a shareable row's stamps — see `visibleHouseholds`. The target's households are
 * the target's business, and a policy on a house in two of them must not tell a
 * member of one about the other. Lossless for the same reason it is there: the
 * house's owner is a member of every household it sits in.
 */
export async function householdsOfLinks(
  rows: { id: string; linked_type?: string | null; linked_id?: string | null }[],
  scope: HouseholdScope,
): Promise<Map<string, string[]>> {
  const byRow = new Map<string, string[]>();
  if (!rows.length) return byRow;
  const mine = visibleHouseholds(scope);

  // A household link IS its household — no lookup needed.
  for (const row of rows) {
    if (row.linked_type === 'household' && row.linked_id && mine.has(row.linked_id)) {
      byRow.set(row.id, [row.linked_id]);
    }
  }

  // Everything else asks the join which households its target sits in.
  const idsByType = new Map<ShareRecordType, Set<string>>();
  for (const row of rows) {
    if (!isRecordLinkType(row.linked_type) || !row.linked_id) continue;
    const set = idsByType.get(row.linked_type) ?? new Set<string>();
    set.add(row.linked_id);
    idsByType.set(row.linked_type, set);
  }
  if (!idsByType.size) return byRow;

  const lookups = await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const { data, error } = await supabase
        .from('record_households')
        .select('record_id, household_id')
        .eq('record_type', type)
        .in('record_id', [...ids]);
      if (error) {
        console.warn(`[linked] household lookup for ${type} failed:`, error.message);
        return [type, new Map<string, string[]>()] as const;
      }
      const map = new Map<string, string[]>();
      for (const r of data ?? []) {
        const householdId = r.household_id as string;
        if (!mine.has(householdId)) continue;    // not this reader's to know about
        const recordId = r.record_id as string;
        map.set(recordId, [...(map.get(recordId) ?? []), householdId]);
      }
      return [type, map] as const;
    }),
  );

  const byType = new Map(lookups);
  for (const row of rows) {
    if (!isRecordLinkType(row.linked_type) || !row.linked_id) continue;
    const households = byType.get(row.linked_type)?.get(row.linked_id) ?? [];
    if (households.length) byRow.set(row.id, households);
  }
  return byRow;
}
