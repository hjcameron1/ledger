/**
 * Phase 8.2 — insurance policies: the decisions, kept pure so they can be tested
 * without a database.
 *
 * The route (routes/insurance.ts) moves rows; THIS file answers questions: what
 * a policy may say about itself, what it may be linked to, and who may see it.
 *
 * Two rules carry the whole phase:
 *
 *   1. A POLICY FOLLOWS THE THING IT COVERS. Linked to nothing it is personal;
 *      linked to a household every member sees it; linked to a property,
 *      account, card, loan or investment, whoever may see that record may see
 *      the cover on it. That is the shared rule in linkedVisibility.ts, derived
 *      at read time — un-share the house and its insurance goes with it.
 *
 *   2. WRITES ARE OWNER-ONLY. A policy shared into view is still one person's
 *      contract with their insurer; a household member may read it, and may not
 *      rename, re-price or delete somebody else's cover. Visible-but-not-owned
 *      answers 403, invisible answers 404, so an id can never be an oracle.
 *
 * No money is computed here or anywhere else on the server. Annual cost, renewal
 * proximity, expiry and premium movement are all derived by the pure engine in
 * frontend/src/utils/insurance.ts from the columns below.
 */

import { HouseholdScope } from './householdScope';
import {
  RECORD_LINK_TYPES, TABLE_OF_LINK, linkedVisibilityFilter, canSeeLinked,
  linkTargetRefusal as refuseLinkTarget, type LinkRefusal,
} from './linkedVisibility';

export { RECORD_LINK_TYPES, TABLE_OF_LINK };
export type { LinkRefusal };

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const POLICY_TYPES = [
  'home', 'contents', 'landlord', 'car', 'health', 'life',
  'income_protection', 'travel', 'pet', 'business', 'other',
] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/** The cadences a premium is actually billed at. Deliberately the forecast
 *  engine's own vocabulary minus `once` — a policy that is never billed again
 *  is not a premium, it is a receipt. */
export const PREMIUM_FREQUENCIES = [
  'weekly', 'fortnightly', 'monthly', 'quarterly', 'annually',
] as const;
export type PremiumFrequency = (typeof PREMIUM_FREQUENCIES)[number];

/** What a policy may be filed against. The five record kinds are exactly the
 *  shareable entities a household can already see; `household` is the one
 *  non-record home (a family health policy covers no single asset). Note there
 *  is no `tax_year`: a policy is a live contract, not a year's paperwork. */
export const LINKABLE_TYPES = [
  'account', 'card', 'loan', 'property', 'investment', 'household',
] as const;
export type LinkedType = (typeof LINKABLE_TYPES)[number];

// ── Field whitelist ──────────────────────────────────────────────────────────

/** '' → null for the optional columns. An empty string in a DATE or a
 *  CHECK-constrained TEXT column is the ""→22P02 failure the transaction routes
 *  already learned to coerce (see [[ledger-txn-500-uuid]]). */
const emptyToNull = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** A money field: null when absent or blank, refused when it isn't a number. */
function numberOrNull(v: unknown): number | null | undefined {
  const s = emptyToNull(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined; // undefined = "not a number"
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PolicyFields {
  name?: string;
  policy_type?: PolicyType;
  insurer?: string | null;
  policy_number?: string | null;
  premium_amount?: number;
  premium_frequency?: PremiumFrequency;
  start_date?: string | null;
  renewal_date?: string | null;
  excess?: number | null;
  coverage_amount?: number | null;
  linked_type?: LinkedType | null;
  linked_id?: string | null;
  document_id?: string | null;
  notes?: string | null;
  active?: boolean;
}

export type FieldRefusal = { error: string } | null;

/**
 * The one gate every policy write passes through, create and edit alike.
 *
 * Returns the whitelisted, coerced patch — or a refusal naming what was wrong.
 * Unknown keys are DROPPED rather than written: `id`, `user_id` and the
 * timestamps are the server's to set, and a client that sends one is either
 * confused or trying something.
 */
export function pickPolicyFields(
  body: Record<string, unknown>,
): { fields: PolicyFields; refusal: FieldRefusal } {
  const fields: PolicyFields = {};

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { fields, refusal: { error: 'A policy needs a name.' } };
    fields.name = name.slice(0, 200);
  }

  if (body.policy_type !== undefined) {
    const t = String(body.policy_type);
    if (!(POLICY_TYPES as readonly string[]).includes(t)) {
      return { fields, refusal: { error: `Unknown policy type '${t}'.` } };
    }
    fields.policy_type = t as PolicyType;
  }

  if (body.premium_frequency !== undefined) {
    const f = String(body.premium_frequency);
    if (!(PREMIUM_FREQUENCIES as readonly string[]).includes(f)) {
      return { fields, refusal: { error: `Unknown premium frequency '${f}'.` } };
    }
    fields.premium_frequency = f as PremiumFrequency;
  }

  if (body.premium_amount !== undefined) {
    const n = numberOrNull(body.premium_amount);
    if (n === undefined) return { fields, refusal: { error: 'The premium must be a number.' } };
    if (n !== null && n < 0) return { fields, refusal: { error: 'A premium cannot be negative.' } };
    fields.premium_amount = n ?? 0;
  }

  for (const key of ['excess', 'coverage_amount'] as const) {
    if (body[key] === undefined) continue;
    const n = numberOrNull(body[key]);
    if (n === undefined) return { fields, refusal: { error: `${key.replace('_', ' ')} must be a number.` } };
    if (n !== null && n < 0) return { fields, refusal: { error: `${key.replace('_', ' ')} cannot be negative.` } };
    fields[key] = n;
  }

  for (const key of ['start_date', 'renewal_date'] as const) {
    if (body[key] === undefined) continue;
    const d = emptyToNull(body[key]);
    if (d !== null && !ISO_DATE.test(d)) {
      return { fields, refusal: { error: `${key.replace('_', ' ')} must be YYYY-MM-DD.` } };
    }
    fields[key] = d;
  }

  if (body.insurer !== undefined) fields.insurer = emptyToNull(body.insurer);
  if (body.policy_number !== undefined) fields.policy_number = emptyToNull(body.policy_number);
  if (body.notes !== undefined) fields.notes = emptyToNull(body.notes);
  if (body.document_id !== undefined) fields.document_id = emptyToNull(body.document_id);
  if (body.active !== undefined) fields.active = body.active !== false && body.active !== 'false';

  // The link travels as a pair or not at all — the same rule the table enforces,
  // checked here so the refusal is a sentence rather than a constraint violation.
  if (body.linked_type !== undefined || body.linked_id !== undefined) {
    const type = emptyToNull(body.linked_type);
    const id = emptyToNull(body.linked_id);
    if ((type === null) !== (id === null)) {
      return { fields, refusal: { error: 'A link needs both linked_type and linked_id (or neither).' } };
    }
    if (type !== null && !(LINKABLE_TYPES as readonly string[]).includes(type)) {
      return { fields, refusal: { error: `A policy cannot be linked to '${type}'.` } };
    }
    fields.linked_type = type as LinkedType | null;
    fields.linked_id = id;
  }

  return { fields, refusal: null };
}

// ── Premium history ──────────────────────────────────────────────────────────

export interface PremiumHistoryFields {
  policy_id: string;
  premium_amount: number;
  premium_frequency: PremiumFrequency;
  effective_date: string;
  note: string | null;
}

/**
 * A premium-history row is an OBSERVATION: what the policy cost, from when.
 * It is written once and never updated — correcting one means deleting it and
 * recording what actually happened, exactly as loan events work.
 */
export function pickHistoryFields(
  body: Record<string, unknown>,
): { fields: PremiumHistoryFields | null; refusal: FieldRefusal } {
  const policyId = emptyToNull(body.policy_id);
  if (!policyId) return { fields: null, refusal: { error: 'A premium record needs a policy.' } };

  const amount = numberOrNull(body.premium_amount);
  if (amount === undefined || amount === null || amount < 0) {
    return { fields: null, refusal: { error: 'A premium record needs a non-negative amount.' } };
  }

  const frequency = String(body.premium_frequency ?? 'annually');
  if (!(PREMIUM_FREQUENCIES as readonly string[]).includes(frequency)) {
    return { fields: null, refusal: { error: `Unknown premium frequency '${frequency}'.` } };
  }

  const effective = emptyToNull(body.effective_date);
  if (!effective || !ISO_DATE.test(effective)) {
    return { fields: null, refusal: { error: 'effective_date must be YYYY-MM-DD.' } };
  }

  return {
    fields: {
      policy_id: policyId,
      premium_amount: amount,
      premium_frequency: frequency as PremiumFrequency,
      effective_date: effective,
      note: emptyToNull(body.note),
    },
    refusal: null,
  };
}

// ── Visibility ───────────────────────────────────────────────────────────────
//
// The shared rule of linkedVisibility.ts, named in this feature's words. Stated
// through these two wrappers rather than called directly so that the route reads
// as insurance and the law stays in one file.

/** The PostgREST `.or(...)` filter for "policies this user may see". Null when
 *  only ownership applies, so the personal-only path keeps its plain `.eq`. */
export function policyVisibilityFilter(scope: HouseholdScope): string | null {
  return linkedVisibilityFilter(scope);
}

export interface PolicyVisibilityRow {
  user_id: string;
  linked_type?: string | null;
  linked_id?: string | null;
}

/** The single-row form, for the endpoints that have already fetched one. */
export function canSeePolicy(policy: PolicyVisibilityRow, scope: HouseholdScope): boolean {
  return canSeeLinked(policy, scope);
}

/**
 * May this user cover this target with a policy?
 *
 * Only something they can already SEE. Linking is filing, not publishing: a
 * policy's audience follows its target's audience, so covering a record you can
 * see can never show the policy to anyone who could not already see that record.
 */
export function linkTargetRefusal(
  linkedType: LinkedType,
  linkedId: string,
  targetOwnerId: string | null,
  scope: HouseholdScope,
): LinkRefusal {
  return refuseLinkTarget(linkedType, linkedId, targetOwnerId, scope);
}

/**
 * May this user attach this document to a policy?
 *
 * The document must be one they OWN. Deliberately stricter than the link rule
 * above: a policy carries its document to everyone who can see the policy, so
 * attaching somebody else's file — even one legitimately shared with you — would
 * be re-publishing their paperwork to an audience they never chose. `ownerId` is
 * the fetched owner of the document (null = not found).
 */
export function documentRefusal(ownerId: string | null, scope: HouseholdScope): LinkRefusal {
  if (!ownerId) return { status: 404, error: 'That document was not found.' };
  if (ownerId !== scope.userId) {
    return { status: 403, error: 'You can only attach your own documents to a policy.' };
  }
  return null;
}
