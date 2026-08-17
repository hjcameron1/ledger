/**
 * Category IDENTITY — deciding when two category names mean the same thing.
 *
 * Ledger has one category taxonomy (`categoryTaxonomy.ts`) and one place user
 * categories live (`custom_categories`). What was missing is the step between a
 * user TYPING a name and that name becoming a category: without it the same
 * category arrives under a dozen spellings —
 *
 *     Groceries · groceries · GROCERIES · " Groceries " · Groceries! · grocuries
 *
 * — and each one gets its own row, its own budget, and its own slice of spend.
 *
 * Two tiers, deliberately separated:
 *
 *   DETERMINISTIC (applied silently, because it is not a guess)
 *     case, whitespace, punctuation, accents, and the taxonomy's own curated
 *     alias table ('grocery' → 'Groceries'). Same name, different spelling.
 *
 *   FUZZY (never applied silently, because it IS a guess)
 *     close misspellings and abbreviations. These produce a SUGGESTION the user
 *     confirms — "Did you mean Groceries?" — and a genuinely new category is
 *     always keepable. When two candidates are equally close the answer is
 *     `ambiguous` and nothing is proposed at all: silently folding "Trans" into
 *     Transport when the user meant Transfer would corrupt their history in a
 *     way that is very hard to notice and harder to undo.
 *
 * PURE — no store, no React — so every rule below is unit-tested directly.
 */

import { explicitAlias } from './categoryTaxonomy';

// ─── The deterministic key ───────────────────────────────────────────────────

/**
 * The identity of a category name: everything that is pure spelling is stripped,
 * so anything that differs only in case, spacing, punctuation or accents lands
 * on the same key.
 *
 *   "Groceries" · "groceries" · " GROCERIES " · "Groceries!" → "groceries"
 *   "Health & Fitness" · "Health and fitness"                → "healthandfitness"
 *   "Eating out" · "Eating-out" · "eatingout"                → "eatingout"
 *
 * Whitespace is removed rather than collapsed on purpose: "Pet supplies" and
 * "Petsupplies" are the same category to a human, and treating them as two is
 * exactly the duplication this exists to stop.
 */
export function categoryKey(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents: "Café" → "Cafe"
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/** Tidy a name for DISPLAY without changing what the user chose to call it. */
export function tidyCategoryName(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ');
}

/** Do two names refer to the same category, ignoring spelling-only differences? */
export function sameCategory(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = categoryKey(a);
  return !!ka && ka === categoryKey(b);
}

// ─── Edit distance ───────────────────────────────────────────────────────────

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * The bound is what makes this safe to run against every known category on
 * every keystroke-completing action: a row whose best cell already exceeds the
 * budget can never recover, so the whole comparison stops there.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowBest = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowBest) rowBest = curr[j];
    }
    if (rowBest > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * How wrong a name is allowed to be before we stop guessing, by length.
 *
 * Short names carry almost no redundancy — "Gas" and "Car" are one edit apart
 * and completely unrelated — so they get no fuzzy matching at all. Longer names
 * can absorb a typo or two without becoming a different word.
 */
export function allowedDistance(length: number): number {
  if (length < 4) return 0;
  if (length < 6) return 1;
  return 2;
}

/** The shortest abbreviation we will try to expand. "Gro" is anyone's guess. */
export const MIN_PREFIX_LENGTH = 4;

// ─── Resolution ──────────────────────────────────────────────────────────────

export type CategoryResolution =
  /** Spelling-only difference from a category that already exists. Safe. */
  | { status: 'exact'; canonical: string; input: string }
  /** The taxonomy's own curated alias, e.g. "grocery" → "Groceries". Safe. */
  | { status: 'alias'; canonical: string; input: string }
  /** A close miss. NOT applied without the user saying yes. */
  | { status: 'suggestion'; canonical: string; input: string; distance: number }
  /** Equally close to several categories — propose nothing, merge nothing. */
  | { status: 'ambiguous'; candidates: string[]; input: string }
  /** Nothing like it exists. A genuinely new category. */
  | { status: 'new'; canonical: string; input: string };

/** A resolution that can be applied without asking the user anything. */
export function isDecided(r: CategoryResolution): r is
  Extract<CategoryResolution, { status: 'exact' | 'alias' | 'new' }> {
  return r.status === 'exact' || r.status === 'alias' || r.status === 'new';
}

/** The name to use if the resolution is accepted as-is. */
export function resolvedName(r: CategoryResolution): string {
  return r.status === 'ambiguous' ? tidyCategoryName(r.input) : r.canonical;
}

export interface ResolveOptions {
  /** Every category that currently exists — built-ins and the user's own. */
  known: string[];
  /**
   * Decisions the user has already made, keyed by `categoryKey` of what they
   * typed. A value equal to its own key's name means "I checked; it really is
   * different" — remembered so we never ask twice.
   */
  aliases?: Record<string, string>;
}

/**
 * Work out what an entered category name actually refers to.
 *
 * Order matters: every deterministic answer is exhausted before any guess is
 * made, and a remembered decision outranks all of them.
 */
export function resolveCategoryName(input: string, opts: ResolveOptions): CategoryResolution {
  const name = tidyCategoryName(input);
  const key = categoryKey(name);
  if (!key) return { status: 'new', canonical: name, input: name };

  // Index the known categories by key. First writer wins, so the built-in
  // spelling beats a stray variant that crept in later.
  const byKey = new Map<string, string>();
  for (const k of opts.known) {
    const kk = categoryKey(k);
    if (kk && !byKey.has(kk)) byKey.set(kk, tidyCategoryName(k));
  }

  // 1. A decision the user already made about this exact spelling.
  const remembered = opts.aliases?.[key];
  if (remembered) {
    return { status: 'alias', canonical: byKey.get(categoryKey(remembered)) ?? tidyCategoryName(remembered), input: name };
  }

  // 2. Spelling-only difference from something that already exists.
  const hit = byKey.get(key);
  if (hit) return { status: 'exact', canonical: hit, input: name };

  // 3. The taxonomy's curated alias table — the same mapping used at ingest, so
  //    a typed "grocery" lands where an imported "grocery" already lands.
  const alias = explicitAlias(name);
  if (alias) {
    const canonical = byKey.get(categoryKey(alias)) ?? alias;
    return { status: 'alias', canonical, input: name };
  }

  // 4. Guesswork, from here down.
  const budget = allowedDistance(key.length);
  const scored: { name: string; distance: number }[] = [];

  for (const [k, display] of byKey) {
    let distance = budget > 0 ? editDistance(key, k, budget) : budget + 1;
    if (distance > budget) {
      // An abbreviation is not a typo — "groc" is 5 edits from "groceries" but
      // is obviously reaching for it. Ranked just behind a one-character slip.
      const isPrefix = key.length >= MIN_PREFIX_LENGTH && k.startsWith(key);
      if (!isPrefix) continue;
      distance = 1;
    }
    scored.push({ name: display, distance });
  }

  if (scored.length === 0) return { status: 'new', canonical: name, input: name };

  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const best = scored[0];
  const tied = scored.filter(s => s.distance === best.distance);

  // Equally close to more than one category: say nothing rather than guess.
  if (tied.length > 1) {
    return { status: 'ambiguous', candidates: tied.map(t => t.name), input: name };
  }

  return { status: 'suggestion', canonical: best.name, input: name, distance: best.distance };
}

// ─── Remembering the answer ──────────────────────────────────────────────────

/**
 * Record what the user decided about a spelling, so they are asked once and
 * never again.
 *
 * Both answers are worth remembering. "Yes, that's Groceries" stops a duplicate
 * being created; "no, this really is different" stops us nagging about a
 * category the user has already defended.
 */
export function rememberDecision(
  aliases: Record<string, string>, input: string, canonical: string,
): Record<string, string> {
  const key = categoryKey(input);
  const name = tidyCategoryName(canonical);
  if (!key || !name) return aliases;
  if (aliases[key] === name) return aliases;
  return { ...aliases, [key]: name };
}

/**
 * Drop alias entries pointing at a category that no longer exists, and follow a
 * rename to its new name. Without this a deleted category keeps quietly
 * capturing every future attempt to create one with a similar name.
 */
export function pruneAliases(
  aliases: Record<string, string>, known: string[],
): Record<string, string> {
  const byKey = new Map<string, string>();
  for (const k of known) {
    const kk = categoryKey(k);
    if (kk && !byKey.has(kk)) byKey.set(kk, tidyCategoryName(k));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    // A self-alias ("keep it, it's different") stays valid as long as the
    // category it defends is still around; both cases are the same lookup.
    const live = byKey.get(categoryKey(value));
    if (live) out[key] = live;
  }
  return out;
}
