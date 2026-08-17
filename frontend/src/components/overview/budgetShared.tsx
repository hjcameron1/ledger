/**
 * Phase 4.2 — shared plumbing for the Budget UI.
 *
 * The card (BudgetSection) and the editor (BudgetManager) both need the same
 * report, the same tone→class mapping and the same wording, so all of it lives
 * here rather than being duplicated or passed down through props.
 *
 * The rule this file exists to enforce: the UI never computes money. It asks
 * `budgetReportDS` for a report, runs it through the pure view model
 * (`utils/budgetView.ts`), and renders the result.
 */

import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { budgetReportDS, budgetsDS, accountIdMatches } from '../../services/dataService';
import {
  toBudgetView, countPlanGoals, shouldSeedFromPlan, seedFlagKey, monthLabel,
  type BudgetMessage, type BudgetTone, type BudgetView, type BudgetLineView,
  type BudgetProjectionView, type BudgetRolloverView,
} from '../../utils/budgetView';
import { formatCurrency } from '../../utils/format';
import type { BudgetReport } from '../../utils/budgeting';
import type { Transaction } from '../../types';

// ─── The report, live ────────────────────────────────────────────────────────

export interface UseBudgetReport {
  report: BudgetReport;
  view: BudgetView;
  /** Recompute now — for the day rolling over, or after a background refresh. */
  refresh: () => void;
}

/**
 * The budget report for a month, recomputed whenever anything it depends on
 * changes: the budgets themselves, the transactions they measure, the split
 * rows that redistribute those transactions, and the signed-in user (whose id
 * scopes the whole report).
 *
 * Because every one of those is a store subscription, an edit made anywhere —
 * this card, the transactions page, a sync landing from another device —
 * refreshes the numbers on the next render with no invalidation to remember.
 */
export function useBudgetReport(opts?: { month?: string; includeUnbudgeted?: boolean }): UseBudgetReport {
  const budgets = useStore(s => s.budgets);
  const transactions = useStore(s => s.transactions);
  const splits = useStore(s => s.transactionSplits);
  const userId = useStore(s => s.user?.id ?? null);

  // Bumped by refresh(); the report also depends on "today", which no store
  // slice can announce.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(n => n + 1), []);

  const month = opts?.month;
  const includeUnbudgeted = opts?.includeUnbudgeted ?? true;

  const report = useMemo(
    () => budgetReportDS.build({ month, includeUnbudgeted }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [budgets, transactions, splits, userId, month, includeUnbudgeted, tick],
  );

  const view = useMemo(() => toBudgetView(report), [report]);

  return { report, view, refresh };
}

// ─── Migrating the legacy planner's goals ────────────────────────────────────

function readSeedFlag(userId: string | null): boolean {
  try { return !!localStorage.getItem(seedFlagKey(userId)); } catch { return false; }
}
function writeSeedFlag(userId: string | null): void {
  try { localStorage.setItem(seedFlagKey(userId), '1'); } catch { /* private mode */ }
}

/** Planner categories still carrying a goal that no budget covers yet. */
export function pendingPlanGoals(): number {
  const s = useStore.getState();
  if (!s.budgetLines.length) return 0;
  const covered = new Set(
    budgetsDS.active()
      .filter(b => b.scope !== 'overall')
      .map(b => (b.category ?? '').trim().toLowerCase()),
  );
  return countPlanGoals(s.budgetLines.filter(l => !covered.has((l.name ?? '').trim().toLowerCase())));
}

/**
 * Import the old planner's category goals as real budgets — once.
 *
 * Phase 4.2 retires the planner as a second store of caps, so a user who had
 * goals must find them already here rather than have to retype them. Guarded
 * by `shouldSeedFromPlan` so it cannot resurrect budgets the user deleted, and
 * flagged afterwards whether or not anything was imported: the offer is a
 * one-time event, not a standing prompt.
 *
 * Returns how many budgets were created.
 */
export function autoSeedPlanGoals(userId: string | null): number {
  const s = useStore.getState();
  const decision = shouldSeedFromPlan({
    alreadySeeded: readSeedFlag(userId),
    existingBudgets: s.budgets.length,
    planGoals: countPlanGoals(s.budgetLines),
  });
  writeSeedFlag(userId);
  return decision ? budgetsDS.seedFromPlan() : 0;
}

/** The same import, run explicitly from the editor. Always allowed to run. */
export function importPlanGoals(userId: string | null): number {
  writeSeedFlag(userId);
  return budgetsDS.seedFromPlan();
}

// ─── Tone → classes ──────────────────────────────────────────────────────────

/** Bar fill. `neutral` is a flat grey: nothing is being measured. */
export const TONE_BAR: Record<BudgetTone, string> = {
  ok: 'bg-brand',
  warn: 'bg-[#f59e0b]',
  over: 'bg-[#ef4444]',
  neutral: 'bg-zinc-300 dark:bg-zinc-700',
};

/** Status text beside a line. */
export const TONE_TEXT: Record<BudgetTone, string> = {
  ok: 'text-zinc-500 dark:text-zinc-400',
  warn: 'text-[#f59e0b]',
  over: 'text-[#ef4444]',
  neutral: 'text-zinc-400 dark:text-zinc-500',
};

/** The headline figure (a big number that itself carries the status). */
export const TONE_HEADLINE: Record<BudgetTone, string> = {
  ok: 'text-zinc-900 dark:text-white',
  warn: 'text-[#f59e0b]',
  over: 'text-[#ef4444]',
  neutral: 'text-zinc-900 dark:text-white',
};

/** A small pill (used for the summary strip). */
export const TONE_PILL: Record<BudgetTone, string> = {
  ok: 'bg-brand/10 text-brand',
  warn: 'bg-[#f59e0b]/10 text-[#f59e0b]',
  over: 'bg-[#ef4444]/10 text-[#ef4444]',
  neutral: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400',
};

// ─── Wording ─────────────────────────────────────────────────────────────────

/**
 * Where the budget stands RIGHT NOW — spent money only.
 *
 * "over budget" and "left" are both statements about what has already
 * happened. Nothing here is a forecast; see `describeProjection`.
 */
export function describeMessage(message: BudgetMessage, currency: string): string {
  switch (message.kind) {
    case 'over':
      return `${formatCurrency(message.by, currency)} over budget`;
    case 'left':
      return `${formatCurrency(message.left, currency)} left`;
    default:
      return 'no cap set';
  }
}

/**
 * Where the month is HEADING, said as a forecast.
 *
 * Always leads with the word "Projected" (or "Final" once the month is done),
 * so a projected overshoot can never be mistaken for money already spent — the
 * confusion the old bare "heading $X over" invited.
 */
export function describeProjection(
  p: BudgetProjectionView, currency: string, opts: { compact?: boolean } = {},
): string {
  const head = p.final
    ? `Final ${formatCurrency(p.amount, currency)}`
    : `${opts.compact ? 'Projected' : 'Projected month-end'} ${formatCurrency(p.amount, currency)}`;

  switch (p.outlook.kind) {
    case 'over':
      return `${head} · ${formatCurrency(p.outlook.by, currency)} over`;
    case 'under':
      return `${head} · ${formatCurrency(p.outlook.by, currency)} under`;
    case 'on-target':
      return `${head} · exactly on budget`;
    default:
      return head;
  }
}

/** The month a rollover was carried from, by name: `July`. */
export function carriedFromLabel(carry: BudgetRolloverView): string {
  return monthLabel(carry.carriedFrom).split(' ')[0] || carry.carriedFrom;
}

/**
 * The amount actually carried in from the previous month — ALWAYS a figure,
 * never an omission. A budget in its own first month reads "$0.00", with the
 * reason, rather than showing nothing and looking broken.
 */
export function describeCarriedIn(
  carry: BudgetRolloverView, currency: string, opts: { short?: boolean } = {},
): string {
  const from = carriedFromLabel(carry);
  if (carry.carriedIn > 0.005) return `+${formatCurrency(carry.carriedIn, currency)} from ${from}`;
  if (carry.carriedIn < -0.005) {
    return `−${formatCurrency(Math.abs(carry.carriedIn), currency)} overspend from ${from}`;
  }
  if (!carry.firstMonth) return `${formatCurrency(0, currency)} from ${from}`;
  return opts.short
    ? `${formatCurrency(0, currency)} (started this month)`
    : `${formatCurrency(0, currency)} — this budget started this month`;
}

/** The cap in force, and the sum it came from. */
export function describeEffectiveBudget(carry: BudgetRolloverView, currency: string): string {
  const base = formatCurrency(carry.baseLimit, currency);
  const effective = formatCurrency(carry.effectiveLimit, currency);
  if (Math.abs(carry.carriedIn) < 0.005) return effective;
  const sign = carry.carriedIn > 0 ? '+' : '−';
  return `${effective}  (${base} ${sign} ${formatCurrency(Math.abs(carry.carriedIn), currency)})`;
}

/** `71%` — or an em dash when there is no cap to be a percentage of. */
export function describePercent(percentUsed: number | null): string {
  return percentUsed == null ? '—' : `${Math.round(percentUsed)}%`;
}

// ─── Small shared bits ───────────────────────────────────────────────────────

/**
 * Transactions filed under a category within a `YYYY-MM`, newest first.
 *
 * The month is matched on the DATE STRING's prefix, exactly as the engine
 * buckets it — a Date comparison would file the 1st of the month into the
 * month before in any negative-offset timezone, and the list would then
 * disagree with the total above it.
 */
export function txnsForCategoryInMonth(
  transactions: Transaction[], category: string, month: string,
): Transaction[] {
  const key = (category ?? '').trim().toLowerCase();
  return transactions
    .filter(t => {
      if ((t.category ?? '').trim().toLowerCase() !== key) return false;
      if ((t.date ?? '').slice(0, 7) !== month) return false;
      return (t.display_amount ?? t.amount ?? 0) < 0;
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Every transaction filed under a category, any date or sign, newest first. */
export function allTxnsForCategory(transactions: Transaction[], category: string): Transaction[] {
  const key = (category ?? '').trim().toLowerCase();
  return transactions
    .filter(t => (t.category ?? '').trim().toLowerCase() === key)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Map a transaction's account_id → a friendly account/card name. */
export function useAccountLookup(): (accountId: string | null | undefined) => string {
  const accounts = useStore(s => s.accounts);
  const creditCards = useStore(s => s.creditCards);
  return useMemo(() => (accountId) => {
    if (!accountId) return 'Cash / manual';
    const bank = accounts.find(a => accountIdMatches(accountId, a));
    if (bank) return bank.name;
    const card = creditCards.find(c => accountIdMatches(accountId, c));
    if (card) return card.name;
    return 'Account';
  }, [accounts, creditCards]);
}

// A distinguishable, theme-agnostic palette for the breakdown donut + legend.
const PALETTE = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#3b82f6',
  '#84cc16', '#eab308',
];
export const colourFor = (i: number) => PALETTE[i % PALETTE.length];

/** Shift a `YYYY-MM` key by whole months. */
export function shiftMonth(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(total / 12);
  return `${String(year).padStart(4, '0')}-${String(total - year * 12 + 1).padStart(2, '0')}`;
}

// ─── The progress bar every budget line uses ─────────────────────────────────

/**
 * A cap bar: spend as a filled proportion of the cap, with a tick showing
 * where the month is projected to end. Overspend saturates the bar at 100% and
 * turns it red — a bar that grew past its track would just be a wider bar.
 */
export function BudgetBar({ bar, height = 'h-1.5', title }: {
  bar: { fillPct: number; markerPct: number | null; tone: BudgetTone };
  height?: string;
  title?: string;
}) {
  return (
    <div className={`relative ${height} rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden`} title={title}>
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${TONE_BAR[bar.tone]}`}
        style={{ width: `${bar.fillPct}%` }}
      />
      {bar.markerPct != null && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-zinc-900/50 dark:bg-white/50"
          style={{ left: `${bar.markerPct}%` }}
        />
      )}
    </div>
  );
}

// ─── The two statements that used to be one ──────────────────────────────────

/**
 * The month-end forecast, on its own line, in its own words.
 *
 * Kept a separate component (rather than a string spliced into the status
 * line) so that every place a budget appears makes the same distinction
 * between spent money and forecast money.
 */
export function ProjectionLine({ line, currency, compact = false, className = '' }: {
  line: BudgetLineView; currency: string; compact?: boolean; className?: string;
}) {
  return (
    <p className={`text-[11px] tabular-nums ${TONE_TEXT[line.projection.tone]} ${className}`}>
      {describeProjection(line.projection, currency, { compact })}
    </p>
  );
}

/**
 * The four figures in full, each labelled: what has been spent, what is left of
 * the cap, where the month is projected to end, and how far that projection
 * lands either side of the cap.
 *
 * Used where there is room for it (the editor), so the user can always find the
 * number behind a one-line summary without doing arithmetic in their head.
 */
export function BudgetFigures({ line, currency }: { line: BudgetLineView; currency: string }) {
  const p = line.projection;

  const overUnder = (() => {
    switch (p.outlook.kind) {
      case 'over': return `${formatCurrency(p.outlook.by, currency)} over`;
      case 'under': return `${formatCurrency(p.outlook.by, currency)} under`;
      case 'on-target': return 'exactly on budget';
      default: return '—';
    }
  })();

  const neutral = 'text-zinc-900 dark:text-white';
  const cells = [
    { label: 'Spent so far', value: formatCurrency(line.spent, currency), tone: neutral },
    {
      label: 'Remaining',
      value: formatCurrency(line.remaining, currency),
      tone: line.remaining < 0 ? TONE_TEXT.over : neutral,
    },
    {
      label: p.final ? 'Final spend' : 'Projected month-end',
      value: formatCurrency(p.amount, currency),
      tone: neutral,
    },
    {
      label: p.final ? 'Finished' : 'Projected over / under',
      value: overUnder,
      tone: TONE_TEXT[p.tone],
    },
  ];

  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
      {cells.map(c => (
        <div key={c.label} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 truncate">
            {c.label}
          </dt>
          <dd className={`text-[13px] font-semibold tabular-nums mt-0.5 ${c.tone}`}>{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What rollover did — and ONLY what rollover did.
 *
 * The rollover control owns the carried amount and the effective cap it
 * produces; the projection lives elsewhere entirely. Renders whenever rollover
 * is on, including a zero carry.
 */
export function RolloverNote({ line, currency, compact = false }: {
  line: BudgetLineView; currency: string; compact?: boolean;
}) {
  const carry = line.carry;
  if (!carry.enabled) return null;

  if (compact) {
    return (
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
        <span aria-hidden="true">⟳</span> Rollover {describeCarriedIn(carry, currency, { short: true })}
        {' · '}effective budget {formatCurrency(carry.effectiveLimit, currency)}
      </p>
    );
  }

  return (
    <dl className="text-[11px] space-y-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-zinc-500 dark:text-zinc-400">Rolled over from last month</dt>
        <dd className="tabular-nums text-zinc-900 dark:text-white text-right">
          {describeCarriedIn(carry, currency)}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-zinc-500 dark:text-zinc-400">Effective budget this month</dt>
        <dd className="tabular-nums text-zinc-900 dark:text-white text-right">
          {describeEffectiveBudget(carry, currency)}
        </dd>
      </div>
    </dl>
  );
}
