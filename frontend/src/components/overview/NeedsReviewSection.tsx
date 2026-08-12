import { useMemo, useState } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { Select } from '../common/Input';
import { TransactionRow } from '../common/TransactionRow';
import { useStore } from '../../store';
import { transactionsDS, accountsDS, creditCardsDS } from '../../services/dataService';
import { reviewQueue, reviewReasonLabel } from '../../utils/reviewQueue';
import { refundCandidates } from '../../utils/refundMatching';
import { formatCurrency, formatDate } from '../../utils/format';
import type { Transaction } from '../../types';

/**
 * Phase 2C — Needs Review queue (UI).
 *
 * Surfaces every transaction the engine flagged review_status='needs_review'
 * (ambiguous duplicate, uncertain merchant/category, possible transfer, possible
 * refund) and lets the user resolve each one:
 *   • Confirm  → it's fine as-is                    (transactionsDS.confirmReview)
 *   • Correct  → fix merchant/category inline; routes through the SAME Phase 2B
 *                learning and clears the flag        (transactionsDS.correctReview)
 *   • Dismiss  → not worth reviewing                 (transactionsDS.dismissReview)
 *
 * Possible refunds get the dedicated refund controls (spec item 4): the likely
 * original purchase is shown, the user can pick a different candidate, confirm the
 * match (nets spend via the existing refund engine), or say it's not a refund.
 * Self-hides when the queue is empty.
 */
export default function NeedsReviewSection({ currency }: { currency: string }) {
  const { transactions, setTransactions, setAccounts, setCreditCards } = useStore();
  const queue = useMemo(() => reviewQueue(transactions), [transactions]);

  const refresh = () => {
    setTransactions(transactionsDS.getAll());
    setAccounts(accountsDS.getAll());
    setCreditCards(creditCardsDS.getAll());
  };

  if (queue.length === 0) return null;

  return (
    <Card className="mb-4" padding="none">
      <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <h2 className="font-semibold flex items-center gap-2">
          Needs review
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#9b8b3b] dark:text-[#d4c15e]">
            {queue.length}
          </span>
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          A few transactions the importer wasn't sure about. Confirm, correct or dismiss each.
        </p>
      </div>
      <div className="p-4 space-y-3">
        {queue.map(tx => (
          <ReviewItem key={tx.id} tx={tx} transactions={transactions} currency={currency} onResolved={refresh} />
        ))}
      </div>
    </Card>
  );
}

function ReviewItem({ tx, transactions, currency, onResolved }: {
  tx: Transaction;
  transactions: Transaction[];
  currency: string;
  onResolved: () => void;
}) {
  const isRefund = tx.review_reason === 'possible_refund';

  return (
    <div className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-50 dark:bg-zinc-900/60">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#9b8b3b] dark:text-[#d4c15e]">
          {reviewReasonLabel(tx.review_reason)}
        </span>
      </div>

      {/* The transaction itself. Inline category/merchant edits route through
          correctReview → Phase 2B learning + clears the review flag. */}
      <TransactionRow
        tx={tx}
        onCategoryChange={(id, category, scope) => { transactionsDS.correctReview(id, { category }, scope); onResolved(); }}
        onMerchantChange={(id, merchant, scope) => { transactionsDS.correctReview(id, { merchant }, scope); onResolved(); }}
        onDelete={(id) => { transactionsDS.removeAndReverseBalance(id); onResolved(); }}
      />

      {isRefund
        ? <RefundControls tx={tx} transactions={transactions} currency={currency} onResolved={onResolved} />
        : (
          <div className="flex gap-2 px-3 pb-3 pt-1">
            <Button variant="primary" size="sm" onClick={() => { transactionsDS.confirmReview(tx.id); onResolved(); }}>
              Confirm
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { transactionsDS.dismissReview(tx.id); onResolved(); }}>
              Dismiss
            </Button>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 self-center ml-1">
              …or change the category/merchant above to correct it.
            </span>
          </div>
        )}
    </div>
  );
}

/** Spec item 4 — confirm/repoint/reject a possible refund using the refund engine. */
function RefundControls({ tx, transactions, currency, onResolved }: {
  tx: Transaction;
  transactions: Transaction[];
  currency: string;
  onResolved: () => void;
}) {
  const candidates = useMemo(() => refundCandidates(tx, transactions), [tx, transactions]);
  const [chosenId, setChosenId] = useState<string>(() => candidates[0]?.id ?? '');
  const chosen = candidates.find(c => c.id === chosenId) ?? candidates[0];

  const confirmMatch = () => {
    if (!chosen) return;
    // Manual counterpart of automatic refund matching: mark it a refund of the
    // chosen purchase and inherit that purchase's category so it NETS spend.
    transactionsDS.correctReview(
      tx.id,
      { transaction_type: 'refund', category: chosen.category, refundOf: chosen.id },
      'only',
    );
    onResolved();
  };

  if (candidates.length === 0) {
    return (
      <div className="px-3 pb-3 pt-1">
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          No matching earlier purchase found. Leave it as an ordinary payment received, or dismiss.
        </p>
        <Button variant="secondary" size="sm" onClick={() => { transactionsDS.dismissReview(tx.id); onResolved(); }}>
          Not a refund
        </Button>
      </div>
    );
  }

  return (
    <div className="px-3 pb-3 pt-1">
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">Likely refund of:</p>
      {candidates.length === 1 ? (
        <p className="text-sm mb-2">
          <span className="font-medium">{chosen!.merchant}</span>{' '}
          <span className="text-zinc-500 dark:text-zinc-400">
            · {formatCurrency(Math.abs(chosen!.amount), currency)} · {formatDate(chosen!.date)}
          </span>
        </p>
      ) : (
        <Select
          className="mb-2"
          value={chosenId}
          onChange={e => setChosenId(e.target.value)}
          options={candidates.map(c => ({
            value: c.id,
            label: `${c.merchant} · ${formatCurrency(Math.abs(c.amount), currency)} · ${formatDate(c.date)}`,
          }))}
        />
      )}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={confirmMatch}>Confirm refund</Button>
        <Button variant="secondary" size="sm" onClick={() => { transactionsDS.dismissReview(tx.id); onResolved(); }}>
          Not a refund
        </Button>
      </div>
    </div>
  );
}
