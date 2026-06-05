import { useState, useEffect, useCallback } from 'react';
import { payrollApi } from '../services/api';
import { parseDocument, estimateTaxForIncome, billsDS } from '../services/dataService';
import { useStore } from '../store';
import { formatCurrency, formatDate } from '../utils/format';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';

// ── Types (shape returned by GET /api/payroll) ────────────────────────────────
interface LineItem { name: string; amount: number }
interface Payslip {
  id: string;
  employer: string;
  abn: string | null;
  employee_name: string | null;
  employment_type: 'full_time' | 'part_time' | 'casual' | 'contractor';
  pay_period_start: string | null;
  pay_period_end: string | null;
  payment_date: string | null;
  pay_frequency: 'weekly' | 'fortnightly' | 'monthly';
  gross_pay: number;
  net_pay: number;
  tax_withheld: number;
  super_amount: number;
  super_rate: number | null;
  ytd_gross: number | null;
  ytd_tax: number | null;
  ytd_super: number | null;
  leave_balance: number | null;
  sick_leave_balance: number | null;
  hourly_rate: number | null;
  allowances: LineItem[];
  deductions: LineItem[];
  cycle_label: string | null;
}
interface PayrollData {
  financial_year: string;
  sg_rate: number;
  payslips: Payslip[];
  expected_super: unknown[];
}

const PERIODS: Record<string, number> = { weekly: 52, fortnightly: 26, monthly: 12 };
const TYPE_LABELS: Record<string, string> = {
  full_time: 'Full-time', part_time: 'Part-time', casual: 'Casual', contractor: 'Contractor',
};
const PREDICTABLE = new Set(['full_time', 'part_time']);

function addFreq(dateStr: string, freq: string): string {
  const d = new Date(dateStr);
  if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

/**
 * Create / refresh the "expected pay" reminder bill for an employer.
 * Salary & permanent part-time only — casual pay is unpredictable so we never
 * predict it. Supports alternating cycles: if the two most recent payslips have
 * materially different net amounts, the next pay is predicted as the OLDER of the
 * two amounts (the cycle alternates).
 */
function refreshPayPrediction(payslips: Payslip[], employer: string): void {
  const mine = payslips
    .filter(p => p.employer === employer && p.payment_date)
    .sort((a, b) => (b.payment_date! < a.payment_date! ? -1 : 1));
  if (mine.length === 0) return;
  const latest = mine[0];
  if (!PREDICTABLE.has(latest.employment_type)) return;

  const freq = latest.pay_frequency;
  let nextAmount = latest.net_pay;
  // Alternating cycle: two most recent nets differ by > $1 → alternate.
  if (mine.length >= 2 && Math.abs(mine[0].net_pay - mine[1].net_pay) > 1) {
    nextAmount = mine[1].net_pay;
  }
  const nextDate = addFreq(latest.payment_date!, freq);
  const name = `Pay from ${employer}`;

  const existing = useStore.getState().bills.find(b => !b.is_paid && b.name === name);
  if (existing) {
    billsDS.update(existing.id, { amount: nextAmount, due_date: nextDate, frequency: freq, is_recurring: true });
  } else {
    billsDS.addLinked({
      name, amount: nextAmount, due_date: nextDate,
      is_recurring: true, frequency: freq, colour: 'grey',
      is_paid: false, calendar_synced: false,
    });
  }
}

export default function PayrollSection({ currency }: { currency: string }) {
  const [data, setData] = useState<PayrollData | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    try { setData(await payrollApi.getAll()); }
    catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (loading) return <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Loading payslips…</p>;
  if (!data) return <p className="text-sm text-[#ef4444]">Could not load payroll data.</p>;

  const payslips = data.payslips;

  // Group by employer for prediction + tax/SG insight (latest payslip per employer).
  const employers = Array.from(new Set(payslips.map(p => p.employer)));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Payslips</h2>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Upload a payslip to track pay, tax and super · FY {data.financial_year}</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Payslip</Button>
      </div>

      {/* Per-employer insight cards (prediction, tax on track, SG check) */}
      {employers.map(emp => {
        const mine = payslips.filter(p => p.employer === emp && p.payment_date)
          .sort((a, b) => (b.payment_date! < a.payment_date! ? -1 : 1));
        const latest = mine[0] ?? payslips.find(p => p.employer === emp)!;
        return <EmployerInsight key={emp} employer={emp} mine={mine.length ? mine : [latest]} sgRate={data.sg_rate} currency={currency} />;
      })}

      {/* Payslip history */}
      <div>
        <h3 className="font-medium mb-3">History ({payslips.length})</h3>
        {payslips.length === 0 ? (
          <Card>
            <div className="text-center py-8">
              <div className="text-3xl mb-2">🧾</div>
              <h3 className="font-medium mb-1">No payslips yet</h3>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Upload a payslip PDF to extract your pay, tax and super automatically.</p>
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>+ Add Payslip</Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {payslips.map(p => (
              <PayslipRow key={p.id} p={p} currency={currency} onDeleted={reload} />
            ))}
          </div>
        )}
      </div>

      {addOpen && (
        <AddPayslipModal
          onClose={() => setAddOpen(false)}
          onSaved={async (employer, createReminder) => {
            setAddOpen(false);
            const fresh = await payrollApi.getAll();
            setData(fresh);
            // Only create/refresh the recurring pay reminder if the user opted in.
            if (createReminder) {
              refreshPayPrediction((fresh as PayrollData).payslips, employer);
            }
          }}
        />
      )}
    </div>
  );
}

// ── Per-employer insight: next pay, tax on track, SG check ───────────────────
function EmployerInsight({ employer, mine, sgRate, currency }: { employer: string; mine: Payslip[]; sgRate: number; currency: string }) {
  const latest = mine[0];
  const periods = PERIODS[latest.pay_frequency] ?? 26;
  const predictable = PREDICTABLE.has(latest.employment_type);
  const alternating = mine.length >= 2 && Math.abs(mine[0].net_pay - mine[1].net_pay) > 1;

  // Next pay prediction
  const nextDate = latest.payment_date ? addFreq(latest.payment_date, latest.pay_frequency) : null;
  const nextAmount = alternating ? mine[1].net_pay : latest.net_pay;

  // Tax on track — annualise this payslip's gross & withheld through the bracket calc.
  const annualGross = latest.gross_pay * periods;
  const estTax = estimateTaxForIncome(annualGross);
  const annualWithheld = latest.tax_withheld * periods;
  const taxDiff = annualWithheld - estTax; // +ve → refund; -ve → bill

  // SG check — implied employer super rate vs the statutory SG rate.
  const impliedRate = latest.super_rate != null
    ? Number(latest.super_rate)
    : (latest.gross_pay > 0 ? (latest.super_amount / latest.gross_pay) * 100 : 0);
  const sgUnderpaid = impliedRate > 0 && impliedRate < sgRate - 0.1;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{employer}</h3>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            {TYPE_LABELS[latest.employment_type]} · paid {latest.pay_frequency}
            {alternating ? ' · alternating cycle' : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        {/* Next pay */}
        <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Next pay (predicted)</p>
          {predictable && nextDate ? (
            <>
              <p className="text-sm font-semibold amount mt-1">{formatCurrency(nextAmount, currency)}</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatDate(nextDate)}</p>
            </>
          ) : (
            <p className="text-sm mt-1 text-[#6b6b6b] dark:text-[#a0a0a0]">
              {latest.employment_type === 'casual' ? 'Casual — logged as one-off' : 'No prediction'}
            </p>
          )}
        </div>

        {/* Tax on track */}
        <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Tax on track?</p>
          <p className={`text-sm font-semibold mt-1 ${taxDiff >= -50 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
            {taxDiff >= 50 ? `~${formatCurrency(Math.abs(taxDiff), currency)} refund` :
             taxDiff <= -50 ? `~${formatCurrency(Math.abs(taxDiff), currency)} bill` :
             'On track'}
          </p>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">vs annualised withholding</p>
        </div>

        {/* Super guarantee */}
        <div className={`rounded-[8px] border p-3 ${sgUnderpaid ? 'border-[#ef4444]/40 bg-[#ef4444]/5' : 'border-[#e5e5e5] dark:border-[#2a2a2a]'}`}>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Super guarantee</p>
          <p className={`text-sm font-semibold mt-1 ${sgUnderpaid ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
            {impliedRate.toFixed(1)}% {sgUnderpaid ? '· below ' + sgRate + '%' : '· OK'}
          </p>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            {sgUnderpaid ? 'Employer may be underpaying super' : `Min ${sgRate}% this year`}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── Single payslip row (expandable detail) ───────────────────────────────────
function PayslipRow({ p, currency, onDeleted }: { p: Payslip; currency: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const period = p.pay_period_start && p.pay_period_end
    ? `${formatDate(p.pay_period_start)} – ${formatDate(p.pay_period_end)}`
    : p.payment_date ? formatDate(p.payment_date) : 'Unknown period';

  return (
    <div className="card group">
      <div className="flex items-center justify-between px-3 py-2.5 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div>
          <p className="text-sm font-medium">{p.employer}</p>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{period} · {TYPE_LABELS[p.employment_type]}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold amount text-[#22c55e]">+{formatCurrency(p.net_pay, currency)}</span>
          <button
            onClick={async (e) => { e.stopPropagation(); await payrollApi.deletePayslip(p.id); onDeleted(); }}
            className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all">✕</button>
        </div>
      </div>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-[#f5f5f5] dark:border-[#2a2a2a] grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <Field label="Gross" value={formatCurrency(p.gross_pay, currency)} />
          <Field label="Tax withheld" value={formatCurrency(p.tax_withheld, currency)} />
          <Field label="Net" value={formatCurrency(p.net_pay, currency)} />
          <Field label="Super" value={`${formatCurrency(p.super_amount, currency)}${p.super_rate != null ? ` (${Number(p.super_rate).toFixed(1)}%)` : ''}`} />
          {p.payment_date && <Field label="Paid" value={formatDate(p.payment_date)} />}
          <Field label="Frequency" value={p.pay_frequency} />
          {p.hourly_rate != null && <Field label="Hourly rate" value={formatCurrency(p.hourly_rate, currency)} />}
          {p.ytd_gross != null && <Field label="YTD gross" value={formatCurrency(p.ytd_gross, currency)} />}
          {p.ytd_tax != null && <Field label="YTD tax" value={formatCurrency(p.ytd_tax, currency)} />}
          {p.ytd_super != null && <Field label="YTD super" value={formatCurrency(p.ytd_super, currency)} />}
          {p.leave_balance != null && <Field label="Annual leave" value={`${p.leave_balance}`} />}
          {p.sick_leave_balance != null && <Field label="Sick leave" value={`${p.sick_leave_balance}`} />}
          {p.abn && <Field label="ABN" value={p.abn} />}
          {(p.allowances ?? []).length > 0 && (
            <div className="col-span-full">
              <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Allowances</p>
              {p.allowances.map((a, i) => <p key={i} className="font-medium">{a.name}: {formatCurrency(a.amount, currency)}</p>)}
            </div>
          )}
          {(p.deductions ?? []).length > 0 && (
            <div className="col-span-full">
              <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Deductions</p>
              {p.deductions.map((d, i) => <p key={i} className="font-medium">{d.name}: {formatCurrency(d.amount, currency)}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

// ── Add payslip modal (upload → parse → review → save) ───────────────────────
const EMPTY = {
  employer: '', abn: '', employee_name: '', employment_type: 'full_time',
  pay_period_start: '', pay_period_end: '', payment_date: '', pay_frequency: 'fortnightly',
  gross_pay: '', net_pay: '', tax_withheld: '', super_amount: '', super_rate: '',
  ytd_gross: '', ytd_tax: '', ytd_super: '', leave_balance: '', sick_leave_balance: '',
  hourly_rate: '',
};

function AddPayslipModal({ onClose, onSaved }: { onClose: () => void; onSaved: (employer: string, createReminder: boolean) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [allowances, setAllowances] = useState<LineItem[]>([]);
  const [deductions, setDeductions] = useState<LineItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [saving, setSaving] = useState(false);
  // Off by default — only create the recurring "Pay from …" reminder when the
  // user explicitly opts in. Casuals/contractors can't be predicted anyway.
  const [createReminder, setCreateReminder] = useState(false);
  const predictable = PREDICTABLE.has(form.employment_type);

  const str = (v: unknown, fallback: string) => (v === undefined || v === null ? fallback : String(v));

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
        employer:           str(p.employer, f.employer),
        abn:                str(p.abn, f.abn),
        employee_name:      str(p.employee_name, f.employee_name),
        employment_type:    str(p.employment_type, f.employment_type),
        pay_period_start:   str(p.pay_period_start, f.pay_period_start),
        pay_period_end:     str(p.pay_period_end, f.pay_period_end),
        payment_date:       str(p.payment_date, f.payment_date),
        pay_frequency:      str(p.pay_frequency, f.pay_frequency),
        gross_pay:          str(p.gross_pay, f.gross_pay),
        net_pay:            str(p.net_pay, f.net_pay),
        tax_withheld:       str(p.tax_withheld, f.tax_withheld),
        super_amount:       str(p.super_amount, f.super_amount),
        super_rate:         str(p.super_rate, f.super_rate),
        ytd_gross:          str(p.ytd_gross, f.ytd_gross),
        ytd_tax:            str(p.ytd_tax, f.ytd_tax),
        ytd_super:          str(p.ytd_super, f.ytd_super),
        leave_balance:      str(p.leave_balance, f.leave_balance),
        sick_leave_balance: str(p.sick_leave_balance, f.sick_leave_balance),
        hourly_rate:        str(p.hourly_rate, f.hourly_rate),
      }));
      if (Array.isArray(p.allowances)) setAllowances(p.allowances as LineItem[]);
      if (Array.isArray(p.deductions)) setDeductions(p.deductions as LineItem[]);
      setUploadMsg('Payslip parsed — please review the details below.');
    }
    e.target.value = '';
  };

  const num = (v: string) => (v ? parseFloat(v) : null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await payrollApi.createPayslip({
        employer: form.employer || 'Employer',
        abn: form.abn || null,
        employee_name: form.employee_name || null,
        employment_type: form.employment_type,
        pay_period_start: form.pay_period_start || null,
        pay_period_end: form.pay_period_end || null,
        payment_date: form.payment_date || null,
        pay_frequency: form.pay_frequency,
        gross_pay: parseFloat(form.gross_pay) || 0,
        net_pay: parseFloat(form.net_pay) || 0,
        tax_withheld: parseFloat(form.tax_withheld) || 0,
        super_amount: parseFloat(form.super_amount) || 0,
        super_rate: num(form.super_rate),
        ytd_gross: num(form.ytd_gross),
        ytd_tax: num(form.ytd_tax),
        ytd_super: num(form.ytd_super),
        leave_balance: num(form.leave_balance),
        sick_leave_balance: num(form.sick_leave_balance),
        hourly_rate: num(form.hourly_rate),
        allowances,
        deductions,
      });
      onSaved(form.employer || 'Employer', createReminder && predictable);
    } finally { setSaving(false); }
  };

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <Modal isOpen onClose={onClose} title="Add Payslip">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading payslip…' : 'Upload payslip to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.toLowerCase().includes('failed') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>{uploadMsg}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
        <Input label="Employer" value={form.employer} onChange={set('employer')} placeholder="e.g. Acme Pty Ltd" required />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Employment type" value={form.employment_type} onChange={set('employment_type')}
            options={[
              { value: 'full_time', label: 'Full-time' }, { value: 'part_time', label: 'Part-time' },
              { value: 'casual', label: 'Casual' }, { value: 'contractor', label: 'Contractor' },
            ]} />
          <Select label="Pay frequency" value={form.pay_frequency} onChange={set('pay_frequency')}
            options={[
              { value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' },
            ]} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Period start" type="date" value={form.pay_period_start} onChange={set('pay_period_start')} />
          <Input label="Period end" type="date" value={form.pay_period_end} onChange={set('pay_period_end')} />
        </div>
        <Input label="Payment date" type="date" value={form.payment_date} onChange={set('payment_date')} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Gross pay" type="number" step="0.01" prefix="$" value={form.gross_pay} onChange={set('gross_pay')} required />
          <Input label="Net pay" type="number" step="0.01" prefix="$" value={form.net_pay} onChange={set('net_pay')} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Tax withheld" type="number" step="0.01" prefix="$" value={form.tax_withheld} onChange={set('tax_withheld')} />
          <Input label="Super amount" type="number" step="0.01" prefix="$" value={form.super_amount} onChange={set('super_amount')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Super rate %" type="number" step="0.01" value={form.super_rate} onChange={set('super_rate')} placeholder="e.g. 11.5" />
          <Input label="Hourly rate" type="number" step="0.01" prefix="$" value={form.hourly_rate} onChange={set('hourly_rate')} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="YTD gross" type="number" step="0.01" prefix="$" value={form.ytd_gross} onChange={set('ytd_gross')} />
          <Input label="YTD tax" type="number" step="0.01" prefix="$" value={form.ytd_tax} onChange={set('ytd_tax')} />
          <Input label="YTD super" type="number" step="0.01" prefix="$" value={form.ytd_super} onChange={set('ytd_super')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Annual leave bal." type="number" step="0.01" value={form.leave_balance} onChange={set('leave_balance')} />
          <Input label="Sick leave bal." type="number" step="0.01" value={form.sick_leave_balance} onChange={set('sick_leave_balance')} />
        </div>
        {(allowances.length > 0 || deductions.length > 0) && (
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            {allowances.length} allowance(s) and {deductions.length} deduction(s) parsed and will be saved.
          </p>
        )}
        {predictable ? (
          <div className="flex items-center justify-between rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
            <div>
              <p className="text-sm font-medium">Add recurring pay reminder</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                Creates a predicted "Pay from {form.employer || 'employer'}" bill in Overview based on your frequency.
              </p>
            </div>
            <Toggle checked={createReminder} onChange={setCreateReminder} />
          </div>
        ) : (
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            {form.employment_type === 'casual' || form.employment_type === 'contractor'
              ? `${TYPE_LABELS[form.employment_type]} pay is logged as a one-off — no recurring reminder.`
              : 'No recurring reminder for this employment type.'}
          </p>
        )}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth disabled={saving}>{saving ? 'Saving…' : 'Save Payslip'}</Button>
        </div>
      </form>
    </Modal>
  );
}
