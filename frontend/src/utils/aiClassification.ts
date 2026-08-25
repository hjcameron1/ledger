/**
 * Phase 2D.3 — AI classification FALLBACK (pure engine).
 *
 * The deterministic classifier (transactionClassify.ts) always runs first and
 * unchanged: user category → user rule → resolved merchant → provider category →
 * keyword. ONLY when that whole chain fails to produce a confident category does
 * the app ask a model for a suggestion — as a last resort, never as an override.
 *
 * This module is the PURE decision layer around that fallback:
 *   • needsAiFallback           — is a row eligible for the AI fallback at all?
 *                                 (encodes the fallback ORDER + the no-repeat +
 *                                  never-touch-explicit-user-rules guarantees)
 *   • selectAiFallbackCandidates — pick the batch to send (dedup / in-flight / cap)
 *   • toAiClassifyItem          — the minimal, low-PII view we send to the model
 *   • planAiSuggestion          — turn a model suggestion into a persist patch,
 *                                 with a hard guard that it can NEVER overwrite a
 *                                 user- or rule-set category
 *
 * PURE — no store, no network. The DS (transactionsDS.runAiFallback) owns the
 * network call and persistence; the UI (NeedsReviewSection) surfaces the result.
 */

import type { Transaction, TransactionType } from '../types';
import { normaliseCategory, UNCATEGORISED } from './categoryTaxonomy';

/**
 * A deterministic result at or above this confidence is trusted — we do NOT spend
 * an AI call on it. Mirrors the ingest threshold that stamps 'uncertain_merchant'
 * (transactionClassify: keyword match = 0.4, uncategorised = 0.1). So only rows
 * the engine itself already considers uncertain reach the model.
 */
export const AI_FALLBACK_MAX_CONFIDENCE = 0.4;

/** Cap on how many rows we send to the model in one pass (bounds latency + cost). */
export const AI_FALLBACK_BATCH_LIMIT = 25;

/**
 * category_source values the AI fallback is ALLOWED to act on. 'user' and 'rule'
 * are deliberately absent: an explicit user choice or a user rule is authoritative
 * and the AI must never override it. 'merchant'/'basiq' are confident deterministic
 * outputs and are excluded by the confidence gate too — but listing only the
 * genuinely-eligible sources here is the belt-and-suspenders that makes
 * planAiSuggestion refuse to touch anything else.
 */
const AI_ELIGIBLE_SOURCES = new Set(['auto', 'ai', null, undefined] as const);

/** The raw suggestion the backend AI classifier returns for one transaction. */
export interface AiSuggestion {
  id: string;
  merchant?: string | null;
  category?: string | null;
  transaction_type?: TransactionType | null;
  /** Short human note — why it's unsure / what to check. Surfaced in review. */
  reason?: string | null;
  /** The model's own 0..1 confidence. */
  confidence?: number | null;
}

/** Minimal, low-PII view of a transaction sent to the model. */
export interface AiClassifyItem {
  id: string;
  description: string;
  merchant: string;
  amount: number;
  date: string;
}

function eligibleSource(source: Transaction['category_source']): boolean {
  return (AI_ELIGIBLE_SOURCES as Set<unknown>).has(source ?? null);
}

/**
 * Is this transaction eligible for the AI fallback?
 *
 * True ONLY when every deterministic layer has already failed AND we haven't
 * already asked. Concretely, ALL of:
 *   1. Not already AI-classified — `ai_classified_at` unset (the no-repeat guard,
 *      persisted so a reload never re-asks).
 *   2. Category is NOT user/rule/merchant/basiq — i.e. the engine left it 'auto'
 *      or unset. This is what "after deterministic rules fail" means, and it's the
 *      structural guarantee the AI never overrides an explicit user rule.
 *   3. Not a detected transfer/refund — those have their own review flows.
 *   4. Not already queued under a different review reason (duplicate / refund /
 *      transfer) — the AI fallback is for uncertain merchant/category only.
 *   5. Low-confidence or uncategorised.
 */
export function needsAiFallback(t: Transaction, cutoff?: string | null): boolean {
  // 0. review cutoff — the "start fresh" line set by "Clear all". Only rows ADDED
  //    on/after the cutoff are ever in scope; the historical backlog is dropped so
  //    review/AI works from new transactions only. A row with no created_at is
  //    treated as pre-cutoff backlog. (created_at is a comparable ISO string.)
  if (cutoff && (!t.created_at || t.created_at < cutoff)) return false;

  // 1. no repeated calls
  if (t.ai_classified_at) return false;

  // 2. never override an explicit user choice / rule / confident merchant match
  if (!eligibleSource(t.category_source)) return false;
  if (t.category_source === 'ai') return false; // already carries an AI suggestion

  // 3. detected events have dedicated handling, not merchant/category guessing
  if (t.is_transfer) return false;
  if (t.transaction_type === 'transfer' || t.transaction_type === 'refund') return false;

  // 4. other review reasons own their own resolution UI
  const reason = t.review_reason;
  if (reason === 'ambiguous_duplicate' || reason === 'possible_refund' || reason === 'possible_transfer') {
    return false;
  }

  // 5. only genuinely uncertain / uncategorised rows
  const uncategorised = !t.category || t.category === UNCATEGORISED;
  const conf = t.confidence ?? 0;
  return uncategorised || conf < AI_FALLBACK_MAX_CONFIDENCE;
}

/**
 * Pick the batch of transactions to send to the model:
 *  - eligible per needsAiFallback (fallback order + no-repeat + no-override)
 *  - not already in flight (prevents a second concurrent call for the same row)
 *  - capped at `limit`
 *
 * Because the caller's `transactions` list is already this user's own rows, this
 * also enforces user isolation — a row from another user is never in scope, and
 * the returned items carry only ids that belong to the caller.
 */
export function selectAiFallbackCandidates(
  transactions: Transaction[],
  opts: { inFlight?: Set<string>; limit?: number; cutoff?: string | null } = {},
): Transaction[] {
  const inFlight = opts.inFlight ?? new Set<string>();
  const limit = opts.limit ?? AI_FALLBACK_BATCH_LIMIT;
  const out: Transaction[] = [];
  for (const t of transactions) {
    if (inFlight.has(t.id)) continue;
    if (!needsAiFallback(t, opts.cutoff)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** The minimal payload row for the model — raw description preferred, no ids leaked. */
export function toAiClassifyItem(t: Transaction): AiClassifyItem {
  return {
    id: t.id,
    description: (t.raw_description || t.merchant || '').slice(0, 140),
    merchant: (t.merchant || '').slice(0, 80),
    amount: t.amount,
    date: t.date,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Turn a model suggestion into the patch to persist on the transaction, or return
 * `null` when the row must be left untouched.
 *
 * HARD GUARANTEES:
 *  - Never overrides a user- or rule-set category. If, between the request and the
 *    response, the user set a category or a rule fired (category_source became
 *    'user'/'rule'/'merchant'/'basiq'), we bail and return null — the AI answer is
 *    silently dropped. This is the async-race backstop to needsAiFallback.
 *  - The suggested category is normalised to the user's own taxonomy (custom
 *    categories preserved); an unknown name collapses to Uncategorised and is NOT
 *    applied — the model can never invent a category.
 *  - The applied category is stamped category_source='ai' with the model's own
 *    (clamped 0..1) confidence, and the row is surfaced in Needs Review so the
 *    user confirms/corrects it. Confirming promotes it to 'user'.
 *  - raw_description is never touched.
 *
 * `now` is injected so the function stays pure/testable.
 */
export function planAiSuggestion(
  t: Transaction,
  s: AiSuggestion,
  opts: { customCategories?: string[]; now?: string } = {},
): Partial<Transaction> | null {
  // Async-race backstop: only ever act on a still-eligible row.
  if (!eligibleSource(t.category_source)) return null;

  const now = opts.now ?? new Date().toISOString();
  const rawCat = s.category ? normaliseCategory(s.category, { customCategories: opts.customCategories }) : null;
  const usableCat = rawCat && rawCat !== UNCATEGORISED ? rawCat : null;
  const merchant = s.merchant?.trim() || null;
  const reason = s.reason?.trim() || null;
  const aiConfidence = s.confidence == null ? null : clamp01(s.confidence);

  const patch: Partial<Transaction> = {
    ai_suggested_category: usableCat,
    ai_suggested_merchant: merchant,
    ai_suggested_transaction_type: s.transaction_type ?? null,
    ai_suggested_reason: reason,
    ai_confidence: aiConfidence,
    ai_classified_at: now,
    // Surface it for the user — the "smarter review" half of the phase. An
    // uncertain row now lands in the queue WITH a suggestion attached.
    review_status: 'needs_review',
    review_reason: 'uncertain_merchant',
  };

  // Apply the AI category only when it's a real, known category. This upgrades a
  // row the engine left 'auto'/Uncategorised — it never overwrites a confident
  // source (guarded above).
  if (usableCat) {
    patch.category = usableCat;
    patch.category_source = 'ai';
    patch.confidence = aiConfidence ?? 0.5;
  }

  return patch;
}
