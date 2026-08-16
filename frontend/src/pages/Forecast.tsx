import { useMemo, useState } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { forecastDS } from '../services/dataService';
import {
  UNALLOCATED,
  type ForecastSourceType,
} from '../utils/cashFlowForecast';
import {
  addDaysISO, buildSeries, openingFor, scopePostings, windowPostings,
  type Scope, type ScopedPosting,
} from '../utils/forecastView';
import { formatCurrency, formatDate, formatRelativeDate } from '../utils/format';
import Card from '../components/common/Card';
import { Select } from '../components/common/Input';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

// ── Phase 3.2 — Cash-flow forecast UI ────────────────────────────────────────
// A thin PRESENTATION layer over the pure engine (utils/cashFlowForecast.ts via
// forecastDS.build). Every projection number — opening balances, per-horizon
// totals, per-account balances, de-duplication and transfer netting — comes from
// the engine. This page only re-shapes the engine's own `events` list into a
// day-by-day balance line and groups them for display; it never re-derives the
// forecast maths (no occurrence generation, no dedup, no sign inference here).

const HORIZONS = [30, 60, 90] as const;
type Horizon = (typeof HORIZONS)[number];

// ── Source presentation ──────────────────────────────────────────────────────
const SOURCE_META: Record<ForecastSourceType, { label: string; badge: string }> = {
  income:           { label: 'Income',       badge: 'bg-[#22c55e]/15 text-[#22c55e]' },
  bill:             { label: 'Bill',         badge: 'bg-[#ef4444]/15 text-[#ef4444]' },
  subscription:     { label: 'Subscription', badge: 'bg-[#a855f7]/15 text-[#a855f7]' },
  recurring_series: { label: 'Detected',     badge: 'bg-[#f59e0b]/15 text-[#f59e0b]' },
  loan:             { label: 'Loan',         badge: 'bg-brand/15 text-brand' },
  credit_card:      { label: 'Card',         badge: 'bg-[#ec4899]/15 text-[#ec4899]' },
  // Learned from transaction history (Phase 3.3) — shown as estimates.
  learned_income:   { label: 'Est. income',  badge: 'bg-[#22c55e]/10 text-[#16a34a] ring-1 ring-[#22c55e]/30' },
  learned_spend:    { label: 'Est. spend',   badge: 'bg-[#64748b]/15 text-[#64748b] ring-1 ring-[#64748b]/30' },
};

function SourceBadge({ type }: { type: ForecastSourceType }) {
  const m = SOURCE_META[type];
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${m.badge}`}>{m.label}</span>;
}

/** Confidence < 1 means the engine isn't certain this movement lands as described
 *  (a detected series, a pending pay run). Surface it so the user weights it. */
function ConfidenceNote({ value }: { value: number }) {
  if (value >= 0.999) return null;
  return (
    <span className="text-[10px] text-zinc-400 dark:text-zinc-500" title="Estimated likelihood this movement occurs as projected">
      ~{Math.round(value * 100)}% likely
    </span>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────
function StatTile({
  label, value, active, tone = 'neutral', onClick, sub,
}: {
  label: string; value: string; active?: boolean; tone?: 'neutral' | 'bad';
  onClick?: () => void; sub?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-colors ${
        active
          ? 'border-brand bg-brand/5'
          : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
      }`}
    >
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`text-xl font-bold mt-1 ${tone === 'bad' ? 'text-[#ef4444]' : 'text-zinc-900 dark:text-zinc-100'}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{sub}</div>}
    </button>
  );
}

function EventRow({ p, currency }: { p: ScopedPosting; currency: string }) {
  const positive = p.amount >= 0;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{p.event.name}</span>
          <SourceBadge type={p.event.sourceType} />
          {p.incoming && <span className="text-[10px] text-zinc-400">transfer in</span>}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatRelativeDate(p.date)}</span>
          <ConfidenceNote value={p.event.confidence} />
        </div>
      </div>
      <span className={`text-sm font-semibold whitespace-nowrap ${positive ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
        {positive ? '+' : '−'}{formatCurrency(Math.abs(p.amount), currency)}
      </span>
    </div>
  );
}

export default function Forecast() {
  const currency = useStore(s => s.user?.currency_preference) ?? 'AUD';
  // Subscribe to the slices forecastDS reads so the forecast recomputes on change.
  const accounts = useStore(s => s.accounts);
  const income = useStore(s => s.incomeEntries);
  const bills = useStore(s => s.bills);
  const subscriptions = useStore(s => s.subscriptions);
  const loans = useStore(s => s.loans);
  const creditCards = useStore(s => s.creditCards);
  const recurringSeries = useStore(s => s.recurringSeries);
  // Phase 3.3: the adaptive layer learns from transaction history, so the
  // forecast must also recompute when transactions change.
  const transactions = useStore(s => s.transactions);

  const [horizon, setHorizon] = useState<Horizon>(30);
  const [scope, setScope] = useState<Scope>('all');

  const forecast = useMemo(
    () => forecastDS.build({ horizons: [...HORIZONS] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, income, bills, subscriptions, loans, creditCards, recurringSeries, transactions],
  );

  const hasAccounts = forecast.accounts.some(a => a.accountId !== UNALLOCATED) || accounts.length > 0;

  // Account filter options: household total, then EVERY visible bank account
  // (sourced from the accounts store so the list is always complete), and the
  // unallocated bucket only if the engine actually routed anything to it. Hidden
  // accounts are excluded here and never reach the forecast (see forecastDS.build).
  const scopeOptions = useMemo(() => {
    const opts = [{ value: 'all', label: 'All accounts' }];
    for (const a of accounts) {
      if (a.hidden) continue;
      opts.push({ value: a.id, label: a.name });
    }
    if (forecast.accounts.some(a => a.accountId === UNALLOCATED)) {
      opts.push({ value: UNALLOCATED, label: 'Unallocated' });
    }
    return opts;
  }, [accounts, forecast.accounts]);

  // If the selected account disappears (e.g. deleted), fall back to household.
  const activeScope: Scope = scopeOptions.some(o => o.value === scope) ? scope : 'all';

  const postings = useMemo(() => scopePostings(forecast, activeScope), [forecast, activeScope]);
  const opening = openingFor(forecast, activeScope);

  // Headline projection at each horizon — cumulated from the engine's events.
  const projByHorizon = useMemo(() => {
    const map = {} as Record<Horizon, ReturnType<typeof buildSeries>>;
    for (const h of HORIZONS) map[h] = buildSeries(opening, postings, forecast.asOf, h);
    return map;
  }, [opening, postings, forecast.asOf]);

  const active = projByHorizon[horizon];
  const inWindow = windowPostings(postings, forecast.asOf, horizon);

  const inflows = inWindow.filter(p => p.amount >= 0);
  const outflows = inWindow.filter(p => p.amount < 0);
  // Pick the 5 largest movements by magnitude, then show them in DATE order so
  // the list reads as a timeline rather than a size ranking.
  const majorEvents = [...inWindow]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const dipsNegative = active.lowest < 0;

  // ── Chart ──────────────────────────────────────────────────────────────────
  const lineColor = dipsNegative ? '#ef4444' : '#3b7dd8';
  const chartData = {
    labels: active.series.map(s => s.date),
    datasets: [{
      data: active.series.map(s => s.balance),
      borderColor: lineColor,
      // Dashed = projected/forecast. The only actual figure is today's opening
      // balance, marked with a solid dot at the left edge (index 0).
      borderDash: [5, 4],
      borderWidth: 2,
      stepped: true as const,
      pointRadius: active.series.map((_, i) => (i === 0 ? 4 : 0)),
      pointBackgroundColor: lineColor,
      pointHoverRadius: 4,
      backgroundColor: (ctx: { chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } } }) => {
        const area = ctx.chart.chartArea;
        if (!area) return 'rgba(59,125,216,0.10)';
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, dipsNegative ? 'rgba(239,68,68,0.18)' : 'rgba(59,125,216,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      },
      fill: true,
    }],
  };
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: { label: string }[]) => formatDate(items[0]?.label ?? ''),
          label: (item: { raw: unknown }) => `Balance: ${formatCurrency(Number(item.raw), currency)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          maxTicksLimit: 6, maxRotation: 0, autoSkip: true,
          color: '#9ca3af', font: { size: 11 },
          callback(this: { getLabelForValue(v: number): string }, value: number) {
            const raw = this.getLabelForValue(value as number);
            const d = new Date(`${raw}T00:00:00Z`);
            return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
          },
        },
      },
      y: {
        grid: { color: 'rgba(120,120,120,0.12)' },
        ticks: {
          color: '#9ca3af', font: { size: 11 },
          callback: (value: number) => formatCurrency(Number(value), currency, true),
        },
      },
    },
  };

  const horizonLabel = `next ${horizon} days`;

  return (
    <Layout>
      <PageHeader
        title="Forecast"
        subtitle="Projected cash balance from your recurring income and bills"
      />

      {!hasAccounts ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">🔮</div>
          <h3 className="font-medium mb-1">No cash forecast yet</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto">
            Add a bank account and your recurring income, bills or subscriptions to
            project your balance 30, 60 and 90 days ahead.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Controls: account filter + horizon switch */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-full sm:w-56">
              <Select
                label="Account"
                options={scopeOptions}
                value={activeScope}
                onChange={e => setScope(e.target.value)}
              />
            </div>
            <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-800 p-0.5">
              {HORIZONS.map(h => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHorizon(h)}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    horizon === h
                      ? 'bg-brand text-white'
                      : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {h}d
                </button>
              ))}
            </div>
          </div>

          {/* 30 / 60 / 90 projected balance — click to switch horizon */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {HORIZONS.map(h => (
              <StatTile
                key={h}
                label={`${h}-day projected balance`}
                value={formatCurrency(projByHorizon[h].closing, currency)}
                sub={`from ${formatCurrency(opening, currency)} today`}
                active={horizon === h}
                tone={projByHorizon[h].closing < 0 ? 'bad' : 'neutral'}
                onClick={() => setHorizon(h)}
              />
            ))}
          </div>

          {/* Balance-over-time chart */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Balance over time</h2>
              <div className="flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: lineColor }} /> Actual today
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-4 border-t-2 border-dashed" style={{ borderColor: lineColor }} /> Projected
                </span>
              </div>
            </div>
            <div className="h-56 sm:h-64">
              <Line data={chartData} options={chartOptions as never} />
            </div>
          </Card>

          {/* Lowest projected balance (liquidity risk) */}
          <Card className={dipsNegative ? 'border border-[#ef4444]/40' : ''}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Lowest projected balance ({horizonLabel})</div>
                <div className={`text-2xl font-bold mt-1 ${dipsNegative ? 'text-[#ef4444]' : 'text-zinc-900 dark:text-zinc-100'}`}>
                  {formatCurrency(active.lowest, currency)}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {active.lowestDate === forecast.asOf ? 'today' : `on ${formatDate(active.lowestDate)} · ${formatRelativeDate(active.lowestDate)}`}
                </div>
              </div>
              <div className="text-3xl">{dipsNegative ? '⚠️' : '✅'}</div>
            </div>
            {dipsNegative && (
              <p className="text-xs text-[#ef4444] mt-3">
                Cash is projected to go negative — you may need to move money in or delay an outflow before then.
              </p>
            )}
          </Card>

          {/* Upcoming inflows / outflows */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <h2 className="font-semibold mb-1">Upcoming inflows</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                {inflows.length ? `${formatCurrency(inflows.reduce((s, p) => s + p.amount, 0), currency)} in over the ${horizonLabel}` : `Nothing expected in the ${horizonLabel}`}
              </p>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {inflows.length === 0 ? (
                  <p className="text-sm text-zinc-400 py-4 text-center">No inflows projected</p>
                ) : inflows.map((p, i) => <EventRow key={`${p.event.sourceId}-${p.date}-${i}`} p={p} currency={currency} />)}
              </div>
            </Card>
            <Card>
              <h2 className="font-semibold mb-1">Upcoming outflows</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                {outflows.length ? `${formatCurrency(Math.abs(outflows.reduce((s, p) => s + p.amount, 0)), currency)} out over the ${horizonLabel}` : `Nothing due in the ${horizonLabel}`}
              </p>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {outflows.length === 0 ? (
                  <p className="text-sm text-zinc-400 py-4 text-center">No outflows projected</p>
                ) : outflows.map((p, i) => <EventRow key={`${p.event.sourceId}-${p.date}-${i}`} p={p} currency={currency} />)}
              </div>
            </Card>
          </div>

          {/* Major events */}
          {majorEvents.length > 0 && (
            <Card>
              <h2 className="font-semibold mb-2">Major events ({horizonLabel})</h2>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {majorEvents.map((p, i) => <EventRow key={`major-${p.event.sourceId}-${p.date}-${i}`} p={p} currency={currency} />)}
              </div>
            </Card>
          )}

          {/* Adaptive footnote — learned income/spend are estimates, not
              scheduled obligations; say so plainly so they're read as such. */}
          {forecast.events.some(e => e.sourceType === 'learned_income' || e.sourceType === 'learned_spend') && (
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 text-center">
              Items badged <span className="font-medium">Est.</span> are learned from your recent transaction history — typical income and spending, not confirmed bills.
            </p>
          )}

          {/* Provenance footnote — the engine excludes duplicate records from
              totals but keeps them for audit; surface the count for trust. */}
          {forecast.suppressed.length > 0 && (
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 text-center">
              {forecast.suppressed.length} duplicate {forecast.suppressed.length === 1 ? 'record' : 'records'} excluded to avoid double-counting.
            </p>
          )}
        </div>
      )}
    </Layout>
  );
}
