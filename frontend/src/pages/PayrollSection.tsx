import { useState, useEffect, useCallback } from 'react';
import { payrollApi } from '../services/api';
import { parseDocument, billsDS, incomeDS } from '../services/dataService';
import { useStore } from '../store';
import { formatCurrency, formatDate } from '../utils/format';
import {
  TYPE_LABELS, PREDICTABLE,
  payrollTotals, nextPredictedPay, addFreq,
  getConfirmedRecurring, setConfirmedRecurring,
  getRepeat, setRepeat, getRates, setRates, getPosition, setPosition,
  getTaxFreeThreshold, setTaxFreeThreshold, taxFreeThresholdClaims,
  type EmployerStats, type RateSettings,
} from '../utils/payroll';
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

interface AddPrefill { employer?: string; payment_date?: string }

/**
 * Create / refresh the "expected pay" reminder bill for an employer. Supports
 * alternating cycles (next pay = the older of two differing recent nets).
 */
function refreshPayPrediction(payslips: Payslip[], employer: string, force = false): void {
  const mine = payslips
    .filter(p => p.employer === employer && p.payment_date)
    .sort((a, b) => (b.payment_date! < a.payment_date! ? -1 : 1));
  if (mine.length === 0) return;
  const latest = mine[0];
  if (!force && !PREDICTABLE.has(latest.employment_type)) return;

  const freq = latest.pay_frequency;
  let nextAmount = latest.net_pay;
  if (mine.length >= 2 && Math.abs(mine[0].net_pay - mine[1].net_pay) > 1) nextAmount = mine[1].net_pay;
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

function removePayPrediction(employer: string): void {
  const existing = useStore.getState().bills.find(b => !b.is_paid && b.name === `Pay from ${employer}`);
  if (existing) billsDS.remove(existing.id);
}

// Delete a payslip and the income-history entry it created (cascade).
async function deletePayslipCascade(id: string): Promise<void> {
  await payrollApi.deletePayslip(id);
  const linked = useStore.getState().incomeEntries.find(e => e.reference_number === `payslip:${id}`);
  if (linked) incomeDS.remove(linked.id);
}

export default function PayrollSection({ currency, onPayslipsChange }: { currency: string; onPayslipsChange?: (slips: Payslip[]) => void }) {
  const [data, setData] = useState<PayrollData | null>(null);
  const [loading, setLoading] = useState(true);
  const [addPrefill, setAddPrefill] = useState<AddPrefill | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bump, setBump] = useState(0); // re-render when localStorage prefs change

  const reload = useCallback(async () => {
    try {
      const fresh = await payrollApi.getAll();
      setData(fresh);
      onPayslipsChange?.((fresh as PayrollData).payslips);
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, [onPayslipsChange]);

  useEffect(() => { reload(); }, [reload]);

  if (loading) return <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Loading payslips…</p>;
  if (!data) return <p className="text-sm text-[#ef4444]">Could not load payroll data.</p>;

  const payslips = data.payslips;
  void bump; // referenced so prefs changes force a recompute below
  const totals = payrollTotals(payslips);
  const employers = totals.byEmployer;

  // Soonest predicted next pay across all employers (only for predictable /
  // confirmed / repeat employers).
  let nextPay: { employer: string; date: string; amount: number } | null = null;
  for (const e of employers) {
    if (!e.latest) continue;
    const eligible = PREDICTABLE.has(e.latest.employment_type) || getConfirmedRecurring(e.employer) || e.repeat;
    if (!eligible) continue;
    const np = nextPredictedPay(e);
    if (np && (!nextPay || np.date < nextPay.date)) nextPay = { employer: e.employer, ...np };
  }

  const selectedStats = selected ? employers.find(e => e.employer === selected) ?? null : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Payslips</h2>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Upload a payslip to track pay, tax and super · FY {data.financial_year}</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setAddPrefill({})}>+ Add Payslip</Button>
      </div>

      {/* ── Recap: next pay, total earned, total tax ── */}
      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Next pay (predicted)</p>
            {nextPay ? (
              <>
                <p className="text-xl font-semibold amount mt-1">{formatCurrency(nextPay.amount, currency)}</p>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatDate(nextPay.date)} · {nextPay.employer}</p>
              </>
            ) : (
              <p className="text-sm mt-1 text-[#6b6b6b] dark:text-[#a0a0a0]">No prediction yet</p>
            )}
          </div>
          <div>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Total earned this year</p>
            <p className="text-xl font-semibold amount mt-1 text-[#22c55e]">{formatCurrency(totals.earnedThisYear, currency)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{totals.usedYtd ? 'From payslip YTD' : 'Summed from payslips'}</p>
          </div>
          <div>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Total tax paid</p>
            <p className="text-xl font-semibold amount mt-1">{formatCurrency(totals.taxWithheld, currency)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Withheld this FY</p>
          </div>
        </div>
      </Card>

      {/* ── Employers (overview cards) ── */}
      {employers.length > 0 && (
        <div>
          <h3 className="font-medium mb-3">Employers ({employers.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {employers.map(e => (
              <EmployerCard key={e.employer} stats={e} currency={currency} onClick={() => setSelected(e.employer)} />
            ))}
          </div>
        </div>
      )}

      {/* ── Global payslip history ── */}
      <div>
        <h3 className="font-medium mb-3">History ({payslips.length})</h3>
        {payslips.length === 0 ? (
          <Card>
            <div className="text-center py-8">
              <div className="text-3xl mb-2">🧾</div>
              <h3 className="font-medium mb-1">No payslips yet</h3>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Upload a payslip PDF to extract your pay, tax and super automatically.</p>
              <Button variant="secondary" size="sm" onClick={() => setAddPrefill({})}>+ Add Payslip</Button>
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

      {addPrefill && (
        <AddPayslipModal
          currency={currency}
          prefill={addPrefill}
          onClose={() => setAddPrefill(null)}
          onSaved={async (employer, createReminder) => {
            setAddPrefill(null);
            await reload();
            if (createReminder) {
              const fresh = await payrollApi.getAll();
              refreshPayPrediction((fresh as PayrollData).payslips, employer);
            }
          }}
        />
      )}

      {selectedStats && (
        <EmployerDetailModal
          stats={selectedStats as EmployerStats}
          allEmployers={employers.map(e => e.employer)}
          currency={currency}
          onClose={() => setSelected(null)}
          onChanged={() => setBump(b => b + 1)}
          onAddPayslip={(prefill) => { setSelected(null); setAddPrefill(prefill); }}
          onDeleted={reload}
        />
      )}
    </div>
  );
}

// ── Employer overview card ───────────────────────────────────────────────────
function EmployerCard({ stats, currency, onClick }: { stats: EmployerStats; currency: string; onClick: () => void }) {
  const { employer, latest } = stats;
  if (!latest) return null;
  const position = getPosition(employer) || TYPE_LABELS[latest.employment_type];
  const eligible = PREDICTABLE.has(latest.employment_type) || getConfirmedRecurring(employer) || stats.repeat;
  const np = eligible ? nextPredictedPay(stats) : null;

  return (
    <button onClick={onClick} className="text-left card p-4 hover:border-[#3b7dd8]/40 transition-colors w-full">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-medium">{employer}</p>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{position} · paid {latest.pay_frequency}</p>
        </div>
        <span className="text-xs text-[#3b7dd8]">Details →</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Next pay</p>
          {np ? (
            <>
              <p className="text-sm font-semibold amount">{formatCurrency(np.amount, currency)}</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatDate(np.date)}</p>
            </>
          ) : (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">—</p>
          )}
        </div>
        <div>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Earned (FY)</p>
          <p className="text-sm font-semibold amount text-[#22c55e]">{formatCurrency(stats.gross, currency)}</p>
        </div>
      </div>
    </button>
  );
}

// ── Employer detail popup ────────────────────────────────────────────────────
function EmployerDetailModal({ stats, allEmployers, currency, onClose, onChanged, onAddPayslip, onDeleted }: {
  stats: EmployerStats; allEmployers: string[]; currency: string; onClose: () => void; onChanged: () => void;
  onAddPayslip: (prefill: AddPrefill) => void; onDeleted: () => void;
}) {
  const { employer, latest, real, synthetic } = stats;
  const [confirmed, setConfirmedState] = useState(() => getConfirmedRecurring(employer));
  const [repeat, setRepeatState] = useState(() => getRepeat(employer));
  const [position, setPositionState] = useState(() => getPosition(employer));
  const [rates, setRatesState] = useState<RateSettings>(() => getRates(employer));
  const [tft, setTftState] = useState(() => getTaxFreeThreshold(employer));

  if (!latest) return null;
  const autoPredictable = PREDICTABLE.has(latest.employment_type);
  const showConfirmToggle = !autoPredictable;

  const handleConfirm = (v: boolean) => {
    setConfirmedState(v);
    setConfirmedRecurring(employer, v);
    if (v) refreshPayPrediction(real as Payslip[], employer, true);
    else removePayPrediction(employer);
    onChanged();
  };
  const handleRepeat = (v: boolean) => { setRepeatState(v); setRepeat(employer, v); onChanged(); };
  const handleTft = (v: boolean) => { setTftState(v); setTaxFreeThreshold(employer, v); onChanged(); };
  const handlePosition = (v: string) => { setPositionState(v); setPosition(employer, v); };
  const updateRates = (patch: Partial<RateSettings>) => {
    const next = { ...rates, ...patch };
    setRatesState(next); setRates(employer, next); onChanged();
  };

  const handleDelete = async (id: string) => {
    await deletePayslipCascade(id);
    onDeleted();
    onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={employer}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {/* Overview */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="YTD earnings" value={formatCurrency(stats.gross, currency)} />
          <Field label="YTD tax" value={formatCurrency(stats.tax, currency)} />
          <Field label="Super (YTD)" value={formatCurrency(stats.superAmt, currency)} />
          <Field label="Type" value={TYPE_LABELS[latest.employment_type]} />
          <Field label="Frequency" value={latest.pay_frequency} />
          {latest.hourly_rate != null && <Field label="Base hourly" value={formatCurrency(latest.hourly_rate, currency)} />}
        </div>

        {/* Position */}
        <Input label="Position / job title" value={position} onChange={e => handlePosition(e.target.value)} placeholder={TYPE_LABELS[latest.employment_type]} />

        {/* Pay-frequency confirmation (casual/contractor only) */}
        {showConfirmToggle && (
          <div className="flex items-center justify-between rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
            <div className="pr-3">
              <p className="text-sm font-medium">Detected: paid {latest.pay_frequency}</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                {confirmed
                  ? `Predicting your next ${latest.pay_frequency} pay. Turn off if it was a one-off.`
                  : `Was this a one-off, or are you actually paid ${latest.pay_frequency}? Turn on to predict your next pay.`}
              </p>
            </div>
            <Toggle checked={confirmed} onChange={handleConfirm} />
          </div>
        )}

        {/* Repeat (same each period) */}
        <div className="flex items-center justify-between rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
          <div className="pr-3">
            <p className="text-sm font-medium">My pay is the same each period</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
              Copies your latest pay into totals each {latest.pay_frequency} period until you upload a new payslip.
              {synthetic.length > 0 && ` ${synthetic.length} period${synthetic.length === 1 ? '' : 's'} projected so far.`}
            </p>
          </div>
          <Toggle checked={repeat} onChange={handleRepeat} />
        </div>

        {/* Tax-free threshold (TFN declaration: claim from one payer only).
            PAYG is withheld per job independently, so forfeiting the threshold
            on a job means over-withholding ~19% of the $18,200 tax-free amount,
            refunded only after lodging. */}
        <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
          <div className="flex items-center justify-between">
            <div className="pr-3">
              <p className="text-sm font-medium">Claiming the tax-free threshold</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                {tft
                  ? 'The first $18,200 you earn is tax-free here. Only claim this from one employer.'
                  : 'Not claimed here. PAYG is worked out per job, so this employer withholds tax as if you get no tax-free threshold — you overpay through the year and get it back as a refund.'}
              </p>
            </div>
            <Toggle checked={tft} onChange={handleTft} />
          </div>
          {!tft && (
            <p className="text-xs text-[#f59e0b] mt-2">
              ≈ {formatCurrency(Math.min(stats.gross, 18200) * 0.19, currency)} extra withheld so far this year from this job — refunded at tax time.
            </p>
          )}
          {taxFreeThresholdClaims(allEmployers) > 1 && (
            <p className="text-xs text-[#ef4444] mt-2">
              You're claiming the tax-free threshold from more than one employer — this usually leads to a tax bill. Claim it from only one (typically your highest-paying job).
            </p>
          )}
        </div>

        {/* Weekend / penalty rates */}
        <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Weekend / penalty rates</p>
            <Toggle checked={rates.weekendEnabled} onChange={v => updateRates({ weekendEnabled: v })} />
          </div>
          {rates.weekendEnabled && (
            <div className="grid grid-cols-3 gap-3 mt-3">
              <Input label="Weekday $/hr" type="number" step="0.01" prefix="$"
                value={rates.weekdayRate ?? ''} onChange={e => updateRates({ weekdayRate: e.target.value ? parseFloat(e.target.value) : undefined })} />
              <Input label="Weekend $/hr" type="number" step="0.01" prefix="$"
                value={rates.weekendRate ?? ''} onChange={e => updateRates({ weekendRate: e.target.value ? parseFloat(e.target.value) : undefined })} />
              <Input label="Weekend hrs" type="number" step="0.5"
                value={rates.weekendHours ?? ''} onChange={e => updateRates({ weekendHours: e.target.value ? parseFloat(e.target.value) : undefined })} />
            </div>
          )}
        </div>

        {/* This employer's payslips */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Payslips ({real.length})</p>
            <Button variant="secondary" size="sm" onClick={() => onAddPayslip({ employer })}>+ Add</Button>
          </div>
          <div className="space-y-1.5">
            {real.map(p => (
              <div key={(p as Payslip).id} className="flex items-center justify-between px-3 py-2 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] text-xs group">
                <div>
                  <p className="font-medium">{p.payment_date ? formatDate(p.payment_date) : 'Unknown date'}</p>
                  <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Gross {formatCurrency(p.gross_pay, currency)} · Tax {formatCurrency(p.tax_withheld, currency)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-[#22c55e]">+{formatCurrency(p.net_pay, currency)}</span>
                  <button onClick={() => handleDelete((p as Payslip).id)} className="text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all">✕</button>
                </div>
              </div>
            ))}
            {/* Synthetic (repeat) periods with no uploaded payslip */}
            {synthetic.map(s => (
              <div key={s.payment_date} className="flex items-center justify-between px-3 py-2 rounded-[8px] border border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] text-xs">
                <div>
                  <p className="font-medium">{formatDate(s.payment_date)}</p>
                  <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">No payslip provided · copied from latest</p>
                </div>
                <button className="text-[#3b7dd8] hover:underline" onClick={() => onAddPayslip({ employer, payment_date: s.payment_date })}>Add payslip</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Single payslip row (expandable detail, global history) ───────────────────
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
            onClick={async (e) => { e.stopPropagation(); await deletePayslipCascade(p.id); onDeleted(); }}
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

function AddPayslipModal({ currency, prefill, onClose, onSaved }: { currency: string; prefill: AddPrefill; onClose: () => void; onSaved: (employer: string, createReminder: boolean) => void }) {
  const [form, setForm] = useState({ ...EMPTY, employer: prefill.employer ?? '', payment_date: prefill.payment_date ?? '' });
  const [allowances, setAllowances] = useState<LineItem[]>([]);
  const [deductions, setDeductions] = useState<LineItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [saving, setSaving] = useState(false);
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
      const created = await payrollApi.createPayslip({
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
      }) as { id?: string };

      // Mirror the payslip into the Income tab so it flows into the income list
      // and tax estimate. Linked via reference_number so deleting the payslip
      // also removes this income entry (cascade).
      const incomeCategory =
        form.employment_type === 'contractor' ? 'Freelance/Contractor'
        : form.employment_type === 'casual' ? 'Wage'
        : 'Salary';
      incomeDS.add({
        source: form.employer || 'Employer',
        amount: parseFloat(form.gross_pay) || 0,
        currency,
        category: incomeCategory,
        frequency: form.pay_frequency,
        is_recurring: false,
        reference_number: created?.id ? `payslip:${created.id}` : undefined,
        date: form.payment_date || new Date().toISOString().slice(0, 10),
        status: 'approved',
        tax_withheld: parseFloat(form.tax_withheld) || 0,
        super_contribution: parseFloat(form.super_amount) || 0,
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
              ? `${TYPE_LABELS[form.employment_type]} pay is logged as a one-off — confirm a recurring cycle from the employer's detail popup.`
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
