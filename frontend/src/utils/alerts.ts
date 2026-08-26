/**
 * Phase 4.4 — proactive financial alerts (pure engine).
 *
 * ONE place that decides what is worth interrupting the user about. It derives
 * every alert from reports the existing engines have ALREADY produced:
 *
 *   • `buildBudgetReport`      (Phase 4.1) — spent / cap / projected month-end
 *   • `buildGoalReport`        (Phase 4.3) — required vs allocated per goal
 *   • `buildCashFlowForecast`  (Phase 3.1) — the projected low point in cash
 *   • `learnFromHistory`       (Phase 3.3) — a category's normal month
 *   • `buildInsuranceReport`   (Phase 8.2) — when cover renews, and whether it
 *                                            has already run out
 *
 * Nothing here re-derives money. It compares numbers those engines computed
 * against thresholds and decides whether the comparison is worth saying out
 * loud, so an alert can never disagree with the card it points at.
 *
 * ── Identity, and why alerts don't repeat ────────────────────────────────────
 * An alert is not an event that happened; it is a CONDITION that currently
 * holds. Rebuilding the report re-derives the same alert with the same `key`,
 * so nothing accumulates and nothing duplicates. When the condition stops
 * holding the alert simply isn't produced — that is what "resolved" means, and
 * its stored state is reported back in `resolvedKeys` so the caller can drop it.
 *
 * ── Dismissal, and why a dismissal can expire ────────────────────────────────
 * Every alert carries a `stage`: a small integer that rises as the situation
 * gets materially worse (nearing a cap → past it → well past it). Dismissing an
 * alert records the stage it was dismissed AT, and the alert stays hidden only
 * while it is still at or below that stage. Cross the next threshold and it
 * comes back — which is the whole point of an alert. That single rule covers
 * "don't nag me about this" and "tell me when it gets worse" without storing a
 * separate reminder schedule.
 *
 * Pure and dependency-injected (`asOf` and every report passed in), so the DS
 * layer (`alertsDS`) is the only thing that touches state, and every rule below
 * is exercised directly by `alerts.test.ts`.
 */

import type { BudgetReport, BudgetReportLine } from './budgeting';
import type { CashFlowForecast } from './cashFlowForecast';
import { round2, UNALLOCATED } from './cashFlowForecast';
import { DAYS_PER_MONTH, type GoalLine, type GoalReport } from './savingsGoals';
import type { InsuranceLine, InsuranceReport } from './insurance';

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * When a comparison becomes worth saying.
 *
 * Every value is a threshold on an EXISTING engine figure, never a new way of
 * measuring money. Kept in one exported object so the tests pin the defaults
 * and a caller can tune them without touching the rules.
 */
export interface AlertThresholds {
  /** % of the effective cap that counts as "nearing the limit". */
  budgetNearPct: number;
  /** % of the cap beyond which "over" becomes "well over". */
  budgetWellOverPct: number;
  /** Ignore a projected overspend smaller than this — it is rounding, not news. */
  projectedOverMin: number;
  /** Ignore a goal shortfall smaller than this per month. */
  goalShortfallMin: number;
  /** Cash buffer = this many months of the forecast's own projected outflow. */
  cashBufferMonths: number;
  /** …but never a smaller buffer than this, so a low-outflow month still has a floor. */
  cashBufferMin: number;
  /** Spending is "unusual" at this multiple of the category's normal month. */
  unusualRatio: number;
  /** …and at this multiple again, it is unusual enough to raise the severity. */
  unusualHighRatio: number;
  /** Ignore an overshoot smaller than this in absolute dollars. */
  unusualMin: number;
  /** Ignore categories whose normal month is trivially small (percentages lie there). */
  unusualBaselineMin: number;
  /** Days of the month that must have passed before spending can be called unusual. */
  unusualMinDaysElapsed: number;
  /**
   * Days before a renewal at which "renews soon" becomes "renews this week".
   *
   * Only the ESCALATION point lives here. What counts as "soon" at all is the
   * insurance engine's own decision (it is what makes a policy `due-soon`), and
   * restating it here would be two definitions of one boundary.
   */
  renewalImminentDays: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  budgetNearPct: 80,
  budgetWellOverPct: 125,
  projectedOverMin: 10,
  goalShortfallMin: 5,
  cashBufferMonths: 0.5,
  cashBufferMin: 200,
  unusualRatio: 1.5,
  unusualHighRatio: 2.5,
  unusualMin: 50,
  unusualBaselineMin: 20,
  unusualMinDaysElapsed: 10,
  renewalImminentDays: 7,
};

// ─── What an alert is ────────────────────────────────────────────────────────

export type AlertKind =
  /** A budget is close to, or past, its cap. */
  | 'budget-limit'
  /** A budget is still inside its cap but heading past it by month end. */
  | 'budget-projected-over'
  /** A goal will not reach its target date on the money the forecast frees up. */
  | 'goal-behind'
  /** Projected bank cash dips below a sensible buffer, or below zero. */
  | 'cash-low'
  /** A category is spending well above its own recent normal. */
  | 'unusual-spend'
  /** An insurance policy is about to renew — or has already lapsed. */
  | 'insurance-renewal';

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Where an alert points. `to` is an in-app path, ready for `navigate()`. */
export interface AlertLink {
  to: string;
  label: string;
}

/**
 * The NUMBERS behind an alert, as data rather than a sentence.
 *
 * The component owns currency and date formatting (and therefore the user's
 * locale); this module owns which figures the sentence is allowed to use. Same
 * split as `GoalMessage` in goalView.ts.
 */
export type AlertFacts =
  | {
    kind: 'budget-limit';
    name: string;
    spent: number;
    limit: number;
    /** Left in the cap. Negative once overspent. */
    remaining: number;
    percentUsed: number;
    /** How far past the cap, 0 while still inside it. */
    over: number;
  }
  | {
    kind: 'budget-projected-over';
    name: string;
    spent: number;
    limit: number;
    projected: number;
    /** projected − limit, always > 0 when this alert exists. */
    by: number;
  }
  | {
    kind: 'goal-behind';
    name: string;
    remaining: number;
    requiredPerMonth: number;
    allocatedPerMonth: number;
    shortfallPerMonth: number;
    targetDate: string | null;
    /** Days past the target date. 0 unless the goal is overdue. */
    daysPast: number;
  }
  | {
    kind: 'cash-low';
    /** The lowest the forecast expects total bank cash to reach. */
    lowest: number;
    lowestDate: string;
    /** The buffer it fell below — derived from the forecast's own outflow. */
    buffer: number;
    openingBalance: number;
    horizonDays: number;
  }
  | {
    kind: 'unusual-spend';
    category: string;
    spent: number;
    projected: number;
    /** The category's normal month, learned from history. */
    baseline: number;
    /** projected ÷ baseline. */
    multiple: number;
  }
  | {
    kind: 'insurance-renewal';
    name: string;
    insurer: string | null;
    policyType: string;
    renewalDate: string;
    /** Days until it renews. NEGATIVE once the date has passed. */
    daysToRenewal: number;
    /** True when cover has run out and nothing has renewed it. */
    expired: boolean;
    /** What it is billed, and what that is a year — a renewal is the one moment
     *  the yearly cost is worth knowing. */
    premium: number;
    annualPremium: number;
  };

export interface Alert {
  /**
   * Stable identity of the CONDITION. Rebuilding produces the same key, which is
   * what makes alerts idempotent and dismissals durable. Month-scoped where the
   * condition is month-scoped, so a new month is genuinely new news.
   */
  key: string;
  kind: AlertKind;
  /** Rises as the situation worsens. A dismissal only holds at or below it. */
  stage: number;
  severity: AlertSeverity;
  /** Short heading — never contains money, so the component owns all formatting. */
  title: string;
  facts: AlertFacts;
  link: AlertLink;
  /** False once the user has seen it at this stage or worse. */
  unread: boolean;
  /** True while a dismissal at this stage or higher is in force. */
  dismissed: boolean;
}

/** One stored dismissal/read record, as the DS holds it. */
export interface AlertStateInput {
  key: string;
  /** Stage the user dismissed at, or null if never dismissed. */
  dismissedStage: number | null;
  /** Stage the user has read up to, or null if never read. */
  readStage: number | null;
}

export interface AlertReport {
  asOf: string;
  /** Everything currently firing, worst first — dismissed ones included. */
  all: Alert[];
  /** What the user should actually see: `all` minus dismissed, same order. */
  visible: Alert[];
  /** Visible alerts not yet read at their current stage. */
  unreadCount: number;
  /**
   * Keys with a stored dismissal/read record whose condition no longer holds.
   * The caller drops these so a condition that returns is not silently
   * suppressed by a dismissal made about a situation that has since passed.
   */
  resolvedKeys: string[];
}

export interface BuildAlertsParams {
  /** Today, `YYYY-MM-DD`. Injected for determinism. */
  asOf: string;
  /** Built with `includeUnbudgeted: true` so every spending category is visible. */
  budget: BudgetReport;
  goals: GoalReport;
  forecast: CashFlowForecast;
  /**
   * A normal month per category, learned by `learnFromHistory` (the same figure
   * the budget projection already leans on). Matched case-insensitively.
   */
  baselineByCategory?: Record<string, number>;
  /**
   * The insurance report (Phase 8.2), when the caller has one. Renewals are
   * raised from its lines; no policy arithmetic happens here.
   */
  insurance?: InsuranceReport | null;
  /** Stored dismissal/read state, from `alert_states`. */
  states?: AlertStateInput[];
  thresholds?: Partial<AlertThresholds>;
}

// ─── Ordering ────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Ties between equally severe alerts break on KIND, not on name, so the list
 * reads in a consistent order every render: money you have already spent, then
 * money you are about to, then cash running out, then the softer signals.
 */
const KIND_RANK: Record<AlertKind, number> = {
  'budget-limit': 0,
  'budget-projected-over': 1,
  'cash-low': 2,
  // A date you can miss outranks the softer signals: lapsed cover and a renewal
  // this week are both deadlines, and the other two are observations.
  'insurance-renewal': 3,
  'goal-behind': 4,
  'unusual-spend': 5,
};

export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    if (a.stage !== b.stage) return b.stage - a.stage;
    return a.key.localeCompare(b.key);
  });
}

// ─── The builders, one per kind ──────────────────────────────────────────────

const categoryKey = (name: string): string => (name ?? '').trim().toLowerCase();

/** Look a category up case-insensitively, the way the budget engine does. */
function lookupCategory(map: Record<string, number> | undefined, key: string): number {
  if (!map) return 0;
  for (const name in map) {
    if (categoryKey(name) === key) return map[name];
  }
  return 0;
}

/**
 * A budget's own alert — at most ONE per budget per month.
 *
 * Three conditions could each fire on the same cap, and saying all three at once
 * would be three notifications about one budget. They are strictly ordered by
 * how settled the news is, and only the most settled is reported:
 *
 *   1. already over the cap        → `budget-limit`, stage 2 (or 3 well over)
 *   2. heading over by month end   → `budget-projected-over`
 *   3. merely nearing the cap      → `budget-limit`, stage 1
 *
 * (2) supersedes (3) because it already implies the cap is under pressure and
 * adds the part the user cannot see: where the month lands.
 */
function budgetAlert(
  line: BudgetReportLine,
  month: string,
  t: AlertThresholds,
): Alert | null {
  const limit = line.effectiveLimit;
  if (!(limit > 0)) return null; // nothing to be near, or over

  const label = line.scope === 'overall' ? 'Overall spending' : line.name;
  const link: AlertLink = {
    to: `/?focus=budget:${encodeURIComponent(line.key)}`,
    label: 'View budget',
  };
  const percentUsed = line.percentUsed ?? round2((line.spent / limit) * 100);

  // 1. Already over.
  if (line.spent > limit) {
    const over = round2(line.spent - limit);
    const wellOver = percentUsed >= t.budgetWellOverPct;
    return {
      key: `budget-limit:${month}:${line.key}`,
      kind: 'budget-limit',
      stage: wellOver ? 3 : 2,
      severity: 'critical',
      title: `${label} is over budget`,
      facts: {
        kind: 'budget-limit',
        name: label,
        spent: line.spent,
        limit,
        remaining: line.remaining,
        percentUsed: round2(percentUsed),
        over,
      },
      link,
      unread: true,
      dismissed: false,
    };
  }

  // 2. Still inside the cap, but the projection says not for long.
  const projectedOver = round2(line.projected - limit);
  if (projectedOver >= t.projectedOverMin) {
    return {
      key: `budget-projected-over:${month}:${line.key}`,
      kind: 'budget-projected-over',
      stage: 1,
      severity: 'warning',
      title: `${label} is heading over budget`,
      facts: {
        kind: 'budget-projected-over',
        name: label,
        spent: line.spent,
        limit,
        projected: line.projected,
        by: projectedOver,
      },
      link,
      unread: true,
      dismissed: false,
    };
  }

  // 3. Nearing the cap, and not projected to breach it.
  if (percentUsed >= t.budgetNearPct) {
    return {
      key: `budget-limit:${month}:${line.key}`,
      kind: 'budget-limit',
      stage: 1,
      severity: 'warning',
      title: `${label} is nearing its limit`,
      facts: {
        kind: 'budget-limit',
        name: label,
        spent: line.spent,
        limit,
        remaining: line.remaining,
        percentUsed: round2(percentUsed),
        over: 0,
      },
      link,
      unread: true,
      dismissed: false,
    };
  }

  return null;
}

/**
 * A goal that will not make its date.
 *
 * Only ever raised on the engine's own verdict — never re-derived here. A goal
 * whose status is `unknown` (no forecast to judge affordability against) raises
 * nothing at all: an alert built on an admitted absence of information would be
 * a guess dressed as a warning.
 */
function goalAlert(line: GoalLine, t: AlertThresholds): Alert | null {
  const link: AlertLink = { to: `/?focus=goal:${encodeURIComponent(line.id)}`, label: 'View goal' };
  const base = {
    name: line.name,
    remaining: line.remaining,
    requiredPerMonth: line.requiredPerMonth ?? 0,
    allocatedPerMonth: line.allocatedPerMonth,
    shortfallPerMonth: line.shortfallPerMonth,
    targetDate: line.targetDate,
  };

  // The date has passed and the goal is still short — a fact, not a projection,
  // so it stands whether or not there is a forecast.
  if (line.status === 'overdue') {
    return {
      key: `goal-behind:${line.id}`,
      kind: 'goal-behind',
      stage: 3,
      severity: 'critical',
      title: `${line.name} passed its target date`,
      facts: { kind: 'goal-behind', ...base, daysPast: Math.abs(line.daysRemaining ?? 0) },
      link,
      unread: true,
      dismissed: false,
    };
  }

  if (line.status !== 'behind' && line.status !== 'at-risk') return null;
  if (line.shortfallPerMonth < t.goalShortfallMin) return null;

  const behind = line.status === 'behind';
  return {
    key: `goal-behind:${line.id}`,
    kind: 'goal-behind',
    // `behind` (nothing at all is reaching it) is the worse of the two, so a
    // dismissal made while it was merely at risk does not silence it.
    stage: behind ? 2 : 1,
    severity: 'warning',
    title: behind ? `${line.name} is not being funded` : `${line.name} is falling behind`,
    facts: { kind: 'goal-behind', ...base, daysPast: 0 },
    link,
    unread: true,
    dismissed: false,
  };
}

/**
 * Cash running low.
 *
 * The trough is the forecast's own `lowestBalance` — the figure the Forecast
 * page already draws — so the alert and the chart can never disagree. What
 * counts as "low" is scaled to the user's own spending: half a month of the
 * outflow this very forecast projects, floored so that a quiet horizon still
 * has a sensible minimum. A fixed dollar threshold would nag one household
 * constantly and never warn another.
 */
function cashAlert(forecast: CashFlowForecast, t: AlertThresholds): Alert | null {
  // L3 (stress audit): with no bank accounts there is no cash to run low —
  // a brand-new user's first screen must not open with a warning about money
  // they have not told us about. The engine itself refuses, rather than
  // trusting every caller's readiness gate.
  if (!forecast.accounts.some(a => a.accountId !== UNALLOCATED)) return null;
  const horizon = forecast.horizons[forecast.horizons.length - 1];
  if (!horizon || !(horizon.days > 0)) return null;

  const months = horizon.days / DAYS_PER_MONTH;
  const monthlyOutflow = months > 0 ? Math.abs(horizon.outflow) / months : 0;
  const buffer = round2(Math.max(t.cashBufferMin, monthlyOutflow * t.cashBufferMonths));

  const lowest = horizon.lowestBalance;
  if (lowest >= buffer) return null;

  const negative = lowest < 0;
  return {
    key: 'cash-low',
    kind: 'cash-low',
    stage: negative ? 2 : 1,
    severity: negative ? 'critical' : 'warning',
    title: negative ? 'Your accounts are projected to run out' : 'Cash is projected to run low',
    facts: {
      kind: 'cash-low',
      lowest,
      lowestDate: horizon.lowestDate,
      buffer,
      openingBalance: horizon.openingBalance,
      horizonDays: horizon.days,
    },
    link: { to: '/forecast', label: 'View forecast' },
    unread: true,
    dismissed: false,
  };
}

/**
 * A category spending well above its own normal.
 *
 * Compares two figures that already exist: the budget engine's projected
 * month-end spend for the category, and the monthly average the adaptive
 * learner derived from recent history.
 *
 * Three guards, and the first is the one that matters most. Early in a month a
 * run rate is almost pure noise — one week's groceries bought on the 2nd
 * projects to five times a normal month — and `projectMonthEnd` only damps that,
 * it cannot remove it, because a projection may never fall below what has
 * already been spent. So nothing is called unusual until enough of the month has
 * actually happened for the rate to mean something. After that, both a ratio and
 * an absolute floor must be cleared, so a category that normally costs $12 and
 * cost $30 this month stays quiet too.
 */
function unusualSpendAlert(
  line: BudgetReportLine,
  baseline: number,
  month: string,
  daysElapsed: number,
  t: AlertThresholds,
): Alert | null {
  if (daysElapsed < t.unusualMinDaysElapsed) return null;
  if (!(baseline >= t.unusualBaselineMin)) return null;
  const projected = line.projected;
  const excess = round2(projected - baseline);
  if (excess < t.unusualMin) return null;
  const multiple = projected / baseline;
  if (multiple < t.unusualRatio) return null;

  const high = multiple >= t.unusualHighRatio;
  return {
    key: `unusual-spend:${month}:${line.key}`,
    kind: 'unusual-spend',
    stage: high ? 2 : 1,
    severity: high ? 'warning' : 'info',
    title: `${line.name} spending is unusually high`,
    facts: {
      kind: 'unusual-spend',
      category: line.name,
      spent: line.spent,
      projected,
      baseline: round2(baseline),
      multiple: round2(multiple),
    },
    link: {
      to: `/accounts?tab=transactions&category=${encodeURIComponent(line.name)}`,
      label: 'View transactions',
    },
    unread: true,
    dismissed: false,
  };
}

/**
 * Insurance: a renewal coming, or cover that has already run out.
 *
 * The two things a person can actually miss about a policy, and the only two
 * this raises. Every figure comes from the insurance engine's own line — the
 * status, the day count, the annualised premium — so the warning and the
 * Insurance page cannot disagree about when cover ends.
 *
 * Three stages on one condition, because it is one condition getting worse:
 *
 *   1. renewing inside the reminder window   (info)
 *   2. renewing within the week              (warning)
 *   3. the date has passed, cover may have lapsed (critical)
 *
 * The key carries the RENEWAL DATE, so renewing a policy retires the old alert
 * (its condition no longer holds, its dismissal is reported as resolved) and the
 * next year's renewal arrives as genuinely new news rather than as something the
 * user silenced twelve months ago.
 *
 * A lapsed policy keeps warning for as long as it is marked as held: there is no
 * quiet cutoff after which "you have no cover" stops being worth saying. The way
 * out is to renew it, or to say you no longer hold it — either of which resolves
 * the alert honestly. Dismissing at stage 3 silences it too, which is the user's
 * call to make.
 */
function insuranceAlert(line: InsuranceLine, t: AlertThresholds): Alert | null {
  // No date, nothing to be early or late for. Cover the user no longer holds
  // raises nothing at all — an ex-policy cannot lapse.
  if (!line.active || !line.renewalDate || line.daysToRenewal == null) return null;
  if (line.status !== 'expired' && line.status !== 'due-soon') return null;

  const days = line.daysToRenewal;
  const facts: AlertFacts = {
    kind: 'insurance-renewal',
    name: line.name,
    insurer: line.insurer,
    policyType: line.type,
    renewalDate: line.renewalDate,
    daysToRenewal: days,
    expired: line.expired,
    premium: line.premium,
    annualPremium: line.annualPremium,
  };
  const link: AlertLink = {
    to: `/insurance?focus=${encodeURIComponent(line.id)}`,
    label: 'View policy',
  };

  if (line.expired) {
    return {
      key: `insurance-renewal:${line.id}:${line.renewalDate}`,
      kind: 'insurance-renewal',
      stage: 3,
      severity: 'critical',
      title: `${line.name} may have lapsed`,
      facts, link, unread: true, dismissed: false,
    };
  }

  const imminent = days <= t.renewalImminentDays;
  return {
    key: `insurance-renewal:${line.id}:${line.renewalDate}`,
    kind: 'insurance-renewal',
    stage: imminent ? 2 : 1,
    severity: imminent ? 'warning' : 'info',
    title: imminent ? `${line.name} renews this week` : `${line.name} renews soon`,
    facts, link, unread: true, dismissed: false,
  };
}

// ─── The report ──────────────────────────────────────────────────────────────

/**
 * Build every alert that currently applies, apply stored dismissal/read state,
 * and report which stored records no longer describe anything.
 */
export function buildAlerts(params: BuildAlertsParams): AlertReport {
  const t = { ...DEFAULT_THRESHOLDS, ...(params.thresholds ?? {}) };
  const { budget, goals, forecast } = params;
  const month = budget.month;

  const alerts: Alert[] = [];

  // ── Budgets: the overall cap and every category cap ──
  const budgetLines: BudgetReportLine[] = [
    ...(budget.overall ? [budget.overall] : []),
    ...budget.categories,
  ];
  /** Category keys that already have a budget alert of their own. */
  const spokenFor = new Set<string>();
  for (const line of budgetLines) {
    const alert = budgetAlert(line, month, t);
    if (!alert) continue;
    alerts.push(alert);
    if (line.scope === 'category') spokenFor.add(line.key);
  }

  // ── Goals ──
  for (const line of goals.lines) {
    const alert = goalAlert(line, t);
    if (alert) alerts.push(alert);
  }

  // ── Cash ──
  const cash = cashAlert(forecast, t);
  if (cash) alerts.push(cash);

  // ── Insurance renewals ──
  //
  // `held` rather than every line: cover the user has said they no longer hold
  // has no renewal to miss. A caller with no policies passes nothing and hears
  // nothing — an absent input is never reported as a finding.
  for (const line of params.insurance?.held ?? []) {
    const alert = insuranceAlert(line, t);
    if (alert) alerts.push(alert);
  }

  // ── Unusual spending ──
  //
  // Budgeted and unbudgeted categories alike, but never one that a budget alert
  // has already spoken about: "Groceries is over budget" and "Groceries is
  // spending unusually" are one piece of news, and the budget version is the
  // more actionable of the two.
  for (const line of [...budget.categories, ...budget.unbudgeted]) {
    if (spokenFor.has(line.key)) continue;
    const baseline = lookupCategory(params.baselineByCategory, line.key);
    const alert = unusualSpendAlert(line, baseline, month, budget.daysElapsed, t);
    if (alert) alerts.push(alert);
  }

  // ── Apply stored dismissal / read state ──
  const stateByKey = new Map((params.states ?? []).map(s => [s.key, s]));
  const live = new Set<string>();

  for (const alert of alerts) {
    live.add(alert.key);
    const state = stateByKey.get(alert.key);
    if (!state) continue;
    // A dismissal covers the stage it was made at and everything below it.
    // Crossing into a worse stage lifts it — that IS the reminder.
    alert.dismissed = state.dismissedStage != null && alert.stage <= state.dismissedStage;
    alert.unread = !(state.readStage != null && alert.stage <= state.readStage);
  }

  const sorted = sortAlerts(alerts);
  const visible = sorted.filter(a => !a.dismissed);

  return {
    asOf: params.asOf,
    all: sorted,
    visible,
    unreadCount: visible.filter(a => a.unread).length,
    // Stored state for a condition that no longer holds. Keeping it would mean a
    // dismissal outliving the situation it was about: overspend Groceries, dismiss
    // it, get back under, overspend again — and hear nothing.
    resolvedKeys: (params.states ?? []).map(s => s.key).filter(key => !live.has(key)),
  };
}
