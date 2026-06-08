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
import { BILL_CATEGORIES } from '../types';
import type { Bill } from '../types';
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
    subscriptions,
  } = useStore();

  const [searchParams] = useSearchParams();
  const [customiseOpen, setCustomiseOpen] = useState(false);
  const [billsExpanded, setBillsExpanded] = useState(false);
  const [addBillOpen, setAddBillOpen] = useState(false);
  const [addGoalOpen, setAddGoalOpen] = useState(false);
  // Add/edit modal default kind, the bill being edited (null = adding new), the
  // categories settings popup, and the "apply to all future occurrences?" prompt.
  const [billModalKind, setBillModalKind] = useState<'bill' | 'reminder'>('bill');
  const [editBill, setEditBill] = useState<Bill | null>(null);
  const [billSettingsOpen, setBillSettingsOpen] = useState(false);
  const [recurringConfirm, setRecurringConfirm] = useState<{ id: string; data: Partial<Bill> } | null>(null);
  // How many items show on the overview before the rest collapse into a stacker,
  // and the base lead time (days before due) at which an item starts appearing.
  const [billsShowCount, setBillsShowCount] = useState<number>(() => Number(localStorage.getItem('billsShowCount')) || 5);
  const [billsLeadDays, setBillsLeadDays] = useState<number>(() => {
    const v = localStorage.getItem('billsLeadDays');
    return v === null ? 7 : Number(v);
  });
  const changeBillsShowCount = (n: number) => { localStorage.setItem('billsShowCount', String(n)); setBillsShowCount(n); };
  const changeBillsLeadDays = (n: number) => { localStorage.setItem('billsLeadDays', String(n)); setBillsLeadDays(n); };

  const currency = user?.currency_preference ?? 'AUD';

  // Net-worth % change trend. Forward-only snapshots (hourly cron + on page
  // load); % is measured from the user's first-ever snapshot, the toggle zooms.
  type NwPoint = { recorded_at: string; pct: number; value: number };
  const [nwTimeframe, setNwTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>('weekly');
  const [nwHistory, setNwHistory] = useState<NwPoint[]>([]);
  const [nwBaseline, setNwBaseline] = useState(0);
  // Dedicated last-24h series (independent of the selected chart timeframe) so the
  // "last day" % under the headline is always the true day change.
  const [nwDayHistory, setNwDayHistory] = useState<NwPoint[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);

  // Breakdown popup: timeframe + per-item change data + "how many to show" pref.
  type ItemChange = {
    item_type: string; item_id: string; name: string; is_debt: boolean;
    start_value: number; current_value: number; change: number; contribution: number;
  };
  const [bdTimeframe, setBdTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'sixmonth' | 'yearly' | 'all'>('daily');
  const [bdItems, setBdItems] = useState<ItemChange[]>([]);
  const [bdLoading, setBdLoading] = useState(false);
  const [topN, setTopN] = useState<number>(() => Number(localStorage.getItem('nwTopN')) || 5);

  useEffect(() => {
    overviewApi.getNetWorthPctHistory(nwTimeframe)
      .then(r => { setNwHistory(r.points ?? []); setNwBaseline(r.baseline ?? 0); })
      .catch(() => { setNwHistory([]); setNwBaseline(0); });
  }, [nwTimeframe]);

  useEffect(() => {
    overviewApi.getNetWorthPctHistory('daily')
      .then(r => setNwDayHistory(r.points ?? []))
      .catch(() => setNwDayHistory([]));
  }, []);

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

  // Last-day % change: current net worth vs its value ~24h ago (first daily point).
  const dayStartValue = nwDayHistory[0]?.value ?? 0;
  const nwDayChange = dayStartValue !== 0 && liveNw
    ? parseFloat((((liveNw - dayStartValue) / dayStartValue) * 100).toFixed(2))
    : null;
  const nwColor = nwUp ? '#22c55e' : '#ef4444';

  // ── Net-worth breakdown popup: per-item CHANGE over a chosen timeframe ──
  // Backend diffs each contributing item (bank/investment/super/SMSF/card) across
  // the window and returns them sorted by biggest contribution to the change.
  const SUB_LABELS: Record<string, string> = {
    bank: 'Bank account', investment: 'Investment', super: 'Superannuation', smsf: 'SMSF', credit_card: 'Credit card',
  };
  const BD_TF_LABELS: { key: typeof bdTimeframe; label: string }[] = [
    { key: 'daily', label: '1 day' }, { key: 'weekly', label: '7 days' },
    { key: 'monthly', label: '1 month' }, { key: 'sixmonth', label: '6 months' },
    { key: 'yearly', label: '1 year' }, { key: 'all', label: 'All time' },
  ];
  const TF_PHRASE: Record<string, string> = {
    daily: 'in the last 24 hours', weekly: 'in the last 7 days', monthly: 'in the last month',
    sixmonth: 'in the last 6 months', yearly: 'in the last year', all: 'since you started tracking',
  };

  useEffect(() => {
    if (!detailOpen) return;
    setBdLoading(true);
    overviewApi.getNetWorthItemChanges(bdTimeframe)
      .then(r => setBdItems(r.items ?? []))
      .catch(() => setBdItems([]))
      .finally(() => setBdLoading(false));
  }, [detailOpen, bdTimeframe]);

  const changeTopN = (n: number) => { setTopN(n); localStorage.setItem('nwTopN', String(n)); };
  // Movers = items that actually changed in the window, biggest contribution first.
  const bdMovers = bdItems.filter(it => Math.abs(it.contribution) >= 0.005);
  const bdTopMovers = bdMovers.slice(0, topN);
  const bdMaxAbs = Math.abs(bdMovers[0]?.contribution ?? 0) || 1;

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
    if (searchParams.get('add') === 'bill') { setEditBill(null); setBillModalKind('bill'); setAddBillOpen(true); }
    if (searchParams.get('add') === 'reminder') { setEditBill(null); setBillModalKind('reminder'); setAddBillOpen(true); }
    if (searchParams.get('add') === 'goal') setAddGoalOpen(true);
  }, [searchParams]);

  const [dismissedDupes, setDismissedDupes] = useState<string[]>([]);

  const allUpcoming = billsDS.getAll();
  // Older rows have no `kind` → treated as bills. Reminders are explicit.
  const upcomingBills = allUpcoming.filter(b => (b.kind ?? 'bill') === 'bill');
  const upcomingReminders = allUpcoming.filter(b => b.kind === 'reminder');
  const recentlyPaidBills = billsDS.getRecentlyPaid();
  const urgentBills = allUpcoming.filter(b => daysUntil(b.due_date) <= 7);

  // Lead time: an item appears on the overview once it's within its lead window
  // (its own lead_days override, else the base setting). The expanded "View all"
  // modal always shows everything regardless of lead time.
  const withinLead = (b: Bill) => daysUntil(b.due_date) <= (b.lead_days ?? billsLeadDays);
  const widgetBills = upcomingBills.filter(withinLead);
  const widgetReminders = upcomingReminders.filter(withinLead);

  /** A linked bank subscription's category, used to prefill a recurring item's. */
  const subscriptionCategoryFor = (bill: Bill): string | undefined => {
    const sub = bill.subscription_id
      ? subscriptions.find(s => s.id === bill.subscription_id)
      : subscriptions.find(s => s.name.toLowerCase().trim() === bill.name.toLowerCase().trim());
    return sub?.category;
  };

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

  // Open the modal to add a fresh bill or reminder.
  const openAdd = (kind: 'bill' | 'reminder') => {
    setEditBill(null);
    setBillModalKind(kind);
    setAddBillOpen(true);
  };

  // Open the modal pre-filled to edit an existing item.
  const openEdit = (bill: Bill) => {
    setEditBill(bill);
    setBillModalKind(bill.kind ?? 'bill');
    setAddBillOpen(true);
  };

  // Save handler from the add/edit modal. Recurring EDITS ask whether to apply to
  // all future occurrences before persisting; everything else saves immediately.
  const handleSaveBill = (data: Partial<Bill>, id?: string) => {
    if (id) {
      const existing = allUpcoming.find(b => b.id === id);
      if (existing?.is_recurring) {
        setRecurringConfirm({ id, data });
        setAddBillOpen(false);
        setEditBill(null);
        return;
      }
      billsDS.updateScoped(id, data, true);
    } else {
      billsDS.add(data as Parameters<typeof billsDS.add>[0]);
    }
    refreshBills();
    setAddBillOpen(false);
    setEditBill(null);
  };

  // Resolve the "apply to all future occurrences?" prompt.
  const applyRecurringEdit = (applyToFuture: boolean) => {
    if (!recurringConfirm) return;
    billsDS.updateScoped(recurringConfirm.id, recurringConfirm.data, applyToFuture);
    refreshBills();
    setRecurringConfirm(null);
  };

  // Inline category change from the settings popup.
  const setItemCategory = (bill: Bill, category: string) => {
    billsDS.updateScoped(bill.id, { category }, true);
    refreshBills();
  };

  // Per-item lead time override. Empty input → null → falls back to the base.
  const setItemLead = (bill: Bill, days: number | null) => {
    billsDS.updateScoped(bill.id, { lead_days: days }, true);
    refreshBills();
  };

  // Overflow "stacker": narrowing peek bars so you can see more items exist
  // without reading them. Tapping opens the full list.
  const renderStacker = (overflow: Bill[]) => {
    if (overflow.length === 0) return null;
    const peek = Math.min(3, overflow.length);
    return (
      <button onClick={() => setBillsExpanded(true)} className="relative w-full block pt-1 group" title="View all">
        <div className="space-y-1">
          {Array.from({ length: peek }).map((_, i) => (
            <div
              key={i}
              className="h-2 rounded-full bg-[#e5e5e5] dark:bg-[#2a2a2a]"
              style={{ width: `${94 - i * 8}%`, margin: '0 auto', opacity: 1 - i * 0.25 }}
            />
          ))}
        </div>
        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] text-center mt-1.5 group-hover:text-[#3b7dd8] transition-colors">
          +{overflow.length} more
        </p>
      </button>
    );
  };

  // Shared active-item row for the expanded modal (bills + reminders).
  const renderActiveRow = (bill: Bill) => (
    <div key={bill.id} className={`flex items-center justify-between p-3 rounded-[8px] ${billWrapClass(bill)}`}>
      <div className="flex items-center gap-3">
        {bill.auto_pay ? (
          <div className="w-5 h-5 rounded-full bg-[#22c55e]/20 text-[#22c55e] flex items-center justify-center flex-shrink-0 text-xs" title="Auto-pay">⚡</div>
        ) : (
          <button
            onClick={() => handlePayBill(bill.id)}
            className="w-5 h-5 rounded-full border-2 border-[#6b6b6b] dark:border-[#a0a0a0] flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/20 transition-colors"
            title="Mark as done"
          />
        )}
        <div>
          <p className="text-sm font-medium flex items-center gap-1.5">
            {bill.kind === 'reminder' && '🔔 '}{bill.name}
            {bill.auto_pay && <span className="text-[10px] font-semibold text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded-full">⚡ Auto-pay</span>}
          </p>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            {billStatusText(bill)}
            {bill.is_recurring && ` · ${bill.frequency}`}
            {bill.category && ` · ${bill.category}`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {(bill.kind !== 'reminder' || bill.amount > 0) && (
          <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
        )}
        <button onClick={() => openEdit(bill)} className="text-[#9b9b9b] hover:text-[#3b7dd8] transition-colors" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button
          onClick={() => { billsDS.remove(bill.id); refreshBills(); }}
          className="text-xs text-[#9b9b9b] hover:text-[#ef4444] transition-colors"
          title="Delete"
        >✕</button>
      </div>
    </div>
  );

  return (
    <Layout onCustomise={() => setCustomiseOpen(true)}>
      {/* Net Worth Hero */}
      <div className="mb-6">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Total net worth</p>
        <button
          onClick={() => setDetailOpen(true)}
          className="group flex items-center gap-2 text-left"
          title="See what makes up your net worth"
        >
          <h1 className="text-4xl sm:text-5xl font-semibold amount tracking-tight mt-1 group-hover:opacity-80 transition-opacity">
            {formatCurrency(netWorth?.net_worth ?? 0, currency)}
          </h1>
          <svg className="w-5 h-5 mt-1 text-[#9ca3af] group-hover:text-[#6b6b6b] dark:group-hover:text-[#d0d0d0] transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">
          {currency} · Updated just now
        </p>
        {nwDayChange !== null && (
          <p className="text-sm mt-0.5">
            <span className={`font-medium ${colorForChange(nwDayChange)}`}>
              {formatPercent(nwDayChange)} today
            </span>
          </p>
        )}
        {nwPoints.length > 0 && (
          <p className="text-sm mt-0.5">
            <span className={`font-medium ${colorForChange(nwCurrentPct)}`}>
              {formatPercent(nwCurrentPct)} since you started tracking
            </span>
          </p>
        )}

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
            {widgetBills.length === 0 ? (
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2 text-center">No upcoming bills</p>
            ) : (
              widgetBills.slice(0, billsShowCount).map(bill => {
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
                          {bill.category && ` · ${bill.category}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
                      <button onClick={() => openEdit(bill)} className="text-[#9b9b9b] hover:text-[#3b7dd8] transition-colors" title="Edit">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
            {renderStacker(widgetBills.slice(billsShowCount))}

            {/* Reminders — date nudges (amount optional), shown separately. */}
            {widgetReminders.length > 0 && (
              <>
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] pt-2">Reminders</h3>
                {widgetReminders.slice(0, billsShowCount).map(rem => (
                  <div key={rem.id} className="flex items-center justify-between px-3 py-2.5 rounded-[8px] bg-[#3b7dd8]/5 border border-[#3b7dd8]/20">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handlePayBill(rem.id)}
                        className="w-5 h-5 rounded-full border-2 border-[#3b7dd8]/50 flex-shrink-0 hover:bg-[#3b7dd8]/20 transition-colors"
                        title="Mark as done"
                      />
                      <div>
                        <p className="text-sm font-medium">🔔 {rem.name}</p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                          {billStatusText(rem)}
                          {rem.is_recurring && ' · Recurring'}
                          {rem.category && ` · ${rem.category}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {rem.amount > 0 && <span className="text-sm font-semibold amount">{formatCurrency(rem.amount, currency)}</span>}
                      <button onClick={() => openEdit(rem)} className="text-[#9b9b9b] hover:text-[#3b7dd8] transition-colors" title="Edit">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                    </div>
                  </div>
                ))}
                {renderStacker(widgetReminders.slice(billsShowCount))}
              </>
            )}
          </div>
          <div className="px-5 pb-4 flex gap-4">
            <button onClick={() => openAdd('bill')} className="text-sm text-[#3b7dd8] hover:underline">+ Add bill</button>
            <button onClick={() => openAdd('reminder')} className="text-sm text-[#3b7dd8] hover:underline">+ Add reminder</button>
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
        <div className="flex justify-end mb-3">
          <button
            onClick={() => setBillSettingsOpen(true)}
            className="text-xs text-[#3b7dd8] hover:underline flex items-center gap-1"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Settings
          </button>
        </div>

        {/* ── Bills ── */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Bills</h3>
        <div className="space-y-2 mb-6">
          {upcomingBills.length === 0 && (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] text-center py-6">No upcoming bills 🎉</p>
          )}
          {upcomingBills.map(renderActiveRow)}
        </div>

        {/* ── Reminders ── */}
        {upcomingReminders.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Reminders</h3>
            <div className="space-y-2 mb-6">
              {upcomingReminders.map(renderActiveRow)}
            </div>
          </>
        )}

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

        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => { setBillsExpanded(false); openAdd('bill'); }} fullWidth>+ Add Bill</Button>
          <Button variant="secondary" onClick={() => { setBillsExpanded(false); openAdd('reminder'); }} fullWidth>+ Add Reminder</Button>
        </div>
      </Modal>

      {/* Add / Edit Bill or Reminder */}
      <BillModal
        isOpen={addBillOpen}
        defaultKind={billModalKind}
        editing={editBill}
        categoryPrefill={editBill ? subscriptionCategoryFor(editBill) : undefined}
        onClose={() => { setAddBillOpen(false); setEditBill(null); }}
        onSave={handleSaveBill}
      />

      {/* Recurring edit: apply to all future occurrences? */}
      <Modal isOpen={!!recurringConfirm} onClose={() => setRecurringConfirm(null)} title="Update recurring payment" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-5">
          This is a recurring payment. Do you want to apply these changes to all future occurrences, or just this one?
        </p>
        <div className="space-y-2">
          <Button variant="primary" fullWidth onClick={() => applyRecurringEdit(true)}>Change all future payments</Button>
          <Button variant="secondary" fullWidth onClick={() => applyRecurringEdit(false)}>Just this one</Button>
        </div>
      </Modal>

      {/* Categorise recurring payments */}
      <Modal isOpen={billSettingsOpen} onClose={() => setBillSettingsOpen(false)} title="Bills & Reminders settings" size="md">
        {/* ── Display ── */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Display</h3>
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Show on overview</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Extra items collapse into a stack you can tap to expand.</p>
            </div>
            <input
              type="number" min={1} max={20} value={billsShowCount}
              onChange={e => changeBillsShowCount(Math.max(1, Number(e.target.value) || 1))}
              className="w-20 text-sm rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-2 py-1.5 flex-shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Show items this many days before due</p>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Base lead time. Override individual items below.</p>
            </div>
            <input
              type="number" min={0} max={365} value={billsLeadDays}
              onChange={e => changeBillsLeadDays(Math.max(0, Number(e.target.value) || 0))}
              className="w-20 text-sm rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-2 py-1.5 flex-shrink-0"
            />
          </div>
        </div>

        {/* ── Per-item: category + lead time ── */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Each bill &amp; reminder</h3>
        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-3">
          Set a category and, optionally, how many days before due it appears. Leave days blank to use the base ({billsLeadDays}d). Items linked to a bank subscription start with that category.
        </p>
        {allUpcoming.length === 0 ? (
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] text-center py-6">No bills or reminders yet.</p>
        ) : (
          <div className="space-y-2">
            {allUpcoming.map(item => {
              const linked = subscriptionCategoryFor(item);
              const value = item.category ?? linked ?? '';
              return (
                <div key={item.id} className="flex items-center justify-between gap-2 p-2.5 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a]">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{item.kind === 'reminder' ? '🔔 ' : ''}{item.name}</p>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      {item.amount > 0 ? formatCurrency(item.amount, currency) : 'No amount'}
                      {item.is_recurring && ` · ${item.frequency}`}
                      {!item.category && linked && ' · from bank'}
                    </p>
                  </div>
                  <input
                    type="number" min={0} max={365}
                    value={item.lead_days ?? ''}
                    placeholder={`${billsLeadDays}d`}
                    onChange={e => setItemLead(item, e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0))}
                    title="Days before due to show (blank = base)"
                    className="w-16 text-sm rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-2 py-1.5 flex-shrink-0"
                  />
                  <select
                    value={value}
                    onChange={e => setItemCategory(item, e.target.value)}
                    className="text-sm rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-2 py-1.5 flex-shrink-0 max-w-[8rem]"
                  >
                    <option value="">Uncategorised</option>
                    {BILL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

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

      {/* Net worth breakdown — what changed it the most over a chosen timeframe */}
      <Modal isOpen={detailOpen} onClose={() => setDetailOpen(false)} title="What's driving your net worth" size="md">
        <div className="space-y-4">
          {/* Timeframe toggle */}
          <div className="flex gap-1 bg-[#f3f4f6] dark:bg-[#1a1a1a] rounded-lg p-1 overflow-x-auto">
            {BD_TF_LABELS.map(tf => (
              <button
                key={tf.key}
                onClick={() => setBdTimeframe(tf.key)}
                className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors ${
                  bdTimeframe === tf.key
                    ? 'bg-white dark:bg-[#2a2a2a] text-[#0f0f0f] dark:text-white shadow-sm font-medium'
                    : 'text-[#6b6b6b] dark:text-[#a0a0a0]'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            Biggest movers {TF_PHRASE[bdTimeframe]} — what added to or subtracted from your net worth.
          </p>

          {bdLoading ? (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-6 text-center">Loading…</p>
          ) : bdMovers.length === 0 ? (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-6 text-center">
              No tracked changes yet {TF_PHRASE[bdTimeframe]}. Changes are recorded from when each item starts being tracked, so this fills in over time.
            </p>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto -mx-1 px-1 space-y-2.5">
              {bdTopMovers.map(it => {
                const up = it.contribution >= 0;
                const share = Math.round((Math.abs(it.contribution) / bdMaxAbs) * 100);
                return (
                  <div key={`${it.item_type}:${it.item_id}`} className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{it.name}</p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{SUB_LABELS[it.item_type] ?? it.item_type}</p>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <p className={`text-sm font-semibold amount ${up ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                          {up ? '+' : '−'}{formatCurrency(Math.abs(it.contribution), currency, true)}
                        </p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">now {formatCurrency(it.current_value, currency, true)}</p>
                      </div>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-[#f0f0f0] dark:bg-[#2a2a2a] overflow-hidden">
                      <div className={`h-full rounded-full ${up ? 'bg-[#22c55e]' : 'bg-[#ef4444]'}`} style={{ width: `${share}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* "How many to show" setting */}
          <div className="flex items-center justify-between pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
            <label className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Show top</label>
            <div className="flex gap-1">
              {[3, 5, 10, 9999].map(n => (
                <button
                  key={n}
                  onClick={() => changeTopN(n)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    topN === n
                      ? 'bg-[#0f0f0f] dark:bg-white text-white dark:text-[#0f0f0f] font-medium'
                      : 'bg-[#f3f4f6] dark:bg-[#1a1a1a] text-[#6b6b6b] dark:text-[#a0a0a0]'
                  }`}
                >
                  {n === 9999 ? 'All' : n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}

// ─── Add / Edit Bill or Reminder Modal ───────────────────────────────────────

function BillModal({ isOpen, onClose, onSave, defaultKind, editing, categoryPrefill }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (d: Partial<Bill>, id?: string) => void;
  defaultKind: 'bill' | 'reminder';
  editing: Bill | null;
  categoryPrefill?: string;
}) {
  const blank = {
    kind: defaultKind, name: '', amount: '', due_date: '', is_recurring: false,
    frequency: 'monthly', colour: 'grey' as 'grey' | 'yellow' | 'red', category: '',
  };
  const [form, setForm] = useState(blank);

  // Re-seed the form whenever the modal opens (for an edit, or a fresh add).
  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setForm({
        kind: editing.kind ?? 'bill',
        name: editing.name,
        amount: editing.amount ? String(editing.amount) : '',
        due_date: editing.due_date ?? '',
        is_recurring: editing.is_recurring,
        frequency: editing.frequency ?? 'monthly',
        colour: editing.colour ?? 'grey',
        category: editing.category ?? categoryPrefill ?? '',
      });
    } else {
      setForm({ ...blank, kind: defaultKind });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editing, defaultKind, categoryPrefill]);

  const isReminder = form.kind === 'reminder';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Reminders allow a blank amount; bills require one.
    if (!form.name || !form.due_date) return;
    if (!isReminder && !form.amount) return;

    const payload: Partial<Bill> = {
      kind: form.kind,
      name: form.name,
      amount: form.amount ? parseFloat(form.amount) : 0,
      due_date: form.due_date,
      is_recurring: form.is_recurring,
      frequency: form.is_recurring ? form.frequency : undefined,
      colour: form.colour,
      category: form.category || null,
    };
    if (editing) {
      onSave(payload, editing.id);
    } else {
      onSave({ ...payload, is_paid: false, calendar_synced: false });
    }
    setForm({ ...blank, kind: defaultKind });
  };

  const title = `${editing ? 'Edit' : 'Add'} ${isReminder ? 'Reminder' : 'Bill'}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Bill vs Reminder toggle */}
        <div className="flex gap-1 bg-[#f3f4f6] dark:bg-[#1a1a1a] rounded-lg p-1">
          {(['bill', 'reminder'] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setForm(f => ({ ...f, kind: k }))}
              className={`flex-1 px-3 py-1.5 text-sm rounded-md capitalize transition-colors ${
                form.kind === k
                  ? 'bg-white dark:bg-[#2a2a2a] text-[#0f0f0f] dark:text-white shadow-sm font-medium'
                  : 'text-[#6b6b6b] dark:text-[#a0a0a0]'
              }`}
            >
              {k}
            </button>
          ))}
        </div>

        <Input label={isReminder ? 'Reminder' : 'Bill name'} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={isReminder ? 'e.g. Rent review' : 'e.g. Electricity'} required />
        <Input label={isReminder ? 'Amount (optional)' : 'Amount'} type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required={!isReminder} />
        <Input label="Due date" type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} required />
        <Toggle label={isReminder ? 'Recurring reminder' : 'Recurring bill'} checked={form.is_recurring} onChange={v => setForm(f => ({ ...f, is_recurring: v }))} />
        {form.is_recurring && (
          <Select label="Frequency" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
            options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]}
          />
        )}
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          options={[{ value: '', label: 'Uncategorised' }, ...BILL_CATEGORIES.map(c => ({ value: c, label: c }))]}
        />
        <Select label="Colour" value={form.colour} onChange={e => setForm(f => ({ ...f, colour: e.target.value as 'grey' | 'yellow' | 'red' }))}
          options={[{ value: 'grey', label: 'Grey (default)' }, { value: 'yellow', label: 'Yellow (moderate)' }, { value: 'red', label: 'Red (urgent)' }]}
        />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save' : title}</Button>
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
