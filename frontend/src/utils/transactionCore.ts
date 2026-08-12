/**
 * Phase 2A — Transaction Foundation: the shared, pure core.
 *
 * Every part of Ledger must agree on:
 *   • transaction SOURCE + RAW DATA   (stampIngest)
 *   • DUPLICATE IDENTITY              (computeContentHash / findExactDuplicate)
 *   • TRANSFERS                       (computeTransferExclusionIds / findTransferMatch)
 *   • what counts as SPENDING         (isSpendTransaction / spendByCategory / totalSpend)
 *
 * This module is PURE — no store, no network, no React — so it can be unit
 * tested in isolation and reused by every ingestion path. It builds on the
 * existing normaliseMerchant() / isTransferMerchant() logic rather than
 * replacing it.
 */

import type { Transaction, TransactionSource, TransactionType } from '../types';
import { normaliseMerchant, isTransferMerchant } from './recurringDetection';

export type { TransactionType };

// ─── Credit-card repayment detection ─────────────────────────────────────────
// Shared with dataService's reconciliation layer (single source of truth).
export const CC_PAYMENT_PATTERNS = [
  'AMEX', 'AMERICAN EXPRESS', 'VISA PAYMENT', 'MASTERCARD', 'MASTERCARD PAYMENT',
  'CREDIT CARD PAYMENT', 'CREDIT CARD', 'ANZ CREDIT', 'CBA CREDIT', 'NAB CREDIT',
  'WESTPAC CREDIT', 'ING CREDIT', 'COMMBANK CREDIT', 'BANKWEST CREDIT',
];

/** Text-only signal that a bank debit is a credit-card repayment. */
export function looksLikeCardRepayment(merchant: string): boolean {
  const m = (merchant || '').toUpperCase();
  return CC_PAYMENT_PATTERNS.some(p => m.includes(p));
}

// ─── Category helpers ─────────────────────────────────────────────────────────

/** A category that means "not real spending" (internal movement / income). */
export function isNonSpendCategory(category?: string | null): boolean {
  const c = (category || '').trim().toLowerCase();
  return c === 'transfer' || c === 'income';
}

// ─── Signed-cents / effective amount ─────────────────────────────────────────

/** Signed integer cents of a raw amount (avoids float drift in hashing/tests). */
export function signedCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * The amount used for spend magnitude and sign. We prefer display_amount (the
 * user's preferred currency) when present so every surface reports the same
 * number, falling back to the native amount.
 */
export function effectiveAmount(t: Pick<Transaction, 'amount' | 'display_amount'>): number {
  return t.display_amount ?? t.amount ?? 0;
}

// ─── Source + raw-data stamping ──────────────────────────────────────────────

export interface IngestStampInput {
  merchant: string;
  amount: number;
  /** Original untouched description from the source system, if distinct from merchant. */
  raw_description?: string | null;
  source: TransactionSource;
  source_ref?: string | null;
  category?: string | null;
  category_source?: Transaction['category_source'];
  user_id?: string;
  account_id?: string;
  date?: string;
}

/**
 * Fill in the foundation fields (source, raw_description, merchant_normalized,
 * content_hash) without ever destroying the raw value. Idempotent: an existing
 * raw_description is preserved.
 */
export function stampIngest<T extends IngestStampInput>(input: T): T & {
  raw_description: string;
  merchant_normalized: string;
  content_hash: string;
} {
  // raw_description defaults to the incoming merchant string and is NEVER
  // overwritten if already supplied.
  const raw_description = (input.raw_description ?? input.merchant) || '';
  const merchant_normalized = normaliseMerchant(raw_description || input.merchant || '');
  const content_hash = computeContentHash({
    user_id: input.user_id,
    account_id: input.account_id,
    date: input.date,
    amount: input.amount,
    merchant: input.merchant,
    raw_description,
  });
  return { ...input, raw_description, merchant_normalized, content_hash };
}

// ─── Duplicate identity ──────────────────────────────────────────────────────

/** Stable non-crypto string hash (FNV-1a, 32-bit) → 8-char hex. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic content hash used for duplicate identity. Built from:
 *   user • account • date • signed-cents • normalised merchant/raw description.
 *
 * Two genuinely-distinct same-value purchases on the same day at the same
 * merchant WILL collide — that is intentional: content_hash is an *advisory*
 * identity for re-import protection, never a licence to silently delete. Exact
 * provider ids (basiq_tx_id / source_ref) are the authoritative idempotency key.
 */
export function computeContentHash(t: {
  user_id?: string | null;
  account_id?: string | null;
  date?: string | null;
  amount: number;
  merchant?: string | null;
  raw_description?: string | null;
}): string {
  const merchantKey = normaliseMerchant((t.raw_description || t.merchant || '').trim());
  const parts = [
    (t.user_id ?? '').trim(),
    (t.account_id ?? '').trim(),
    (t.date ?? '').trim(),
    String(signedCents(t.amount)),
    merchantKey,
  ];
  const key = parts.join('|');
  // Two FNV passes over key + reversed key to shrink accidental collisions.
  return fnv1a(key) + fnv1a(key.split('').reverse().join(''));
}

/**
 * Multiplicity-aware duplicate decision for batch imports (Step 5).
 *
 * When importing a batch, we may legitimately see the SAME content_hash more
 * than once (two distinct $4.50 purchases on the same day at the same merchant).
 * The Nth occurrence in a batch — where `processedInBatch` occurrences have
 * already been handled — is a re-import duplicate ONLY if the store already
 * holds more copies than we've accounted for. This lets genuine same-value
 * purchases coexist while a full statement re-import adds nothing.
 */
export function isMultiplicityDuplicate(existingCount: number, processedInBatch: number): boolean {
  return existingCount > processedInBatch;
}

export interface DuplicateMatch {
  transaction: Transaction;
  reason: 'source_ref' | 'content_hash';
}

/**
 * Find an EXACT duplicate of a candidate among existing transactions.
 *
 * Priority:
 *   1. Exact provider/source reference (basiq_tx_id / source_ref) — authoritative.
 *   2. Deterministic content_hash — same user/account/date/amount/merchant.
 *
 * Returns undefined when the candidate is new. Fuzzy/cross-account similarity is
 * deliberately NOT handled here — that stays advisory (UI prompt), never a
 * silent drop.
 */
export function findExactDuplicate(
  candidate: {
    basiq_tx_id?: string | null;
    source_ref?: string | null;
    content_hash?: string | null;
    user_id?: string | null;
    account_id?: string | null;
    date?: string | null;
    amount: number;
    merchant?: string | null;
    raw_description?: string | null;
  },
  existing: Transaction[],
): DuplicateMatch | undefined {
  const ref = candidate.basiq_tx_id ?? candidate.source_ref ?? null;
  if (ref) {
    const hit = existing.find(e => (e.basiq_tx_id && e.basiq_tx_id === ref) || (e.source_ref && e.source_ref === ref));
    if (hit) return { transaction: hit, reason: 'source_ref' };
  }
  const hash = candidate.content_hash ?? computeContentHash(candidate);
  const hit = existing.find(e => {
    const eh = e.content_hash ?? computeContentHash(e);
    return eh === hash;
  });
  if (hit) return { transaction: hit, reason: 'content_hash' };
  return undefined;
}

/** content_hash of an existing stored transaction (recomputes if not persisted). */
export function contentHashOf(e: Pick<Transaction,
  'content_hash' | 'user_id' | 'account_id' | 'date' | 'amount' | 'merchant' | 'raw_description'>): string {
  return e.content_hash ?? computeContentHash(e);
}

// ─── Duplicate CLASSIFICATION (the full multiplicity-aware decision) ──────────
//
// content_hash is DEDUP EVIDENCE, not a globally-unique financial-event id. The
// only strict identity is a provider/source reference (basiq_tx_id / source_ref).
// This function encodes the whole policy so it is unit-testable without a store:
//
//   • Strong id present:
//       – matches an existing ref → DUPLICATE (authoritative).
//       – no match → a DISTINCT event; NEVER content-dedup it (two Basiq txns
//         with different ids but identical content both survive).
//   • No strong id (statement / manual):
//       – multiplicity-aware content_hash dedup, counted ONLY against prior
//         IMPORT-sourced rows (source ≠ 'manual'). A manual entry never
//         suppresses an imported line — that would silently drop a legitimate
//         transaction.
//   • Whatever is kept, if it content-collides with an existing row of a
//     DIFFERENT source (e.g. manual vs statement), it is flagged
//     review_status='needs_review' — preserved, surfaced, never deleted.
export interface IncomingCandidate {
  source: TransactionSource;
  content_hash: string;
  basiq_tx_id?: string | null;
  source_ref?: string | null;
}

export interface DuplicateDecision {
  isDuplicate: boolean;
  reason?: 'source_ref' | 'content_hash';
  duplicateOf?: Transaction;
  /** When kept but ambiguously colliding across sources. */
  reviewFlag?: 'needs_review';
}

export function classifyDuplicate(
  candidate: IncomingCandidate,
  existing: Transaction[],
  opts: { allowDuplicate?: boolean; batchState?: Map<string, number> } = {},
): DuplicateDecision {
  const hash = candidate.content_hash;

  if (!opts.allowDuplicate) {
    const ref = candidate.basiq_tx_id ?? candidate.source_ref ?? null;
    if (ref) {
      // Strong identity path.
      const dup = existing.find(e => (e.basiq_tx_id && e.basiq_tx_id === ref) || (e.source_ref && e.source_ref === ref));
      if (dup) return { isDuplicate: true, reason: 'source_ref', duplicateOf: dup };
      // No ref match → distinct event; fall through WITHOUT content dedup.
    } else {
      // No strong id → content_hash multiplicity, import-sourced rows only.
      const existingCount = existing.reduce(
        (n, e) => n + (e.source !== 'manual' && contentHashOf(e) === hash ? 1 : 0), 0,
      );
      const processed = opts.batchState?.get(hash) ?? 0;
      opts.batchState?.set(hash, processed + 1);
      if (isMultiplicityDuplicate(existingCount, processed)) {
        const dup = existing.find(e => e.source !== 'manual' && contentHashOf(e) === hash);
        return { isDuplicate: true, reason: 'content_hash', duplicateOf: dup };
      }
    }
  }

  // Kept. Flag a cross-source content collision for later review (never delete).
  const collision = existing.some(e => e.source !== candidate.source && contentHashOf(e) === hash);
  return { isDuplicate: false, reviewFlag: collision ? 'needs_review' : undefined };
}

// ─── Transfers ───────────────────────────────────────────────────────────────

/** A merchant string that signals an internal movement (transfer or repayment). */
export function looksLikeInternalMovement(merchant: string): boolean {
  return isTransferMerchant(merchant) || looksLikeCardRepayment(merchant);
}

export interface TransferMatch {
  counterparty: Transaction;
}

/**
 * Find the counter-leg of an internal transfer for a single candidate against
 * existing transactions. Conservative — requires a DIFFERENT account, amount
 * equal to the cent, within 2 days, and at least one leg that looks like an
 * internal movement (transfer/PayID/BPAY or a credit-card repayment).
 *
 * This is the single-candidate extension of detectInternalTransferIds and
 * additionally recognises bank→credit-card repayments.
 */
export function findTransferMatch(
  candidate: Pick<Transaction, 'id' | 'account_id' | 'amount' | 'date' | 'merchant'>,
  existing: Transaction[],
): TransferMatch | undefined {
  const amt = Math.abs(candidate.amount);
  if (amt < 0.01) return undefined;
  const cTime = new Date(candidate.date).getTime();
  const candidateLooks = looksLikeInternalMovement(candidate.merchant);

  const match = existing.find(o => {
    if (o.id === candidate.id) return false;
    if (o.account_id === candidate.account_id) return false;
    // opposite direction, same magnitude to the cent
    if (Math.sign(o.amount) === Math.sign(candidate.amount)) return false;
    if (Math.abs(Math.abs(o.amount) - amt) > 0.01) return false;
    const gapDays = Math.abs(new Date(o.date).getTime() - cTime) / 86400000;
    if (gapDays > 2) return false;
    // High-confidence only: at least one side must look like an internal movement.
    return candidateLooks || looksLikeInternalMovement(o.merchant);
  });
  return match ? { counterparty: match } : undefined;
}

// ─── Spend definition (THE canonical rule) ───────────────────────────────────

export interface SpendOptions {
  /**
   * Pre-computed set of transaction ids to exclude from spend/income (internal
   * transfers + credit-card repayments). Both callers must pass the SAME set —
   * use computeTransferExclusionIds() to build it once — so every surface agrees.
   */
  excludeIds?: Set<string>;
  /**
   * Phase 2C — split lines keyed by parent transaction id. When a spend
   * transaction has splits, spendByCategory distributes it across the split
   * categories INSTEAD of its own single category (no double-counting), and its
   * per-category slices still sum to the parent magnitude so totals are
   * unchanged. Pass the SAME map to every surface so they agree.
   */
  splitsByTxId?: Map<string, { category: string; amount: number }[]>;
}

// ─── Refunds (Phase 2C) ───────────────────────────────────────────────────────

/** A confidently-matched refund (transaction_type='refund'). */
export function isRefundTransaction(t: Pick<Transaction, 'transaction_type'>): boolean {
  return t.transaction_type === 'refund';
}

/**
 * The amount a matched refund REDUCES net spend by (0 for a non-refund). A refund
 * is a positive inflow already excluded from spend by isSpendTransaction; here it
 * is netted against the category it reverses (its category is set to the original
 * purchase's at match time). An UNMATCHED inflow is never a refund, so never nets
 * — that is the conservative stance (see refundMatching.ts).
 */
export function refundReduction(t: Transaction, opts: SpendOptions = {}): number {
  if (!isRefundTransaction(t)) return 0;
  if (isTransferTransaction(t, opts)) return 0;
  const a = effectiveAmount(t);
  return a > 0 ? a : 0;
}

/**
 * THE canonical answer to "does this transaction count as spending?".
 *
 * A transaction is spending iff ALL hold:
 *   • it is a genuine OUTFLOW           (effective amount < 0)
 *   • it is NOT an internal transfer    (is_transfer / transfer_pair_id / excludeIds)
 *   • it is NOT a credit-card repayment (folded into excludeIds/looksLikeCardRepayment)
 *   • it is NOT income                  (category, and sign already handles it)
 *
 * Never `Math.abs(amount)` blindly — that is exactly the bug this replaces.
 *
 * REFUNDS (Phase 2A): a positive refund is an inflow, so it is excluded here —
 * and it is NEVER treated as income (income is sourced from income_entries, not
 * from positive transactions). It therefore neither adds to nor nets against
 * spending today. True net-of-refund spending needs refund identification
 * (matching a credit back to an earlier purchase), which is Phase 2B. When
 * `transaction_type` is later populated ('refund'), this is the single place to
 * net it against category spend — the data model is ready; the logic is not
 * wired now (no guessing from sign).
 */
export function isSpendTransaction(t: Transaction, opts: SpendOptions = {}): boolean {
  if (effectiveAmount(t) >= 0) return false;                 // income / credit / refund inflow
  if (isTransferTransaction(t, opts)) return false;           // internal movement (transfer/repayment)
  if (isNonSpendCategory(t.category)) return false;           // explicitly categorised out
  return true;
}

/** The positive spend magnitude of a transaction (0 if it isn't spend). */
export function spendAmount(t: Transaction, opts: SpendOptions = {}): number {
  return isSpendTransaction(t, opts) ? Math.abs(effectiveAmount(t)) : 0;
}

/**
 * Total NET spend over a set of transactions — genuine outflows, minus matched
 * refunds. Defined as the sum of spendByCategory so Accounts, Budget and the
 * backend integrationSummary all report the SAME figure. Splits don't change the
 * total (their lines sum to the parent magnitude); refunds reduce it.
 */
export function totalSpend(transactions: Transaction[], opts: SpendOptions = {}): number {
  const byCat = spendByCategory(transactions, opts);
  let sum = 0;
  for (const cat in byCat) sum += byCat[cat];
  return sum;
}

/**
 * NET spend grouped by category over an optional [start, end) window.
 *
 * Phase 2C reporting rules, all applied here so every surface agrees:
 *   • a SPLIT spend transaction is distributed across its split categories
 *     instead of its own category (counted once — no double-counting);
 *   • a matched REFUND (transaction_type='refund') SUBTRACTS from the category it
 *     reverses (its category is the original purchase's), netting spend;
 *   • per-category totals are floored at 0 so an over-refunded category can never
 *     show negative spend.
 */
export function spendByCategory(
  transactions: Transaction[],
  opts: SpendOptions & { start?: Date; end?: Date } = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (cat: string, amt: number) => {
    const key = cat || 'Uncategorised';
    out[key] = (out[key] ?? 0) + amt;
  };
  for (const t of transactions) {
    if (opts.start || opts.end) {
      const d = new Date(t.date);
      if (opts.start && d < opts.start) continue;
      if (opts.end && d >= opts.end) continue;
    }
    // Refund: net it against the category it reverses.
    const refund = refundReduction(t, opts);
    if (refund > 0) { add(t.category || 'Uncategorised', -refund); continue; }

    const amt = spendAmount(t, opts);
    if (amt <= 0) continue;
    // Split: distribute across the split lines instead of the parent category.
    const splits = opts.splitsByTxId?.get(t.id);
    if (splits && splits.length > 0) {
      for (const line of splits) {
        const m = Math.abs(Number(line.amount) || 0);
        if (m > 0) add(line.category || 'Uncategorised', m);
      }
    } else {
      add(t.category || 'Uncategorised', amt);
    }
  }
  // Floor each category at 0 — a category can't have negative spend.
  for (const cat in out) if (out[cat] < 0) out[cat] = 0;
  return out;
}

// ─── Transfer flow (per-account money movement) ──────────────────────────────
//
// Internal transfers are excluded from SPEND and INCOME everywhere (isSpend
// above, income sourced separately). But a single account still needs to show
// the money that entered or left it via those transfers, and its true net
// movement. These helpers make that visible WITHOUT reclassifying a transfer as
// a spending category — the transfer stays a transfer.

/**
 * Is this transaction an internal transfer leg? True when it is persisted as a
 * transfer (is_transfer / transfer_pair_id), typed as one (transaction_type ===
 * 'transfer'), or folded into the shared exclusion set (detected pairs +
 * credit-card repayments). This is the SAME notion of "internal movement" that
 * isSpendTransaction excludes, so transfer-in/out reconcile exactly against
 * spend: every non-income, non-spend outflow is a transfer-out, and so on.
 */
export function isTransferTransaction(t: Transaction, opts: SpendOptions = {}): boolean {
  return Boolean(
    t.is_transfer ||
    t.transfer_pair_id ||
    t.transaction_type === 'transfer' ||
    opts.excludeIds?.has(t.id),
  );
}

/** Positive amount entering the account via an internal transfer (0 otherwise). */
export function transferInAmount(t: Transaction, opts: SpendOptions = {}): number {
  if (!isTransferTransaction(t, opts)) return 0;
  const a = effectiveAmount(t);
  return a > 0 ? a : 0;
}

/** Positive amount leaving the account via an internal transfer (0 otherwise). */
export function transferOutAmount(t: Transaction, opts: SpendOptions = {}): number {
  if (!isTransferTransaction(t, opts)) return 0;
  const a = effectiveAmount(t);
  return a < 0 ? Math.abs(a) : 0;
}

/** Total money that entered the given transactions via internal transfers. */
export function totalTransferIn(transactions: Transaction[], opts: SpendOptions = {}): number {
  let sum = 0;
  for (const t of transactions) sum += transferInAmount(t, opts);
  return sum;
}

/** Total money that left the given transactions via internal transfers. */
export function totalTransferOut(transactions: Transaction[], opts: SpendOptions = {}): number {
  let sum = 0;
  for (const t of transactions) sum += transferOutAmount(t, opts);
  return sum;
}

/**
 * Signed net movement across the given transactions — every inflow minus every
 * outflow, transfers INCLUDED. This is the real change in the account's balance
 * from activity over the window, reported separately from spending (which
 * counts only genuine, non-transfer outflows).
 */
export function netMovement(transactions: Transaction[]): number {
  let sum = 0;
  for (const t of transactions) sum += effectiveAmount(t);
  return sum;
}

/**
 * Build the exclusion set that isSpendTransaction/spendByCategory consume: the
 * union of (a) persisted transfer legs, (b) freshly-detected internal transfer
 * pairs, and (c) credit-card repayment bank debits.
 *
 * `detectPairs` is injected (the existing detectInternalTransferIds) to avoid a
 * circular import and to keep this module pure. `isRepayment` defaults to the
 * text-only card-repayment signal but callers may pass a card-aware predicate.
 */
export function computeTransferExclusionIds(
  transactions: Transaction[],
  detectPairs: (txns: Transaction[]) => Set<string>,
  isRepayment: (t: Transaction) => boolean = t => t.account_type === 'bank' && t.amount < 0 && looksLikeCardRepayment(t.merchant),
): Set<string> {
  const ids = new Set<string>();
  for (const t of transactions) {
    if (t.is_transfer || t.transfer_pair_id || t.transaction_type === 'transfer') ids.add(t.id);
    if (isRepayment(t)) ids.add(t.id);
  }
  for (const id of detectPairs(transactions)) ids.add(id);
  return ids;
}
