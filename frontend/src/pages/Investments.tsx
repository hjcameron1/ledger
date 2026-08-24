import { useState, useEffect, useRef, useMemo } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import { useSearchParams, Link } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { investmentsDS, superDS, salesDS, cgtDS, parseDocument, householdContext, currentScope } from '../services/dataService';
import { useScopeKey } from '../hooks/useScopeKey';
import { payrollApi, API_BASE, investmentsApi } from '../services/api';
import SMSFSection from './SMSFSection';
import PropertySection from './PropertySection';
import { formatCurrency, formatPercent, colorForChange, formatTimestamp, formatDate } from '../utils/format';
import { investmentPlansApi } from '../services/api';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import SharePanel from '../components/common/SharePanel';
import LinkedDocuments from '../components/common/LinkedDocuments';
import SharedBadge from '../components/common/SharedBadge';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import type { InvestmentSale, Investment, Subscription } from '../types';
import { Doughnut, Line } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, LineElement, PointElement, LinearScale, Filler } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend, LineElement, PointElement, LinearScale, Filler);

const MARKETS = [
  'ASX', 'NYSE', 'NASDAQ', 'LSE', 'TSX',
  'XETRA', 'Euronext Paris', 'Euronext Amsterdam', 'SIX', 'JPX', 'HKEX', 'NSE',
  'Crypto', 'Managed Fund', 'Physical Precious Metals',
  'Private Investment', 'Other',
];
const METALS = ['Gold', 'Silver', 'Copper', 'Platinum'];
const UNIT_ABBR: Record<string, string> = { grams: 'g', ounces: 'oz', kg: 'kg' };
const METAL_FORMS = [
  { value: 'minted_bar', label: 'Minted bar' },
  { value: 'cast_bar', label: 'Cast bar' },
  { value: 'coin', label: 'Coin' },
  { value: 'round', label: 'Round' },
  { value: 'bullion', label: 'Bullion / other' },
];
const METAL_FORM_LABEL: Record<string, string> = Object.fromEntries(METAL_FORMS.map(f => [f.value, f.label]));
// Common AU mints / brands as a fixed dropdown so casing/spelling stays consistent.
const METAL_MINTS = [
  'Perth Mint',
  'ABC Bullion',
  'Ainslie Bullion',
  'Royal Australian Mint',
  'PAMP',
  'Scottsdale Mint',
  'Royal Canadian Mint',
  'Other',
];

interface MetalProduct {
  id: string;
  dealer: string;
  metal: string;
  form: string | null;
  weight_grams: number | null;
  unit_label: string | null;
  product_name: string;
  url: string;
  buy_price: number | null;
  sell_price: number | null;
  spot_value: number | null;
  currency: string;
  in_stock: boolean;
}
const ASSET_COLORS: Record<string, string> = {
  stock: '#3b7dd8', etf: '#22c55e', crypto: '#f59e0b',
  precious_metal: '#ef4444', managed_fund: '#8b5cf6',
  private: '#6b7280', other: '#9ca3af',
  bond: '#0ea5e9', art: '#ec4899', wine: '#9f1239', jewellery: '#14b8a6',
  cash: '#64748b',
};

// The first dropdown in the Add modal: the asset CATEGORY the user is recording.
// 'market'-backed categories (stocks/etf, crypto, metals, managed fund, private,
// other) drive the existing flows; the collectible categories (bond/art/wine/
// jewellery) render their own purpose-built forms and reuse shares_owned×current_price
// for valuation so portfolio/net-worth math is unchanged.
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'stocks_etf',      label: "Stocks / ETF's" },
  { value: 'crypto',          label: 'Crypto' },
  { value: 'bond',            label: 'Bonds' },
  { value: 'precious_metals', label: 'Precious Metals' },
  { value: 'art',             label: 'Art' },
  { value: 'wine',            label: 'Wine' },
  { value: 'jewellery',       label: 'Jewellery' },
  { value: 'managed_fund',    label: 'Managed Fund' },
  { value: 'private',         label: 'Private Investment' },
  { value: 'cash',            label: 'Cash' },
  { value: 'other',           label: 'Other' },
];
// Stock/ETF markets shown in the second dropdown once that category is chosen.
const STOCK_MARKETS = [
  'ASX', 'NYSE', 'NASDAQ', 'LSE', 'TSX',
  'XETRA', 'Euronext Paris', 'Euronext Amsterdam', 'SIX', 'JPX', 'HKEX', 'NSE', 'Other',
];
const COLLECTIBLE_CATEGORIES = new Set(['bond', 'art', 'wine', 'jewellery']);

// Australian financial year runs 1 Jul → 30 Jun. The start year is the calendar year
// for July–December dates, else the previous year.
function fyStartYear(d: Date): number {
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}
function fyLabelFor(dateStr: string): string {
  if (!dateStr) return '';
  const sy = fyStartYear(new Date(dateStr));
  return `${sy}–${String(sy + 1).slice(2)}`;
}

type Tab = 'Investments' | 'Property' | 'Watchlist' | 'Super' | 'SMSF';

// Property lives here rather than in its own sidebar tab: a house is an asset
// class alongside shares and super, and net worth already treats it as one.
const TABS: Tab[] = ['Investments', 'Property', 'Watchlist', 'Super', 'SMSF'];

// ── Shared types ────────────────────────────────────────────────────────────

interface TickerResult {
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  typeDisplay: string;
}

interface ParsedHolding {
  ticker: string;
  name: string;
  market: string;
  asset_type: string;
  currency: string;
  shares_owned: number;
  cost_basis: number;
  current_value: number | null;
  current_price: number | null;
  details?: Record<string, unknown> | null;
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function Investments() {
  const { user, investments: allInvestments, setInvestments, setPortfolioTotal, superFunds, setSuperFunds, investmentsNextUpdate } = useStore();
  const scopeKey = useScopeKey();
  // The store holds the visible SUPERSET (own + household-shared + granted).
  // The page renders the current scope: your holdings on Personal, the
  // household's shared ones on Household. Same rule as accounts, so a holding
  // shared with you never shows up as yours or joins your totals.
  // Scope FIRST, enrich SECOND (getAll does exactly that). Enriching recomputes
  // display_value from shares × price × rate, so the order is load-bearing twice
  // over: a household overlay's edited price actually moves the shown value
  // (enriching before the overlay merge left the old value baked in), and your
  // own just-saved price edit shows its new value immediately instead of waiting
  // for the next server round-trip.
  const investments = useMemo(
    () => investmentsDS.getAll().investments,
    [allInvestments, scopeKey],
  );
  // The total the page shows is the total OF WHAT IT SHOWS. The store's figure
  // was computed for whatever scope was active when it was last set; deriving
  // it here keeps the headline honest the instant the scope switch flips.
  const portfolioTotal = useMemo(
    () => investments.reduce((sum, i) => sum + (i.display_value ?? 0), 0),
    [investments],
  );
  // Phase 5.4 — disposals live in the store now, so this page and the Tax page
  // read one list and can never show two different capital gains.
  const sales = useStore(s => s.investmentSales);
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Investments');
  const [addOpen, setAddOpen] = useState(false);
  const [addSuperOpen, setAddSuperOpen] = useState(false);
  const [editInv, setEditInv] = useState<typeof investments[0] | null>(null);
  const [sellInv, setSellInv] = useState<typeof investments[0] | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [editCash, setEditCash] = useState<typeof investments[0] | null>(null);
  // Same-named cash entries render as one combined row; this tracks which of
  // those rows are expanded to show their per-entry breakdown.
  const [openCashGroups, setOpenCashGroups] = useState<Record<string, boolean>>({});
  // Sequential import: parsed holdings reviewed one at a time in the Add modal.
  const [importQueue, setImportQueue] = useState<ParsedHolding[]>([]);
  const [queueIdx, setQueueIdx] = useState(0);
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  type PlPoint = { recorded_at: string; pl_percent: number };
  const [plTimeframe, setPlTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>('weekly');
  const [plHistory, setPlHistory] = useState<PlPoint[]>([]);

  const currency = user?.currency_preference ?? 'AUD';

  useEffect(() => {
    const { all, portfolio_total } = investmentsDS.enrichAll();
    setInvestments(all);
    setPortfolioTotal(portfolio_total);
  }, []); // eslint-disable-line

  useEffect(() => {
    const add = searchParams.get('add');
    if (add === 'investment') setAddOpen(true);
    if (add === 'super') { setActiveTab('Super'); setAddSuperOpen(true); }
    // ?tab=Property is how the old /property route (and the sync-failure
    // notification) still lands the user on the right tab. Matched case-insensitively
    // so a hand-typed ?tab=property works too.
    const tab = searchParams.get('tab');
    if (tab) {
      const match = TABS.find(t => t.toLowerCase() === tab.toLowerCase());
      if (match) setActiveTab(match);
    }
  }, [searchParams]);

  // P&L is summed from each holding's preferred-currency profit_loss (computed in
  // dataService.getAll as value-in-preferred minus cost-in-preferred, honouring the
  // currency each cost was entered in). Total cost = total value − total P&L.
  const totalPL = investments.reduce((s, i) => s + (i.verification?.profit_loss ?? 0), 0);
  // Cash carries no gain and shouldn't dilute the return %, so it's excluded from
  // the cost base. cashTotal is its display value (which equals its cost).
  const cashTotal = investments
    .filter(i => i.asset_type === 'cash')
    .reduce((s, i) => s + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0);
  const totalCostBasis = portfolioTotal - totalPL - cashTotal;
  const totalPLPct = totalCostBasis > 0 ? (totalPL / totalCostBasis) * 100 : 0;

  // P&L % trend history. Forward-only: the backend records snapshots hourly and
  // on page load. We always append the live current % so the line ends "now".
  useEffect(() => {
    if (investments.length === 0) { setPlHistory([]); return; }
    investmentsApi.getPlHistory(plTimeframe)
      .then(r => setPlHistory(r.points ?? []))
      .catch(() => setPlHistory([]));
  }, [plTimeframe, investments.length]); // eslint-disable-line

  const DAY_MS = 24 * 60 * 60 * 1000;
  const TF_WINDOW: Record<string, number> = {
    daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS, yearly: 365 * DAY_MS,
  };
  const TF_LABELS: { key: typeof plTimeframe; label: string }[] = [
    { key: 'daily', label: 'Daily' }, { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' }, { key: 'yearly', label: 'Yearly' },
    { key: 'all', label: 'All time' },
  ];

  // Build {x: epoch ms, y: %} points, then append the live reading so the chart
  // always reflects the current +/-% even before the next snapshot is taken.
  const nowMs = Date.now();
  const plPoints = plHistory.map(p => ({ x: new Date(p.recorded_at).getTime(), y: p.pl_percent }));
  if (investments.length > 0) {
    const last = plPoints[plPoints.length - 1];
    if (!last || nowMs - last.x > 60 * 1000) {
      plPoints.push({ x: nowMs, y: parseFloat(totalPLPct.toFixed(4)) });
    } else {
      last.y = parseFloat(totalPLPct.toFixed(4)); // refresh the latest point to live value
    }
  }
  // Fixed axis window → the line fills only the portion we have data for
  // (e.g. 4 days of a 7-day weekly view occupies 4/7ths). All-time spans
  // earliest point → now.
  const win = TF_WINDOW[plTimeframe];
  const axisMin = win ? nowMs - win : (plPoints.length ? plPoints[0].x : nowMs - DAY_MS);
  const axisMax = nowMs;
  const plUp = (plPoints[plPoints.length - 1]?.y ?? totalPLPct) >= 0;
  const plLineColor = plUp ? '#22c55e' : '#ef4444';

  const plChartData = {
    datasets: [{
      data: plPoints,
      borderColor: plLineColor,
      backgroundColor: (ctx: { chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } } }) => {
        const area = ctx.chart.chartArea;
        if (!area) return plUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, plUp ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      },
      borderWidth: 2,
      pointRadius: plPoints.length <= 60 ? 2 : 0,
      pointHoverRadius: 4,
      tension: 0.25,
      fill: true,
    }],
  };

  const fmtTick = (ms: number) => {
    const d = new Date(ms);
    if (plTimeframe === 'daily') return `${d.getHours().toString().padStart(2, '0')}:00`;
    if (plTimeframe === 'yearly' || plTimeframe === 'all') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  const plChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: { parsed: { x: number | null } }[]) => {
            const d = new Date(items[0].parsed.x ?? 0);
            return plTimeframe === 'daily'
              ? d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
              : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          },
          label: (item: { parsed: { y: number | null } }) => `${(item.parsed.y ?? 0) >= 0 ? '+' : ''}${(item.parsed.y ?? 0).toFixed(2)}%`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear' as const,
        min: axisMin,
        max: axisMax,
        ticks: {
          maxTicksLimit: 6,
          callback: (v: string | number) => fmtTick(Number(v)),
          color: '#9ca3af',
          font: { size: 10 },
        },
        grid: { display: false },
      },
      y: {
        ticks: {
          callback: (v: string | number) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`,
          color: '#9ca3af',
          font: { size: 10 },
        },
        grid: { color: 'rgba(128,128,128,0.12)' },
      },
    },
  };

  // Price-freshness disclaimer. Prices (and the FX snapshot) only refresh while
  // each holding's market is open, then freeze until its next session. The
  // backend computes the soonest next refresh (next market open, or the next
  // hourly tick for anything currently trading) and returns it as next_update.
  const priceFreshness = (() => {
    if (investments.length === 0) return null;
    const stamps = investments
      .map(i => i.last_price_update)
      .filter((s): s is string => !!s)
      .map(s => new Date(s).getTime());
    const newest = stamps.length ? Math.max(...stamps) : null;
    const now = new Date();

    const fmtSince = (ms: number) => {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      if (h === 0 && m <= 1) return 'just now';
      if (h === 0) return `${m} min ago`;
      if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
      const d = Math.round(h / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    };
    const fmtUntil = (ms: number) => {
      const mins = Math.round(ms / 60_000);
      if (mins <= 1) return 'any moment';
      if (mins < 60) return `in ${mins} min`;
      const h = Math.round(mins / 60);
      if (h < 24) return `in ${h} hour${h === 1 ? '' : 's'}`;
      // Far out (market closed for the weekend / holiday) — show the day/time.
      return new Date(now.getTime() + ms).toLocaleString('en-AU', {
        weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
      });
    };

    const nextMs = investmentsNextUpdate ? new Date(investmentsNextUpdate).getTime() - now.getTime() : null;
    return {
      since: newest != null ? fmtSince(now.getTime() - newest) : null,
      until: nextMs != null && nextMs > 0 ? fmtUntil(nextMs) : null,
    };
  })();

  const byType = investments.reduce((acc, inv) => {
    acc[inv.asset_type] = (acc[inv.asset_type] ?? 0) + (inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1));
    return acc;
  }, {} as Record<string, number>);

  const sectorKeys = Object.keys(byType);
  const donutData = {
    labels: sectorKeys.map(k => k.replace('_', ' ')),
    datasets: [{
      data: Object.values(byType),
      backgroundColor: sectorKeys.map(k =>
        selectedSector && k !== selectedSector ? '#d4d4d4' : (ASSET_COLORS[k] ?? '#9ca3af')),
      borderWidth: 0,
    }],
  };

  // Aggregated stats for a single asset-type sector (value, cost, P&L, %).
  const sectorStats = (type: string) => {
    const holdings = investments.filter(i => i.asset_type === type);
    const value = holdings.reduce((s, inv) => s + (inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1)), 0);
    const pl = holdings.reduce((s, inv) => s + (inv.verification?.profit_loss ?? 0), 0);
    const cost = holdings.reduce((s, inv) => s + (inv.display_cost ?? ((inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1)) - (inv.verification?.profit_loss ?? 0))), 0);
    const plPct = cost > 0 ? (pl / cost) * 100 : 0;
    const pctOfPortfolio = portfolioTotal > 0 ? (value / portfolioTotal) * 100 : 0;
    return { holdings, value, cost, pl, plPct, pctOfPortfolio };
  };

  // Cash is a normal asset class: it appears in the allocation split and under
  // Holdings alongside everything else (with a cash-specific card layout).
  const grouped = investments.reduce((acc, inv) => {
    if (!acc[inv.asset_type]) acc[inv.asset_type] = [];
    acc[inv.asset_type].push(inv);
    return acc;
  }, {} as Record<string, typeof investments>);

  const refreshInvestments = () => {
    const { all, portfolio_total } = investmentsDS.enrichAll();
    setInvestments(all);
    setPortfolioTotal(portfolio_total);
  };

  const addInvestment = (data: object) => {
    investmentsDS.add(data as Parameters<typeof investmentsDS.add>[0]);
    refreshInvestments();
  };

  // Load recorded disposals (for the realised-gains / CGT panel).
  useEffect(() => {
    let cancelled = false;
    investmentsApi.getSales()
      .then((d: { sales?: InvestmentSale[] }) => { if (!cancelled) salesDS.load(d.sales ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Sell part or all of a holding: log the disposal + reduce/remove the holding.
  const handleSell = (inv: typeof investments[0], input: {
    quantity: number; proceeds: number; fees: number; sale_date: string; acquired_date: string;
  }) => {
    const origQty = inv.shares_owned || 0;
    const qty = Math.min(input.quantity, origQty) || origQty;
    const fraction = origQty > 0 ? qty / origQty : 1;
    // Cost attributed to the sold units, in the preferred currency.
    const totalCostPref = inv.display_cost ?? inv.cost_basis;
    const costSold = parseFloat((totalCostPref * fraction).toFixed(2));

    salesDS.record({
      investment_id: inv.id,
      name: inv.name,
      ticker: inv.ticker ?? null,
      asset_type: inv.asset_type,
      market: inv.market,
      quantity: qty,
      proceeds: input.proceeds,
      fees: input.fees,
      cost_basis: costSold,
      acquired_date: input.acquired_date || null,
      sale_date: input.sale_date,
      currency,
    });

    // Reduce the holding (or remove it on a full sale). Cost basis is scaled in the
    // currency it's stored in, so no FX needed.
    if (qty >= origQty - 1e-9) {
      investmentsDS.remove(inv.id, true); // sold → keep it on the P&L history line
    } else {
      investmentsDS.update(inv.id, {
        shares_owned: parseFloat((origQty - qty).toFixed(8)),
        cost_basis: parseFloat((inv.cost_basis * (1 - fraction)).toFixed(2)),
      });
    }
    refreshInvestments();
    setSellInv(null);
  };

  // Advance the sequential-import queue after one holding has been added (or close
  // the Add modal when the queue is exhausted / there was no queue).
  const advanceImportQueue = () => {
    if (!importQueue.length) { setAddOpen(false); return; }
    const next = queueIdx + 1;
    if (next < importQueue.length) { setQueueIdx(next); }
    else { setImportQueue([]); setQueueIdx(0); setAddOpen(false); }
  };

  const cancelImportQueue = () => { setImportQueue([]); setQueueIdx(0); setAddOpen(false); };

  return (
    <Layout>
      <PageHeader title="Investments" />

      {/* Tabs */}
      <div className="flex border-b border-zinc-200 dark:border-zinc-800 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0">
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`shrink-0 px-4 sm:px-6 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 ${activeTab === tab ? 'text-brand border-brand' : 'text-zinc-500 dark:text-zinc-400 border-transparent'}`}>
            {tab}
          </button>
        ))}
      </div>

      {/* ── INVESTMENTS TAB ── */}
      {activeTab === 'Investments' && (
        <div>
          {/* Price freshness disclaimer */}
          {priceFreshness && (priceFreshness.since || priceFreshness.until) && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] flex-shrink-0" />
              {priceFreshness.since && `Prices as of ${priceFreshness.since}`}
              {priceFreshness.since && priceFreshness.until && ' · '}
              {priceFreshness.until && `updating ${priceFreshness.until}`}
            </p>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <Card>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Portfolio Value</p>
              <p className="text-2xl font-semibold amount mt-1">{formatCurrency(portfolioTotal, currency)}</p>
            </Card>
            <Card>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Total P&amp;L</p>
              <p className={`text-2xl font-semibold amount mt-1 ${colorForChange(totalPL)}`}>
                {totalPL >= 0 ? '+' : ''}{formatCurrency(totalPL, currency)}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Total Return</p>
              <p className={`text-2xl font-semibold mt-1 ${colorForChange(totalPLPct)}`}>{formatPercent(totalPLPct)}</p>
            </Card>
          </div>

          {/* P&L % trend */}
          {investments.length > 0 && (
            <Card className="mb-6">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
                <div>
                  <h3 className="font-medium">Return over time</h3>
                  <p className={`text-2xl font-semibold mt-0.5 ${colorForChange(totalPLPct)}`}>{formatPercent(totalPLPct)}</p>
                </div>
                <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
                  {TF_LABELS.map(tf => (
                    <button
                      key={tf.key}
                      onClick={() => setPlTimeframe(tf.key)}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                        plTimeframe === tf.key
                          ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                          : 'text-zinc-500 dark:text-zinc-400'
                      }`}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-56">
                {plPoints.length > 0 ? (
                  <Line data={plChartData} options={plChartOptions} />
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
                    No history yet — your return will be tracked from today.
                  </div>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 mt-2">
                Tracked from when you added your holdings. Shorter than the selected period? The line fills only the time you've held.
              </p>
            </Card>
          )}

          {/* Donut chart */}
          {investments.length > 0 && (
            <Card className="mb-6">
              <h3 className="font-medium mb-4">Portfolio Allocation</h3>
              <div className="flex items-start gap-6 flex-wrap">
                <div className="w-32 h-32 flex-shrink-0">
                  <Doughnut
                    data={donutData}
                    options={{
                      responsive: true, maintainAspectRatio: true, cutout: '65%',
                      plugins: { legend: { display: false } },
                      onClick: (_evt, els) => {
                        if (!els.length) return;
                        const key = sectorKeys[els[0].index];
                        setSelectedSector(prev => (prev === key ? null : key));
                      },
                      onHover: (evt, els) => {
                        const t = evt.native?.target as HTMLElement | undefined;
                        if (t) t.style.cursor = els.length ? 'pointer' : 'default';
                      },
                    }}
                  />
                </div>

                {selectedSector ? (
                  (() => {
                    const s = sectorStats(selectedSector);
                    return (
                      <div className="flex-1 min-w-[220px]">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ASSET_COLORS[selectedSector] ?? '#9ca3af' }} />
                            <h4 className="text-sm font-semibold capitalize">{selectedSector.replace('_', ' ')}</h4>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">({s.pctOfPortfolio.toFixed(1)}% of portfolio)</span>
                          </div>
                          <button onClick={() => setSelectedSector(null)} className="text-xs text-brand hover:underline">✕ Close</button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Value</p>
                            <p className="text-sm font-semibold amount">{formatCurrency(s.value, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Cost</p>
                            <p className="text-sm font-semibold amount">{formatCurrency(s.cost, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">P&amp;L</p>
                            <p className={`text-sm font-semibold amount ${colorForChange(s.pl)}`}>{s.pl >= 0 ? '+' : ''}{formatCurrency(s.pl, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Return</p>
                            <p className={`text-sm font-semibold ${colorForChange(s.plPct)}`}>{formatPercent(s.plPct)}</p>
                          </div>
                        </div>
                        <div className="space-y-1 border-t border-zinc-200 dark:border-zinc-800 pt-2">
                          {s.holdings.map(inv => {
                            const rate = inv.conversion_rate ?? 1;
                            const val = inv.display_value ?? (inv.current_value * rate);
                            const plPct = inv.verification?.profit_loss_percent ?? 0;
                            return (
                              <div key={inv.id} className="flex items-center justify-between text-xs">
                                <span className="font-medium truncate mr-2">{inv.ticker ?? inv.name}</span>
                                <span className="flex items-center gap-2 flex-shrink-0">
                                  <span className="amount">{formatCurrency(val, currency)}</span>
                                  <span className={`amount ${colorForChange(plPct)}`}>{formatPercent(plPct)}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {Object.entries(byType).map(([type, value]) => (
                      <button key={type} onClick={() => setSelectedSector(type)} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ASSET_COLORS[type] ?? '#9ca3af' }} />
                        <span className="text-xs capitalize text-zinc-500 dark:text-zinc-400">
                          {type.replace('_', ' ')} ({portfolioTotal > 0 ? Math.round((value / portfolioTotal) * 100) : 0}%)
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Holdings list header */}
          <div className="flex justify-between items-center gap-2 flex-wrap mb-4">
            <h2 className="font-semibold">Holdings ({investments.length})</h2>
            <div className="flex flex-wrap gap-2 justify-end">
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                📂 Import Portfolio
              </Button>
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Investment</Button>
            </div>
          </div>

          {investments.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📈</div>
              <h3 className="font-medium mb-1">No investments yet</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                Add individual holdings or import a portfolio from your broker.
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>📂 Import Portfolio</Button>
                <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Investment</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(grouped).map(([type, holdings]) => (
                <div key={type}>
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-2 capitalize">
                    {type.replace('_', ' ')}
                  </h3>
                  <div className="space-y-2">
                    {/* Cash is a balance, not a priced security — no shares, price,
                        P&L or Sell action. Same-named entries (case-insensitive) are
                        one pot held in different places, so they render as ONE row
                        with a click-to-expand breakdown; distinct names ("Buying
                        Power 1" vs "Buying Power 2") stay separate rows. */}
                    {type === 'cash' ? (() => {
                      const cashGroups = new Map<string, typeof holdings>();
                      holdings.forEach(inv => {
                        const key = (inv.name || 'Cash').trim().toLowerCase();
                        const list = cashGroups.get(key);
                        if (list) list.push(inv); else cashGroups.set(key, [inv]);
                      });
                      return [...cashGroups.entries()].map(([key, entries]) => {
                        if (entries.length === 1) {
                          const inv = entries[0];
                          const rate = inv.conversion_rate ?? 1;
                          const val = inv.display_value ?? (inv.current_value * rate);
                          return (
                            <Card key={inv.id}>
                              <div className="flex items-center justify-between">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h4 className="font-medium truncate">{inv.name || 'Cash'}</h4>
                                    <SharedBadge row={inv} />
                                  </div>
                                  {inv.native_currency && inv.native_currency !== currency && (
                                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                      {formatCurrency(inv.current_price, inv.native_currency)} @ {rate.toFixed(4)}
                                    </p>
                                  )}
                                </div>
                                <div className="flex items-center gap-4 flex-shrink-0">
                                  <p className="font-semibold amount">{formatCurrency(val, currency)}</p>
                                  <div className="flex gap-3 text-xs">
                                    <button onClick={() => setEditCash(inv)} className="text-brand hover:underline">Edit</button>
                                    <button onClick={() => setDeleteId(inv.id)} className="text-zinc-500 hover:text-[#ef4444]">Remove</button>
                                  </div>
                                </div>
                              </div>
                            </Card>
                          );
                        }
                        const groupVal = entries.reduce((s, i) => s + (i.display_value ?? (i.current_value * (i.conversion_rate ?? 1))), 0);
                        const open = !!openCashGroups[key];
                        return (
                          <Card key={key}>
                            <button
                              type="button"
                              className="w-full flex items-center justify-between gap-3 text-left"
                              onClick={() => setOpenCashGroups(g => ({ ...g, [key]: !g[key] }))}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <h4 className="font-medium truncate">{entries[0].name || 'Cash'}</h4>
                                <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">{entries.length} entries</span>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <p className="font-semibold amount">{formatCurrency(groupVal, currency)}</p>
                                <span className={`text-xs text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
                              </div>
                            </button>
                            {open && (
                              <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
                                {entries.map(inv => {
                                  const rate = inv.conversion_rate ?? 1;
                                  const val = inv.display_value ?? (inv.current_value * rate);
                                  return (
                                    <div key={inv.id} className="flex items-center justify-between gap-3">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-sm truncate">{inv.name || 'Cash'}</span>
                                        <SharedBadge row={inv} />
                                        {inv.native_currency && inv.native_currency !== currency && (
                                          <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">
                                            {formatCurrency(inv.current_price, inv.native_currency)} @ {rate.toFixed(4)}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-4 flex-shrink-0">
                                        <span className="text-sm font-medium amount">{formatCurrency(val, currency)}</span>
                                        <div className="flex gap-3 text-xs">
                                          <button onClick={() => setEditCash(inv)} className="text-brand hover:underline">Edit</button>
                                          <button onClick={() => setDeleteId(inv.id)} className="text-zinc-500 hover:text-[#ef4444]">Remove</button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </Card>
                        );
                      });
                    })() : holdings.map(inv => {
                      // All display figures are already in the preferred currency
                      // (computed in dataService.getAll / the backend). P&L and cost
                      // are NOT re-multiplied by the FX rate here — doing so was the
                      // old bug. Only the per-unit price is shown in native too.
                      const rate = inv.conversion_rate ?? 1;
                      const val = inv.display_value ?? (inv.current_value * rate);

                      const pl = inv.verification?.profit_loss ?? 0;
                      const plPct = inv.verification?.profit_loss_percent ?? 0;
                      const dayChange = inv.verification?.day_change ?? null;
                      const dayPct = inv.verification?.day_change_percent ?? null;
                      const cost = inv.display_cost ?? (val - pl);
                      const priceDisplay = inv.current_price * rate;
                      return (
                        <Card key={inv.id}>
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h4 className="font-medium">{inv.ticker ?? inv.name}</h4>
                                {inv.ticker && inv.name !== inv.ticker && <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{inv.name}</span>}
                                {inv.is_dividend_paying && <span className="badge bg-brand/10 text-brand text-[10px]">DIV</span>}
                                <SharedBadge row={inv} />
                                {inv.verification && !inv.verification.is_verified && <span className="badge bg-[#f59e0b]/10 text-[#f59e0b] text-[10px]">⚠ Verify</span>}
                              </div>
                              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                {inv.market} · {inv.shares_owned} {inv.asset_type === 'crypto' ? 'units' : inv.asset_type === 'precious_metal' ? (UNIT_ABBR[inv.metal_unit ?? 'grams'] ?? 'g') : 'shares'} · Cost: {formatCurrency(cost, currency)}
                              </p>
                            </div>
                            <div className="text-right ml-4 flex-shrink-0">
                              <p className="font-semibold amount">{formatCurrency(val, currency)}</p>
                              <p className={`text-sm amount ${colorForChange(pl)}`}>
                                {pl >= 0 ? '+' : ''}{formatCurrency(pl, currency)} ({formatPercent(plPct)})
                              </p>
                              <p className="text-[11px] amount text-zinc-500 dark:text-zinc-400">
                                Today:{' '}
                                {dayPct != null ? (
                                  <span className={colorForChange(dayChange ?? 0)}>
                                    {(dayChange ?? 0) >= 0 ? '+' : ''}{formatCurrency(dayChange ?? 0, currency)} ({formatPercent(dayPct)})
                                  </span>
                                ) : (
                                  <span>—</span>
                                )}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">
                              {inv.current_price > 0 && `Price: ${formatCurrency(priceDisplay, currency)}`}
                              {inv.current_price > 0 && rate !== 1 &&
                                ` (${formatCurrency(inv.current_price, inv.native_currency)} @ ${rate.toFixed(4)})`}
                              {inv.last_price_update && ` · As of ${formatTimestamp(inv.last_price_update)}`}
                              {inv.current_price === 0 && 'No live price — manual'}
                            </p>
                            <div className="flex gap-3 text-xs">
                              <button onClick={() => setEditInv(inv)} className="text-brand hover:underline">Edit</button>
                              <button onClick={() => setSellInv(inv)} className="text-[#16a34a] hover:underline">Sell</button>
                              <button onClick={() => setDeleteId(inv.id)} className="text-zinc-500 hover:text-[#ef4444]">Remove</button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <RegularInvestments currency={currency} investments={investments} />

          {sales.length > 0 && <RealisedGainsPanel sales={sales} currency={currency} />}
        </div>
      )}

      {/* ── PROPERTY TAB ── */}
      {activeTab === 'Property' && <PropertySection currency={currency} />}

      {/* ── WATCHLIST TAB ── */}
      {activeTab === 'Watchlist' && <WatchlistTab currency={currency} />}

      {/* ── SUPER TAB ── */}
      {activeTab === 'Super' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="font-semibold">Superannuation</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Total: {formatCurrency(superFunds.reduce((s, f) => s + f.balance, 0), currency)}</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setAddSuperOpen(true)}>+ Add Fund</Button>
          </div>
          {superFunds.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">🏦</div>
              <h3 className="font-medium mb-1">No super funds added</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Upload your annual super statement or add manually.</p>
              <Button variant="secondary" size="sm" onClick={() => setAddSuperOpen(true)}>+ Add Super Fund</Button>
            </div>
          ) : (
            <div className="space-y-3">
              {superFunds.map(fund => (
                <Card key={fund.id}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-medium">{fund.fund_name}</h3>
                      {fund.investment_option && <p className="text-xs text-zinc-500 dark:text-zinc-400">{fund.investment_option}</p>}
                      {fund.member_number && <p className="text-xs text-zinc-500 dark:text-zinc-400">Member #{fund.member_number}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">Balance</p>
                      <p className="text-lg font-semibold amount">{formatCurrency(fund.balance, currency)}</p>
                      <button onClick={() => { superDS.remove(fund.id); setSuperFunds(superDS.getAll()); }} className="text-xs text-zinc-500 hover:text-[#ef4444] mt-1">Remove</button>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Contributions this financial year</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">Employer</p>
                        <p className="text-sm font-medium amount">{formatCurrency(fund.employer_contributions, currency)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">Personal</p>
                        <p className="text-sm font-medium amount">{formatCurrency(fund.personal_contributions, currency)}</p>
                      </div>
                      {fund.fees != null && fund.fees > 0 && (
                        <div>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">Fees (this year)</p>
                          <p className="text-sm font-medium amount">{formatCurrency(fund.fees, currency)}</p>
                        </div>
                      )}
                      {fund.insurance_details && (
                        <div className="col-span-2">
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">Insurance</p>
                          <p className="text-sm font-medium">{fund.insurance_details}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">Count toward net worth</span>
                    <Toggle
                      size="sm"
                      checked={fund.include_in_net_worth !== false}
                      onChange={(v) => { superDS.update(fund.id, { include_in_net_worth: v }); setSuperFunds(superDS.getAll()); }}
                    />
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Expected employer super (pending contributions ledger) */}
          <PendingSuperLedger currency={currency} />
        </div>
      )}

      {/* ── SMSF TAB ── */}
      {activeTab === 'SMSF' && <SMSFSection currency={currency} />}

      {/* ── MODALS ── */}
      <AddInvestmentModal
        isOpen={addOpen}
        onClose={cancelImportQueue}
        prefill={importQueue.length ? importQueue[queueIdx] : null}
        queuePosition={importQueue.length ? { index: queueIdx + 1, total: importQueue.length } : null}
        onSave={(data) => {
          addInvestment(data);
          advanceImportQueue();
        }}
      />

      {editInv && (
        <EditInvestmentModal
          inv={editInv}
          onClose={() => setEditInv(null)}
          onSave={(id, data) => {
            investmentsDS.update(id, data);
            refreshInvestments();
            setEditInv(null);
          }}
        />
      )}

      {sellInv && (
        <SellInvestmentModal
          inv={sellInv}
          currency={currency}
          onClose={() => setSellInv(null)}
          onSell={(input) => handleSell(sellInv, input)}
        />
      )}

      <ImportPortfolioModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(holdings) => {
          setImportOpen(false);
          if (!holdings.length) return;
          // Cash balances go straight in (no per-holding review needed); priced
          // securities are handed to the Add modal one at a time for review.
          const cash = holdings.filter(h => h.asset_type === 'cash');
          const securitiesToReview = holdings.filter(h => h.asset_type !== 'cash');
          for (const c of cash) {
            const balance = c.current_value ?? c.current_price ?? 0;
            if (!balance || balance <= 0) continue;
            investmentsDS.add({
              name: c.name || (c.currency === currency ? 'Cash' : `Cash (${c.currency})`),
              market: 'Cash',
              asset_type: 'cash',
              shares_owned: 1,
              current_price: balance,
              cost_basis: balance,
              cost_basis_currency: c.currency,
              native_currency: c.currency,
            });
          }
          if (cash.length) refreshInvestments();
          if (securitiesToReview.length) {
            setImportQueue(securitiesToReview);
            setQueueIdx(0);
            setAddOpen(true);
          }
        }}
      />

      <AddSuperModal
        isOpen={addSuperOpen}
        onClose={() => setAddSuperOpen(false)}
        onSave={(data) => {
          superDS.add(data as Parameters<typeof superDS.add>[0]);
          setSuperFunds(superDS.getAll());
          setAddSuperOpen(false);
        }}
      />

      {editCash && (
        <AddCashModal
          isOpen
          pref={currency}
          existing={editCash}
          onClose={() => setEditCash(null)}
          onSave={(data) => {
            investmentsDS.update(editCash.id, data as Partial<typeof investments[0]>);
            refreshInvestments();
            setEditCash(null);
          }}
        />
      )}

      <Modal isOpen={!!deleteId} onClose={() => setDeleteId(null)} title="Remove Investment" size="sm">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Remove this investment from your portfolio?</p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setDeleteId(null)} fullWidth>Cancel</Button>
          <Button variant="danger" onClick={() => { if (deleteId) { investmentsDS.remove(deleteId); refreshInvestments(); setDeleteId(null); } }} fullWidth>Remove</Button>
        </div>
      </Modal>
    </Layout>
  );
}

// ─── Watchlist Tab ──────────────────────────────────────────────────────────

interface WatchlistItem {
  id: string;
  ticker: string;
  name: string;
  market: string;
  native_currency: string;
  current_price: number | null;
  last_price_update: string | null;
  alert_enabled: boolean;
  target_price: number | null;
  alert_direction: 'above' | 'below' | null;
  alerted: boolean;
  preferred_currency?: string;
  converted_price?: number | null;
  converted_target?: number | null;
  last_hit_at?: string | null;
}

function WatchlistTab({ currency }: { currency: string }) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  const [market, setMarket] = useState('ASX');
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [targetPrice, setTargetPrice] = useState('');
  const [alertDirection, setAlertDirection] = useState<'above' | 'below'>('above');
  const [saving, setSaving] = useState(false);
  const [editItem, setEditItem] = useState<WatchlistItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = () => {
    investmentsApi.getWatchlist()
      .then(d => setItems(d.watchlist ?? []))
      .catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line

  const resetForm = () => {
    setTicker(''); setName(''); setMarket('ASX');
    setAlertEnabled(false); setTargetPrice(''); setAlertDirection('above');
  };

  const handleAdd = async () => {
    if (!ticker) return;
    setSaving(true);
    try {
      await investmentsApi.addToWatchlist({
        ticker, name: name || ticker, market,
        alert_enabled: alertEnabled,
        target_price: alertEnabled && targetPrice ? Number(targetPrice) : null,
        alert_direction: alertEnabled ? alertDirection : null,
      });
      load();
      resetForm();
      setAddOpen(false);
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleUpdateAlert = async () => {
    if (!editItem) return;
    setSaving(true);
    try {
      await investmentsApi.updateWatchlistItem(editItem.id, {
        alert_enabled: alertEnabled,
        target_price: alertEnabled && targetPrice ? Number(targetPrice) : null,
        alert_direction: alertEnabled ? alertDirection : null,
      });
      load();
      setEditItem(null);
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    await investmentsApi.removeFromWatchlist(id);
    load();
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="font-semibold">Stock Watchlist</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Monitor stocks and set price alerts</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => { resetForm(); setAddOpen(true); }}>+ Watch Stock</Button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-medium mb-1">No stocks on your watchlist</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Add stocks to monitor their price and get alerts.</p>
          <Button variant="secondary" size="sm" onClick={() => { resetForm(); setAddOpen(true); }}>+ Watch Stock</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => {
            const expanded = expandedId === item.id;
            // Movement needed to reach the target: signed $ and % from current price.
            const price = item.current_price;
            const target = item.target_price;
            const gap = price != null && target != null ? target - price : null;
            const gapPct = gap != null && price ? (gap / price) * 100 : null;
            return (
            <Card key={item.id} className="p-0 overflow-hidden">
              {/* Header row — always stacks cleanly on narrow screens */}
              <button
                onClick={() => setExpandedId(expanded ? null : item.id)}
                className="w-full flex items-center gap-3 p-4 text-left"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{item.ticker}</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">{item.market}</span>
                    {item.alert_enabled && item.target_price != null && (
                      <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${item.alerted ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                        {item.alerted ? '✅ Hit' : `${item.alert_direction === 'above' ? '↑' : '↓'} ${formatCurrency(item.target_price, item.native_currency)}`}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate">{item.name}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-medium tabular-nums">
                    {item.current_price != null ? formatCurrency(item.current_price, item.native_currency) : '—'}
                  </p>
                  {item.converted_price != null && item.preferred_currency && item.native_currency !== item.preferred_currency && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                      ({formatCurrency(item.converted_price, item.preferred_currency)})
                    </p>
                  )}
                  {item.last_price_update && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{formatTimestamp(item.last_price_update)}</p>
                  )}
                </div>
                <span className={`shrink-0 text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
              </button>

              {/* Expandable detail */}
              {expanded && (
                <div className="px-4 pb-4 pt-1 border-t border-zinc-100 dark:border-zinc-800 space-y-2 text-sm">
                  {item.alert_enabled && target != null && gap != null ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-zinc-500 dark:text-zinc-400">Target price</span>
                        <span className="tabular-nums text-right">
                          {formatCurrency(target, item.native_currency)} ({item.alert_direction === 'above' ? 'above' : 'below'})
                          {item.converted_target != null && item.preferred_currency && item.native_currency !== item.preferred_currency && (
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">({formatCurrency(item.converted_target, item.preferred_currency)})</span>
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500 dark:text-zinc-400">Needs to move</span>
                        <span className={`tabular-nums ${gap >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                          {gap >= 0 ? '+' : ''}{formatCurrency(gap, item.native_currency)}{gapPct != null ? ` (${gap >= 0 ? '+' : ''}${gapPct.toFixed(1)}%)` : ''}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500 dark:text-zinc-400">Last hit target</span>
                        <span>{item.last_hit_at ? formatTimestamp(item.last_hit_at) : 'Not since tracking began'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500 dark:text-zinc-400">Status</span>
                        <span>{item.alerted ? 'Target reached — alert sent' : 'Watching for target'}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-zinc-500 dark:text-zinc-400">No price alert set. Tap the pencil to add one.</p>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <Button variant="secondary" size="sm" onClick={() => {
                      setEditItem(item);
                      setAlertEnabled(item.alert_enabled);
                      setTargetPrice(item.target_price?.toString() ?? '');
                      setAlertDirection(item.alert_direction ?? 'above');
                    }}>✏️ Edit alert</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(item.id)}>🗑 Remove</Button>
                  </div>
                </div>
              )}
            </Card>
            );
          })}
        </div>
      )}

      {/* Add to watchlist modal */}
      <Modal isOpen={addOpen} onClose={() => setAddOpen(false)} title="Watch a Stock">
        <div className="space-y-4">
          <Select label="Market" value={market} onChange={e => setMarket(e.target.value)}
            options={MARKETS.filter(m => !['Managed Fund', 'Physical Precious Metals', 'Private Investment', 'Other'].includes(m)).map(m => ({ value: m, label: m }))} />
          <TickerAutocomplete
            value={ticker}
            onChange={setTicker}
            onSelect={r => { setTicker(r.symbol); setName(r.name); setMarket(r.market || market); }}
            market={market}
          />
          {ticker && <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder={ticker} />}
          <div className="flex items-center justify-between">
            <span className="text-sm">Set price alert</span>
            <Toggle checked={alertEnabled} onChange={setAlertEnabled} size="sm" />
          </div>
          {alertEnabled && (
            <div className="flex gap-3">
              <Select label="Direction" value={alertDirection} onChange={e => setAlertDirection(e.target.value as 'above' | 'below')}
                options={[{ value: 'above', label: 'Goes above' }, { value: 'below', label: 'Drops below' }]}
                className="w-40" />
              <Input label="Target price" type="number" value={targetPrice} onChange={e => setTargetPrice(e.target.value)} placeholder="0.00" />
            </div>
          )}
          <Button variant="primary" fullWidth onClick={handleAdd} disabled={!ticker || saving}>
            {saving ? 'Adding…' : 'Add to Watchlist'}
          </Button>
        </div>
      </Modal>

      {/* Edit alert modal */}
      <Modal isOpen={!!editItem} onClose={() => setEditItem(null)} title={`Alert — ${editItem?.ticker ?? ''}`}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">Price alert</span>
            <Toggle checked={alertEnabled} onChange={setAlertEnabled} size="sm" />
          </div>
          {alertEnabled && (
            <div className="flex gap-3">
              <Select label="Direction" value={alertDirection} onChange={e => setAlertDirection(e.target.value as 'above' | 'below')}
                options={[{ value: 'above', label: 'Goes above' }, { value: 'below', label: 'Drops below' }]}
                className="w-40" />
              <Input label="Target price" type="number" value={targetPrice} onChange={e => setTargetPrice(e.target.value)} placeholder="0.00" />
            </div>
          )}
          <Button variant="primary" fullWidth onClick={handleUpdateAlert} disabled={saving}>
            {saving ? 'Saving…' : 'Save Alert'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ─── Ticker Autocomplete ─────────────────────────────────────────────────────

function TickerAutocomplete({
  value,
  onChange,
  onSelect,
  market,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (result: TickerResult, price: number, currency: string) => void;
  market?: string;
  label?: string;
  placeholder?: string;
}) {
  const [results, setResults] = useState<TickerResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (value.length < 1) { setResults([]); setOpen(false); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`${API_BASE}/api/investments/search?q=${encodeURIComponent(value)}${market ? `&market=${encodeURIComponent(market)}` : ''}`);
        if (res.ok) {
          const data = await res.json() as TickerResult[];
          setResults(data);
          setOpen(data.length > 0);
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [value, market]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = async (r: TickerResult) => {
    setOpen(false);
    onChange(r.symbol);
    setFetchingPrice(true);
    try {
      const res = await fetch(`${API_BASE}/api/investments/price/${encodeURIComponent(r.symbol)}?market=${encodeURIComponent(r.market)}`);
      if (res.ok) {
        const { price, currency } = await res.json() as { price: number; currency: string };
        onSelect(r, price || 0, currency || 'AUD');
      } else {
        onSelect(r, 0, 'AUD');
      }
    } catch {
      onSelect(r, 0, 'AUD');
    }
    setFetchingPrice(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Input
          label={label ?? 'Ticker symbol'}
          value={value}
          onChange={e => onChange(e.target.value.toUpperCase())}
          placeholder={placeholder ?? 'e.g. CBA, SPY, BTC'}
        />
        {(searching || fetchingPrice) && (
          <div className="absolute right-3 bottom-3">
            <div className="w-3.5 h-3.5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
      {fetchingPrice && (
        <p className="text-[11px] text-brand mt-0.5">Fetching live price…</p>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[8px] shadow-lg max-h-52 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.symbol}
              type="button"
              className="w-full px-3 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between gap-2 transition-colors border-b border-zinc-100 dark:border-[#222] last:border-0"
              onMouseDown={e => { e.preventDefault(); handleSelect(r); }}
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm">{r.symbol}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-2 truncate">{r.name}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[10px] bg-brand/10 text-brand px-1.5 py-0.5 rounded font-medium">{r.typeDisplay}</span>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{r.market}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add / Edit Cash Modal ───────────────────────────────────────────────────
// Cash is a plain balance (settled cash, buying power) held in a brokerage or
// settlement account. It counts toward Portfolio Value but isn't a priced holding,
// so it's stored as an investment row with asset_type 'cash' (shares_owned 1,
// current_price = balance) and shown in its own section.
const CASH_CURRENCIES = ['AUD', 'USD', 'GBP', 'EUR', 'NZD', 'SGD', 'CAD', 'JPY', 'HKD', 'CHF'];

function AddCashModal({ isOpen, onClose, onSave, pref, existing }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (d: object) => void;
  pref: string;
  existing?: Investment | null;
}) {
  const [label, setLabel] = useState(existing?.name ?? '');
  const [ccy, setCcy] = useState(existing?.native_currency ?? pref);
  const [amount, setAmount] = useState(existing ? String(existing.current_price ?? '') : '');

  // Currencies list always includes the user's preferred currency.
  const currencyOptions = Array.from(new Set([pref, ...CASH_CURRENCIES]));

  const save = async () => {
    const balance = parseFloat(amount);
    if (!isFinite(balance) || balance < 0) return;

    // Snapshot the FX rate so a foreign cash balance shows correct preferred-currency
    // figures immediately (the backend also refreshes it live on every read).
    let conversion_rate = 1;
    if (ccy !== pref) {
      try {
        const r = await fetch(`${API_BASE}/api/investments/fxrate?from=${encodeURIComponent(ccy)}&to=${encodeURIComponent(pref)}`)
          .then(res => (res.ok ? res.json() : null));
        if (r?.rate) conversion_rate = r.rate;
      } catch { /* fall back to 1 */ }
    }

    onSave({
      name: label.trim() || (ccy === pref ? 'Cash' : `Cash (${ccy})`),
      market: 'Cash',
      asset_type: 'cash',
      shares_owned: 1,
      current_price: balance,
      cost_basis: balance,
      cost_basis_currency: ccy,
      native_currency: ccy,
      conversion_rate,
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={existing ? 'Edit cash' : 'Add cash'} size="sm">
      <div className="space-y-4">
        <Input
          label="Label (optional)"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Settled cash, Buying power"
        />
        <div className="grid grid-cols-3 gap-3">
          <Select
            label="Currency"
            value={ccy}
            onChange={e => setCcy(e.target.value)}
            options={currencyOptions.map(c => ({ value: c, label: c }))}
          />
          <div className="col-span-2">
            <Input
              label="Balance"
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Counts toward your Portfolio Value. Cash has no gain or loss, so it's kept out of your return %.
        </p>
        <div className="flex gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} fullWidth>Cancel</Button>
          <Button variant="primary" onClick={save} fullWidth disabled={!amount}>
            {existing ? 'Save' : 'Add cash'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Add Investment Modal ────────────────────────────────────────────────────

function AddInvestmentModal({ isOpen, onClose, onSave, prefill, queuePosition }: {
  isOpen: boolean; onClose: () => void; onSave: (d: object) => void;
  // When importing, the current parsed holding to pre-fill the form with, plus the
  // "n of total" position shown in the title. Null for a normal manual add.
  prefill?: ParsedHolding | null;
  queuePosition?: { index: number; total: number } | null;
}) {
  const pref = useStore(s => s.user?.currency_preference) ?? 'AUD';
  // First dropdown = asset category; for stocks/ETFs a second dropdown picks the
  // market. `market` (the value the rest of the flow keys off) is derived from both.
  const [category, setCategory] = useState('');
  const [stockMarket, setStockMarket] = useState('ASX');
  const market =
    category === 'stocks_etf'      ? stockMarket :
    category === 'crypto'          ? 'Crypto' :
    category === 'precious_metals' ? 'Physical Precious Metals' :
    category === 'managed_fund'    ? 'Managed Fund' :
    category === 'private'         ? 'Private Investment' :
    category === 'other'           ? 'Other' :
    category === 'bond'            ? 'Bonds' :
    category === 'art'             ? 'Art' :
    category === 'wine'            ? 'Wine' :
    category === 'cash'            ? 'Cash' :
    category === 'jewellery'       ? 'Jewellery' : '';
  const isCollectible = COLLECTIBLE_CATEGORIES.has(category);
  const isCash = category === 'cash';
  const [form, setForm] = useState({
    ticker: '', name: '', shares_owned: '', cost_basis: '', profit_loss: '', current_price: '',
    acquired_date: '',
    asset_type: 'stock', is_dividend_paying: false,
    metal_weight: '', metal_unit: 'grams', native_currency: 'AUD',
    metal_detailed: false, metal_form: 'minted_bar', metal_mint: '',
    metal_buy_price: '', metal_sell_price: '',
    // Collectibles (bond/art/wine/jewellery): total current/last-valuation value.
    c_value: '',
    // Bonds.
    bond_purchase_date: '', bond_maturity_date: '', bond_expected: '',
    // Shared collectible dates (art / wine / jewellery).
    c_purchase_date: '', c_valuation_date: '',
    // Art.
    art_artist: '', art_collection: '', art_year: '', art_medium: '',
    // Wine.
    wine_region: '', wine_vintage: '', wine_producer: '', wine_varietal: '', wine_size: '750ml',
    // Jewellery.
    jw_type: 'Ring', jw_brand: '', jw_model: '', jw_reference: '',
  });
  // Jewellery is made of one or more materials (e.g. 24k gold + diamonds), each with
  // its own approximate value — summed as a suggestion for the holding's worth.
  const [materials, setMaterials] = useState<{ material: string; value: string }[]>([{ material: '', value: '' }]);
  // Scraped dealer products for the in-depth metal picker, + the chosen one.
  const [metalProducts, setMetalProducts] = useState<MetalProduct[]>([]);
  const [metalProductId, setMetalProductId] = useState('');
  // Which currency the cost / P&L inputs are denominated in.
  const [entryCcy, setEntryCcy] = useState<'native' | 'pref'>('native');
  // Live native → preferred FX rate (1 when same currency); powers the toggle and
  // the cost↔P&L auto-calc, and is passed to the backend as the snapshot rate.
  const [fxRate, setFxRate] = useState(1);

  const isMetal   = market === 'Physical Precious Metals';
  const isPrivate = market === 'Private Investment' || market === 'Managed Fund';
  const isForeign = !isMetal && !isPrivate && form.native_currency !== pref;
  // Currency the entered amounts are in.
  const inputCcy = isForeign && entryCcy === 'pref' ? pref : form.native_currency;

  // Fetch the FX rate whenever the holding's native currency changes.
  useEffect(() => {
    const nc = form.native_currency;
    if (isMetal || isPrivate || !nc || nc === pref) { setFxRate(1); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/fxrate?from=${encodeURIComponent(nc)}&to=${encodeURIComponent(pref)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { rate?: number } | null) => { if (!cancelled && d?.rate) setFxRate(d.rate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [form.native_currency, pref, isMetal, isPrivate]);

  // Seed the metal selection when switching into metal mode. The <select> shows
  // "Gold" by default but its bound value starts empty, so without this the spot
  // fetch (which needs a ticker) never fires until the user re-picks the metal.
  useEffect(() => {
    if (isMetal && !form.ticker) setForm(f => ({ ...f, ticker: METALS[0] }));
  }, [isMetal, form.ticker]);

  // Metals: pull the live spot price for the chosen metal + weight unit, converted
  // into the user's preferred currency, and use it as the per-unit value. This drives
  // the holding's worth in BOTH generic and in-depth modes — a holding's value is the
  // metal's live spot value, never a static figure. (The buy price/cost basis the
  // user enters is separate; the sell side is always auto = live spot.)
  useEffect(() => {
    if (!isMetal || !form.ticker) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/price/${encodeURIComponent(form.ticker)}?unit=${encodeURIComponent(form.metal_unit)}&currency=${encodeURIComponent(pref)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { price?: number; currency?: string } | null) => {
        if (cancelled || !d?.price) return;
        setForm(f => ({
          ...f,
          current_price: d.price!.toFixed(4),
          metal_sell_price: d.price!.toFixed(4),  // value/buyback auto-tracks spot
          native_currency: d.currency ?? pref,
        }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isMetal, form.ticker, form.metal_unit, pref]);

  // Load scraped dealer products for the chosen metal when in-depth mode is on,
  // so the user can pick a real product instead of typing prices by hand.
  useEffect(() => {
    if (!isMetal || !form.metal_detailed || !form.ticker) { setMetalProducts([]); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/metal-products?metal=${encodeURIComponent(form.ticker)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { products?: MetalProduct[] } | null) => {
        if (cancelled) return;
        // Group by dealer (alphabetical) so all ABC products sit together, all
        // Perth Mint together, etc.; within a dealer order by weight ascending.
        const sorted = [...(d?.products ?? [])].sort((a, b) =>
          a.dealer.localeCompare(b.dealer) || (a.weight_grams ?? 0) - (b.weight_grams ?? 0));
        setMetalProducts(sorted);
      })
      .catch(() => { if (!cancelled) setMetalProducts([]); });
    return () => { cancelled = true; };
  }, [isMetal, form.metal_detailed, form.ticker]);

  // Picking a dealer product fills weight, form, mint and the per-unit BUY price
  // (the scraped buy figure is a whole-product total → divide by the product weight).
  // The sell/value side is handled automatically by the live-spot effect, so we
  // don't touch it here. Cost basis is derived from the buy price × weight.
  const onPickProduct = (id: string) => {
    setMetalProductId(id);
    const p = metalProducts.find(x => x.id === id);
    if (!p) return;
    const grams = p.weight_grams || 0;
    const perUnitBuy = grams > 0 && p.buy_price != null ? p.buy_price / grams : null;
    // Mint dropdown only holds known brands; fall back to "Other" for anything else.
    const mint = METAL_MINTS.includes(p.dealer) ? p.dealer : 'Other';
    setForm(f => ({
      ...f,
      metal_unit: 'grams',
      metal_weight: grams ? String(grams) : f.metal_weight,
      metal_form: p.form ?? f.metal_form,
      metal_mint: mint,
      name: p.product_name,
      metal_buy_price: perUnitBuy != null ? perUnitBuy.toFixed(4) : f.metal_buy_price,
      cost_basis: perUnitBuy != null && grams > 0 ? (perUnitBuy * grams).toFixed(2) : f.cost_basis,
    }));
  };

  // Dealer products are scraped for the whole metal regardless of size, so once
  // the user has entered a weight we only offer products that actually match it
  // (e.g. typing 5g + Gold should never surface a 1oz bar). Tolerance is 1% to
  // absorb rounding between troy-oz and grams. With no weight yet, show all.
  const GRAMS_PER_UNIT: Record<string, number> = { grams: 1, ounces: 31.1035, kg: 1000 };
  const targetGrams = (parseFloat(form.metal_weight) || 0) * (GRAMS_PER_UNIT[form.metal_unit] ?? 1);
  const visibleMetalProducts = targetGrams > 0
    ? metalProducts.filter(p => p.weight_grams != null &&
        Math.abs(p.weight_grams - targetGrams) <= targetGrams * 0.01)
    : metalProducts;

  // Current market value expressed in the chosen input currency — the basis for
  // deriving cost from P&L (and vice-versa).
  const shares = parseFloat(isMetal ? form.metal_weight : form.shares_owned) || 0;
  const valueNative = shares * (parseFloat(form.current_price) || 0);
  const valueInInput = inputCcy === form.native_currency ? valueNative : parseFloat((valueNative * fxRate).toFixed(2));

  // Cost ↔ P&L are linked: editing one fills the other when a market value exists.
  // For metals, cost ↔ buy-price-per-unit are also linked (the user enters EITHER):
  // editing total cost back-fills the per-unit buy price (cost ÷ weight).
  const onCostChange = (v: string) => setForm(f => ({
    ...f, cost_basis: v,
    profit_loss: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.profit_loss,
    ...(isMetal && shares > 0 ? { metal_buy_price: v !== '' ? (parseFloat(v) / shares).toFixed(4) : '' } : {}),
  }));
  // Entering a per-unit buy price fills the total cost basis (price × weight).
  const onMetalBuyPriceChange = (v: string) => setForm(f => ({
    ...f, metal_buy_price: v,
    cost_basis: v !== '' && shares > 0 ? (parseFloat(v) * shares).toFixed(2) : f.cost_basis,
  }));
  const onPlChange = (v: string) => setForm(f => ({
    ...f, profit_loss: v,
    cost_basis: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.cost_basis,
  }));

  // Switching the input currency re-expresses already-entered amounts.
  const switchCcy = (next: 'native' | 'pref') => {
    if (next === entryCcy || fxRate === 0) return;
    const factor = next === 'pref' ? fxRate : 1 / fxRate;
    setForm(f => ({
      ...f,
      cost_basis:  f.cost_basis  !== '' ? (parseFloat(f.cost_basis)  * factor).toFixed(2) : '',
      profit_loss: f.profit_loss !== '' ? (parseFloat(f.profit_loss) * factor).toFixed(2) : '',
    }));
    setEntryCcy(next);
  };

  // Import queue: pre-fill the whole form from the current parsed holding. Runs each
  // time the queue advances to a new holding (prefill identity changes).
  useEffect(() => {
    if (!prefill) return;
    const h = prefill;
    const at = (h.asset_type || '').toLowerCase();
    let cat = 'stocks_etf';
    if (at === 'crypto' || h.market === 'Crypto') cat = 'crypto';
    else if (at === 'precious_metal') cat = 'precious_metals';
    else if (['bond', 'art', 'wine', 'jewellery'].includes(at)) cat = at;
    else if (at === 'managed_fund') cat = 'managed_fund';
    else if (at === 'private') cat = 'private';
    else if (at === 'other') cat = 'other';
    setCategory(cat);
    if (cat === 'stocks_etf' && STOCK_MARKETS.includes(h.market)) setStockMarket(h.market);
    const collectible = COLLECTIBLE_CATEGORIES.has(cat);
    const d = (h.details ?? {}) as Record<string, unknown>;
    const ds = (k: string) => (d[k] != null ? String(d[k]) : '');
    setForm(f => ({
      ...f,
      ticker: h.ticker || '',
      name: h.name || '',
      shares_owned: h.shares_owned ? String(h.shares_owned) : '',
      cost_basis: h.cost_basis ? String(h.cost_basis) : '',
      current_price: h.current_price != null ? String(h.current_price) : '',
      native_currency: h.currency || 'AUD',
      asset_type: collectible ? f.asset_type : (at || 'stock'),
      c_value: collectible && h.current_value != null ? String(h.current_value) : f.c_value,
      // Collectible-specific fields, when the parser supplied them.
      bond_maturity_date: ds('maturity_date'), bond_expected: ds('expected_maturity_value'),
      bond_purchase_date: cat === 'bond' ? ds('purchase_date') : f.bond_purchase_date,
      c_purchase_date: cat !== 'bond' ? ds('purchase_date') : f.c_purchase_date,
      c_valuation_date: ds('last_valuation_date'),
      art_artist: ds('artist'), art_collection: ds('collection'), art_year: ds('year'), art_medium: ds('medium'),
      wine_region: ds('region'), wine_vintage: ds('vintage'), wine_producer: ds('producer'),
      wine_varietal: ds('varietal'), wine_size: ds('bottle_size') || f.wine_size,
      jw_type: ds('jewellery_type') || f.jw_type, jw_brand: ds('brand'), jw_model: ds('model'), jw_reference: ds('reference'),
    }));
    if (cat === 'jewellery' && Array.isArray(d.materials) && d.materials.length) {
      setMaterials((d.materials as { material?: unknown; value?: unknown }[]).map(m => ({
        material: m.material != null ? String(m.material) : '',
        value: m.value != null ? String(m.value) : '',
      })));
    }
    setEntryCcy('native');
  }, [prefill]);

  const handleTickerSelect = (result: TickerResult, price: number, currency: string) => {
    // Stocks/ETFs: snap the market sub-dropdown to the ticker's real market when known.
    if (category === 'stocks_etf' && STOCK_MARKETS.includes(result.market)) setStockMarket(result.market);
    setEntryCcy('native');
    setForm(f => ({
      ...f,
      ticker:          result.symbol,
      name:            result.name,
      asset_type:      result.assetType,
      current_price:   price > 0 ? String(price) : f.current_price,
      native_currency: currency || 'AUD',
    }));
  };

  const resetForm = () => {
    setForm({ ticker: '', name: '', shares_owned: '', cost_basis: '', profit_loss: '', current_price: '', acquired_date: '', asset_type: 'stock', is_dividend_paying: false, metal_weight: '', metal_unit: 'grams', native_currency: 'AUD', metal_detailed: false, metal_form: 'minted_bar', metal_mint: '', metal_buy_price: '', metal_sell_price: '', c_value: '', bond_purchase_date: '', bond_maturity_date: '', bond_expected: '', c_purchase_date: '', c_valuation_date: '', art_artist: '', art_collection: '', art_year: '', art_medium: '', wine_region: '', wine_vintage: '', wine_producer: '', wine_varietal: '', wine_size: '750ml', jw_type: 'Ring', jw_brand: '', jw_model: '', jw_reference: '' });
    setMaterials([{ material: '', value: '' }]);
    setEntryCcy('native');
    setFxRate(1);
    setMetalProductId('');
    setMetalProducts([]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!category) { alert('Please choose an asset type.'); return; }

    // ── Cash ────────────────────────────────────────────────────────────────
    // A plain brokerage/settlement balance: no shares or gain. Stored as a cash
    // holding (shares_owned 1, current_price = balance) so it counts toward the
    // portfolio total and appears in the allocation split and holdings list.
    if (isCash) {
      const balance = parseFloat(form.current_price) || 0;
      const ccy = form.native_currency || pref;
      onSave({
        name: form.name.trim() || (ccy === pref ? 'Cash' : `Cash (${ccy})`),
        market: 'Cash',
        asset_type: 'cash',
        shares_owned: 1,
        cost_basis: balance,
        cost_basis_currency: ccy,
        conversion_rate: fxRate,
        current_price: balance,
        native_currency: ccy,
        currency: ccy,
        is_dividend_paying: false,
      });
      resetForm();
      setCategory('');
      return;
    }

    // ── Collectibles (bond/art/wine/jewellery) ──────────────────────────────
    // Valued via shares_owned×current_price like everything else, so portfolio &
    // net-worth math is unchanged. Quantity defaults to 1; the "current value" the
    // user enters is the TOTAL, divided back to a per-unit price. No FX (entered in
    // the user's own currency). Extra fields land in `details` (filled out per-type
    // in later phases — minimal here).
    if (isCollectible) {
      const qty = parseFloat(form.shares_owned) || 1;
      const totalValue = parseFloat(form.c_value) || 0;
      const details: Record<string, unknown> = { kind: category };
      if (category === 'bond') {
        details.purchase_date = form.bond_purchase_date || null;
        details.maturity_date = form.bond_maturity_date || null;
        details.expected_maturity_value = form.bond_expected ? parseFloat(form.bond_expected) : null;
      } else if (category === 'art') {
        details.artist = form.art_artist || null;
        details.collection = form.art_collection || null;
        details.year = form.art_year || null;
        details.medium = form.art_medium || null;
        details.purchase_date = form.c_purchase_date || null;
        details.last_valuation_date = form.c_valuation_date || null;
      } else if (category === 'wine') {
        details.region = form.wine_region || null;
        details.vintage = form.wine_vintage || null;
        details.producer = form.wine_producer || null;
        details.varietal = form.wine_varietal || null;
        details.bottle_size = form.wine_size || null;
        details.purchase_date = form.c_purchase_date || null;
        details.last_valuation_date = form.c_valuation_date || null;
      } else if (category === 'jewellery') {
        details.jewellery_type = form.jw_type || null;
        details.brand = form.jw_brand || null;
        details.model = form.jw_model || null;
        details.reference = form.jw_reference || null;
        details.materials = materials
          .filter(m => m.material.trim() || m.value.trim())
          .map(m => ({ material: m.material.trim(), value: m.value ? parseFloat(m.value) || 0 : 0 }));
        details.purchase_date = form.c_purchase_date || null;
        details.last_valuation_date = form.c_valuation_date || null;
      }
      onSave({
        name: form.name || category,
        market,
        asset_type: category,
        shares_owned: qty,
        cost_basis: parseFloat(form.cost_basis) || 0,
        cost_basis_currency: pref,
        conversion_rate: 1,
        current_price: qty > 0 ? totalValue / qty : totalValue,
        native_currency: pref,
        currency: pref,
        is_dividend_paying: false,
        details,
      });
      resetForm();
      setCategory('');
      return;
    }

    const metalName = form.metal_detailed && form.name
      ? form.name
      : `${form.ticker}${form.metal_weight ? ` ${form.metal_weight}${UNIT_ABBR[form.metal_unit] ?? 'g'}` : ''}${form.metal_detailed && form.metal_form ? ` ${METAL_FORM_LABEL[form.metal_form] ?? ''}` : ''}`.trim();
    onSave({
      // Metals keep the metal name as their "ticker" (e.g. Gold) so the price
      // cron can look it up; do NOT uppercase — METAL_TICKERS keys are TitleCase.
      ticker:            isMetal ? form.ticker : (!isPrivate ? form.ticker.toUpperCase() || undefined : undefined),
      name:              isMetal ? metalName : (form.name || form.ticker || 'Unknown'),
      market,
      asset_type:        isMetal ? 'precious_metal' : isPrivate ? (market === 'Managed Fund' ? 'managed_fund' : 'private') : form.asset_type,
      shares_owned:      parseFloat(isMetal ? form.metal_weight : form.shares_owned) || 0,
      cost_basis:        parseFloat(form.cost_basis) || 0,
      // Metals are bought locally → cost is in the owner's preferred currency,
      // even when the spot price (native_currency) is quoted in USD.
      cost_basis_currency: isMetal ? pref : inputCcy,
      conversion_rate:   fxRate,
      current_price:     parseFloat(form.current_price) || 0,
      native_currency:   form.native_currency,
      // Purchase date → backend converts a foreign cost at that date's FX rate so the
      // locked cost matches what was actually paid (and feeds CGT held-time).
      acquired_date:     form.acquired_date || null,
      is_dividend_paying: form.is_dividend_paying,
      ...(isMetal ? {
        metal_unit:       form.metal_unit,
        metal_detailed:   form.metal_detailed,
        metal_form:       form.metal_detailed ? form.metal_form : 'generic',
        metal_mint:       form.metal_detailed ? (form.metal_mint || null) : null,
        // Link to the chosen scraped dealer product so the holding is valued from
        // that dealer's own buyback price (matches the dealer's site). Null for
        // generic holdings, which value at live spot.
        metal_product_id: form.metal_detailed && metalProductId ? metalProductId : null,
        // The per-unit buy price the user paid (premium over spot) — recorded for
        // both modes as the cost side; valuation always tracks live spot.
        metal_buy_price:  form.metal_buy_price ? parseFloat(form.metal_buy_price) : null,
        metal_sell_price: form.metal_sell_price ? parseFloat(form.metal_sell_price) : null,
      } : {}),
    });
    resetForm();
    setCategory('');
  };

  const ccyToggle = isForeign && (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500 dark:text-zinc-400">Amounts entered in</span>
      <div className="inline-flex rounded-[6px] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        {(['native', 'pref'] as const).map(c => {
          const ccy = c === 'native' ? form.native_currency : pref;
          return (
            <button key={c} type="button" onClick={() => switchCcy(c)}
              className={`px-2.5 py-1 transition-colors ${entryCcy === c ? 'bg-brand text-white' : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
              {ccy}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Bonds: a straight-line accretion estimate from purchase price toward the
  // expected maturity value, used as a *suggested* current value the user can accept.
  // Needs purchase date, maturity date and expected value; null until all are set.
  const bondSuggestion: number | null = (() => {
    if (category !== 'bond') return null;
    const purchase = parseFloat(form.cost_basis);
    const expected = parseFloat(form.bond_expected);
    const p = form.bond_purchase_date ? new Date(form.bond_purchase_date).getTime() : NaN;
    const m = form.bond_maturity_date ? new Date(form.bond_maturity_date).getTime() : NaN;
    if (!isFinite(purchase) || !isFinite(expected) || isNaN(p) || isNaN(m) || m <= p) return null;
    const term = m - p;
    const elapsed = Math.min(Math.max(Date.now() - p, 0), term);
    return purchase + (expected - purchase) * (elapsed / term);
  })();

  // Jewellery: sum of the entered material values, offered as a suggested worth.
  const materialsTotal = materials.reduce((s, m) => s + (parseFloat(m.value) || 0), 0);
  const updateMaterial = (i: number, key: 'material' | 'value', v: string) =>
    setMaterials(ms => ms.map((m, idx) => idx === i ? { ...m, [key]: v } : m));
  const addMaterial = () => setMaterials(ms => [...ms, { material: '', value: '' }]);
  const removeMaterial = (i: number) => setMaterials(ms => ms.length > 1 ? ms.filter((_, idx) => idx !== i) : ms);

  const costPlRow = !isMetal && !isCollectible && !isCash && (
    <>
      {ccyToggle}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
        <Input label={`Cost basis (${inputCcy})`} type="number" step="0.01" prefix="$"
          value={form.cost_basis} onChange={e => onCostChange(e.target.value)} />
        <span className="pb-2.5 text-xs text-zinc-500 dark:text-zinc-400">or</span>
        <Input label={`Profit / loss (${inputCcy})`} type="number" step="0.01" prefix="$"
          value={form.profit_loss} onChange={e => onPlChange(e.target.value)} />
      </div>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
        Fill either one — the other is worked out from the current market value.
        {isForeign && entryCcy === 'pref' && ' Your AUD cost stays fixed regardless of future FX moves.'}
      </p>
      <Input label="Purchase date (optional)" type="date" value={form.acquired_date}
        onChange={e => setForm(f => ({ ...f, acquired_date: e.target.value }))} />
      {isForeign && entryCcy === 'native' && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
          Add the date you bought it and we'll lock your {pref} cost at that day's
          exchange rate — so it matches what you actually paid, not today's rate.
        </p>
      )}
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose}
      title={queuePosition ? `Add Investment (${queuePosition.index} of ${queuePosition.total})` : 'Add Investment'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select label="Asset type" value={category} onChange={e => setCategory(e.target.value)}
          options={[{ value: '', label: 'Select…' }, ...CATEGORIES.map(c => ({ value: c.value, label: c.label }))]} />

        {/* Stocks/ETFs: a second dropdown picks the exchange. */}
        {category === 'stocks_etf' && (
          <Select label="Market / exchange" value={stockMarket} onChange={e => setStockMarket(e.target.value)}
            options={STOCK_MARKETS.map(m => ({ value: m, label: m }))} />
        )}

        {category === 'cash' ? (
          <>
            <Input label="Label (optional)" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Settled cash, Buying power" />
            <div className="grid grid-cols-3 gap-3">
              <Select label="Currency" value={form.native_currency}
                onChange={e => setForm(f => ({ ...f, native_currency: e.target.value }))}
                options={Array.from(new Set([pref, ...CASH_CURRENCIES])).map(c => ({ value: c, label: c }))} />
              <div className="col-span-2">
                <Input label="Balance" type="number" step="0.01" prefix="$" inputMode="decimal"
                  value={form.current_price}
                  onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))}
                  placeholder="0.00" required />
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
              Counts toward your Portfolio Value. Cash has no gain or loss, so it stays out of your return %.
            </p>
          </>
        ) : category === 'bond' ? (
          <>
            <Input label="Bond" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Australian Govt Treasury Bond 2.75% 2030" required />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Quantity held" type="number" step="1" value={form.shares_owned}
                onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} placeholder="1" />
              <Input label={`Bought price (${pref})`} type="number" step="0.01" prefix="$"
                value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} hint="Total you paid" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Purchase date" type="date" value={form.bond_purchase_date}
                onChange={e => setForm(f => ({ ...f, bond_purchase_date: e.target.value }))} />
              <Input label="Maturity date" type="date" value={form.bond_maturity_date}
                onChange={e => setForm(f => ({ ...f, bond_maturity_date: e.target.value }))} />
            </div>
            <Input label={`Expected value at maturity (${pref})`} type="number" step="0.01" prefix="$"
              value={form.bond_expected} onChange={e => setForm(f => ({ ...f, bond_expected: e.target.value }))}
              hint="What it's expected to be worth when it matures (total)" />
            <Input label={`Current value (${pref})`} type="number" step="0.01" prefix="$"
              value={form.c_value} onChange={e => setForm(f => ({ ...f, c_value: e.target.value }))}
              hint="Total current value — drives your portfolio total" />
            {bondSuggestion != null && (
              <div className="flex items-center justify-between gap-2 text-xs rounded-[6px] border border-zinc-200 dark:border-zinc-800 px-3 py-2 -mt-1">
                <span className="text-zinc-500 dark:text-zinc-400">
                  Suggested (straight-line to maturity): <span className="font-medium text-zinc-900 dark:text-zinc-200">{formatCurrency(bondSuggestion, pref)}</span>
                </span>
                <button type="button" onClick={() => setForm(f => ({ ...f, c_value: bondSuggestion.toFixed(2) }))}
                  className="text-brand font-medium hover:underline flex-shrink-0">Use</button>
              </div>
            )}
          </>
        ) : category === 'art' ? (
          <>
            <Input label="Title" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Blue Poles" required />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Artist / painter" value={form.art_artist} onChange={e => setForm(f => ({ ...f, art_artist: e.target.value }))} placeholder="e.g. Jackson Pollock" />
              <Input label="Collection / series" value={form.art_collection} onChange={e => setForm(f => ({ ...f, art_collection: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Year" value={form.art_year} onChange={e => setForm(f => ({ ...f, art_year: e.target.value }))} placeholder="e.g. 1952" />
              <Input label="Medium" value={form.art_medium} onChange={e => setForm(f => ({ ...f, art_medium: e.target.value }))} placeholder="e.g. Oil on canvas" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Purchase price (${pref})`} type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} />
              <Input label="Purchase date" type="date" value={form.c_purchase_date} onChange={e => setForm(f => ({ ...f, c_purchase_date: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Last valuation (${pref})`} type="number" step="0.01" prefix="$" value={form.c_value} onChange={e => setForm(f => ({ ...f, c_value: e.target.value }))} hint="Drives your portfolio total" />
              <Input label="Last valued on" type="date" value={form.c_valuation_date} onChange={e => setForm(f => ({ ...f, c_valuation_date: e.target.value }))} />
            </div>
          </>
        ) : category === 'wine' ? (
          <>
            <Input label="Wine" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Penfolds Grange" required />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Producer" value={form.wine_producer} onChange={e => setForm(f => ({ ...f, wine_producer: e.target.value }))} placeholder="e.g. Penfolds" />
              <Input label="Region" value={form.wine_region} onChange={e => setForm(f => ({ ...f, wine_region: e.target.value }))} placeholder="e.g. Barossa Valley" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Input label="Vintage (year)" value={form.wine_vintage} onChange={e => setForm(f => ({ ...f, wine_vintage: e.target.value }))} placeholder="e.g. 2016" />
              <Input label="Varietal" value={form.wine_varietal} onChange={e => setForm(f => ({ ...f, wine_varietal: e.target.value }))} placeholder="e.g. Shiraz" />
              <Select label="Bottle size" value={form.wine_size} onChange={e => setForm(f => ({ ...f, wine_size: e.target.value }))}
                options={['375ml', '750ml', '1.5L (Magnum)', '3L (Double Magnum)', '6L (Imperial)'].map(s => ({ value: s, label: s }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Bottles owned" type="number" step="1" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} placeholder="1" />
              <Input label="Purchase date" type="date" value={form.c_purchase_date} onChange={e => setForm(f => ({ ...f, c_purchase_date: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Purchase price (${pref})`} type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} hint="Total you paid" />
              <Input label={`Current value (${pref})`} type="number" step="0.01" prefix="$" value={form.c_value} onChange={e => setForm(f => ({ ...f, c_value: e.target.value }))} hint="Total — drives portfolio" />
            </div>
            <Input label="Last valued on" type="date" value={form.c_valuation_date} onChange={e => setForm(f => ({ ...f, c_valuation_date: e.target.value }))}
              hint="Update this whenever you get a fresh valuation" />
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
              Enter the current value manually for now — live wine-market valuation is coming.
            </p>
          </>
        ) : category === 'jewellery' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Select label="Type" value={form.jw_type} onChange={e => setForm(f => ({ ...f, jw_type: e.target.value }))}
                options={['Ring', 'Bracelet', 'Necklace', 'Earrings', 'Watch', 'Pendant', 'Brooch', 'Other'].map(t => ({ value: t, label: t }))} />
              <Input label="Name / description" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Diamond tennis bracelet" required />
            </div>
            {form.jw_type === 'Watch' && (
              <div className="grid grid-cols-3 gap-3">
                <Input label="Brand" value={form.jw_brand} onChange={e => setForm(f => ({ ...f, jw_brand: e.target.value }))} placeholder="e.g. Rolex" />
                <Input label="Model" value={form.jw_model} onChange={e => setForm(f => ({ ...f, jw_model: e.target.value }))} placeholder="e.g. Submariner" />
                <Input label="Reference" value={form.jw_reference} onChange={e => setForm(f => ({ ...f, jw_reference: e.target.value }))} placeholder="e.g. 124060" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">Materials</label>
              <div className="space-y-2">
                {materials.map((m, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                    <Input value={m.material} onChange={e => updateMaterial(i, 'material', e.target.value)} placeholder="e.g. 24k gold" />
                    <Input type="number" step="0.01" prefix="$" value={m.value} onChange={e => updateMaterial(i, 'value', e.target.value)} placeholder="value" />
                    <button type="button" onClick={() => removeMaterial(i)} className="text-zinc-500 hover:text-[#ef4444] px-1" aria-label="Remove material">✕</button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={addMaterial} className="text-xs text-brand font-medium hover:underline mt-1.5">+ Add material</button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Purchase price (${pref})`} type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} />
              <Input label="Purchase date" type="date" value={form.c_purchase_date} onChange={e => setForm(f => ({ ...f, c_purchase_date: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Last valuation (${pref})`} type="number" step="0.01" prefix="$" value={form.c_value} onChange={e => setForm(f => ({ ...f, c_value: e.target.value }))} hint="Drives your portfolio total" />
              <Input label="Last valued on" type="date" value={form.c_valuation_date} onChange={e => setForm(f => ({ ...f, c_valuation_date: e.target.value }))} />
            </div>
            {materialsTotal > 0 && (
              <div className="flex items-center justify-between gap-2 text-xs rounded-[6px] border border-zinc-200 dark:border-zinc-800 px-3 py-2 -mt-1">
                <span className="text-zinc-500 dark:text-zinc-400">
                  Materials total: <span className="font-medium text-zinc-900 dark:text-zinc-200">{formatCurrency(materialsTotal, pref)}</span>
                </span>
                <button type="button" onClick={() => setForm(f => ({ ...f, c_value: materialsTotal.toFixed(2) }))}
                  className="text-brand font-medium hover:underline flex-shrink-0">Use as value</button>
              </div>
            )}
            {form.jw_type === 'Watch' && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-1">
                Live watch-market valuation is coming — enter the current value manually for now.
              </p>
            )}
          </>
        ) : isMetal ? (
          <>
            <Select label="Metal" value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))} options={METALS.map(m => ({ value: m, label: m }))} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Weight" type="number" step="0.001" value={form.metal_weight} onChange={e => setForm(f => ({ ...f, metal_weight: e.target.value }))} placeholder="e.g. 100" required />
              <Select label="Unit" value={form.metal_unit} onChange={e => setForm(f => ({ ...f, metal_unit: e.target.value }))} options={[{ value: 'grams', label: 'Grams' }, { value: 'ounces', label: 'Troy oz' }, { value: 'kg', label: 'Kilograms' }]} />
            </div>

            <Toggle
              label="In-depth (specific product)"
              checked={form.metal_detailed}
              onChange={v => setForm(f => ({ ...f, metal_detailed: v }))}
            />
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
              {form.metal_detailed
                ? 'Record a specific bar/coin with its own buy & sell price (premium over spot). Value tracks your sell price and is not auto-updated.'
                : 'Uses the live spot price, converted to your weight unit & currency, and refreshed hourly.'}
            </p>

            {form.metal_detailed && (
              <>
                {visibleMetalProducts.length > 0 && (
                  <>
                    <Select
                      label="Live dealer price (optional)"
                      value={metalProductId}
                      onChange={e => onPickProduct(e.target.value)}
                      options={[
                        { value: '', label: '— Enter manually —' },
                        ...visibleMetalProducts.map(p => ({
                          value: p.id,
                          label: `${p.dealer} · ${p.unit_label ?? ''} ${METAL_FORM_LABEL[p.form ?? ''] ?? p.form ?? ''}${p.buy_price != null ? ` — $${p.buy_price.toLocaleString()}` : ''}${p.in_stock ? '' : ' (out of stock)'}`.replace(/\s+/g, ' ').trim(),
                        })),
                      ]}
                    />
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
                      Picks a real product and fills its weight, form & prices from the dealer. You can still tweak anything below.
                    </p>
                  </>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Select label="Form" value={form.metal_form} onChange={e => setForm(f => ({ ...f, metal_form: e.target.value }))} options={METAL_FORMS} />
                  <Select label="Mint / brand" value={form.metal_mint} onChange={e => setForm(f => ({ ...f, metal_mint: e.target.value }))} options={METAL_MINTS.map(m => ({ value: m, label: m }))} />
                </div>
                <Input label="Product name (optional)" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Perth Mint 5g Minted Bar" />
              </>
            )}
          </>
        ) : isPrivate ? (
          <Input label="Investment name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Startup investment" required />
        ) : (
          <TickerAutocomplete
            value={form.ticker}
            onChange={v => setForm(f => ({ ...f, ticker: v }))}
            onSelect={handleTickerSelect}
            market={market}
            label={market === 'Crypto' ? 'Ticker (e.g. BTC-AUD)' : market === 'ASX' ? 'Ticker (e.g. CBA.AX or CBA)' : 'Ticker symbol'}
            placeholder={market === 'ASX' ? 'e.g. VAS' : market === 'Crypto' ? 'e.g. BTC-AUD' : 'e.g. AAPL'}
          />
        )}

        {!isMetal && !isCollectible && !isCash && (
          <Input
            label="Company / fund name (optional)"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={form.ticker ? 'Auto-filled from ticker search' : 'e.g. Vanguard Australian Shares ETF'}
          />
        )}

        {!isMetal && !isCollectible && !isCash && (
          <Input label={market === 'Crypto' ? 'Units owned' : 'Shares / units'} type="number" step="0.00000001" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
        )}

        {!(isMetal && form.metal_detailed) && !isCollectible && !isCash && (
          <Input
            label={isMetal ? `Spot price per ${UNIT_ABBR[form.metal_unit] ?? 'unit'} (${form.native_currency})` : `Current price per unit (${form.native_currency})`}
            type="number" step="0.00000001" prefix="$"
            value={form.current_price}
            onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))}
            hint={
              isMetal
                ? (form.current_price ? `Live spot for ${form.ticker} — in ${form.native_currency}, per ${UNIT_ABBR[form.metal_unit] ?? 'unit'}` : 'Auto-filled from the live spot price')
                : (form.current_price ? `Auto-filled from Yahoo Finance — in ${form.native_currency}` : 'Leave blank — search for a ticker to auto-fill')
            }
          />
        )}

        {isMetal && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Buy price per ${UNIT_ABBR[form.metal_unit] ?? 'unit'} (${pref})`} type="number" step="0.01" prefix="$"
                value={form.metal_buy_price} onChange={e => onMetalBuyPriceChange(e.target.value)} hint="Per-unit price you paid" />
              <Input label={`Total cost basis (${pref})`} type="number" step="0.01" prefix="$"
                value={form.cost_basis} onChange={e => onCostChange(e.target.value)} hint="Total amount you paid" />
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">
              Enter either one — the other fills automatically from your weight. Value tracks the live spot price.
            </p>
          </>
        )}

        {costPlRow}

        {!isMetal && !isPrivate && !isCollectible && !isCash && (
          <Select label="Asset type" value={form.asset_type} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))}
            options={[{ value: 'stock', label: 'Stock' }, { value: 'etf', label: 'ETF' }, { value: 'managed_fund', label: 'Managed Fund' }, { value: 'other', label: 'Other' }]}
          />
        )}

        {!isMetal && !isCollectible && !isCash && (
          <Toggle label="Dividend / distribution paying" checked={form.is_dividend_paying} onChange={v => setForm(f => ({ ...f, is_dividend_paying: v }))} />
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>{queuePosition ? 'Cancel import' : 'Cancel'}</Button>
          <Button variant="primary" type="submit" fullWidth>
            {queuePosition ? (queuePosition.index < queuePosition.total ? 'Add & next' : 'Add & finish') : 'Add Investment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Import Portfolio Modal ──────────────────────────────────────────────────

function ImportPortfolioModal({
  isOpen,
  onClose,
  onImport,
}: {
  isOpen: boolean;
  onClose: () => void;
  onImport: (holdings: ParsedHolding[]) => void;
}) {
  const [step, setStep] = useState<'upload' | 'confirm'>('upload');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [portfolioName, setPortfolioName] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<ParsedHolding[]>([]);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState<Partial<ParsedHolding>>({});

  const reset = () => {
    setStep('upload');
    setParsing(false);
    setParseError(null);
    setPortfolioName(null);
    setHoldings([]);
    setEditIdx(null);
    setEditBuf({});
  };

  const handleClose = () => { reset(); onClose(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError(null);

    const { parsed, error } = await parseDocument(file, 'investment_portfolio');
    setParsing(false);

    if (error || !parsed) {
      setParseError(error ?? 'Failed to parse document. Please check the file and try again.');
      e.target.value = '';
      return;
    }

    // Normalise raw Claude output
    type RawHolding = Record<string, unknown>;
    const rawHoldings = (parsed.holdings as RawHolding[] | undefined) ?? [];

    if (rawHoldings.length === 0) {
      setParseError('No holdings detected. Make sure the file is a portfolio export from your broker.');
      e.target.value = '';
      return;
    }

    const normalized: ParsedHolding[] = rawHoldings.map((r): ParsedHolding => {
      const market = String(r.market ?? 'ASX').trim();
      const usMarket = /nasdaq|nyse|us|amex/i.test(market);
      const currency = String(r.currency ?? (usMarket ? 'USD' : 'AUD')).trim().toUpperCase() || 'AUD';
      return {
      ticker:        String(r.ticker ?? '').trim().toUpperCase(),
      name:          String(r.name ?? r.ticker ?? 'Unknown').trim(),
      market,
      asset_type:    String(r.asset_type ?? 'stock').trim(),
      currency,
      shares_owned:  Number(r.shares_owned) || 0,
      cost_basis:    Number(r.cost_basis)   || 0,
      current_value: r.current_value != null && r.current_value !== '' ? Number(r.current_value) || null : null,
      current_price: r.current_price != null && r.current_price !== '' ? Number(r.current_price) || null : null,
      details: (r.details && typeof r.details === 'object') ? (r.details as Record<string, unknown>) : null,
      };
    });

    setPortfolioName((parsed.portfolio_name as string | null) ?? null);
    setHoldings(normalized);
    setStep('confirm');
    e.target.value = '';
  };

  const startEdit = (idx: number) => {
    setEditIdx(idx);
    setEditBuf({ ...holdings[idx] });
  };

  const saveEdit = () => {
    if (editIdx === null) return;
    setHoldings(prev => prev.map((h, i) => i === editIdx ? { ...h, ...editBuf } as ParsedHolding : h));
    setEditIdx(null);
    setEditBuf({});
  };

  const removeHolding = (idx: number) => {
    setHoldings(prev => prev.filter((_, i) => i !== idx));
    if (editIdx === idx) setEditIdx(null);
  };

  const handleConfirm = () => {
    onImport(holdings);
    reset();
  };

  const currency = useStore.getState().user?.currency_preference ?? 'AUD';

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import Portfolio" size="lg">
      {/* ── Upload step ── */}
      {step === 'upload' && (
        <div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            Upload a portfolio export from your broker. Claude will extract all holdings automatically.
          </p>

          {/* Supported brokers hint */}
          <div className="mb-4 px-3 py-2.5 rounded-[8px] bg-zinc-100 dark:bg-zinc-900 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-medium text-[#333] dark:text-[#ccc]">Supported brokers: </span>
            CommSec · SelfWealth · Stake · Interactive Brokers · CMC Markets · Sharesight · and more
          </div>

          {/* Drop zone */}
          <label className={`w-full flex flex-col items-center justify-center gap-2 px-4 py-8 mb-4 rounded-[8px] border-2 border-dashed cursor-pointer transition-colors ${parsing ? 'border-brand/40 bg-brand/5' : 'border-zinc-200 dark:border-zinc-800 hover:border-brand/40 hover:bg-brand/5'}`}>
            {parsing ? (
              <>
                <div className="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-medium text-brand">Analysing your portfolio…</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">This may take 15–30 seconds</p>
              </>
            ) : (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500 dark:text-zinc-400">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p className="text-sm font-medium">Click to upload portfolio file</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">PDF or CSV · up to 20 MB</p>
              </>
            )}
            <input type="file" accept=".pdf,.csv,image/*" className="hidden" onChange={handleFile} disabled={parsing} />
          </label>

          {parseError && (
            <div className="px-3 py-2.5 rounded-[8px] bg-[#ef4444]/10 text-[#ef4444] text-sm mb-4">
              {parseError}
            </div>
          )}

          <Button variant="secondary" type="button" onClick={handleClose} fullWidth>Cancel</Button>
        </div>
      )}

      {/* ── Confirm step ── */}
      {step === 'confirm' && (
        <div>
          {/* Summary header */}
          <div className="mb-4 px-3 py-3 rounded-[8px] bg-[#22c55e]/10 text-[#22c55e] text-sm">
            <span className="font-semibold">Found {holdings.length} investment{holdings.length !== 1 ? 's' : ''}</span>
            {portfolioName && <span className="text-[#22c55e]/80"> in {portfolioName}</span>}
            <span className="text-[#22c55e]/80">. Review and edit below, then confirm to import.</span>
          </div>

          {/* Holdings list */}
          <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1 mb-4">
            {holdings.map((h, idx) => (
              <div key={idx} className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                {/* Row */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm">{h.ticker || '—'}</span>
                      {h.ticker !== h.name && <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[160px]">{h.name}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/10 text-brand font-medium">{h.market}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${h.currency === 'USD' ? 'bg-[#22c55e]/10 text-[#22c55e]' : 'bg-[#f59e0b]/10 text-[#f59e0b]'}`}>{h.currency}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 capitalize">{h.asset_type.replace('_', ' ')}</span>
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {h.shares_owned} {h.asset_type === 'crypto' ? 'units' : 'shares'} · Cost: {formatCurrency(h.cost_basis, h.currency || currency)}
                      {h.current_value != null && ` · Value: ${formatCurrency(h.current_value, h.currency || currency)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => editIdx === idx ? setEditIdx(null) : startEdit(idx)}
                      className="text-xs text-brand hover:underline"
                    >
                      {editIdx === idx ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeHolding(idx)}
                      className="text-xs text-zinc-500 hover:text-[#ef4444]"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Inline edit form */}
                {editIdx === idx && (
                  <div className="px-3 pb-3 pt-2 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-[#161616] space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Ticker"
                        value={String(editBuf.ticker ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, ticker: e.target.value.toUpperCase() }))}
                      />
                      <Input
                        label="Name"
                        value={String(editBuf.name ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, name: e.target.value }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Shares / units"
                        type="number"
                        step="0.00000001"
                        value={String(editBuf.shares_owned ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, shares_owned: parseFloat(e.target.value) || 0 }))}
                      />
                      <Input
                        label="Total cost basis"
                        type="number"
                        step="0.01"
                        prefix="$"
                        value={String(editBuf.cost_basis ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, cost_basis: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="Market"
                        value={String(editBuf.market ?? 'ASX')}
                        onChange={e => setEditBuf(b => ({ ...b, market: e.target.value }))}
                        options={MARKETS.map(m => ({ value: m, label: m }))}
                      />
                      <Select
                        label="Asset type"
                        value={String(editBuf.asset_type ?? 'stock')}
                        onChange={e => setEditBuf(b => ({ ...b, asset_type: e.target.value }))}
                        options={[
                          { value: 'stock', label: 'Stock' },
                          { value: 'etf', label: 'ETF' },
                          { value: 'managed_fund', label: 'Managed Fund' },
                          { value: 'crypto', label: 'Crypto' },
                          { value: 'other', label: 'Other' },
                        ]}
                      />
                    </div>
                    <Select
                      label="Native currency"
                      value={String(editBuf.currency ?? 'AUD')}
                      onChange={e => setEditBuf(b => ({ ...b, currency: e.target.value }))}
                      options={[
                        { value: 'AUD', label: 'AUD — Australian (ASX)' },
                        { value: 'USD', label: 'USD — US-listed' },
                      ]}
                    />
                    <Button variant="primary" size="sm" onClick={saveEdit}>Save changes</Button>
                  </div>
                )}
              </div>
            ))}

            {holdings.length === 0 && (
              <div className="text-center py-6 text-sm text-zinc-500 dark:text-zinc-400">
                All holdings removed. Go back to upload a different file.
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              variant="secondary"
              type="button"
              onClick={() => { setStep('upload'); setHoldings([]); setParseError(null); }}
            >
              ← Back
            </Button>
            <Button
              variant="primary"
              type="button"
              fullWidth
              onClick={handleConfirm}
              disabled={holdings.length === 0}
            >
              Review {holdings.length} holding{holdings.length !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Edit Investment Modal ───────────────────────────────────────────────────

function EditInvestmentModal({ inv, onClose, onSave }: {
  inv: ReturnType<typeof useStore.getState>['investments'][0];
  onClose: () => void;
  onSave: (id: string, data: object) => void;
}) {
  const pref = useStore(s => s.user?.currency_preference) ?? 'AUD';
  const nativeCcy = inv.native_currency || 'AUD';
  const isForeign = nativeCcy !== pref;
  const storedCostCcy = inv.cost_basis_currency || nativeCcy;

  const isColl = COLLECTIBLE_CATEGORIES.has(inv.asset_type);
  const initDetails = (inv.details ?? {}) as Record<string, unknown>;

  const [form, setForm] = useState({
    shares_owned:  String(inv.shares_owned),
    cost_basis:    String(inv.cost_basis),
    profit_loss:   '',
    current_price: String(inv.current_price),
    name:          inv.name,
  });
  // Collectibles: edit the TOTAL current/last-valuation value and the valuation date.
  const [cValue, setCValue] = useState(String(((inv.shares_owned || 0) * (inv.current_price || 0)) || ''));
  const [valDate, setValDate] = useState(initDetails.last_valuation_date ? String(initDetails.last_valuation_date) : '');
  const [entryCcy, setEntryCcy] = useState<'native' | 'pref'>(storedCostCcy === pref ? 'pref' : 'native');
  const [fxRate, setFxRate] = useState(inv.conversion_rate ?? 1);

  useEffect(() => {
    if (!isForeign) { setFxRate(1); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/fxrate?from=${encodeURIComponent(nativeCcy)}&to=${encodeURIComponent(pref)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { rate?: number } | null) => { if (!cancelled && d?.rate) setFxRate(d.rate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isForeign, nativeCcy, pref]);

  const inputCcy = isForeign && entryCcy === 'pref' ? pref : nativeCcy;
  const valueNative = (parseFloat(form.shares_owned) || 0) * (parseFloat(form.current_price) || 0);
  const valueInInput = inputCcy === nativeCcy ? valueNative : parseFloat((valueNative * fxRate).toFixed(2));

  const onCostChange = (v: string) => setForm(f => ({
    ...f, cost_basis: v,
    profit_loss: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.profit_loss,
  }));
  const onPlChange = (v: string) => setForm(f => ({
    ...f, profit_loss: v,
    cost_basis: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.cost_basis,
  }));
  const switchCcy = (next: 'native' | 'pref') => {
    if (next === entryCcy || fxRate === 0) return;
    const factor = next === 'pref' ? fxRate : 1 / fxRate;
    setForm(f => ({
      ...f,
      cost_basis:  f.cost_basis  !== '' ? (parseFloat(f.cost_basis)  * factor).toFixed(2) : '',
      profit_loss: f.profit_loss !== '' ? (parseFloat(f.profit_loss) * factor).toFixed(2) : '',
    }));
    setEntryCcy(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isColl) {
      const qty = parseFloat(form.shares_owned) || 1;
      const total = parseFloat(cValue) || 0;
      onSave(inv.id, {
        name: form.name,
        shares_owned: qty,
        cost_basis: parseFloat(form.cost_basis) || 0,
        current_price: qty > 0 ? total / qty : total,
        details: { ...initDetails, last_valuation_date: valDate || null },
      });
      return;
    }
    onSave(inv.id, {
      shares_owned:  parseFloat(form.shares_owned),
      cost_basis:    parseFloat(form.cost_basis) || 0,
      cost_basis_currency: inputCcy,
      conversion_rate: fxRate,
      current_price: parseFloat(form.current_price),
      name:          form.name,
    });
  };

  if (isColl) {
    const qtyLabel = inv.asset_type === 'wine' ? 'Bottles owned' : inv.asset_type === 'bond' ? 'Quantity held' : 'Quantity';
    return (
      <Modal isOpen={true} onClose={onClose} title={`Edit — ${inv.name}`} size="sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label={qtyLabel} type="number" step="1" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
            <Input label={`Purchase price (${pref})`} type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} />
          </div>
          <Input label={`Current value (${pref})`} type="number" step="0.01" prefix="$" value={cValue} onChange={e => setCValue(e.target.value)} hint="Total — drives your portfolio total" />
          <Input label="Last valued on" type="date" value={valDate} onChange={e => setValDate(e.target.value)} hint="Set this when you get a fresh valuation" />
          <SharePanel kind="investment" id={inv.id} noun="this holding" />
          <LinkedDocuments linkedType="investment" linkedId={inv.id}
            emptyText="No documents filed against this holding yet." />
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" fullWidth>Save Changes</Button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal isOpen={true} onClose={onClose} title={`Edit — ${inv.ticker ?? inv.name}`} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <Input label="Shares / units owned" type="number" step="0.00000001" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
        <Input label={`Current price per unit (${nativeCcy})`} type="number" step="0.00000001" prefix="$" value={form.current_price} onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))} />
        {isForeign && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500 dark:text-zinc-400">Amounts entered in</span>
            <div className="inline-flex rounded-[6px] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              {(['native', 'pref'] as const).map(c => {
                const ccy = c === 'native' ? nativeCcy : pref;
                return (
                  <button key={c} type="button" onClick={() => switchCcy(c)}
                    className={`px-2.5 py-1 transition-colors ${entryCcy === c ? 'bg-brand text-white' : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
                    {ccy}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
          <Input label={`Cost basis (${inputCcy})`} type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => onCostChange(e.target.value)} />
          <span className="pb-2.5 text-xs text-zinc-500 dark:text-zinc-400">or</span>
          <Input label={`Profit / loss (${inputCcy})`} type="number" step="0.01" prefix="$" value={form.profit_loss} onChange={e => onPlChange(e.target.value)} />
        </div>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 -mt-2">Fill either one — the other is worked out from the current market value.</p>
        <SharePanel kind="investment" id={inv.id} noun="this holding" />
        <LinkedDocuments linkedType="investment" linkedId={inv.id}
          emptyText="No documents filed against this holding yet." />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Save Changes</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Sell Investment Modal ───────────────────────────────────────────────────

function SellInvestmentModal({ inv, currency, onClose, onSell }: {
  inv: ReturnType<typeof useStore.getState>['investments'][0];
  currency: string;
  onClose: () => void;
  onSell: (input: { quantity: number; proceeds: number; fees: number; sale_date: string; acquired_date: string }) => void;
}) {
  const origQty = inv.shares_owned || 0;
  const unitWord = inv.asset_type === 'crypto' ? 'units'
    : inv.asset_type === 'precious_metal' ? (UNIT_ABBR[inv.metal_unit ?? 'grams'] ?? 'units')
    : inv.asset_type === 'wine' ? 'bottles'
    : ['art', 'jewellery', 'bond'].includes(inv.asset_type) ? 'units' : 'shares';
  const dispValue = inv.display_value ?? (inv.current_value * (inv.conversion_rate ?? 1));
  const dispCost = inv.display_cost ?? inv.cost_basis;
  const detailsPurchase = (inv.details as Record<string, unknown> | undefined)?.purchase_date;

  const [form, setForm] = useState({
    quantity: String(origQty),
    proceeds: dispValue ? dispValue.toFixed(2) : '',
    fees: '0',
    sale_date: new Date().toISOString().slice(0, 10),
    acquired_date: detailsPurchase ? String(detailsPurchase) : '',
  });

  const qty = Math.min(parseFloat(form.quantity) || 0, origQty);
  const fraction = origQty > 0 ? qty / origQty : 1;
  const proceeds = parseFloat(form.proceeds) || 0;
  const fees = parseFloat(form.fees) || 0;
  const costSold = parseFloat((dispCost * fraction).toFixed(2));
  const gain = parseFloat((proceeds - fees - costSold).toFixed(2));
  const suggestedProceeds = parseFloat((dispValue * fraction).toFixed(2));

  const heldDays = form.acquired_date
    ? Math.round((new Date(form.sale_date).getTime() - new Date(form.acquired_date).getTime()) / 86_400_000)
    : null;
  const discountEligible = heldDays != null && heldDays > 365 && gain > 0;
  const taxableGain = discountEligible ? parseFloat((gain * 0.5).toFixed(2)) : gain;
  const heldLabel = heldDays == null ? '—'
    : heldDays >= 365 ? `${(heldDays / 365).toFixed(1)} yr` : `${heldDays} days`;

  const valid = qty > 0 && qty <= origQty && form.proceeds !== '';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSell({ quantity: qty, proceeds, fees, sale_date: form.sale_date, acquired_date: form.acquired_date });
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={`Sell — ${inv.ticker ?? inv.name}`} size="sm">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label={`Quantity to sell (of ${origQty} ${unitWord})`} type="number" step="0.00000001"
            value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} required />
          <Input label={`Sale proceeds (${currency})`} type="number" step="0.01" prefix="$"
            value={form.proceeds} onChange={e => setForm(f => ({ ...f, proceeds: e.target.value }))}
            hint={`≈ ${formatCurrency(suggestedProceeds, currency)} at current value`} required />
        </div>
        <button type="button" onClick={() => setForm(f => ({ ...f, quantity: String(origQty) }))}
          className="text-xs text-brand font-medium hover:underline -mt-2">Sell all</button>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Sale date" type="date" value={form.sale_date} onChange={e => setForm(f => ({ ...f, sale_date: e.target.value }))} required />
          <Input label="Acquired date" type="date" value={form.acquired_date} onChange={e => setForm(f => ({ ...f, acquired_date: e.target.value }))}
            hint="For the 12-month CGT discount" />
        </div>
        <Input label={`Brokerage / selling fees (${currency})`} type="number" step="0.01" prefix="$"
          value={form.fees} onChange={e => setForm(f => ({ ...f, fees: e.target.value }))} />

        <div className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 p-3 space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">Cost of sold units</span><span>{formatCurrency(costSold, currency)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">Holding period</span><span>{heldLabel}</span></div>
          <div className="flex justify-between font-medium">
            <span>{gain >= 0 ? 'Capital gain' : 'Capital loss'}</span>
            <span className={gain >= 0 ? 'text-[#16a34a]' : 'text-[#ef4444]'}>{formatCurrency(gain, currency)}</span>
          </div>
          {discountEligible && (
            <div className="flex justify-between text-xs text-[#16a34a]">
              <span>50% CGT discount (held &gt; 12 mo)</span><span>−{formatCurrency(parseFloat((gain * 0.5).toFixed(2)), currency)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold border-t border-zinc-200 dark:border-zinc-800 pt-1.5">
            <span>Taxable gain</span>
            <span className={taxableGain >= 0 ? 'text-[#16a34a]' : 'text-[#ef4444]'}>{formatCurrency(taxableGain, currency)}</span>
          </div>
        </div>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Counts toward the {fyLabelFor(form.sale_date)} financial year. Estimate only — confirm with your accountant.
        </p>

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth disabled={!valid}>Record sale</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Realised Gains & CGT panel ──────────────────────────────────────────────

/**
 * Phase 5.4 — the realised-gains panel, rebuilt on the shared CGT engine.
 *
 * It used to end in a five-row "your marginal tax rate" dropdown and multiply.
 * That was a second, worse copy of a rate table Ledger audits against the ATO
 * every year, and it could not see carried-forward losses, parcels, or the rest
 * of the user's income. The number now comes from `cgtDS.build`, exactly the
 * same call the Tax page makes, and the tax on it is worked out where tax is
 * worked out — on the Tax page, against that year's real brackets.
 */
function RealisedGainsPanel({ sales, currency }: { sales: InvestmentSale[]; currency: string }) {
  // Financial years present in the data (plus the current one), newest first.
  const fyYears = Array.from(new Set([
    fyStartYear(new Date()),
    ...sales.map(s => fyStartYear(new Date(s.sale_date))),
  ])).sort((a, b) => b - a);
  const [fy, setFy] = useState(fyYears[0]);
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  const position = useMemo(() => cgtDS.build(`${fy}-${fy + 1}`), [fy, sales]);

  const fyLabel = `${fy}–${String(fy + 1).slice(2)}`;
  const fmt = (n: number) => formatCurrency(n, currency);
  const grossGains = position.grossGainsTotal;
  const grossLosses = position.currentYearLosses.ordinary + position.currentYearLosses.collectable;

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="font-semibold">Realised Gains & CGT</h2>
        <Select value={String(fy)} onChange={e => setFy(Number(e.target.value))}
          options={fyYears.map(y => ({ value: String(y), label: `FY ${y}–${String(y + 1).slice(2)}` }))} />
      </div>

      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><p className="text-xs text-zinc-500 dark:text-zinc-400">Proceeds</p><p className="font-semibold amount">{fmt(position.proceeds)}</p></div>
          <div><p className="text-xs text-zinc-500 dark:text-zinc-400">Cost base</p><p className="font-semibold amount">{fmt(position.costBase)}</p></div>
          <div><p className="text-xs text-zinc-500 dark:text-zinc-400">Gross gains</p><p className="font-semibold amount text-[#16a34a]">{fmt(grossGains)}</p></div>
          <div><p className="text-xs text-zinc-500 dark:text-zinc-400">Losses</p><p className="font-semibold amount text-[#ef4444]">{fmt(grossLosses)}</p></div>
        </div>

        <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-1.5 text-sm">
          {position.broughtForward.ordinary + position.broughtForward.collectable > 0 && (
            <div className="flex justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Losses carried in from earlier years</span>
              <span>{fmt(position.broughtForward.ordinary + position.broughtForward.collectable)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-zinc-500 dark:text-zinc-400">Gains after offsetting losses</span>
            <span>{fmt(position.gainsAfterLossesTotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500 dark:text-zinc-400">Less 50% discount (eligible gains)</span>
            <span>−{fmt(position.discount)}</span>
          </div>
          <div className="flex justify-between font-semibold border-t border-zinc-200 dark:border-zinc-800 pt-1.5">
            <span>Net capital gain ({fyLabel})</span><span className="text-[#16a34a]">{fmt(position.netCapitalGain)}</span>
          </div>
          {position.carriedForwardTotal > 0 && (
            <div className="flex justify-between text-xs text-[#ef4444]">
              <span>Net capital loss carried forward</span><span>{fmt(position.carriedForwardTotal)}</span>
            </div>
          )}
        </div>

        <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            This net capital gain is assessable income for FY {fyLabel}, so what it actually costs
            depends on the rest of your income that year.{' '}
            <Link to="/tax" className="text-brand hover:underline">See it in your tax position</Link>{' '}
            — where the parcels, the carried-forward losses and this year's brackets all live.
          </p>
          {position.warnings.filter(w => w.severity === 'warn').map((w, i) => (
            <p key={i} className="text-[11px] text-[#b45309] dark:text-[#fbbf24] mt-2">
              {w.message}{w.amount != null && <span className="font-medium"> {fmt(w.amount)}</span>}
            </p>
          ))}
        </div>
      </Card>

      {/* Each disposal, opening onto the parcels its cost base actually came from. */}
      <div className="space-y-2 mt-4">
        {position.events.map(e => (
          <Card key={e.disposalId}>
            <button
              className="w-full flex items-start justify-between text-left"
              onClick={() => setOpenEvent(openEvent === e.disposalId ? null : e.disposalId)}
              aria-expanded={openEvent === e.disposalId}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-medium">
                    <span className="inline-block w-3 text-zinc-400">{openEvent === e.disposalId ? '▾' : '▸'}</span>{' '}
                    {e.ticker ?? e.label}
                  </h4>
                  {e.discountableGain > 0 && <span className="badge bg-[#16a34a]/10 text-[#16a34a] text-[10px]">50% discount</span>}
                  {e.assetClass === 'collectable' && <span className="badge bg-[#f59e0b]/10 text-[#b45309] text-[10px]">collectable</span>}
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 pl-4">
                  Sold {e.quantity} · {formatDate(e.saleDate)} ·{' '}
                  {e.allocations.length === 1 ? '1 parcel' : `${e.allocations.length} parcels`}
                </p>
              </div>
              <div className="text-right ml-4 flex-shrink-0">
                <p className="font-semibold amount">{fmt(e.proceeds)}</p>
                <p className={`text-sm amount ${e.gain >= 0 ? 'text-[#16a34a]' : 'text-[#ef4444]'}`}>
                  {e.gain >= 0 ? '+' : ''}{fmt(e.gain)}
                </p>
              </div>
            </button>

            {openEvent === e.disposalId && (
              <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800 space-y-1.5">
                {e.allocations.map(a => (
                  <div key={a.key} className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p>
                        {a.quantity} units ·{' '}
                        {a.acquiredDate ? `bought ${formatDate(a.acquiredDate)}` : 'acquisition date unknown'}
                        {a.discountEligible && <span className="text-[#16a34a]"> · discounted</span>}
                        {a.dateUnknown && <span className="text-[#b45309] dark:text-[#fbbf24]"> · no discount without a date</span>}
                        {a.exempt && <span className="text-zinc-400"> · under $500, ignored</span>}
                      </p>
                      <p className="text-zinc-500 dark:text-zinc-400">
                        {a.source === 'parcel' ? 'from a recorded parcel'
                          : a.source === 'recorded' ? 'cost base recorded on the sale'
                          : 'no cost base recorded'}
                        {' · '}cost {fmt(a.costBase)}
                      </p>
                    </div>
                    <span className={`amount shrink-0 ${a.gain >= 0 ? 'text-[#16a34a]' : 'text-[#ef4444]'}`}>
                      {a.gain >= 0 ? '+' : ''}{fmt(a.gain)}
                    </span>
                  </div>
                ))}
                {e.fees > 0 && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
                    {fmt(e.fees)} of selling costs came off the proceeds before the gain was worked out.
                  </p>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}


// ─── Add Super Fund Modal ────────────────────────────────────────────────────

function AddSuperModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void }) {
  const EMPTY = { fund_name: '', member_number: '', balance: '', employer_contributions: '0', personal_contributions: '0', investment_option: '', insurance_details: '', fees: '0', include_in_net_worth: true };
  const [form, setForm] = useState(EMPTY);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  // Map a parsed value to a string, preserving the existing form value when the
  // field is absent/null. Numeric helper coerces null → '' so we don't render "null".
  const str = (v: unknown, fallback: string) =>
    v === undefined || v === null ? fallback : String(v);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true); setUploadMsg('');
    const { parsed, error } = await parseDocument(file, 'super_statement');
    setUploading(false);
    if (error) { setUploadMsg(error); return; }
    if (parsed) {
      const p = parsed as Record<string, unknown>;
      setForm(f => ({
        ...f,
        fund_name:              str(p.fund_name, f.fund_name),
        member_number:          str(p.member_number, f.member_number),
        balance:                str(p.balance, f.balance),
        employer_contributions: str(p.employer_contributions, f.employer_contributions),
        personal_contributions: str(p.personal_contributions, f.personal_contributions),
        investment_option:      str(p.investment_option, f.investment_option),
        insurance_details:      str(p.insurance_details, f.insurance_details),
        fees:                   str(p.fees, f.fees),
      }));
      setUploadMsg('Statement parsed — please review the details below.');
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...form,
      balance:                parseFloat(form.balance) || 0,
      employer_contributions: parseFloat(form.employer_contributions) || 0,
      personal_contributions: parseFloat(form.personal_contributions) || 0,
      fees:                   parseFloat(form.fees) || 0,
      include_in_investments: false,
      include_in_net_worth:   form.include_in_net_worth,
    });
    setForm(EMPTY);
    setUploadMsg('');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Super Fund">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-zinc-200 dark:border-zinc-800 hover:border-brand/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{uploading ? 'Reading statement…' : 'Upload super statement to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('requires') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>{uploadMsg}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Fund name" value={form.fund_name} onChange={e => setForm(f => ({ ...f, fund_name: e.target.value }))} placeholder="e.g. AustralianSuper" required />
          <Input label="Member number" value={form.member_number} onChange={e => setForm(f => ({ ...f, member_number: e.target.value }))} placeholder="e.g. 1234567" />
        </div>
        <Input label="Current balance" type="number" step="0.01" prefix="$" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} required />
        <div>
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Contributions this financial year</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Employer" type="number" step="0.01" prefix="$" value={form.employer_contributions} onChange={e => setForm(f => ({ ...f, employer_contributions: e.target.value }))} />
            <Input label="Personal" type="number" step="0.01" prefix="$" value={form.personal_contributions} onChange={e => setForm(f => ({ ...f, personal_contributions: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Investment option (optional)" value={form.investment_option} onChange={e => setForm(f => ({ ...f, investment_option: e.target.value }))} placeholder="e.g. High Growth" />
          <Input label="Fees this year (optional)" type="number" step="0.01" prefix="$" value={form.fees} onChange={e => setForm(f => ({ ...f, fees: e.target.value }))} />
        </div>
        <Input label="Insurance details (optional)" value={form.insurance_details} onChange={e => setForm(f => ({ ...f, insurance_details: e.target.value }))} placeholder="e.g. Death $250k; TPD $250k" />
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-zinc-900 dark:text-zinc-100">Count toward net worth</span>
          <Toggle checked={form.include_in_net_worth} onChange={v => setForm(f => ({ ...f, include_in_net_worth: v }))} />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Super Fund</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Pending Employer Super Ledger + Reconciliation ──────────────────────────
interface ExpectedSuper {
  id: string;
  employer: string;
  amount: number;
  pay_period_start: string | null;
  pay_period_end: string | null;
  expected_payment_date: string | null;
  quarter: string | null;
  financial_year: string | null;
  status: string;
}
interface ReconResult {
  financial_year: string;
  expected: number;
  received: number;
  difference: number;
  within_tolerance: boolean;
  tolerance: number;
  matched_count: number;
  flag: 'ok' | 'minor' | 'shortfall';
}

function PendingSuperLedger({ currency }: { currency: string }) {
  const [pending, setPending] = useState<ExpectedSuper[]>([]);
  const [fy, setFy] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [reconOpen, setReconOpen] = useState(false);
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReconResult | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await payrollApi.getAll();
      setFy(data.financial_year);
      setPending((data.expected_super ?? []).filter((e: ExpectedSuper) => e.status === 'pending'));
    } catch { /* ignore */ }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  if (loading) return null;
  if (pending.length === 0 && !result) return null;

  // Group by quarter
  const groups: Record<string, ExpectedSuper[]> = {};
  for (const e of pending) {
    const k = e.quarter ?? 'Unscheduled';
    (groups[k] ??= []).push(e);
  }
  const totalExpected = pending.reduce((s, e) => s + Number(e.amount), 0);

  const runReconcile = async () => {
    setBusy(true);
    try {
      const r = await payrollApi.reconcileSuper({
        employer_contributions: parseFloat(received) || 0,
        financial_year: fy,
      });
      setResult(r);
      setReconOpen(false);
      setReceived('');
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <div className="mt-6">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h3 className="font-semibold">Expected employer super</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Tally of super your employer should have paid (from payslips) · FY {fy}
          </p>
        </div>
        {pending.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setReconOpen(true)}>Reconcile statement</Button>
        )}
      </div>

      {result && (
        <Card className={`mb-3 border ${
          result.flag === 'shortfall' ? 'border-[#ef4444]/40 bg-[#ef4444]/5'
          : result.flag === 'minor' ? 'border-[#f59e0b]/40 bg-[#f59e0b]/5'
          : 'border-[#22c55e]/40 bg-[#22c55e]/5'}`}>
          <p className="text-sm font-medium mb-1">
            {result.flag === 'shortfall' ? '⚠️ Possible employer underpayment'
              : result.flag === 'minor' ? 'Small difference detected'
              : '✓ Contributions reconciled'}
          </p>
          <p className="text-sm">
            Expected {formatCurrency(result.expected, currency)} · received {formatCurrency(result.received, currency)} · difference{' '}
            <span className={result.difference < 0 ? 'text-[#ef4444]' : ''}>{formatCurrency(result.difference, currency)}</span>
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {result.within_tolerance
              ? `Within $${result.tolerance} tolerance — likely fees, review if concerned.`
              : result.flag === 'shortfall'
                ? `Received materially less than expected — investigate whether your employer is paying your super correctly.`
                : `Received more than expected.`}
            {' '}{result.matched_count} pending entr{result.matched_count === 1 ? 'y' : 'ies'} cleared.
          </p>
        </Card>
      )}

      {pending.length > 0 && (
        <Card>
          <div className="flex justify-between items-center mb-3">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Pending (not yet confirmed in fund)</p>
            <p className="text-sm font-semibold amount">{formatCurrency(totalExpected, currency)}</p>
          </div>
          <div className="space-y-4">
            {Object.entries(groups).map(([quarter, rows]) => {
              const qTotal = rows.reduce((s, e) => s + Number(e.amount), 0);
              return (
                <div key={quarter}>
                  <div className="flex justify-between items-center mb-1">
                    <p className="text-xs font-medium">{quarter}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Due {rows[0].expected_payment_date ?? '—'} · {formatCurrency(qTotal, currency)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    {rows.map(e => (
                      <div key={e.id} className="flex items-center justify-between text-sm py-1 border-b border-zinc-200 dark:border-zinc-800 last:border-0">
                        <div>
                          <span className="font-medium">{e.employer}</span>
                          {(e.pay_period_start || e.pay_period_end) && (
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-2">
                              {e.pay_period_start ?? '?'} → {e.pay_period_end ?? '?'}
                            </span>
                          )}
                        </div>
                        <span className="amount">{formatCurrency(Number(e.amount), currency)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Modal isOpen={reconOpen} onClose={() => setReconOpen(false)} title="Reconcile super statement">
        <div className="space-y-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Enter the total employer contributions your super fund received this financial year. We'll compare it
            against the {formatCurrency(totalExpected, currency)} expected from your payslips.
          </p>
          <Input
            label="Employer contributions received"
            type="number" step="0.01" prefix="$"
            value={received}
            onChange={e => setReceived(e.target.value)}
            placeholder="0.00"
          />
          <Button variant="primary" fullWidth disabled={busy} onClick={runReconcile}>
            {busy ? 'Reconciling…' : 'Reconcile'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Regular investments: recurring contribution plans. Each plan can link to a
// holding and/or a detected auto-payment, and spawns a recurring reminder bill.
// When a contribution falls due, a popup asks whether the user invested and
// offers to add it to the linked holding (currencies converted server-side).
// ─────────────────────────────────────────────────────────────────────────────
interface InvestmentPlan {
  id: string;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  next_date: string;
  investment_id: string | null;
  subscription_id: string | null;
  is_active: boolean;
  last_contributed_on: string | null;
  investment?: { id: string; name: string; ticker: string | null; native_currency: string | null; current_price?: number } | null;
  subscription?: { id: string; name: string } | null;
  // Present on /due items: how the prompt was triggered and, for detected debits,
  // the real date/amount that landed in the user's accounts.
  source?: 'schedule' | 'transaction';
  detected_date?: string | null;
  detected_amount?: number | null;
}

const PLAN_FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

function RegularInvestments({ currency, investments }: { currency: string; investments: Investment[] }) {
  const subscriptions = useStore(s => s.subscriptions);
  const [plans, setPlans] = useState<InvestmentPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InvestmentPlan | null>(null);
  const [due, setDue] = useState<InvestmentPlan[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [list, dueList] = await Promise.all([
        investmentPlansApi.getAll(),
        investmentPlansApi.getDue(),
      ]);
      setPlans(list ?? []);
      setDue(dueList ?? []);
    } catch { /* offline / not logged in — show nothing */ }
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const remove = async (id: string) => {
    await investmentPlansApi.remove(id);
    load();
  };

  // Confirm/skip the first due plan, then refresh the linked holding if it changed.
  const respondToDue = async (plan: InvestmentPlan, confirmed: boolean) => {
    setBusy(true);
    try {
      // When a real debit was detected, use its actual amount/date over the estimate.
      const res = await investmentPlansApi.confirm(plan.id, {
        confirmed,
        ...(plan.source === 'transaction' && plan.detected_amount != null ? { amount: plan.detected_amount } : {}),
        ...(plan.source === 'transaction' && plan.detected_date ? { contributed_on: plan.detected_date } : {}),
      });
      if (confirmed && res?.investment) {
        // Reflect the updated holding immediately in the store.
        const s = useStore.getState();
        s.setInvestments(s.investments.map(i => (i.id === res.investment.id ? { ...i, ...res.investment } : i)));
      }
    } catch { /* ignore */ }
    setBusy(false);
    setDue(d => d.filter(p => p.id !== plan.id));
    load();
  };

  if (loading) return null;

  const dueOne = due[0] ?? null;

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-semibold">Regular investments</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Recurring contributions — get a reminder and add them to a holding when they happen.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>+ Add plan</Button>
      </div>

      {plans.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No regular investments yet. Add one if you invest a set amount each week, fortnight or month (e.g. $100/week into VAS).
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {plans.map(p => (
            <Card key={p.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.name}</p>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {formatCurrency(p.amount, p.currency)} · {PLAN_FREQUENCIES.find(f => f.value === p.frequency)?.label ?? p.frequency} · Next: {formatDate(p.next_date)}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {p.investment && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#eaf2fd] text-brand dark:bg-[#15263b]">
                        → {p.investment.name}{p.investment.ticker ? ` (${p.investment.ticker})` : ''}
                      </span>
                    )}
                    {p.subscription && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#e9f6ee] text-[#16a34a] dark:bg-[#13301f]">
                        🔗 {p.subscription.name}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 text-sm shrink-0 text-right">
                  <button onClick={() => { setEditing(p); setFormOpen(true); }} className="text-brand hover:underline">Edit</button>
                  <button onClick={() => remove(p.id)} className="text-zinc-500 hover:text-[#ef4444]">Remove</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <PlanFormModal
          plan={editing}
          currency={currency}
          investments={investments}
          subscriptions={subscriptions}
          onClose={() => setFormOpen(false)}
          onSaved={() => { setFormOpen(false); load(); }}
        />
      )}

      {/* "Did you invest?" confirmation — one due plan at a time. */}
      {dueOne && (
        <Modal isOpen onClose={() => setDue(d => d.slice(1))} title="Did you invest?" size="sm">
          <div className="space-y-4">
            {dueOne.source === 'transaction' ? (
              <p className="text-sm">
                I spotted a payment of <strong>{formatCurrency(dueOne.detected_amount ?? dueOne.amount, dueOne.currency)}</strong>
                {' '}on {formatDate(dueOne.detected_date ?? dueOne.next_date)} that matches your <strong>{dueOne.name}</strong> plan.
                {dueOne.investment
                  ? <> Did this go into <strong>{dueOne.investment.name}</strong>? I’ll add it to that holding.</>
                  : <> Was this your regular contribution?</>}
              </p>
            ) : (
              <p className="text-sm">
                Your plan <strong>{dueOne.name}</strong> was due on {formatDate(dueOne.next_date)}
                {' '}({formatCurrency(dueOne.amount, dueOne.currency)}).
                {dueOne.investment
                  ? <> Did this go into <strong>{dueOne.investment.name}</strong>? I’ll add it to that holding.</>
                  : <> Did you make this contribution?</>}
              </p>
            )}
            {dueOne.investment && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                I’ll add {formatCurrency((dueOne.source === 'transaction' ? dueOne.detected_amount : null) ?? dueOne.amount, dueOne.currency)} of cost and estimate the units at the current price. You can fine-tune the holding afterwards if your broker shows a different fill.
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" fullWidth disabled={busy} onClick={() => respondToDue(dueOne, false)}>Not yet</Button>
              <Button variant="primary" fullWidth disabled={busy} onClick={() => respondToDue(dueOne, true)}>
                {busy ? 'Saving…' : dueOne.investment ? 'Yes, add it' : 'Yes, done'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PlanFormModal({ plan, currency, investments, subscriptions, onClose, onSaved }: {
  plan: InvestmentPlan | null;
  currency: string;
  investments: Investment[];
  subscriptions: Subscription[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState(plan?.name ?? '');
  const [amount, setAmount] = useState(plan ? String(plan.amount) : '');
  const [frequency, setFrequency] = useState(plan?.frequency ?? 'weekly');
  const [nextDate, setNextDate] = useState(plan?.next_date ?? today);
  const [investmentId, setInvestmentId] = useState(plan?.investment_id ?? '');
  const [subscriptionId, setSubscriptionId] = useState(plan?.subscription_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Picking a detected auto-payment prefills amount/frequency/next date from it.
  const onPickSubscription = (id: string) => {
    setSubscriptionId(id);
    const sub = subscriptions.find(s => s.id === id);
    if (sub) {
      if (!amount) setAmount(String(sub.display_amount ?? sub.amount));
      if (sub.frequency && PLAN_FREQUENCIES.some(f => f.value === sub.frequency)) setFrequency(sub.frequency);
      if (sub.next_charge_date) setNextDate(sub.next_charge_date.slice(0, 10));
      if (!name) setName(sub.name);
    }
  };

  const save = async () => {
    if (!name.trim() || !amount || !nextDate) { setErr('Give it a name, amount and next date.'); return; }
    setBusy(true);
    setErr('');
    const payload = {
      name: name.trim(),
      amount: Number(amount) || 0,
      currency,
      frequency,
      next_date: nextDate,
      investment_id: investmentId || null,
      subscription_id: subscriptionId || null,
    };
    try {
      if (plan) await investmentPlansApi.update(plan.id, payload);
      else await investmentPlansApi.create(payload);
      onSaved();
    } catch {
      setErr('Could not save. Try again.');
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={plan ? 'Edit regular investment' : 'Add regular investment'} size="md">
      <div className="space-y-3">
        <Input label="Name" placeholder="e.g. Weekly VAS" value={name} onChange={e => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label={`Amount (${currency})`} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
          <Select label="Frequency" value={frequency} onChange={e => setFrequency(e.target.value)}
            options={PLAN_FREQUENCIES} />
        </div>
        <Input label="Next contribution date" type="date" value={nextDate} onChange={e => setNextDate(e.target.value)} />
        <Select label="Link to a holding (optional)" value={investmentId} onChange={e => setInvestmentId(e.target.value)}
          options={[{ value: '', label: '— Not linked —' }, ...investments.map(i => ({ value: i.id, label: `${i.name}${i.ticker ? ` (${i.ticker})` : ''}` }))]} />
        <Select label="Link to a detected auto-payment (optional)" value={subscriptionId} onChange={e => onPickSubscription(e.target.value)}
          options={[{ value: '', label: '— Not linked —' }, ...subscriptions.map(s => ({ value: s.id, label: `${s.name} · ${formatCurrency(s.display_amount ?? s.amount, s.display_currency ?? s.currency)}` }))]} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          A recurring reminder is added to your bills & reminders so you’re nudged each time. When it’s due, we’ll ask if you invested and add it to the linked holding.
        </p>
        {err && <p className="text-sm text-[#ef4444]">{err}</p>}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" fullWidth onClick={onClose}>Cancel</Button>
          <Button variant="primary" fullWidth disabled={busy} onClick={save}>{busy ? 'Saving…' : plan ? 'Save' : 'Add plan'}</Button>
        </div>
      </div>
    </Modal>
  );
}
