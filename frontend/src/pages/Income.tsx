import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { incomeDS, parseDocument } from '../services/dataService';
import { payrollApi, incomeApi } from '../services/api';
import { formatCurrency, formatDate, getCurrentFinancialYear, financialYearOf } from '../utils/format';
import { payrollTotals, onTrackAnnualFromStats, inCurrentFinancialYear, employerGrossForFY, type PayslipCore } from '../utils/payroll';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import SharePanel from '../components/common/SharePanel';
import SharedBadge from '../components/common/SharedBadge';
import { useScopeKey } from '../hooks/useScopeKey';
import { INCOME_CATEGORIES } from '../types';
import type { Investment, IncomeEntry } from '../types';
import PayrollSection from './PayrollSection';
import { Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend);

// Palette for the income-by-source pie (cycled if there are more sources).
const SOURCE_COLOURS = ['#3b7dd8', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#84cc16'];

type Tab = 'Income' | 'Payslips';

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
  const { incomeEntries: allIncomeEntries, user, setIncomeEntries, setProjectedAnnual, investments } = useStore();
  const scopeKey = useScopeKey();
  // The store holds the visible SUPERSET (own + household-shared + granted);
  // the page renders the current scope. Personal shows everything the user
  // earns; a household view shows only what was shared to that household.
  const { entries: incomeEntries, projected_annual: projectedAnnual } = useMemo(
    () => incomeDS.getAll(),
    [allIncomeEntries, scopeKey],
  );
  // Entries somebody granted this user directly — shown, never counted.
  const sharedWithMeIncome = useMemo(
    () => incomeDS.sharedWithMe(),
    [allIncomeEntries, scopeKey],
  );
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Income');
  const [addOpen, setAddOpen] = useState(false);
  const [editingIncome, setEditingIncome] = useState<IncomeEntry | null>(null);
  const [dividendMsg, setDividendMsg] = useState('');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [payslips, setPayslips] = useState<PayslipCore[]>([]);
  const [historyFY, setHistoryFY] = useState<string>(getCurrentFinancialYear());
  // Pie financial year — null = follow the default (current FY, or the most recent
  // FY with income when the current one is still empty, e.g. early in a new FY).
  const [pieFY, setPieFY] = useState<string | null>(null);

  const currency = user?.currency_preference ?? 'AUD';
  const fy = getCurrentFinancialYear();

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
  const { earnedThisYear, byEmployer } = payrollTotals(payslips);

  // "On track to earn this year" = the pay actually earned across the uploaded
  // payslips scaled to 52 weeks (per employer). Simple and robust: numerator and
  // denominator come from the same payslips, so it can't be inflated by a
  // 1-July-straddling YTD figure, projected "repeat" pays, or a double upload.
  // Centralised in payroll.ts so the Payslips recap and Budget match this figure.
  const fyPayslips = payslips.filter(p => inCurrentFinancialYear(p));
  const weeksCovered = fyPayslips.reduce((s, p) => s + payslipWeeks(p), 0);
  const onTrackAnnual = onTrackAnnualFromStats(byEmployer, false);
  const hasPayslips = fyPayslips.length > 0;

  const refreshIncome = () => {
    // The DS write already updated the store (which re-renders this page); the
    // scoped list above must NEVER be written back — it would silently drop
    // every shared row from the cache. Only the stored headline is refreshed.
    setProjectedAnnual(incomeDS.getAll().projected_annual);
  };

  const [payslipCandidate, setPayslipCandidate] = useState<Record<string, unknown> | null>(null);
  const [savingPayslip, setSavingPayslip] = useState(false);

  const pending  = incomeEntries.filter(e => e.status === 'pending');
  const approved = incomeEntries.filter(e => e.status === 'approved');

  // The pie is browsable by financial year. Offer every FY that actually has
  // income — from a placeable payslip or an approved (non-payslip) entry — newest
  // first. Default to the current FY, or the most recent FY with income when the
  // current one is still empty (so the pie doesn't vanish at the start of a new FY).
  const incomeFYs = Array.from(new Set([
    ...payslips
      .map(p => p.payment_date ?? p.pay_period_end)
      .filter((d): d is string => !!d)
      .map(d => financialYearOf(d)),
    ...approved
      .filter(e => !/^payslip:/.test(e.reference_number || ''))
      .map(e => financialYearOf(e.date)),
  ])).sort((a, b) => (a < b ? 1 : -1));
  const defaultPieFY = incomeFYs.includes(fy) ? fy : (incomeFYs[0] ?? fy);
  const activePieFY = pieFY ?? defaultPieFY;

  // Income grouped by source for the pie chart + $ recap — TOTAL income for the
  // selected FY, not just the manual history. Employment income comes from each
  // employer's payslip YTD (the same figure the recap/tax use); all other sources
  // (e.g. dividends, rental, interest) come from approved income entries, excluding
  // any that are payslip-linked so employment income isn't double-counted. For the
  // current FY we reuse `byEmployer` (which carries synthetic "repeat" pays); past
  // FYs are recomputed FY-scoped from the payslips.
  const pieEmployerRows = activePieFY === fy
    ? byEmployer.filter(e => e.gross > 0).map(e => ({ employer: e.employer, gross: e.gross }))
    : employerGrossForFY(payslips, activePieFY);

  const bySource = (() => {
    const map = new Map<string, number>();
    for (const e of pieEmployerRows) {
      map.set(e.employer, (map.get(e.employer) ?? 0) + e.gross);
    }
    for (const e of approved) {
      if (financialYearOf(e.date) !== activePieFY) continue;
      if (/^payslip:/.test(e.reference_number || '')) continue; // already in payslip YTD
      map.set(e.source, (map.get(e.source) ?? 0) + (e.display_amount ?? e.amount));
    }
    const rows = Array.from(map.entries())
      .map(([source, amount]) => ({ source, amount }))
      .sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return { rows, total };
  })();

  const employerNames = new Set(pieEmployerRows.map(e => e.employer));

  // Income History is browsable by financial year. Offer every FY that has an
  // approved entry, plus the current FY, newest first; filter the list to the pick.
  const historyFYs = Array.from(
    new Set([getCurrentFinancialYear(), ...approved.map(e => financialYearOf(e.date))]),
  ).sort((a, b) => (a < b ? 1 : -1));
  const historyEntries = approved.filter(e => financialYearOf(e.date) === historyFY);

  // Breakdown stats for one income source: total, % of FY income, and the
  // individual contributing entries (payslip-derived employer income has no
  // line items, so it's flagged instead).
  const sourceDetail = (source: string) => {
    const row = bySource.rows.find(r => r.source === source);
    const amount = row?.amount ?? 0;
    const pct = bySource.total > 0 ? (amount / bySource.total) * 100 : 0;
    const entries = approved
      .filter(e => e.source === source && financialYearOf(e.date) === activePieFY && !/^payslip:/.test(e.reference_number || ''))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
    return { amount, pct, entries, fromPayslips: employerNames.has(source) };
  };

  const ICONS: Record<string, string> = {
    'Salary': '💼', 'Wage': '⏰', 'Freelance/Contractor': '💻',
    'Rental': '🏠', 'Dividends': '📊', 'Government Payments': '🏛️',
    'Interest': '🏦', 'Bonus': '🎁', 'Trust Distribution': '📋', 'Other': '💰',
  };

  return (
    <Layout>
      <PageHeader title="Income" />

      {/* Tabs */}
      <div className="flex border-b border-zinc-200 dark:border-zinc-800 mb-6">
        {(['Income', 'Payslips'] as Tab[]).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-6 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 ${activeTab === tab ? 'text-brand border-brand' : 'text-zinc-500 dark:text-zinc-400 border-transparent'}`}>
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
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Earned this year</p>
                <p className="text-2xl font-semibold amount mt-1">{formatCurrency(earnedThisYear, currency)}</p>
                <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">On track to earn this year</p>
                  <p className="text-3xl font-semibold amount mt-1">{formatCurrency(onTrackAnnual, currency)}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                    {`Annualised from ${fyPayslips.length} payslip${fyPayslips.length === 1 ? '' : 's'} (${weeksCovered.toFixed(1)} weeks)`} · FY {fy}
                  </p>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">On track to earn this year</p>
                <p className="text-3xl font-semibold amount mt-1">{formatCurrency(projectedAnnual, currency)}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Add payslips for a payslip-based estimate · FY {fy}</p>
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
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{entry.source}</p>
                          <SharedBadge row={entry} />
                        </div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{entry.category} · {formatDate(entry.date)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold amount text-sm">{formatCurrency(entry.display_amount ?? entry.amount, currency)}</span>
                      <Button variant="primary" size="sm" onClick={() => { incomeDS.approve(entry.id); refreshIncome(); }}>Approve</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {dividendMsg && (
            <div className="mb-6 px-3 py-2 rounded-[8px] text-xs bg-brand/10 text-brand flex items-center gap-2">
              <span>📈</span>{dividendMsg}
            </div>
          )}

          {/* Income by source — pie + $ recap, browsable by financial year */}
          {incomeFYs.length > 0 && (
            <Card className="mb-6">
              <div className="flex justify-between items-center mb-4 gap-3">
                <h2 className="font-semibold whitespace-nowrap">Income by source</h2>
                <select
                  value={activePieFY}
                  onChange={e => { setPieFY(e.target.value); setSelectedSource(null); }}
                  className="text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-transparent px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand"
                  title="Financial year"
                >
                  {incomeFYs.map(y => (
                    <option key={y} value={y}>FY {y}{y === getCurrentFinancialYear() ? ' (current)' : ''}</option>
                  ))}
                </select>
              </div>
              {bySource.rows.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-8">No income recorded for FY {activePieFY}.</p>
              ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                <div className="max-w-[220px] mx-auto w-full">
                  <Doughnut
                    data={{
                      labels: bySource.rows.map(r => r.source),
                      datasets: [{
                        data: bySource.rows.map(r => r.amount),
                        backgroundColor: bySource.rows.map((r, i) =>
                          selectedSource && r.source !== selectedSource ? '#d4d4d4' : SOURCE_COLOURS[i % SOURCE_COLOURS.length]),
                        borderWidth: 0,
                      }],
                    }}
                    options={{
                      responsive: true, maintainAspectRatio: true, cutout: '62%',
                      plugins: { legend: { display: false } },
                      onClick: (_evt, els) => {
                        if (!els.length) return;
                        const key = bySource.rows[els[0].index]?.source;
                        if (key) setSelectedSource(prev => (prev === key ? null : key));
                      },
                      onHover: (evt, els) => {
                        const t = evt.native?.target as HTMLElement | undefined;
                        if (t) t.style.cursor = els.length ? 'pointer' : 'default';
                      },
                    }}
                  />
                </div>

                {selectedSource ? (
                  (() => {
                    const d = sourceDetail(selectedSource);
                    const colourIdx = bySource.rows.findIndex(r => r.source === selectedSource);
                    return (
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SOURCE_COLOURS[colourIdx % SOURCE_COLOURS.length] }} />
                            <span className="text-xl">{ICONS[selectedSource] ?? '💰'}</span>
                            <h3 className="text-sm font-semibold truncate">{selectedSource}</h3>
                          </div>
                          <button onClick={() => setSelectedSource(null)} className="text-xs text-brand hover:underline flex-shrink-0">✕ Close</button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Amount</p>
                            <p className="text-sm font-semibold amount text-[#22c55e]">{formatCurrency(d.amount, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">% of income</p>
                            <p className="text-sm font-semibold">{d.pct.toFixed(1)}%</p>
                          </div>
                        </div>
                        <div className="space-y-1 border-t border-zinc-200 dark:border-zinc-800 pt-2">
                          {d.fromPayslips && (
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">From payslip year-to-date earnings.</p>
                          )}
                          {d.entries.map(e => (
                            <div key={e.id} className="flex items-center justify-between text-xs">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span>{ICONS[e.category] ?? '💰'}</span>
                                <span className="truncate">{formatDate(e.date)}{e.category ? ` · ${e.category}` : ''}</span>
                              </span>
                              <span className="font-semibold amount text-[#22c55e] flex-shrink-0 ml-2">{formatCurrency(e.display_amount ?? e.amount, currency)}</span>
                            </div>
                          ))}
                          {!d.fromPayslips && d.entries.length === 0 && (
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">No line items.</p>
                          )}
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="space-y-2">
                    {bySource.rows.map((r, i) => {
                      const pct = bySource.total > 0 ? (r.amount / bySource.total) * 100 : 0;
                      return (
                        <button key={r.source} onClick={() => setSelectedSource(r.source)} className="w-full flex items-center justify-between text-sm hover:opacity-70 transition-opacity">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: SOURCE_COLOURS[i % SOURCE_COLOURS.length] }} />
                            <span className="truncate">{r.source}</span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">{pct.toFixed(0)}%</span>
                          </div>
                          <span className="font-semibold amount text-[#22c55e] flex-shrink-0 ml-3">{formatCurrency(r.amount, currency)}</span>
                        </button>
                      );
                    })}
                    <div className="flex items-center justify-between text-sm pt-2 mt-1 border-t border-zinc-200 dark:border-zinc-800">
                      <span className="font-medium">Total</span>
                      <span className="font-semibold amount">{formatCurrency(bySource.total, currency)}</span>
                    </div>
                  </div>
                )}
              </div>
              )}
            </Card>
          )}

          {/* Income history */}
          <div className="flex justify-between items-center mb-3 gap-3">
            <h2 className="font-semibold whitespace-nowrap">Income History ({historyEntries.length})</h2>
            <div className="flex items-center gap-2">
              <select
                value={historyFY}
                onChange={e => setHistoryFY(e.target.value)}
                className="text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-transparent px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand"
                title="Financial year"
              >
                {historyFYs.map(y => (
                  <option key={y} value={y}>FY {y}{y === getCurrentFinancialYear() ? ' (current)' : ''}</option>
                ))}
              </select>
              <Button variant="primary" size="sm" onClick={() => { setEditingIncome(null); setAddOpen(true); }}>+ Log Income</Button>
            </div>
          </div>

          {historyEntries.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">💰</div>
              <h3 className="font-medium mb-1">No income in FY {historyFY}</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                {historyFY === getCurrentFinancialYear() ? 'Upload a payslip or add income manually.' : 'Nothing recorded for this financial year.'}
              </p>
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>+ Log Income</Button>
            </div>
          ) : (
            <div className="space-y-1">
              {historyEntries.map(entry => (
                <div key={entry.id} className="flex items-center justify-between px-3 py-3 rounded-[8px] hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors group">
                  <div className="flex items-center gap-3">
                    <span className="text-xl w-8 text-center flex-shrink-0">{ICONS[entry.category] ?? '💰'}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{entry.source}</p>
                        <SharedBadge row={entry} />
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {entry.category} · {formatDate(entry.date)}
                        {entry.is_recurring && <span className="ml-1 badge bg-brand/10 text-brand">Recurring</span>}
                        {entry.reference_number && !/^(dividend|payslip):/.test(entry.reference_number) && <span className="ml-1 text-zinc-500">· Ref: {entry.reference_number}</span>}
                        {entry.tax_withheld && entry.tax_withheld > 0 && <span className="ml-1">· Tax withheld: {formatCurrency(entry.display_tax_withheld ?? entry.tax_withheld, currency)}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold amount text-[#22c55e]">+{formatCurrency(entry.display_amount ?? entry.amount, currency)}</span>
                    <button onClick={() => { setEditingIncome(entry); setAddOpen(true); }} className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#3b82f6] transition-all" title="Edit income">✎</button>
                    <button onClick={() => { incomeDS.remove(entry.id); refreshIncome(); }} className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all" title="Delete income">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Income somebody shared with this user directly — same row, same
              money, badged as somebody else's, and in none of the totals above. */}
          {sharedWithMeIncome.length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2">Shared with you</h2>
              <div className="space-y-1">
                {sharedWithMeIncome.map(entry => (
                  <div key={entry.id} className="flex items-center justify-between px-3 py-3 rounded-[8px] bg-zinc-50 dark:bg-zinc-900/50">
                    <div className="flex items-center gap-3">
                      <span className="text-xl w-8 text-center flex-shrink-0">{ICONS[entry.category] ?? '💰'}</span>
                      <div>
                        <p className="text-sm font-medium">{entry.source}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{entry.category} · {formatDate(entry.date)} · shared with you</p>
                      </div>
                    </div>
                    <span className="text-sm font-semibold amount">+{formatCurrency(entry.display_amount ?? entry.amount, currency)}</span>
                  </div>
                ))}
              </div>
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
          const d = data as Record<string, unknown>;
          if (editingIncome) {
            incomeDS.update(editingIncome.id, d as Partial<IncomeEntry>);
          } else {
            incomeDS.add(d as Parameters<typeof incomeDS.add>[0]);
          }
          refreshIncome();
          setAddOpen(false);
          setEditingIncome(null);
          if (!editingIncome && ['Salary', 'Wage'].includes(String(d.category || ''))
              && (Number(d.tax_withheld) > 0 || Number(d.super_contribution) > 0)) {
            setPayslipCandidate(d);
          }
        }}
      />

      {/* Payslip prompt — appears after logging salary/wage with tax/super */}
      <Modal isOpen={!!payslipCandidate} onClose={() => setPayslipCandidate(null)} title="Also save as payslip?">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          This looks like it could be a pay slip. Saving it as a payslip record will feed into your payroll tracking, tax estimates, and super reconciliation.
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setPayslipCandidate(null)}>No, just income</Button>
          <Button variant="primary" fullWidth disabled={savingPayslip} onClick={async () => {
            if (!payslipCandidate) return;
            setSavingPayslip(true);
            try {
              await payrollApi.createPayslip({
                employer: payslipCandidate.source,
                payment_date: payslipCandidate.date,
                gross_pay: Number(payslipCandidate.amount) || 0,
                net_pay: (Number(payslipCandidate.amount) || 0) - (Number(payslipCandidate.tax_withheld) || 0),
                tax_withheld: Number(payslipCandidate.tax_withheld) || 0,
                super_amount: Number(payslipCandidate.super_contribution) || 0,
                pay_frequency: String(payslipCandidate.frequency || 'fortnightly'),
              });
              payrollApi.getAll()
                .then(d => setPayslips((d.payslips ?? []) as PayslipCore[]))
                .catch(() => {});
            } catch { /* best-effort */ }
            setSavingPayslip(false);
            setPayslipCandidate(null);
          }}>
            {savingPayslip ? 'Saving…' : 'Yes, save as payslip'}
          </Button>
        </div>
      </Modal>

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
          <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-zinc-200 dark:border-zinc-800 hover:border-brand/40 cursor-pointer transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{uploading ? 'Reading payslip…' : 'Upload payslip to auto-fill'}</span>
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
              <p className="text-xs text-zinc-500 dark:text-zinc-400">No stock/ETF holdings found. Add them in Investments, or enter the dividend manually below.</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Per share (${nativeCurrency})`} type="number" step="0.0001" prefix="$" value={perShare} onChange={e => setPerShare(e.target.value)} placeholder="e.g. 0.50" required />
              <Input label="Shares held" type="number" step="0.0001" value={shares} onChange={e => setShares(e.target.value)} required />
            </div>
            <Input label="Payment date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
            <div className="rounded-[8px] bg-zinc-100 dark:bg-zinc-900 px-3 py-2.5 text-sm flex items-center justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Total dividend</span>
              <span className="font-semibold amount text-[#22c55e]">
                {formatCurrency(divConvertedTotal, preferredCurrency)}
                {nativeCurrency !== preferredCurrency && (
                  <span className="ml-1 text-xs font-normal text-zinc-500">({formatCurrency(divNativeTotal, nativeCurrency)})</span>
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

        {editing && <SharePanel kind="income" id={editing.id} noun="this income entry" />}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save Changes' : 'Log Income'}</Button>
        </div>
      </form>

    </Modal>
  );
}

