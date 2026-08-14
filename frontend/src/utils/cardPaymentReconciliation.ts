/**
 * Credit-card payment reconciliation — pure predicates.
 *
 * A bank transaction that pays a credit card is confirmed EITHER automatically
 * (a matching statement was ticked off) OR by the user answering the card-payment
 * popup ("which card?" / "was this the whole amount?"). Both paths persist the
 * decision the same way: a `PendingPayment` with status 'reconciled' and
 * `reconciled_transaction_id` pointing back at the bank transaction.
 *
 * Once that relationship exists it is authoritative — the review system must
 * recognise it and never raise the popup (or a Needs Review item) for the same
 * transaction again. These helpers are the single source of that truth, kept pure
 * (no store, no network) so the reconciliation flow and its tests share one rule.
 */

import type { PendingPayment, CcPaymentPrompt } from '../types';

/**
 * True when a confirmed (reconciled) card payment already exists for this bank
 * transaction — i.e. the user or auto-apply has settled which card it clears.
 * This is the persisted, refresh-surviving record of the decision.
 */
export function isTransactionReconciled(
  txId: string,
  pendingPayments: Pick<PendingPayment, 'status' | 'reconciled_transaction_id'>[],
): boolean {
  return pendingPayments.some(
    p => p.status === 'reconciled' && p.reconciled_transaction_id === txId,
  );
}

/**
 * Every confirmed (reconciled) card payment linked to this bank transaction. Used
 * when the transaction is being deleted: if it settled a card, we must offer to
 * reverse that payment too, otherwise deleting an accidental transaction would
 * leave the card falsely marked paid.
 */
export function linkedCardPayments<T extends Pick<PendingPayment, 'status' | 'reconciled_transaction_id'>>(
  txId: string,
  pendingPayments: T[],
): T[] {
  return pendingPayments.filter(
    p => p.status === 'reconciled' && p.reconciled_transaction_id === txId,
  );
}

/**
 * Every confirmed (reconciled) payment made toward a given card, newest first.
 * A card payment recorded from a bank transaction updates the card's statement /
 * balance but does NOT create a card-side transaction row, so without this the
 * card's own page shows no evidence a payment was ever made. This surfaces those
 * payments for display. `date` prefers the paying bank transaction's date, then
 * the payment's own updated/created timestamp.
 */
export function reconciledPaymentsForCard<
  T extends Pick<PendingPayment, 'id' | 'credit_card_id' | 'status' | 'amount' | 'statement_id' | 'reconciled_transaction_id' | 'created_at' | 'updated_at'>
>(
  cardId: string,
  pendingPayments: T[],
  txDateById?: (txId: string | undefined) => string | undefined,
): (T & { date: string })[] {
  return pendingPayments
    .filter(p => p.status === 'reconciled' && p.credit_card_id === cardId)
    .map(p => ({
      ...p,
      date: (txDateById?.(p.reconciled_transaction_id))
        ?? (p.updated_at ?? p.created_at ?? '').slice(0, 10),
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** True when a card-payment popup is already open for this transaction. */
export function hasOpenCardPrompt(
  txId: string,
  prompts: Pick<CcPaymentPrompt, 'transaction_id'>[],
): boolean {
  return prompts.some(p => p.transaction_id === txId);
}

/**
 * Should we raise a card-payment popup for this transaction? Only when it is not
 * already reconciled AND no popup for it is already open. A confirmed relationship
 * is therefore never re-questioned, and we never stack two popups on one record.
 */
export function shouldPromptCardPayment(
  txId: string,
  pendingPayments: Pick<PendingPayment, 'status' | 'reconciled_transaction_id'>[],
  prompts: Pick<CcPaymentPrompt, 'transaction_id'>[],
): boolean {
  return !isTransactionReconciled(txId, pendingPayments) && !hasOpenCardPrompt(txId, prompts);
}
