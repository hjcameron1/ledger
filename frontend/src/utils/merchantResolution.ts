/**
 * Phase 2B — Merchant recognition.
 *
 * Turns a raw bank description into a canonical merchant:
 *
 *   "WOOLWORTHS 1234 ROBINA"  ┐
 *   "WOOLWORTHS ONLINE"       ├──►  Woolworths   (default category: Groceries)
 *   "W/WORTHS ROBINA"         ┘
 *
 * normaliseMerchant() alone can't unify those — "woolworths robina",
 * "woolworths online" and "w worths robina" are three different keys. So a
 * MATCHING layer sits on top:
 *
 *   1. USER aliases      (user_id === me)        — learned from corrections; win first
 *   2. GLOBAL aliases    (user_id == null, DB)   — shared mappings
 *   3. Built-in SEEDS    (shipped in code)       — work out-of-the-box, no DB seeding
 *   4. USER merchants    (direct normalized ==)  — a user-owned canonical merchant
 *   5. GLOBAL merchants  (direct normalized ==)  — a shared canonical merchant
 *
 * A user alias ALWAYS overrides a global alias/seed. Everything here is PURE.
 *
 * This NEVER touches raw_description — it only proposes a display `merchant` and a
 * `merchant_id`/`default_category`. The caller decides how to apply them.
 */

import type { Merchant, MerchantAlias } from '../types';
import { normaliseMerchant } from './recurringDetection';

export interface MerchantContext {
  merchants: Merchant[];
  aliases: MerchantAlias[];
  /** The current user's id; user-scoped rows win over global (null user_id) rows. */
  userId?: string | null;
}

export interface MerchantResolution {
  merchantId: string | null;
  displayName: string;
  defaultCategory: string | null;
  /** How the match was made — useful for confidence/metadata and debugging. */
  matchedBy: 'user_alias' | 'global_alias' | 'seed' | 'user_merchant' | 'global_merchant';
}

// ─── Built-in seeds ──────────────────────────────────────────────────────────
// Shipped canonical merchants so recognition works before any DB seeding. Each
// seed matches when the UPPERCASED raw description contains ANY of its `contains`
// tokens (substring), which robustly unifies bank spelling variants.
interface MerchantSeed {
  /** Stable synthetic id, prefixed so it never collides with a DB uuid. */
  id: string;
  displayName: string;
  defaultCategory: string;
  contains: string[];
}

export const MERCHANT_SEEDS: MerchantSeed[] = [
  { id: 'seed:woolworths', displayName: 'Woolworths', defaultCategory: 'Groceries',
    contains: ['WOOLWORTHS', 'WOOLIES', 'W/WORTHS', 'WWORTHS'] },
  { id: 'seed:coles', displayName: 'Coles', defaultCategory: 'Groceries',
    contains: ['COLES'] },
  { id: 'seed:aldi', displayName: 'Aldi', defaultCategory: 'Groceries',
    contains: ['ALDI'] },
  { id: 'seed:iga', displayName: 'IGA', defaultCategory: 'Groceries',
    contains: ['IGA '] },
  { id: 'seed:costco', displayName: 'Costco', defaultCategory: 'Groceries',
    contains: ['COSTCO'] },
  { id: 'seed:mcdonalds', displayName: "McDonald's", defaultCategory: 'Dining',
    contains: ['MCDONALD', 'MACCAS'] },
  { id: 'seed:kfc', displayName: 'KFC', defaultCategory: 'Dining',
    contains: ['KFC'] },
  { id: 'seed:ubereats', displayName: 'Uber Eats', defaultCategory: 'Dining',
    contains: ['UBER EATS', 'UBEREATS'] },
  { id: 'seed:uber', displayName: 'Uber', defaultCategory: 'Transport',
    contains: ['UBER '] },
  { id: 'seed:netflix', displayName: 'Netflix', defaultCategory: 'Entertainment',
    contains: ['NETFLIX'] },
  { id: 'seed:spotify', displayName: 'Spotify', defaultCategory: 'Entertainment',
    contains: ['SPOTIFY'] },
  { id: 'seed:amazon', displayName: 'Amazon', defaultCategory: 'Shopping',
    contains: ['AMAZON', 'AMZN'] },
  { id: 'seed:bp', displayName: 'BP', defaultCategory: 'Fuel',
    contains: ['BP '] },
  { id: 'seed:shell', displayName: 'Shell', defaultCategory: 'Fuel',
    contains: ['SHELL'] },
  { id: 'seed:ampol', displayName: 'Ampol', defaultCategory: 'Fuel',
    contains: ['AMPOL', 'CALTEX'] },
  { id: 'seed:jbhifi', displayName: 'JB Hi-Fi', defaultCategory: 'Electronics',
    contains: ['JB HI-FI', 'JB HIFI', 'JBHIFI'] },
  { id: 'seed:chemistwarehouse', displayName: 'Chemist Warehouse', defaultCategory: 'Health',
    contains: ['CHEMIST WAREHOUSE'] },
  { id: 'seed:telstra', displayName: 'Telstra', defaultCategory: 'Telecommunications',
    contains: ['TELSTRA'] },
];

// ─── Broad-match token (learn-from-corrections) ──────────────────────────────

/**
 * Given a resolved merchant and the raw description it came from, return an
 * UPPERCASE brand substring that identifies EVERY transaction from that merchant
 * — so a correction learned on "WOOLWORTHS 1234 ROBINA" also covers "WOOLWORTHS
 * ONLINE" and "WOOLWORTHS 5678 SYDNEY", not just the one store.
 *
 *   • Recognised via a seed → the seed's own matching token (already tuned to
 *     avoid false positives, e.g. "BP " keeps its trailing space).
 *   • Otherwise, if the display name literally appears in the raw → that name.
 *   • Unrecognised merchant → null (caller falls back to the narrow exact key).
 *
 * PURE. Used by learn-from-corrections to key rules/aliases on the brand, not on
 * a single location-specific description.
 */
export function merchantMatchToken(res: MerchantResolution | null, raw: string): string | null {
  if (!res) return null;
  const upper = (raw ?? '').toUpperCase();
  if (res.merchantId && res.merchantId.startsWith('seed:')) {
    const seed = MERCHANT_SEEDS.find(s => s.id === res.merchantId);
    const tok = seed?.contains.find(t => upper.includes(t));
    if (tok) return tok; // already uppercase; keep any deliberate trailing space
  }
  const dn = (res.displayName ?? '').toUpperCase().trim();
  if (dn && upper.includes(dn)) return dn;
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Is `row` scoped to the given user (vs a global row with null user_id)? */
function isUserScoped(rowUserId: string | null | undefined, userId: string | null | undefined): boolean {
  return Boolean(userId) && rowUserId === userId;
}

function isGlobalScoped(rowUserId: string | null | undefined): boolean {
  return rowUserId == null;
}

function aliasMatches(alias: MerchantAlias, normalized: string, rawUpper: string): boolean {
  if (alias.match_type === 'normalized') return alias.pattern === normalized;
  // 'contains' — pattern stored uppercased, tested against the raw description.
  return alias.pattern.length > 0 && rawUpper.includes(alias.pattern.toUpperCase());
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve a raw description to a canonical merchant, or null when nothing matches.
 *
 * `raw` should be the ORIGINAL bank/provider description (raw_description) so that
 * 'contains' seeds/aliases can see the un-normalised spelling. The function also
 * computes normaliseMerchant(raw) internally for exact-key matching.
 */
export function resolveMerchant(raw: string, ctx: MerchantContext): MerchantResolution | null {
  const rawStr = raw ?? '';
  const rawUpper = rawStr.toUpperCase();
  const normalized = normaliseMerchant(rawStr);
  const merchantById = new Map(ctx.merchants.map(m => [m.id, m]));

  const toResolution = (
    merchant: Merchant | undefined,
    matchedBy: MerchantResolution['matchedBy'],
  ): MerchantResolution | null => {
    if (!merchant) return null;
    return {
      merchantId: merchant.id,
      displayName: merchant.display_name,
      defaultCategory: merchant.default_category ?? null,
      matchedBy,
    };
  };

  // 1. USER aliases (learned corrections) — highest precedence.
  for (const a of ctx.aliases) {
    if (!isUserScoped(a.user_id, ctx.userId)) continue;
    if (aliasMatches(a, normalized, rawUpper)) {
      const r = toResolution(merchantById.get(a.merchant_id), 'user_alias');
      if (r) return r;
    }
  }

  // 2. GLOBAL aliases (shared DB mappings).
  for (const a of ctx.aliases) {
    if (!isGlobalScoped(a.user_id)) continue;
    if (aliasMatches(a, normalized, rawUpper)) {
      const r = toResolution(merchantById.get(a.merchant_id), 'global_alias');
      if (r) return r;
    }
  }

  // 3. Built-in seeds (contains match on the raw description).
  for (const seed of MERCHANT_SEEDS) {
    if (seed.contains.some(tok => rawUpper.includes(tok))) {
      return {
        merchantId: seed.id,
        displayName: seed.displayName,
        defaultCategory: seed.defaultCategory,
        matchedBy: 'seed',
      };
    }
  }

  // 4. USER merchants by exact normalized key.
  if (normalized) {
    const userMerchant = ctx.merchants.find(
      m => isUserScoped(m.user_id, ctx.userId) && m.merchant_normalized === normalized,
    );
    const r = toResolution(userMerchant, 'user_merchant');
    if (r) return r;

    // 5. GLOBAL merchants by exact normalized key.
    const globalMerchant = ctx.merchants.find(
      m => isGlobalScoped(m.user_id) && m.merchant_normalized === normalized,
    );
    const g = toResolution(globalMerchant, 'global_merchant');
    if (g) return g;
  }

  return null;
}
