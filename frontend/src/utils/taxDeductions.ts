/**
 * Phase 2D.4 — smarter deduction handling (pure engine).
 *
 * Ledger already has TWO deduction inputs and this module does NOT duplicate
 * either — it MERGES them into one financial-year view:
 *
 *   1. Per-transaction tax metadata (Phase 2D.1): a transaction row flagged
 *      `is_tax_deductible` with a `deduction_category`. These are real spends the
 *      user already recorded and ticked as claimable.
 *   2. The manual `tax_deductions` list (`deductionsDS`): free-form deduction
 *      entries the user types in (e.g. a WFH hours calc) that have no single
 *      backing transaction.
 *
 * buildDeductionView() folds both into one list, filtered to a financial year,
 * grouped by deduction category, with per-group and grand totals, and each line
 * carries a link back to its source transaction where one exists.
 *
 * DOUBLE-COUNT PREVENTION: a manual deduction may be LINKED to a source
 * transaction (`source_transaction_id`). When it is, that transaction is
 * represented by the manual line and is dropped from the transaction-sourced
 * lines — so the same expense is never counted twice. Editing/removing that link
 * (setDeductionLink) is what moves an expense between "counted as the transaction"
 * and "counted as the manual entry".
 *
 * This deliberately does NOT compute final tax liability — it only assembles the
 * deduction total that feeds the existing estimate.
 *
 * PURE — no store, no network, no localStorage. `deductionsDS` (dataService) is
 * the thin persistence wrapper around the list mutators here; the Tax page
 * renders the view.
 */

import type { Transaction } from '../types';
import { financialYearOf } from './format';

/**
 * Canonical Australian work-related deduction buckets. Single source of truth so
 * the per-transaction TaxModal and the manual-deduction form group together into
 * the same categories. Free-form under the hood — an existing value not in this
 * list is always preserved by the callers, so nothing already set is lost.
 */
export const DEDUCTION_CATEGORIES: readonly string[] = [
  'Work-related travel',
  'Vehicle & car expenses',
  'Clothing, laundry & dry-cleaning',
  'Self-education',
  'Working from home',
  'Tools, equipment & assets',
  'Phone, data & internet',
  'Union & professional fees',
  'Gifts & donations',
  'Investment & interest expenses',
  'Income protection insurance',
  'Cost of managing tax affairs',
  'Other work-related',
];

/** Label used when a deduction carries no category. */
export const UNCATEGORISED_DEDUCTION = 'Uncategorised';

/** A manual `tax_deductions` record (the shape persisted by deductionsDS). */
export interface ManualDeduction {
  id: string;
  name: string;
  amount: number;
  category: string;
  date: string;
  /** Optional link to the transaction this deduction represents (dedup key). */
  source_transaction_id?: string | null;
  /**
   * Transaction ids the user confirmed are NOT duplicates of this deduction.
   * Suppresses the heuristic duplicate detector for those pairs so a genuinely
   * separate same-amount/date expense is never permanently hidden ("keep both").
   */
  not_duplicate_of?: string[];
  created_at?: string;
}

/** Days apart a manual deduction and a transaction may be and still match. */
export const DUP_DATE_WINDOW_DAYS = 3;

export type DeductionSource = 'manual' | 'transaction';

/** One row in the merged deduction view. */
export interface DeductionLine {
  /** Stable React key, namespaced by source so ids can't collide. */
  key: string;
  source: DeductionSource;
  /** The manual deduction id OR the transaction id. */
  id: string;
  name: string;
  /** Always a positive dollar figure. */
  amount: number;
  category: string;
  date: string;
  /** Source/linked transaction id, so the UI can link back. Null for unlinked manual. */
  transactionId: string | null;
  /** Display merchant of the backing transaction, when known. */
  merchant: string | null;
  /** True for a manual line that carries an explicit transaction link. */
  linked: boolean;
  /**
   * True when this line is one half of a HEURISTICALLY-detected duplicate pair
   * (same expense entered both manually and as a deductible transaction, without
   * an explicit link). Set on BOTH the manual and the transaction line so the UI
   * can flag them for review.
   */
  suspectedDuplicate: boolean;
  /**
   * The id of the other line in a suspected/explicit duplicate pair — the matched
   * transaction id (on a manual line) or the manual deduction id (on a tx line).
   */
  duplicateOf: string | null;
  /**
   * True when this line is excluded from every total (the transaction half of a
   * suspected duplicate). It stays VISIBLE for review — never silently deleted —
   * but does not contribute to group or grand totals.
   */
  excluded: boolean;
}

/** A heuristically-detected duplicate: one manual deduction ↔ one transaction. */
export interface SuspectedDuplicate {
  manualId: string;
  transactionId: string;
  /** The (shared) claim amount. */
  amount: number;
  /** Manual deduction name, for the review prompt. */
  name: string;
  category: string;
  /** Transaction merchant, when known. */
  merchant: string | null;
  date: string;
}

export interface DeductionGroup {
  category: string;
  total: number;
  lines: DeductionLine[];
}

export interface DeductionView {
  fy: string;
  /** Grand total of every line (manual + transaction), after dedup. */
  total: number;
  lineCount: number;
  /** Sum of manual deduction amounts in this FY (incl. linked ones). */
  manualTotal: number;
  /** Sum of transaction-sourced lines (excludes those a manual line represents). */
  transactionTotal: number;
  groups: DeductionGroup[];
  /** Transaction ids an EXPLICIT manual link represents — dropped from tx lines. */
  linkedTransactionIds: string[];
  /**
   * Heuristically-detected duplicate pairs awaiting review. The transaction half
   * is excluded from totals (counted via the manual line) but still shown flagged.
   */
  suspectedDuplicates: SuspectedDuplicate[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function catOf(c?: string | null): string {
  const t = (c ?? '').trim();
  return t === '' ? UNCATEGORISED_DEDUCTION : t;
}

// ─── Heuristic duplicate detection ───────────────────────────────────────────

/** Whole days between two YYYY-MM-DD dates (Infinity if either is unparseable). */
function daysBetween(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / 86_400_000;
}

/** Significant word tokens of a description (lowercased, ≥3 chars, punctuation-free). */
function tokensOf(s?: string | null): Set<string> {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3),
  );
}

/** True when two descriptions share at least one significant token. */
function descriptionSimilar(a?: string | null, b?: string | null): boolean {
  const ta = tokensOf(a);
  if (ta.size === 0) return false;
  for (const w of tokensOf(b)) if (ta.has(w)) return true;
  return false;
}

/**
 * Whether a manual deduction and a deductible transaction are LIKELY the same
 * expense — the basis for excluding one from totals and flagging the pair.
 *
 * Amount must match to the cent AND the dates must be within DUP_DATE_WINDOW_DAYS
 * (both mandatory), plus at least one corroborating signal — same category OR a
 * shared word between the manual name and the transaction merchant. This uses all
 * four fields (date, amount, description/merchant, category) and stays
 * conservative so it flags for review rather than over-matching distinct spends.
 */
export function isLikelyDuplicate(m: ManualDeduction, t: Transaction): boolean {
  const amt = round2(Math.abs(m.amount) || 0);
  if (amt === 0 || amt !== round2(Math.abs(t.amount) || 0)) return false;
  if (daysBetween(m.date, t.date) > DUP_DATE_WINDOW_DAYS) return false;
  const sameCategory = catOf(m.category) === catOf(t.deduction_category);
  return sameCategory || descriptionSimilar(m.name, t.merchant);
}

/** Stable ordering (date asc, then id) so matching is order-independent. */
function byDateThenId<T extends { date: string; id: string }>(a: T, b: T): number {
  if (a.date === b.date) return a.id.localeCompare(b.id);
  return a.date < b.date ? -1 : 1;
}

// ─── Financial-year selection ────────────────────────────────────────────────

/** Deductible transactions that fall in the given financial year. */
export function deductibleTransactionsForFY(transactions: Transaction[], fy: string): Transaction[] {
  return transactions.filter(t => t.is_tax_deductible === true && !!t.date && financialYearOf(t.date) === fy);
}

/** Manual deductions that fall in the given financial year (by their own date). */
export function manualDeductionsForFY(deductions: ManualDeduction[], fy: string): ManualDeduction[] {
  return deductions.filter(d => !!d.date && financialYearOf(d.date) === fy);
}

/**
 * Financial years present across deductible transactions + manual deductions,
 * newest first — the option list for the FY switcher.
 */
export function availableFinancialYears(
  transactions: Transaction[],
  manualDeductions: ManualDeduction[],
): string[] {
  const set = new Set<string>();
  for (const t of transactions) {
    if (t.is_tax_deductible === true && t.date) set.add(financialYearOf(t.date));
  }
  for (const d of manualDeductions) {
    if (d.date) set.add(financialYearOf(d.date));
  }
  return [...set].sort().reverse();
}

// ─── The merged view ─────────────────────────────────────────────────────────

/**
 * Merge manual deductions + deductible transactions into one FY view, grouped by
 * category, with totals and back-links. A manual deduction linked to a
 * transaction suppresses that transaction's own line (no double counting).
 */
export function buildDeductionView(input: {
  transactions: Transaction[];
  manualDeductions: ManualDeduction[];
  fy: string;
}): DeductionView {
  const { transactions, manualDeductions, fy } = input;

  const manual = manualDeductionsForFY(manualDeductions, fy);
  const deductibleTx = deductibleTransactionsForFY(transactions, fy);

  // Any transaction claimed by a manual deduction's EXPLICIT link is already
  // represented by that manual line — it must not also be counted as its own line.
  const linkedTransactionIds = new Set<string>();
  for (const d of manual) {
    const link = d.source_transaction_id?.trim();
    if (link) linkedTransactionIds.add(link);
  }

  // Heuristic pass: match an unlinked manual deduction to a look-alike transaction
  // so an unlinked same-expense pair is counted once (not $24 for a $12 spend).
  // One-to-one and order-independent: both lists are sorted, and each transaction
  // can be claimed by at most one manual deduction. The transaction half is
  // flagged + excluded from totals but kept visible for review — never deleted.
  const manualByTx = new Map<string, string>(); // txId  → manualId (suspected dup)
  const txByManual = new Map<string, string>(); // manualId → txId
  const claimedTx = new Set<string>(linkedTransactionIds);
  const stableManual = manual.slice().sort(byDateThenId);
  const stableTx = deductibleTx.slice().sort(byDateThenId);
  for (const d of stableManual) {
    if (d.source_transaction_id?.trim()) continue; // resolved via an explicit link
    const dismissed = new Set(d.not_duplicate_of ?? []);
    for (const t of stableTx) {
      if (claimedTx.has(t.id) || dismissed.has(t.id)) continue;
      if (isLikelyDuplicate(d, t)) {
        manualByTx.set(t.id, d.id);
        txByManual.set(d.id, t.id);
        claimedTx.add(t.id);
        break;
      }
    }
  }

  const lines: DeductionLine[] = [];

  for (const d of manual) {
    const link = d.source_transaction_id?.trim() || null;
    const dupTx = txByManual.get(d.id) ?? null;
    lines.push({
      key: `m:${d.id}`,
      source: 'manual',
      id: d.id,
      name: d.name?.trim() || 'Deduction',
      amount: round2(Math.abs(d.amount) || 0),
      category: catOf(d.category),
      date: d.date,
      transactionId: link ?? dupTx,
      merchant: null,
      linked: !!link,
      suspectedDuplicate: !!dupTx,
      duplicateOf: dupTx,
      excluded: false, // the manual line is the one that counts
    });
  }

  for (const t of deductibleTx) {
    if (linkedTransactionIds.has(t.id)) continue; // deduped — an explicit link owns it
    const dupManualId = manualByTx.get(t.id) ?? null;
    lines.push({
      key: `t:${t.id}`,
      source: 'transaction',
      id: t.id,
      name: t.merchant?.trim() || 'Transaction',
      amount: round2(Math.abs(t.amount) || 0),
      category: catOf(t.deduction_category),
      date: t.date,
      transactionId: t.id,
      merchant: t.merchant ?? null,
      linked: false,
      suspectedDuplicate: !!dupManualId,
      duplicateOf: dupManualId,
      excluded: !!dupManualId, // suspected dup → flagged, kept visible, not counted
    });
  }

  // Group by category, newest line first within a group, biggest group first.
  const byCat = new Map<string, DeductionLine[]>();
  for (const ln of lines) {
    const arr = byCat.get(ln.category);
    if (arr) arr.push(ln);
    else byCat.set(ln.category, [ln]);
  }

  // Totals never count an `excluded` line (the transaction half of a suspected
  // duplicate) — but the line is still listed in its group for review.
  const sumCounted = (ls: DeductionLine[]) =>
    round2(ls.reduce((s, l) => s + (l.excluded ? 0 : l.amount), 0));

  const groups: DeductionGroup[] = [...byCat.entries()]
    .map(([category, ls]) => ({
      category,
      total: sumCounted(ls),
      lines: ls.slice().sort(byDateDesc),
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  const manualTotal = round2(manual.reduce((s, d) => s + (Math.abs(d.amount) || 0), 0));
  const total = sumCounted(lines);
  const transactionTotal = round2(total - manualTotal);

  const suspectedDuplicates: SuspectedDuplicate[] = [...txByManual.entries()].map(
    ([manualId, transactionId]) => {
      const d = manual.find(x => x.id === manualId)!;
      const t = deductibleTx.find(x => x.id === transactionId);
      return {
        manualId,
        transactionId,
        amount: round2(Math.abs(d.amount) || 0),
        name: d.name?.trim() || 'Deduction',
        category: catOf(d.category),
        merchant: t?.merchant ?? null,
        date: d.date,
      };
    },
  );

  return {
    fy,
    total,
    lineCount: lines.length,
    manualTotal,
    transactionTotal,
    groups,
    linkedTransactionIds: [...linkedTransactionIds],
    suspectedDuplicates,
  };
}

function byDateDesc(a: DeductionLine, b: DeductionLine): number {
  if (a.date === b.date) return a.name.localeCompare(b.name);
  return a.date < b.date ? 1 : -1;
}

// ─── Pure list mutators (deductionsDS persists these) ────────────────────────

export interface NewManualDeduction {
  name: string;
  amount: number;
  category: string;
  date: string;
  source_transaction_id?: string | null;
}

/** Append a manual deduction, returning a new list (id/created_at injected). */
export function addManualDeduction(
  list: ManualDeduction[],
  data: NewManualDeduction,
  meta: { id: string; now: string },
): ManualDeduction[] {
  const record: ManualDeduction = {
    id: meta.id,
    name: data.name,
    amount: data.amount,
    category: data.category,
    date: data.date,
    source_transaction_id: data.source_transaction_id?.trim() || null,
    created_at: meta.now,
  };
  return [...list, record];
}

/** Patch a manual deduction by id, returning a new list. Unknown id → unchanged. */
export function updateManualDeduction(
  list: ManualDeduction[],
  id: string,
  patch: Partial<NewManualDeduction>,
): ManualDeduction[] {
  return list.map(d => {
    if (d.id !== id) return d;
    const next: ManualDeduction = { ...d, ...patch };
    if ('source_transaction_id' in patch) {
      next.source_transaction_id = patch.source_transaction_id?.trim() || null;
    }
    return next;
  });
}

/** Remove a manual deduction by id, returning a new list. */
export function removeManualDeduction(list: ManualDeduction[], id: string): ManualDeduction[] {
  return list.filter(d => d.id !== id);
}

/**
 * Set or clear the transaction link on a manual deduction (pass null to remove
 * the link). This is the edit that toggles double-count protection on/off.
 */
export function setDeductionLink(
  list: ManualDeduction[],
  id: string,
  transactionId: string | null,
): ManualDeduction[] {
  return list.map(d =>
    d.id === id ? { ...d, source_transaction_id: transactionId?.trim() || null } : d,
  );
}

/**
 * Record that a manual deduction is NOT a duplicate of a transaction ("keep
 * both") — suppresses the heuristic detector for that one pair so both keep
 * counting. Idempotent; unknown id → unchanged. The inverse of confirming a link.
 */
export function dismissDuplicate(
  list: ManualDeduction[],
  id: string,
  transactionId: string,
): ManualDeduction[] {
  const txId = transactionId.trim();
  if (!txId) return list;
  return list.map(d => {
    if (d.id !== id) return d;
    const existing = d.not_duplicate_of ?? [];
    if (existing.includes(txId)) return d;
    return { ...d, not_duplicate_of: [...existing, txId] };
  });
}
