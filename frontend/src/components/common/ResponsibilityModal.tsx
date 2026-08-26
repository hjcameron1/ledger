import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { Select } from './Input';
import { useStore } from '../../store';
import { sharingDS, transactionHouseholds } from '../../services/dataService';
import { activeMembers } from '../../utils/household';
import { validateResponsibilitySplit } from '../../utils/sharedSpending';
import { formatCurrency } from '../../utils/format';
import type { Transaction, ResponsibilityLine } from '../../types';

/**
 * Phase 7.2 — who paid for a shared transaction, and whose spending it was.
 *
 * Pure UI over sharingDS.setAttribution(): one write carrying who paid plus
 * either a single responsible member or a split between several, by dollar
 * amounts or by percentages. Save is blocked until a split accounts for the
 * whole transaction — the category-split invariant transplanted, so shared
 * spending is distributed between people and never multiplied. All of it is
 * reporting metadata on the one transaction that already exists: nothing here
 * can move a balance, and Ledger records no debt between anybody.
 */
export default function ResponsibilityModal({ tx, isOpen, onClose }: {
  tx: Transaction;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { user, householdMembers } = useStore();
  const currency = tx.display_currency ?? tx.currency ?? 'AUD';
  const target = Math.abs(tx.amount) || 0;

  // The people this transaction can be attributed to: every active member of
  // every household it is VISIBLE to — its own stamps or its shared account's
  // (transactionHouseholds), so a joint-account purchase offers the household
  // even when the row itself was never individually shared. Deduped across
  // households; the owner is always offered even if their membership row
  // hasn't loaded.
  const members = useMemo(() => {
    const seen = new Map<string, { userId: string; label: string }>();
    for (const hh of transactionHouseholds(tx)) {
      for (const m of activeMembers(householdMembers, hh)) {
        if (!seen.has(m.user_id)) {
          seen.set(m.user_id, {
            userId: m.user_id,
            label: (m.name || m.email || 'Member') + (m.user_id === user?.id ? ' (you)' : ''),
          });
        }
      }
    }
    if (tx.user_id && !seen.has(tx.user_id)) {
      seen.set(tx.user_id, {
        userId: tx.user_id,
        label: tx.user_id === user?.id ? 'You' : 'The owner',
      });
    }
    return [...seen.values()];
  }, [tx, householdMembers, user?.id]);

  const owner = tx.user_id ?? user?.id ?? '';

  type Mode = 'one' | 'amount' | 'percent';
  const [payer, setPayer] = useState(owner);
  const [mode, setMode] = useState<Mode>('one');
  const [responsible, setResponsible] = useState(owner);
  const [lines, setLines] = useState<ResponsibilityLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Seed from what the row already says, every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setPayer(tx.paid_by_user_id ?? owner);
    setError(null);
    const stored = tx.responsibility_split ?? [];
    if (stored.length) {
      const byPercent = stored.every(l => l.percent !== undefined);
      setMode(byPercent ? 'percent' : 'amount');
      setLines(stored.map(l => ({ ...l })));
      setResponsible(owner);
    } else {
      setMode('one');
      setResponsible(tx.responsible_user_id ?? owner);
      setLines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, tx.id]);

  // Switching into a split mode starts from an even division between everybody
  // in the household — the split people usually mean, one edit away from any
  // other. Switching between amount and percent re-expresses the same people.
  const seedLines = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === 'one') return;
    setLines(prev => {
      const people = prev.length ? prev.map(l => l.user_id) : members.map(m => m.userId);
      if (nextMode === 'percent') {
        const even = Math.floor(10000 / people.length) / 100;
        return people.map((u, i) => ({
          user_id: u,
          percent: i === people.length - 1
            ? Math.round((100 - even * (people.length - 1)) * 100) / 100
            : even,
        }));
      }
      const even = Math.floor((target * 100) / people.length) / 100;
      return people.map((u, i) => ({
        user_id: u,
        amount: i === people.length - 1
          ? Math.round((target - even * (people.length - 1)) * 100) / 100
          : even,
      }));
    });
  };

  const setLine = (i: number, patch: Partial<ResponsibilityLine>) =>
    setLines(ls => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => {
    const used = new Set(lines.map(l => l.user_id));
    const next = members.find(m => !used.has(m.userId))?.userId ?? '';
    setLines(ls => [...ls, mode === 'percent' ? { user_id: next, percent: 0 } : { user_id: next, amount: 0 }]);
  };
  const removeLine = (i: number) => setLines(ls => ls.filter((_, idx) => idx !== i));

  const validation = mode === 'one' ? null : validateResponsibilitySplit(lines, tx.amount);
  const remaining = validation?.remaining ?? 0;
  const unit = mode === 'percent' ? '%' : '$';

  const save = () => {
    const result = sharingDS.setAttribution(tx.id, mode === 'one'
      ? { paidBy: payer, responsible, split: null }
      : { paidBy: payer, split: lines });
    if (!result.ok) { setError(result.error ?? 'Could not save that.'); return; }
    onClose();
  };

  const memberOptions = members.map(m => ({ value: m.userId, label: m.label }));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Who paid & who's responsible" size="md">
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1">
        {tx.merchant} · {formatCurrency(target, currency)}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
        Reporting only — this moves the spend between people's columns in the
        household summary. No balance changes, and nothing is owed or recorded
        against anyone.
      </p>

      <div className="mb-4">
        <Select
          label="Paid by"
          value={payer}
          onChange={e => setPayer(e.target.value)}
          options={memberOptions}
        />
      </div>

      <p className="text-sm font-medium mb-1.5">Whose spending is it?</p>
      <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1 mb-3">
        {([['one', 'One person'], ['amount', 'Split by amount'], ['percent', 'Split by %']] as [Mode, string][]).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => seedLines(m)}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              mode === m
                ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'one' ? (
        <div className="mb-4">
          <Select
            value={responsible}
            onChange={e => setResponsible(e.target.value)}
            options={memberOptions}
          />
        </div>
      ) : (
        <>
          <div className="space-y-2 mb-3">
            {lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1">
                  <Select
                    value={line.user_id}
                    onChange={e => setLine(i, { user_id: e.target.value })}
                    options={[{ value: '', label: 'Choose member…' }, ...memberOptions]}
                  />
                </div>
                <div className="w-28 flex-shrink-0 relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-zinc-400 pointer-events-none">{unit}</span>
                  <input
                    type="number" inputMode="decimal" step="0.01" min="0"
                    aria-label="Member share"
                    className="input w-full pl-6 text-sm"
                    value={(mode === 'percent' ? line.percent : line.amount) || ''}
                    onChange={e => {
                      const v = parseFloat(e.target.value) || 0;
                      setLine(i, mode === 'percent' ? { percent: v, amount: undefined } : { amount: v, percent: undefined });
                    }}
                    placeholder="0"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={lines.length <= 1}
                  className="text-zinc-400 hover:text-[#ef4444] disabled:opacity-30 disabled:hover:text-zinc-400"
                  title="Remove line"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {lines.length < members.length && (
            <button type="button" onClick={addLine} className="text-sm text-brand hover:underline mb-3">
              + Add person
            </button>
          )}
          <div className={`flex items-center justify-between px-3 py-2 rounded-[8px] mb-4 text-sm ${
            validation?.ok
              ? 'bg-[#22c55e]/10 text-[#16a34a] dark:text-[#4ade80]'
              : 'bg-[#f59e0b]/10 text-[#9b8b3b] dark:text-[#d4c15e]'
          }`}>
            <span>{validation?.ok ? 'Balanced' : remaining > 0 ? 'Left to allocate' : 'Over by'}</span>
            <span className="font-semibold amount">
              {mode === 'percent'
                ? `${Math.abs(remaining)}% of 100%`
                : `${formatCurrency(Math.abs(remaining), currency)} of ${formatCurrency(target, currency)}`}
            </span>
          </div>
        </>
      )}

      {error && <p className="text-xs text-[#ef4444] mb-3">{error}</p>}

      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary" size="sm" fullWidth
          disabled={mode !== 'one' && !validation?.ok}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}
