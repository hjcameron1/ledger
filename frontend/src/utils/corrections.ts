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
 */

import type { RuleCondition, RuleAction } from '../types';

export type CorrectionScope = 'only' | 'future' | 'existing';

export interface CorrectionChanges {
  merchant?: string;
  category?: string;
}

export interface CorrectionPlan {
  /** Create a user rule keyed on the normalised merchant. */
  rule?: { conditions: RuleCondition; actions: RuleAction; priority: number; label: string };
  /** Find-or-create a user merchant + alias for the corrected display name. */
  merchant?: { display_name: string; merchant_normalized: string; default_category?: string };
  /** Retro-apply to already-stored, non-user-set rows sharing the merchant key. */
  applyToExisting: boolean;
}

/** Priority given to rules learned from a user correction (well above the default 100 baseline... == 100). */
export const LEARNED_RULE_PRIORITY = 100;

export function planCorrection(
  merchantNormalized: string,
  changes: CorrectionChanges,
  scope: CorrectionScope,
): CorrectionPlan {
  // A one-off edit never creates permanent artifacts.
  if (scope === 'only') return { applyToExisting: false };

  // Can't key a rule/alias without a normalised merchant.
  const norm = (merchantNormalized ?? '').trim();
  if (!norm) return { applyToExisting: scope === 'existing' };

  const plan: CorrectionPlan = { applyToExisting: scope === 'existing' };

  if (changes.category !== undefined) {
    plan.rule = {
      conditions: { merchant_normalized: norm },
      actions: { category: changes.category },
      priority: LEARNED_RULE_PRIORITY,
      label: `${changes.merchant ?? norm} → ${changes.category}`,
    };
  }

  if (changes.merchant !== undefined) {
    plan.merchant = {
      display_name: changes.merchant,
      merchant_normalized: norm,
      default_category: changes.category,
    };
  }

  return plan;
}
