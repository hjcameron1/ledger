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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
