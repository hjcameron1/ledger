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

/** Reactive list of all categories (built-in + custom) for use inside components. */
export function useAllCategories(base: string[] = BASE_TX_CATEGORIES): string[] {
  const custom = useStore(s => s.customCategories);
  return mergeCategories(custom.map(c => c.name), base);
}
