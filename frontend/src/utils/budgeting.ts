/**
 * Phase 4.1 — Budgeting foundation (the pure engine).
 *
 * A budget answers one question per calendar month: "how much of this cap have
 * I used, and where will I land by month end?". Two kinds of cap exist:
 *
 *   • CATEGORY budget — a monthly limit on one spending category (built-in or
 *     user-created; the category is matched case-insensitively by name).
 *   • OVERALL budget  — a single monthly limit on ALL spending, whatever the
 *     category (including categories with no budget of their own).
 *
 * Either kind may ROLL OVER: whatever is left of a month's cap (or overspent
 * from it) carries into the next month, so an underspent January raises the
 * February cap and an overspent January lowers it.
 *
 * What counts as spending is NOT decided here. Every figure comes from the
 * canonical `transactionCore.spendByCategory`, so budgets agree exactly with
 * Accounts, the Forecast and the backend integration summary: genuine outflows
 * only, internal transfers and credit-card repayments excluded, split
 * transactions distributed over their split lines, matched refunds netted
 * against the category they reverse, and each category floored at zero.
 *
 * This module is PURE — no store, no network, no React, `asOf` injected — so
 * every rule below is unit-testable in isolation, and the data-service layer
 * (budgetsDS / budgetReportDS) is the only place that touches state.
 */

import type { Budget, BudgetScope, Transaction } from '../types';
import { spendByCategory, type SpendOptions } from './transactionCore';
import { round2 } from './cashFlowForecast';

/** The reserved key of the single overall (all-spending) budget. */
export const BUDGET_OVERALL_KEY = '__overall__';

/** Hard cap on how many months of history rollover ever accumulates over. */
export const ROLLOVER_MAX_MONTHS = 24;

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

// ─── Month keys ──────────────────────────────────────────────────────────────
//
// A month is identified by its `YYYY-MM` key, and a transaction's month is read
// from the LEADING CHARACTERS of its stored `YYYY-MM-DD` date — never by
// constructing a Date and reading its month. `new Date('2026-08-01')` is UTC
// midnight, which in any negative-offset timezone is still July locally: a
// Date-based comparison silently files the 1st of the month into the month
// before. String keys make the boundary exact everywhere.

/** Local-calendar `YYYY-MM` of a Date. */
export function monthKeyFromDate(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` of an ISO date string or Date. Null when unparseable. */
export function monthKeyOf(date: string | Date | null | undefined): string | null {
  if (!date) return null;
  if (typeof date !== 'string') {
    return Number.isNaN(date.getTime()) ? null : monthKeyFromDate(date);
  }
  const trimmed = date.trim();
  const iso = ISO_DATE_RE.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}`;
  if (MONTH_KEY_RE.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : monthKeyFromDate(parsed);
}

/** Shift a `YYYY-MM` key by whole months (negative = back). */
export function addMonthsKey(key: string, delta: number): string {
  const m = MONTH_KEY_RE.exec(key);
  if (!m) return key;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
}

/** Whole months from `from` to `to` (negative when `to` is earlier). */
export function monthsBetweenKeys(from: string, to: string): number {
  const a = MONTH_KEY_RE.exec(from);
  const b = MONTH_KEY_RE.exec(to);
  if (!a || !b) return 0;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

/** Days in the calendar month a key names (leap years handled). */
export function daysInMonthKey(key: string): number {
  const m = MONTH_KEY_RE.exec(key);
  if (!m) return 30;
  return new Date(Number(m[1]), Number(m[2]), 0).getDate();
}

/** Day-of-month (1-31) of an ISO date string, or null. */
export function dayOfMonth(date: string | Date): number | null {
  if (typeof date !== 'string') {
    return Number.isNaN(date.getTime()) ? null : date.getDate();
  }
  const iso = ISO_DATE_RE.exec(date.trim());
  if (iso) return Number(iso[3]);
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getDate();
}

/** Group transactions by the `YYYY-MM` of their own date. Undated rows dropped. */
export function bucketByMonth(transactions: Transaction[]): Map<string, Transaction[]> {
  const out = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = monthKeyOf(t.date);
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(t);
    else out.set(key, [t]);
  }
  return out;
}

// ─── Budget records → normalised monthly caps ────────────────────────────────

/**
 * A stored budget's limit expressed as a MONTHLY amount. Phase 4.1 budgets are
 * monthly, but the `budgets` table predates it and still allows weekly/yearly
 * rows, so those are converted rather than ignored (a $50/week cap is a
 * $216.67/month cap, using the same 52/26/12 year the rest of Ledger uses).
 */
export function toMonthlyLimit(amount: number, period?: string | null): number {
  const a = Math.abs(Number(amount) || 0);
  switch ((period ?? 'monthly').trim().toLowerCase()) {
    case 'weekly': return round2((a * 52) / 12);
    case 'fortnightly': case 'biweekly': return round2((a * 26) / 12);
    case 'yearly': case 'annual': case 'annually': return round2(a / 12);
    default: return round2(a);
  }
}

/** The identity of a budget: the overall key, or its lower-cased category. */
export function budgetKey(b: Pick<Budget, 'scope' | 'category'>): string | null {
  if ((b.scope ?? 'category') === 'overall') return BUDGET_OVERALL_KEY;
  const cat = (b.category ?? '').trim();
  return cat ? cat.toLowerCase() : null;
}

/** A stored budget reduced to what the engine needs. */
export interface NormalisedBudget {
  id: string;
  /** `__overall__`, or the lower-cased category name. */
  key: string;
  scope: BudgetScope;
  /** Display category name as the user saved it (null for the overall budget). */
  category: string | null;
  /** The cap for one calendar month. */
  monthlyLimit: number;
  rollover: boolean;
  /** First month this budget applies to (`YYYY-MM`), or null for "always". */
  startMonth: string | null;
}

/**
 * Turn stored budget rows into the engine's normalised caps.
 *
 * USER ISOLATION: when `userId` is given, any row stamped with a DIFFERENT
 * user_id is dropped. Rows with no user_id yet are local-only records created
 * offline by the signed-in user and are kept. The store is already purged on a
 * user switch; this is the second, pure line of defence so a leaked row can
 * never reach another account's numbers.
 *
 * Inactive rows are ignored, category rows without a category are ignored, and
 * two rows claiming the same key collapse to the most recently updated one (a
 * duplicate created by two devices racing must not double the cap).
 */
export function normaliseBudgets(
  budgets: Budget[],
  opts: { userId?: string | null } = {},
): NormalisedBudget[] {
  const byKey = new Map<string, { record: NormalisedBudget; stamp: string }>();

  for (const b of budgets) {
    if (b.active === false) continue;
    if (opts.userId && b.user_id && b.user_id !== opts.userId) continue;
    const key = budgetKey(b);
    if (!key) continue;

    const scope: BudgetScope = (b.scope ?? 'category') === 'overall' ? 'overall' : 'category';
    const record: NormalisedBudget = {
      id: b.id,
      key,
      scope,
      category: scope === 'overall' ? null : (b.category ?? '').trim(),
      monthlyLimit: toMonthlyLimit(b.limit_amount, b.period),
      rollover: !!b.rollover_enabled,
      startMonth: monthKeyOf(b.start_month ?? null),
    };
    const stamp = b.updated_at ?? b.created_at ?? '';
    const seen = byKey.get(key);
    if (!seen || stamp >= seen.stamp) byKey.set(key, { record, stamp });
  }

  return [...byKey.values()].map(v => v.record);
}

// ─── Spend for a month ───────────────────────────────────────────────────────

export interface MonthSpend {
  /** Net spend per category name, exactly as transactionCore reports it. */
  byCategory: Record<string, number>;
  /** Net spend across every category — the figure an overall budget caps. */
  total: number;
}

/**
 * Net spend for a set of transactions, delegated wholesale to the canonical
 * `spendByCategory`. Callers pre-filter to the month by KEY (see bucketByMonth)
 * rather than passing a Date window, so month boundaries stay timezone-exact.
 */
export function monthlySpend(transactions: Transaction[], opts: SpendOptions = {}): MonthSpend {
  const byCategory = spendByCategory(transactions, opts);
  let total = 0;
  for (const cat in byCategory) total += byCategory[cat];
  return { byCategory, total: round2(total) };
}

/** Spend filed under one category key, matched case-insensitively. */
export function spendForCategoryKey(byCategory: Record<string, number>, key: string): number {
  let sum = 0;
  for (const cat in byCategory) {
    if (cat.trim().toLowerCase() === key) sum += byCategory[cat];
  }
  return round2(sum);
}

// ─── Month-end projection ────────────────────────────────────────────────────

export interface ProjectMonthEndParams {
  /** Net spend so far this month. */
  spent: number;
  /** Days of the month already observed (0 = month not started, N = complete). */
  daysElapsed: number;
  daysInMonth: number;
  /**
   * Typical spend for a WHOLE month learned from history (adaptiveForecast's
   * per-category `monthlyObserved`). Optional — without it the projection is a
   * pure in-month run rate.
   */
  monthlyRate?: number | null;
  /**
   * Known outflows still to land this month that the learned rate does NOT
   * already contain (a one-off scheduled payment). Anything already visible in
   * history is inside `monthlyRate` — adding it here would double-count.
   */
  scheduledRemaining?: number;
}

/**
 * Project where a month's spend lands by its last day.
 *
 * Early in the month a run rate is noise — three days of groceries says almost
 * nothing about the month — so the learned monthly rate carries most of the
 * weight. As days pass, actual spending earns that weight back: the blend is
 * linear in elapsed fraction, reaching a pure run rate on the final day. With
 * no learned rate the run rate is used alone; with no days elapsed (a future
 * month) the learned rate is used alone.
 *
 * A completed month projects to exactly what was spent, and no projection is
 * ever below what has already been spent.
 */
export function projectMonthEnd(p: ProjectMonthEndParams): number {
  const spent = Math.max(0, Number(p.spent) || 0);
  const daysInMonth = Math.max(1, Number(p.daysInMonth) || 1);
  const elapsed = Math.min(Math.max(0, Number(p.daysElapsed) || 0), daysInMonth);
  const scheduled = Math.max(0, Number(p.scheduledRemaining) || 0);
  const rate = p.monthlyRate != null && p.monthlyRate > 0 ? p.monthlyRate : null;

  // Month already complete — the actuals ARE the outcome.
  if (elapsed >= daysInMonth) return round2(spent);

  // Month hasn't started — only the learned rate and known scheduled outflows.
  if (elapsed <= 0) return round2((rate ?? 0) + scheduled);

  const runRateDaily = spent / elapsed;
  const weight = elapsed / daysInMonth;
  const daily = rate == null
    ? runRateDaily
    : weight * runRateDaily + (1 - weight) * (rate / daysInMonth);

  const projected = spent + daily * (daysInMonth - elapsed) + scheduled;
  return round2(Math.max(spent, projected));
}

// ─── The report ──────────────────────────────────────────────────────────────

export type BudgetStatus =
  /** No positive cap to measure against. */
  | 'no-limit'
  /** Spent and projected to stay within the cap. */
  | 'under'
  /** Still within the cap, but projected to exceed it by month end. */
  | 'at-risk'
  /** Already over the cap. */
  | 'over';

export interface BudgetReportLine {
  /** Budget row id, or null for a category with spend but no budget. */
  id: string | null;
  key: string;
  scope: BudgetScope;
  /** Display name — the category, or "Overall". */
  name: string;
  category: string | null;
  /** The month's own cap, before rollover. */
  baseLimit: number;
  /** Surplus (+) or deficit (−) carried in from earlier months. 0 when off. */
  rolloverIn: number;
  /** What this month actually allows: baseLimit + rolloverIn. */
  effectiveLimit: number;
  spent: number;
  /** effectiveLimit − spent. Negative once overspent. */
  remaining: number;
  /** 0-100+ percentage of the effective limit used; null when there is no cap. */
  percentUsed: number | null;
  /** Projected spend for the whole month (see projectMonthEnd). */
  projected: number;
  /** effectiveLimit − projected. Negative when heading over. */
  projectedRemaining: number;
  rollover: boolean;
  /** What would carry into next month at today's spend (0 when rollover off). */
  rolloverOut: number;
  /**
   * First month this budget applies to (`YYYY-MM`), or null for "always".
   * Carried through so the UI can say WHY nothing rolled in — a budget in its
   * own first month has no earlier month to carry from, which is different
   * from one that simply broke even.
   */
  startMonth: string | null;
  status: BudgetStatus;
}

export interface BudgetProjectionInput {
  /** Learned typical MONTHLY spend per category (case-insensitive lookup). */
  monthlyRateByCategory?: Record<string, number>;
  /** Learned typical monthly spend across all categories. */
  overallMonthlyRate?: number | null;
  /** Known one-off outflows left in the month, per category. */
  scheduledByCategory?: Record<string, number>;
  /** Known one-off outflows left in the month, all categories. */
  scheduledOverall?: number;
}

export interface BuildBudgetReportParams {
  /** Month to report on (`YYYY-MM`). Defaults to the month of `asOf`. */
  month?: string;
  /** "Today" — drives days elapsed and therefore the projection. */
  asOf: string | Date;
  budgets: Budget[];
  transactions: Transaction[];
  /** Scopes budgets AND transactions to one user (see normaliseBudgets). */
  userId?: string | null;
  /** Canonical spend options — the shared transfer-exclusion set and split map. */
  spendOptions?: SpendOptions;
  projection?: BudgetProjectionInput;
  /**
   * Earliest month whose transactions are fully loaded (`YYYY-MM`). Rollover
   * never accumulates from months before it: an unloaded month looks like zero
   * spend, which would invent a full month's surplus and silently inflate the
   * cap. Omit only when `transactions` is the complete history.
   */
  coverageFromMonth?: string | null;
  /** Rollover look-back bound. Defaults to ROLLOVER_MAX_MONTHS. */
  rolloverMaxMonths?: number;
  /** Include categories that have spend but no budget as informational lines. */
  includeUnbudgeted?: boolean;
}

export interface BudgetReport {
  month: string;
  asOf: string;
  daysInMonth: number;
  /** Days of the month observed so far: 0 future, N complete. */
  daysElapsed: number;
  /** The overall spending budget, or null when the user hasn't set one. */
  overall: BudgetReportLine | null;
  /** One line per category budget, biggest cap first. */
  categories: BudgetReportLine[];
  /** Categories with spend but no budget (only when includeUnbudgeted). */
  unbudgeted: BudgetReportLine[];
  /** Spend this month in categories with no budget of their own. */
  unbudgetedSpend: number;
  /** Sums across CATEGORY budgets only — the overall budget is not added in. */
  totals: {
    budgeted: number;
    spent: number;
    remaining: number;
    projected: number;
  };
  /** All spend this month, per category, as transactionCore reports it. */
  spendByCategory: Record<string, number>;
  /** Total net spend this month across every category. */
  totalSpent: number;
}

/**
 * Build the full month report: spent, remaining, percentage used and projected
 * month-end spend for every category budget and for the overall budget, with
 * rollover folded into each cap.
 */
export function buildBudgetReport(params: BuildBudgetReportParams): BudgetReport {
  const asOfKey = monthKeyOf(params.asOf) ?? monthKeyFromDate(new Date());
  const month = params.month && MONTH_KEY_RE.test(params.month) ? params.month : asOfKey;
  const asOfIso = typeof params.asOf === 'string'
    ? params.asOf
    : params.asOf.toISOString().slice(0, 10);

  const userId = params.userId ?? null;
  const transactions = userId
    ? params.transactions.filter(t => !t.user_id || t.user_id === userId)
    : params.transactions;

  const budgets = normaliseBudgets(params.budgets, { userId });
  const spendOptions = params.spendOptions ?? {};
  const buckets = bucketByMonth(transactions);

  // Per-month spend, computed once per month touched (this month + any month
  // rollover walks back through).
  const spendCache = new Map<string, MonthSpend>();
  const spendFor = (key: string): MonthSpend => {
    const hit = spendCache.get(key);
    if (hit) return hit;
    const computed = monthlySpend(buckets.get(key) ?? [], spendOptions);
    spendCache.set(key, computed);
    return computed;
  };

  const current = spendFor(month);

  const daysInMonth = daysInMonthKey(month);
  const daysElapsed = (() => {
    if (month < asOfKey) return daysInMonth;   // fully in the past
    if (month > asOfKey) return 0;             // hasn't started
    const day = dayOfMonth(params.asOf) ?? 1;  // today counts as observed
    return Math.min(Math.max(day, 1), daysInMonth);
  })();

  const maxMonths = Math.max(0, params.rolloverMaxMonths ?? ROLLOVER_MAX_MONTHS);
  const coverage = monthKeyOf(params.coverageFromMonth ?? null);

  /** Spend in `monthKey` that counts against this budget. */
  const spentAgainst = (b: NormalisedBudget, monthKey: string): number => {
    const s = spendFor(monthKey);
    return b.scope === 'overall' ? s.total : spendForCategoryKey(s.byCategory, b.key);
  };

  /**
   * Surplus (+) / deficit (−) carried into `month`. Accumulates
   * (limit − spent) over every earlier month the budget was both ACTIVE and
   * fully OBSERVED, bounded by the look-back. Overspend carries as a debt: an
   * envelope you emptied early is smaller next month, which is the whole point
   * of rollover.
   */
  const rolloverInto = (b: NormalisedBudget): number => {
    if (!b.rollover || maxMonths <= 0) return 0;
    let start = addMonthsKey(month, -maxMonths);
    if (b.startMonth && b.startMonth > start) start = b.startMonth;
    if (coverage && coverage > start) start = coverage;
    if (start >= month) return 0;

    let carry = 0;
    let cursor = start;
    for (let i = 0; i < maxMonths && cursor < month; i++) {
      carry += b.monthlyLimit - spentAgainst(b, cursor);
      cursor = addMonthsKey(cursor, 1);
    }
    return round2(carry);
  };

  const rateFor = (key: string): number | null => {
    const rates = params.projection?.monthlyRateByCategory;
    if (!rates) return null;
    for (const cat in rates) {
      if (cat.trim().toLowerCase() === key) return rates[cat];
    }
    return null;
  };

  const scheduledFor = (key: string): number => {
    const sched = params.projection?.scheduledByCategory;
    if (!sched) return 0;
    let sum = 0;
    for (const cat in sched) {
      if (cat.trim().toLowerCase() === key) sum += sched[cat];
    }
    return sum;
  };

  /**
   * Does this budget exist yet, in this month?
   *
   * A budget created in August says nothing about July, so it is left out of
   * July's report entirely rather than reported as a zero cap the month blew
   * through. Its spend still appears — as an UNBUDGETED category, which is
   * exactly what it was at the time.
   */
  const appliesTo = (b: NormalisedBudget): boolean => !b.startMonth || month >= b.startMonth;

  const lineFor = (b: NormalisedBudget): BudgetReportLine => {
    const spent = spentAgainst(b, month);
    const rolloverIn = rolloverInto(b);
    const baseLimit = round2(b.monthlyLimit);
    const effectiveLimit = round2(baseLimit + rolloverIn);

    const projected = projectMonthEnd({
      spent,
      daysElapsed,
      daysInMonth,
      monthlyRate: b.scope === 'overall'
        ? params.projection?.overallMonthlyRate ?? null
        : rateFor(b.key),
      scheduledRemaining: b.scope === 'overall'
        ? params.projection?.scheduledOverall ?? 0
        : scheduledFor(b.key),
    });

    const limit = effectiveLimit;
    const remaining = round2(limit - spent);
    const percentUsed = limit > 0 ? round2((spent / limit) * 100) : null;
    const projectedRemaining = round2(limit - projected);

    let status: BudgetStatus;
    if (limit <= 0) status = spent > 0 ? 'over' : 'no-limit';
    else if (spent > limit) status = 'over';
    else if (projected > limit) status = 'at-risk';
    else status = 'under';

    return {
      id: b.id,
      key: b.key,
      scope: b.scope,
      name: b.scope === 'overall' ? 'Overall' : (b.category || 'Uncategorised'),
      category: b.category,
      baseLimit,
      rolloverIn,
      effectiveLimit: limit,
      spent,
      remaining,
      percentUsed,
      projected,
      projectedRemaining,
      rollover: b.rollover,
      rolloverOut: b.rollover ? round2(limit - spent) : 0,
      startMonth: b.startMonth,
      status,
    };
  };

  const overallBudget = budgets.find(b => b.scope === 'overall' && appliesTo(b)) ?? null;
  const categoryBudgets = budgets.filter(b => b.scope === 'category' && appliesTo(b));

  const overall = overallBudget ? lineFor(overallBudget) : null;
  const categories = categoryBudgets
    .map(lineFor)
    .sort((a, b) => b.effectiveLimit - a.effectiveLimit || a.name.localeCompare(b.name));

  const budgetedKeys = new Set(categories.map(c => c.key));
  let budgetedSpend = 0;
  for (const c of categories) budgetedSpend += c.spent;

  const unbudgeted: BudgetReportLine[] = [];
  if (params.includeUnbudgeted) {
    for (const cat in current.byCategory) {
      const key = cat.trim().toLowerCase();
      if (budgetedKeys.has(key)) continue;
      const spent = round2(current.byCategory[cat]);
      if (spent <= 0) continue;
      unbudgeted.push({
        id: null,
        key,
        scope: 'category',
        name: cat,
        category: cat,
        baseLimit: 0,
        rolloverIn: 0,
        effectiveLimit: 0,
        spent,
        remaining: round2(-spent),
        percentUsed: null,
        projected: projectMonthEnd({
          spent, daysElapsed, daysInMonth,
          monthlyRate: rateFor(key), scheduledRemaining: scheduledFor(key),
        }),
        projectedRemaining: 0,
        rollover: false,
        rolloverOut: 0,
        startMonth: null,
        status: 'no-limit',
      });
    }
    unbudgeted.sort((a, b) => b.spent - a.spent);
  }

  const totals = categories.reduce(
    (acc, c) => ({
      budgeted: acc.budgeted + c.effectiveLimit,
      spent: acc.spent + c.spent,
      remaining: acc.remaining + c.remaining,
      projected: acc.projected + c.projected,
    }),
    { budgeted: 0, spent: 0, remaining: 0, projected: 0 },
  );

  return {
    month,
    asOf: asOfIso,
    daysInMonth,
    daysElapsed,
    overall,
    categories,
    unbudgeted,
    unbudgetedSpend: round2(Math.max(0, current.total - budgetedSpend)),
    totals: {
      budgeted: round2(totals.budgeted),
      spent: round2(totals.spent),
      remaining: round2(totals.remaining),
      projected: round2(totals.projected),
    },
    spendByCategory: current.byCategory,
    totalSpent: current.total,
  };
}

// ─── Category maintenance ────────────────────────────────────────────────────

/**
 * Re-point budgets after a category is renamed (custom categories can be
 * renamed at any time, and a budget that keeps pointing at the old name goes
 * silently blank).
 *
 * When the new name already has its own budget the renamed row is DEACTIVATED
 * rather than merged — two caps for one category would otherwise double it, and
 * silently summing two user-chosen limits is a guess. Returns a new array;
 * rows that don't change are returned untouched so callers can persist only the
 * difference.
 */
export function applyCategoryRename(budgets: Budget[], from: string, to: string): Budget[] {
  const fromKey = (from ?? '').trim().toLowerCase();
  const toName = (to ?? '').trim();
  const toKey = toName.toLowerCase();
  if (!fromKey || !toKey || fromKey === toKey) return budgets;

  const targetExists = budgets.some(b =>
    b.active !== false &&
    (b.scope ?? 'category') !== 'overall' &&
    (b.category ?? '').trim().toLowerCase() === toKey,
  );

  return budgets.map(b => {
    if ((b.scope ?? 'category') === 'overall') return b;
    if ((b.category ?? '').trim().toLowerCase() !== fromKey) return b;
    return targetExists
      ? { ...b, active: false }
      : { ...b, category: toName };
  });
}

/**
 * Monthly caps implied by the legacy budget-plan categories (`budget_lines`
 * rows with `is_category_budget`), converted from the plan's own period into
 * monthly amounts, skipping any category that already has a Phase 4 budget.
 *
 * Pure, so the one-time import is testable and idempotent — running it twice
 * proposes nothing the second time.
 */
export function budgetsFromLegacyPlan(
  planCategories: { name: string; amount: number }[],
  planPeriod: string | null | undefined,
  existing: Budget[],
): { category: string; monthlyLimit: number }[] {
  const taken = new Set(
    normaliseBudgets(existing).filter(b => b.scope === 'category').map(b => b.key),
  );
  const out: { category: string; monthlyLimit: number }[] = [];
  const seen = new Set<string>();

  for (const line of planCategories) {
    const name = (line.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (taken.has(key) || seen.has(key)) continue;
    const monthlyLimit = toMonthlyLimit(line.amount, planPeriod);
    if (monthlyLimit <= 0) continue;
    seen.add(key);
    out.push({ category: name, monthlyLimit });
  }
  return out;
}
