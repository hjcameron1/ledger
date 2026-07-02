import { useState, useEffect } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { calculateTax, getTaxBrackets, deductionsDS } from '../services/dataService';
import { payrollApi } from '../services/api';
import { formatCurrency, formatDate, getCurrentFinancialYear } from '../utils/format';
import { payrollTotals, type PayslipCore } from '../utils/payroll';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';

export default function Tax() {
  const { user } = useStore();
  const currency = user?.currency_preference ?? 'AUD';
  const fy = getCurrentFinancialYear();
  const brackets = getTaxBrackets();

  const [addDeductionOpen, setAddDeductionOpen] = useState(false);
  const [editingDeduction, setEditingDeduction] = useState<{ id: string; name: string; amount: number; category: string; date: string } | null>(null);
  const [deductions, setDeductions] = useState<ReturnType<typeof deductionsDS.getAll>>([]);
  const [hecsEnabled, setHecsEnabled] = useState(false);
  const [payslips, setPayslips] = useState<PayslipCore[]>([]);

  const totalDeductions = deductions.reduce((s: number, d: { amount: number }) => s + d.amount, 0);

  useEffect(() => {
    setDeductions(deductionsDS.getAll());
  }, [addDeductionOpen]);

  useEffect(() => {
    payrollApi.getAll()
      .then(d => setPayslips((d.payslips ?? []) as PayslipCore[]))
      .catch(() => { /* leave empty */ });
  }, []);

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
          <span className="text-sm text-zinc-500 dark:text-zinc-400">FY {fy}</span>
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

      {/* Deductions */}
      <div className="flex justify-between items-center mb-3">
        <div>
          <h3 className="font-medium">Tax Deductions</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Total: {formatCurrency(totalDeductions, currency)}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setEditingDeduction(null); setAddDeductionOpen(true); }}>+ Add</Button>
      </div>
      {deductions.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">No deductions added yet</p>
      ) : (
        <div className="space-y-2">
          {deductions.map((d: { id: string; name: string; amount: number; category: string; date: string }) => (
            <div key={d.id} className="flex items-center justify-between px-3 py-2.5 card group">
              <div>
                <p className="text-sm font-medium">{d.name}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{d.category} · {formatDate(d.date)}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold amount text-[#22c55e]">-{formatCurrency(d.amount, currency)}</span>
                <button onClick={() => { setEditingDeduction(d); setAddDeductionOpen(true); }} className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#3b82f6] transition-all" title="Edit deduction">✎</button>
                <button onClick={() => { deductionsDS.remove(d.id); setDeductions(deductionsDS.getAll()); }} className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all" title="Delete deduction">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Deduction Modal */}
      <AddDeductionModal
        isOpen={addDeductionOpen}
        editing={editingDeduction}
        onClose={() => { setAddDeductionOpen(false); setEditingDeduction(null); }}
        onSave={(data) => {
          if (editingDeduction) {
            deductionsDS.update(editingDeduction.id, data as Parameters<typeof deductionsDS.update>[1]);
          } else {
            deductionsDS.add(data as Parameters<typeof deductionsDS.add>[0]);
          }
          setDeductions(deductionsDS.getAll());
          setAddDeductionOpen(false);
          setEditingDeduction(null);
        }}
      />
    </Layout>
  );
}

// ─── Add Deduction Modal ─────────────────────────────────────────────────────

interface DeductionRecord { id: string; name: string; amount: number; category: string; date: string }

function AddDeductionModal({ isOpen, onClose, onSave, editing }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void; editing?: DeductionRecord | null }) {
  const blank = { name: '', amount: '', category: 'Work from home', date: new Date().toISOString().split('T')[0] };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    if (editing) setForm({ name: editing.name, amount: String(editing.amount), category: editing.category, date: editing.date });
    else setForm(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ ...form, amount: parseFloat(form.amount) || 0 });
    setForm(blank);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit Tax Deduction' : 'Add Tax Deduction'} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Deduction name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Home office equipment" required />
        <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          options={[
            { value: 'Work from home', label: 'Work from home' }, { value: 'Equipment', label: 'Equipment' },
            { value: 'Vehicle', label: 'Vehicle / travel' }, { value: 'Clothing', label: 'Clothing / uniform' },
            { value: 'Education', label: 'Education / training' }, { value: 'Donations', label: 'Donations' },
            { value: 'Investment', label: 'Investment expenses' }, { value: 'Other', label: 'Other' },
          ]}
        />
        <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save Changes' : 'Add Deduction'}</Button>
        </div>
      </form>
    </Modal>
  );
}
