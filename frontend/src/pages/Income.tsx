import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { incomeDS, calculateTax, getTaxBrackets, deductionsDS, parseDocument } from '../services/dataService';
import { payrollApi, incomeApi } from '../services/api';
import { formatCurrency, formatDate, getCurrentFinancialYear } from '../utils/format';
import { payrollTotals, financialYearStart, type PayslipCore } from '../utils/payroll';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import { INCOME_CATEGORIES } from '../types';
import type { Investment, IncomeEntry } from '../types';
import PayrollSection from './PayrollSection';
import { Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend);

// Palette for the income-by-source pie (cycled if there are more sources).
const SOURCE_COLOURS = ['#3b7dd8', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#84cc16'];

type Tab = 'Income' | 'Tax' | 'Payslips';

// Weeks one payslip covers — prefer the actual pay-period span, else the frequency.
const FREQ_WEEKS: Record<string, number> = { weekly: 1, fortnightly: 2, monthly: 52 / 12 };
function payslipWeeks(p: PayslipCore): number {
  if (p.pay_period_start && p.pay_period_end) {
    const days = (new Date(p.pay_period_end).getTime() - new Date(p.pay_period_start).getTime()) / 86_400_000;
    if (days > 0) return (days + 1) / 7; // inclusive of both endpoints
  }
  return FREQ_WEEKS[p.pay_frequency] ?? 2;
}

export default function Income() {
  const { user, incomeEntries, setIncomeEntries, projectedAnnual, setProjectedAnnual, investments } = useStore();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Income');
  const [addOpen, setAddOpen] = useState(false);
  const [editingIncome, setEditingIncome] = useState<IncomeEntry | null>(null);
  const [dividendMsg, setDividendMsg] = useState('');
  const [addDeductionOpen, setAddDeductionOpen] = useState(false);
  const [editingDeduction, setEditingDeduction] = useState<{ id: string; name: string; amount: number; category: string; date: string } | null>(null);
  const [deductions, setDeductions] = useState<ReturnType<typeof deductionsDS.getAll>>([]);
  const [hecsEnabled, setHecsEnabled] = useState(false);
  const [payslips, setPayslips] = useState<PayslipCore[]>([]);

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
      .then(d => setPayslips((d.payslips ?? []) as PayslipCore[]))
      .catch(() => { /* leave empty */ });
  }, []);

  // On opening Income, ask the backend to check dividend-paying holdings for any
  // dividends paid this FY. New ones land as PENDING income entries the user can
  // confirm below. (The same check also runs twice daily via cron.)
  useEffect(() => {
    incomeApi.syncDividends()
      .then(({ created }) => {
        if (created > 0) {
          setDividendMsg(`${created} new dividend${created === 1 ? '' : 's'} found — confirm ${created === 1 ? 'it' : 'them'} below.`);
          incomeApi.getIncome()
            .then((res) => setIncomeEntries((res?.entries ?? []) as IncomeEntry[]))
            .catch(() => { /* keep current */ });
        }
      })
      .catch(() => { /* dividend sync is best-effort */ });
  }, [setIncomeEntries]);

  // Earned-this-year prefers each payslip's YTD gross (which already accumulates
  // every prior pay this FY) over summing individual payslips, and includes any
  // projected "repeat" pays. Shared with the Payslips tab so the numbers agree.
  const { earnedThisYear, taxWithheld: ytdTaxWithheld, usedYtd } = payrollTotals(payslips);

  // Tax estimate is driven by the same payslip-derived totals as the recap
  // (YTD-preferring, including projected "repeat" pays) whenever any payslips
  // exist, so the Tax tab and the Payslips recap always agree. Falls back to
  // summing income entries only when there are no payslips at all.
  const taxData = calculateTax(
    hecsEnabled,
    payslips.length > 0
      ? { total_income: earnedThisYear, tax_withheld: ytdTaxWithheld, total_deductions: totalDeductions }
      : { total_deductions: totalDeductions },
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

  // Income grouped by source for the pie chart + $ recap. Amounts are taken at
  // face value in the user's preferred currency (entries are stored already
  // converted), newest sources by total first.
  const bySource = (() => {
    const map = new Map<string, number>();
    for (const e of approved) map.set(e.source, (map.get(e.source) ?? 0) + e.amount);
    const rows = Array.from(map.entries())
      .map(([source, amount]) => ({ source, amount }))
      .sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return { rows, total };
  })();

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

          {dividendMsg && (
            <div className="mb-6 px-3 py-2 rounded-[8px] text-xs bg-[#3b7dd8]/10 text-[#3b7dd8] flex items-center gap-2">
              <span>📈</span>{dividendMsg}
            </div>
          )}

          {/* Income by source — pie + $ recap */}
          {bySource.rows.length > 0 && (
            <Card className="mb-6">
              <h2 className="font-semibold mb-4">Income by source</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                <div className="max-w-[220px] mx-auto w-full">
                  <Doughnut
                    data={{
                      labels: bySource.rows.map(r => r.source),
                      datasets: [{
                        data: bySource.rows.map(r => r.amount),
                        backgroundColor: bySource.rows.map((_, i) => SOURCE_COLOURS[i % SOURCE_COLOURS.length]),
                        borderWidth: 0,
                      }],
                    }}
                    options={{ responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } }, cutout: '62%' }}
                  />
                </div>
                <div className="space-y-2">
                  {bySource.rows.map((r, i) => {
                    const pct = bySource.total > 0 ? (r.amount / bySource.total) * 100 : 0;
                    return (
                      <div key={r.source} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SOURCE_COLOURS[i % SOURCE_COLOURS.length] }} />
                          <span className="truncate">{r.source}</span>
                          <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] flex-shrink-0">{pct.toFixed(0)}%</span>
                        </div>
                        <span className="font-semibold amount text-[#22c55e] flex-shrink-0 ml-3">{formatCurrency(r.amount, currency)}</span>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between text-sm pt-2 mt-1 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                    <span className="font-medium">Total</span>
                    <span className="font-semibold amount">{formatCurrency(bySource.total, currency)}</span>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Income history */}
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">Income History ({approved.length})</h2>
            <Button variant="primary" size="sm" onClick={() => { setEditingIncome(null); setAddOpen(true); }}>+ Log Income</Button>
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
                        {entry.reference_number && !/^(dividend|payslip):/.test(entry.reference_number) && <span className="ml-1 text-[#6b6b6b]">· Ref: {entry.reference_number}</span>}
                        {entry.tax_withheld && entry.tax_withheld > 0 && <span className="ml-1">· Tax withheld: {formatCurrency(entry.tax_withheld, entry.currency)}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold amount text-[#22c55e]">+{formatCurrency(entry.amount, entry.currency)}</span>
                    <button onClick={() => { setEditingIncome(entry); setAddOpen(true); }} className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#3b82f6] transition-all" title="Edit income">✎</button>
                    <button onClick={() => { incomeDS.remove(entry.id); refreshIncome(); }} className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all" title="Delete income">✕</button>
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
            <Button variant="secondary" size="sm" onClick={() => { setEditingDeduction(null); setAddDeductionOpen(true); }}>+ Add</Button>
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
                    <button onClick={() => { setEditingDeduction(d); setAddDeductionOpen(true); }} className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#3b82f6] transition-all" title="Edit deduction">✎</button>
                    <button onClick={() => { deductionsDS.remove(d.id); setDeductions(deductionsDS.getAll()); }} className="text-xs text-[#6b6b6b] opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all" title="Delete deduction">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── PAYSLIPS TAB ── */}
      {activeTab === 'Payslips' && <PayrollSection currency={currency} onPayslipsChange={setPayslips} />}

      {/* ── MODALS ── */}
      <AddIncomeModal
        isOpen={addOpen}
        editing={editingIncome}
        investments={investments}
        preferredCurrency={currency}
        onClose={() => { setAddOpen(false); setEditingIncome(null); }}
        onSave={(data) => {
          if (editingIncome) {
            incomeDS.update(editingIncome.id, data as Partial<IncomeEntry>);
          } else {
            incomeDS.add(data as Parameters<typeof incomeDS.add>[0]);
          }
          refreshIncome();
          setAddOpen(false);
          setEditingIncome(null);
        }}
      />

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

// ─── Add Income Modal ────────────────────────────────────────────────────────

interface IncomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (d: object) => void;
  editing?: IncomeEntry | null;
  investments: Investment[];
  preferredCurrency: string;
}

function AddIncomeModal({ isOpen, onClose, onSave, editing, investments, preferredCurrency }: IncomeModalProps) {
  const blank = {
    source: '', amount: '', currency: preferredCurrency, category: 'Salary',
    is_recurring: false, frequency: 'fortnightly',
    reference_number: '', date: new Date().toISOString().split('T')[0],
    tax_withheld: '', super_contribution: '', status: 'approved' as const,
  };
  const [form, setForm] = useState(blank);
  // Dividend-mode fields (only used when category === 'Dividends').
  const [divInvestmentId, setDivInvestmentId] = useState('');
  const [perShare, setPerShare] = useState('');
  const [shares, setShares] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const isDividend = form.category === 'Dividends';
  const dividendHoldings = investments.filter(i => ['stock', 'etf', 'managed_fund'].includes(i.asset_type));
  const selectedHolding = investments.find(i => i.id === divInvestmentId);
  // Convert per-share × shares from the holding's native currency to the user's
  // preferred currency using the rate snapshotted on the holding.
  const divRate = selectedHolding?.conversion_rate ?? 1;
  const divNativeTotal = (parseFloat(perShare) || 0) * (parseFloat(shares) || 0);
  const divConvertedTotal = parseFloat((divNativeTotal * divRate).toFixed(2));
  const nativeCurrency = selectedHolding?.native_currency ?? preferredCurrency;

  useEffect(() => {
    if (editing) {
      setForm({
        source: editing.source, amount: String(editing.amount), currency: editing.currency || preferredCurrency,
        category: editing.category, is_recurring: editing.is_recurring, frequency: editing.frequency || 'fortnightly',
        reference_number: /^(dividend|payslip):/.test(editing.reference_number || '') ? '' : (editing.reference_number || ''),
        date: editing.date, tax_withheld: editing.tax_withheld ? String(editing.tax_withheld) : '',
        super_contribution: editing.super_contribution ? String(editing.super_contribution) : '', status: 'approved',
      });
    } else {
      setForm(blank);
    }
    setDivInvestmentId(''); setPerShare(''); setShares(''); setUploadMsg('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isOpen]);

  // When a holding is chosen, default the share count to the held quantity.
  useEffect(() => {
    if (selectedHolding) setShares(String(selectedHolding.shares_owned));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divInvestmentId]);

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
    if (isDividend) {
      onSave({
        source: selectedHolding ? `${selectedHolding.ticker} dividend` : (form.source || 'Dividend'),
        amount: divConvertedTotal,
        currency: preferredCurrency,
        category: 'Dividends',
        is_recurring: false,
        frequency: form.frequency,
        reference_number: form.reference_number,
        date: form.date,
        tax_withheld: 0,
        super_contribution: 0,
        status: 'approved',
      });
    } else {
      onSave({
        ...form,
        amount:             parseFloat(form.amount) || 0,
        tax_withheld:       form.tax_withheld  ? parseFloat(form.tax_withheld)  : 0,
        super_contribution: form.super_contribution ? parseFloat(form.super_contribution) : 0,
      });
    }
    setForm(blank); setDivInvestmentId(''); setPerShare(''); setShares(''); setUploadMsg('');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit Income' : 'Log Income'}>
      {!isDividend && !editing && (
        <>
          <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading payslip…' : 'Upload payslip to auto-fill'}</span>
            <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
          </label>
          {uploadMsg && (
            <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('requires') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>{uploadMsg}</div>
          )}
        </>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select label="Income type" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          options={[...INCOME_CATEGORIES].map(c => ({ value: c, label: c }))}
        />

        {isDividend ? (
          <>
            {dividendHoldings.length > 0 ? (
              <Select label="Stock / holding" value={divInvestmentId} onChange={e => setDivInvestmentId(e.target.value)}
                options={[{ value: '', label: 'Select a holding…' }, ...dividendHoldings.map(i => ({ value: i.id, label: `${i.ticker} — ${i.name}` }))]}
              />
            ) : (
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">No stock/ETF holdings found. Add them in Investments, or enter the dividend manually below.</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Per share (${nativeCurrency})`} type="number" step="0.0001" prefix="$" value={perShare} onChange={e => setPerShare(e.target.value)} placeholder="e.g. 0.50" required />
              <Input label="Shares held" type="number" step="0.0001" value={shares} onChange={e => setShares(e.target.value)} required />
            </div>
            <Input label="Payment date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
            <div className="rounded-[8px] bg-[#f5f5f5] dark:bg-[#1a1a1a] px-3 py-2.5 text-sm flex items-center justify-between">
              <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Total dividend</span>
              <span className="font-semibold amount text-[#22c55e]">
                {formatCurrency(divConvertedTotal, preferredCurrency)}
                {nativeCurrency !== preferredCurrency && (
                  <span className="ml-1 text-xs font-normal text-[#6b6b6b]">({formatCurrency(divNativeTotal, nativeCurrency)})</span>
                )}
              </span>
            </div>
          </>
        ) : (
          <>
            <Input label="Source / Employer" value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} placeholder="e.g. Employer Pty Ltd" required />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
              <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
            </div>
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
          </>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save Changes' : 'Log Income'}</Button>
        </div>
      </form>
    </Modal>
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
