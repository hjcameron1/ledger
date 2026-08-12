/**
 * Phase 2C — Needs Review queue (pure helpers).
 *
 * A transaction lands in review when the engine isn't confident enough to act
 * silently. Phase 2A already sets review_status='needs_review' on cross-source
 * content collisions (ambiguous duplicates); Phase 2C adds refund and low-
 * confidence classifier reasons. This module just READS the flags the ingestion
 * pipeline writes — it never mutates. The DS (transactionsDS) owns the three
 * actions (confirm / correct / dismiss) because those write through the store.
 *
 * PURE — no store, no network.
 */

import type { Transaction, ReviewReason } from './../types';

/** Is this transaction currently awaiting review? */
export function isNeedsReview(t: Pick<Transaction, 'review_status'>): boolean {
  return t.review_status === 'needs_review';
}

/** Every transaction awaiting review, newest first. */
export function reviewQueue(transactions: Transaction[]): Transaction[] {
  return transactions
    .filter(isNeedsReview)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/** Count of items awaiting review — drives the queue badge. */
export function reviewCount(transactions: Transaction[]): number {
  let n = 0;
  for (const t of transactions) if (isNeedsReview(t)) n++;
  return n;
}

/** Human-readable reason label for the queue UI. */
export function reviewReasonLabel(reason?: ReviewReason | null): string {
  switch (reason) {
    case 'ambiguous_duplicate': return 'Possible duplicate';
    case 'uncertain_merchant':  return 'Uncertain merchant / category';
    case 'possible_transfer':   return 'Possible transfer';
    case 'possible_refund':     return 'Possible refund';
    default:                    return 'Needs review';
  }
}

/** Group the review queue by reason, for a sectioned UI. */
export function reviewByReason(transactions: Transaction[]): Record<string, Transaction[]> {
  const out: Record<string, Transaction[]> = {};
  for (const t of reviewQueue(transactions)) {
    const key = t.review_reason ?? 'unknown';
    (out[key] ??= []).push(t);
  }
  return out;
}
