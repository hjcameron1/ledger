import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import {
  calculateNetWorth, billsDS, goalsDS,
} from '../services/dataService';
import { formatCurrency, formatRelativeDate, formatDate, daysUntil, formatPercent, colorForChange } from '../utils/format';
import { overviewApi } from '../services/api';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

export default function Overview() {
  const {
    user, setNetWorth, netWorth, netWorthHistory,
    setBills, goals, setGoals,
    widgetVisibility, setWidgetVisibility,
    accounts, creditCards, investments, superFunds,
  } = useStore();

  const [searchParams] = useSearchParams();
  const [customiseOpen, setCustomiseOpen] = useState(false);
  const [billsExpanded, setBillsExpanded] = useState(false);
  const [addBillOpen, setAddBillOpen] = useState(false);
  const [addGoalOpen, setAddGoalOpen] = useState(false);

  const currency = user?.currency_preference ?? 'AUD';

  // Net-worth % change trend. Forward-only snapshots (hourly cron + on page
  // load); % is measured from the user's first-ever snapshot, the toggle zooms.
  type NwPoint = { recorded_at: string; pct: number; value: number };
  const [nwTimeframe, setNwTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>('weekly');
  const [nwHistory, setNwHistory] = useState<NwPoint[]>([]);
  const [nwBaseline, setNwBaseline] = useState(0);

  useEffect(() => {
    overviewApi.getNetWorthPctHistory(nwTimeframe)
      .then(r => { setNwHistory(r.points ?? []); setNwBaseline(r.baseline ?? 0); })
      .catch(() => { setNwHistory([]); setNwBaseline(0); });
  }, [nwTimeframe]);

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NW_WINDOW: Record<string, number> = {
    daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS, yearly: 365 * DAY_MS,
  };
  const NW_TF_LABELS: { key: typeof nwTimeframe; label: string }[] = [
    { key: 'daily', label: 'Daily' }, { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' }, { key: 'yearly', label: 'Yearly' },
    { key: 'all', label: 'All time' },
  ];

  const nwNowMs = Date.now();
  const nwPoints = nwHistory.map(p => ({ x: new Date(p.recorded_at).getTime(), y: p.pct }));
  // Append/refresh a live point from current net worth vs the baseline.
  const liveNw = netWorth?.net_worth ?? 0;
  if (nwBaseline !== 0 && liveNw) {
    const livePct = parseFloat((((liveNw - nwBaseline) / nwBaseline) * 100).toFixed(4));
    const last = nwPoints[nwPoints.length - 1];
    if (!last || nwNowMs - last.x > 60 * 1000) nwPoints.push({ x: nwNowMs, y: livePct });
    else last.y = livePct;
  }
  const nwWin = NW_WINDOW[nwTimeframe];
  const nwAxisMin = nwWin ? nwNowMs - nwWin : (nwPoints.length ? nwPoints[0].x : nwNowMs - DAY_MS);
  const nwCurrentPct = nwPoints[nwPoints.length - 1]?.y ?? 0;
  const nwUp = nwCurrentPct >= 0;
  const nwColor = nwUp ? '#22c55e' : '#ef4444';

  const nwChartData = {
    datasets: [{
      data: nwPoints,
      borderColor: nwColor,
      backgroundColor: (ctx: { chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } } }) => {
        const area = ctx.chart.chartArea;
        if (!area) return nwUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, nwUp ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      },
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.4,
      fill: true,
    }],
  };

  const nwChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        callbacks: {
          title: (items: { parsed: { x: number | null } }[]) => {
            const d = new Date(items[0].parsed.x ?? 0);
            return nwTimeframe === 'daily'
              ? d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
              : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          },
          label: (item: { parsed: { y: number | null } }) => `${(item.parsed.y ?? 0) >= 0 ? '+' : ''}${(item.parsed.y ?? 0).toFixed(2)}%`,
        },
      },
    },
    // Minimal "glanceable" sparkline — no axes, ticks or gridlines. The headline
    // % above the chart carries the actual number; the line just shows the shape.
    scales: {
      x: { type: 'linear' as const, min: nwAxisMin, max: nwNowMs, display: false },
      y: { display: false },
    },
  };

  // Recalculate net worth from local data every time relevant data changes
  useEffect(() => {
    const nw = calculateNetWorth();
    setNetWorth(nw);
  }, [accounts, creditCards, investments, superFunds, setNetWorth]);

  useEffect(() => {
    if (searchParams.get('add') === 'bill') setAddBillOpen(true);
    if (searchParams.get('add') === 'goal') setAddGoalOpen(true);
  }, [searchParams]);

  const [dismissedDupes, setDismissedDupes] = useState<string[]>([]);

  const upcomingBills = billsDS.getAll();
  const recentlyPaidBills = billsDS.getRecentlyPaid();
  const urgentBills = upcomingBills.filter(b => daysUntil(b.due_date) <= 7);

  // Bills the user renamed whose original (import) name has re-appeared as a
  // separate bill — surfaced as a "looks like a duplicate" prompt.
  const duplicateBills = billsDS.findDuplicates()
    .filter(d => !dismissedDupes.includes(d.duplicate.id));

  const billColour: Record<string, string> = {
    grey:   'bg-[#f5f5f5] dark:bg-[#2a2a2a]',
    yellow: 'bg-[#f59e0b]/10 border border-[#f59e0b]/30',
    red:    'bg-[#ef4444]/10 border border-[#ef4444]/20',
  };

  // Auto-pay bills are always "on track" (green, never overdue). Manual bills
  // go amber when due today/tomorrow and red once overdue.
  const billWrapClass = (bill: import('../types').Bill): string => {
    if (bill.auto_pay) return 'bg-[#22c55e]/10 border border-[#22c55e]/30';
    const days = daysUntil(bill.due_date);
    if (days < 0) return billColour.red;
    if (days <= 1) return billColour.yellow;
    return billColour[bill.colour] ?? billColour.grey;
  };

  const billStatusText = (bill: import('../types').Bill): string => {
    const days = daysUntil(bill.due_date);
    if (bill.auto_pay) {
      return days <= 0 ? 'Auto-pays today' : days === 1 ? 'Auto-pays tomorrow' : `Auto-pays in ${days} days`;
    }
    return days < 0 ? `Overdue by ${Math.abs(days)} days`
      : days === 0 ? 'Due today'
      : days === 1 ? 'Due tomorrow'
      : `Due in ${days} days`;
  };

  const refreshBills = () => setBills([...useStore.getState().bills]);

  const handlePayBill = (id: string) => {
    billsDS.pay(id);
    refreshBills();
  };

  const handleRestoreBill = (id: string) => {
    billsDS.restore(id);
    refreshBills();
  };

  return (
    <Layout onCustomise={() => setCustomiseOpen(true)}>
      {/* Net Worth Hero */}
      <div className="mb-6">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Total net worth</p>
        <h1 className="text-4xl sm:text-5xl font-semibold amount tracking-tight mt-1">
          {formatCurrency(netWorth?.net_worth ?? 0, currency)}
        </h1>
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">
          {currency} · Updated just now
          {nwPoints.length > 0 && (
            <span className={`ml-2 font-medium ${colorForChange(nwCurrentPct)}`}>
              {formatPercent(nwCurrentPct)} since you started tracking
            </span>
          )}
        </p>

        <div className="mt-4">
          <div className="flex justify-end mb-2">
            <div className="flex gap-1 bg-[#f3f4f6] dark:bg-[#1a1a1a] rounded-lg p-1">
              {NW_TF_LABELS.map(tf => (
                <button
                  key={tf.key}
                  onClick={() => setNwTimeframe(tf.key)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    nwTimeframe === tf.key
                      ? 'bg-white dark:bg-[#2a2a2a] text-[#0f0f0f] dark:text-white shadow-sm font-medium'
                      : 'text-[#6b6b6b] dark:text-[#a0a0a0]'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>
          <div className="h-32">
            {nwPoints.length > 0 ? (
              <Line data={nwChartData} options={nwChartOptions} />
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
                No history yet — your net worth change will be tracked from today.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Bank accounts',  value: netWorth?.bank_balance ?? 0,    isDebt: false },
          { label: 'Investments',    value: netWorth?.investments ?? 0,      isDebt: false },
          { label: 'Credit cards',   value: netWorth?.credit_card_debt ?? 0, isDebt: true  },
          { label: 'Superannuation', value: netWorth?.super ?? 0,            isDebt: false },
        ].map(item => (
          <Card key={item.label} padding="sm">
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{item.label}</p>
            <p className={`text-base font-semibold amount mt-1 ${item.isDebt && item.value > 0 ? 'text-[#ef4444]' : ''}`}>
              {formatCurrency(item.value, currency, true)}
            </p>
          </Card>
        ))}
      </div>

      {/* Bills Widget */}
      {widgetVisibility.bills && (
        <Card className="mb-4" padding="none">
          <div className="px-5 py-4 flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
            <div>
              <h2 className="font-semibold">Bills &amp; Reminders</h2>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{urgentBills.length} due this week</p>
            </div>
            <button onClick={() => setBillsExpanded(true)} className="text-xs text-[#3b7dd8] hover:underline flex items-center gap-1">
              View all <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
          <div className="p-4 space-y-2">
            {duplicateBills.map(({ keep, duplicate }) => (
              <div key={duplicate.id} className="px-3 py-2.5 rounded-[8px] bg-[#f59e0b]/10 border border-[#f59e0b]/30">
                <p className="text-sm font-medium">Found two bills that look the same</p>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">
                  “{duplicate.name}” ({formatCurrency(duplicate.amount, currency)}) looks like “{keep.name}”,
                  which you renamed from the same payment. Delete the duplicate?
                </p>
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => { billsDS.remove(duplicate.id); refreshBills(); }}
                    className="text-xs font-semibold text-white bg-[#ef4444] hover:bg-[#dc2626] px-3 py-1.5 rounded-[6px] transition-colors"
                  >
                    Delete “{duplicate.name}”
                  </button>
                  <button
                    onClick={() => setDismissedDupes(d => [...d, duplicate.id])}
                    className="text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] px-3 py-1.5 rounded-[6px] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors"
                  >
                    Keep both
                  </button>
                </div>
              </div>
            ))}
            {upcomingBills.length === 0 ? (
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2 text-center">No upcoming bills</p>
            ) : (
              upcomingBills.slice(0, 4).map(bill => {
                return (
                  <div key={bill.id} className={`flex items-center justify-between px-3 py-2.5 rounded-[8px] ${billWrapClass(bill)}`}>
                    <div className="flex items-center gap-3">
                      {bill.auto_pay ? (
                        /* Auto-pay: lightning indicator, no manual tick */
                        <div
                          className="w-5 h-5 rounded-full bg-[#22c55e]/20 text-[#22c55e] flex items-center justify-center flex-shrink-0 text-xs"
                          title="Auto-pay"
                        >
                          ⚡
                        </div>
                      ) : (
                        /* Tick circle — marks as paid, moves to recently completed */
                        <button
                          onClick={() => handlePayBill(bill.id)}
                          className="w-5 h-5 rounded-full border-2 border-[#6b6b6b] dark:border-[#a0a0a0] flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/20 transition-colors"
                          title="Mark as paid"
                        />
                      )}
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          {bill.name}
                          {bill.auto_pay && (
                            <span className="text-[10px] font-semibold text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded-full">⚡ Auto-pay</span>
                          )}
                        </p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                          {billStatusText(bill)}
                          {bill.is_recurring && ' · Recurring'}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
                  </div>
                );
              })
            )}
            {upcomingBills.length > 4 && (
              <button onClick={() => setBillsExpanded(true)} className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] text-center w-full hover:underline">
                +{upcomingBills.length - 4} more — view all
              </button>
            )}
          </div>
          <div className="px-5 pb-4">
            <button onClick={() => setAddBillOpen(true)} className="text-sm text-[#3b7dd8] hover:underline">+ Add bill</button>
          </div>
        </Card>
      )}

      {/* Goals Widget */}
      {widgetVisibility.goals && goals.length > 0 && (
        <Card className="mb-4" padding="none">
          <div className="px-5 py-4 flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
            <h2 className="font-semibold">Goals</h2>
            <button onClick={() => setAddGoalOpen(true)} className="text-xs text-[#3b7dd8] hover:underline">+ Add goal</button>
          </div>
          <div className="p-4 space-y-4">
            {goals.slice(0, 3).map(goal => {
              const pct = goal.target_amount > 0
                ? Math.min(100, Math.round((goal.current_amount / goal.target_amount) * 100))
                : 0;
              return (
                <div key={goal.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-medium">{goal.name}</span>
                    <span className="text-sm amount">{formatCurrency(goal.current_amount, currency)} / {formatCurrency(goal.target_amount, currency)}</span>
                  </div>
                  <div className="h-2 bg-[#e5e5e5] dark:bg-[#2a2a2a] rounded-full overflow-hidden">
                    <div className="h-full bg-[#3b7dd8] rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{pct}% complete</span>
                    {goal.target_date && <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatRelativeDate(goal.target_date)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Widget Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {widgetVisibility.bankAccounts && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Bank Accounts</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.bank_balance ?? 0, currency, true)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.investments && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Investments</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.investments ?? 0, currency, true)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{investments.length} holding{investments.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.creditCards && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Credit Card Debt</p>
            <p className={`text-xl font-semibold amount ${(netWorth?.credit_card_debt ?? 0) > 0 ? 'text-[#ef4444]' : ''}`}>
              {formatCurrency(netWorth?.credit_card_debt ?? 0, currency, true)}
            </p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{creditCards.length} card{creditCards.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.super && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Superannuation</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.super ?? 0, currency, true)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{superFunds.length} fund{superFunds.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
      </div>

      {/* Add Goal prompt when none yet */}
      {widgetVisibility.goals && goals.length === 0 && (
        <div className="mt-4">
          <button
            onClick={() => setAddGoalOpen(true)}
            className="w-full py-3 border border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[12px] text-sm text-[#6b6b6b] dark:text-[#a0a0a0] hover:border-[#3b7dd8]/40 hover:text-[#3b7dd8] transition-all"
          >
            + Add your first goal
          </button>
        </div>
      )}

      {/* Customise Modal */}
      <Modal isOpen={customiseOpen} onClose={() => setCustomiseOpen(false)} title="Customise Dashboard" size="sm">
        <div className="space-y-3">
          {Object.entries(widgetVisibility).map(([key, visible]) => {
            const labels: Record<string, string> = {
              bankAccounts: 'Bank Accounts', investments: 'Investments',
              creditCards: 'Credit Cards', super: 'Superannuation',
              income: 'Income Summary', netWorthTrend: 'Net Worth Trend',
              goals: 'Goals', budgeting: 'Budgeting', bills: 'Bills',
            };
            return (
              <div key={key} className="flex items-center justify-between py-1">
                <span className="text-sm">{labels[key] ?? key}</span>
                <Toggle checked={visible} onChange={v => setWidgetVisibility(key, v)} />
              </div>
            );
          })}
        </div>
      </Modal>

      {/* Bills Expanded */}
      <Modal isOpen={billsExpanded} onClose={() => setBillsExpanded(false)} title="Bills & Reminders" size="lg">
        {/* ── Active bills ── */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Upcoming</h3>
        <div className="space-y-2 mb-6">
          {upcomingBills.length === 0 && (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] text-center py-6">No upcoming bills 🎉</p>
          )}
          {upcomingBills.map(bill => {
            return (
              <div key={bill.id} className={`flex items-center justify-between p-3 rounded-[8px] ${billWrapClass(bill)}`}>
                <div className="flex items-center gap-3">
                  {bill.auto_pay ? (
                    <div
                      className="w-5 h-5 rounded-full bg-[#22c55e]/20 text-[#22c55e] flex items-center justify-center flex-shrink-0 text-xs"
                      title="Auto-pay"
                    >
                      ⚡
                    </div>
                  ) : (
                    <button
                      onClick={() => handlePayBill(bill.id)}
                      className="w-5 h-5 rounded-full border-2 border-[#6b6b6b] dark:border-[#a0a0a0] flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/20 transition-colors"
                      title="Mark as paid"
                    />
                  )}
                  <div>
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      {bill.name}
                      {bill.auto_pay && (
                        <span className="text-[10px] font-semibold text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded-full">⚡ Auto-pay</span>
                      )}
                    </p>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      {billStatusText(bill)}
                      {bill.is_recurring && ` · ${bill.frequency}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
                  <button
                    onClick={() => { billsDS.remove(bill.id); refreshBills(); }}
                    className="text-xs text-[#9b9b9b] hover:text-[#ef4444] transition-colors"
                    title="Delete bill"
                  >✕</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Recently completed ── */}
        {recentlyPaidBills.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">
              Recently completed
              <span className="ml-1.5 font-normal normal-case">(kept for 7 days — click to restore)</span>
            </h3>
            <div className="space-y-2 mb-5">
              {recentlyPaidBills.map(bill => (
                <div key={bill.id} className="flex items-center justify-between p-3 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] opacity-60">
                  <div className="flex items-center gap-3">
                    {/* Filled green circle — paid */}
                    <button
                      onClick={() => handleRestoreBill(bill.id)}
                      className="w-5 h-5 rounded-full bg-[#22c55e] flex-shrink-0 flex items-center justify-center hover:opacity-70 transition-opacity"
                      title="Restore (mark as unpaid)"
                    >
                      <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                    <div>
                      <p className="text-sm font-medium line-through text-[#6b6b6b] dark:text-[#a0a0a0]">{bill.name}</p>
                      <p className="text-xs text-[#9b9b9b] dark:text-[#666]">
                        Paid {bill.paid_at ? formatDate(bill.paid_at) : 'recently'} · {formatCurrency(bill.amount, currency)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestoreBill(bill.id)}
                    className="text-xs text-[#3b7dd8] hover:underline flex-shrink-0"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <Button variant="secondary" onClick={() => { setBillsExpanded(false); setAddBillOpen(true); }} fullWidth>+ Add Bill</Button>
      </Modal>

      {/* Add Bill */}
      <AddBillModal
        isOpen={addBillOpen}
        onClose={() => setAddBillOpen(false)}
        onSave={(data) => {
          billsDS.add(data as Parameters<typeof billsDS.add>[0]);
          setBills(billsDS.getAll());
          setAddBillOpen(false);
        }}
      />

      {/* Add Goal */}
      <AddGoalModal
        isOpen={addGoalOpen}
        onClose={() => setAddGoalOpen(false)}
        onSave={(data) => {
          goalsDS.add(data as Parameters<typeof goalsDS.add>[0]);
          setGoals(goalsDS.getAll());
          setAddGoalOpen(false);
        }}
      />
    </Layout>
  );
}

// ─── Add Bill Modal ──────────────────────────────────────────────────────────

function AddBillModal({ isOpen, onClose, onSave }: {
  isOpen: boolean; onClose: () => void; onSave: (d: object) => void;
}) {
  const [form, setForm] = useState({
    name: '', amount: '', due_date: '', is_recurring: false,
    frequency: 'monthly', colour: 'grey' as 'grey' | 'yellow' | 'red',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.amount || !form.due_date) return;
    onSave({ ...form, amount: parseFloat(form.amount), is_paid: false, calendar_synced: false });
    setForm({ name: '', amount: '', due_date: '', is_recurring: false, frequency: 'monthly', colour: 'grey' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Bill" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Bill name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Electricity" required />
        <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <Input label="Due date" type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} required />
        <Toggle label="Recurring bill" checked={form.is_recurring} onChange={v => setForm(f => ({ ...f, is_recurring: v }))} />
        {form.is_recurring && (
          <Select label="Frequency" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
            options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]}
          />
        )}
        <Select label="Colour" value={form.colour} onChange={e => setForm(f => ({ ...f, colour: e.target.value as 'grey' | 'yellow' | 'red' }))}
          options={[{ value: 'grey', label: 'Grey (default)' }, { value: 'yellow', label: 'Yellow (moderate)' }, { value: 'red', label: 'Red (urgent)' }]}
        />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Bill</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Goal Modal ──────────────────────────────────────────────────────────

function AddGoalModal({ isOpen, onClose, onSave }: {
  isOpen: boolean; onClose: () => void; onSave: (d: object) => void;
}) {
  const [form, setForm] = useState({ name: '', target_amount: '', current_amount: '0', target_date: '' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.target_amount) return;
    onSave({ ...form, target_amount: parseFloat(form.target_amount), current_amount: parseFloat(form.current_amount || '0') });
    setForm({ name: '', target_amount: '', current_amount: '0', target_date: '' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Goal" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Goal name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. House Deposit" required />
        <Input label="Target amount" type="number" step="0.01" prefix="$" value={form.target_amount} onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} required />
        <Input label="Current amount" type="number" step="0.01" prefix="$" value={form.current_amount} onChange={e => setForm(f => ({ ...f, current_amount: e.target.value }))} />
        <Input label="Target date (optional)" type="date" value={form.target_date} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Goal</Button>
        </div>
      </form>
    </Modal>
  );
}
