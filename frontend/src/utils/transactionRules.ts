/**
 * Phase 2B — Transaction rules engine.
 *
 * A user-owned, deterministic rules layer that stamps category / merchant / tags /
 * business-personal / tax / type onto a transaction when its conditions match.
 *
 * Hard guarantees (all enforced here, all unit-tested):
 *   • A rule NEVER applies to another user — callers pass the current userId and
 *     rules whose user_id differs are dropped before evaluation.
 *   • A disabled rule does nothing.
 *   • Higher `priority` wins; among equal priorities the most recently created
 *     rule wins. The single highest-priority MATCHING rule is applied.
 *   • Account-specific rules stay account-specific (a condition.account_id must
 *     equal the candidate's account).
 *
 * PURE — no store, no network.
 */

import type { RuleCondition, RuleAction, TransactionRule } from '../types';

/** The transaction fields a rule can test. */
export interface RuleCandidate {
  merchant_normalized: string;
  /** Raw description (or merchant) — matched case-insensitively for *_contains. */
  raw_description: string;
  merchant: string;
  account_id: string;
  amount: number;
  source: string;
}

/** True when EVERY present condition matches the candidate (absent = not tested). */
export function matchRule(cond: RuleCondition, c: RuleCandidate): boolean {
  if (cond.merchant_normalized !== undefined &&
      cond.merchant_normalized !== c.merchant_normalized) return false;

  if (cond.merchant_contains !== undefined) {
    const hay = `${c.merchant ?? ''} ${c.raw_description ?? ''}`.toUpperCase();
    if (!hay.includes(cond.merchant_contains.toUpperCase())) return false;
  }

  if (cond.description_contains !== undefined) {
    const hay = (c.raw_description ?? '').toUpperCase();
    if (!hay.includes(cond.description_contains.toUpperCase())) return false;
  }

  if (cond.account_id !== undefined && cond.account_id !== c.account_id) return false;

  const absAmount = Math.abs(c.amount);
  if (cond.amount_min !== undefined && absAmount < cond.amount_min) return false;
  if (cond.amount_max !== undefined && absAmount > cond.amount_max) return false;

  if (cond.direction !== undefined) {
    const dir = c.amount < 0 ? 'debit' : 'credit';
    if (cond.direction !== dir) return false;
  }

  if (cond.source !== undefined && cond.source !== c.source) return false;

  return true;
}

/**
 * Order enabled rules belonging to `userId` by precedence: priority DESC, then
 * newest first. Rules with a different user_id are never returned.
 */
export function orderedUserRules(rules: TransactionRule[], userId: string | null | undefined): TransactionRule[] {
  return rules
    .filter(r => r.enabled && (userId ? r.user_id === userId : false))
    .slice()
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      return bt - at;
    });
}

export interface RuleMatch {
  rule: TransactionRule;
  actions: RuleAction;
}

/**
 * Find the single highest-priority enabled rule (for this user) that matches the
 * candidate, and return its actions. Returns null when nothing matches.
 */
export function applyRules(
  candidate: RuleCandidate,
  rules: TransactionRule[],
  userId: string | null | undefined,
): RuleMatch | null {
  for (const rule of orderedUserRules(rules, userId)) {
    if (matchRule(rule.conditions, candidate)) {
      return { rule, actions: rule.actions };
    }
  }
  return null;
}
