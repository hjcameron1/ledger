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
 * A document may ALSO be shared to households in its own right, through the
 * same `record_households` join every other shareable row uses (record type
 * 'document'). One document row, in as many households as its owner puts it in,
 * counted and shown once in each — never a copy. That share is the owner's to
 * make and to end, and ending it removes the document from that household's
 * view in the same instant, again with nothing to clean up.
 *
 * Writes never follow anybody: rename, re-file and delete are OWNER-ONLY.
 */

import { HouseholdScope } from './householdScope';
// The visibility rule itself lives in linkedVisibility.ts — Phase 8.2 hangs
// insurance policies on the same one, and two copies of "who may see this" would
// be two chances to answer it differently. This file keeps the vault's own
// vocabulary (what a document IS) and delegates the decision.
import {
  RECORD_LINK_TYPES, TABLE_OF_LINK, linkedVisibilityFilter, canSeeLinked,
  linkTargetRefusal as refuseLinkTarget, type LinkRefusal,
} from './linkedVisibility';

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

/** The linked types whose visibility cascades through household scope, and
 *  where each of them lives — re-exported so the vault's callers and tests keep
 *  reading them from here. */
export { RECORD_LINK_TYPES, TABLE_OF_LINK };

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

/**
 * The households a write is asking this document to sit in, or null when the
 * request said nothing about sharing (so an ordinary rename can never move a
 * document between households as a side effect).
 *
 * Accepts what each caller can actually send: a JSON array from the edit
 * screen, and a comma-separated string from the multipart upload form, which
 * has no way to express an array. An empty value is a real answer — "no
 * households" — and is kept apart from silence.
 */
export function pickHouseholdIds(body: Record<string, unknown> | null | undefined): string[] | null {
  const raw = body?.household_ids;
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw)
    ? raw.map(v => String(v))
    : String(raw).split(',');
  return [...new Set(list.map(v => v.trim()).filter(Boolean))];
}

// ── Visibility ───────────────────────────────────────────────────────────────
//
// TWO ways in, and only two:
//
//   FOLLOWING ITS LINK   the shared rule in linkedVisibility.ts, named in the
//                        vault's own words — a document filed against a record
//                        is seen by whoever sees that record. `tax_year` needs
//                        no special case: an unrecognised link kind is personal
//                        there, which is exactly what tax is.
//   SHARED IN ITS OWN    a `record_households` row of type 'document', put there
//   RIGHT                by its owner. The same many-to-many join every other
//                        shareable row uses, so one document can sit in several
//                        households at once and is still ONE row.
//
// Both are derived at READ time from the caller's scope, nothing is stamped on
// the document, and neither can reach further than the other allows: a document
// shared to a household is visible to that household's members and to nobody
// else, and un-sharing it takes it back in the same instant.

/** The documents shared with a household this caller is in, as ids. Empty for
 *  everyone not in a household — the path that must behave exactly as before. */
export function sharedDocumentIds(scope: HouseholdScope): Set<string> {
  return new Set(scope.householdRecords.get('document') ?? []);
}

/**
 * The PostgREST `.or(...)` filter for "documents this user may see": their own,
 * plus documents shared to a household they are in, plus documents filed to a
 * household they are in or to a record they can see. Null when only ownership
 * applies — the caller then uses the plain `.eq('user_id', …)`, so the
 * personal-only path (nearly everybody) gains no `or` and no new way to be wrong.
 */
export function documentVisibilityFilter(scope: HouseholdScope): string | null {
  const linked = linkedVisibilityFilter(scope);
  const shared = sharedDocumentIds(scope);
  if (!shared.size) return linked;

  const parts = linked ? [linked] : [`user_id.eq.${scope.userId}`];
  parts.push(`id.in.(${[...shared].join(',')})`);
  return parts.join(',');
}

export interface DocumentVisibilityRow {
  id?: string;
  user_id: string;
  linked_type?: string | null;
  linked_id?: string | null;
}

/**
 * The single-row form of the filter above, for the download/preview endpoint —
 * one fetched row, one answer, provably the same rule.
 */
export function canSeeDocument(doc: DocumentVisibilityRow, scope: HouseholdScope): boolean {
  if (canSeeLinked(doc, scope)) return true;
  return !!doc.id && sharedDocumentIds(scope).has(doc.id);
}

// ── Link validation ──────────────────────────────────────────────────────────

export type { LinkRefusal };

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
  return refuseLinkTarget(linkedType, linkedId, targetOwnerId, scope);
}
