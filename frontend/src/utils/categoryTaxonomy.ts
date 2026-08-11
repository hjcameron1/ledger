/**
 * Phase 2B — Canonical Ledger category taxonomy.
 *
 * Basiq (ANZSIC titles), the statement parser, and autoCategory() all emit
 * category strings in their OWN vocabularies. Left unchecked that sprays dozens
 * of near-duplicate category names ("Supermarket and grocery stores", "Food",
 * "Groceries", "GROCERY") across the app. This module maps every provider/parser
 * category into ONE canonical taxonomy so budgets, spend-by-category and rules
 * all agree.
 *
 * PURE — no store, no network — so it is unit-testable and reusable at ingest.
 *
 * IMPORTANT (non-destructive): this only NORMALISES an incoming category at
 * ingestion/mapping time. It never rewrites history and it never discards a
 * user's own custom category — a value that matches a user category (or is
 * already canonical) is returned unchanged.
 */

import { BASE_TX_CATEGORIES } from './categories';

/** The canonical taxonomy. Superset order-preserving; mirrors BASE_TX_CATEGORIES. */
export const LEDGER_CATEGORIES = BASE_TX_CATEGORIES;

export const UNCATEGORISED = 'Uncategorised';

// Canonical name keyed by its own lowercased form, so we can recover the exact
// canonical casing from any-case input ("groceries" → "Groceries").
const CANONICAL_BY_LOWER = new Map<string, string>(
  LEDGER_CATEGORIES.map(c => [c.toLowerCase(), c]),
);

/**
 * Explicit provider/parser → canonical mappings. Keys are lowercased. Covers the
 * statement-parser option lists (pdfParser/claudeService) and common Basiq ANZSIC
 * titles. Anything not found here falls through to keyword inference, then to the
 * value itself (if already canonical), then Uncategorised.
 */
const EXPLICIT_MAP: Record<string, string> = {
  // ── Groceries ──
  'groceries': 'Groceries',
  'grocery': 'Groceries',
  'supermarket': 'Groceries',
  'supermarkets': 'Groceries',
  'supermarket and grocery stores': 'Groceries',
  'supermarkets and grocery stores': 'Groceries',
  // ── Dining ──
  'dining': 'Dining',
  'restaurant': 'Dining',
  'restaurants': 'Dining',
  'cafes and restaurants': 'Dining',
  'takeaway food services': 'Dining',
  'takeaway': 'Dining',
  'food and drink': 'Dining',
  'food': 'Food',
  'eating out': 'Dining',
  // ── Transport / Fuel / Travel ──
  'transport': 'Transport',
  'transportation': 'Transport',
  'public transport': 'Transport',
  'taxi': 'Transport',
  'taxi and other road transport': 'Transport',
  'ride share': 'Transport',
  'automotive fuel retailing': 'Fuel',
  'fuel': 'Fuel',
  'petrol': 'Fuel',
  'travel': 'Travel',
  'travel agency and tour arrangement services': 'Travel',
  'air and space transport': 'Travel',
  'accommodation': 'Travel',
  'hotels': 'Travel',
  // ── Bills / Utilities / Telco / Rent ──
  'bills': 'Bills',
  'utilities': 'Utilities',
  'electricity': 'Utilities',
  'gas': 'Utilities',
  'water': 'Utilities',
  'electricity supply': 'Utilities',
  'water supply, sewerage and drainage services': 'Utilities',
  'telecommunications': 'Telecommunications',
  'telecommunication': 'Telecommunications',
  'telco': 'Telecommunications',
  'internet service providers': 'Telecommunications',
  'rent': 'Rent',
  'lease': 'Rent',
  'residential property operators': 'Rent',
  // ── Shopping / Electronics ──
  'shopping': 'Shopping',
  'retail': 'Shopping',
  'clothing retailing': 'Shopping',
  'department stores': 'Shopping',
  'online shopping': 'Shopping',
  'electronics': 'Electronics',
  'electronic': 'Electronics',
  'computer and computer peripheral retailing': 'Electronics',
  'software': 'Electronics',
  // ── Entertainment ──
  'entertainment': 'Entertainment',
  'streaming': 'Entertainment',
  'news': 'Entertainment',
  'gambling': 'Entertainment',
  'motion picture and video activities': 'Entertainment',
  // ── Health / Fitness ──
  'health': 'Health',
  'healthcare': 'Health',
  'medical': 'Health',
  'pharmaceutical, cosmetic and toiletry goods retailing': 'Health',
  'pharmacy': 'Health',
  'fitness': 'Fitness',
  'gym': 'Fitness',
  'health and fitness centres and gymnasia operation': 'Fitness',
  // ── Insurance ──
  'insurance': 'Insurance',
  'health insurance': 'Insurance',
  'general insurance': 'Insurance',
  // ── Income / Transfer / Dividends ──
  'income': 'Income',
  'salary': 'Income',
  'wages': 'Income',
  'transfer': 'Transfer',
  'transfers': 'Transfer',
  'dividend': 'Dividends',
  'dividends': 'Dividends',
  // ── Fallbacks ──
  'other': 'Other',
  'uncategorized': UNCATEGORISED,
  'uncategorised': UNCATEGORISED,
  'miscellaneous': 'Other',
};

// Keyword → canonical, used when neither the explicit map nor a custom/canonical
// exact match applies. Ordered: first hit wins.
const KEYWORD_RULES: [string[], string][] = [
  [['grocer', 'supermarket'], 'Groceries'],
  [['restaurant', 'cafe', 'dining', 'takeaway', 'coffee'], 'Dining'],
  [['fuel', 'petrol'], 'Fuel'],
  [['transport', 'taxi', 'rideshare'], 'Transport'],
  [['flight', 'airline', 'hotel', 'travel', 'accommodation'], 'Travel'],
  [['pharmac', 'medical', 'health', 'doctor', 'dental'], 'Health'],
  [['gym', 'fitness'], 'Fitness'],
  [['insurance'], 'Insurance'],
  [['electric', 'water', 'utilit', 'energy'], 'Utilities'],
  [['internet', 'mobile', 'telecom', 'phone'], 'Telecommunications'],
  [['rent', 'lease'], 'Rent'],
  [['software', 'computer', 'electronic'], 'Electronics'],
  [['entertain', 'stream', 'movie', 'cinema', 'gaming'], 'Entertainment'],
  [['dividend'], 'Dividends'],
  [['salary', 'wage', 'payroll', 'income'], 'Income'],
  [['transfer'], 'Transfer'],
  [['shopping', 'retail', 'clothing'], 'Shopping'],
];

/**
 * Map any incoming category string into the canonical Ledger taxonomy.
 *
 * Priority:
 *   1. Empty/nullish            → Uncategorised
 *   2. A user CUSTOM category   → returned unchanged (never remapped)
 *   3. An already-canonical name→ canonical casing
 *   4. Explicit provider map    → canonical
 *   5. Keyword inference        → canonical
 *   6. Fallback                 → Uncategorised
 */
export function normaliseCategory(
  raw: string | null | undefined,
  opts: { customCategories?: string[] } = {},
): string {
  const value = (raw ?? '').trim();
  if (!value) return UNCATEGORISED;

  const lower = value.toLowerCase();

  // 2. Preserve a user's own custom category verbatim.
  const custom = opts.customCategories?.find(c => c.trim().toLowerCase() === lower);
  if (custom) return custom;

  // 3. Already canonical → normalise casing only.
  const canonical = CANONICAL_BY_LOWER.get(lower);
  if (canonical) return canonical;

  // 4. Explicit provider/parser mapping.
  if (EXPLICIT_MAP[lower]) return EXPLICIT_MAP[lower];

  // 5. Keyword inference.
  for (const [keywords, cat] of KEYWORD_RULES) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }

  // 6. Unknown provider category → Uncategorised (do NOT invent a new name).
  return UNCATEGORISED;
}

/** True when a category string is (case-insensitively) one of the canonical names. */
export function isCanonicalCategory(name: string): boolean {
  return CANONICAL_BY_LOWER.has((name ?? '').trim().toLowerCase());
}
