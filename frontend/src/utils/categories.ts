import { useMemo } from 'react';
import { useStore } from '../store';
import { categoryKey } from './categoryResolve';
import { LEDGER_CATEGORIES } from './categoryTaxonomy';

// The built-in transaction categories. User-created categories (from the budget
// builder) are merged on top of these so they appear everywhere a category can
// be picked — transactions, bills, and the budget itself.
//
// Defined in `categoryTaxonomy` and re-exported here under its long-standing
// name: the taxonomy sits below everything else in the import graph, so nothing
// it needs can depend on this module (see LEDGER_CATEGORIES for the cycle that
// caused).
export const BASE_TX_CATEGORIES = LEDGER_CATEGORIES;

/**
 * De-dupe a list of category names by IDENTITY, keeping the first spelling seen.
 *
 * Built-ins are always pushed first, so the canonical spelling wins over a stray
 * "groceries" row that predates normalisation — one name, everywhere.
 */
function dedupeByIdentity(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? '').trim();
    const key = categoryKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Base categories + any user-created ones, de-duped by identity, order
 * preserved. Built-ins come first, so the canonical spelling always wins.
 *
 * The custom list is de-duped against ITSELF as well as against the base — it
 * arrives from several places at once (category rows, budget categories) and
 * commonly contains the same category twice under two spellings.
 */
export function mergeCategories(custom: string[], base: string[] = BASE_TX_CATEGORIES): string[] {
  return dedupeByIdentity([...base, ...custom]);
}


/**
 * Every category the user has committed to by putting a LIVE BUDGET on it.
 *
 * That is the strongest commitment there is — a monthly cap, with the
 * expectation that spending lands in it — so these names are never filtered out
 * of the pickable list, whatever Settings says (see `useAllCategories`).
 *
 * The retired Phase 4.1 planner (`budget_lines`) is deliberately NOT counted.
 * Its rows still put their names in the category MENU for back-compat, but a
 * goal from a system that no longer runs is not a commitment and must not
 * override the user's own choice of which categories to show.
 */
export function useCommittedCategories(): string[] {
  const budgets = useStore(s => s.budgets);

  return useMemo(() => dedupeByIdentity(
    budgets
      .filter(b => b.active !== false && b.scope !== 'overall')
      .map(b => (b.category ?? '').trim()),
  ), [budgets]);
}

/** Every category that COULD be picked: built-ins first (in order), then every
 *  category the user has defined (custom + budget + legacy planner goals),
 *  de-duped by identity. This is the full menu shown in Settings — the allowlist
 *  is chosen from it. */
export function useCategoryUniverse(base: string[] = BASE_TX_CATEGORIES): string[] {
  const custom = useStore(s => s.customCategories);
  const committed = useCommittedCategories();
  // Retired planner goals: in the menu so an existing user's names don't vanish,
  // never written to again, and never treated as a live commitment.
  const budgetLines = useStore(s => s.budgetLines);

  return useMemo(
    () => dedupeByIdentity([
      ...base,
      ...custom.map(c => c.name),
      ...committed,
      ...budgetLines.filter(l => l.is_category_budget).map(l => (l.name ?? '').trim()),
    ]),
    [base, custom, committed, budgetLines],
  );
}

/**
 * Reactive list of pickable categories used EVERYWHERE a category is chosen —
 * transaction rows, splits, bills, rules and the budget editor all read this
 * one function, so there is no second list to drift out of step.
 *
 * Once the user has saved a selection in Settings, only those categories show…
 * with one exception that makes this a single source of truth rather than two:
 * a category with an ACTIVE BUDGET is always offered. Without that exception a
 * budget could exist for Groceries while Groceries was unpickable on a
 * transaction — the cap would sit at $0 spent forever and the user would have no
 * way to file anything into it. Settings chooses the menu; a budget overrides
 * the choice for as long as it exists.
 */
export function useAllCategories(base: string[] = BASE_TX_CATEGORIES): string[] {
  const universe = useCategoryUniverse(base);
  const committed = useCommittedCategories();
  const custom = useStore(s => s.customCategories);
  const selected = useStore(s => s.selectedCategories);
  const hidden = useStore(s => s.hiddenCategories);

  return useMemo(
    () => pickableCategories({
      universe, committed, custom: custom.map(c => c.name), selected, hidden,
    }),
    [universe, committed, custom, selected, hidden],
  );
}

export interface PickableInput {
  /** Everything that exists, built-ins first (see useCategoryUniverse). */
  universe: string[];
  /** Categories the user has committed to by budgeting them. */
  committed: string[];
  /** The user's own category rows. */
  custom: string[];
  /** The Settings allowlist, or null if the user has never chosen. */
  selected: string[] | null;
  /** Legacy per-category blocklist, used only before an allowlist exists. */
  hidden: string[];
}

/**
 * The pickable-category rule, as a pure function — this repo has no DOM test
 * harness, and this is the rule the reported bug lived in.
 */
export function pickableCategories(input: PickableInput): string[] {
  const alwaysOn = new Set(input.committed.map(categoryKey));

  // Explicit allowlist wins once the user has saved one (even an empty one) —
  // except over a live budget, which cannot be un-chosen while it exists.
  if (input.selected) {
    const sel = new Set(input.selected.map(categoryKey));
    return input.universe.filter(c => {
      const k = categoryKey(c);
      return sel.has(k) || alwaysOn.has(k);
    });
  }

  // Legacy default: all, minus switched-off built-ins, but keep every category
  // the user defined or committed to.
  const userSet = new Set([...input.custom, ...input.committed].map(categoryKey));
  const hiddenSet = new Set(input.hidden.map(categoryKey));
  return input.universe.filter(c => {
    const k = categoryKey(c);
    return userSet.has(k) || !hiddenSet.has(k);
  });
}
