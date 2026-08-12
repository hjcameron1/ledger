/**
 * Phase 2C — Conservative refund matching (pure core).
 *
 * Tries to match a POSITIVE inflow to an earlier PURCHASE it reverses, using:
 *   • same account (where appropriate)
 *   • same / canonical merchant (merchant_normalized or merchant_id)
 *   • compatible amount (full OR partial — never MORE than the purchase, net of
 *     any refunds already booked against it)
 *   • a reasonable forward date window (refund on/after the purchase)
 *
 * Philosophy (spec): "Do not guess when confidence is low; send it to Needs
 * Review." So there are exactly three outcomes:
 *   - matched → stamp transaction_type='refund' + refund_of + inherit the
 *               purchase's category, so it nets against that category's spend.
 *   - review  → ambiguous (several candidate purchases) or it would over-refund →
 *               flag review_status='needs_review', reason 'possible_refund'.
 *   - none    → not a refund; leave the inflow excluded from spend and income.
 *
 * PURE — no store, no network — so every branch is unit-testable.
 */

import type { Transaction } from '../types';
import { effectiveAmount, isTransferTransaction, isSpendTransaction, isNonSpendCategory } from './transactionCore';
import { normaliseMerchant } from './recurringDetection';

/** Cent tolerance so float drift never blocks an exact match. */
const EPS = 0.01;
/** How many days after a purchase a refund may still post and be auto-matched. */
export const REFUND_WINDOW_DAYS = 120;

export type RefundDecision =
  | { status: 'matched'; original: Transaction; confidence: number; partial: boolean }
  | { status: 'review'; reason: 'ambiguous' | 'over_refund' }
  | { status: 'none' };

function normKey(t: Pick<Transaction, 'merchant' | 'raw_description' | 'merchant_normalized'>): string {
  return t.merchant_normalized || normaliseMerchant(t.raw_description || t.merchant || '');
}

function daysBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000;
}

/** True when candidate and purchase resolve to the same merchant. */
function sameMerchant(candidate: Transaction, purchase: Transaction): boolean {
  if (candidate.merchant_id && purchase.merchant_id && candidate.merchant_id === purchase.merchant_id) return true;
  const a = normKey(candidate);
  const b = normKey(purchase);
  return a.length >= 3 && a === b;
}

/**
 * Sum of refunds ALREADY booked against a purchase (rows whose refund_of points
 * to it). Lets a second partial refund be checked against the remaining balance
 * so two partials can't quietly exceed the original.
 */
function alreadyRefunded(purchaseId: string, existing: Transaction[]): number {
  let sum = 0;
  for (const t of existing) {
    if (t.transaction_type === 'refund' && t.refund_of === purchaseId) {
      sum += Math.abs(effectiveAmount(t));
    }
  }
  return sum;
}

/**
 * Decide whether `candidate` (a positive inflow) is a refund of some earlier
 * purchase in `existing`. Conservative: a confident match needs a SINGLE
 * same-account, same-merchant purchase with enough un-refunded balance inside the
 * window. Several plausible purchases → review; an over-refund → review.
 */
export function classifyRefund(candidate: Transaction, existing: Transaction[]): RefundDecision {
  const amt = effectiveAmount(candidate);
  if (amt <= 0) return { status: 'none' };                       // only inflows can be refunds
  if (isTransferTransaction(candidate)) return { status: 'none' }; // transfer leg, not a refund
  if (candidate.transaction_type === 'income') return { status: 'none' };
  if (isNonSpendCategory(candidate.category) && (candidate.category || '').toLowerCase() === 'income') {
    return { status: 'none' };
  }
  const refundAmt = Math.abs(amt);
  const cDate = candidate.date;

  // Candidate purchases: genuine earlier spend at the same merchant, within the
  // forward window, that still has un-refunded balance to cover this refund.
  const candidates = existing.filter(p => {
    if (p.id === candidate.id) return false;
    if (!isSpendTransaction(p)) return false;                    // must be real spend (outflow, non-transfer)
    if (!sameMerchant(candidate, p)) return false;
    const gap = daysBetween(p.date, cDate);
    if (gap < -1 || gap > REFUND_WINDOW_DAYS) return false;      // refund on/after purchase (1d slack)
    return true;
  });

  if (candidates.length === 0) return { status: 'none' };

  // Prefer same-account purchases — a refund almost always posts to the card/
  // account that was charged. If any same-account candidate exists, restrict to
  // those; otherwise a cross-account single match is treated cautiously (review).
  const sameAccount = candidates.filter(p => p.account_id === candidate.account_id);
  const pool = sameAccount.length > 0 ? sameAccount : candidates;

  // Those with enough remaining (un-refunded) balance to absorb this refund.
  const affordable = pool.filter(p => {
    const remaining = Math.abs(effectiveAmount(p)) - alreadyRefunded(p.id, existing);
    return refundAmt <= remaining + EPS;
  });

  if (affordable.length === 0) {
    // Merchant + window matched but every candidate is already fully refunded (or
    // the amount exceeds the purchase) — don't guess; surface it.
    return { status: 'review', reason: 'over_refund' };
  }

  if (affordable.length > 1) {
    // Several purchases could be the one being refunded — ambiguous.
    return { status: 'review', reason: 'ambiguous' };
  }

  const original = affordable[0];
  const purchaseMag = Math.abs(effectiveAmount(original));
  const partial = refundAmt < purchaseMag - EPS;
  // Cross-account matches are inherently weaker.
  const confidence = sameAccount.length > 0 ? (partial ? 0.85 : 0.95) : 0.7;
  return { status: 'matched', original, confidence, partial };
}

/**
 * The candidate original purchases a positive inflow COULD be a refund of, using
 * the SAME conservative criteria as classifyRefund (same merchant, forward
 * window, un-refunded balance to cover the refund). READ-ONLY and additive — it
 * does not widen or change automatic matching; it just surfaces the pool so a
 * Needs-Review UI can show the likely original and let the user pick another.
 * Sorted best-first: same-account before cross-account, then closest amount, then
 * most recent. Returns [] when nothing plausibly matches.
 */
export function refundCandidates(candidate: Transaction, existing: Transaction[]): Transaction[] {
  const amt = effectiveAmount(candidate);
  if (amt <= 0) return [];
  if (isTransferTransaction(candidate)) return [];
  const refundAmt = Math.abs(amt);
  const cDate = candidate.date;

  const pool = existing.filter(p => {
    if (p.id === candidate.id) return false;
    if (!isSpendTransaction(p)) return false;
    if (!sameMerchant(candidate, p)) return false;
    const gap = daysBetween(p.date, cDate);
    if (gap < -1 || gap > REFUND_WINDOW_DAYS) return false;
    const remaining = Math.abs(effectiveAmount(p)) - alreadyRefunded(p.id, existing);
    return refundAmt <= remaining + EPS;                          // still affordable
  });

  return pool.sort((a, b) => {
    const aSame = a.account_id === candidate.account_id ? 0 : 1;
    const bSame = b.account_id === candidate.account_id ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;                    // same-account first
    const aDiff = Math.abs(Math.abs(effectiveAmount(a)) - refundAmt);
    const bDiff = Math.abs(Math.abs(effectiveAmount(b)) - refundAmt);
    if (Math.abs(aDiff - bDiff) > EPS) return aDiff - bDiff;      // closest amount
    return new Date(b.date).getTime() - new Date(a.date).getTime(); // most recent
  });
}
