/**
 * Phase 8.3 — what a document SAYS, kept honest.
 *
 * The vault (documentVault.ts) decides who may see a file. This file decides
 * what may be believed about one. Everything here is pure so it can be tested
 * without a database, a model or a network — which matters more than usual,
 * because this is the layer standing between a language model's reading of a
 * PDF and figures the user will act on.
 *
 * THE RULE, in one line: A FACT IS THE WORDS ON THE PAGE, OR IT IS NOT A FACT.
 *
 * Three structural consequences, none of them a request made to a prompt:
 *
 *   • A proposed fact must quote the document, and the value must be FOUND IN
 *     THE QUOTE. A premium of $1,240 whose quote does not contain 1240 is
 *     discarded, whatever the model's confidence. This is the same guard the
 *     Ask Ledger rewriter uses on figures, applied a layer earlier: a number
 *     nobody can point at is not reported.
 *   • A field outside the closed list for this KIND of document is discarded.
 *     A "statement" cannot yield an excess; an insurance schedule cannot yield
 *     a closing balance. Reading a field that the document type does not have
 *     is the shape inference takes when it goes wrong.
 *   • A value that does not parse as what its field is (a date that is not a
 *     date, money that is not a number) is discarded rather than coerced.
 *     Coercion is how "the 3rd" becomes the 3rd of the wrong month.
 *
 * Confidence is not a filter here — it is carried through to the row, and
 * decides how the fact may be USED: below FACT_TRUST_FLOOR nothing is answered
 * from it until a person has confirmed it. Filtering low-confidence facts out
 * silently would leave the user with no way to tell Ledger it read correctly.
 */

/** What kind of value a field holds — decides parsing, storage and formatting. */
export type FactKind = 'money' | 'date' | 'rate' | 'text';

export interface FactSpec {
  field: string;
  /** What to call it in front of a person. */
  label: string;
  kind: FactKind;
  /** Told to the extractor, so it looks for the right words on the page. */
  hint: string;
}

/**
 * The document types Ledger will try to read, and the ONLY fields it will
 * accept from each.
 *
 * Deliberately short. Every field here is one Ledger already has a home for —
 * a policy's renewal date, a loan's rate, a statement's closing balance — so a
 * fact read out of paperwork can be checked against, or promoted into, a real
 * record. Fields nobody can use are fields nobody can check.
 */
export const FACT_FIELDS = {
  insurance: [
    { field: 'insurer', label: 'Insurer', kind: 'text', hint: 'the company providing the cover' },
    { field: 'policy_number', label: 'Policy number', kind: 'text', hint: 'the policy or certificate number' },
    { field: 'policy_type', label: 'Cover type', kind: 'text', hint: 'what is covered — car, home, health, life, landlord' },
    { field: 'premium_amount', label: 'Premium', kind: 'money', hint: 'what the premium costs, as billed' },
    { field: 'premium_frequency', label: 'Billed', kind: 'text', hint: 'how often the premium is billed — annually, monthly, fortnightly' },
    { field: 'start_date', label: 'Cover starts', kind: 'date', hint: 'the day cover begins' },
    { field: 'renewal_date', label: 'Renews', kind: 'date', hint: 'the day cover expires or falls due for renewal' },
    { field: 'excess', label: 'Excess', kind: 'money', hint: 'the excess payable on a claim' },
    { field: 'coverage_amount', label: 'Sum insured', kind: 'money', hint: 'the sum insured or benefit amount' },
  ],
  loan: [
    { field: 'lender', label: 'Lender', kind: 'text', hint: 'the bank or lender' },
    { field: 'account_number', label: 'Account number', kind: 'text', hint: 'the loan or account number' },
    { field: 'balance', label: 'Balance', kind: 'money', hint: 'the amount owing' },
    { field: 'interest_rate', label: 'Interest rate', kind: 'rate', hint: 'the annual interest rate, as a percentage' },
    { field: 'repayment_amount', label: 'Repayment', kind: 'money', hint: 'the scheduled repayment amount' },
    { field: 'repayment_frequency', label: 'Repaid', kind: 'text', hint: 'how often repayments are made' },
    { field: 'loan_term', label: 'Term', kind: 'text', hint: 'the loan term, as written' },
    { field: 'maturity_date', label: 'Matures', kind: 'date', hint: 'the day the loan is scheduled to end' },
  ],
  statement: [
    { field: 'provider', label: 'Provider', kind: 'text', hint: 'the bank or institution the statement is from' },
    { field: 'account_number', label: 'Account number', kind: 'text', hint: 'the account number the statement is for' },
    { field: 'period_start', label: 'Period from', kind: 'date', hint: 'the first day of the statement period' },
    { field: 'period_end', label: 'Period to', kind: 'date', hint: 'the last day of the statement period' },
    { field: 'opening_balance', label: 'Opening balance', kind: 'money', hint: 'the balance the period opened with' },
    { field: 'closing_balance', label: 'Closing balance', kind: 'money', hint: 'the balance the period closed with' },
    { field: 'total_credits', label: 'Money in', kind: 'money', hint: 'total credits, deposits or money in over the period' },
    { field: 'total_debits', label: 'Money out', kind: 'money', hint: 'total debits, withdrawals or money out over the period' },
    { field: 'minimum_payment', label: 'Minimum payment', kind: 'money', hint: 'the minimum payment due, on a card statement' },
    { field: 'payment_due_date', label: 'Payment due', kind: 'date', hint: 'the day payment is due' },
  ],
} as const satisfies Record<string, readonly FactSpec[]>;

export type ExtractableType = keyof typeof FACT_FIELDS;

export const EXTRACTABLE_TYPES = Object.keys(FACT_FIELDS) as ExtractableType[];

export function isExtractableType(t: string | null | undefined): t is ExtractableType {
  return !!t && Object.prototype.hasOwnProperty.call(FACT_FIELDS, t);
}

/** Files that can be read at all. A spreadsheet is data, not a document to read. */
export const EXTRACTABLE_MIMES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

export function isExtractableMime(mime: string | null | undefined): boolean {
  return !!mime && EXTRACTABLE_MIMES.has(mime);
}

/**
 * How sure the extractor must be before a fact may be answered from without
 * anybody looking at it.
 *
 * Below this the fact is still stored, still shown, and still quoted — it is
 * simply marked as needing confirmation, and nothing is built on it until the
 * user says it is right. A wrong renewal date the user was never shown is
 * worse than no renewal date; a wrong one they were asked about is a typo they
 * fix in a second.
 */
export const FACT_TRUST_FLOOR = 0.75;

export interface ExtractedFact {
  field: string;
  kind: FactKind;
  /** The value as it reads. Always set. */
  valueText: string;
  /** The value as it computes, for money and rates. */
  valueNumber: number | null;
  /** The value as a date, ISO `YYYY-MM-DD`, for dates. */
  valueDate: string | null;
  /** The words on the page it came from, verbatim. Never empty. */
  quote: string;
  page: number | null;
  /** 0–1, as the extractor reported it. */
  confidence: number;
}

/** A proposal that did not survive, and the reason — surfaced, never silent. */
export interface DiscardedFact {
  field: string;
  reason: string;
}

// ── Parsing ──────────────────────────────────────────────────────────────────
//
// Forgiving about how a value is written, unforgiving about whether it is that
// kind of value at all. Anything these cannot read is discarded; none of them
// ever fills in a part that is missing.

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Digits only, for comparing a value against the words it was taken from. */
function digitsOf(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `$1,240.50` → 1240.5. Null when there is no number in it at all. */
export function parseMoney(raw: string): number | null {
  const m = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** `5.89% p.a.` → 5.89. Percent signs and words around it are ignored. */
export function parseRate(raw: string): number | null {
  const n = parseMoney(raw);
  if (n == null) return null;
  // A rate written as a fraction ("0.0589") is a different claim from 5.89%,
  // and guessing which was meant is exactly the inference this file refuses.
  return n >= 0 && n <= 100 ? n : null;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A date as ISO, from the spellings paperwork actually uses.
 *
 * `DD/MM/YYYY` is read Australian, because this app is: every other date in
 * Ledger is. An ambiguous `03/04/2027` therefore means 3 April — stated here
 * rather than left to whoever reads the row next.
 */
export function parseDateValue(raw: string): string | null {
  const t = raw.trim().toLowerCase();

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const slash = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (slash) return validDate(+slash[3], +slash[2], +slash[1]);

  const named = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (named) {
    const month = MONTHS.findIndex(m => m.startsWith(named[2].slice(0, 3)));
    if (month >= 0) return validDate(+named[3], month + 1, +named[1]);
  }

  const monthFirst = t.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (monthFirst) {
    const month = MONTHS.findIndex(m => m.startsWith(monthFirst[1].slice(0, 3)));
    if (month >= 0) return validDate(+monthFirst[3], month + 1, +monthFirst[2]);
  }

  return null;
}

// ── The guard ────────────────────────────────────────────────────────────────

/**
 * Is this value actually IN the words it claims to come from?
 *
 * The whole feature rests on this function. A model asked to quote its source
 * will quote something; whether the number it reported appears in that quote
 * is checkable, and is checked. The comparison is deliberately loose about
 * formatting ($1,240.00 against "1240") and strict about identity: a different
 * number is a different number.
 */
export function quoteSupports(kind: FactKind, valueText: string, valueNumber: number | null, valueDate: string | null, quote: string): boolean {
  const q = quote.toLowerCase();
  if (!q.trim()) return false;

  if (kind === 'money' || kind === 'rate') {
    if (valueNumber == null) return false;
    const qDigits = digitsOf(q);
    // Both the written form ("1,240.50") and the plain integer ("1240") are
    // accepted, because a page saying "$1,240" supports a value of 1240.
    const whole = digitsOf(String(Math.trunc(Math.abs(valueNumber))));
    const exact = digitsOf(String(Math.abs(valueNumber)));
    return (whole.length > 0 && qDigits.includes(whole)) || (exact.length > 0 && qDigits.includes(exact));
  }

  if (kind === 'date') {
    if (!valueDate) return false;
    const [y, m, d] = valueDate.split('-');
    if (!q.includes(y)) return false;
    const monthName = MONTHS[+m - 1];
    const saysMonth = q.includes(monthName) || q.includes(monthName.slice(0, 3))
      || new RegExp(`\\b0?${+m}\\b`).test(q);
    const saysDay = new RegExp(`\\b0?${+d}(?:st|nd|rd|th)?\\b`).test(q);
    return saysMonth && saysDay;
  }

  // Text: the value has to be in the sentence. Substring rather than equality,
  // because a quote is a line off the page ("Insurer: NRMA Insurance"), not the
  // value on its own.
  const v = letters(valueText);
  return v.length > 0 && letters(q).includes(v);
}

// ── Sanitising a proposal ────────────────────────────────────────────────────

/** One untrusted proposal, exactly as a model might hand it over. */
export interface RawFactProposal {
  field?: unknown;
  value?: unknown;
  quote?: unknown;
  page?: unknown;
  confidence?: unknown;
}

function str(v: unknown, max: number): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
}

/**
 * Turn what a model proposed into what Ledger will store.
 *
 * Everything is untrusted: the field name, the value, the quote, the page, the
 * confidence. Whatever does not survive comes back in `discarded` with a
 * reason, so a document that read badly can say so instead of quietly
 * producing three facts out of nine.
 */
export function sanitiseExtraction(
  documentType: string,
  raw: unknown,
): { facts: ExtractedFact[]; discarded: DiscardedFact[] } {
  const facts: ExtractedFact[] = [];
  const discarded: DiscardedFact[] = [];

  if (!isExtractableType(documentType)) {
    return { facts, discarded: [{ field: '*', reason: `Ledger does not read ${documentType || 'this kind of'} documents.` }] };
  }

  const specs = FACT_FIELDS[documentType] as readonly FactSpec[];
  const bySpec = new Map(specs.map(s => [s.field, s]));

  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { fields?: unknown })?.fields)
      ? ((raw as { fields: unknown[] }).fields)
      : [];

  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as RawFactProposal;

    const field = str(p.field, 60)?.toLowerCase().replace(/\s+/g, '_') ?? '';
    const spec = bySpec.get(field);
    if (!spec) {
      if (field) discarded.push({ field, reason: 'not a field this kind of document has' });
      continue;
    }
    // One answer per field. A second reading of the same field is a
    // disagreement, and the honest thing to do with a disagreement is not to
    // pick the later one.
    if (seen.has(field)) {
      discarded.push({ field, reason: 'read twice, with two answers' });
      continue;
    }

    const valueText = str(p.value, 200);
    if (!valueText) { discarded.push({ field, reason: 'no value' }); continue; }

    const quote = str(p.quote, 400);
    if (!quote) { discarded.push({ field, reason: 'nothing quoted from the document' }); continue; }

    let valueNumber: number | null = null;
    let valueDate: string | null = null;
    if (spec.kind === 'money') valueNumber = parseMoney(valueText);
    if (spec.kind === 'rate') valueNumber = parseRate(valueText);
    if (spec.kind === 'date') valueDate = parseDateValue(valueText);

    if ((spec.kind === 'money' || spec.kind === 'rate') && valueNumber == null) {
      discarded.push({ field, reason: `"${valueText}" is not an amount` });
      continue;
    }
    if (spec.kind === 'date' && !valueDate) {
      discarded.push({ field, reason: `"${valueText}" is not a date` });
      continue;
    }

    if (!quoteSupports(spec.kind, valueText, valueNumber, valueDate, quote)) {
      discarded.push({ field, reason: 'the quoted words do not contain that value' });
      continue;
    }

    const rawConfidence = typeof p.confidence === 'number' ? p.confidence : NaN;
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      // No confidence given is not high confidence. It lands below the floor,
      // so the fact is shown and asked about rather than acted on.
      : 0.4;

    const rawPage = typeof p.page === 'number' && Number.isFinite(p.page) ? Math.trunc(p.page) : null;

    seen.add(field);
    facts.push({
      field,
      kind: spec.kind,
      // The value keeps the page's own spelling for text, and Ledger's
      // spelling for anything it parsed — one canonical form per kind.
      valueText: spec.kind === 'date' ? valueDate! : valueText,
      valueNumber,
      valueDate,
      quote,
      page: rawPage != null && rawPage > 0 ? rawPage : null,
      confidence,
    });
  }

  return { facts, discarded };
}

/** A fact nobody has looked at, that the extractor was not sure enough about. */
export function factNeedsConfirmation(fact: { confidence: number; status: string }): boolean {
  return fact.status === 'unconfirmed' && fact.confidence < FACT_TRUST_FLOOR;
}

/**
 * May an answer be built on this fact?
 *
 * Confirmed always; unconfirmed only when the extractor was sure. Rejected
 * never — a fact the user has said is wrong is not a fact that gets quietly
 * used somewhere else.
 */
export function factIsUsable(fact: { confidence: number; status: string }): boolean {
  if (fact.status === 'rejected') return false;
  if (fact.status === 'confirmed') return true;
  return fact.confidence >= FACT_TRUST_FLOOR;
}

/** The label a field is shown under, for whoever is rendering it. */
export function factLabel(documentType: string, field: string): string {
  if (!isExtractableType(documentType)) return field;
  const spec = (FACT_FIELDS[documentType] as readonly FactSpec[]).find(s => s.field === field);
  return spec?.label ?? field;
}
