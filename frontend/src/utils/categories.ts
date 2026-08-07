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

/** Reactive list of pickable categories: the built-ins the user hasn't switched
 *  off, plus EVERY category the user has defined — both their custom categories
 *  and their budget categories. User-defined names always show, even when a
 *  same-named built-in is switched off, so hiding built-in "Health" never hides a
 *  "Health" the user made their own or budgets for. */
export function useAllCategories(base: string[] = BASE_TX_CATEGORIES): string[] {
  const custom = useStore(s => s.customCategories);
  const budgetLines = useStore(s => s.budgetLines);
  const hidden = useStore(s => s.hiddenCategories);

  const userNames = [
    ...custom.map(c => c.name),
    ...budgetLines.filter(l => l.is_category_budget).map(l => l.name),
  ].map(n => (n ?? '').trim()).filter(Boolean);

  const userSet = new Set(userNames.map(n => n.toLowerCase()));
  const hiddenSet = new Set(hidden.map(h => h.toLowerCase()));

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name.trim());
  };

  // Built-ins first (preserve their order), skipping ones switched off — unless
  // the user has re-declared that name as their own category.
  for (const b of base) {
    if (hiddenSet.has(b.toLowerCase()) && !userSet.has(b.toLowerCase())) continue;
    push(b);
  }
  // Then everything the user defined (custom + budget), always included.
  for (const n of userNames) push(n);
  return out;
}
