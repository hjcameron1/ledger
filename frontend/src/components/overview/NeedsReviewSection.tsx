import { useEffect, useMemo, useState } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { Select } from '../common/Input';
import { TransactionRow } from '../common/TransactionRow';
import { useStore } from '../../store';
import { transactionsDS, accountsDS, creditCardsDS } from '../../services/dataService';
import { reviewQueue, reviewReasonLabel } from '../../utils/reviewQueue';
import { refundCandidates } from '../../utils/refundMatching';
import { needsAiFallback } from '../../utils/aiClassification';
import { getReviewCutoff, setReviewCutoffNow, isAfterReviewCutoff } from '../../utils/reviewCutoff';
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
/**
 * `standalone` renders this as its own page section (the Accounts → Needs Review
 * tab): it always shows — including a friendly empty state — and exposes a
 * "Clear all" action for the whole backlog. The default (Overview) mode keeps the
 * original behaviour of self-hiding when there is nothing to review.
 */
export default function NeedsReviewSection({ currency, standalone = false }: { currency: string; standalone?: boolean }) {
  const { transactions, user, setTransactions, setAccounts, setCreditCards } = useStore();

  // The "start fresh" line set by "Clear all". Held in state so clearing it
  // re-renders immediately; re-read if the signed-in user changes.
  const [cutoff, setCutoff] = useState<string | null>(() => getReviewCutoff(user?.id));
  useEffect(() => { setCutoff(getReviewCutoff(user?.id)); }, [user?.id]);

  // Only surface transactions added since the cutoff — the historical backlog is
  // suppressed so review works from new transactions only.
  const queue = useMemo(
    () => reviewQueue(transactions).filter(t => isAfterReviewCutoff(t, cutoff)),
    [transactions, cutoff],
  );
  // Rows the deterministic engine couldn't place and hasn't yet asked AI about.
  // These sit silently (review_status 'clear') — the button below asks the
  // model, which surfaces them here with a suggestion. Also gated by the cutoff.
  const aiPending = useMemo(
    () => transactions.filter(t => needsAiFallback(t, cutoff)).length,
    [transactions, cutoff],
  );
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const refresh = () => {
    // Write back the full VISIBLE set, never the scoped subset — narrowing the
    // shared store here would strip out directly-shared accounts, cards and their
    // transactions (scoping is a read-time concern, handled where totals are summed).
    setTransactions(transactionsDS.getVisible());
    setAccounts(accountsDS.getVisible());
    setCreditCards(creditCardsDS.getVisible());
  };

  const runAi = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const { requested, applied, error } = await transactionsDS.runAiFallback();
      // Distinguish a real failure from a genuine no-op so the user isn't left
      // watching the button reset with nothing to show for it.
      if (error) setAiError(error);
      else if (requested > 0 && applied === 0) {
        setAiError("The AI didn't return any suggestions this time — try again in a moment.");
      }
    } finally {
      setAiBusy(false);
      refresh();
    }
  };

  // Clear the ENTIRE current backlog — both the review queue and the silent
  // AI-suggestion pool — in one action, and only work from new transactions from
  // here on. Genuine review flags are resolved (persisted); the large silent pool
  // is dropped write-free via the cutoff. Reversible: nothing is deleted.
  const clearAll = () => {
    const n = queue.length + aiPending;
    if (n === 0) return;
    if (!window.confirm(`Clear all ${n} current item${n === 1 ? '' : 's'} from review? New transactions will still show up here.`)) return;
    transactionsDS.dismissAllReview();          // resolve real needs_review flags
    setCutoff(setReviewCutoffNow(user?.id));     // drop the silent backlog write-free
    refresh();
  };

  // Overview mode: stay out of the way when there's nothing to do.
  if (!standalone && queue.length === 0 && aiPending === 0) return null;

  return (
    <Card className="mb-4" padding="none">
      <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            Needs review
            {queue.length > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#9b8b3b] dark:text-[#d4c15e]">
                {queue.length}
              </span>
            )}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {queue.length > 0
              ? "A few transactions the importer wasn't sure about. Confirm, correct or dismiss each."
              : aiPending > 0
                ? `${aiPending} transaction${aiPending === 1 ? '' : 's'} couldn't be categorised automatically.`
                : 'Nothing to review right now.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {aiPending > 0 && (
            <div className="flex flex-col items-end gap-1">
              <Button variant="secondary" size="sm" disabled={aiBusy} onClick={runAi}>
                {aiBusy ? 'Thinking…' : `Suggest categories (${aiPending})`}
              </Button>
              {aiError && (
                <span className="text-[11px] text-right text-red-600 dark:text-red-400 max-w-[220px]">
                  {aiError}
                </span>
              )}
            </div>
          )}
          {(queue.length > 0 || aiPending > 0) && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Clear all
            </Button>
          )}
        </div>
      </div>
      {queue.length > 0 ? (
        <div className="p-4 space-y-3">
          {queue.map(tx => (
            <ReviewItem key={tx.id} tx={tx} transactions={transactions} currency={currency} onResolved={refresh} />
          ))}
        </div>
      ) : aiPending > 0 ? (
        <div className="px-5 py-10">
          <p className="text-sm font-medium">
            {aiPending} transaction{aiPending === 1 ? '' : 's'} still {aiPending === 1 ? 'has' : 'have'} no category
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-md">
            The importer couldn't place {aiPending === 1 ? 'it' : 'them'} from the description alone.
            Suggest categories to have a model take a guess you can accept or ignore, or clear them
            and work from new transactions only.
          </p>
        </div>
      ) : (
        <div className="px-5 py-10">
          <p className="text-sm font-medium">Nothing to review</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Transactions the importer isn't sure about will land here.
          </p>
        </div>
      )}
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
        onCategoryChange={(id, category, scope, splits) => { transactionsDS.correctReview(id, { category }, scope, { splits }); onResolved(); }}
        onMerchantChange={(id, merchant, scope) => { transactionsDS.correctReview(id, { merchant }, scope); onResolved(); }}
        onEntityChange={(id, entity, scope) => { if (entity === null) transactionsDS.update(id, { entity: null }); else transactionsDS.applyCorrection(id, { entity }, scope); }}
        onDelete={(id) => { transactionsDS.removeAndReverseBalance(id); onResolved(); }}
      />

      {isRefund
        ? <RefundControls tx={tx} transactions={transactions} currency={currency} onResolved={onResolved} />
        : (
          <>
            {tx.ai_classified_at && <AiSuggestion tx={tx} onResolved={onResolved} />}
            <div className="flex gap-2 px-3 pb-3 pt-1">
              <Button variant="primary" size="sm" onClick={() => { transactionsDS.confirmReview(tx.id); onResolved(); }}>
                Confirm
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { transactionsDS.dismissReview(tx.id); onResolved(); }}>
                Dismiss
              </Button>
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400 self-center ml-1">
                …or change the category/merchant above to correct it.
              </span>
            </div>
          </>
        )}
    </div>
  );
}

/**
 * Phase 2D.3 — the AI fallback's suggestion for a row the deterministic engine
 * couldn't place. The suggested category is already applied (category_source
 * 'ai'), shown in the row above; this banner explains it and lets the user accept
 * it (which promotes it to a user choice and can teach future matching) in one
 * click. It NEVER acts on its own — the user always confirms.
 */
function AiSuggestion({ tx, onResolved }: { tx: Transaction; onResolved: () => void }) {
  const cat = tx.ai_suggested_category;
  const merchant = tx.ai_suggested_merchant;
  const reason = tx.ai_suggested_reason;
  const pct = tx.ai_confidence != null ? Math.round(tx.ai_confidence * 100) : null;

  const accept = () => {
    // Apply the full suggestion as the user's choice (also learns for the future
    // via the Phase 2B correction path) and clears the review flag.
    if (cat || merchant) {
      transactionsDS.correctReview(
        tx.id,
        { ...(cat ? { category: cat } : {}), ...(merchant ? { merchant } : {}) },
        'future',
      );
    } else {
      transactionsDS.confirmReview(tx.id);
    }
    onResolved();
  };

  return (
    // Purple-and-sparkles is what every app in the world uses to mean "a model
    // said this", which is precisely why it stopped meaning anything. A guess is
    // a guess: it gets a plain surface, a quiet label, and its confidence stated
    // in words rather than dressed up.
    <div className="mx-3 mt-2 rounded-[10px] bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-700/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-zinc-600 dark:text-zinc-300 min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
            Suggested
          </span>{' '}
          {cat
            ? <span className="font-medium text-zinc-900 dark:text-zinc-100">{cat}</span>
            : <span className="italic">no category</span>}
          {merchant && <span> · {merchant}</span>}
          {pct != null && <span className="text-zinc-500 dark:text-zinc-400"> · {pct}% sure</span>}
          {reason && <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">{reason}</div>}
        </div>
        {(cat || merchant) && (
          <Button variant="primary" size="sm" onClick={accept}>Accept</Button>
        )}
      </div>
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
