/**
 * Phase 2B — Learn-from-corrections planner (pure).
 *
 * Decides WHAT persistent artifacts a user correction should create, given a
 * scope. Kept pure and separate from dataService so the "one-off edit creates
 * nothing / future creates a rule+alias / existing also retro-applies" policy is
 * unit-testable without the store or network.
 *
 *   'only'     → change this transaction only. No rule, no alias.
 *   'future'   → also create a user rule (category) and/or alias (merchant).
 *   'existing' → everything 'future' does + retro-apply to matching rows.
 *
 * The learning is keyed on a CorrectionMatch, NOT on the one transaction:
 *   • 'contains'   — an UPPERCASE brand substring (e.g. "WOOLWORTHS") that matches
 *                    EVERY store/online variant of a recognised merchant. This is
 *                    what makes a correction apply to ALL of that merchant's
 *                    transactions rather than a single location-specific line.
 *   • 'normalized' — the exact normaliseMerchant() key; the narrow fallback used
 *                    only when the merchant isn't recognised.
 */

import type { RuleCondition, RuleAction } from '../types';

export type CorrectionScope = 'only' | 'future' | 'existing';

export interface CorrectionChanges {
  merchant?: string;
  category?: string;
}

/** How to match OTHER transactions that belong to the same merchant. */
export interface CorrectionMatch {
  type: 'normalized' | 'contains';
  pattern: string;
}

export interface CorrectionPlan {
  /** Create a user rule keyed on the merchant match. */
  rule?: { conditions: RuleCondition; actions: RuleAction; priority: number; label: string };
  /** Find-or-create a user merchant for the corrected display name. */
  merchant?: { display_name: string; merchant_normalized: string; default_category?: string };
  /** The alias that maps this merchant's descriptions → that user merchant. */
  alias?: { pattern: string; match_type: 'normalized' | 'contains' };
  /** Retro-apply to already-stored, non-user-set rows sharing the merchant. */
  applyToExisting: boolean;
  /** Echoes the match so the caller retro-applies to the SAME breadth. */
  match: CorrectionMatch;
}

/** Priority given to rules learned from a user correction (well above defaults). */
export const LEARNED_RULE_PRIORITY = 100;

export function planCorrection(
  match: CorrectionMatch,
  changes: CorrectionChanges,
  scope: CorrectionScope,
  opts: { merchantDefaultCategory?: string } = {},
): CorrectionPlan {
  const pattern = (match?.pattern ?? '').trim();
  const echo: CorrectionMatch = { type: match?.type ?? 'normalized', pattern };

  // A one-off edit never creates permanent artifacts.
  if (scope === 'only') return { applyToExisting: false, match: echo };

  const plan: CorrectionPlan = { applyToExisting: scope === 'existing', match: echo };

  // Can't key a rule/alias without something to match on.
  if (!pattern) return plan;

  const condition: RuleCondition = echo.type === 'contains'
    ? { merchant_contains: pattern }
    : { merchant_normalized: pattern };

  if (changes.category !== undefined) {
    plan.rule = {
      conditions: condition,
      actions: { category: changes.category },
      priority: LEARNED_RULE_PRIORITY,
      label: `${changes.merchant ?? pattern} → ${changes.category}`,
    };
  }

  if (changes.merchant !== undefined) {
    plan.merchant = {
      display_name: changes.merchant,
      // Storage key for the user merchant row; a contains-pattern collapses to a
      // clean brand slug ("WOOLWORTHS" → "woolworths").
      merchant_normalized: echo.type === 'contains' ? pattern.toLowerCase() : pattern,
      // Preserve categorisation: the user's new category, else the merchant's
      // recognised default — so a pure rename never strips an existing category.
      default_category: changes.category ?? opts.merchantDefaultCategory,
    };
    plan.alias = { pattern, match_type: echo.type };
  }

  return plan;
}
