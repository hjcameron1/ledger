/**
 * Phase 4.2 — the budget VIEW MODEL.
 *
 * Everything the Budget UI needs to decide *how to draw a budget* lives here:
 * which tone a line is, how long its bar is, where the projected month-end
 * marker sits, what the one-line status says, how lines are ordered, and
 * whether the legacy planner's goals should be imported.
 *
 * It is deliberately separated from the React component for the same reason
 * `budgeting.ts` is separated from `dataService.ts`: the component then holds
 * no arithmetic and no branching worth testing, and every rule below is
 * exercised directly by `budgetView.test.ts`.
 *
 * NOTHING here re-derives money. Every figure arrives already computed by the
 * Phase 4.1 engine (`buildBudgetReport`) — the single source of truth for
 * spent / remaining / % used / projected / status / rollover. This module only
 * decides how those numbers are presented.
 */

import { addMonthsKey, type BudgetReport, type BudgetReportLine, type BudgetStatus } from './budgeting';
import { round2 } from './cashFlowForecast';

/** Rounding noise: anything smaller than half a cent is nothing. */
const EPSILON = 0.005;

/**
 * What month a line is being read in. Needed for wording that a single line
 * cannot know on its own: whether its projection is still a forecast, and which
 * month a rollover was carried from.
 */
export interface BudgetViewContext {
  /** The month being reported (`YYYY-MM`). */
  month: string;
  /** True once that month is over — a projection becomes a final figure. */
  monthComplete: boolean;
}

// ─── Tone ────────────────────────────────────────────────────────────────────

/** The visual register of a budget line, derived only from its engine status. */
export type BudgetTone =
  /** Within the cap and projected to stay there. */
  | 'ok'
  /** Within the cap but projected to exceed it. */
  | 'warn'
  /** Already past the cap. */
  | 'over'
  /** No cap to measure against. */
  | 'neutral';

const TONE_BY_STATUS: Record<BudgetStatus, BudgetTone> = {
  under: 'ok',
  'at-risk': 'warn',
  over: 'over',
  'no-limit': 'neutral',
};

export function toneFor(status: BudgetStatus): BudgetTone {
  return TONE_BY_STATUS[status] ?? 'neutral';
}

// ─── Bars ────────────────────────────────────────────────────────────────────

export interface BudgetBar {
  /** Width of the filled portion, 0-100. Overspend saturates at 100. */
  fillPct: number;
  /**
   * Where projected month-end lands on the same 0-100 scale, or null when
   * there is nothing useful to mark: no cap, a finished month, or a projection
   * that has already been overtaken by actual spend.
   */
  markerPct: number | null;
  tone: BudgetTone;
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/**
 * Bar geometry for one line.
 *
 * The fill is spend against the EFFECTIVE limit (the month's own cap plus
 * whatever rolled in), so a rollover budget's bar reflects the cap the user
 * actually has this month rather than the nominal one.
 */
export function barFor(line: BudgetReportLine): BudgetBar {
  const tone = toneFor(line.status);
  const limit = line.effectiveLimit;

  if (!(limit > 0)) {
    // No cap: the bar is inert. A full grey track reads as "we're not
    // measuring this", which is honest — a 0%-filled bar would imply room.
    return { fillPct: 0, markerPct: null, tone };
  }

  const fillPct = clampPct((line.spent / limit) * 100);
  const projectedPct = (line.projected / limit) * 100;

  // The marker only earns its place when it says something the fill does not:
  // it must be ahead of today's spend and still on the bar.
  const markerPct = line.projected > line.spent && projectedPct < 100
    ? clampPct(projectedPct)
    : null;

  return { fillPct, markerPct, tone };
}

// ─── Status messages ─────────────────────────────────────────────────────────

/**
 * WHERE THE LINE STANDS RIGHT NOW — money already spent against the cap, and
 * nothing else. Deliberately says nothing about the future: a forecast that
 * shares a sentence with an actual reads as an actual.
 *
 * Returned as DATA rather than a string: the component owns currency
 * formatting (and therefore the user's currency), this module owns which of
 * the three things is worth saying.
 */
export type BudgetMessage =
  /** Past the cap already, by `by`. */
  | { kind: 'over'; by: number }
  /** Inside the cap, with `left` still to spend. */
  | { kind: 'left'; left: number }
  /** Tracked but uncapped — all we can report is what has been spent. */
  | { kind: 'no-limit'; spent: number };

export function messageFor(line: BudgetReportLine): BudgetMessage {
  if (line.status === 'no-limit') return { kind: 'no-limit', spent: line.spent };
  if (line.status === 'over') return { kind: 'over', by: round2(line.spent - line.effectiveLimit) };
  // 'under' and 'at-risk' are both still INSIDE the cap. What separates them is
  // the projection, which is reported on its own below.
  return { kind: 'left', left: round2(line.remaining) };
}

// ─── The projection, kept separate from everything else ──────────────────────

/** Where the month is heading, measured against the cap in force. */
export type ProjectionOutlook =
  /** Projected to finish `by` past the cap. */
  | { kind: 'over'; by: number }
  /** Projected to finish `by` inside the cap. */
  | { kind: 'under'; by: number }
  /** Projected to land on the cap, to the cent. */
  | { kind: 'on-target' }
  /** No cap, so a projection has nothing to be measured against. */
  | { kind: 'untracked' };

export interface BudgetProjectionView {
  /** Projected total spend for the whole month — the engine's own figure. */
  amount: number;
  outlook: ProjectionOutlook;
  /** The month is finished: `amount` is what was spent, not a forecast. */
  final: boolean;
  /** Amber while merely heading over; red only once actually over. */
  tone: BudgetTone;
}

/**
 * Month-end projection as its own statement.
 *
 * This exists because "heading $X over" is a FORECAST and was previously the
 * only thing said about an at-risk budget, sitting where the current position
 * belongs. Splitting them means the user can always read both: what has been
 * spent, and separately what that is on course to become.
 */
export function projectionFor(line: BudgetReportLine, ctx: BudgetViewContext): BudgetProjectionView {
  const final = !!ctx.monthComplete;
  const amount = line.projected;

  if (!(line.effectiveLimit > 0)) {
    return { amount, outlook: { kind: 'untracked' }, final, tone: 'neutral' };
  }

  // The engine already computed limit − projected; never recompute it here.
  const headroom = round2(line.projectedRemaining);
  const outlook: ProjectionOutlook =
    headroom < -EPSILON ? { kind: 'over', by: round2(-headroom) }
      : headroom > EPSILON ? { kind: 'under', by: headroom }
        : { kind: 'on-target' };

  const tone: BudgetTone = outlook.kind !== 'over'
    ? 'ok'
    : line.status === 'over' ? 'over' : 'warn';

  return { amount, outlook, final, tone };
}

// ─── Rollover, as its own set of facts ───────────────────────────────────────

/**
 * What rollover actually did to this month's cap.
 *
 * Reported whenever rollover is ON, including when the carry is zero — a
 * silent absence is indistinguishable from a bug, and "$0.00 carried in" is
 * exactly the answer for a budget in its first month.
 */
export interface BudgetRolloverView {
  enabled: boolean;
  /** Carried in: positive = room earned, negative = debt from overspending. */
  carriedIn: number;
  /** The month it was carried from (`YYYY-MM`). */
  carriedFrom: string;
  /** This month's own cap, before any carry. */
  baseLimit: number;
  /** baseLimit + carriedIn — the cap actually in force. */
  effectiveLimit: number;
  /** This IS the budget's first month, so there was nothing to carry. */
  firstMonth: boolean;
}

export function rolloverFor(line: BudgetReportLine, ctx: BudgetViewContext): BudgetRolloverView {
  return {
    enabled: line.rollover,
    carriedIn: line.rollover ? round2(line.rolloverIn) : 0,
    carriedFrom: addMonthsKey(ctx.month, -1),
    baseLimit: line.baseLimit,
    effectiveLimit: line.effectiveLimit,
    // `>=` rather than `===`: a budget starting next month is likewise yet to
    // have a previous month of its own.
    firstMonth: !!line.startMonth && line.startMonth >= ctx.month,
  };
}

// ─── Line views ──────────────────────────────────────────────────────────────

/** A report line plus every presentation decision made about it. */
export interface BudgetLineView {
  /** Budget row id — null for an unbudgeted category (nothing to edit). */
  id: string | null;
  key: string;
  name: string;
  scope: BudgetReportLine['scope'];
  category: string | null;
  spent: number;
  /** The cap in force this month, rollover included. */
  limit: number;
  /** The cap before rollover — shown when the two differ. */
  baseLimit: number;
  remaining: number;
  percentUsed: number | null;
  projected: number;
  status: BudgetStatus;
  tone: BudgetTone;
  bar: BudgetBar;
  rollover: boolean;
  rolloverIn: number;
  /** Where the line stands NOW. */
  message: BudgetMessage;
  /** Where the month is HEADING — never mixed into `message`. */
  projection: BudgetProjectionView;
  /** What rollover contributed, and to what effective cap. */
  carry: BudgetRolloverView;
}

export function toLineView(line: BudgetReportLine, ctx: BudgetViewContext): BudgetLineView {
  return {
    id: line.id,
    key: line.key,
    name: line.name,
    scope: line.scope,
    category: line.category,
    spent: line.spent,
    limit: line.effectiveLimit,
    baseLimit: line.baseLimit,
    remaining: line.remaining,
    percentUsed: line.percentUsed,
    projected: line.projected,
    status: line.status,
    tone: toneFor(line.status),
    bar: barFor(line),
    rollover: line.rollover,
    rolloverIn: line.rolloverIn,
    message: messageFor(line),
    projection: projectionFor(line, ctx),
    carry: rolloverFor(line, ctx),
  };
}

/**
 * Display order: the lines that need attention first.
 *
 * Over-budget outranks at-risk outranks on-track, and within a band the
 * fullest budget leads. Ties break on name so the list is stable between
 * renders — a budget must not jump around while the user is reading it.
 */
const STATUS_RANK: Record<BudgetStatus, number> = { over: 0, 'at-risk': 1, under: 2, 'no-limit': 3 };

export function sortLineViews(views: BudgetLineView[]): BudgetLineView[] {
  return [...views].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    const pct = (b.percentUsed ?? -1) - (a.percentUsed ?? -1);
    if (Math.abs(pct) > 0.001) return pct;
    const spend = b.spent - a.spent;
    if (Math.abs(spend) > 0.001) return spend;
    return a.name.localeCompare(b.name);
  });
}

// ─── The whole report, ready to render ───────────────────────────────────────

export interface BudgetSummary {
  /** How many category budgets exist. */
  count: number;
  overCount: number;
  atRiskCount: number;
  /** Sum of the category caps in force (rollover included). */
  budgeted: number;
  /** Spend against those caps. */
  spent: number;
  /** All spend this month, budgeted or not — what an overall cap measures. */
  totalSpent: number;
  /** Spend in categories with no cap of their own. */
  unbudgetedSpend: number;
}

export interface BudgetView {
  month: string;
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
  /** True once the month is done — projections stop being predictions. */
  monthComplete: boolean;
  overall: BudgetLineView | null;
  categories: BudgetLineView[];
  unbudgeted: BudgetLineView[];
  summary: BudgetSummary;
  /** No overall budget and no category budgets — show the empty state. */
  isEmpty: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `2026-08` → `August 2026`. Built from the parts, never via Date parsing. */
export function monthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey ?? '');
  if (!m) return monthKey ?? '';
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : monthKey;
}

/** Turn an engine report into everything the UI renders, in display order. */
export function toBudgetView(report: BudgetReport): BudgetView {
  const ctx: BudgetViewContext = {
    month: report.month,
    monthComplete: report.daysElapsed >= report.daysInMonth,
  };
  const view = (l: BudgetReportLine) => toLineView(l, ctx);

  const overall = report.overall ? view(report.overall) : null;
  const categories = sortLineViews(report.categories.map(view));
  const unbudgeted = report.unbudgeted.map(view).sort((a, b) => b.spent - a.spent);

  return {
    month: report.month,
    monthLabel: monthLabel(report.month),
    daysElapsed: report.daysElapsed,
    daysInMonth: report.daysInMonth,
    monthComplete: ctx.monthComplete,
    overall,
    categories,
    unbudgeted,
    summary: {
      count: categories.length,
      overCount: categories.filter(c => c.status === 'over').length,
      atRiskCount: categories.filter(c => c.status === 'at-risk').length,
      budgeted: report.totals.budgeted,
      spent: report.totals.spent,
      totalSpent: report.totalSpent,
      unbudgetedSpend: report.unbudgetedSpend,
    },
    isEmpty: !overall && categories.length === 0,
  };
}

// ─── Migrating off the legacy planner ────────────────────────────────────────
//
// Before Phase 4.2 the Overview budget was a PLANNER: `budget_lines` rows
// carrying a per-category goal, tracked against a separate ad-hoc spend sum.
// Phase 4.2 retires that as a second system — the `budgets` table is now the
// only place a cap is stored — so a user's existing goals must arrive in the
// new world exactly once.

/** Per-user key for the "planner goals already imported" marker. */
export function seedFlagKey(userId: string | null | undefined): string {
  return `budget_phase42_seeded:${userId ?? 'local'}`;
}

export interface SeedDecisionInput {
  /** Has the one-time import already run for this user on this device? */
  alreadySeeded: boolean;
  /** How many budgets exist right now (active or retired, any scope). */
  existingBudgets: number;
  /** How many planner categories carry a goal worth importing. */
  planGoals: number;
}

/**
 * Whether to auto-import the planner's goals.
 *
 * Three independent guards, because an accidental re-import would resurrect
 * budgets the user has deliberately deleted:
 *
 *   1. a per-user device flag — the import is a one-time event;
 *   2. `existingBudgets === 0` — if ANY budget exists, Phase 4.2 is already in
 *      use here (very likely synced from another device that ran the import),
 *      so importing again is at best a no-op and at worst a resurrection;
 *   3. something to import.
 *
 * `budgetsDS.seedFromPlan()` is itself idempotent per category, so this is the
 * outer of two layers rather than the only one.
 */
export function shouldSeedFromPlan(input: SeedDecisionInput): boolean {
  return !input.alreadySeeded && input.existingBudgets === 0 && input.planGoals > 0;
}

/** Planner rows worth importing: a named category with a positive goal. */
export function countPlanGoals(
  lines: { name?: string | null; amount?: number | null; is_category_budget?: boolean }[],
): number {
  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.is_category_budget) continue;
    const name = (l.name ?? '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    if (!((l.amount ?? 0) > 0)) continue;
    seen.add(name);
  }
  return seen.size;
}

// ─── Picking a category to budget ────────────────────────────────────────────

/**
 * Categories offered when adding a budget: everything pickable in the app, plus
 * any category the user has actually spent in this month (so a category that
 * arrived from the bank — and is quietly eating money — can be capped without
 * first being registered anywhere), minus the ones already capped.
 *
 * Order is: spent-in categories first (biggest spend first) since those are
 * what a user reaches for, then the rest of the menu alphabetically.
 */
export function budgetableCategories(
  allCategories: string[],
  spendByCategory: Record<string, number>,
  alreadyBudgeted: string[],
): string[] {
  const taken = new Set(alreadyBudgeted.map(c => (c ?? '').trim().toLowerCase()).filter(Boolean));

  const spent = Object.entries(spendByCategory)
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const name = (raw ?? '').trim();
    const key = name.toLowerCase();
    if (!key || seen.has(key) || taken.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  for (const name of spent) push(name);
  for (const name of [...allCategories].sort((a, b) => a.localeCompare(b))) push(name);
  return out;
}
