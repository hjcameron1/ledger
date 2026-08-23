/**
 * Phase 8.1 — the document vault's decisions, kept pure so they can be tested
 * without a database.
 *
 * The route (routes/documents.ts) moves bytes; THIS file answers questions:
 * who may see a document, what may be linked to what, which files are accepted,
 * and where a file lives in storage. The visibility rule deliberately mirrors
 * the transaction↔account cascade in householdScope.ts:
 *
 *   A DOCUMENT FOLLOWS THE RECORD IT IS LINKED TO.
 *
 * Linked to nothing (or to a tax year) it is personal. Linked to a household it
 * is visible to that household's members. Linked to an account, card, loan,
 * property or investment it is visible to exactly the people who may see that
 * record — derived at read time from the same HouseholdScope, so un-sharing the
 * record takes its paperwork back in the same instant, with nothing stamped.
 *
 * Writes never follow anybody: rename, re-file and delete are OWNER-ONLY.
 */

import {
  HouseholdScope, ShareRecordType, grantedIds, householdIds, isMemberOf,
} from './householdScope';

export const DOCUMENT_TYPES = [
  'statement', 'payslip', 'tax', 'loan', 'property',
  'insurance', 'receipt', 'contract', 'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** What a document may be filed against. The five record kinds are exactly the
 *  shareable entities a household can already see; tax_year and household are
 *  the two non-record homes. */
export const LINKABLE_TYPES = [
  'account', 'card', 'loan', 'property', 'investment', 'tax_year', 'household',
] as const;
export type LinkedType = (typeof LINKABLE_TYPES)[number];

/** The linked types whose visibility cascades through household scope. */
export const RECORD_LINK_TYPES: ShareRecordType[] =
  ['account', 'card', 'loan', 'property', 'investment'];

/** Where each linkable record kind lives, for the route's ownership lookup. */
export const TABLE_OF_LINK: Record<string, string> = {
  account: 'bank_accounts',
  card: 'credit_cards',
  loan: 'loans',
  property: 'properties',
  investment: 'investments',
};

// ── Files we accept ──────────────────────────────────────────────────────────
// Financial paperwork: PDFs, images (photographed receipts/policies), office
// documents and plain data files. Executables and archives are not paperwork.
export const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'text/csv', 'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;
export const DOCUMENTS_BUCKET = 'documents';

export function isAcceptedMime(mime: string | undefined | null): boolean {
  return !!mime && ACCEPTED_MIMES.has(mime);
}

/** Mimes the client can render inline (img / iframe). Anything else is
 *  download-only; the server still serves it either way. */
export function isPreviewable(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
}

// ── Naming and storage paths ─────────────────────────────────────────────────

/**
 * A filename fit for a storage key: no path separators (a name like
 * `../../x.pdf` must never steer the key out of the owner's folder), no
 * control characters, bounded length, never empty. The DISPLAY name keeps the
 * user's spelling — this is only what the object store sees.
 */
export function sanitizeFilename(name: string | undefined | null): string {
  const base = String(name ?? '')
    .split(/[/\\]/).pop()!            // strip any path the browser leaked in
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')  // control chars have no place in a key
    .replace(/[^\w.\- ()]/g, '_')     // storage keys stay ASCII-safe
    .replace(/\s+/g, ' ')
    .trim();
  const bounded = base.length > 140 ? base.slice(base.length - 140) : base;
  return bounded || 'document';
}

/** {user}/{doc}/{file}: the owner's id leads, so every object a user has ever
 *  stored lives under one prefix and a compromise of one path leaks one file. */
export function storagePathFor(userId: string, documentId: string, filename: string): string {
  return `${userId}/${documentId}/${sanitizeFilename(filename)}`;
}

// ── Field whitelist ──────────────────────────────────────────────────────────

/** '' → null for the optional columns: multipart forms send empty strings, and
 *  an empty string in a DATE (or a CHECK-constrained TEXT) column is the exact
 *  ""→22P02-class failure the transaction routes already learned to coerce. */
const emptyToNull = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export interface DocumentMetadata {
  name?: string;
  document_type?: DocumentType;
  document_date?: string | null;
  provider?: string | null;
  notes?: string | null;
  linked_type?: LinkedType | null;
  linked_id?: string | null;
}

export type FieldRefusal = { error: string } | null;

/**
 * The one gate every metadata write passes through (upload and edit alike).
 * Returns the whitelisted, coerced patch — or a refusal naming what was wrong.
 * Unknown keys are dropped, never written: `user_id`, `storage_path` and
 * `size_bytes` can only ever be set by the server itself.
 */
export function pickDocumentFields(
  body: Record<string, unknown>,
): { fields: DocumentMetadata; refusal: FieldRefusal } {
  const fields: DocumentMetadata = {};

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { fields, refusal: { error: 'A document needs a name.' } };
    fields.name = name.slice(0, 200);
  }

  if (body.document_type !== undefined) {
    const t = String(body.document_type);
    if (!(DOCUMENT_TYPES as readonly string[]).includes(t)) {
      return { fields, refusal: { error: `Unknown document type '${t}'.` } };
    }
    fields.document_type = t as DocumentType;
  }

  if (body.document_date !== undefined) {
    const d = emptyToNull(body.document_date);
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { fields, refusal: { error: 'document_date must be YYYY-MM-DD.' } };
    }
    fields.document_date = d;
  }

  if (body.provider !== undefined) fields.provider = emptyToNull(body.provider);
  if (body.notes !== undefined) fields.notes = emptyToNull(body.notes);

  // The link travels as a pair or not at all — same rule the table enforces.
  if (body.linked_type !== undefined || body.linked_id !== undefined) {
    const type = emptyToNull(body.linked_type);
    const id = emptyToNull(body.linked_id);
    if ((type === null) !== (id === null)) {
      return { fields, refusal: { error: 'A link needs both linked_type and linked_id (or neither).' } };
    }
    if (type !== null && !(LINKABLE_TYPES as readonly string[]).includes(type)) {
      return { fields, refusal: { error: `Documents cannot be linked to '${type}'.` } };
    }
    if (type === 'tax_year' && id !== null && !/^\d{4}-\d{4}$/.test(id)) {
      return { fields, refusal: { error: "A tax year link uses the FY label, e.g. '2025-2026'." } };
    }
    fields.linked_type = type as LinkedType | null;
    fields.linked_id = id;
  }

  return { fields, refusal: null };
}

// ── Visibility ───────────────────────────────────────────────────────────────

/** The ids of one record kind this scope may see beyond its own rows —
 *  household-shared and directly-granted merged, exactly as visibilityFilter
 *  in householdScope.ts merges them. */
function visibleRecordIds(scope: HouseholdScope, type: ShareRecordType): Set<string> {
  return new Set<string>([
    ...(scope.householdRecords.get(type) ?? []),
    ...grantedIds(scope, type),
  ]);
}

/**
 * The PostgREST `.or(...)` filter for "documents this user may see": their own,
 * plus documents filed to a household they are in, plus documents filed to a
 * record they can see. Null when only ownership applies — the caller then uses
 * the plain `.eq('user_id', …)`, so the personal-only path (nearly everybody)
 * gains no `or` and no new way to be wrong.
 */
export function documentVisibilityFilter(scope: HouseholdScope): string | null {
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

export interface DocumentVisibilityRow {
  user_id: string;
  linked_type?: string | null;
  linked_id?: string | null;
}

/**
 * The single-row form of the filter above, for the download/preview endpoint —
 * one fetched row, one answer, provably the same rule.
 */
export function canSeeDocument(doc: DocumentVisibilityRow, scope: HouseholdScope): boolean {
  if (doc.user_id === scope.userId) return true;
  if (!doc.linked_type || !doc.linked_id) return false;
  if (doc.linked_type === 'household') return isMemberOf(scope, doc.linked_id);
  if ((RECORD_LINK_TYPES as string[]).includes(doc.linked_type)) {
    return visibleRecordIds(scope, doc.linked_type as ShareRecordType).has(doc.linked_id);
  }
  // tax_year (and anything future): personal, owner only.
  return false;
}

// ── Link validation ──────────────────────────────────────────────────────────

export type LinkRefusal = { status: number; error: string } | null;

/**
 * May this user file a document against this target?
 *
 * A household: only one they are a member of. A record: only one they can SEE —
 * their own, or one shared with them — because linking is filing, not
 * publishing: the document's audience follows the record's audience, so linking
 * to a record you can see can never show your file to anyone who couldn't
 * already see the record. A tax year needs no lookup: it is the caller's own
 * by construction.
 *
 * `targetOwnerId` is the fetched owner of the record (null = not found); the
 * route does the one-row read, this decides.
 */
export function linkTargetRefusal(
  linkedType: LinkedType,
  linkedId: string,
  targetOwnerId: string | null,
  scope: HouseholdScope,
): LinkRefusal {
  if (linkedType === 'tax_year') return null;

  if (linkedType === 'household') {
    return isMemberOf(scope, linkedId)
      ? null
      : { status: 403, error: "You're not a member of that household." };
  }

  // Not-found and not-visible give the same answer — "this is not yours to
  // know about" must not become an oracle for guessing other people's ids.
  if (!targetOwnerId) return { status: 404, error: 'That record was not found.' };
  if (targetOwnerId === scope.userId) return null;
  if (visibleRecordIds(scope, linkedType as ShareRecordType).has(linkedId)) return null;
  return { status: 404, error: 'That record was not found.' };
}
