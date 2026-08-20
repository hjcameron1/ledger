import { useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { Select, Toggle } from './Input';
import { useStore } from '../../store';
import { transactionsDS } from '../../services/dataService';
import { formatCurrency } from '../../utils/format';
import type { Transaction } from '../../types';
import { DEDUCTION_CATEGORIES } from '../../utils/taxDeductions';

/**
 * Phase 2D.1 — per-transaction TAX METADATA editor.
 *
 * Pure UI over transactionsDS.update(): it edits the five tax fields that live
 * directly on the transaction row and persists them through the normal
 * transaction.update sync path (offline-queued + reconciled like any other edit).
 * NO tax calculations happen here — this only records the metadata.
 *
 * Three of the fields (is_tax_deductible, deduction_category, entity) were added
 * in Phase 2A; tax_note + receipt_ref are new in 2D.1. This does NOT touch the
 * standalone `tax_deductions` table — that remains the manual, financial-year
 * deduction list. This is the same "one shared TransactionRow surface, no extra
 * plumbing" pattern the Split editor uses.
 */

export default function TaxModal({ tx, isOpen, onClose }: {
  tx: Transaction;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { setTransactions } = useStore();
  const currency = tx.display_currency ?? tx.currency ?? 'AUD';

  const [deductible, setDeductible] = useState<boolean>(!!tx.is_tax_deductible);
  const [entity, setEntity] = useState<string>(tx.entity ?? '');
  const [deductionCategory, setDeductionCategory] = useState<string>(tx.deduction_category ?? '');
  const [taxNote, setTaxNote] = useState<string>(tx.tax_note ?? '');
  const [receiptRef, setReceiptRef] = useState<string>(tx.receipt_ref ?? '');

  // Preserve a pre-existing deduction category that isn't one of our presets.
  const categoryOptions = [
    { value: '', label: 'No category' },
    ...(deductionCategory && !DEDUCTION_CATEGORIES.includes(deductionCategory)
      ? [{ value: deductionCategory, label: deductionCategory }]
      : []),
    ...DEDUCTION_CATEGORIES.map(c => ({ value: c, label: c })),
  ];

  const save = () => {
    // Normalise blanks to null so an unset field is stored as NULL, not "".
    const clean = (v: string) => {
      const t = v.trim();
      return t === '' ? null : t;
    };
    transactionsDS.update(tx.id, {
      is_tax_deductible: deductible,
      deduction_category: clean(deductionCategory),
      entity: clean(entity),
      tax_note: clean(taxNote),
      receipt_ref: clean(receiptRef),
    });
    // Full visible set, not the scoped subset — see NeedsReviewSection.refresh:
    // narrowing the store here would drop shared-account transactions.
    setTransactions(transactionsDS.getVisible());
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Tax details" size="md">
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1">
        {tx.merchant} · {formatCurrency(Math.abs(tx.display_amount ?? tx.amount), currency)}
      </p>
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">
        Record the tax treatment for this transaction. This only saves the details —
        no deduction totals are calculated here.
      </p>

      <div className="space-y-4">
        {/* Deductible toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Tax deductible</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">Mark if you can claim this at tax time</p>
          </div>
          <Toggle checked={deductible} onChange={setDeductible} />
        </div>

        {/* Entity */}
        <Select
          label="Entity"
          value={entity}
          onChange={e => setEntity(e.target.value)}
          options={[
            { value: '', label: 'Unspecified' },
            { value: 'personal', label: 'Personal' },
            { value: 'business', label: 'Business' },
          ]}
        />

        {/* Deduction category */}
        <Select
          label="Deduction category"
          value={deductionCategory}
          onChange={e => setDeductionCategory(e.target.value)}
          options={categoryOptions}
        />

        {/* Tax note */}
        <div className="w-full">
          <label className="label">Tax note</label>
          <textarea
            className="input w-full min-h-[70px] resize-y"
            placeholder="e.g. 60% work use — home office"
            value={taxNote}
            onChange={e => setTaxNote(e.target.value)}
          />
        </div>

        {/* Receipt / evidence reference */}
        <div className="w-full">
          <label className="label">Receipt / evidence reference</label>
          <input
            className="input w-full"
            placeholder="Link, file name, or where the receipt is kept"
            value={receiptRef}
            onChange={e => setReceiptRef(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2 mt-6">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" fullWidth onClick={save}>Save tax details</Button>
      </div>
    </Modal>
  );
}
