/**
 * Manual ↔ bank-sync reconciliation (pure, store-free, unit-tested).
 *
 * When a user adds a transaction by hand to a LIVE-SYNCED (Basiq-linked) account,
 * the next bank sync may:
 *   • contain the same transaction        → EXACT   (bank authoritative; drop the manual dup)
 *   • contain a similar-but-not-identical  → CONFLICT (amount off by a few dollars, or the
 *                                                       merchant spelled differently → ask)
 *   • not contain it at all                → NONE    (after a grace period, ask "keep it?")
 *
 * All amounts here are in the account's OWN currency (the `amount` column). Both a
 * manual entry and a Basiq entry on the same account share that currency, so we
 * compare raw amounts and never the display-converted value.
 *
 * This module deliberately mirrors the shape of transactionCore.ts: no imports of
 * the store, everything pure so the matching policy is testable in isolation.
 */
import type { Transaction } from '../types';
import { contentHashOf } from './transactionCore';
import { normaliseMerchant } from './recurringDetection';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A manual entry is only chased as "missing" once it's this old AND a sync has run. */
export const RECONCILE_GRACE_DAYS = 3;
/** Exact-match date window (same event posted a day or two later). */
const EXACT_DATE_WINDOW_DAYS = 2;
/** Fuzzy-match date window. */
const CONFLICT_DATE_WINDOW_DAYS = 4;
/** Amount is "near" if within max($2, 3%) of the larger magnitude. */
const AMOUNT_ABS_TOLERANCE = 2;
const AMOUNT_PCT_TOLERANCE = 0.03;
/** Levenshtein-ratio threshold above which two merchant keys count as "similar". */
const MERCHANT_SIM_THRESHOLD = 0.5;

export type ReconcileState = NonNullable<Transaction['reconcile_state']>;

// ─── Small numeric / string helpers ──────────────────────────────────────────

/** Absolute magnitude in whole cents (avoids float noise on ==). */
function cents(amount: number): number {
  return Math.round(Math.abs(amount) * 100);
}

function daysApart(a?: string | null, b?: string | null): number {
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(ta - tb) / DAY_MS;
}

/** Same sign (both outflow or both inflow). Zero never matches. */
function sameDirection(a: number, b: number): boolean {
  return (a < 0 && b < 0) || (a > 0 && b > 0);
}

/** Amounts equal to the cent. */
function amountExact(a: number, b: number): boolean {
  return cents(a) === cents(b);
}

/** Amounts within tolerance (includes exact). */
function amountNear(a: number, b: number): boolean {
  const ca = Math.abs(a), cb = Math.abs(b);
  const tol = Math.max(AMOUNT_ABS_TOLERANCE, AMOUNT_PCT_TOLERANCE * Math.max(ca, cb));
  return Math.abs(ca - cb) <= tol;
}

/** Normalised, lower-cased merchant key for fuzzy comparison. */
function merchantKey(t: Pick<Transaction, 'merchant' | 'merchant_normalized' | 'raw_description'>): string {
  const base = t.merchant_normalized || normaliseMerchant(t.raw_description || t.merchant || '');
  return base.trim().toLowerCase();
}

/** Levenshtein edit distance (iterative, single-row). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1 similarity between two strings (1 = identical). */
export function merchantSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

/** True when the two keys share at least one meaningful (3+ char) token. */
function tokenOverlap(a: string, b: string): boolean {
  const tokens = (s: string) => s.split(/\s+/).filter(t => t.length >= 3);
  const ta = new Set(tokens(a));
  if (ta.size === 0) return false;
  return tokens(b).some(t => ta.has(t));
}

/** Two merchant keys are "related" (same or clearly a spelling/format variant). */
function merchantsRelated(a: string, b: string): boolean {
  return merchantSimilarity(a, b) >= MERCHANT_SIM_THRESHOLD || tokenOverlap(a, b);
}

// ─── Classification ───────────────────────────────────────────────────────────

export type ManualMatchResult = 'exact' | 'conflict' | 'none';

export interface ManualMatch {
  result: ManualMatchResult;
  /** The synced transaction that matched (for exact) or is the near-twin (for conflict). */
  candidate?: Transaction;
}

/**
 * Decide how a manual transaction relates to the transactions a bank sync brought
 * in for the SAME account.
 *
 *   EXACT    — same content_hash, OR same signed amount + same merchant key within
 *              ±2 days. The bank's row is authoritative; the manual dup is dropped.
 *   CONFLICT — plausibly the same event but not identical: a related merchant AND an
 *              amount within tolerance (covers "off by a few dollars" and "merchant
 *              spelled differently"). Surfaced to the user to resolve.
 *   NONE     — nothing comparable; the manual entry stands (missing-prompt handled by
 *              the grace-period gate, not here).
 */
export function classifyManualAgainstSync(
  manual: Transaction,
  syncedTxns: Transaction[],
): ManualMatch {
  const mAmt = manual.amount;
  const mHash = contentHashOf(manual);
  const mKey = merchantKey(manual);

  // 1. Exact — strongest first.
  for (const s of syncedTxns) {
    if (contentHashOf(s) === mHash) return { result: 'exact', candidate: s };
  }
  for (const s of syncedTxns) {
    if (!sameDirection(s.amount, mAmt)) continue;
    if (!amountExact(s.amount, mAmt)) continue;
    if (merchantKey(s) === mKey && daysApart(s.date, manual.date) <= EXACT_DATE_WINDOW_DAYS) {
      return { result: 'exact', candidate: s };
    }
  }

  // 2. Conflict — best near-twin above threshold.
  let best: { candidate: Transaction; score: number } | undefined;
  for (const s of syncedTxns) {
    if (!sameDirection(s.amount, mAmt)) continue;
    if (daysApart(s.date, manual.date) > CONFLICT_DATE_WINDOW_DAYS) continue;
    if (!amountNear(s.amount, mAmt)) continue;
    const sim = merchantSimilarity(merchantKey(s), mKey);
    if (!merchantsRelated(merchantKey(s), mKey)) continue;
    // Rank: amount closeness (0.6) then merchant similarity (0.4).
    const denom = Math.max(1, Math.abs(mAmt));
    const amtScore = 1 - Math.min(1, Math.abs(Math.abs(s.amount) - Math.abs(mAmt)) / denom);
    const score = amtScore * 0.6 + sim * 0.4;
    if (!best || score > best.score) best = { candidate: s, score };
  }
  if (best) return { result: 'conflict', candidate: best.candidate };

  return { result: 'none' };
}

// ─── Missing-prompt timing ────────────────────────────────────────────────────

/**
 * Should we ask the user "this wasn't in your bank sync — keep it?" for a manual
 * entry? Only when it's still `pending`, older than the grace period, at least one
 * sync has run since it was added, and — if the user previously deferred — a NEWER
 * sync has happened since that deferral.
 */
export function isMissingPromptDue(
  manual: Pick<Transaction, 'reconcile_state' | 'created_at' | 'reconcile_checked_at'>,
  lastSyncAt: number | null,
  now: number = Date.now(),
): boolean {
  if (manual.reconcile_state !== 'pending') return false;
  const created = manual.created_at ? new Date(manual.created_at).getTime() : now;
  if (now - created < RECONCILE_GRACE_DAYS * DAY_MS) return false;   // still within grace
  if (!lastSyncAt || lastSyncAt < created) return false;             // no sync since it was added
  if (manual.reconcile_checked_at) {
    const checked = new Date(manual.reconcile_checked_at).getTime();
    if (!Number.isNaN(checked) && lastSyncAt <= checked) return false; // deferred; no newer sync yet
  }
  return true;
}

// ─── Balance layering ─────────────────────────────────────────────────────────

/**
 * The net signed adjustment a set of manual transactions makes to a linked
 * account's authoritative bank balance. Only `pending` (optimistically shown) and
 * `kept` (bank never showed it) contribute; `conflict`/`resolved` are already
 * reflected in the bank figure. Amounts are in the account's own currency.
 */
export function manualAdjustment(manualTxns: Transaction[]): number {
  let sum = 0;
  for (const t of manualTxns) {
    if (t.reconcile_state === 'pending' || t.reconcile_state === 'kept') sum += t.amount;
  }
  return sum;
}
