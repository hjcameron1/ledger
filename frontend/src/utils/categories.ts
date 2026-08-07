import { useStore } from '../store';

// The built-in transaction categories. User-created categories (from the budget
// builder) are merged on top of these so they appear everywhere a category can
// be picked — transactions, bills, and the budget itself.
export const BASE_TX_CATEGORIES = [
  'Food', 'Transport', 'Shopping', 'Bills', 'Entertainment',
  'Health', 'Income', 'Transfer', 'Other',
  'Groceries', 'Dining', 'Fuel', 'Travel', 'Fitness',
  'Electronics', 'Insurance', 'Utilities', 'Rent', 'Telecommunications', 'Dividends',
];

/** Base categories + any user-created ones, de-duped (case-insensitive), order preserved. */
export function mergeCategories(custom: string[], base: string[] = BASE_TX_CATEGORIES): string[] {
  const seen = new Set(base.map(c => c.toLowerCase()));
  const extra = custom.filter(c => c && !seen.has(c.toLowerCase()));
  return [...base, ...extra];
}

/** Every category that COULD be picked: built-ins first (in order), then every
 *  category the user has defined (custom + budget), deduped case-insensitively.
 *  This is the full menu shown in Settings — the allowlist is chosen from it. */
export function useCategoryUniverse(base: string[] = BASE_TX_CATEGORIES): string[] {
  const custom = useStore(s => s.customCategories);
  const budgetLines = useStore(s => s.budgetLines);

  const userNames = [
    ...custom.map(c => c.name),
    ...budgetLines.filter(l => l.is_category_budget).map(l => l.name),
  ].map(n => (n ?? '').trim()).filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name.trim());
  };
  for (const b of base) push(b);
  for (const n of userNames) push(n);
  return out;
}

/** Reactive list of pickable categories used everywhere a category is chosen.
 *  Once the user has saved a selection in Settings, ONLY those categories show.
 *  Before any selection exists, falls back to the legacy behaviour (everything,
 *  minus built-ins the user switched off, but never a user-defined category). */
export function useAllCategories(base: string[] = BASE_TX_CATEGORIES): string[] {
  const universe = useCategoryUniverse(base);
  const custom = useStore(s => s.customCategories);
  const budgetLines = useStore(s => s.budgetLines);
  const selected = useStore(s => s.selectedCategories);
  const hidden = useStore(s => s.hiddenCategories);

  // Explicit allowlist wins once the user has saved one (even an empty one).
  if (selected) {
    const sel = new Set(selected.map(s => s.toLowerCase()));
    return universe.filter(c => sel.has(c.toLowerCase()));
  }

  // Legacy default: all, minus switched-off built-ins, but keep user categories.
  const userSet = new Set(
    [...custom.map(c => c.name), ...budgetLines.filter(l => l.is_category_budget).map(l => l.name)]
      .map(n => (n ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const hiddenSet = new Set(hidden.map(h => h.toLowerCase()));
  return universe.filter(c => {
    const k = c.toLowerCase();
    return userSet.has(k) || !hiddenSet.has(k);
  });
}
