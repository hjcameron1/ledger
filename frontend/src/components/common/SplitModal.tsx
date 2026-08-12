import { useMemo, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { Select } from './Input';
import { useStore } from '../../store';
import { transactionSplitsDS } from '../../services/dataService';
import { validateSplits, splitTarget, type SplitLineInput } from '../../utils/transactionSplits';
import { useAllCategories } from '../../utils/categories';
import { formatCurrency } from '../../utils/format';
import type { Transaction } from '../../types';

/**
 * Phase 2C — Split a single transaction across multiple categories.
 *
 * Pure UI over transactionSplitsDS.setSplits(): the parent bank row is never
 * touched; these lines REPLACE its single category in reporting (see
 * transactionCore.spendByCategory). Save is blocked until the lines sum to the
 * parent's magnitude — the invariant that keeps totals identical and prevents
 * double-counting. Clearing all lines un-splits the transaction.
 */
export default function SplitModal({ tx, isOpen, onClose }: {
  tx: Transaction;
  isOpen: boolean;
  onClose: () => void;
}) {
  const categories = useAllCategories();
  const { transactionSplits, setTransactionSplits } = useStore();
  const currency = tx.display_currency ?? tx.currency ?? 'AUD';
  const target = splitTarget(tx.amount);

  // Seed from any existing splits; otherwise start with the parent's own category
  // as a single full-amount line the user can divide.
  const existing = useMemo(
    () => transactionSplits.filter(s => s.transaction_id === tx.id),
    [transactionSplits, tx.id],
  );
  const [lines, setLines] = useState<SplitLineInput[]>(() =>
    existing.length > 0
      ? existing.map(s => ({ category: s.category, amount: s.amount, notes: s.notes ?? '' }))
      : [
          { category: tx.category || categories[0] || 'Other', amount: target, notes: '' },
          { category: '', amount: 0, notes: '' },
        ],
  );

  const validation = validateSplits(lines.filter(l => l.category.trim() || Number(l.amount) > 0), tx.amount);
  const remaining = validation.remaining;

  const setLine = (i: number, patch: Partial<SplitLineInput>) =>
    setLines(ls => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(ls => [...ls, { category: '', amount: 0, notes: '' }]);
  const removeLine = (i: number) => setLines(ls => ls.filter((_, idx) => idx !== i));

  // Auto-fill an empty (or the last) line with whatever's left to reach the target.
  const fillRemaining = (i: number) => {
    const others = lines.reduce((s, l, idx) => idx === i ? s : s + Math.abs(Number(l.amount) || 0), 0);
    setLine(i, { amount: Math.max(0, Math.round((target - others) * 100) / 100) });
  };

  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const clean = lines
      .filter(l => l.category.trim() && Number(l.amount) > 0)
      .map(l => ({ category: l.category.trim(), amount: Math.abs(Number(l.amount)), notes: (l.notes ?? '').trim() || null }));
    const res = transactionSplitsDS.setSplits(tx.id, clean);
    if (!res.ok) {
      setError(res.validation?.error === 'sum_mismatch'
        ? `Splits must add up to ${formatCurrency(target, currency)}.`
        : 'Each line needs a category and a positive amount.');
      return;
    }
    setTransactionSplits(transactionSplitsDS.getAll());
    onClose();
  };

  const unsplit = () => {
    transactionSplitsDS.clear(tx.id);
    setTransactionSplits(transactionSplitsDS.getAll());
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Split transaction" size="md">
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1">
        {tx.merchant} · {formatCurrency(target, currency)}
      </p>
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">
        Divide this transaction across categories. The original bank transaction is left intact —
        your budgets and reports use these lines instead.
      </p>

      <div className="space-y-2 mb-3">
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              <Select
                value={line.category}
                onChange={e => setLine(i, { category: e.target.value })}
                options={[
                  { value: '', label: 'Choose category…' },
                  ...categories.map(c => ({ value: c, label: c })),
                ]}
              />
              <input
                className="input w-full mt-1 text-xs"
                placeholder="Note (optional)"
                value={line.notes ?? ''}
                onChange={e => setLine(i, { notes: e.target.value })}
              />
            </div>
            <div className="w-28 flex-shrink-0">
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-zinc-400 pointer-events-none">$</span>
                <input
                  type="number" inputMode="decimal" step="0.01" min="0"
                  className="input w-full pl-6 text-sm"
                  value={line.amount === 0 ? '' : line.amount}
                  onChange={e => setLine(i, { amount: parseFloat(e.target.value) || 0 })}
                  placeholder="0.00"
                />
              </div>
              <button
                type="button"
                onClick={() => fillRemaining(i)}
                className="text-[10px] text-brand hover:underline mt-1"
              >
                Fill rest
              </button>
            </div>
            <button
              type="button"
              onClick={() => removeLine(i)}
              disabled={lines.length <= 1}
              className="mt-2 text-zinc-400 hover:text-[#ef4444] disabled:opacity-30 disabled:hover:text-zinc-400"
              title="Remove line"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <button type="button" onClick={addLine} className="text-sm text-brand hover:underline mb-4">
        + Add category
      </button>

      {/* Remaining indicator */}
      <div className={`flex items-center justify-between px-3 py-2 rounded-[8px] mb-4 text-sm ${
        Math.abs(remaining) < 0.005
          ? 'bg-[#22c55e]/10 text-[#16a34a] dark:text-[#4ade80]'
          : 'bg-[#f59e0b]/10 text-[#9b8b3b] dark:text-[#d4c15e]'
      }`}>
        <span>{Math.abs(remaining) < 0.005 ? 'Balanced' : remaining > 0 ? 'Left to allocate' : 'Over by'}</span>
        <span className="font-semibold amount">
          {formatCurrency(Math.abs(remaining), currency)} of {formatCurrency(target, currency)}
        </span>
      </div>

      {error && <p className="text-xs text-[#ef4444] mb-3">{error}</p>}

      <div className="flex gap-2">
        {existing.length > 0 && (
          <Button variant="secondary" size="sm" onClick={unsplit}>Remove split</Button>
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" fullWidth disabled={!validation.ok} onClick={save}>
          Save split
        </Button>
      </div>
    </Modal>
  );
}
