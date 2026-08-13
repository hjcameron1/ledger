import { useState, useEffect, useMemo } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { calculateTax, getTaxBrackets, deductionsDS } from '../services/dataService';
import { payrollApi } from '../services/api';
import { formatCurrency, formatDate, getCurrentFinancialYear } from '../utils/format';
import { payrollTotals, type PayslipCore } from '../utils/payroll';
import {
  buildDeductionView,
  availableFinancialYears,
  deductibleTransactionsForFY,
  DEDUCTION_CATEGORIES,
  type ManualDeduction,
} from '../utils/taxDeductions';
import type { Transaction } from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';

export default function Tax() {
  const { user, transactions } = useStore();
  const currency = user?.currency_preference ?? 'AUD';
  const brackets = getTaxBrackets();

  const [addDeductionOpen, setAddDeductionOpen] = useState(false);
  const [editingDeduction, setEditingDeduction] = useState<ManualDeduction | null>(null);
  const [deductions, setDeductions] = useState<ManualDeduction[]>([]);
  const [hecsEnabled, setHecsEnabled] = useState(false);
  const [payslips, setPayslips] = useState<PayslipCore[]>([]);
  const [selectedFY, setSelectedFY] = useState<string>(getCurrentFinancialYear());

  const reloadDeductions = () => setDeductions(deductionsDS.getAll());
  useEffect(() => { reloadDeductions(); }, [addDeductionOpen]);

  useEffect(() => {
    payrollApi.getAll()
      .then(d => setPayslips((d.payslips ?? []) as PayslipCore[]))
      .catch(() => { /* leave empty */ });
  }, []);

  // FY switcher options — always include the current FY so it's never empty.
  const fyOptions = useMemo(() => {
    const found = availableFinancialYears(transactions, deductions);
    const cur = getCurrentFinancialYear();
    return found.includes(cur) ? found : [cur, ...found];
  }, [transactions, deductions]);

  // The merged, deduped, grouped deduction view for the selected FY.
  const view = useMemo(
    () => buildDeductionView({ transactions, manualDeductions: deductions, fy: selectedFY }),
    [transactions, deductions, selectedFY],
  );

  // Deductible transactions in this FY the user can link a manual deduction to
  // (minus any already claimed by another manual line, to prevent a double link).
  const linkableTx = useMemo(() => {
    const claimed = new Set(
      deductions
        .filter(d => d.id !== editingDeduction?.id)
        .map(d => d.source_transaction_id?.trim())
        .filter(Boolean) as string[],
    );
    return deductibleTransactionsForFY(transactions, selectedFY).filter(t => !claimed.has(t.id));
  }, [transactions, deductions, selectedFY, editingDeduction]);

  const totalDeductions = view.total;

  const { earnedThisYear, taxWithheld: ytdTaxWithheld } = payrollTotals(payslips);

  const taxData = calculateTax(
    hecsEnabled,
    payslips.length > 0
      ? { total_income: earnedThisYear, tax_withheld: ytdTaxWithheld, total_deductions: totalDeductions }
      : { total_deductions: totalDeductions },
  );
  const netTax = taxData.estimated_tax_owing - taxData.tax_withheld;

  return (
    <Layout>
      <PageHeader title="Tax" />

      {/* Tax summary */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Tax Estimate</h2>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">FY {selectedFY}</span>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Estimated Tax</p>
            <p className="text-xl font-semibold amount mt-1">{formatCurrency(taxData.estimated_tax_owing, currency)}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Already Withheld</p>
            <p className="text-xl font-semibold amount mt-1">{formatCurrency(taxData.tax_withheld, currency)}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{netTax >= 0 ? 'Still to Pay' : 'Refund Due'}</p>
            <p className={`text-xl font-semibold amount mt-1 ${netTax >= 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
              {formatCurrency(Math.abs(netTax), currency)}
            </p>
          </div>
        </div>
      </Card>

      {/* Tax breakdown */}
      <Card className="mb-6">
        <h3 className="font-medium mb-3">Breakdown</h3>
        <div className="space-y-2">
          {[
            { label: 'Total taxable income', value: taxData.total_income },
            { label: 'Income tax', value: taxData.estimated_tax_owing - taxData.medicare_levy - taxData.hecs_repayment },
            { label: 'Medicare levy (2%)', value: taxData.medicare_levy },
            ...(taxData.hecs_repayment > 0 ? [{ label: 'HECS/HELP repayment', value: taxData.hecs_repayment }] : []),
            { label: 'Total deductions', value: -totalDeductions },
          ].map(item => (
            <div key={item.label} className="flex justify-between py-1.5 border-b border-zinc-100 dark:border-zinc-800">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">{item.label}</span>
              <span className={`text-sm font-medium amount ${item.value < 0 ? 'text-[#22c55e]' : ''}`}>{formatCurrency(Math.abs(item.value), currency)}</span>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Toggle label="I have a HECS/HELP debt" checked={hecsEnabled} onChange={setHecsEnabled} />
        </div>
      </Card>

      {/* Tax brackets */}
      <Card className="mb-6">
        <h3 className="font-medium mb-3">2024–25 Tax Brackets</h3>
        <div className="space-y-1.5">
          {brackets.map((b, i) => {
            const isActive = taxData.total_income >= b.min && (b.max == null || taxData.total_income <= b.max);
            return (
              <div key={i} className={`flex justify-between text-sm py-1 px-2 rounded-[6px] ${isActive ? 'bg-brand/10 font-medium' : ''}`}>
                <span className={isActive ? 'text-brand' : 'text-zinc-500 dark:text-zinc-400'}>
                  ${b.min.toLocaleString()} – {b.max ? `$${b.max.toLocaleString()}` : 'above'}
                </span>
                <span className={isActive ? 'text-brand' : 'text-zinc-900 dark:text-zinc-100'}>
                  {b.rate === 0 ? 'Nil' : `${(b.rate * 100).toFixed(0)}c per $1`}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Deductions — merged FY view: manual entries + deductible transactions */}
      <div className="flex justify-between items-start mb-3 gap-3">
        <div>
          <h3 className="font-medium">Tax Deductions</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Total: <span className="font-medium">{formatCurrency(view.total, currency)}</span>
            {view.transactionTotal > 0 && (
              <> · {formatCurrency(view.manualTotal, currency)} manual + {formatCurrency(view.transactionTotal, currency)} from transactions</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {fyOptions.length > 1 && (
            <Select
              value={selectedFY}
              onChange={e => setSelectedFY(e.target.value)}
              options={fyOptions.map(f => ({ value: f, label: `FY ${f}` }))}
            />
          )}
          <Button variant="secondary" size="sm" onClick={() => { setEditingDeduction(null); setAddDeductionOpen(true); }}>+ Add</Button>
        </div>
      </div>

      {/* Suspected-duplicate review banner — same expense entered twice, counted once. */}
      {view.suspectedDuplicates.length > 0 && (
        <div className="mb-3 rounded-[10px] border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2.5">
          <p className="text-xs font-medium text-[#b45309] dark:text-[#fbbf24]">
            {view.suspectedDuplicates.length === 1 ? 'Possible duplicate found' : `${view.suspectedDuplicates.length} possible duplicates found`}
          </p>
          <p className="text-xs text-[#b45309]/80 dark:text-[#fbbf24]/80 mt-0.5">
            A manual deduction and a deductible transaction look like the same expense.
            The transaction is flagged below and left out of the total so it's counted once — review each to link or keep both.
          </p>
        </div>
      )}

      {view.groups.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
          No deductions for FY {selectedFY} yet. Add one, or mark a transaction as tax-deductible.
        </p>
      ) : (
        <div className="space-y-5">
          {view.groups.map(group => (
            <div key={group.category}>
              <div className="flex justify-between items-center mb-1.5 px-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{group.category}</h4>
                <span className="text-xs font-semibold amount text-[#22c55e]">-{formatCurrency(group.total, currency)}</span>
              </div>
              <div className="space-y-2">
                {group.lines.map(line => (
                  <div key={line.key} className={`flex items-center justify-between px-3 py-2.5 card group ${line.excluded ? 'opacity-70 border-[#f59e0b]/40' : ''}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{line.name}</p>
                        {line.source === 'transaction' && !line.suspectedDuplicate && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#3b82f6]/10 text-[#3b82f6]" title="Pulled from a transaction you marked tax-deductible">from transaction</span>
                        )}
                        {line.source === 'manual' && line.linked && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#8b5cf6]/10 text-[#8b5cf6]" title="Linked to a transaction — that transaction is not counted again">↔ linked</span>
                        )}
                        {line.suspectedDuplicate && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#b45309] dark:text-[#fbbf24]" title="Looks like the same expense as a manual deduction — counted once, review to link or keep both">
                            {line.source === 'transaction' ? '⚠ possible duplicate' : '⚠ has duplicate'}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                        {formatDate(line.date)}
                        {line.source === 'transaction' && line.merchant ? <> · {line.merchant}</> : null}
                        {line.excluded ? <> · not counted</> : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`text-sm font-semibold amount ${line.excluded ? 'text-zinc-400 line-through dark:text-zinc-500' : 'text-[#22c55e]'}`}>-{formatCurrency(line.amount, currency)}</span>
                      {line.source === 'manual' ? (
                        <>
                          {line.linked && (
                            <button
                              onClick={() => { deductionsDS.setLink(line.id, null); reloadDeductions(); }}
                              className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#8b5cf6] transition-all"
                              title="Remove transaction link"
                            >⛓︎✕</button>
                          )}
                          <button
                            onClick={() => { setEditingDeduction(deductions.find(d => d.id === line.id) ?? null); setAddDeductionOpen(true); }}
                            className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#3b82f6] transition-all"
                            title="Edit deduction"
                          >✎</button>
                          <button
                            onClick={() => { deductionsDS.remove(line.id); reloadDeductions(); }}
                            className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all"
                            title="Delete deduction"
                          >✕</button>
                        </>
                      ) : line.suspectedDuplicate && line.duplicateOf ? (
                        <>
                          <button
                            onClick={() => { deductionsDS.setLink(line.duplicateOf!, line.id); reloadDeductions(); }}
                            className="text-[11px] px-1.5 py-0.5 rounded-[6px] text-[#8b5cf6] hover:bg-[#8b5cf6]/10 transition-colors"
                            title="Confirm these are the same expense — link them (counted once)"
                          >Link</button>
                          <button
                            onClick={() => { deductionsDS.dismissDuplicate(line.duplicateOf!, line.id); reloadDeductions(); }}
                            className="text-[11px] px-1.5 py-0.5 rounded-[6px] text-zinc-500 hover:bg-zinc-500/10 transition-colors"
                            title="These are different expenses — count both"
                          >Keep both</button>
                        </>
                      ) : (
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500" title="Managed from the transaction's tax details">on transaction</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Deduction Modal */}
      <AddDeductionModal
        isOpen={addDeductionOpen}
        editing={editingDeduction}
        currency={currency}
        defaultDate={defaultDateForFY(selectedFY)}
        linkableTx={linkableTx}
        onClose={() => { setAddDeductionOpen(false); setEditingDeduction(null); }}
        onSave={(data) => {
          if (editingDeduction) {
            deductionsDS.update(editingDeduction.id, data);
          } else {
            deductionsDS.add(data);
          }
          reloadDeductions();
          setAddDeductionOpen(false);
          setEditingDeduction(null);
        }}
      />
    </Layout>
  );
}

/** A sensible default date inside the selected FY (its 1 July start, or today if current). */
function defaultDateForFY(fy: string): string {
  const today = new Date().toISOString().split('T')[0];
  if (fy === getCurrentFinancialYear()) return today;
  const startYear = parseInt(fy.split('-')[0], 10);
  return Number.isFinite(startYear) ? `${startYear}-07-01` : today;
}

// ─── Add Deduction Modal ─────────────────────────────────────────────────────

interface DeductionFormData {
  name: string;
  amount: number;
  category: string;
  date: string;
  source_transaction_id: string | null;
}

function AddDeductionModal({ isOpen, onClose, onSave, editing, currency, defaultDate, linkableTx }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (d: DeductionFormData) => void;
  editing?: ManualDeduction | null;
  currency: string;
  defaultDate: string;
  linkableTx: Transaction[];
}) {
  const blank = { name: '', amount: '', category: DEDUCTION_CATEGORIES[4], date: defaultDate, link: '' };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        amount: String(editing.amount),
        category: editing.category,
        date: editing.date,
        link: editing.source_transaction_id ?? '',
      });
    } else {
      setForm({ ...blank });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isOpen]);

  // Preserve a pre-existing category that isn't one of our presets.
  const categoryOptions = [
    ...(form.category && !DEDUCTION_CATEGORIES.includes(form.category)
      ? [{ value: form.category, label: form.category }]
      : []),
    ...DEDUCTION_CATEGORIES.map(c => ({ value: c, label: c })),
  ];

  // The currently linked transaction may sit outside `linkableTx` (it's claimed by
  // this very deduction) — inject it so the Select can still show/keep it.
  const linkedNotInList = editing?.source_transaction_id
    && !linkableTx.some(t => t.id === editing.source_transaction_id);
  const linkOptions = [
    { value: '', label: 'None — standalone deduction' },
    ...(linkedNotInList ? [{ value: editing!.source_transaction_id!, label: '(linked transaction)' }] : []),
    ...linkableTx.map(t => ({
      value: t.id,
      label: `${t.merchant || 'Transaction'} · ${formatDate(t.date)} · ${formatCurrency(Math.abs(t.amount), currency)}`,
    })),
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: form.name,
      amount: parseFloat(form.amount) || 0,
      category: form.category,
      date: form.date,
      source_transaction_id: form.link || null,
    });
  };

  // When linking a transaction, offer to prefill name/amount from it.
  const applyLinkPrefill = (txId: string) => {
    const t = linkableTx.find(x => x.id === txId);
    setForm(f => ({
      ...f,
      link: txId,
      name: f.name || (t?.merchant ?? ''),
      amount: f.amount || (t ? String(Math.abs(t.amount)) : ''),
    }));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit Tax Deduction' : 'Add Tax Deduction'} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Deduction name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Home office equipment" required />
        <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} options={categoryOptions} />
        <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />

        {/* Optional link to a deductible transaction — prevents double counting. */}
        {(linkableTx.length > 0 || linkedNotInList) && (
          <div>
            <Select
              label="Link to transaction (optional)"
              value={form.link}
              onChange={e => applyLinkPrefill(e.target.value)}
              options={linkOptions}
            />
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
              Linking a deductible transaction records this deduction once — the transaction won't be counted again.
            </p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save Changes' : 'Add Deduction'}</Button>
        </div>
      </form>
    </Modal>
  );
}
