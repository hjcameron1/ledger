/**
 * Phase 2A — canonical spend definition (backend mirror).
 *
 * This intentionally mirrors frontend/src/utils/transactionCore.ts so that
 * Ledger returns the SAME spending total everywhere. A transaction counts as
 * spending iff it is a genuine outflow that is NOT an internal transfer, NOT a
 * credit-card repayment, and NOT income.
 *
 * The backend relies on the PERSISTED foundation flags (is_transfer, category,
 * source) written by the client's ingestion pipeline, plus a text fallback for
 * credit-card repayments on rows not yet flagged.
 */

export const CC_PAYMENT_PATTERNS = [
  'AMEX', 'AMERICAN EXPRESS', 'VISA PAYMENT', 'MASTERCARD', 'MASTERCARD PAYMENT',
  'CREDIT CARD PAYMENT', 'CREDIT CARD', 'ANZ CREDIT', 'CBA CREDIT', 'NAB CREDIT',
  'WESTPAC CREDIT', 'ING CREDIT', 'COMMBANK CREDIT', 'BANKWEST CREDIT',
];

export function looksLikeCardRepayment(merchant?: string | null): boolean {
  const m = (merchant || '').toUpperCase();
  return CC_PAYMENT_PATTERNS.some(p => m.includes(p));
}

function isNonSpendCategory(category?: string | null): boolean {
  const c = (category || '').trim().toLowerCase();
  return c === 'transfer' || c === 'income';
}

export interface SpendRow {
  amount: number | string;
  category?: string | null;
  is_transfer?: boolean | null;
  transfer_pair_id?: string | null;
  transaction_type?: string | null;
  account_type?: string | null;
  merchant?: string | null;
}

/** THE canonical "is this spending?" test — kept in lockstep with the frontend. */
export function isSpendRow(t: SpendRow): boolean {
  const amount = Number(t.amount) || 0;
  if (amount >= 0) return false;                                   // inflow / income / refund
  if (t.is_transfer || t.transfer_pair_id || t.transaction_type === 'transfer') return false; // transfer leg
  if (isNonSpendCategory(t.category)) return false;               // categorised out
  if (t.account_type === 'bank' && looksLikeCardRepayment(t.merchant)) return false; // CC repayment
  return true;
}

/** A matched refund (transaction_type='refund') that nets against spend. */
export function isRefundRow(t: SpendRow): boolean {
  return t.transaction_type === 'refund' && (Number(t.amount) || 0) > 0;
}

/**
 * NET spend over rows — genuine outflows minus matched refunds. Mirrors the
 * frontend transactionCore.totalSpend (Phase 2C): spend is bucketed by category,
 * refunds subtract from the category they reverse, and each category is floored
 * at 0, so backend and frontend report the SAME figure.
 *
 * Splits don't need handling here: split lines sum to the parent magnitude, so a
 * split transaction contributes the same total as an unsplit one — the backend
 * summary total is unaffected. (Per-category backend reporting would consult
 * transaction_splits; today only the total is exposed.)
 */
export function totalSpend(rows: SpendRow[]): number {
  const byCat: Record<string, number> = {};
  const add = (cat: string | null | undefined, amt: number) => {
    const key = (cat || 'Uncategorised').trim() || 'Uncategorised';
    byCat[key] = (byCat[key] ?? 0) + amt;
  };
  for (const t of rows) {
    if (isRefundRow(t)) { add(t.category, -Math.abs(Number(t.amount) || 0)); continue; }
    if (isSpendRow(t)) add(t.category, Math.abs(Number(t.amount) || 0));
  }
  let sum = 0;
  for (const cat in byCat) sum += Math.max(0, byCat[cat]);
  return sum;
}
