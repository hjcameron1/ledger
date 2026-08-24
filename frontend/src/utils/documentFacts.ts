/**
 * Phase 8.3 — what a document says, on the client side.
 *
 * The decisions all live on the server (backend/src/services/documentFacts.ts):
 * which fields a kind of document may yield, whether a value is really in the
 * words quoted, what parses as a date. Nothing here re-decides any of that.
 * This file does two smaller jobs, both presentational:
 *
 *   • turn a stored row into something with a LABEL and a readable value, and
 *   • say whether an answer may be built on it.
 *
 * The trust floor is duplicated from the server deliberately rather than
 * fetched: the server enforces it (nothing else may write a fact), and the
 * client needs the same number to explain WHY a reading is being shown greyed
 * out with a "confirm this" beside it. Should they ever disagree, the server's
 * answer is the one that decides what is stored; this one only decides what is
 * said about it.
 */
import type { DocumentFact, DocumentFactKind, LedgerDocument } from '../types';

/** Mirrors FACT_TRUST_FLOOR in backend/src/services/documentFacts.ts. */
export const FACT_TRUST_FLOOR = 0.75;

/** A fact nobody has checked, that the reader was not sure enough about. */
export function factNeedsConfirmation(f: Pick<DocumentFact, 'confidence' | 'status'>): boolean {
  return f.status === 'unconfirmed' && Number(f.confidence) < FACT_TRUST_FLOOR;
}

/**
 * May something be answered from this reading?
 *
 * Confirmed always; unconfirmed only when the reader was sure; rejected never.
 * A reading the user has said is wrong does not quietly resurface somewhere
 * they weren't looking.
 */
export function factIsUsable(f: Pick<DocumentFact, 'confidence' | 'status'>): boolean {
  if (f.status === 'rejected') return false;
  if (f.status === 'confirmed') return true;
  return Number(f.confidence) >= FACT_TRUST_FLOOR;
}

/**
 * What to call a field in front of a person.
 *
 * A field the server knows about that this table does not is prettified rather
 * than dropped — a new field on the server should appear in the UI reading
 * slightly plainly, never disappear.
 */
const FIELD_LABELS: Record<string, string> = {
  insurer: 'Insurer',
  policy_number: 'Policy number',
  policy_type: 'Cover type',
  premium_amount: 'Premium',
  premium_frequency: 'Billed',
  start_date: 'Cover starts',
  renewal_date: 'Renews',
  excess: 'Excess',
  coverage_amount: 'Sum insured',
  lender: 'Lender',
  account_number: 'Account number',
  balance: 'Balance',
  interest_rate: 'Interest rate',
  repayment_amount: 'Repayment',
  repayment_frequency: 'Repaid',
  loan_term: 'Term',
  maturity_date: 'Matures',
  provider: 'Provider',
  period_start: 'Period from',
  period_end: 'Period to',
  opening_balance: 'Opening balance',
  closing_balance: 'Closing balance',
  total_credits: 'Money in',
  total_debits: 'Money out',
  minimum_payment: 'Minimum payment',
  payment_due_date: 'Payment due',
};

export function factLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  const words = field.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : field;
}

/** The document types Ledger will read. Mirrors EXTRACTABLE_TYPES. */
export const READABLE_DOCUMENT_TYPES = ['insurance', 'loan', 'statement'] as const;

export function isReadableDocument(doc: Pick<LedgerDocument, 'document_type' | 'mime_type'>): boolean {
  return (READABLE_DOCUMENT_TYPES as readonly string[]).includes(doc.document_type)
    && (doc.mime_type === 'application/pdf' || doc.mime_type.startsWith('image/'));
}

/** A stored fact, ready to be shown or quoted. Nothing is computed from it. */
export interface DocumentFactView {
  id: string;
  documentId: string;
  field: string;
  label: string;
  kind: DocumentFactKind;
  /** The value as it reads — a date is ISO, money is digits, text is the page's. */
  text: string;
  number: number | null;
  date: string | null;
  /** The words on the page it came from. Shown wherever the value is claimed. */
  quote: string;
  page: number | null;
  confidence: number;
  status: DocumentFact['status'];
  source: DocumentFact['source'];
  usable: boolean;
  needsConfirmation: boolean;
}

export function factView(f: DocumentFact): DocumentFactView {
  const number = f.value_number == null ? null : Number(f.value_number);
  return {
    id: f.id,
    documentId: f.document_id,
    field: f.field,
    label: factLabel(f.field),
    kind: f.value_kind,
    text: f.value_text,
    number: Number.isFinite(number as number) ? (number as number) : null,
    date: f.value_date ?? null,
    quote: f.quote,
    page: f.page ?? null,
    confidence: Number(f.confidence) || 0,
    status: f.status,
    source: f.source,
    usable: factIsUsable(f),
    needsConfirmation: factNeedsConfirmation(f),
  };
}

/**
 * The readings for one document, in the order the fields are worth reading:
 * usable first, then the ones waiting on the user. Rejected readings are gone
 * — the user has already said what they think of them.
 */
export function factsForDocument(facts: DocumentFact[], documentId: string): DocumentFactView[] {
  return facts
    .filter(f => f.document_id === documentId && f.status !== 'rejected')
    .map(factView)
    .sort((a, b) => Number(b.usable) - Number(a.usable) || a.label.localeCompare(b.label));
}
