import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import {
  calculateNetWorth, billsDS, goalsDS, billReconciliationDS, subscriptionsDS,
  accountsDS, creditCardsDS, loansDS, propertiesDS, currentScope,
} from '../services/dataService';
import { formatCurrency, formatRelativeDate, formatDate, daysUntil, formatPercent, colorForChange } from '../utils/format';
import { buildNetWorthChartData } from '../utils/chartData';
import { trendScales, tooltipStyle } from '../utils/chartTheme';
import { buildNetWorthSeries } from '../utils/netWorthSeries';
import { overviewApi, settingsApi } from '../services/api';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import { Greeting, Button as KitButton } from '../components/design-kit/UI';
import Input, { Select, Toggle } from '../components/common/Input';
import BudgetSection from '../components/overview/BudgetSection';
import GoalSection from '../components/overview/GoalSection';
import SharedBadge from '../components/common/SharedBadge';
import SharePanel from '../components/common/SharePanel';
import { householdsOf, activeMembers } from '../utils/household';
import AttentionCard from '../components/overview/AttentionCard';
import ReviewSection from '../components/overview/ReviewSection';
import { BILL_CATEGORIES } from '../types';
import type { Bill, Goal, BankAccount, CreditCard } from '../types';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

/** Every dashboard widget that can be shown or hidden, in the order listed. */
const WIDGET_LABELS = [
  ['alerts', 'Right now — needs you'],
  ['insights', 'Right now — what changed'],
  ['review', 'Week / month in review'],
  ['bills', 'Bills'],
  ['budgeting', 'Budgeting'],
  ['goals', 'Goals'],
  ['bankAccounts', 'Bank Accounts'],
  ['investments', 'Investments'],
  ['creditCards', 'Credit Cards'],
  ['super', 'Superannuation'],
  ['income', 'Income Summary'],
  ['netWorthTrend', 'Net Worth Trend'],
] as const;

export default function Overview() {
  const {
    user, setNetWorth, netWorth, netWorthHistory,
    setBills, goals,
    widgetVisibility, setWidgetVisibility,
    investments, superFunds,
    subscriptions, setSubscriptions, setQuickAddOpen,
    // The RAW rows the user may see (all households + direct shares). Subscribed
    // to for reactivity + as the memo keys below — never rendered directly, or
    // one household's accounts would bleed into another's.
    accounts: rawAccounts, creditCards: rawCreditCards,
    loans: rawLoans, properties: rawProperties,
    financeScope, activeHouseholdId, householdMembers,
  } = useStore();

  // Phase 7.2 — the member responsible for a shared bill, for the row's meta
  // line. Null for an unassigned (or personal) bill, so nothing extra renders.
  const billResponsibleName = (bill: Bill): string | null => {
    if (!bill.responsible_user_id) return null;
    if (bill.responsible_user_id === user?.id) return 'you';
    const m = householdMembers.find(x => x.user_id === bill.responsible_user_id);
    return m?.name || m?.email || 'a member';
  };

  // The whole dashboard follows the selected scope (My Finances or a household),
  // exactly like every other page. Narrowing to the active scope is a read-time
  // job done here via the scoped DS; useMemo keeps the identities stable so the
  // net-worth effect below doesn't re-fire on every render.
  const accounts = useMemo(
    () => accountsDS.getAll(),
    [rawAccounts, financeScope, activeHouseholdId],
  );
  const creditCards = useMemo(
    () => creditCardsDS.getAll(),
    [rawCreditCards, financeScope, activeHouseholdId],
  );
  const loans = useMemo(
    () => loansDS.getAll(),
    [rawLoans, financeScope, activeHouseholdId],
  );
  const properties = useMemo(
    () => propertiesDS.getAll(),
    [rawProperties, financeScope, activeHouseholdId],
  );

  // Which of the two pictures this page is showing. Read from the same single
  // definition the totals use, rather than from `financeScope` directly, so a
  // stale "household" preference belonging to a household the user has since
  // left can't put the page in a state its own numbers disagree with.
  const inHousehold = useMemo(
    () => currentScope() === 'household',
    [financeScope, activeHouseholdId],
  );

  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [customiseOpen, setCustomiseOpen] = useState(false);
  const [billsExpanded, setBillsExpanded] = useState(false);
  const [addBillOpen, setAddBillOpen] = useState(false);
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
  // Persist the two display prefs to the user's account (ui_preferences) so they
  // sync across devices — localStorage is just a fast local cache. No save button:
  // each change autosaves. We send the full prefs object to avoid clobbering.
  // Full ui_preferences blob, so we merge our two keys in without clobbering
  // other prefs stored in the same object (e.g. hidden_categories from Settings).
  const uiPrefsRef = useRef<Record<string, unknown>>({});
  const saveBillPrefs = (next: { billsShowCount?: number; billsLeadDays?: number }) => {
    const merged = {
      ...uiPrefsRef.current,
      billsShowCount: next.billsShowCount ?? billsShowCount,
      billsLeadDays: next.billsLeadDays ?? billsLeadDays,
    };
    uiPrefsRef.current = merged;
    settingsApi.updateProfile({ ui_preferences: merged }).catch(() => {});
  };
  const changeBillsShowCount = (n: number) => { localStorage.setItem('billsShowCount', String(n)); setBillsShowCount(n); saveBillPrefs({ billsShowCount: n }); };
  const changeBillsLeadDays = (n: number) => { localStorage.setItem('billsLeadDays', String(n)); setBillsLeadDays(n); saveBillPrefs({ billsLeadDays: n }); };

  // On mount, pull the account-level prefs so a setting saved on another device
  // shows up here. Server value wins over the local cache when present.
  useEffect(() => {
    settingsApi.getProfile().then((p: { ui_preferences?: { billsShowCount?: number; billsLeadDays?: number } & Record<string, unknown> }) => {
      const prefs = p?.ui_preferences;
      if (!prefs) return;
      uiPrefsRef.current = prefs;  // keep the full blob for non-clobbering merges
      if (typeof prefs.billsShowCount === 'number') {
        localStorage.setItem('billsShowCount', String(prefs.billsShowCount));
        setBillsShowCount(prefs.billsShowCount);
      }
      if (typeof prefs.billsLeadDays === 'number') {
        localStorage.setItem('billsLeadDays', String(prefs.billsLeadDays));
        setBillsLeadDays(prefs.billsLeadDays);
      }
    }).catch(() => {});
  }, []);
  // Raw input drafts so the fields can be cleared to empty mid-edit without
  // snapping back to a number. Committed (clamped, defaulted) on blur.
  const [showCountDraft, setShowCountDraft] = useState('');
  const [leadDaysDraft, setLeadDaysDraft] = useState('');

  const currency = user?.currency_preference ?? 'AUD';
  // Which view is on — decides how every chart on this page is DRAWN, never what
  // it plots. See utils/chartTheme.
  const viewMode = useStore(s => s.viewMode);

  // Net-worth % change trend. Forward-only snapshots (hourly cron + on page
  // load); % is measured from the user's first-ever snapshot, the toggle zooms.
  type NwPoint = { recorded_at: string; pct: number; value: number };
  // Structural-adjustment series: each item counts only its movement since it was
  // first tracked, so adding/removing an account never spikes the % or $.
  type NwAdjPoint = { recorded_at: string; value: number; base: number; organic: number; pct: number };
  type NwAdjusted = { points: NwAdjPoint[]; baseline: number; currentBase: number; currentValue?: number; carryValue?: number };
  const [nwTimeframe, setNwTimeframeState] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>(
    () => (localStorage.getItem('nwTimeframe') as 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all') || 'weekly',
  );
  const setNwTimeframe = (tf: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all') => {
    setNwTimeframeState(tf);
    localStorage.setItem('nwTimeframe', tf);
  };
  // Graph mode: '%' = cumulative change (structural add/remove neutralised),
  // '$' = raw net-worth value (spikes when an account is added). Remembered.
  const [nwMode, setNwModeState] = useState<'pct' | 'dollar'>(
    () => (localStorage.getItem('nwMode') as 'pct' | 'dollar') || 'pct',
  );
  const setNwMode = (m: 'pct' | 'dollar') => { setNwModeState(m); localStorage.setItem('nwMode', m); };
  const nwDollar = nwMode === 'dollar';
  const [nwHistory, setNwHistory] = useState<NwPoint[]>([]);
  const [nwBaseline, setNwBaseline] = useState(0);
  const [nwAdjusted, setNwAdjusted] = useState<NwAdjusted | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  // When on (default), newly added/removed accounts don't move the headline change —
  // only real gains/losses do. Persisted locally like the other net-worth prefs.
  const [excludeStructural, setExcludeStructural] = useState<boolean>(
    () => localStorage.getItem('nwExcludeStructural') !== '0',
  );
  const toggleExcludeStructural = (v: boolean) => {
    setExcludeStructural(v);
    localStorage.setItem('nwExcludeStructural', v ? '1' : '0');
  };

  // Breakdown popup: timeframe + per-item change data + "how many to show" pref.
  type ItemChange = {
    item_type: string; item_id: string; name: string; is_debt: boolean;
    start_value: number; current_value: number; change: number; contribution: number;
    /** No longer part of net worth — deleted, hidden, or switched off. */
    removed?: boolean;
  };
  const [bdTimeframe, setBdTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'sixmonth' | 'yearly' | 'all'>('daily');
  const [bdItems, setBdItems] = useState<ItemChange[]>([]);
  const [bdLoading, setBdLoading] = useState(false);
  const [topN, setTopN] = useState<number>(() => Number(localStorage.getItem('nwTopN')) || 5);

  // ── The trend is a PERSONAL series, and only ever a personal one ───────────
  //
  // `net_worth_history` is recorded per USER, from the rows they own — which
  // includes their investments and super, neither of which can be shared with a
  // household at all. Plotted under a household headline it was answering a
  // different question from the number above it: the household's balance with
  // the owner's private portfolio's movement under it, so a personal share price
  // slipping showed up as "−$150 today" on the shared view. There is no
  // household snapshot feed to plot instead, so a household view simply doesn't
  // have a trend, and says so.
  useEffect(() => {
    if (inHousehold) { setNwHistory([]); setNwBaseline(0); setNwAdjusted(null); return; }
    overviewApi.getNetWorthPctHistory(nwTimeframe)
      .then(r => { setNwHistory(r.points ?? []); setNwBaseline(r.baseline ?? 0); setNwAdjusted(r.adjusted ?? null); })
      .catch(() => { setNwHistory([]); setNwBaseline(0); setNwAdjusted(null); });
  }, [nwTimeframe, inHousehold]);

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
  const liveNw = netWorth?.net_worth ?? 0;
  // ── ONE series behind the chart, the percentage AND the headline ─────────────
  // All three used to be computed separately, over two different sources, which is
  // how the page came to show $51,126.13 with "−884.29% (−$850.3K) this week" under
  // it. They now come from a single pure builder whose last point IS the live net
  // worth, so the line, the percentage and the number are one statement said three
  // ways. See utils/netWorthSeries for what each mode plots and why.
  const nwSeries = buildNetWorthSeries({
    adjusted: nwAdjusted,
    history: nwHistory,
    liveNetWorth: liveNw,
    excludeStructural,
    nowMs: nwNowMs,
  });

  // Chart plots whichever mode is selected; the headline text still shows both.
  const nwPoints = nwDollar ? nwSeries.points : nwSeries.pctPoints;
  const nwWin = NW_WINDOW[nwTimeframe];
  const nwAxisMin = nwWin ? nwNowMs - nwWin : (nwPoints.length ? nwPoints[0].x : nwNowMs - DAY_MS);

  // Guard against a broken-looking sparkline when the snapshot feed has a gap.
  // The x-axis is pinned to the whole window (e.g. the last 24h for Daily), but if
  // the backend went idle and only woke on page load, every point bunches up at
  // "now" — chart.js then draws a 1px vertical sliver jammed against the right edge
  // (looks like the chart is broken). Only treat the series as chartable when ≥2
  // points inside the window actually SPAN a non-trivial slice of it; otherwise show
  // an honest "not enough data" state. Slow, well-spread series always pass.
  const nwInWindow = nwPoints.filter(p => p.x >= nwAxisMin - 1 && p.x <= nwNowMs + 1);
  const nwWindowLen = nwWin ?? (nwPoints.length ? nwNowMs - nwPoints[0].x : DAY_MS);
  const nwSpan = nwInWindow.length > 1 ? nwInWindow[nwInWindow.length - 1].x - nwInWindow[0].x : 0;
  const nwHasShape = nwInWindow.length >= 2 && nwSpan >= nwWindowLen * 0.05;

  // ── Headline change over the SELECTED timeframe ──────────────────────────────
  // Daily → today, weekly → this week, … all → since you started tracking. Simply
  // the two ends of the series plotted above: where the line starts and where it
  // ends, which is today's net worth. Nothing is recomputed here, so the headline is
  // the chart stated in words.
  const periodAmount = nwSeries.amount;
  const periodChange = nwSeries.pct;
  const TF_HEADLINE: Record<typeof nwTimeframe, string> = {
    daily: 'today', weekly: 'this week', monthly: 'this month',
    yearly: 'this year', all: 'since you started tracking',
  };
  const periodLabel = TF_HEADLINE[nwTimeframe];
  // Line colour follows the headline change directly — the single source of truth for
  // "up or down this period". The plotted series is now rebased to the window start
  // (0 at the left edge, ending at the headline change), so its slope and the headline
  // sign are the same thing; colouring straight off `periodChange` makes it impossible
  // for the line colour and the number to contradict each other.
  const nwUp = (periodChange ?? 0) >= 0;

  // ── Net-worth breakdown popup: per-item CHANGE over a chosen timeframe ──
  // Backend diffs each contributing item (bank/investment/super/SMSF/card) across
  // the window and returns them sorted by biggest contribution to the change.
  const SUB_LABELS: Record<string, string> = {
    bank: 'Bank account', investment: 'Investment', super: 'Superannuation', smsf: 'SMSF', credit_card: 'Credit card', loan: 'Loan',
    property: 'Property',
    // A holding's own change is its PRICE move — that is what "today" means on the
    // Investments page, and a share's performance is not a currency story. But net
    // worth is kept in one currency, so the rate moved it too. That half arrives as
    // its own row rather than going unattributed, which is what used to leave the
    // headline change larger than everything listed under it.
    currency: 'Currency movement',
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
    // Same personal feed as the trend above — it names the individual items that
    // moved, private investments and super among them. It has no business in a
    // household view, which shows what is shared and nothing else.
    if (inHousehold) { setBdItems([]); return; }
    setBdLoading(true);
    overviewApi.getNetWorthItemChanges(bdTimeframe)
      .then(r => setBdItems(r.items ?? []))
      .catch(() => setBdItems([]))
      .finally(() => setBdLoading(false));
  }, [detailOpen, bdTimeframe, inHousehold]);

  const changeTopN = (n: number) => { setTopN(n); localStorage.setItem('nwTopN', String(n)); };
  // Movers = items that actually changed in the window, biggest contribution first.
  // Something switched OUT of net worth (an excluded property, a hidden account, a
  // deleted loan) left structurally, not by losing money, so it belongs under the
  // same setting as an added/removed account rather than in the movers list.
  const bdMovers = bdItems.filter(
    it => Math.abs(it.contribution) >= 0.005 && !(excludeStructural && it.removed),
  );
  const bdTopMovers = bdMovers.slice(0, topN);
  // Bar length = this item's share of the TOTAL change, so $60 of a $100 move fills
  // 60% of the track. Denominator is the summed magnitude of all movers (not just the
  // shown top N) so proportions stay honest even when the list is truncated.
  const bdTotalAbs = bdMovers.reduce((sum, it) => sum + Math.abs(it.contribution), 0) || 1;

  // Chart.js `data` is built by a pure helper (utils/chartData) so the series→plot
  // mapping and up/down colour rule are unit-tested without rendering a canvas.
  const nwChartData = buildNetWorthChartData(nwPoints, nwUp, viewMode);

  // Axis tick text for the technical view. Same series, same window — this only
  // decides how a tick is WORDED, and is never used by the peaceful sparkline.
  const nwTickX = (ms: number) => {
    const d = new Date(ms);
    if (nwTimeframe === 'daily') return `${d.getHours().toString().padStart(2, '0')}:00`;
    if (nwTimeframe === 'yearly' || nwTimeframe === 'all') {
      return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const nwTickY = (v: number) => (nwDollar
    ? formatCurrency(v, currency, true)
    : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

  const nwChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipStyle(viewMode),
        callbacks: {
          title: (items: { parsed: { x: number | null } }[]) => {
            const d = new Date(items[0].parsed.x ?? 0);
            return nwTimeframe === 'daily'
              ? d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
              : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          },
          label: (item: { parsed: { y: number | null } }) => nwDollar
            ? formatCurrency(item.parsed.y ?? 0, currency, true)
            : `${(item.parsed.y ?? 0) >= 0 ? '+' : ''}${(item.parsed.y ?? 0).toFixed(2)}%`,
        },
      },
    },
    // Peaceful: a glanceable sparkline with no axes at all — the headline above the
    // chart carries the number, so ticks would only repeat it. Technical: the same
    // window with a dated x-axis and a value axis you can read off.
    scales: trendScales(viewMode, {
      min: nwAxisMin, max: nwNowMs, formatX: nwTickX, formatY: nwTickY,
    }),
  };

  // Recalculate net worth from local data every time relevant data changes.
  // `properties` is in the list because net worth counts them: without it a
  // revaluation, an ownership change or a flip of the count-toward-net-worth
  // switch left the headline showing the old figure until something else moved.
  useEffect(() => {
    const nw = calculateNetWorth();
    setNetWorth(nw);
  }, [accounts, creditCards, investments, superFunds, loans, properties, setNetWorth]);

  useEffect(() => {
    if (searchParams.get('add') === 'bill') { setEditBill(null); setBillModalKind('bill'); setAddBillOpen(true); }
    if (searchParams.get('add') === 'reminder') { setEditBill(null); setBillModalKind('reminder'); setAddBillOpen(true); }
    // `?add=goal` is handled inside GoalSection, which owns the add-goal modal.
  }, [searchParams]);

  // ── `?focus=` — where a Phase 4.4 alert lands you ──────────────────────────
  //
  // `focus=budget:<budget key>` and `focus=goal:<goal id>` scroll to the widget
  // and mark the one row the alert was about, so following an alert about
  // Groceries puts Groceries in front of you rather than the card it lives on.
  // The mark is transient: it fades after a few seconds, because it is a "here"
  // gesture, not a state the page should hold.
  const focus = searchParams.get('focus') ?? '';
  const [focusBudgetKey, setFocusBudgetKey] = useState<string | null>(null);
  const [focusGoalId, setFocusGoalId] = useState<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    const [what, ...rest] = focus.split(':');
    const which = rest.join(':') || null;
    const anchor = what === 'budget' ? 'budget-widget' : what === 'goal' ? 'goal-widget' : null;
    if (!anchor) return;

    if (what === 'budget') setFocusBudgetKey(which);
    if (what === 'goal') setFocusGoalId(which);

    // A frame's delay: the widget may not have rendered on the tick the query
    // param arrives, and scrolling to an element that isn't there does nothing.
    const scroll = window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    const clear = window.setTimeout(() => { setFocusBudgetKey(null); setFocusGoalId(null); }, 4000);
    return () => { window.clearTimeout(scroll); window.clearTimeout(clear); };
    // `location.key` as well as `focus`: following the SAME alert a second time
    // navigates to the identical URL, so the search string alone never changes
    // and the highlight would fire once and never again. Every navigation gets a
    // fresh key, which is what makes the second click behave like the first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, location.key]);

  const [dismissedDupes, setDismissedDupes] = useState<string[]>([]);
  // "Not now" — session-hidden bill↔subscription reconciliation suggestions (keyed
  // by bill id). "Different bills" persists via billReconciliationDS; this is the
  // lighter, non-persistent hush so the same banner doesn't nag within a session.
  const [hushedRecon, setHushedRecon] = useState<string[]>([]);

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

  // A manual bill and an auto-detected subscription that look like the SAME
  // recurring payment (evidence: name + amount + cadence + account, never date
  // alone). Surfaced for the user to confirm — never auto-linked.
  const reconCandidates = billReconciliationDS.candidates()
    .filter(c => !hushedRecon.includes(c.bill.id));

  // Solid (opaque) fills — these rows sit in front of the stacked peek cards,
  // so any transparency would let the grey deck behind them bleed through.
  const billColour: Record<string, string> = {
    grey:   'bg-zinc-100 dark:bg-zinc-800',
    yellow: 'bg-[#fdf3e0] dark:bg-[#3a2e15] border border-[#f59e0b]/30',
    red:    'bg-[#fdeaea] dark:bg-[#3a1f1f] border border-[#ef4444]/30',
  };

  // Row tint reflects STATUS, not "auto". An auto item just restarts on its due
  // date so it can never lapse — it stays neutral, and only its little ⚡ Auto
  // badge is green (no more full-green row). A missed (overdue) MANUAL item turns
  // red. Yellow/orange and red are the user's own urgency colours, set per item;
  // they are no longer applied automatically as the due date approaches.
  const reminderDefault = 'bg-[#eef4fc] dark:bg-[#16263a] border border-brand/20';
  const billWrapClass = (bill: import('../types').Bill): string => {
    const isReminder = bill.kind === 'reminder';
    if (!bill.auto_pay && daysUntil(bill.due_date) < 0) return billColour.red; // missed
    if (bill.colour === 'red') return billColour.red;                          // user: urgent
    if (bill.colour === 'yellow') return billColour.yellow;                    // user: moderate
    return isReminder ? reminderDefault : billColour.grey;                     // neutral
  };

  const billStatusText = (bill: import('../types').Bill): string => {
    const days = daysUntil(bill.due_date);
    if (bill.auto_pay) {
      const verb = bill.kind === 'reminder' ? 'Auto-completes' : 'Auto-pays';
      return days <= 0 ? `${verb} today` : days === 1 ? `${verb} tomorrow` : `${verb} in ${days} days`;
    }
    return days < 0 ? `Overdue by ${Math.abs(days)} days`
      : days === 0 ? 'Due today'
      : days === 1 ? 'Due tomorrow'
      : `Due in ${days} days`;
  };

  // "⚡ Auto-pay" for bills, "⚡ Auto-complete" for reminders — same field, but
  // a reminder ticks itself off rather than paying.
  const autoLabel = (bill: import('../types').Bill): string =>
    bill.kind === 'reminder' ? 'Auto-complete' : 'Auto-pay';

  const refreshBills = () => setBills([...useStore.getState().bills]);

  const handlePayBill = (id: string) => {
    billsDS.pay(id);
    refreshBills();
  };

  // Tick-to-pay first asks for confirmation, so an accidental tap can't silently
  // mark a bill/reminder as paid. payConfirm holds the item awaiting confirmation.
  const [payConfirm, setPayConfirm] = useState<Bill | null>(null);
  const confirmPay = () => {
    if (payConfirm) handlePayBill(payConfirm.id);
    setPayConfirm(null);
  };

  // Deleting a bill/reminder asks for confirmation so it can't be removed by an
  // accidental tap. billToDelete holds the item awaiting confirmation.
  const [billToDelete, setBillToDelete] = useState<Bill | null>(null);
  const confirmDeleteBill = () => {
    if (billToDelete) { billsDS.remove(billToDelete.id); refreshBills(); }
    setBillToDelete(null);
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

  // Overflow "stacker": the extra items sit *under* the last visible row as a deck.
  // Each peek card is pulled up so most of it (≈¾) hides behind the row above, with
  // only its bottom edge showing and its sides tucked in — like a notification stack.
  // The cards use a negative z-index inside the list's isolated stacking context, so
  // the real (non-positioned) rows always paint on top of them. Tapping opens the list.
  const renderStacker = (overflow: Bill[]) => {
    if (overflow.length === 0) return null;
    // Always show a two-card stack when there's any overflow — even a single extra
    // item reads better as a stacked deck than a lone peek.
    const layers = 2;
    const open = () => setBillsExpanded(true);
    return (
      <>
        {Array.from({ length: layers }).map((_, i) => (
          <div
            key={i}
            onClick={open}
            title={`${overflow.length} more — tap to view all`}
            className="cursor-pointer rounded-[8px] border border-[#e0e0e0] dark:border-zinc-800 bg-[#ededed] dark:bg-zinc-800 shadow-sm mx-auto"
            style={{
              position: 'relative',
              zIndex: -1 - i,
              height: 46,
              width: `${96 - i * 7}%`,
              marginTop: i === 0 ? -34 : -38,
              opacity: 1 - i * 0.35,
            }}
          />
        ))}
        <p
          onClick={open}
          className="text-xs text-zinc-500 dark:text-zinc-400 text-center cursor-pointer hover:text-brand transition-colors"
          style={{ marginTop: 8 }}
        >
          +{overflow.length} more
        </p>
      </>
    );
  };

  // Shared active-item row for the expanded modal (bills + reminders).
  const renderActiveRow = (bill: Bill) => (
    <div key={bill.id} className={`flex items-center justify-between p-3 rounded-[8px] ${billWrapClass(bill)}`}>
      <div className="flex items-center gap-3">
        {bill.auto_pay ? (
          <div className="w-5 h-5 rounded-full bg-[#22c55e]/20 text-[#22c55e] flex items-center justify-center flex-shrink-0 text-xs" title={autoLabel(bill)}>⚡</div>
        ) : (
          <button
            onClick={() => setPayConfirm(bill)}
            className="w-5 h-5 rounded-full border-2 border-zinc-500 dark:border-zinc-400 flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/20 transition-colors"
            title="Mark as done"
          />
        )}
        <div>
          <p className="text-sm font-medium flex items-center gap-1.5">
            {bill.kind === 'reminder' && '🔔 '}{bill.name}
            {bill.auto_pay && <span className="text-[10px] font-semibold text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded-full">⚡ {autoLabel(bill)}</span>}
            <SharedBadge row={bill} />
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {billStatusText(bill)}
            {bill.is_recurring && ` · ${bill.frequency}`}
            {bill.category && ` · ${bill.category}`}
            {billResponsibleName(bill) && <span className="text-[#7c3aed] dark:text-[#c4b5fd]"> · 👤 {billResponsibleName(bill)}</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {(bill.kind !== 'reminder' || bill.amount > 0) && (
          <div className="flex flex-col items-end leading-tight">
            <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
            {(bill.loan_id || bill.category === 'loan') && <span className="text-[10px] font-normal text-zinc-400 dark:text-zinc-500">min pay</span>}
          </div>
        )}
        <button onClick={() => openEdit(bill)} className="text-zinc-400 hover:text-brand transition-colors" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button
          onClick={() => setBillToDelete(bill)}
          className="text-xs text-zinc-400 hover:text-[#ef4444] transition-colors"
          title="Delete"
        >✕</button>
      </div>
    </div>
  );

  return (
    <Layout>
      {/* Greeting header — matches PAssistant's "Good morning, Harry" + big CTA layout. */}
      <Greeting
        name={user?.name ?? undefined}
        subtitle={new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}
        action={
          <KitButton large onClick={() => setQuickAddOpen(true)}>+ Quick Add</KitButton>
        }
      />

      {/* Net Worth Hero */}
      <div className="mb-6">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Total net worth</p>
        <button
          onClick={() => setDetailOpen(true)}
          className="group flex items-center gap-2 text-left"
          title="See what makes up your net worth"
        >
          <h1 className="text-4xl sm:text-5xl font-semibold amount tracking-tight mt-1 group-hover:opacity-80 transition-opacity">
            {formatCurrency(netWorth?.net_worth ?? 0, currency)}
          </h1>
          <svg className="w-5 h-5 mt-1 text-zinc-400 group-hover:text-zinc-500 dark:group-hover:text-zinc-300 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          {currency} · Updated just now
          <span className="mx-1.5">·</span>
          <button onClick={() => setCustomiseOpen(true)} className="text-brand hover:underline">Customise</button>
        </p>
        {!inHousehold && periodChange !== null && (
          <p className="text-sm mt-0.5">
            <span className={`font-medium ${colorForChange(periodChange)}`}>
              {formatPercent(periodChange)} ({periodAmount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(periodAmount), currency, true)}) {periodLabel}
            </span>
          </p>
        )}

        {/* The trend, and the change above it, are the PERSONAL series — see the
            fetch. A household has no snapshot feed of its own, so rather than
            plot somebody's private portfolio under a shared headline, the
            household view says plainly that it has no trend to show. */}
        {inHousehold ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">
            This is what the household shares, as it stands right now. The net-worth
            trend is tracked for My Finances — switch back to see it.
          </p>
        ) : (
        <div className="mt-4">
          <div className="flex justify-between items-center mb-2 gap-2">
            <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
              {([
                { key: 'pct' as const, label: '%' },
                { key: 'dollar' as const, label: '$' },
              ]).map(m => (
                <button
                  key={m.key}
                  onClick={() => setNwMode(m.key)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    nwMode === m.key
                      ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                      : 'text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
              {NW_TF_LABELS.map(tf => (
                <button
                  key={tf.key}
                  onClick={() => setNwTimeframe(tf.key)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    nwTimeframe === tf.key
                      ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                      : 'text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>
          <div className="h-32">
            {nwHasShape ? (
              <Line data={nwChartData} options={nwChartOptions} />
            ) : (
              <div className="nw-sparse-state h-full flex items-center justify-center text-center px-6 text-sm text-zinc-500 dark:text-zinc-400">
                {nwPoints.length === 0
                  ? 'No history yet — your net worth change will be tracked from today.'
                  : `Not enough data in the ${({ daily: 'last 24 hours', weekly: 'last week', monthly: 'last month', yearly: 'last year', all: 'tracked range' } as Record<typeof nwTimeframe, string>)[nwTimeframe]} yet — the trend fills in as new snapshots are recorded.`}
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Summary Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Bank accounts',  value: netWorth?.bank_balance ?? 0,    isDebt: false },
          // Investments and super can't be shared with a household at all, so in
          // the household view they are not a $0 line — they are not part of the
          // picture. Printing them as zero read as "the household holds nothing",
          // when the truth is that this view has nothing to say about them.
          ...(inHousehold
            ? []
            : [{ label: 'Investments', value: netWorth?.investments ?? 0, isDebt: false }]),
          { label: 'Credit cards',   value: netWorth?.credit_card_debt ?? 0, isDebt: true  },
          ...(inHousehold
            ? []
            : [{ label: 'Superannuation', value: netWorth?.super ?? 0, isDebt: false }]),
          // Property only earns a tile once there is one — the share you own of
          // it, with its mortgage sitting under Loans where it is subtracted.
          // Shown whenever it is non-zero, not merely positive: a property worth
          // less than the mortgage against it is a real, negative contribution and
          // hiding it would leave net worth unexplained by the tiles above.
          ...((netWorth?.property ?? 0) !== 0
            ? [{ label: 'Property', value: netWorth!.property, isDebt: false }]
            : []),
          // Loans belong beside Property for the same reason a balance sheet puts
          // them together: the house is on one line and what is owed against it on
          // the next. Without this tile the breakdown showed the full value of a
          // property and no debt anywhere, which reads as the house sitting on top
          // of its mortgage — even though net worth had already subtracted it.
          ...((netWorth?.loans ?? 0) > 0
            ? [{ label: 'Loans', value: netWorth!.loans, isDebt: true }]
            : []),
        ].map(item => (
          <Card key={item.label} padding="sm">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{item.label}</p>
            <p className={`text-base font-semibold amount mt-1 ${item.isDebt && item.value > 0 ? 'text-[#ef4444]' : ''}`}>
              {formatCurrency(item.value, currency, true)}
            </p>
          </Card>
        ))}
      </div>

      {/* One card, where there used to be three stacked ones: the Phase 4.4
          alerts, the Phase 6.1 insights and the Phase 2C import queue, merged
          into a single ranked list under two labelled tiers — what needs you,
          then what changed. Self-hides when there is nothing to say. The two
          Settings toggles still work: each one silences its own tier. */}
      {(widgetVisibility.alerts !== false || widgetVisibility.insights !== false) && (
        <AttentionCard
          currency={currency}
          showAlerts={widgetVisibility.alerts !== false}
          showInsights={widgetVisibility.insights !== false}
        />
      )}
      {/* Phase 6.2 — one COMPLETE week or month, read back. COLLAPSED by
          default: it is the slow, deliberate read of the same engines, and a
          period picker plus five groups of rows is not something to walk into
          on the way to your balance. */}
      {widgetVisibility.review !== false && <ReviewSection currency={currency} />}

      {/* Bills Widget */}
      {widgetVisibility.bills && (
        <Card className="mb-4" padding="none">
          <button
            onClick={() => setBillsExpanded(true)}
            className="w-full px-5 py-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 text-left group hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
          >
            <div>
              <h2 className="font-semibold group-hover:text-brand transition-colors">Bills &amp; Reminders</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{urgentBills.length} due this week</p>
            </div>
            <span className="text-xs text-brand group-hover:underline flex items-center gap-1">
              View all <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
            </span>
          </button>
          <div className="p-4 space-y-2 relative isolate">
            {duplicateBills.map(({ keep, duplicate }) => (
              <div key={duplicate.id} className="px-3 py-2.5 rounded-[8px] bg-[#f59e0b]/10 border border-[#f59e0b]/30">
                <p className="text-sm font-medium">Found two bills that look the same</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
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
                    className="text-xs font-medium text-zinc-500 dark:text-zinc-400 px-3 py-1.5 rounded-[6px] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Keep both
                  </button>
                </div>
              </div>
            ))}
            {reconCandidates.map(({ bill, subscription, result }) => (
              <div key={`recon-${bill.id}`} className="px-3 py-2.5 rounded-[8px] bg-brand/10 border border-brand/30">
                <p className="text-sm font-medium">
                  {result.verdict === 'same' ? 'This looks like the same bill' : 'Possible same bill'}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Your bill “{bill.name}” ({formatCurrency(bill.amount, currency)}) may be the same payment as
                  your subscription “{subscription.name}”.{result.reasons.length > 0 ? ` ${result.reasons.join(' · ')}.` : ''} Link them so it's counted once?
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button
                    onClick={() => {
                      billReconciliationDS.link(bill.id, subscription.id);
                      refreshBills();
                      setSubscriptions(subscriptionsDS.getAll());
                    }}
                    className="text-xs font-semibold text-white bg-brand hover:opacity-90 px-3 py-1.5 rounded-[6px] transition-opacity"
                  >
                    Same bill
                  </button>
                  <button
                    onClick={() => {
                      billReconciliationDS.markDifferent(bill.id, subscription.id);
                      setHushedRecon(h => [...h, bill.id]);
                    }}
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 rounded-[6px] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Different bills
                  </button>
                  <button
                    onClick={() => setHushedRecon(h => [...h, bill.id])}
                    className="text-xs font-medium text-zinc-500 dark:text-zinc-400 px-3 py-1.5 rounded-[6px] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ))}
            {widgetBills.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2 text-center">No upcoming bills</p>
            ) : (
              widgetBills.slice(0, billsShowCount).map(bill => {
                return (
                  <div key={bill.id} className={`flex items-center justify-between px-3 py-2.5 rounded-[8px] ${billWrapClass(bill)}`}>
                    <div className="flex items-center gap-3">
                      {bill.auto_pay ? (
                        /* Auto-pay: lightning indicator, no manual tick */
                        <div
                          className="w-5 h-5 rounded-full bg-[#22c55e]/20 text-[#22c55e] flex items-center justify-center flex-shrink-0 text-xs"
                          title={autoLabel(bill)}
                        >
                          ⚡
                        </div>
                      ) : (
                        /* Tick circle — marks as paid, moves to recently completed */
                        <button
                          onClick={() => setPayConfirm(bill)}
                          className="w-5 h-5 rounded-full border-2 border-zinc-500 dark:border-zinc-400 flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/20 transition-colors"
                          title="Mark as paid"
                        />
                      )}
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          {bill.name}
                          {bill.auto_pay && (
                            <span className="text-[10px] font-semibold text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded-full">⚡ {autoLabel(bill)}</span>
                          )}
                          <SharedBadge row={bill} />
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {billStatusText(bill)}
                          {bill.is_recurring && ' · Recurring'}
                          {bill.category && ` · ${bill.category}`}
                          {billResponsibleName(bill) && <span className="text-[#7c3aed] dark:text-[#c4b5fd]"> · 👤 {billResponsibleName(bill)}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col items-end leading-tight">
                        <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
                        {(bill.loan_id || bill.category === 'loan') && <span className="text-[10px] font-normal text-zinc-400 dark:text-zinc-500">min pay</span>}
                      </div>
                      <button onClick={() => openEdit(bill)} className="text-zinc-400 hover:text-brand transition-colors" title="Edit">
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
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 pt-2">Reminders</h3>
                {widgetReminders.slice(0, billsShowCount).map(rem => (
                  <div key={rem.id} className={`flex items-center justify-between px-3 py-2.5 rounded-[8px] ${billWrapClass(rem)}`}>
                    <div className="flex items-center gap-3">
                      {rem.auto_pay ? (
                        /* Auto-complete: lightning indicator, ticks itself off on due date */
                        <div
                          className="w-5 h-5 rounded-full bg-[#22c55e]/20 text-[#22c55e] flex items-center justify-center flex-shrink-0 text-xs"
                          title={autoLabel(rem)}
                        >
                          ⚡
                        </div>
                      ) : (
                        <button
                          onClick={() => setPayConfirm(rem)}
                          className="w-5 h-5 rounded-full border-2 border-brand/50 flex-shrink-0 hover:bg-brand/20 transition-colors"
                          title="Mark as done"
                        />
                      )}
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          🔔 {rem.name}
                          {rem.auto_pay && (
                            <span className="text-[10px] font-semibold text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded-full">⚡ {autoLabel(rem)}</span>
                          )}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {billStatusText(rem)}
                          {rem.is_recurring && ' · Recurring'}
                          {rem.category && ` · ${rem.category}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {rem.amount > 0 && <span className="text-sm font-semibold amount">{formatCurrency(rem.amount, currency)}</span>}
                      <button onClick={() => openEdit(rem)} className="text-zinc-400 hover:text-brand transition-colors" title="Edit">
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
            <button onClick={() => openAdd('bill')} className="text-sm text-brand hover:underline">+ Add bill</button>
            <button onClick={() => openAdd('reminder')} className="text-sm text-brand hover:underline">+ Add reminder</button>
          </div>
        </Card>
      )}

      {/* Budget Widget */}
      {widgetVisibility.budgeting && (
        <div className="mb-4" id="budget-widget">
          <BudgetSection currency={currency} focusKey={focusBudgetKey} />
        </div>
      )}

      {/* Goals Widget — Phase 4.3 savings goals (progress, required pace, on-track vs forecast) */}
      {widgetVisibility.goals && (
        <div className="mb-4" id="goal-widget">
          <GoalSection currency={currency} focusGoalId={focusGoalId} />
        </div>
      )}

      {/* Widget Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {widgetVisibility.bankAccounts && (
          <Card>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Bank Accounts</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.bank_balance ?? 0, currency, true)}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {/* Personal by construction — hidden in the household view rather than
            shown as a zero over a count of the owner's own private holdings. */}
        {widgetVisibility.investments && !inHousehold && (
          <Card>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Investments</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.investments ?? 0, currency, true)}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{investments.length} holding{investments.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.creditCards && (
          <Card>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Credit Card Debt</p>
            <p className={`text-xl font-semibold amount ${(netWorth?.credit_card_debt ?? 0) > 0 ? 'text-[#ef4444]' : ''}`}>
              {formatCurrency(netWorth?.credit_card_debt ?? 0, currency, true)}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{creditCards.length} card{creditCards.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.super && !inHousehold && (
          <Card>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Superannuation</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.super ?? 0, currency, true)}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{superFunds.length} fund{superFunds.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
      </div>


      {/* Customise Modal */}
      <Modal isOpen={customiseOpen} onClose={() => setCustomiseOpen(false)} title="Customise Dashboard" size="sm">
        <div className="space-y-3">
          {/* Driven by the canonical list, not by the keys that happen to be in
              the persisted blob — a widget added after a user's preferences were
              saved would otherwise never get a toggle on their device. Anything
              they have stored that isn't listed here still gets one, so nothing
              a user has turned off becomes unreachable. */}
          {[...WIDGET_LABELS, ...Object.keys(widgetVisibility)
            .filter(k => !WIDGET_LABELS.some(([key]) => key === k))
            .map(k => [k, k] as const),
          ].map(([key, label]) => (
            <div key={key} className="flex items-center justify-between py-1">
              <span className="text-sm">{label}</span>
              <Toggle
                checked={widgetVisibility[key] !== false}
                onChange={v => setWidgetVisibility(key, v)}
              />
            </div>
          ))}
        </div>
      </Modal>

      {/* Bills Expanded */}
      <Modal isOpen={billsExpanded} onClose={() => setBillsExpanded(false)} title="Bills & Reminders" size="lg">
        <div className="flex justify-end mb-3">
          <button
            onClick={() => { setShowCountDraft(String(billsShowCount)); setLeadDaysDraft(String(billsLeadDays)); setBillSettingsOpen(true); }}
            className="text-xs text-brand hover:underline flex items-center gap-1"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Settings
          </button>
        </div>

        {/* ── Bills ── */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Bills</h3>
        <div className="space-y-2 mb-6">
          {upcomingBills.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">No upcoming bills 🎉</p>
          )}
          {upcomingBills.map(renderActiveRow)}
        </div>

        {/* ── Reminders ── */}
        {upcomingReminders.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Reminders</h3>
            <div className="space-y-2 mb-6">
              {upcomingReminders.map(renderActiveRow)}
            </div>
          </>
        )}

        {/* ── Recently completed ── */}
        {recentlyPaidBills.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
              Recently completed
              <span className="ml-1.5 font-normal normal-case">(kept for 7 days — click to restore)</span>
            </h3>
            <div className="space-y-2 mb-5">
              {recentlyPaidBills.map(bill => (
                <div key={bill.id} className="flex items-center justify-between p-3 rounded-[8px] border border-zinc-200 dark:border-zinc-800 opacity-60">
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
                      <p className="text-sm font-medium line-through text-zinc-500 dark:text-zinc-400">{bill.name}</p>
                      <p className="text-xs text-zinc-400 dark:text-[#666]">
                        Paid {bill.paid_at ? formatDate(bill.paid_at) : 'recently'} · {formatCurrency(bill.amount, currency)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestoreBill(bill.id)}
                    className="text-xs text-brand hover:underline flex-shrink-0"
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
        accounts={accounts}
        creditCards={creditCards}
        onClose={() => { setAddBillOpen(false); setEditBill(null); }}
        onSave={handleSaveBill}
      />

      {/* Recurring edit: apply to all future occurrences? */}
      {/* Confirm tick-to-pay so an accidental tap can't mark an item paid. */}
      <Modal isOpen={!!payConfirm} onClose={() => setPayConfirm(null)} title={payConfirm?.kind === 'reminder' ? 'Mark reminder as done?' : 'Mark bill as paid?'} size="sm">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
          {payConfirm?.kind === 'reminder'
            ? <>Mark <span className="font-medium text-zinc-900 dark:text-white">{payConfirm?.name}</span> as done? It’ll move to recently completed.</>
            : <>Confirm you’ve paid <span className="font-medium text-zinc-900 dark:text-white">{payConfirm?.name}</span>{payConfirm && payConfirm.amount > 0 ? <> ({formatCurrency(payConfirm.amount, currency)})</> : null}? It’ll move to recently completed.</>}
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" fullWidth onClick={() => setPayConfirm(null)}>Cancel</Button>
          <Button variant="primary" fullWidth onClick={confirmPay}>{payConfirm?.kind === 'reminder' ? 'Mark done' : 'Mark paid'}</Button>
        </div>
      </Modal>

      <Modal isOpen={!!recurringConfirm} onClose={() => setRecurringConfirm(null)} title="Update recurring payment" size="sm">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Display</h3>
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Show on overview</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Extra items collapse into a stack you can tap to expand.</p>
            </div>
            <input
              type="number" min={1} max={20} inputMode="numeric" value={showCountDraft}
              onChange={e => {
                setShowCountDraft(e.target.value);
                if (e.target.value !== '') changeBillsShowCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)));
              }}
              onBlur={() => { const n = Math.max(1, Math.min(20, Number(showCountDraft) || billsShowCount)); changeBillsShowCount(n); setShowCountDraft(String(n)); }}
              className="w-20 text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 flex-shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Show items this many days before due</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Base lead time. Override per item when editing it.</p>
            </div>
            <input
              type="number" min={0} max={365} inputMode="numeric" value={leadDaysDraft}
              onChange={e => {
                setLeadDaysDraft(e.target.value);
                if (e.target.value !== '') changeBillsLeadDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)));
              }}
              onBlur={() => { const n = Math.max(0, Math.min(365, Number(leadDaysDraft) || billsLeadDays)); changeBillsLeadDays(n); setLeadDaysDraft(String(n)); }}
              className="w-20 text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 flex-shrink-0"
            />
          </div>
        </div>

        {/* ── Per-item: category ── */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Categories</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
          Tag each bill &amp; reminder. Items linked to a bank subscription start with that category. (Set how early each one appears when editing it.)
        </p>
        {allUpcoming.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">No bills or reminders yet.</p>
        ) : (
          <div className="space-y-2">
            {allUpcoming.map(item => {
              const linked = subscriptionCategoryFor(item);
              const value = item.category ?? linked ?? '';
              return (
                <div key={item.id} className="flex items-center justify-between gap-2 p-2.5 rounded-[8px] border border-zinc-200 dark:border-zinc-800">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{item.kind === 'reminder' ? '🔔 ' : ''}{item.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {item.amount > 0 ? formatCurrency(item.amount, currency) : 'No amount'}
                      {item.is_recurring && ` · ${item.frequency}`}
                      {!item.category && linked && ' · from bank'}
                    </p>
                  </div>
                  <select
                    value={value}
                    onChange={e => setItemCategory(item, e.target.value)}
                    className="text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 flex-shrink-0 max-w-[8rem]"
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

      {/* Add / Edit / delete goal, contributions, and the whole goals list now
          live inside GoalSection (Phase 4.3). */}

      {/* Delete-bill/reminder confirmation */}
      <Modal isOpen={!!billToDelete} onClose={() => setBillToDelete(null)} title={`Delete ${billToDelete?.kind === 'reminder' ? 'reminder' : 'bill'}?`} size="sm">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
          Delete <span className="font-medium text-zinc-900 dark:text-white">“{billToDelete?.name}”</span>? This can't be undone.
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" fullWidth onClick={() => setBillToDelete(null)}>Cancel</Button>
          <Button variant="danger" fullWidth onClick={confirmDeleteBill}>Delete</Button>
        </div>
      </Modal>

      {/* Net worth breakdown — what changed it the most over a chosen timeframe */}
      <Modal isOpen={detailOpen} onClose={() => setDetailOpen(false)} title="What's driving your net worth" size="md">
        <div className="space-y-4">
          {/* Timeframe toggle. Hidden in the household view, where there is no
              series for it to pick a window of. */}
          {!inHousehold && (
          <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1 overflow-x-auto">
            {BD_TF_LABELS.map(tf => (
              <button
                key={tf.key}
                onClick={() => setBdTimeframe(tf.key)}
                className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors ${
                  bdTimeframe === tf.key
                    ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
          )}

          {!inHousehold && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Biggest movers {TF_PHRASE[bdTimeframe]} — what added to or subtracted from your net worth.
            </p>
          )}

          {inHousehold ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">
              Movers are tracked for My Finances — they're measured from your own
              recorded history, which includes things a household never sees, like
              your investments and super. Switch back to My Finances to see them.
            </p>
          ) : bdLoading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">Loading…</p>
          ) : bdMovers.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">
              No tracked changes yet {TF_PHRASE[bdTimeframe]}. Changes are recorded from when each item starts being tracked, so this fills in over time.
            </p>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto -mx-1 px-1 space-y-2.5">
              {bdTopMovers.map(it => {
                const up = it.contribution >= 0;
                const share = Math.round((Math.abs(it.contribution) / bdTotalAbs) * 100);
                return (
                  <div key={`${it.item_type}:${it.item_id}`} className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{it.name}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {SUB_LABELS[it.item_type] ?? it.item_type}
                          {it.removed && ' · no longer counted'}
                        </p>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <p className={`text-sm font-semibold amount ${up ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                          {up ? '+' : '−'}{formatCurrency(Math.abs(it.contribution), currency, true)}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {it.item_type === 'currency'
                            ? `${formatCurrency(it.current_value, currency, true)} held in ${it.item_id.split('-')[0]}`
                            : `now ${formatCurrency(it.current_value, currency, true)}`}
                        </p>
                      </div>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                      <div className={`h-full rounded-full ${up ? 'bg-[#22c55e]' : 'bg-[#ef4444]'}`} style={{ width: `${share}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* "Don't count new accounts as a gain" setting */}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-900 dark:text-white">Ignore added/removed accounts</p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                When on, adding or removing an account — or switching one out of net worth — won't spike your change. Only real gains and losses move it.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={excludeStructural}
              onClick={() => toggleExcludeStructural(!excludeStructural)}
              className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${excludeStructural ? 'bg-[#22c55e]' : 'bg-zinc-300 dark:bg-zinc-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${excludeStructural ? 'translate-x-4' : ''}`} />
            </button>
          </div>

          {/* "How many to show" setting */}
          <div className="flex items-center justify-between pt-3 border-t border-zinc-200 dark:border-zinc-800">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">Show top</label>
            <div className="flex gap-1">
              {[3, 5, 10, 9999].map(n => (
                <button
                  key={n}
                  onClick={() => changeTopN(n)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    topN === n
                      ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-medium'
                      : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400'
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

function BillModal({ isOpen, onClose, onSave, defaultKind, editing, categoryPrefill, accounts, creditCards }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (d: Partial<Bill>, id?: string) => void;
  defaultKind: 'bill' | 'reminder';
  editing: Bill | null;
  categoryPrefill?: string;
  accounts: BankAccount[];
  creditCards: CreditCard[];
}) {
  const blank = {
    kind: defaultKind, name: '', amount: '', due_date: '', is_recurring: false,
    frequency: 'monthly', colour: 'grey' as 'grey' | 'yellow' | 'red', category: '',
    lead_days: '', auto_pay: false,
    // "bank:<id>" / "card:<id>" / "" (unassigned). One control spanning both owner
    // kinds keeps the value unambiguous when a bank and card share a raw id.
    payFrom: '',
    // Phase 7.2 — the household member responsible for a shared bill ('' = unassigned).
    responsible: '',
  };
  const [form, setForm] = useState(blank);

  // Phase 7.2 — who a shared bill can be assigned to: the active members of
  // every household it is shared with. Empty for a personal bill, which is what
  // hides the control.
  const { householdMembers, user: me } = useStore();
  const respMembers = useMemo(() => {
    if (!editing) return [];
    const seen = new Map<string, { userId: string; label: string }>();
    for (const hh of householdsOf(editing)) {
      for (const m of activeMembers(householdMembers, hh)) {
        if (!seen.has(m.user_id)) {
          seen.set(m.user_id, {
            userId: m.user_id,
            label: (m.name || m.email || 'Member') + (m.user_id === me?.id ? ' (you)' : ''),
          });
        }
      }
    }
    return [...seen.values()];
  }, [editing, householdMembers, me?.id]);

  // Telegram reminders, edited in the UI as absolute date + time. Converted to/from
  // the stored { offset_days, time } (relative to due date) on seed/save so recurring
  // bills shift automatically. last_sent is preserved so editing doesn't re-fire.
  type ReminderRow = { id: string; date: string; time: string; last_sent: string | null };
  const [reminders, setReminders] = useState<ReminderRow[]>([]);

  // YYYY-MM-DD ± whole days (UTC date math, timezone-drift free).
  const shiftDateStr = (dateStr: string, delta: number): string => {
    const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().split('T')[0];
  };
  const diffDays = (from: string, to: string): number =>
    Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000);

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
        lead_days: editing.lead_days != null ? String(editing.lead_days) : '',
        auto_pay: editing.auto_pay ?? false,
        payFrom: editing.account_id && editing.account_type
          ? `${editing.account_type === 'credit_card' ? 'card' : 'bank'}:${editing.account_id}`
          : '',
        responsible: editing.responsible_user_id ?? '',
      });
      const due = editing.due_date ?? '';
      setReminders((editing.reminders ?? []).map(r => ({
        id: r.id,
        date: due ? shiftDateStr(due, -r.offset_days) : '',
        time: r.time,
        last_sent: r.last_sent,
      })));
    } else {
      setForm({ ...blank, kind: defaultKind });
      setReminders([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editing, defaultKind, categoryPrefill]);

  const isReminder = form.kind === 'reminder';

  const addReminder = () =>
    setReminders(rs => [...rs, { id: crypto.randomUUID(), date: form.due_date || '', time: '09:00', last_sent: null }]);
  const updateReminder = (id: string, patch: Partial<ReminderRow>) =>
    setReminders(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const removeReminder = (id: string) => setReminders(rs => rs.filter(r => r.id !== id));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Reminders allow a blank amount; bills require one.
    if (!form.name || !form.due_date) return;
    if (!isReminder && !form.amount) return;

    // "Pay from" — split "bank:<id>" / "card:<id>" back into the two stored fields.
    // Reminders and unassigned bills store null (no transaction on pay). A stale
    // selection whose account no longer exists is dropped to unassigned.
    const [payKind, payId] = form.payFrom ? form.payFrom.split(/:(.+)/) : ['', ''];
    const ownerType: 'bank' | 'credit_card' | null =
      isReminder ? null : payKind === 'bank' ? 'bank' : payKind === 'card' ? 'credit_card' : null;
    const ownerExists = ownerType === 'bank'
      ? accounts.some(a => a.id === payId)
      : ownerType === 'credit_card'
        ? creditCards.some(c => c.id === payId)
        : false;
    // Clearing a previously-set assignment must send explicit nulls; an always-
    // unassigned bill sends NO account keys at all, so it keeps working even before
    // the 3.4 columns migration runs (only assigning depends on the new columns).
    const clearingAssignment = !!editing && !!editing.account_id && !ownerExists;

    const payload: Partial<Bill> = {
      kind: form.kind,
      name: form.name,
      amount: form.amount ? parseFloat(form.amount) : 0,
      due_date: form.due_date,
      ...(ownerExists ? { account_id: payId, account_type: ownerType } : {}),
      ...(clearingAssignment ? { account_id: null, account_type: null } : {}),
      is_recurring: form.is_recurring,
      frequency: form.is_recurring ? form.frequency : undefined,
      colour: form.colour,
      category: form.category || null,
      lead_days: form.lead_days === '' ? null : Math.max(0, Number(form.lead_days) || 0),
      // "Auto" only applies where it can act: a recurring item (rolls forward) or a
      // reminder (a one-off reminder ticks itself off). A one-off bill can't auto-pay.
      auto_pay: (form.is_recurring || form.kind === 'reminder') ? form.auto_pay : false,
      reminders: reminders
        .filter(r => r.date && r.time)
        .map(r => ({
          id: r.id,
          offset_days: diffDays(r.date, form.due_date),
          time: r.time,
          last_sent: r.last_sent,
        })),
      // Only sent when the control was on screen — a personal bill never carries
      // the key, so it keeps working even before the 7.2 migration runs.
      ...(respMembers.length > 0 ? { responsible_user_id: form.responsible || null } : {}),
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
        <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
          {(['bill', 'reminder'] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setForm(f => ({ ...f, kind: k }))}
              className={`flex-1 px-3 py-1.5 text-sm rounded-md capitalize transition-colors ${
                form.kind === k
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                  : 'text-zinc-500 dark:text-zinc-400'
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
        {/* Auto — reminders tick themselves off on the due date; recurring bills
            auto-pay and roll forward. Hidden for a one-off bill (nothing to auto). */}
        {(isReminder || form.is_recurring) && (
          <div>
            <Toggle
              label={isReminder ? '⚡ Auto-complete when due' : '⚡ Auto-pay when due'}
              checked={form.auto_pay}
              onChange={v => setForm(f => ({ ...f, auto_pay: v }))}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              {isReminder
                ? (form.is_recurring
                    ? 'Ticks itself off on the due date and rolls to the next one — never goes overdue.'
                    : 'Ticks itself off automatically once the due date arrives.')
                : 'Marks itself paid on the due date and rolls to the next one — never goes overdue.'}
            </p>
          </div>
        )}
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          options={[{ value: '', label: 'Uncategorised' }, ...BILL_CATEGORIES.map(c => ({ value: c, label: c }))]}
        />
        {/* Phase 7.2 — the member responsible for a shared bill. Only offered once
            the bill is shared (the Sharing panel below is where that happens), and
            purely an attribution: it decides whose column the bill counts in and
            who it nags — never who CAN pay it, which any editing member may. */}
        {respMembers.length > 0 && (
          <div>
            <Select
              label="Responsible member"
              value={form.responsible}
              onChange={e => setForm(f => ({ ...f, responsible: e.target.value }))}
              options={[
                { value: '', label: 'Nobody in particular' },
                ...respMembers.map(m => ({ value: m.userId, label: m.label })),
              ]}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Shows on the bill for the whole household. Anyone who can edit shared
              money can still mark it paid.
            </p>
          </div>
        )}
        {/* Pay-from account — bills only. When set, ticking the bill paid records a
            matching transaction on this account/card and moves its balance; a later
            bank/statement import of the same payment reconciles against it. Hidden
            accounts are excluded (consistent with the rest of the app). */}
        {!isReminder && (
          <div>
            <Select label="Pay from account (optional)" value={form.payFrom} onChange={e => setForm(f => ({ ...f, payFrom: e.target.value }))}
              options={[
                { value: '', label: "Don't record a transaction" },
                ...accounts.filter(a => !a.hidden).map(a => ({ value: `bank:${a.id}`, label: a.name })),
                ...creditCards.map(c => ({ value: `card:${c.id}`, label: `${c.name} (card)` })),
              ]}
            />
            {form.payFrom && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Marking this paid records a transaction here and updates the balance. Undo restores it.
              </p>
            )}
          </div>
        )}
        <Select label="Colour" value={form.colour} onChange={e => setForm(f => ({ ...f, colour: e.target.value as 'grey' | 'yellow' | 'red' }))}
          options={[{ value: 'grey', label: 'Grey (default)' }, { value: 'yellow', label: 'Yellow/orange (needs attention)' }, { value: 'red', label: 'Red (urgent)' }]}
        />
        <Input
          label="Show this many days before due (optional)"
          type="number" min="0" inputMode="numeric"
          value={form.lead_days}
          onChange={e => setForm(f => ({ ...f, lead_days: e.target.value }))}
          placeholder="Leave blank to use the default"
        />

        {/* Telegram reminders — standalone messages at each chosen date + time */}
        <div className="space-y-2 pt-1 border-t border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center justify-between pt-2">
            <label className="text-sm font-medium">🔔 Telegram reminders</label>
            <button type="button" onClick={addReminder} className="text-sm text-brand hover:underline">+ Add reminder</button>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Get a Telegram message at each date &amp; time you set.
            {form.is_recurring && ' These repeat for every future payment.'}
          </p>
          {reminders.length === 0 ? (
            <p className="text-xs text-zinc-400 dark:text-[#666]">No reminders yet.</p>
          ) : (
            reminders.map(r => (
              <div key={r.id} className="flex items-center gap-2">
                <input
                  type="date"
                  value={r.date}
                  onChange={e => updateReminder(r.id, { date: e.target.value })}
                  className="flex-1 min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
                />
                <input
                  type="time"
                  value={r.time}
                  onChange={e => updateReminder(r.id, { time: e.target.value })}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeReminder(r.id)}
                  className="text-[#ef4444] hover:opacity-70 px-1 text-lg leading-none"
                  title="Remove reminder"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        {/* Phase 7.2 — sharing, the same panel every shareable row carries. Only
            for a bill that already exists: sharing stamps the join beside the
            row, so there has to be a row. */}
        {editing && (
          <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <SharePanel kind="bill" id={editing.id} noun="this bill" />
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save' : title}</Button>
        </div>
      </form>
    </Modal>
  );
}
