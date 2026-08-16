/**
 * Bill → transaction payment (Phase 3.4, pure/store-free, unit-tested).
 *
 * A bill/reminder can be assigned to a bank account or credit card. When the user
 * manually ticks it paid, that payment is recorded as an ordinary MANUAL transaction
 * on the assigned account so it moves the balance and — crucially — enters the same
 * manual↔import reconciliation the rest of the app uses (see reconcile.ts). A later
 * Basiq/statement import of the same payment then reconciles against this transaction
 * instead of duplicating it.
 *
 * This module owns only the DECISION (sign, source, reconcile lifecycle, category)
 * so it can be tested in isolation; dataService wires the result to
 * transactionsDS.ingest + moveOwnerBalance.
 */
import type { Bill, TransactionSource } from '../types';

export type BillOwnerKind = 'bank' | 'credit_card';

export interface BillPaymentAccount {
  id: string;
  kind: BillOwnerKind;
  currency: string;
  /**
   * Whether the owner is a purely-manual (non-synced) account. Only affects the
   * initial reconcile_state: a live-synced owner's payment is 'pending' so the next
   * bank sync can reconcile it; a manual owner's payment carries no reconcile_state
   * (exactly like a hand-added transaction) — a statement import still reconciles it
   * because that path matches on content, not on reconcile_state.
   */
  is_manual: boolean;
}

/**
 * The transaction-ingest input transactionsDS.ingest expects (minus the fields it
 * derives). Structural on purpose — this module never imports the store.
 */
export interface BillPaymentIngest {
  account_id: string;
  account_type: BillOwnerKind;
  date: string;
  merchant: string;
  raw_description: string;
  amount: number;
  currency: string;
  category: string;
  category_source: 'user' | 'auto';
  is_duplicate_flagged: boolean;
  is_subscription: boolean;
  source: TransactionSource;
  reconcile_state: 'pending' | undefined;
}

export interface BillPaymentPlan {
  ingest: BillPaymentIngest;
  /**
   * Signed "money into the account is positive" delta for moveOwnerBalance. A bill
   * payment is money OUT of a bank (balance falls → negative) and a CHARGE that
   * RAISES a card's owing (moveOwnerBalance does `owing -= delta`, so a negative
   * delta raises owing) — one sign serves both, identical to `ingest.amount`.
   */
  balanceDelta: number;
}

/**
 * Only a payable BILL with a positive amount AND an assigned account produces a
 * transaction. Reminders (date nudges), unassigned bills, and zero-amount bills
 * return false — pay() just ticks those off (the pre-3.4 behaviour).
 */
export function canRecordBillPayment(
  bill: Pick<Bill, 'kind' | 'amount' | 'account_id' | 'account_type'>,
): boolean {
  return (
    (bill.kind ?? 'bill') !== 'reminder' &&
    !!bill.account_id &&
    !!bill.account_type &&
    Number.isFinite(bill.amount) &&
    Math.abs(bill.amount) > 0
  );
}

/**
 * Build the transaction + balance move for marking `bill` paid from `account`.
 * Returns null when the bill isn't payable to an account (see canRecordBillPayment).
 */
export function buildBillPayment({
  bill,
  account,
  asOf,
}: {
  bill: Bill;
  account: BillPaymentAccount;
  asOf: string;
}): BillPaymentPlan | null {
  if (!canRecordBillPayment(bill)) return null;

  const amount = -Math.abs(bill.amount); // outflow / charge — see balanceDelta note.
  const hasCategory = !!(bill.category && bill.category.trim());

  return {
    ingest: {
      account_id: account.id,
      account_type: account.kind,
      date: asOf,
      merchant: bill.name,
      raw_description: bill.name,
      amount,
      currency: account.currency,
      // A bill nearly always names a category; fall back to the natural default so a
      // recorded payment is never left uncategorised.
      category: hasCategory ? bill.category!.trim() : 'Bills',
      category_source: hasCategory ? 'user' : 'auto',
      is_duplicate_flagged: false,
      is_subscription: false,
      source: 'manual',
      // Live-synced owner → enter reconciliation ('pending'); manual owner → unset,
      // exactly like a hand-added transaction.
      reconcile_state: account.is_manual ? undefined : 'pending',
    },
    balanceDelta: amount,
  };
}
