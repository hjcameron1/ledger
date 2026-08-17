import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { budgetReportDS } from '../../services/dataService';
import { formatCurrency } from '../../utils/format';
import { monthLabel, type BudgetLineView } from '../../utils/budgetView';
import Card from '../common/Card';
import Modal from '../common/Modal';
import BudgetManager from './BudgetManager';
import {
  useBudgetReport, BudgetBar, ProjectionLine, RolloverNote, TONE_TEXT, TONE_HEADLINE, TONE_PILL,
  describeMessage, describePercent,
  autoSeedPlanGoals, colourFor, shiftMonth, txnsForCategoryInMonth, useAccountLookup,
} from './budgetShared';

// ─────────────────────────────────────────────────────────────────────────────
//  Budget — Phase 4.2.
//
//  ONE system. Every number on this card comes from `budgetReportDS.build()`,
//  which runs the Phase 4.1 engine over the canonical spend definition. There
//  is no second set of goals, no separate spend sum, and no view-local
//  arithmetic: the card renders spent / remaining / % used / projected
//  month-end / status / rollover exactly as the engine reports them.
//
//  Storage is the `budgets` table (scope 'category' | 'overall'), edited only
//  through `budgetsDS`, which upserts by category name so a category can never
//  hold two caps. The pre-4.2 planner (`budget_lines`) is imported once on
//  first load and then left alone forever.
// ─────────────────────────────────────────────────────────────────────────────

const CARD_ROWS = 5;

export default function BudgetSection({ currency }: { currency: string }) {
  const userId = useStore(s => s.user?.id ?? null);
  const { view, refresh } = useBudgetReport();

  const [manageOpen, setManageOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [seeded, setSeeded] = useState(0);

  // One-time migration off the old planner. Runs per user, guarded so it can
  // never resurrect a budget the user deleted (see shouldSeedFromPlan).
  useEffect(() => {
    const imported = autoSeedPlanGoals(userId);
    if (imported > 0) setSeeded(imported);
  }, [userId]);

  // The report depends on "today" as well as on data, and nothing tells us the
  // date changed. Re-check on tab focus — the cheap, correct moment.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // ── Nothing budgeted yet ──
  if (view.isEmpty) {
    return (
      <>
        <Card padding="none" className="p-5">
          <h2 className="text-base font-semibold mb-1">Budget</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            Set a monthly cap on a category — or on everything at once — and Ledger tracks it
            against your real spending, transfers and refunds already excluded.
          </p>
          <button
            onClick={() => setManageOpen(true)}
            className="w-full py-3 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-[12px] text-sm text-zinc-500 dark:text-zinc-400 hover:border-brand/40 hover:text-brand transition-all"
          >
            + Set up a budget
          </button>
          {view.summary.totalSpent > 0 && (
            <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500 text-center">
              {formatCurrency(view.summary.totalSpent, currency)} spent in {view.monthLabel} so far.
            </p>
          )}
        </Card>
        {manageOpen && <BudgetManager onClose={() => setManageOpen(false)} currency={currency} view={view} />}
      </>
    );
  }

  const { overall, categories, summary } = view;
  const shown = categories.slice(0, CARD_ROWS);
  const hidden = categories.length - shown.length;

  return (
    <>
      <Card padding="none" className="p-5">
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Budget</h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {view.monthLabel}
              {!view.monthComplete && ` · day ${view.daysElapsed} of ${view.daysInMonth}`}
            </p>
          </div>
          <button onClick={() => setManageOpen(true)} className="text-xs text-brand hover:underline flex-shrink-0">
            Manage
          </button>
        </div>

        {seeded > 0 && (
          <p className="mb-3 text-[11px] text-brand">
            Imported {seeded} goal{seeded === 1 ? '' : 's'} from your old budget plan — they're real budgets now.
          </p>
        )}

        {/* Hero — the overall cap, or total spend when there isn't one */}
        {overall
          ? <OverallHero line={overall} currency={currency} onOpen={() => setDetailOpen(true)} />
          : <NoOverallHero
              totalSpent={summary.totalSpent}
              monthLabel={view.monthLabel}
              currency={currency}
              onSet={() => setManageOpen(true)}
            />}

        {/* Attention strip */}
        {(summary.overCount > 0 || summary.atRiskCount > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {summary.overCount > 0 && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${TONE_PILL.over}`}>
                {summary.overCount} over budget
              </span>
            )}
            {summary.atRiskCount > 0 && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${TONE_PILL.warn}`}>
                {summary.atRiskCount} projected over
              </span>
            )}
          </div>
        )}

        {/* Category budgets — the ones needing attention first */}
        {categories.length > 0 ? (
          <div className="space-y-3">
            {shown.map(line => <CategoryRow key={line.key} line={line} currency={currency} />)}
          </div>
        ) : (
          <button
            onClick={() => setManageOpen(true)}
            className="w-full py-2.5 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-[10px] text-xs text-zinc-500 dark:text-zinc-400 hover:border-brand/40 hover:text-brand transition-all"
          >
            + Add a category budget
          </button>
        )}

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-1">
          {categories.length > 0 && (
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>Budgeted across {summary.count} categor{summary.count === 1 ? 'y' : 'ies'}</span>
              <span className="font-medium text-zinc-900 dark:text-white tabular-nums">
                {formatCurrency(summary.spent, currency)} / {formatCurrency(summary.budgeted, currency)}
              </span>
            </div>
          )}
          {summary.unbudgetedSpend > 0 && (
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>Spent outside any budget</span>
              <span className="font-medium tabular-nums">{formatCurrency(summary.unbudgetedSpend, currency)}</span>
            </div>
          )}
        </div>

        <button
          onClick={() => setDetailOpen(true)}
          className="mt-3 w-full flex items-center justify-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors"
        >
          <span>{hidden > 0 ? `View all ${categories.length} budgets` : 'View full breakdown'}</span>
          <span>→</span>
        </button>
      </Card>

      {manageOpen && <BudgetManager onClose={() => setManageOpen(false)} currency={currency} view={view} />}
      {detailOpen && (
        <BudgetDetail
          onClose={() => setDetailOpen(false)}
          currency={currency}
          onManage={() => { setDetailOpen(false); setManageOpen(true); }}
        />
      )}
    </>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────────

function OverallHero({ line, currency, onOpen }: {
  line: BudgetLineView; currency: string; onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="rounded-[12px] bg-zinc-100 dark:bg-zinc-900 px-4 py-3.5 mb-4 cursor-pointer hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 transition-colors"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Overall budget
        </p>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
          {describePercent(line.percentUsed)} used
        </p>
      </div>

      <p className={`text-2xl font-bold mt-0.5 tabular-nums ${TONE_HEADLINE[line.tone]}`}>
        {formatCurrency(line.spent, currency)}
        <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {' '}of {formatCurrency(line.limit, currency)}
        </span>
      </p>

      <div className="mt-2.5">
        <BudgetBar bar={line.bar} height="h-2" title={`Projected ${formatCurrency(line.projected, currency)}`} />
      </div>

      {/* Now, then the forecast — two separate statements, in that order. */}
      <div className="mt-1.5 space-y-0.5">
        <p className={`text-[11px] tabular-nums ${TONE_TEXT[line.tone]}`}>
          {describeMessage(line.message, currency)}
        </p>
        <ProjectionLine line={line} currency={currency} />
      </div>

      {line.carry.enabled && (
        <div className="mt-2 pt-2 border-t border-zinc-200/70 dark:border-zinc-800/70">
          <RolloverNote line={line} currency={currency} />
        </div>
      )}
    </div>
  );
}

function NoOverallHero({ totalSpent, monthLabel: label, currency, onSet }: {
  totalSpent: number; monthLabel: string; currency: string; onSet: () => void;
}) {
  return (
    <div className="rounded-[12px] bg-zinc-100 dark:bg-zinc-900 px-4 py-3.5 mb-4">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Total spent · {label}
      </p>
      <p className="text-2xl font-bold mt-0.5 tabular-nums">{formatCurrency(totalSpent, currency)}</p>
      <button onClick={onSet} className="mt-1.5 text-[11px] text-brand hover:underline">
        Set an overall monthly cap →
      </button>
    </div>
  );
}

// ─── One category ────────────────────────────────────────────────────────────

function CategoryRow({ line, currency }: { line: BudgetLineView; currency: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-sm mb-1">
        <span className="font-medium truncate min-w-0 flex items-center gap-1.5">
          {line.name}
          {line.rollover && (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 flex-shrink-0" title="Rolls over">⟳</span>
          )}
        </span>
        <span className="text-xs flex-shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
          {formatCurrency(line.spent, currency)} / {formatCurrency(line.limit, currency)}
        </span>
      </div>
      <BudgetBar bar={line.bar} title={`Projected ${formatCurrency(line.projected, currency)}`} />
      <div className="flex items-center justify-between gap-2 mt-1 text-[11px]">
        <span className={`tabular-nums ${TONE_TEXT[line.tone]}`}>{describeMessage(line.message, currency)}</span>
        <span className="text-zinc-400 dark:text-zinc-500 tabular-nums flex-shrink-0">
          {describePercent(line.percentUsed)}
        </span>
      </div>
      <ProjectionLine line={line} currency={currency} compact />
      <RolloverNote line={line} currency={currency} compact />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  Breakdown — the same engine, one month at a time
// ═════════════════════════════════════════════════════════════════════════════

/** An SVG donut of each category's share of total spend. */
function Donut({ slices, centreLabel, centreSub }: {
  slices: { colour: string; value: number }[]; centreLabel: string; centreSub: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 58, cx = 80, cy = 80, sw = 22;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg viewBox="0 0 160 160" className="w-36 h-36 sm:w-40 sm:h-40 -rotate-90">
      <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={sw} className="stroke-zinc-200 dark:stroke-zinc-800" />
      {total > 0 && slices.filter(s => s.value > 0).map((s, i) => {
        const frac = s.value / total;
        const len = frac * C;
        const offset = -acc * C;
        acc += frac;
        return (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.colour}
            strokeWidth={sw} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={offset} strokeLinecap="butt" />
        );
      })}
      <g transform={`rotate(90 ${cx} ${cy})`}>
        <text x={cx} y={cy - 2} textAnchor="middle" className="fill-zinc-900 dark:fill-white"
          style={{ fontSize: 17, fontWeight: 700 }}>{centreLabel}</text>
        <text x={cx} y={cy + 15} textAnchor="middle" className="fill-zinc-400 dark:fill-zinc-500"
          style={{ fontSize: 9 }}>{centreSub}</text>
      </g>
    </svg>
  );
}

function BudgetDetail({ onClose, currency, onManage }: {
  onClose: () => void; currency: string; onManage: () => void;
}) {
  const transactions = useStore(s => s.transactions);
  const accountName = useAccountLookup();

  const currentMonth = useMemo(() => budgetReportDS.currentMonth(), []);
  const coverageMonth = useMemo(() => budgetReportDS.coverageMonth(), []);
  const [month, setMonth] = useState(currentMonth);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { view } = useBudgetReport({ month });

  // Only offer months whose transactions are actually loaded — an unloaded
  // month reads as zero spend, which would be a lie rather than a gap.
  const canGoBack = month > coverageMonth;
  const canGoForward = month < currentMonth;

  // Everything with spend or a cap, capped budgets first (already ordered by
  // urgency), then uncapped categories by spend.
  const lines = useMemo(() => [...view.categories, ...view.unbudgeted], [view]);
  const totalSpent = view.summary.totalSpent;

  const slices = lines.map((l, i) => ({ colour: colourFor(i), value: l.spent }));

  const tiles = [
    { label: 'Spent', value: formatCurrency(totalSpent, currency), tone: 'text-zinc-900 dark:text-white' },
    {
      label: 'Budgeted',
      value: formatCurrency(view.summary.budgeted, currency),
      tone: 'text-zinc-900 dark:text-white',
    },
    {
      label: view.monthComplete ? 'Final' : 'Projected',
      value: formatCurrency(view.overall?.projected ?? lines.reduce((s, l) => s + l.projected, 0), currency),
      tone: view.overall && view.overall.projected > view.overall.limit
        ? 'text-[#ef4444]' : 'text-zinc-900 dark:text-white',
    },
  ];

  return (
    <Modal isOpen onClose={onClose} title="Budget breakdown" size="xl">
      <div className="space-y-5">

        {/* Month navigator */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => canGoBack && setMonth(shiftMonth(month, -1))}
            disabled={!canGoBack}
            className="px-2.5 py-1.5 text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 disabled:opacity-30 hover:border-brand/40 transition-colors"
            aria-label="Previous month"
          >‹</button>
          <div className="text-center min-w-0">
            <p className="text-sm font-semibold truncate">{monthLabel(month)}</p>
            {!view.monthComplete && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                day {view.daysElapsed} of {view.daysInMonth}
              </p>
            )}
          </div>
          <button
            onClick={() => canGoForward && setMonth(shiftMonth(month, 1))}
            disabled={!canGoForward}
            className="px-2.5 py-1.5 text-sm rounded-[8px] border border-zinc-200 dark:border-zinc-800 disabled:opacity-30 hover:border-brand/40 transition-colors"
            aria-label="Next month"
          >›</button>
        </div>

        {/* Tiles */}
        <div className="grid grid-cols-3 gap-2">
          {tiles.map(t => (
            // Three tiles at 375px leave ~78px each: a five-figure currency
            // value only fits at the smaller step, so the size is per-breakpoint
            // rather than clipped.
            <div key={t.label} className="rounded-[12px] bg-zinc-100 dark:bg-zinc-900 px-2.5 sm:px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.label}</p>
              <p className={`text-sm sm:text-lg font-bold mt-0.5 tabular-nums ${t.tone}`}>{t.value}</p>
            </div>
          ))}
        </div>

        {/* Overall cap, in full */}
        {view.overall && (
          <div className="rounded-[12px] border border-zinc-200 dark:border-zinc-800 px-3.5 py-3">
            <div className="flex items-center justify-between text-sm mb-1.5">
              <span className="font-medium">Overall budget</span>
              <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                {formatCurrency(view.overall.spent, currency)} / {formatCurrency(view.overall.limit, currency)}
              </span>
            </div>
            <BudgetBar bar={view.overall.bar} height="h-2" />
            <div className="mt-1.5 space-y-0.5">
              <p className={`text-[11px] tabular-nums ${TONE_TEXT[view.overall.tone]}`}>
                {describeMessage(view.overall.message, currency)}
              </p>
              <ProjectionLine line={view.overall} currency={currency} />
            </div>
            {view.overall.carry.enabled && (
              <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/60">
                <RolloverNote line={view.overall} currency={currency} />
              </div>
            )}
          </div>
        )}

        {/* Donut + legend */}
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <div className="flex-shrink-0">
            <Donut
              slices={slices}
              centreLabel={formatCurrency(totalSpent, currency)}
              centreSub={`spent · ${monthLabel(month).split(' ')[0]}`}
            />
          </div>
          <div className="flex-1 w-full space-y-1.5">
            {totalSpent === 0 && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No spending recorded in {monthLabel(month)}.
              </p>
            )}
            {lines.filter(l => l.spent > 0).map((l, i) => (
              <div key={l.key} className="flex items-center gap-2 text-sm">
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colourFor(i) }} />
                <span className="font-medium truncate flex-1">{l.name}</span>
                <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">
                  {totalSpent > 0 ? ((l.spent / totalSpent) * 100).toFixed(0) : 0}%
                </span>
                <span className="font-medium tabular-nums w-20 text-right">{formatCurrency(l.spent, currency)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Per-category, expandable to the transactions behind the number */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Categories</p>
            <button onClick={onManage} className="text-xs text-brand hover:underline">Manage budgets</button>
          </div>

          {lines.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing budgeted or spent this month.</p>
          )}

          {lines.map((l, i) => {
            const isOpen = expanded === l.key;
            const txns = isOpen ? txnsForCategoryInMonth(transactions, l.category ?? l.name, month) : [];
            return (
              <div key={l.key} className="rounded-[12px] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : l.key)}
                  className="w-full text-left px-3.5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colourFor(i) }} />
                      <span className="font-medium truncate">{l.name}</span>
                      {l.rollover && <span className="text-[10px] text-zinc-400 flex-shrink-0" title="Rolls over">⟳</span>}
                      {l.id == null && (
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 flex-shrink-0">no budget</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs tabular-nums ${TONE_TEXT[l.tone]}`}>
                        {formatCurrency(l.spent, currency)}
                        {l.limit > 0 && <> / {formatCurrency(l.limit, currency)}</>}
                      </span>
                      <span className={`text-zinc-400 text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                    </div>
                  </div>
                  <BudgetBar bar={l.bar} />
                  <div className="mt-1 space-y-0.5">
                    {l.limit > 0 && (
                      <p className={`text-[11px] tabular-nums ${TONE_TEXT[l.tone]}`}>
                        {describeMessage(l.message, currency)}
                      </p>
                    )}
                    <ProjectionLine line={l} currency={currency} />
                    <RolloverNote line={l} currency={currency} compact />
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
                    {txns.length === 0 && (
                      <p className="px-3.5 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                        No transactions filed under this category in {monthLabel(month)}.
                      </p>
                    )}
                    {txns.map(t => (
                      <div key={t.id} className="flex items-center gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{t.merchant || 'Transaction'}</p>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                            {(t.date ?? '').slice(0, 10)} · {accountName(t.account_id)}
                          </p>
                        </div>
                        <span className="text-sm font-medium tabular-nums flex-shrink-0">
                          {formatCurrency(Math.abs(t.display_amount ?? t.amount ?? 0), currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* A quick way out of "why is this category not capped?" */}
        {view.unbudgeted.length > 0 && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {view.unbudgeted.length} categor{view.unbudgeted.length === 1 ? 'y has' : 'ies have'} spending but no cap —
            {' '}<button onClick={onManage} className="text-brand hover:underline">budget them</button>.
          </p>
        )}
      </div>
    </Modal>
  );
}
