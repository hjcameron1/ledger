/**
 * Phase 2B — Classification orchestrator.
 *
 * The single place that decides a transaction's merchant, category and metadata,
 * implementing the fixed priority order so manual / statement / Basiq all classify
 * IDENTICALLY:
 *
 *   CATEGORY precedence
 *     1. explicit user choice        (category_source === 'user')   conf 1.0
 *     2. user rule                   (rule action.category)         conf 0.9
 *     3. resolved merchant default   (user alias / merchant)        conf 0.85
 *     4. resolved merchant default   (global alias / seed)          conf 0.80
 *     5. provider category mapping   (Basiq → taxonomy)             conf 0.60
 *     6. autoCategory() keyword      (→ taxonomy)                   conf 0.40
 *     7. Uncategorised                                              conf 0.10
 *
 * PURE — no store, no network. Consumes context (merchants, aliases, rules,
 * customCategories, userId) supplied by the caller (dataService at ingest time).
 *
 * NEVER touches raw_description. `merchant` is a DISPLAY value only.
 */

import type {
  Merchant, MerchantAlias, TransactionRule, TransactionType,
} from '../types';
import { normaliseMerchant } from './recurringDetection';
import { autoCategory } from './format';
import { resolveMerchant, type MerchantResolution } from './merchantResolution';
import { applyRules, type RuleCandidate } from './transactionRules';
import { normaliseCategory, UNCATEGORISED } from './categoryTaxonomy';

export interface ClassifyInput {
  merchant: string;
  raw_description?: string | null;
  amount: number;
  account_id: string;
  source: string;
  category?: string | null;
  category_source?: 'auto' | 'basiq' | 'user' | 'rule' | 'merchant' | 'ai' | null;
  /**
   * Did the user deliberately curate the DISPLAY merchant string (vs just type a
   * bank-style description)? Only 'user' suppresses merchant recognition. This is
   * intentionally SEPARATE from category_source: picking a category must never
   * stop "WOOLWORTHS 1234 ROBINA" from resolving to "Woolworths". Nothing sets
   * this today, so recognition applies to every manual/statement/Basiq entry.
   */
  merchant_source?: 'user' | null;
  tags?: string[] | null;
  entity?: string | null;
  is_tax_deductible?: boolean;
  transaction_type?: TransactionType | null;
}

export interface ClassifyContext {
  merchants: Merchant[];
  aliases: MerchantAlias[];
  rules: TransactionRule[];
  customCategories?: string[];
  userId?: string | null;
}

export interface Classification {
  merchant: string;
  merchant_id: string | null;
  merchant_normalized: string;
  category: string;
  category_source: 'auto' | 'basiq' | 'user' | 'rule' | 'merchant';
  confidence: number;
  tags?: string[] | null;
  entity?: string | null;
  is_tax_deductible?: boolean;
  transaction_type?: TransactionType | null;
  /** Which rule (if any) matched — surfaced for debugging/telemetry. */
  matchedRuleId?: string | null;
}

function isMerchantScopedUser(res: MerchantResolution): boolean {
  return res.matchedBy === 'user_alias' || res.matchedBy === 'user_merchant';
}

export function classifyTransaction(input: ClassifyInput, ctx: ClassifyContext): Classification {
  const raw = input.raw_description ?? input.merchant ?? '';
  const merchant_normalized = normaliseMerchant(raw || input.merchant || '');
  const userExplicit = input.category_source === 'user';
  const merchantExplicit = input.merchant_source === 'user';
  const custom = ctx.customCategories;

  // Merchant + rule resolution (both pure lookups).
  const merchantRes = resolveMerchant(raw, {
    merchants: ctx.merchants, aliases: ctx.aliases, userId: ctx.userId,
  });
  const candidate: RuleCandidate = {
    merchant_normalized,
    raw_description: raw,
    merchant: input.merchant,
    account_id: input.account_id,
    amount: input.amount,
    source: input.source,
  };
  const ruleMatch = applyRules(candidate, ctx.rules, ctx.userId);
  const actions = ruleMatch?.actions;

  // ── Display merchant ──────────────────────────────────────────────────────
  // rule.merchant wins; else the resolved canonical name; else the incoming
  // string unchanged. Recognition is gated on merchant_source (a deliberately
  // curated merchant), NOT category_source — picking a category must never stop
  // "WOOLWORTHS 1234 ROBINA" resolving to "Woolworths". raw_description is
  // preserved by the caller regardless.
  let merchant = input.merchant;
  if (actions?.merchant) {
    merchant = actions.merchant;
  } else if (merchantRes && !merchantExplicit) {
    merchant = merchantRes.displayName;
  }
  const merchant_id = merchantRes?.merchantId ?? null;

  // ── Category (priority order) ─────────────────────────────────────────────
  let category = UNCATEGORISED;
  let category_source: Classification['category_source'] = 'auto';
  let confidence = 0.1;

  const merchantDefault = merchantRes?.defaultCategory
    ? normaliseCategory(merchantRes.defaultCategory, { customCategories: custom })
    : null;
  const providerCat = (input.category && (input.category_source === 'basiq' || input.source === 'basiq'))
    ? normaliseCategory(input.category, { customCategories: custom })
    : null;
  const keywordCat = normaliseCategory(autoCategory(merchant), { customCategories: custom });

  if (userExplicit && input.category) {
    // 1. Explicit user choice — untouchable.
    category = input.category;
    category_source = 'user';
    confidence = 1.0;
  } else if (actions?.category) {
    // 2. User rule.
    category = normaliseCategory(actions.category, { customCategories: custom });
    category_source = 'rule';
    confidence = 0.9;
  } else if (merchantDefault && merchantDefault !== UNCATEGORISED) {
    // 3/4. Resolved merchant default (user-scoped slightly higher confidence).
    category = merchantDefault;
    category_source = 'merchant';
    confidence = merchantRes && isMerchantScopedUser(merchantRes) ? 0.85 : 0.8;
  } else if (providerCat && providerCat !== UNCATEGORISED) {
    // 5. Provider (Basiq) category mapping.
    category = providerCat;
    category_source = 'basiq';
    confidence = 0.6;
  } else if (keywordCat && keywordCat !== UNCATEGORISED) {
    // 6. Keyword autoCategory().
    category = keywordCat;
    category_source = 'auto';
    confidence = 0.4;
  } else {
    // 7. Nothing matched.
    category = UNCATEGORISED;
    category_source = 'auto';
    confidence = 0.1;
  }

  // ── Rule-driven metadata (applied regardless of who set the category) ──────
  const tags = actions?.tags && actions.tags.length
    ? Array.from(new Set([...(input.tags ?? []), ...actions.tags]))
    : (input.tags ?? null);
  const entity = actions?.entity ?? input.entity ?? null;
  const is_tax_deductible = actions?.is_tax_deductible ?? input.is_tax_deductible ?? false;
  const transaction_type = actions?.transaction_type ?? input.transaction_type ?? null;

  return {
    merchant,
    merchant_id,
    merchant_normalized,
    category,
    category_source,
    confidence,
    tags,
    entity,
    is_tax_deductible,
    transaction_type,
    matchedRuleId: ruleMatch?.rule.id ?? null,
  };
}
