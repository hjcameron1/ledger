/**
 * Phase 8.1 — the document vault's presentation logic, kept pure.
 *
 * The page (pages/Documents.tsx) renders; THIS file decides: what a document
 * type is called, what a link points at in words, which mimes preview inline,
 * how a mixed pile of paperwork splits into "yours" and "shared with you",
 * which documents belong in the view being looked at, which belong to one
 * record, and which FY labels a tax link may use. Pure functions over data —
 * tested in documents.test.ts without a browser.
 */
import type {
  LedgerDocument, DocumentKind, DocumentLinkType, FinanceScope,
  BankAccount, CreditCard, Loan, Property, Investment, Household,
} from '../types';
import { householdsOf, scopeRows, type HouseholdContext } from './household';

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const DOCUMENT_KINDS: { value: DocumentKind; label: string }[] = [
  { value: 'statement', label: 'Statement' },
  { value: 'payslip',   label: 'Payslip' },
  { value: 'tax',       label: 'Tax document' },
  { value: 'loan',      label: 'Loan document' },
  { value: 'property',  label: 'Property document' },
  { value: 'insurance', label: 'Insurance policy' },
  { value: 'receipt',   label: 'Receipt' },
  { value: 'contract',  label: 'Contract' },
  { value: 'other',     label: 'Other' },
];

export function kindLabel(kind: string): string {
  return DOCUMENT_KINDS.find(k => k.value === kind)?.label ?? 'Other';
}

/** Badge tint per kind — same palette idiom as the Forecast source badges. */
export const KIND_BADGE: Record<DocumentKind, string> = {
  statement: 'bg-brand/15 text-brand',
  payslip:   'bg-[#22c55e]/15 text-[#16a34a]',
  tax:       'bg-[#f59e0b]/15 text-[#d97706]',
  loan:      'bg-[#ec4899]/15 text-[#ec4899]',
  property:  'bg-[#a855f7]/15 text-[#a855f7]',
  insurance: 'bg-[#06b6d4]/15 text-[#0891b2]',
  receipt:   'bg-[#64748b]/15 text-[#64748b]',
  contract:  'bg-[#8b5cf6]/15 text-[#8b5cf6]',
  other:     'bg-zinc-500/15 text-zinc-500',
};

export const LINK_TYPE_LABEL: Record<DocumentLinkType, string> = {
  account: 'Account',
  card: 'Credit card',
  loan: 'Loan',
  property: 'Property',
  investment: 'Investment',
  tax_year: 'Tax year',
  household: 'Household',
};

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatBytes(bytes: number | null | undefined): string {
  const n = bytes ?? 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Mirrors the server's isPreviewable: PDFs, images and text render inline;
 *  everything else is honest about being download-only. */
export function canPreview(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
}

// ── Link resolution ──────────────────────────────────────────────────────────

/** A row a link can point at — some entities' names are optional in the store,
 *  so the display falls back rather than the type lying about it. */
export interface Linkable { id: string; name?: string | null }

export interface LinkSources {
  accounts: (Pick<BankAccount, 'id'> & Linkable)[];
  creditCards: (Pick<CreditCard, 'id'> & Linkable)[];
  loans: (Pick<Loan, 'id'> & Linkable)[];
  properties: (Pick<Property, 'id'> & Linkable)[];
  investments: (Pick<Investment, 'id'> & Linkable)[];
  households: (Pick<Household, 'id'> & Linkable)[];
}

export function displayName(r: Linkable): string {
  return (r.name ?? '').trim() || 'Unnamed';
}

/** "2024-2025" → "Tax year 2024–25" and friends: the words a link renders as.
 *  A link whose target this device can't resolve (not shared with us, or long
 *  deleted) still SAYS what it is rather than pretending there is no link. */
export function linkDisplay(doc: Pick<LedgerDocument, 'linked_type' | 'linked_id'>, sources: LinkSources): string | null {
  if (!doc.linked_type || !doc.linked_id) return null;
  const label = LINK_TYPE_LABEL[doc.linked_type];

  if (doc.linked_type === 'tax_year') {
    const m = doc.linked_id.match(/^(\d{4})-(\d{4})$/);
    return m ? `Tax year ${m[1]}–${m[2].slice(2)}` : `Tax year ${doc.linked_id}`;
  }

  const pool: Record<string, Linkable[]> = {
    account: sources.accounts,
    card: sources.creditCards,
    loan: sources.loans,
    property: sources.properties,
    investment: sources.investments,
    household: sources.households,
  };
  const hit = (pool[doc.linked_type] ?? []).find(r => r.id === doc.linked_id);
  return hit ? `${label} · ${displayName(hit)}` : label;
}

// ── Grouping and filtering ───────────────────────────────────────────────────

/**
 * Yours versus shared with you — by OWNERSHIP, the same split every other
 * screen draws. A document another member filed to the household appears under
 * "Shared with you" and never among your own papers.
 */
export function splitByOwnership(
  docs: LedgerDocument[], myUserId: string | null | undefined,
): { mine: LedgerDocument[]; shared: LedgerDocument[] } {
  const mine: LedgerDocument[] = [];
  const shared: LedgerDocument[] = [];
  for (const d of docs) (d.user_id === myUserId ? mine : shared).push(d);
  return { mine, shared };
}

/** Kind filter + free-text search over the fields a person actually remembers:
 *  name, filename, provider, notes, and the words of its type. */
export function filterDocuments(
  docs: LedgerDocument[], kind: DocumentKind | 'all', search: string,
): LedgerDocument[] {
  const q = search.trim().toLowerCase();
  return docs.filter(d => {
    if (kind !== 'all' && d.document_type !== kind) return false;
    if (!q) return true;
    return [d.name, d.original_filename, d.provider, d.notes, kindLabel(d.document_type)]
      .some(f => (f ?? '').toLowerCase().includes(q));
  });
}

// ── Which view a document belongs in ─────────────────────────────────────────
//
// A document is a shareable row like any other, so it is scoped like any other:
// the SAME `scopeRows` every account, loan and property goes through. Two
// questions, and only two:
//
//   MY FINANCES  the documents you OWN — shared or not. A statement you filed
//                into the household is still your paperwork and still belongs
//                here; somebody else's is NOT yours and never appears here,
//                however many households the two of you share. This is the
//                whole of the leak that used to exist: "everything this device
//                was sent" put another member's paperwork in a view that means
//                "mine".
//   HOUSEHOLD    the documents in THAT household — its own shares and whatever
//                is filed against something it can see, from every member,
//                each once. Nobody's private papers, nothing from another
//                household.
//
// Where somebody else's shared document is therefore the same answer as for
// their shared account: in the household view where they put it. And because
// this is `scopeRows`, that answer cannot drift from the rest of the ledger's.

/**
 * The documents to show in the current view — ownership in My Finances, the
 * household's own picture in a household. See the note above.
 *
 * A household scope with no household resolved (or one the user is no longer a
 * member of) shows nothing rather than everything: an unanswerable "which
 * household?" must never fall back to "all of them".
 */
export function scopeDocuments(
  docs: LedgerDocument[],
  ctx: HouseholdContext,
  scope: FinanceScope,
  householdId?: string | null,
): LedgerDocument[] {
  return scopeRows(docs, ctx, scope, householdId);
}

/** The households a document appears in — its own shares and its link's, as the
 *  server merged them. Named here so screens never read the field raw. */
export function documentHouseholds(doc: LedgerDocument): string[] {
  return householdsOf(doc);
}

// ── The other direction: a record's paperwork ────────────────────────────────

/**
 * The documents filed against ONE record — what a Documents section on an
 * account, card, loan, property, investment or tax year shows.
 *
 * The link is stored once, on the document, and read from both ends: this is
 * the same `linked_type`/`linked_id` pair the vault files by, so a document can
 * never appear against a record it was not filed against, and nothing has to be
 * kept in step. Permission needs no thought here either — the list it filters
 * is what the server was willing to send.
 *
 * Newest paperwork first, by the document's OWN date where it has one (a
 * statement's period, not when somebody got round to uploading it).
 */
export function documentsForRecord(
  docs: LedgerDocument[], linkedType: DocumentLinkType, linkedId: string | null | undefined,
): LedgerDocument[] {
  if (!linkedId) return [];
  return docs
    .filter(d => d.linked_type === linkedType && d.linked_id === linkedId)
    .sort(byNewest);
}

/** The documents with these ids — for a record that points AT its document
 *  (an insurance policy's `document_id`) rather than being pointed at. */
export function documentsByIds(
  docs: LedgerDocument[], ids: (string | null | undefined)[],
): LedgerDocument[] {
  const wanted = new Set(ids.filter(Boolean) as string[]);
  if (!wanted.size) return [];
  return docs.filter(d => wanted.has(d.id)).sort(byNewest);
}

function byNewest(a: LedgerDocument, b: LedgerDocument): number {
  const key = (d: LedgerDocument) => d.document_date ?? d.created_at ?? '';
  return key(b).localeCompare(key(a));
}

// ── Tax years ────────────────────────────────────────────────────────────────

/** The FY label ("2025-2026") containing a date — Australian FY, 1 Jul–30 Jun. */
export function fyOfDate(date: Date): string {
  const y = date.getFullYear();
  return date.getMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** The current FY and the `count-1` before it, newest first — what the tax-year
 *  link picker offers. */
export function fyOptions(now: Date, count = 8): string[] {
  const [startYear] = fyOfDate(now).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => `${startYear - i}-${startYear - i + 1}`);
}
