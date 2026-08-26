import Modal from '../common/Modal';
import Button from '../common/Button';
import { useStore } from '../../store';
import { formatCurrency, formatDate } from '../../utils/format';

/**
 * Phase 5.1 — the bottom of the drill-down.
 *
 * Every figure in the FY summary traces to a line, and every line that came from
 * a transaction traces to THIS: the actual row, exactly as Ledger holds it. It
 * reads the store by id and edits nothing — the point is to answer "what is this
 * number made of?" without leaving the Tax page.
 */
export default function SourceTransactionModal({ transactionId, onClose }: {
  transactionId: string | null;
  onClose: () => void;
}) {
  const transactions = useStore(s => s.transactions);
  const accounts = useStore(s => s.accounts);
  const userId = useStore(s => s.user?.id ?? null);
  // The drill-down is the visible face of the tax position, so it obeys the
  // same rule: own rows only. The store holds rows shared into view; a tax
  // figure is never made of one, so neither is its evidence.
  const found = transactionId ? transactions.find(t => t.id === transactionId) : null;
  const tx = found && (!userId || !found.user_id || found.user_id === userId) ? found : null;

  if (!transactionId) return null;

  const currency = tx?.display_currency ?? tx?.currency ?? 'AUD';
  const account = tx ? accounts.find(a => a.id === tx.account_id) : null;
  const amount = tx ? (tx.display_amount ?? tx.amount) : 0;

  const rows: [string, string | null][] = tx
    ? [
        ['Date', formatDate(tx.date)],
        ['Amount', `${amount < 0 ? '−' : '+'}${formatCurrency(Math.abs(amount), currency)}`],
        ['Account', account?.name ?? null],
        ['Category', tx.category || null],
        ['Entity', tx.entity ? (tx.entity === 'business' ? 'Business' : 'Personal') : 'Unspecified (treated as personal)'],
        ['Deduction category', tx.deduction_category || null],
        ['Tax note', tx.tax_note || null],
        ['Receipt / evidence', tx.receipt_ref || null],
        ['Original description', tx.raw_description || null],
      ]
    : [];

  return (
    <Modal isOpen onClose={onClose} title="Source transaction" size="md">
      {!tx ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          This transaction isn't loaded right now — only recent months are held on the
          device. Open the Transactions page for the period to see it in full.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <p className="font-medium truncate">{tx.merchant || 'Transaction'}</p>
            {tx.is_tax_deductible && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#22c55e]/10 text-[#22c55e]">
                marked deductible
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {rows.filter(([, v]) => !!v).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-1.5 border-b border-zinc-100 dark:border-zinc-800">
                <span className="text-sm text-zinc-500 dark:text-zinc-400 shrink-0">{label}</span>
                <span className="text-sm text-right break-words">{value}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-5">
        <Button variant="secondary" size="sm" fullWidth onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
