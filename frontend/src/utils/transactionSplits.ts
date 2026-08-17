/**
 * Phase 2C — Split transactions (pure core).
 *
 * A split divides ONE bank transaction across multiple categories. The parent
 * bank row is never mutated or duplicated; these lines simply REPLACE the
 * parent's single category in reporting/budgets (see transactionCore's
 * splits-aware spendByCategory). The invariant that makes "no double-counting"
 * true is that split amounts sum to exactly the parent magnitude — so the total
 * spend is identical whether or not a transaction is split.
 *
 * Amounts are stored as POSITIVE magnitudes (the example Costco -$250 splits into
 * Groceries $140 + Household $70 + Work $40, summing to $250 = |parent|). This
 * module is PURE — no store, no network — so the sum rule is unit-testable.
 */

import type { TransactionSplit } from '../types';

/** Cent-precision equality so float drift ($0.005) never fails a valid split. */
const EPS = 0.005;

export interface SplitLineInput {
  category: string;
  amount: number;
  notes?: string | null;
  tags?: string[] | null;
}

export interface SplitValidation {
  ok: boolean;
  /** Sum of the provided split amounts (absolute). */
  total: number;
  /** The magnitude the split must sum to (|parent amount|). */
  target: number;
  /** Signed shortfall/overage: target − total (0 when balanced). */
  remaining: number;
  error?:
    | 'no_lines'
    | 'empty_category'
    | 'nonpositive_amount'
    | 'sum_mismatch';
}

/** The magnitude a split must sum to — the parent transaction's absolute amount. */
export function splitTarget(parentAmount: number): number {
  return Math.abs(Number(parentAmount) || 0);
}

/**
 * Validate a proposed set of split lines against the parent amount. The core
 * rule (spec item 4): split amounts must sum to the original transaction amount.
 * Also rejects empty categories and non-positive amounts — a split line must be a
 * real, positive slice of the parent.
 */
export function validateSplits(lines: SplitLineInput[], parentAmount: number): SplitValidation {
  const target = splitTarget(parentAmount);
  const total = lines.reduce((s, l) => s + Math.abs(Number(l.amount) || 0), 0);
  const base: Omit<SplitValidation, 'ok' | 'error'> = {
    total: round2(total),
    target: round2(target),
    remaining: round2(target - total),
  };
  if (lines.length === 0) return { ...base, ok: false, error: 'no_lines' };
  if (lines.some(l => !(l.category ?? '').trim())) return { ...base, ok: false, error: 'empty_category' };
  if (lines.some(l => !(Number(l.amount) > 0))) return { ...base, ok: false, error: 'nonpositive_amount' };
  if (Math.abs(target - total) > EPS) return { ...base, ok: false, error: 'sum_mismatch' };
  return { ...base, ok: true };
}

/** True when a set of split lines is a valid split of the parent. */
export function splitsAreValid(lines: SplitLineInput[], parentAmount: number): boolean {
  return validateSplits(lines, parentAmount).ok;
}

/**
 * The per-category spend contribution of a split transaction. Returns positive
 * magnitudes keyed by category, summing to |parent amount| — this is what
 * spendByCategory adds INSTEAD of the parent's single category, so a split
 * transaction is counted once, distributed across its lines.
 *
 * Lines that don't sum to the parent are used as-is (the UI blocks saving an
 * invalid split; reporting stays truthful to whatever is stored rather than
 * silently rescaling).
 */
export function splitCategoryAmounts(lines: Pick<TransactionSplit, 'category' | 'amount'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    const amt = Math.abs(Number(l.amount) || 0);
    if (amt <= 0) continue;
    const cat = (l.category || 'Uncategorised').trim() || 'Uncategorised';
    out[cat] = (out[cat] ?? 0) + amt;
  }
  return out;
}

// ─── What a split transaction is actually FILED AS ───────────────────────────
//
// A split transaction has two category stories: the parent's own `category`
// column, and the lines that replace it in every report. Budgets, the forecast
// and the category breakdown all read the LINES (see spendByCategory above), so
// the parent column is a dormant fallback — what the transaction reverts to if
// the split is ever removed. Showing that column on a split row is therefore a
// lie the moment the two disagree, which is exactly what happens when someone
// re-files a split transaction from the category chip.
//
// Everything below exists so one function answers "what is this filed as?" for
// both the screen and the report. It is pure and amount-driven: the headline is
// the category holding the LARGEST slice, because that is where most of the
// money is counted.

/** How a transaction's category should READ, given its split lines (if any). */
export interface SplitDisplay {
  /** The category to show as the headline — the largest slice when split. */
  label: string;
  /** True when split lines exist and therefore decide the reporting. */
  isSplit: boolean;
  /** Distinct categories the money is filed under, largest slice first. */
  categories: string[];
  /** How many categories are hidden behind the headline (0 when not split). */
  extra: number;
}

/**
 * What a transaction is filed as, for display — guaranteed to name a category
 * the reports actually count it under.
 *
 * Unsplit: the parent's own category (or 'Uncategorised'). Split: the biggest
 * line's category, plus how many others share the transaction. Ties break
 * alphabetically so the headline never flickers between equal slices.
 */
export function splitDisplay(
  parentCategory: string | null | undefined,
  lines: Pick<TransactionSplit, 'category' | 'amount'>[],
): SplitDisplay {
  const fallback = (parentCategory ?? '').trim() || 'Uncategorised';
  const byCat = splitCategoryAmounts(lines ?? []);
  const categories = Object.keys(byCat).sort((a, b) => {
    const d = byCat[b] - byCat[a];
    return Math.abs(d) > EPS ? d : a.localeCompare(b);
  });
  if (categories.length === 0) {
    return { label: fallback, isSplit: false, categories: [fallback], extra: 0 };
  }
  return {
    label: categories[0],
    isSplit: true,
    categories,
    extra: categories.length - 1,
  };
}

/**
 * The user's answer when they re-file a transaction that is already split:
 *
 *   'replace' — the new category takes over; the split lines are removed.
 *   'keep'    — the split still decides the reporting; the new category becomes
 *               the parent's (dormant) fallback and teaches the chosen scope.
 *   'edit'    — neither yet; open the split editor and divide it by hand.
 */
export type SplitCategoryChoice = 'replace' | 'keep' | 'edit';

/**
 * Does re-filing this transaction to `newCategory` need the user to decide what
 * happens to its split?
 *
 * Only when a split exists AND it disagrees with the new category. A split that
 * is already wholly that one category says the same thing the new category
 * does, so there is nothing to ask about.
 */
export function needsSplitDecision(
  lines: Pick<TransactionSplit, 'category' | 'amount'>[],
  newCategory: string,
): boolean {
  const cats = splitDisplay(null, lines ?? []);
  if (!cats.isSplit) return false;
  const target = (newCategory ?? '').trim().toLowerCase();
  return !(cats.categories.length === 1 && cats.categories[0].trim().toLowerCase() === target);
}

/**
 * How much of a split transaction a given category is charged — the figure a
 * budget counted, as opposed to the amount that left the account. 0 when the
 * split doesn't touch that category; null when the transaction isn't split (the
 * caller should use the transaction's own amount).
 */
export function splitContribution(
  lines: Pick<TransactionSplit, 'category' | 'amount'>[],
  category: string,
): number | null {
  if (!lines || lines.length === 0) return null;
  const byCat = splitCategoryAmounts(lines);
  const key = (category ?? '').trim().toLowerCase();
  for (const cat in byCat) {
    if (cat.trim().toLowerCase() === key) return round2(byCat[cat]);
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
