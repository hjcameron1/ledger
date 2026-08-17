/**
 * What a category is holding up, and what happens if it goes.
 *
 * A category name is a soft foreign key: budgets, rules, transactions and split
 * lines all reference it as a plain string. Deleting the row without dealing
 * with those references does not remove the category — it strands it. The
 * budget keeps its cap on a name that exists nowhere, the rule keeps stamping
 * it onto new transactions, and (worst) `reconcile()` sees a budget on an
 * unregistered category on the next load and helpfully recreates the row the
 * user just deleted.
 *
 * So deletion is planned before it is performed: this module counts the
 * references and works out the exact edits, as pure functions over plain data,
 * so both the confirmation the user reads and the writes that follow come from
 * the same source.
 */

import type { Budget, RuleAction, Transaction, TransactionRule, TransactionSplit } from '../types';
import { sameCategory, tidyCategoryName } from './categoryResolve';
import { isCanonicalCategory } from './categoryTaxonomy';

export interface CategoryUsage {
  budgets: number;
  rules: number;
  transactions: number;
  /** Split lines filed under it — part of a transaction, counted separately. */
  splits: number;
}

export interface UsageSources {
  budgets: Budget[];
  rules: TransactionRule[];
  transactions: Transaction[];
  splits?: TransactionSplit[];
}

/**
 * How much of the app currently points at this category.
 *
 * Everything is matched by IDENTITY, not by string equality: a budget on
 * "groceries" is using Groceries, and telling the user otherwise would make the
 * confirmation dialog a lie at exactly the moment they are trusting it.
 *
 * Only ACTIVE budgets count. A retired one is already invisible to the user, so
 * including it would inflate the number they are being asked to weigh.
 */
export function countCategoryUsage(name: string, sources: UsageSources): CategoryUsage {
  const target = tidyCategoryName(name);
  if (!target) return { budgets: 0, rules: 0, transactions: 0, splits: 0 };

  return {
    budgets: sources.budgets.filter(
      b => b.active !== false && b.scope !== 'overall' && sameCategory(b.category, target),
    ).length,
    rules: sources.rules.filter(r => sameCategory(r.actions?.category, target)).length,
    transactions: sources.transactions.filter(t => sameCategory(t.category, target)).length,
    splits: (sources.splits ?? []).filter(s => sameCategory(s.category, target)).length,
  };
}

/** True when anything at all references the category. */
export function isCategoryInUse(usage: CategoryUsage): boolean {
  return usage.budgets + usage.rules + usage.transactions + usage.splits > 0;
}

/**
 * Why a category cannot be deleted, or null if it can be.
 *
 * Built-ins are permanent. They are the shared vocabulary every import, rule
 * and provider mapping resolves into (see `categoryTaxonomy`), so removing one
 * would not remove the category — the next Basiq sync would simply reintroduce
 * it, and meanwhile the user's own rows would be the only casualty. Switching
 * it off in Settings is the supported way to stop seeing it.
 */
export function undeletableReason(name: string, customNames: string[]): string | null {
  const target = tidyCategoryName(name);
  if (!target) return 'That category no longer exists.';
  if (isCanonicalCategory(target)) {
    return 'Built-in categories can’t be deleted — un-tick it above to stop it appearing.';
  }
  if (!customNames.some(c => sameCategory(c, target))) {
    return 'Only categories you created can be deleted.';
  }
  return null;
}

// ─── Planning the delete ─────────────────────────────────────────────────────

/**
 * What a rule's actions become when the category it stamps is going away.
 *
 * `reassignTo` re-points it; otherwise the category action is dropped. A rule
 * left with NOTHING to do is disabled rather than deleted — the conditions the
 * user wrote are worth keeping, and an inert rule they can re-point later is
 * kinder than a rule that silently vanished with their category.
 */
export function rewriteRuleActions(
  actions: RuleAction, reassignTo: string | null,
): { actions: RuleAction; disable: boolean } {
  const next: RuleAction = { ...actions };
  if (reassignTo) {
    next.category = tidyCategoryName(reassignTo);
    return { actions: next, disable: false };
  }
  delete next.category;
  const doesSomething = Object.values(next).some(
    v => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0),
  );
  return { actions: next, disable: !doesSomething };
}

export interface CategoryDeletionPlan {
  /** The category being removed, in its stored spelling. */
  name: string;
  /** Where its transactions land: a category name, or null for Uncategorised. */
  reassignTo: string | null;
  usage: CategoryUsage;
  /** Active budgets to retire (reassignTo === null) or re-point. */
  budgetIds: string[];
  ruleEdits: { id: string; actions: RuleAction; disable: boolean }[];
  transactionIds: string[];
  /** Parent transaction ids whose split lines mention the category. */
  splitParentIds: string[];
}

/**
 * Everything deletion will touch, decided up front.
 *
 * Budgets are the reason this is a plan rather than three loops: a budget on a
 * category that no longer exists is not harmless. Left active it re-registers
 * the category on the next bootstrap (`reconcile()` pass 3), undoing the
 * delete; so it is retired when the category is simply removed, and moved when
 * the user chose somewhere for it to go.
 */
export function planCategoryDeletion(
  name: string,
  sources: UsageSources,
  opts: { reassignTo?: string | null } = {},
): CategoryDeletionPlan {
  const target = tidyCategoryName(name);
  const reassignRaw = tidyCategoryName(opts.reassignTo ?? '');
  // Reassigning to itself is not a reassignment; treat it as a plain delete
  // rather than generating a no-op rename of every transaction.
  const reassignTo = reassignRaw && !sameCategory(reassignRaw, target) ? reassignRaw : null;

  const usage = countCategoryUsage(target, sources);

  return {
    name: target,
    reassignTo,
    usage,
    budgetIds: sources.budgets
      .filter(b => b.active !== false && b.scope !== 'overall' && sameCategory(b.category, target))
      .map(b => b.id),
    ruleEdits: sources.rules
      .filter(r => sameCategory(r.actions?.category, target))
      .map(r => ({ id: r.id, ...rewriteRuleActions(r.actions ?? {}, reassignTo) })),
    transactionIds: sources.transactions
      .filter(t => sameCategory(t.category, target))
      .map(t => t.id),
    splitParentIds: Array.from(new Set(
      (sources.splits ?? [])
        .filter(s => sameCategory(s.category, target))
        .map(s => s.transaction_id),
    )),
  };
}
