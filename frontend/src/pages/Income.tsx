import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { incomeDS, calculateTax, getTaxBrackets, deductionsDS, parseDocument } from '../services/dataService';
import { payrollApi } from '../services/api';
import { formatCurrency, formatDate, getCurrentFinancialYear } from '../utils/format';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import { INCOME_CATEGORIES } from '../types';
import PayrollSection from './PayrollSection';

type Tab = 'Income' | 'Tax' | 'Payslips';

interface PayslipLite {
  employer: string;
  gross_pay: number;
  ytd_gross: number | null;
  ytd_tax: number | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  payment_date: string | null;
  pay_frequency: 'weekly' | 'fortnightly' | 'monthly';
}

// Weeks one payslip covers — prefer the actual pay-period span, else the frequency.
const FREQ_WEEKS: Record<string, number> = { weekly: 1, fortnightly: 2, monthly: 52 / 12 };
function payslipWeeks(p: PayslipLite): number {
  if (p.pay_period_start && p.pay_period_end) {
    const days = (new Date(p.pay_period_end).getTime() - new Date(p.pay_period_start).getTime()) / 86_400_000;
    if (days > 0) return (days + 1) / 7; // inclusive of both endpoints
  }
  return FREQ_WEEKS[p.pay_frequency] ?? 2;
}

// Start of the current Australian financial year (1 July).
function financialYearStart(): Date {
  const now = new Date();
  const startYear = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(startYear, 6, 1);
}

export default function Income() {
  const { user, incomeEntries, setIncomeEntries, projectedAnnual, setProjectedAnnual } = useStore();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Income');
  const [addOpen, setAddOpen] = useState(false);
  const [addDeductionOpen, setAddDeductionOpen] = useState(false);
  const [deductions, setDeductions] = useState<ReturnType<typeof deductionsDS.getAll>>([]);
  const [hecsEnabled, setHecsEnabled] = useState(false);
  const [payslips, setPayslips] = useState<PayslipLite[]>([]);

  const currency = user?.currency_preference ?? 'AUD';
  const fy = getCurrentFinancialYear();
  const brackets = getTaxBrackets();
  const totalDeductions = deductions.reduce((s: number, d: { amount: number }) => s + d.amount, 0);

  useEffect(() => {
    setDeductions(deductionsDS.getAll());
  }, [addDeductionOpen]);

  useEffect(() => {
    if (searchParams.get('add') === 'income') setAddOpen(true);
  }, [searchParams]);

  useEffect(() => {
    payrollApi.getAll()
      .then(d => setPayslips((d.payslips ?? []) as PayslipLite[]))
      .catch(() => { /* leave empty */ });
  }, []);

  // Earned-this-year prefers each payslip's YTD gross (which already accumulates
  // every prior pay this FY) over summing individual payslips — so a single
  // payslip still reflects everything earned to date, not just that one pay.
  // Per employer we take the most recent payslip's YTD figure, then sum across
  // employers; we fall back to summing gross when no YTD is present.
  const byEmployer = new Map<string, PayslipLite[]>();
  for (const p of payslips) {
    const arr = byEmployer.get(p.employer) ?? [];
    arr.push(p);
    byEmployer.set(p.employer, arr);
  }
  let earnedThisYear = 0;
  let ytdTaxWithheld = 0;
  let usedYtd = false;
  for (const arr of byEmployer.values()) {
    const latest = [...arr].sort((a, b) => (b.payment_date ?? '') < (a.payment_date ?? '') ? -1 : 1)[0];
    if (latest?.ytd_gross != null && Number(latest.ytd_gross) > 0) {
      earnedThisYear += Number(latest.ytd_gross);
      ytdTaxWithheld += Number(latest.ytd_tax ?? 0);
      usedYtd = true;
    } else {
      earnedThisYear += arr.reduce((s, p) => s + Number(p.gross_pay || 0), 0);
      ytdTaxWithheld += arr.reduce((s, p) => s + Number((p as { tax_withheld?: number }).tax_withheld ?? 0), 0);
    }
  }

  // Tax estimate prefers payslip YTD (gross + tax) when available so a single
  // payslip reflects the whole year's tax position, not just one pay.
  const taxData = calculateTax(
    hecsEnabled,
    usedYtd ? { total_income: earnedThisYear, tax_withheld: ytdTaxWithheld } : undefined,
  );
  const netTax = taxData.estimated_tax_owing - taxData.tax_withheld;

  const weeksCovered = payslips.reduce((s, p) => s + payslipWeeks(p), 0);
  // When using YTD, annualise over weeks elapsed in the FY (to the latest pay
  // date) rather than weeks covered by the uploaded payslips.
  const latestPayDate = payslips.map(p => p.payment_date).filter(Boolean).sort().pop();
  const asOf = latestPayDate ? new Date(latestPayDate) : new Date();
  const weeksElapsed = Math.max(1, (asOf.getTime() - financialYearStart().getTime()) / (7 * 86_400_000));
  const onTrackAnnual = usedYtd
    ? (earnedThisYear / weeksElapsed) * 52
    : (weeksCovered > 0 ? (earnedThisYear / weeksCovered) * 52 : 0);
  const hasPayslips = payslips.length > 0;

  const refreshIncome = () => {
    const { entries, projected_annual } = incomeDS.getAll();
    setIncomeEntries(entries);
    setProjectedAnnual(projected_annual);
  };

  const pending  = incomeEntries.filter(e => e.status === 'pending');
  const approved = incomeEntries.filter(e => e.status === 'approved');

  const ICONS: Record<string, string> = {
    'Salary': '💼', 'Wage': '⏰', 'Freelance/Contractor': '💻',
    'Rental': '🏠', 'Dividends': '📊', 'Government Payments': '🏛️',
    'Interest': '🏦', 'Bonus': '🎁', 'Trust Distribution': '📋', 'Other': '💰',
  };

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Income</h1>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#e5e5e5] dark:border-[#2a2a2a] mb-6">
        {(['Income', 'Tax', 'Payslips'] as Tab[]).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-6 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 ${activeTab === tab ? 'text-[#3b7dd8] border-[#3b7dd8]' : 'text-[#6b6b6b] dark:text-[#a0a0a0] border-transparent'}`}>
            {tab}
          </button>
        ))}
      </div>

      {/* ── INCOME TAB ── */}
      {activeTab === 'Income' && (
        <div>
          {/* Earned this year + on-track (from payslips) */}
          <Card className="mb-6">
            {hasPayslips ? (
              <>
                <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Earned this year</p>
                <p className="text-2xl font-semibold amount mt-1">{formatCurrency(earnedThisYear, currency)}</p>
                <div className="mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                  <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">On track to earn this year</p>
                  <p className="text-3xl font-semibold amount mt-1">{formatCurrency(onTrackAnnual, currency)}</p>
                  <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">
                    {usedYtd
                      ? `Annualised from year-to-date earnings (${weeksElapsed.toFixed(1)} weeks into FY)`
                      : `Annualised from ${payslips.length} payslip${payslips.length === 1 ? '' : 's'} (${weeksCovered.toFixed(1)} weeks)`} · FY {fy}
                  </p>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">On track to earn this year</p>
                <p className="text-3xl font-semibold amount mt-1">{formatCurrency(projectedAnnual, currency)}</p>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">Add payslips for a payslip-based estimate · FY {fy}</p>
              </>
            )}
          </Card>

          {/* Pending approval */}
          {pending.length > 0 && (
            <div className="mb-6">
              <h2 className="font-medium mb-3 flex items-center gap-2">
                Pending Approval
                <span className="badge bg-[#f59e0b]/10 text-[#f59e0b]">{pending.length}</span>
              </h2>
              <div className="space-y-2">
                {pending.map(entry => (
                  <div key={entry.id} className="flex items-center justify-between p-3 rounded-[8px] border border-[#f59e0b]/30 bg-[#f59e0b]/5">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{ICONS[entry.category] ?? '💰'}</span>
                      <div>
                        <p className="text-sm font-medium">{entry.source}</p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{entry.category} · {formatDate(entry.date)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold amount text-sm">{formatCurrency(entry.amount, entry.currency)}</span>
                      <Button variant="primary" size="sm" onClick={() => { incomeDS.approve(entry.id); refreshIncome(); }}>Approve</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Income history */}
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">Income History ({approved.length})</h2>
            <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Log Income</Button>
          </div>

          {approved.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">💰</div>
              <h3 className="font-medium mb-1">No income recorded</h3>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Upload a payslip or add income manually.</p>
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>+ Log Income</Button>
            </div>
          ) : (
            <div className="space-y-1">
              {approved.map(entry => (
                <div key={entry.id} className="flex items-center justify-between px-3 py-3 rounded-[8px] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a] transition-colors group">
                  <div className="flex items-center gap-3">
                    <span className="text-xl w-8 text-center flex-shrink-0">{ICONS[entry.category] ?? '💰'}</span>
                    <div>
                      <p className="text-sm font-medium">{entry.source}</p>
                      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                        {entry.category} · {formatDate(entry.date)}
                        {entry.is_recurring && <span className="ml-1 badge bg-[#3b7dd8]/10 text-[#3b7dd8]">Recurring</span>}
                        {entry.reference_number && <span className="ml-1 text-[#6b6b6b]">· Ref: {entry.reference_number}</span>}
                        {entry.tax_withheld && entry.tax_withheld > 0 && <span className="ml-1">· Tax withheld: {formatCurrency(entry.tax_withheld, entry.currency)}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold amount text-[#22c55e]">+{formatCurrency(entry.amount, entry.currency)}</span>
                    <button onClick={() => { incomeDS.remove(entry.id); refreshIncome(); }} className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAX TAB ── */}
      {activeTab === 'Tax' && (
        <div>
          {/* Tax summary */}
          <Card className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Tax Estimate</h2>
              <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">FY {fy}</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Estimated Tax</p>
                <p className="text-xl font-semibold amount mt-1">{formatCurrency(taxData.estimated_tax_owing, currency)}</p>
              </div>
              <div>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Already Withheld</p>
                <p className="text-xl font-semibold amount mt-1">{formatCurrency(taxData.tax_withheld, currency)}</p>
              </div>
              <div>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{netTax >= 0 ? 'Still to Pay' : 'Refund Due'}</p>
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
                <div key={item.label} className="flex justify-between py-1.5 border-b border-[#f5f5f5] dark:border-[#2a2a2a]">
                  <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{item.label}</span>
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
                  <div key={i} className={`flex justify-between text-sm py-1 px-2 rounded-[6px] ${isActive ? 'bg-[#3b7dd8]/10 font-medium' : ''}`}>
                    <span className={isActive ? 'text-[#3b7dd8]' : 'text-[#6b6b6b] dark:text-[#a0a0a0]'}>
                      ${b.min.toLocaleString()} – {b.max ? `$${b.max.toLocaleString()}` : 'above'}
                    </span>
                    <span className={isActive ? 'text-[#3b7dd8]' : 'text-[#0f0f0f] dark:text-[#f5f5f5]'}>
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
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Total: {formatCurrency(totalDeductions, currency)}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setAddDeductionOpen(true)}>+ Add</Button>
          </div>
          {deductions.length === 0 ? (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-4 text-center">No deductions added yet</p>
          ) : (
            <div className="space-y-2">
              {deductions.map((d: { id: string; name: string; amount: number; category: string; date: string }) => (
                <div key={d.id} className="flex items-center justify-between px-3 py-2.5 card group">
                  <div>
                    <p className="text-sm font-medium">{d.name}</p>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{d.category} · {formatDate(d.date)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold amount text-[#22c55e]">-{formatCurrency(d.amount, currency)}</span>
                    <button onClick={() => { deductionsDS.remove(d.id); setDeductions(deductionsDS.getAll()); }} className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── PAYSLIPS TAB ── */}
      {activeTab === 'Payslips' && <PayrollSection currency={currency} />}

      {/* ── MODALS ── */}
      <AddIncomeModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={(data) => {
          incomeDS.add(data as Parameters<typeof incomeDS.add>[0]);
          refreshIncome();
          setAddOpen(false);
        }}
      />

      <AddDeductionModal
        isOpen={addDeductionOpen}
        onClose={() => setAddDeductionOpen(false)}
        onSave={(data) => {
          deductionsDS.add(data as Parameters<typeof deductionsDS.add>[0]);
          setDeductions(deductionsDS.getAll());
          setAddDeductionOpen(false);
        }}
      />
    </Layout>
  );
}

// ─── Add Income Modal ────────────────────────────────────────────────────────

function AddIncomeModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void }) {
  const [form, setForm] = useState({
    source: '', amount: '', currency: 'AUD', category: 'Salary',
    is_recurring: false, frequency: 'fortnightly',
    reference_number: '', date: new Date().toISOString().split('T')[0],
    tax_withheld: '', super_contribution: '', status: 'approved' as const,
  });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true); setUploadMsg('');
    const { parsed, error } = await parseDocument(file, 'payslip');
    setUploading(false);
    if (error) { setUploadMsg(error); return; }
    if (parsed) {
      const p = parsed as Record<string, unknown>;
      setForm(f => ({
        ...f,
        source:             String(p.employer ?? f.source),
        amount:             String(p.net_pay ?? f.amount),
        category:           'Salary',
        is_recurring:       true,
        frequency:          String(p.frequency ?? 'fortnightly'),
        tax_withheld:       String(p.tax_withheld ?? ''),
        super_contribution: String(p.super_contribution ?? ''),
        date:               String(p.pay_date ?? f.date),
      }));
      setUploadMsg('Payslip parsed — please review the details below.');
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...form,
      amount:             parseFloat(form.amount) || 0,
      tax_withheld:       form.tax_withheld  ? parseFloat(form.tax_withheld)  : 0,
      super_contribution: form.super_contribution ? parseFloat(form.super_contribution) : 0,
    });
    setForm({ source: '', amount: '', currency: 'AUD', category: 'Salary', is_recurring: false, frequency: 'fortnightly', reference_number: '', date: new Date().toISOString().split('T')[0], tax_withheld: '', super_contribution: '', status: 'approved' });
    setUploadMsg('');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Log Income">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading payslip…' : 'Upload payslip to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('requires') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>{uploadMsg}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Source / Employer" value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} placeholder="e.g. Employer Pty Ltd" required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
          <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
        </div>
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          options={[...INCOME_CATEGORIES].map(c => ({ value: c, label: c }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Tax withheld" type="number" step="0.01" prefix="$" value={form.tax_withheld} onChange={e => setForm(f => ({ ...f, tax_withheld: e.target.value }))} />
          <Input label="Super contribution" type="number" step="0.01" prefix="$" value={form.super_contribution} onChange={e => setForm(f => ({ ...f, super_contribution: e.target.value }))} />
        </div>
        <Toggle label="Recurring income" checked={form.is_recurring} onChange={v => setForm(f => ({ ...f, is_recurring: v }))} />
        {form.is_recurring && (
          <Select label="Frequency" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
            options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]}
          />
        )}
        <Input label="Reference number (optional)" value={form.reference_number} onChange={e => setForm(f => ({ ...f, reference_number: e.target.value }))} />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Log Income</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Deduction Modal ─────────────────────────────────────────────────────

function AddDeductionModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void }) {
  const [form, setForm] = useState({ name: '', amount: '', category: 'Work from home', date: new Date().toISOString().split('T')[0] });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ ...form, amount: parseFloat(form.amount) || 0 });
    setForm({ name: '', amount: '', category: 'Work from home', date: new Date().toISOString().split('T')[0] });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Tax Deduction" size="sm">
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
          <Button variant="primary" type="submit" fullWidth>Add Deduction</Button>
        </div>
      </form>
    </Modal>
  );
}
