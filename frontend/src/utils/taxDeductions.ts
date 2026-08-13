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
  created_at?: string;
}

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
  /** True for a manual line that carries a transaction link. */
  linked: boolean;
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
  /** Transaction ids a manual deduction represents — dropped from tx lines. */
  linkedTransactionIds: string[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function catOf(c?: string | null): string {
  const t = (c ?? '').trim();
  return t === '' ? UNCATEGORISED_DEDUCTION : t;
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

  // Any transaction claimed by a manual deduction's link is already represented
  // by that manual line — it must not also be counted as its own tx line.
  const linkedTransactionIds = new Set<string>();
  for (const d of manual) {
    const link = d.source_transaction_id?.trim();
    if (link) linkedTransactionIds.add(link);
  }

  const lines: DeductionLine[] = [];

  for (const d of manual) {
    const link = d.source_transaction_id?.trim() || null;
    lines.push({
      key: `m:${d.id}`,
      source: 'manual',
      id: d.id,
      name: d.name?.trim() || 'Deduction',
      amount: round2(Math.abs(d.amount) || 0),
      category: catOf(d.category),
      date: d.date,
      transactionId: link,
      merchant: null,
      linked: !!link,
    });
  }

  for (const t of deductibleTransactionsForFY(transactions, fy)) {
    if (linkedTransactionIds.has(t.id)) continue; // deduped — a manual line owns it
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
    });
  }

  // Group by category, newest line first within a group, biggest group first.
  const byCat = new Map<string, DeductionLine[]>();
  for (const ln of lines) {
    const arr = byCat.get(ln.category);
    if (arr) arr.push(ln);
    else byCat.set(ln.category, [ln]);
  }

  const groups: DeductionGroup[] = [...byCat.entries()]
    .map(([category, ls]) => ({
      category,
      total: round2(ls.reduce((s, l) => s + l.amount, 0)),
      lines: ls.slice().sort(byDateDesc),
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  const manualTotal = round2(manual.reduce((s, d) => s + (Math.abs(d.amount) || 0), 0));
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  const transactionTotal = round2(total - manualTotal);

  return {
    fy,
    total,
    lineCount: lines.length,
    manualTotal,
    transactionTotal,
    groups,
    linkedTransactionIds: [...linkedTransactionIds],
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
