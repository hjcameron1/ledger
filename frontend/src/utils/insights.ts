/**
 * Phase 6.1 — financial insights (pure engine).
 *
 * ONE place that decides what is worth TELLING the user about their money, as
 * opposed to what is worth interrupting them about (that is Phase 4.4, alerts).
 * Every figure below has already been worked out by an engine that owns it:
 *
 *   • transactionCore      — what counts as spend, income and net movement
 *   • buildBudgetReport    — spent vs cap, per month (4.1)
 *   • buildCashFlowForecast— where cash is heading (3.1)
 *   • buildLoanReport      — balances, offsets, contract vs projection (4.2)
 *   • buildPropertyReport  — rent, costs and yield over the trailing year (4.3)
 *   • buildTaxYearPosition — the financial year's deductions (5.1)
 *   • learnFromHistory     — a recurring commitment's own cadence (3.3)
 *
 * Nothing here re-derives money. It compares figures those engines produced,
 * decides whether the comparison is material, and ranks what survives — so an
 * insight can never disagree with the page it points at.
 *
 * ── What an insight IS ───────────────────────────────────────────────────────
 * Something true about the user's money that they would not otherwise notice,
 * carrying three things: WHAT changed (`facts`), WHY it matters (`impact` — the
 * money consequence, normalised to a monthly figure) and WHERE it came from
 * (`source` names the engine, `link` opens the page that shows the working).
 *
 * Most insights are a CHANGE measured over a rolling window against the window
 * before it. A few are standing facts — an offset quietly saving thousands a
 * year is news the first time it is said, and stays true afterwards. Standing
 * facts are weighted below changes when ranking, because news outranks context.
 *
 * ── Ranking ──────────────────────────────────────────────────────────────────
 * By MATERIALITY IN DOLLARS, not by drama. Every insight declares its impact on
 * one of three bases (this window / per month / per year); the engine converts
 * each to a monthly equivalent so a $40-a-month subscription rise and a
 * $600-a-year offset saving can be compared on one scale. Two documented
 * weights then apply: kind (news over context) and direction (a problem over an
 * equally-sized improvement, because the user can still act on the problem).
 *
 * ── Why the list does not get noisy ──────────────────────────────────────────
 * Four rules, each enforced below and each tested:
 *
 *   1. FLOORS — a change must clear both an absolute and a relative threshold.
 *      A 40% swing on $12 is not news, and neither is 2% of $6,000.
 *   2. COVERAGE — no insight is produced about a period the caller's history
 *      does not actually cover. A month that is merely unloaded looks identical
 *      to a month with no spending, and "your spending halved" is the wrong
 *      thing to say about missing data.
 *   3. SPECIFICITY — when two insights describe the SAME money, the most
 *      specific one survives. A subscription that went up explains its
 *      category; a category explains the overall total.
 *   4. ALREADY SAID — anything a live alert is already shouting about is
 *      dropped, so the same fact is never on screen twice in two voices.
 *
 * ── Identity, resolution and dismissal ───────────────────────────────────────
 * As with alerts: an insight is a CONDITION, not an event. Rebuilding re-derives
 * the same `key`, so nothing accumulates; when the condition stops holding the
 * insight simply is not produced, and any stored state for it comes back in
 * `resolvedKeys` for the caller to drop. Keys are namespaced under `insight:`
 * so insight and alert state can share one store without either pruning the
 * other's records.
 *
 * Pure and dependency-injected (`asOf`, the windows and every report are passed
 * in), so the DS layer (`insightsDS`) is the only thing that touches state.
 */

import { round2 } from './cashFlowForecast';
import type { CashFlowForecast, ForecastFrequency } from './cashFlowForecast';
import { monthlyEquivalent } from './adaptiveForecast';
import { DAYS_PER_MONTH } from './savingsGoals';
import { perMonth } from './loanEngine';
import type { LoanReport } from './loanEngine';
import type { BudgetReport } from './budgeting';
import type { PropertyReport } from './property';
import type { TaxYearPosition } from './taxYear';
import type { AlertStateInput } from './alerts';

// ─── Namespace ───────────────────────────────────────────────────────────────

/**
 * Every insight key starts with this.
 *
 * Insight state (dismissed / read) is stored in the SAME table as alert state —
 * the row is just a key and a stage, and a second table would have been the same
 * table with a different name. The prefix is what keeps the two apart: each side
 * reads only its own namespace, so neither can prune the other's records when it
 * reports what has resolved.
 */
export const INSIGHT_KEY_PREFIX = 'insight:';

/** True for a stored state key that belongs to an insight rather than an alert. */
export function isInsightKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(INSIGHT_KEY_PREFIX);
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * When a comparison becomes worth saying.
 *
 * Every value is a threshold on an EXISTING engine figure, never a new way of
 * measuring money. Absolute floors and percentage floors are paired throughout:
 * either alone produces noise at one end of the scale.
 */
export interface InsightThresholds {
  /** Overall spending must move by at least this much… */
  minSpendChange: number;
  /** …and by at least this share of the previous window, %. */
  minSpendChangePct: number;
  /** One category must move by at least this much… */
  minCategoryChange: number;
  /** …and by at least this share of its own previous window, %. */
  minCategoryChangePct: number;
  /** At most this many category-change insights, largest movement first. */
  maxCategoryInsights: number;
  /** Income must move by at least this much… */
  minIncomeChange: number;
  /** …and by at least this share of the previous window, %. */
  minIncomeChangePct: number;
  /** A recurring commitment must rise by at least this much per occurrence… */
  minRecurringIncrease: number;
  /** …and by at least this share of what it used to cost, %. */
  minRecurringIncreasePct: number;
  /** …with at least this many earlier occurrences behind the old price. */
  minRecurringHistory: number;
  /** Consecutive complete months over a cap before it is called a trend. */
  budgetOverMonths: number;
  /** Consecutive complete months well under a cap before the cap is questioned. */
  budgetUnderMonths: number;
  /** "Well under" means using no more than this share of the cap, %. */
  budgetUnderPct: number;
  /** Ignore an average monthly overshoot/headroom smaller than this. */
  minBudgetTrend: number;
  /** Net movement must change by at least this much window on window. */
  minCashFlowChange: number;
  /** Ignore an overpayment smaller than this per month. */
  minDebtProgress: number;
  /** Months ahead of the contract before being ahead is worth saying. */
  minMonthsAhead: number;
  /** Ignore an offset saving smaller than this per year. */
  minOffsetSaving: number;
  /** A single charge must be at least this large… */
  minUnusualTxn: number;
  /** …and this many times the category's usual charge. */
  unusualTxnRatio: number;
  /** …measured against at least this many charges in the category. */
  minUnusualSample: number;
  /** At most this many unusual-charge insights. */
  maxUnusualInsights: number;
  /** Ignore a property whose yearly cash flow is smaller than this either way. */
  minPropertyCashFlow: number;
  /** Ignore a financial year with less than this claimed. */
  minDeductions: number;
  /**
   * A more specific insight supersedes a broader one once it explains this
   * share of the broader movement, %.
   */
  overlapPct: number;
  /**
   * One category supersedes the overall spending change once it explains this
   * share of it, %.
   */
  dominantPct: number;
}

export const DEFAULT_INSIGHT_THRESHOLDS: InsightThresholds = {
  minSpendChange: 150,
  minSpendChangePct: 10,
  minCategoryChange: 75,
  minCategoryChangePct: 25,
  maxCategoryInsights: 3,
  minIncomeChange: 200,
  minIncomeChangePct: 5,
  minRecurringIncrease: 3,
  minRecurringIncreasePct: 5,
  minRecurringHistory: 2,
  budgetOverMonths: 2,
  budgetUnderMonths: 3,
  budgetUnderPct: 60,
  minBudgetTrend: 25,
  minCashFlowChange: 250,
  minDebtProgress: 100,
  minMonthsAhead: 1,
  minOffsetSaving: 150,
  minUnusualTxn: 200,
  unusualTxnRatio: 3,
  minUnusualSample: 3,
  maxUnusualInsights: 2,
  minPropertyCashFlow: 1_000,
  minDeductions: 500,
  overlapPct: 50,
  dominantPct: 80,
};

// ─── What an insight is ──────────────────────────────────────────────────────

export type InsightKind =
  /** All spending, this window against the one before it. */
  | 'spending-change'
  /** One category, same comparison. */
  | 'category-change'
  /** Money coming in, same comparison. */
  | 'income-change'
  /** A recurring commitment now costs more per charge than it used to. */
  | 'recurring-increase'
  /** A single charge far above what that category normally costs. */
  | 'unusual-transaction'
  /** A budget cap missed — or comfortably beaten — several complete months running. */
  | 'budget-trend'
  /** Net movement improving or worsening, with where the forecast says it goes. */
  | 'cash-flow-trend'
  /** A debt being paid down faster than the contract requires. */
  | 'debt-progress'
  /** What an offset account is saving in interest. */
  | 'offset-benefit'
  /** What a property earns against what it costs to hold, over the trailing year. */
  | 'property-performance'
  /** What has been claimed against this financial year so far. */
  | 'tax-deductions';

/** Which way the money moved, from the user's point of view. */
export type InsightDirection = 'improving' | 'worsening' | 'neutral';

/** The engine whose figures the insight quotes — its provenance. */
export type InsightSource =
  | 'transactions' | 'budgets' | 'forecast' | 'loans' | 'property' | 'tax';

/** What period `impact.amount` is measured over. */
export type ImpactBasis = 'window' | 'per-month' | 'per-year';

/** The money consequence — the "why it matters" half, as data. */
export interface InsightImpact {
  /** Always positive: the direction is on the insight, not on the amount. */
  amount: number;
  basis: ImpactBasis;
}

/** The window a change was measured over. */
export interface InsightWindow {
  /** Inclusive first day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  to: string;
  days: number;
}

/** Where an insight points. `to` is an in-app path, ready for `navigate()`. */
export interface InsightLink {
  to: string;
  label: string;
}

/** One category's contribution to a movement — the "what drove it" detail. */
export interface InsightDriver {
  category: string;
  /** Signed: positive is more spending than before. */
  delta: number;
}

/**
 * The NUMBERS behind an insight, as data rather than a sentence.
 *
 * The component owns currency and date formatting (and therefore the user's
 * locale); this module owns which figures the sentence is allowed to use. Same
 * split as `AlertFacts` in alerts.ts and `GoalMessage` in goalView.ts.
 */
export type InsightFacts =
  | {
    kind: 'spending-change';
    current: number;
    previous: number;
    /** current − previous. Positive means more was spent. */
    delta: number;
    /** delta as a share of `previous`, %. 100 when there was no previous spend. */
    percent: number;
    /** The categories behind the movement, biggest first. */
    drivers: InsightDriver[];
  }
  | {
    kind: 'category-change';
    category: string;
    current: number;
    previous: number;
    delta: number;
    percent: number;
    /** This category's share of ALL spending this window, %. */
    shareOfSpend: number;
  }
  | {
    kind: 'income-change';
    current: number;
    previous: number;
    delta: number;
    percent: number;
  }
  | {
    kind: 'recurring-increase';
    name: string;
    category: string | null;
    /** What it costs now, per charge. */
    amount: number;
    /** What it used to cost, per charge. */
    previousAmount: number;
    delta: number;
    percent: number;
    frequency: ForecastFrequency;
    /** The rise expressed over a year, which is what it really costs. */
    annualDelta: number;
    lastDate: string;
  }
  | {
    kind: 'unusual-transaction';
    category: string;
    merchant: string;
    amount: number;
    date: string;
    /** The category's usual charge, from this window's own transactions. */
    usual: number;
    /** amount ÷ usual. */
    multiple: number;
  }
  | {
    kind: 'budget-trend';
    name: string;
    /** 'over' — missed the cap; 'under' — well inside it. */
    trend: 'over' | 'under';
    months: number;
    /** The complete months compared, oldest first. */
    monthKeys: string[];
    /** Average spend across those months. */
    averageSpent: number;
    /** Average cap across those months. */
    averageLimit: number;
    /** Average overshoot ('over') or headroom ('under') per month. */
    averageGap: number;
  }
  | {
    kind: 'cash-flow-trend';
    /** Net movement across the current window (inflows − outflows). */
    current: number;
    previous: number;
    delta: number;
    /** What the forecast expects over its first horizon, when there is one. */
    projectedNet: number | null;
    projectedDays: number | null;
    /** The lowest the forecast expects cash to reach, when there is one. */
    projectedLow: number | null;
  }
  | {
    kind: 'debt-progress';
    name: string;
    balance: number;
    originalAmount: number;
    repaidPercent: number;
    /** Months the projection beats the contract by. */
    monthsAhead: number;
    /** What is being paid above the contracted repayment, per month. */
    overpaymentPerMonth: number;
    payoffDate: string | null;
    contractEndDate: string | null;
  }
  | {
    kind: 'offset-benefit';
    name: string;
    offsetBalance: number;
    /** Interest avoided per year at today's balance. */
    savingPerYear: number;
    savingPerMonth: number;
    /** What interest is actually charged on: balance − offset. */
    effectiveBalance: number;
    rate: number;
    /** True when the offset tracks a real account rather than a typed figure. */
    linked: boolean;
  }
  | {
    kind: 'property-performance';
    name: string;
    annualRent: number;
    annualExpenses: number;
    annualMortgage: number;
    /** rent − expenses − mortgage over a year. Negative is money going in. */
    annualCashFlow: number;
    monthlyCashFlow: number;
    netYield: number | null;
    /** Whether the rent figure is the agreed lease or what the bank saw. */
    rentBasis: 'agreed' | 'banked';
  }
  | {
    kind: 'tax-deductions';
    fy: string;
    /** Claimable expenses for the year, net of refunds. */
    deductions: number;
    /** How many categories they fall across. */
    categories: number;
    topCategory: string | null;
    topCategoryTotal: number;
  };

export interface Insight {
  /**
   * Stable identity of the OBSERVATION, namespaced under `insight:`. Rebuilding
   * produces the same key, which is what makes insights idempotent and
   * dismissals durable. Month-scoped where the observation is about a rolling
   * window, so a new month is genuinely new news rather than the same sentence
   * with yesterday's dates.
   */
  key: string;
  kind: InsightKind;
  /**
   * What the insight is ABOUT, for de-duplication: `category:groceries`,
   * `loan:<id>`, `cash`. Two insights sharing an entity are two descriptions of
   * one thing, and only the most specific of them survives.
   */
  entity: string;
  direction: InsightDirection;
  source: InsightSource;
  /** Rises as the movement grows. A dismissal only holds at or below it. */
  stage: number;
  /** Short heading — never contains money, so the component owns all formatting. */
  title: string;
  facts: InsightFacts;
  /** The money consequence, on its own basis. */
  impact: InsightImpact;
  /** `impact` converted to a monthly equivalent — the ranking scale. */
  monthlyImpact: number;
  /** monthlyImpact after the kind and direction weights. Higher ranks first. */
  score: number;
  /** The period compared, or null for a standing fact. */
  window: InsightWindow | null;
  link: InsightLink;
  /** False once the user has seen it at this stage or worse. */
  unread: boolean;
  /** True while a dismissal at this stage or higher is in force. */
  dismissed: boolean;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Net spend over a window, exactly as transactionCore reports it. */
export interface WindowSpend {
  total: number;
  /** Per category, keyed by display name. */
  byCategory: Record<string, number>;
}

/** One spend transaction inside the current window, already classified. */
export interface WindowTxn {
  id: string;
  date: string;
  category: string;
  merchant: string;
  /** POSITIVE spend magnitude (transactionCore.spendAmount). */
  amount: number;
}

/**
 * A recurring commitment's price now against its price before.
 *
 * The caller reads the amounts off the commitment's own occurrences — this
 * module never decides what a recurring charge is, only whether the rise in one
 * is worth mentioning.
 */
export interface RecurringCostInput {
  id: string;
  name: string;
  category: string | null;
  frequency: ForecastFrequency;
  /** The latest charge, as a positive magnitude. */
  amount: number;
  /** The typical earlier charge, as a positive magnitude. */
  previousAmount: number;
  /** How many earlier charges `previousAmount` was taken from. */
  history: number;
  lastDate: string;
}

/** The financial-year figures an insight may quote. */
export interface TaxInsightInput {
  fy: string;
  /** First day of the year, `YYYY-MM-DD` — checked against coverage. */
  start: string;
  position: TaxYearPosition;
}

export interface BuildInsightsParams {
  /** Today, `YYYY-MM-DD`. Injected for determinism. */
  asOf: string;
  /** The period changes are measured over. */
  window: InsightWindow;
  /** The period it is measured against — same length, immediately before. */
  previousWindow: InsightWindow;
  /**
   * The oldest date the caller's history actually covers, `YYYY-MM-DD`.
   *
   * Nothing is said about a period starting before it. Unloaded history and an
   * empty history are indistinguishable in the data and completely different in
   * meaning, and this is the only thing that tells them apart.
   */
  coverageFrom?: string | null;
  /** Net spend over both windows (transactionCore). */
  spend?: { current: WindowSpend; previous: WindowSpend } | null;
  /** Genuine income inflow over both windows (transactionCore). */
  income?: { current: number; previous: number } | null;
  /** Signed net movement over both windows (transactionCore). */
  netMovement?: { current: number; previous: number } | null;
  /** Spend transactions inside the current window. */
  transactions?: WindowTxn[];
  /** Recurring commitments whose price can be compared. */
  recurring?: RecurringCostInput[];
  /**
   * COMPLETE months only, oldest first, every one of them covered. A month still
   * running is not a data point about a budget: it is always under its cap right
   * up until it isn't.
   */
  budgetHistory?: BudgetReport[];
  forecast?: CashFlowForecast | null;
  loans?: LoanReport | null;
  property?: PropertyReport | null;
  tax?: TaxInsightInput | null;
  /** Stored dismissal/read state, from `alert_states` (insight namespace only). */
  states?: AlertStateInput[];
  /** Entities a live alert is already speaking about — see rule 4 at the top. */
  spokenFor?: string[];
  thresholds?: Partial<InsightThresholds>;
}

export interface InsightReport {
  asOf: string;
  window: InsightWindow;
  previousWindow: InsightWindow;
  /** Everything currently holding, best-ranked first — dismissed ones included. */
  all: Insight[];
  /** What the user should actually see: `all` minus dismissed, same order. */
  visible: Insight[];
  /** Visible insights not yet read at their current stage. */
  unreadCount: number;
  /**
   * Insight-namespaced stored keys whose observation no longer holds. The caller
   * drops these, so an observation that returns is not silently suppressed by a
   * dismissal made about a situation that has since passed.
   */
  resolvedKeys: string[];
  /**
   * How many insights were dropped because a live alert is already saying it.
   *
   * Reported rather than merely done: a caller that summarises this list (the
   * Phase 6.2 review) has to be able to say "and two more are already in Needs
   * your attention" instead of quietly showing a shorter list.
   */
  suppressedByAlert: number;
  /**
   * What was NOT looked at, and why — one line per skipped dimension.
   *
   * A silent absence reads as "nothing to report"; these say "not enough history
   * to tell", which is a different answer and the honest one.
   */
  skipped: string[];
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

/**
 * News outranks context.
 *
 * A change is something that just happened and may need a decision; a standing
 * fact is background the user can act on whenever they like. Both are ranked in
 * dollars, and these weights only decide which of two EQUALLY large figures is
 * said first.
 */
const KIND_WEIGHT: Record<InsightKind, number> = {
  'spending-change': 1,
  'category-change': 1,
  'income-change': 1,
  'recurring-increase': 1,
  'cash-flow-trend': 1,
  'budget-trend': 0.9,
  'unusual-transaction': 0.9,
  'debt-progress': 0.6,
  'property-performance': 0.5,
  'offset-benefit': 0.5,
  'tax-deductions': 0.4,
};

/**
 * A problem outranks an equally-sized improvement: there is something to do
 * about the first and nothing to do about the second.
 */
const DIRECTION_WEIGHT: Record<InsightDirection, number> = {
  worsening: 1,
  improving: 0.85,
  neutral: 0.7,
};

/** Tie-break order when two insights score identically. */
const KIND_RANK: Record<InsightKind, number> = {
  'cash-flow-trend': 0,
  'spending-change': 1,
  'category-change': 2,
  'recurring-increase': 3,
  'unusual-transaction': 4,
  'budget-trend': 5,
  'income-change': 6,
  'debt-progress': 7,
  'offset-benefit': 8,
  'property-performance': 9,
  'tax-deductions': 10,
};

/** `impact` on one comparable scale: what it is worth in a month. */
export function monthlyImpactOf(impact: InsightImpact, windowDays: number): number {
  const amount = Math.abs(impact.amount);
  switch (impact.basis) {
    case 'per-month': return round2(amount);
    case 'per-year': return round2(amount / 12);
    case 'window': {
      const days = windowDays > 0 ? windowDays : DAYS_PER_MONTH;
      return round2(amount * (DAYS_PER_MONTH / days));
    }
  }
}

export function sortInsights(insights: Insight[]): Insight[] {
  return [...insights].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    if (a.stage !== b.stage) return b.stage - a.stage;
    return a.key.localeCompare(b.key);
  });
}

// ─── Small shared helpers ────────────────────────────────────────────────────

const categoryKey = (name: string): string => (name ?? '').trim().toLowerCase();

/** Percentage change from `previous` to `current`, guarding a zero baseline. */
function percentChange(current: number, previous: number): number {
  if (previous > 0) return round2(((current - previous) / previous) * 100);
  return current > 0 ? 100 : 0;
}

/** Median of a list of magnitudes. 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How loud this movement is, against the smallest one worth mentioning.
 *
 * The same rule for every kind: material (1), twice that (2), four times (3). It
 * is what makes a dismissal expire — dismissing "spending is up a bit" does not
 * silence "spending has doubled", because that is a different stage.
 */
function stageFor(monthlyImpact: number, floor: number): number {
  if (!(floor > 0)) return 1;
  const ratio = monthlyImpact / floor;
  if (ratio >= 4) return 3;
  if (ratio >= 2) return 2;
  return 1;
}

/** Assemble an insight, working out its monthly impact, stage and score. */
function make(input: {
  key: string;
  kind: InsightKind;
  entity: string;
  direction: InsightDirection;
  source: InsightSource;
  title: string;
  facts: InsightFacts;
  impact: InsightImpact;
  /** The smallest monthly-equivalent movement this kind reports — the stage unit. */
  floor: number;
  window: InsightWindow | null;
  link: InsightLink;
}): Insight {
  const windowDays = input.window?.days ?? Math.round(DAYS_PER_MONTH);
  const monthlyImpact = monthlyImpactOf(input.impact, windowDays);
  return {
    key: input.key,
    kind: input.kind,
    entity: input.entity,
    direction: input.direction,
    source: input.source,
    stage: stageFor(monthlyImpact, input.floor),
    title: input.title,
    facts: input.facts,
    impact: { amount: round2(Math.abs(input.impact.amount)), basis: input.impact.basis },
    monthlyImpact,
    score: round2(monthlyImpact * KIND_WEIGHT[input.kind] * DIRECTION_WEIGHT[input.direction]),
    window: input.window,
    link: input.link,
    unread: true,
    dismissed: false,
  };
}

// ─── The builders, one per kind ──────────────────────────────────────────────

/**
 * Overall spending, this window against the one before.
 *
 * The drivers are attached because "you spent $400 more" is a fact and "$300 of
 * it was one holiday" is the answer to the question it provokes. They are read
 * off the same two windows — nothing extra is computed.
 */
function spendingChange(
  spend: { current: WindowSpend; previous: WindowSpend },
  window: InsightWindow,
  month: string,
  t: InsightThresholds,
): Insight | null {
  const current = round2(spend.current.total);
  const previous = round2(spend.previous.total);
  const delta = round2(current - previous);
  if (Math.abs(delta) < t.minSpendChange) return null;
  const percent = percentChange(current, previous);
  if (Math.abs(percent) < t.minSpendChangePct) return null;

  const drivers = categoryDeltas(spend)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3)
    .map(d => ({ category: d.name, delta: d.delta }));

  const up = delta > 0;
  return make({
    key: `${INSIGHT_KEY_PREFIX}spending-change:${month}`,
    kind: 'spending-change',
    entity: 'spend:overall',
    direction: up ? 'worsening' : 'improving',
    source: 'transactions',
    title: up ? 'You are spending more than you were' : 'You are spending less than you were',
    facts: { kind: 'spending-change', current, previous, delta, percent, drivers },
    impact: { amount: delta, basis: 'window' },
    floor: t.minSpendChange,
    window,
    link: { to: '/accounts?tab=transactions', label: 'View transactions' },
  });
}

/** Every category's movement across the two windows, matched case-insensitively. */
function categoryDeltas(
  spend: { current: WindowSpend; previous: WindowSpend },
): { key: string; name: string; current: number; previous: number; delta: number }[] {
  const rows = new Map<string, { key: string; name: string; current: number; previous: number }>();
  const put = (name: string, amount: number, side: 'current' | 'previous') => {
    const key = categoryKey(name);
    if (!key) return;
    const row = rows.get(key) ?? { key, name, current: 0, previous: 0 };
    row[side] = round2(row[side] + amount);
    // The current window owns the spelling: it is the one the user is looking at.
    if (side === 'current') row.name = name;
    rows.set(key, row);
  };
  for (const name in spend.previous.byCategory) put(name, spend.previous.byCategory[name], 'previous');
  for (const name in spend.current.byCategory) put(name, spend.current.byCategory[name], 'current');
  return [...rows.values()].map(r => ({ ...r, delta: round2(r.current - r.previous) }));
}

/**
 * The categories that actually moved, biggest movement first and capped.
 *
 * Capped rather than filtered harder: a month where six categories each moved
 * $100 is a month where the OVERALL figure is the story, and printing six rows
 * would bury it.
 */
function categoryChanges(
  spend: { current: WindowSpend; previous: WindowSpend },
  window: InsightWindow,
  month: string,
  t: InsightThresholds,
): Insight[] {
  const totalSpend = spend.current.total;
  return categoryDeltas(spend)
    .filter(row => {
      if (Math.abs(row.delta) < t.minCategoryChange) return false;
      return Math.abs(percentChange(row.current, row.previous)) >= t.minCategoryChangePct;
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, t.maxCategoryInsights)
    .map(row => {
      const up = row.delta > 0;
      return make({
        key: `${INSIGHT_KEY_PREFIX}category-change:${month}:${row.key}`,
        kind: 'category-change',
        entity: `category:${row.key}`,
        direction: up ? 'worsening' : 'improving',
        source: 'transactions',
        title: up ? `${row.name} is costing more` : `${row.name} is costing less`,
        facts: {
          kind: 'category-change',
          category: row.name,
          current: row.current,
          previous: row.previous,
          delta: row.delta,
          percent: percentChange(row.current, row.previous),
          shareOfSpend: totalSpend > 0 ? round2((row.current / totalSpend) * 100) : 0,
        },
        impact: { amount: row.delta, basis: 'window' },
        floor: t.minCategoryChange,
        window,
        link: {
          to: `/accounts?tab=transactions&category=${encodeURIComponent(row.name)}`,
          label: 'View transactions',
        },
      });
    });
}

/**
 * Money coming in, this window against the one before.
 *
 * Income is lumpy by nature — a fortnightly payer lands three times in some
 * 30-day windows and twice in others — so the percentage floor is deliberately
 * lower than the spending one while the dollar floor is higher: one extra pay
 * cycle is a large absolute swing that means nothing, and it is the ABSOLUTE
 * floor plus the user's own eyes on the figures that keep it honest.
 */
function incomeChange(
  income: { current: number; previous: number },
  window: InsightWindow,
  month: string,
  t: InsightThresholds,
): Insight | null {
  const current = round2(income.current);
  const previous = round2(income.previous);
  const delta = round2(current - previous);
  if (Math.abs(delta) < t.minIncomeChange) return null;
  const percent = percentChange(current, previous);
  if (Math.abs(percent) < t.minIncomeChangePct) return null;

  const up = delta > 0;
  return make({
    key: `${INSIGHT_KEY_PREFIX}income-change:${month}`,
    kind: 'income-change',
    entity: 'income',
    direction: up ? 'improving' : 'worsening',
    source: 'transactions',
    title: up ? 'More money came in than usual' : 'Less money came in than usual',
    facts: { kind: 'income-change', current, previous, delta, percent },
    impact: { amount: delta, basis: 'window' },
    floor: t.minIncomeChange,
    window,
    link: { to: '/income', label: 'View income' },
  });
}

/**
 * A recurring commitment that costs more per charge than it used to.
 *
 * Only increases. A cancelled or cheaper subscription is good news the user
 * already knows about — they made it happen — while a price rise arrives
 * silently, months after the email announcing it, and is the whole reason this
 * kind exists. The rise is reported per charge AND over a year, because a
 * "$3 a month" rise is $36 a year and the second number is the one that decides
 * whether it is worth cancelling.
 */
function recurringIncreases(
  inputs: RecurringCostInput[],
  month: string,
  t: InsightThresholds,
): Insight[] {
  const out: Insight[] = [];
  for (const r of inputs) {
    if (r.history < t.minRecurringHistory) continue;
    const amount = round2(Math.abs(r.amount));
    const previousAmount = round2(Math.abs(r.previousAmount));
    const delta = round2(amount - previousAmount);
    if (delta < t.minRecurringIncrease) continue;
    if (percentChange(amount, previousAmount) < t.minRecurringIncreasePct) continue;

    // A one-off charge has no ongoing cost, so a rise in one has no monthly
    // consequence to report — the existing cadence maths decides that, not this.
    const monthlyDelta = round2(monthlyEquivalent(delta, r.frequency));
    if (monthlyDelta <= 0) continue;

    out.push(make({
      key: `${INSIGHT_KEY_PREFIX}recurring-increase:${month}:${r.id}`,
      kind: 'recurring-increase',
      entity: `recurring:${r.id}`,
      direction: 'worsening',
      source: 'transactions',
      title: `${r.name} costs more than it did`,
      facts: {
        kind: 'recurring-increase',
        name: r.name,
        category: r.category ?? null,
        amount,
        previousAmount,
        delta,
        percent: percentChange(amount, previousAmount),
        frequency: r.frequency,
        annualDelta: round2(monthlyDelta * 12),
        lastDate: r.lastDate,
      },
      impact: { amount: monthlyDelta, basis: 'per-month' },
      floor: t.minRecurringIncrease,
      window: null,
      link: { to: '/accounts?tab=subscriptions', label: 'View recurring costs' },
    }));
  }
  return out;
}

/**
 * A single charge far above what that category normally costs.
 *
 * Measured against the MEDIAN charge in the same category over the same window,
 * so the outlier cannot drag its own baseline the way an average would. A
 * minimum sample is required: two charges have no normal, and calling the larger
 * of them unusual would be arithmetic dressed as a finding.
 */
function unusualTransactions(
  transactions: WindowTxn[],
  window: InsightWindow,
  month: string,
  t: InsightThresholds,
): Insight[] {
  const groups = new Map<string, { name: string; txns: WindowTxn[] }>();
  for (const txn of transactions) {
    if (!(txn.amount > 0)) continue;
    const key = categoryKey(txn.category);
    if (!key) continue;
    const group = groups.get(key) ?? { name: txn.category, txns: [] };
    group.txns.push(txn);
    groups.set(key, group);
  }

  const found: Insight[] = [];
  for (const [key, group] of groups) {
    if (group.txns.length < t.minUnusualSample) continue;
    const usual = round2(median(group.txns.map(x => x.amount)));
    if (!(usual > 0)) continue;
    const biggest = group.txns.reduce((a, b) => (b.amount > a.amount ? b : a));
    if (biggest.amount < t.minUnusualTxn) continue;
    const multiple = biggest.amount / usual;
    if (multiple < t.unusualTxnRatio) continue;

    found.push(make({
      key: `${INSIGHT_KEY_PREFIX}unusual-transaction:${month}:${biggest.id}`,
      kind: 'unusual-transaction',
      entity: `category:${key}`,
      direction: 'worsening',
      source: 'transactions',
      title: `An unusually large ${group.name} charge`,
      facts: {
        kind: 'unusual-transaction',
        category: group.name,
        merchant: biggest.merchant,
        amount: round2(biggest.amount),
        date: biggest.date,
        usual,
        multiple: round2(multiple),
      },
      impact: { amount: round2(biggest.amount - usual), basis: 'window' },
      floor: t.minUnusualTxn,
      window,
      link: {
        to: `/accounts?tab=transactions&category=${encodeURIComponent(group.name)}`,
        label: 'View transactions',
      },
    }));
  }

  return found
    .sort((a, b) => b.monthlyImpact - a.monthlyImpact)
    .slice(0, t.maxUnusualInsights);
}

/**
 * A cap missed — or comfortably beaten — several COMPLETE months running.
 *
 * The month in progress is never a data point: a budget is under its cap right
 * up until it isn't, so including it would turn every trend into a coin toss on
 * the day of the month. Two directions, and both are useful: repeatedly over
 * says the spending or the cap is wrong, repeatedly well under says the cap is
 * not doing anything and the difference could be going somewhere.
 */
function budgetTrends(
  history: BudgetReport[],
  t: InsightThresholds,
): Insight[] {
  // Nothing to trend against: the shorter of the two runs is the least this can
  // possibly need, and below it neither direction can be established.
  if (history.length < Math.min(t.budgetOverMonths, t.budgetUnderMonths)) return [];

  /** Every budget line by key, in month order, over the months supplied. */
  const byKey = new Map<string, {
    name: string;
    scope: 'overall' | 'category';
    months: { month: string; spent: number; limit: number }[];
  }>();
  for (const report of history) {
    const lines = [...(report.overall ? [report.overall] : []), ...report.categories];
    for (const line of lines) {
      if (!(line.effectiveLimit > 0)) continue;
      const row = byKey.get(line.key)
        ?? { name: line.scope === 'overall' ? 'Overall spending' : line.name, scope: line.scope, months: [] };
      row.months.push({ month: report.month, spent: line.spent, limit: line.effectiveLimit });
      byKey.set(line.key, row);
    }
  }

  const out: Insight[] = [];
  for (const [key, row] of byKey) {
    const tail = (n: number) => (row.months.length >= n ? row.months.slice(-n) : null);
    const entity = row.scope === 'overall' ? 'spend:overall' : `category:${categoryKey(row.name)}`;
    const link: InsightLink = {
      to: `/?focus=budget:${encodeURIComponent(key)}`,
      label: 'View budget',
    };

    // Over the cap wins over under it: they cannot both hold, but if the window
    // lengths ever differ, the miss is the one worth saying.
    const over = tail(t.budgetOverMonths);
    if (over && over.every(m => m.spent > m.limit)) {
      const averageGap = round2(over.reduce((s, m) => s + (m.spent - m.limit), 0) / over.length);
      if (averageGap >= t.minBudgetTrend) {
        out.push(make({
          key: `${INSIGHT_KEY_PREFIX}budget-trend:${over[over.length - 1].month}:${key}`,
          kind: 'budget-trend',
          entity,
          direction: 'worsening',
          source: 'budgets',
          title: `${row.name} has been over budget ${over.length} months running`,
          facts: {
            kind: 'budget-trend',
            name: row.name,
            trend: 'over',
            months: over.length,
            monthKeys: over.map(m => m.month),
            averageSpent: round2(over.reduce((s, m) => s + m.spent, 0) / over.length),
            averageLimit: round2(over.reduce((s, m) => s + m.limit, 0) / over.length),
            averageGap,
          },
          impact: { amount: averageGap, basis: 'per-month' },
          floor: t.minBudgetTrend,
          window: null,
          link,
        }));
        continue;
      }
    }

    const under = tail(t.budgetUnderMonths);
    if (under && under.every(m => m.spent <= m.limit * (t.budgetUnderPct / 100))) {
      const averageGap = round2(under.reduce((s, m) => s + (m.limit - m.spent), 0) / under.length);
      if (averageGap < t.minBudgetTrend) continue;
      out.push(make({
        key: `${INSIGHT_KEY_PREFIX}budget-trend:${under[under.length - 1].month}:${key}`,
        kind: 'budget-trend',
        entity,
        direction: 'neutral',
        source: 'budgets',
        title: `${row.name} has been well under budget ${under.length} months running`,
        facts: {
          kind: 'budget-trend',
          name: row.name,
          trend: 'under',
          months: under.length,
          monthKeys: under.map(m => m.month),
          averageSpent: round2(under.reduce((s, m) => s + m.spent, 0) / under.length),
          averageLimit: round2(under.reduce((s, m) => s + m.limit, 0) / under.length),
          averageGap,
        },
        impact: { amount: averageGap, basis: 'per-month' },
        floor: t.minBudgetTrend,
        window: null,
        link,
      }));
    }
  }

  return out;
}

/**
 * Cash flow, improving or worsening.
 *
 * Both sides are the SAME measurement — signed net movement over a window,
 * transfers included — taken over two equal windows. That symmetry is the whole
 * point: comparing what the bank actually did against what the forecast expects
 * would be comparing two different definitions of a dollar, and the difference
 * between them would look like news.
 *
 * The forecast still appears, as the forward half of the same sentence: where
 * the trend has been, and where the projection says it goes.
 */
function cashFlowTrend(
  net: { current: number; previous: number },
  forecast: CashFlowForecast | null | undefined,
  window: InsightWindow,
  month: string,
  t: InsightThresholds,
): Insight | null {
  const current = round2(net.current);
  const previous = round2(net.previous);
  const delta = round2(current - previous);
  if (Math.abs(delta) < t.minCashFlowChange) return null;

  const horizon = forecast?.horizons?.[0] ?? null;
  const up = delta > 0;
  return make({
    key: `${INSIGHT_KEY_PREFIX}cash-flow-trend:${month}`,
    kind: 'cash-flow-trend',
    entity: 'cash',
    direction: up ? 'improving' : 'worsening',
    source: forecast ? 'forecast' : 'transactions',
    title: up ? 'Your cash flow is improving' : 'Your cash flow is getting tighter',
    facts: {
      kind: 'cash-flow-trend',
      current,
      previous,
      delta,
      projectedNet: horizon ? round2(horizon.net) : null,
      projectedDays: horizon ? horizon.days : null,
      projectedLow: horizon ? round2(horizon.lowestBalance) : null,
    },
    impact: { amount: delta, basis: 'window' },
    floor: t.minCashFlowChange,
    window,
    link: { to: '/forecast', label: 'View forecast' },
  });
}

/**
 * A debt being paid down faster than the contract requires.
 *
 * The insight is the MONEY doing it — what is going in above the contracted
 * repayment each month — with the months saved as the consequence. Being ahead
 * on paper with nothing extra going in (a lump sum years ago, a rate that fell)
 * is not reported: there is nothing there the user is doing, and therefore
 * nothing to keep doing.
 */
function debtProgress(loans: LoanReport, t: InsightThresholds): Insight[] {
  const out: Insight[] = [];
  for (const row of loans.rows) {
    if (!(row.balance > 0)) continue;

    // What is being paid above the contract: measured against the contracted
    // repayment where the agreement is on file, and against the loan's own
    // minimum otherwise. Both figures come off the loan report as it built them.
    const contracted = row.contractedRepayment != null && row.contractedRepayment > 0
      ? row.contractedRepayment
      : row.repayment;
    const overpayment = Math.max(0, round2(row.periodOutlay - contracted));
    const overpaymentPerMonth = round2(perMonth(overpayment, row.frequency));
    if (overpaymentPerMonth < t.minDebtProgress) continue;

    const monthsAhead = Math.max(0, row.monthsAheadOfContract ?? 0);
    out.push(make({
      key: `${INSIGHT_KEY_PREFIX}debt-progress:${row.id}`,
      kind: 'debt-progress',
      entity: `loan:${row.id}`,
      direction: 'improving',
      source: 'loans',
      title: monthsAhead >= t.minMonthsAhead
        ? `${row.name} is ahead of schedule`
        : `You are paying ${row.name} down faster than required`,
      facts: {
        kind: 'debt-progress',
        name: row.name,
        balance: round2(row.balance),
        originalAmount: round2(row.originalAmount),
        repaidPercent: round2(row.repaidPercent),
        monthsAhead,
        overpaymentPerMonth,
        payoffDate: row.payoffDate,
        contractEndDate: row.contractEndDate,
      },
      impact: { amount: overpaymentPerMonth, basis: 'per-month' },
      floor: t.minDebtProgress,
      window: null,
      link: { to: '/loans', label: 'View loan' },
    }));
  }
  return out;
}

/**
 * What an offset account is saving.
 *
 * A standing fact, and one of the few worth repeating: the saving moves with
 * both the balance and the rate, and most people have never seen it as a number.
 * A broken link is skipped rather than reported as zero — the Loans page already
 * says the link is broken, and a "your offset saves nothing" insight built on a
 * known-missing account would be the wrong sentence for the right problem.
 */
function offsetBenefits(loans: LoanReport, t: InsightThresholds): Insight[] {
  const out: Insight[] = [];
  for (const row of loans.rows) {
    if (row.offsetLinkBroken) continue;
    if (!(row.offsetBalance > 0)) continue;
    if (row.offsetSavingPerYear < t.minOffsetSaving) continue;

    out.push(make({
      key: `${INSIGHT_KEY_PREFIX}offset-benefit:${row.id}`,
      kind: 'offset-benefit',
      entity: `loan:${row.id}:offset`,
      direction: 'improving',
      source: 'loans',
      title: `Your offset is cutting the interest on ${row.name}`,
      facts: {
        kind: 'offset-benefit',
        name: row.name,
        offsetBalance: round2(row.offsetBalance),
        savingPerYear: round2(row.offsetSavingPerYear),
        savingPerMonth: round2(row.offsetSavingPerMonth),
        effectiveBalance: round2(row.effectiveBalance),
        rate: row.rate,
        linked: row.offsetIsLinked,
      },
      impact: { amount: row.offsetSavingPerYear, basis: 'per-year' },
      floor: t.minOffsetSaving,
      window: null,
      link: { to: '/loans', label: 'View loan' },
    }));
  }
  return out;
}

/**
 * What a property earns against what it costs to hold.
 *
 * Only properties that EARN: a home the user lives in costs money by
 * definition, and reporting that as a finding would be noise on every build.
 * The figures — rent, costs, mortgage, yield — are the property engine's own
 * trailing-year working, quoted rather than recomputed, so this and the property
 * card can never disagree.
 */
function propertyPerformance(report: PropertyReport, t: InsightThresholds): Insight[] {
  const out: Insight[] = [];
  for (const row of report.rows) {
    const p = row.performance;
    if (!p?.matched) continue;
    if (!p.isIncomeProducing && !(p.annualRent > 0)) continue;
    if (Math.abs(p.annualCashFlow) < t.minPropertyCashFlow) continue;

    const positive = p.annualCashFlow >= 0;
    out.push(make({
      key: `${INSIGHT_KEY_PREFIX}property-performance:${row.id}`,
      kind: 'property-performance',
      entity: `property:${row.id}`,
      direction: positive ? 'improving' : 'worsening',
      source: 'property',
      title: positive
        ? `${row.name} is paying for itself`
        : `${row.name} costs more than it earns`,
      facts: {
        kind: 'property-performance',
        name: row.name,
        annualRent: round2(p.annualRent),
        annualExpenses: round2(p.annualExpenses),
        annualMortgage: round2(p.annualMortgage),
        annualCashFlow: round2(p.annualCashFlow),
        monthlyCashFlow: round2(p.monthlyCashFlow),
        netYield: p.netYield,
        rentBasis: p.annualRentBasis,
      },
      impact: { amount: p.annualCashFlow, basis: 'per-year' },
      floor: t.minPropertyCashFlow,
      window: null,
      link: { to: '/investments?tab=Property', label: 'View property' },
    }));
  }
  return out;
}

/**
 * What has been claimed against this financial year so far.
 *
 * Deliberately modest: the deductions the tax engine has already merged and
 * totalled, and which category they mostly sit in. No tax saving is claimed —
 * the saving depends on the marginal rate, which is the Tax page's job to
 * settle, and quoting a figure here that the Tax page would settle differently
 * is exactly the kind of disagreement this whole layer exists to avoid.
 *
 * `impact` is therefore the size of the FIGURE, not a claim about tax saved;
 * it ranks this as the context it is (see KIND_WEIGHT) rather than as news.
 */
function taxDeductions(tax: TaxInsightInput, t: InsightThresholds): Insight | null {
  const deductions = round2(tax.position.deductibleExpenses);
  if (deductions < t.minDeductions) return null;
  const categories = tax.position.deductionCategories ?? [];
  const top = categories[0] ?? null;

  return make({
    key: `${INSIGHT_KEY_PREFIX}tax-deductions:${tax.fy}`,
    kind: 'tax-deductions',
    entity: `tax:${tax.fy}`,
    direction: 'neutral',
    source: 'tax',
    title: 'Deductions logged this financial year',
    facts: {
      kind: 'tax-deductions',
      fy: tax.fy,
      deductions,
      categories: categories.length,
      topCategory: top?.category ?? null,
      topCategoryTotal: round2(top?.total ?? 0),
    },
    impact: { amount: deductions, basis: 'per-year' },
    floor: t.minDeductions,
    window: null,
    link: { to: '/tax', label: 'View tax position' },
  });
}

// ─── Saying one thing once ───────────────────────────────────────────────────

/**
 * When two insights describe the same money, the most specific one survives.
 *
 * The order below is the order of specificity, and each step is a claim about
 * what the user would rather read:
 *
 *   • a subscription that went up EXPLAINS its category's rise;
 *   • one very large charge EXPLAINS its category's rise;
 *   • a cap missed for months is a more actionable statement about a category
 *     (or about all spending) than the same money measured against last month;
 *   • one dominant category EXPLAINS the overall movement.
 *
 * "Explains" is a threshold, not a hunch: the specific movement must account for
 * at least `overlapPct` of the broader one (`dominantPct` for the overall
 * total). A $40 subscription rise inside a $600 category jump explains nothing,
 * and both sentences deserve to be said.
 */
function supersede(
  insights: Insight[],
  spend: { current: WindowSpend; previous: WindowSpend } | null | undefined,
  t: InsightThresholds,
): Insight[] {
  const dropped = new Set<string>();
  const byEntity = (kind: InsightKind) =>
    new Map(insights.filter(i => i.kind === kind).map(i => [i.entity, i]));

  const categoryChangeByEntity = byEntity('category-change');
  const explains = (specific: Insight, broad: Insight, pct: number): boolean =>
    broad.monthlyImpact > 0 && specific.monthlyImpact >= broad.monthlyImpact * (pct / 100);

  // A recurring rise explains its own category.
  for (const insight of insights) {
    if (insight.kind !== 'recurring-increase') continue;
    const category = insight.facts.kind === 'recurring-increase' ? insight.facts.category : null;
    if (!category) continue;
    const broad = categoryChangeByEntity.get(`category:${categoryKey(category)}`);
    if (broad && explains(insight, broad, t.overlapPct)) dropped.add(broad.key);
  }

  // One outsized charge explains its own category.
  for (const insight of insights) {
    if (insight.kind !== 'unusual-transaction') continue;
    const broad = categoryChangeByEntity.get(insight.entity);
    if (broad && explains(insight, broad, t.overlapPct)) dropped.add(broad.key);
  }

  // A cap missed (or beaten) for months supersedes the same money measured
  // against the previous window — for a category and for the overall total
  // alike. Both are true; only one of them tells the user what to do.
  for (const insight of insights) {
    if (insight.kind !== 'budget-trend') continue;
    for (const other of insights) {
      if (other.kind !== 'category-change' && other.kind !== 'spending-change') continue;
      if (other.entity === insight.entity) dropped.add(other.key);
    }
  }

  // One dominant category explains the whole movement.
  const overall = insights.find(i => i.kind === 'spending-change');
  if (overall && spend && !dropped.has(overall.key)) {
    const overallDelta = overall.facts.kind === 'spending-change' ? overall.facts.delta : 0;
    const top = categoryDeltas(spend)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    const sameWay = top && overallDelta !== 0 && Math.sign(top.delta) === Math.sign(overallDelta);
    const dominant = sameWay
      && Math.abs(top.delta) >= Math.abs(overallDelta) * (t.dominantPct / 100);
    // Only when something SURVIVING actually says the specific thing — otherwise
    // dropping the overall figure would leave the movement unreported entirely.
    const spokenSpecifically = dominant && insights.some(i =>
      i.entity === `category:${top.key}` && !dropped.has(i.key));
    if (spokenSpecifically) dropped.add(overall.key);
  }

  return insights.filter(i => !dropped.has(i.key));
}

// ─── The report ──────────────────────────────────────────────────────────────

/**
 * Build every insight that currently holds, apply stored dismissal/read state,
 * and report which stored records no longer describe anything.
 *
 * Every dimension is optional. A caller that has no loans passes no loans and
 * gets no loan insights — the absence of an input is never reported as a
 * finding, and never throws.
 */
export function buildInsights(params: BuildInsightsParams): InsightReport {
  const t = { ...DEFAULT_INSIGHT_THRESHOLDS, ...(params.thresholds ?? {}) };
  const { asOf, window, previousWindow } = params;
  const month = asOf.slice(0, 7);
  const skipped: string[] = [];

  /** True when the caller's history reaches back to `from`. */
  const covers = (from: string): boolean =>
    !params.coverageFrom || params.coverageFrom <= from;

  const windowsCovered = covers(previousWindow.from);
  let insights: Insight[] = [];

  // ── Changes over the rolling window ──
  //
  // All of these compare two windows, so all of them need both windows loaded.
  // Said once here rather than in each rule: a partially-loaded history makes
  // every one of them wrong in the same way.
  if (!windowsCovered) {
    skipped.push(`Spending, income and cash flow: history does not reach back to ${previousWindow.from}.`);
  } else {
    if (params.spend) {
      const overall = spendingChange(params.spend, window, month, t);
      if (overall) insights.push(overall);
      insights.push(...categoryChanges(params.spend, window, month, t));
    }
    if (params.income) {
      const income = incomeChange(params.income, window, month, t);
      if (income) insights.push(income);
    }
    if (params.netMovement) {
      const cash = cashFlowTrend(params.netMovement, params.forecast, window, month, t);
      if (cash) insights.push(cash);
    }
  }

  // ── Inside the current window only ──
  //
  // A price rise and an outsized charge are both facts about charges that have
  // happened, so they need the current window and nothing before it.
  if (covers(window.from)) {
    if (params.recurring?.length) insights.push(...recurringIncreases(params.recurring, month, t));
    if (params.transactions?.length) {
      insights.push(...unusualTransactions(params.transactions, window, month, t));
    }
  }

  // ── Budgets, over complete months ──
  const history = (params.budgetHistory ?? []).filter(r => covers(`${r.month}-01`));
  if ((params.budgetHistory?.length ?? 0) > history.length) {
    skipped.push('Some budget months were left out: history does not cover them.');
  }
  if (history.length > 0) insights.push(...budgetTrends(history, t));

  // ── Standing facts from the other engines ──
  if (params.loans) {
    insights.push(...debtProgress(params.loans, t));
    insights.push(...offsetBenefits(params.loans, t));
  }
  if (params.property) insights.push(...propertyPerformance(params.property, t));
  if (params.tax) {
    if (covers(params.tax.start)) {
      const tax = taxDeductions(params.tax, t);
      if (tax) insights.push(tax);
    } else {
      skipped.push(`Tax: history does not reach back to the start of ${params.tax.fy}.`);
    }
  }

  // ── Anything a live alert is already saying ──
  //
  // Dropped whole: the user is being shown the more urgent version of this fact
  // a few pixels away, and two voices on one subject is the definition of noise.
  const spokenFor = new Set(params.spokenFor ?? []);
  let suppressedByAlert = 0;
  if (spokenFor.size > 0) {
    const before = insights.length;
    insights = insights.filter(i => !spokenFor.has(i.entity));
    suppressedByAlert = before - insights.length;
  }

  // ── One thing, said once ──
  insights = supersede(insights, params.spend, t);

  // ── Apply stored dismissal / read state ──
  const stateByKey = new Map((params.states ?? []).map(s => [s.key, s]));
  const live = new Set<string>();
  for (const insight of insights) {
    live.add(insight.key);
    const state = stateByKey.get(insight.key);
    if (!state) continue;
    // A dismissal covers the stage it was made at and everything below it.
    // A movement that grows into a worse stage lifts it — that IS the news.
    insight.dismissed = state.dismissedStage != null && insight.stage <= state.dismissedStage;
    insight.unread = !(state.readStage != null && insight.stage <= state.readStage);
  }

  const sorted = sortInsights(insights);
  const visible = sorted.filter(i => !i.dismissed);

  return {
    asOf,
    window,
    previousWindow,
    all: sorted,
    visible,
    unreadCount: visible.filter(i => i.unread).length,
    // Stored state for an observation that no longer holds. Keeping it would
    // mean a dismissal outliving the situation it was about — spending spikes,
    // the user dismisses it, it settles, it spikes again, and nothing is said.
    resolvedKeys: (params.states ?? [])
      .map(s => s.key)
      .filter(key => isInsightKey(key) && !live.has(key)),
    suppressedByAlert,
    skipped,
  };
}

// ─── Window helpers ──────────────────────────────────────────────────────────

/** `days` before `date`, `YYYY-MM-DD`, in UTC (no local-timezone drift). */
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The pair of windows every change is measured across: the `days` ending today
 * (today included), and the `days` immediately before them.
 *
 * Trailing windows rather than calendar months, deliberately. A month still
 * running is compared against a complete one — the 3rd of the month against all
 * of last month — and that comparison says "spending is down 90%" every month,
 * on the 3rd. Two equal windows are always comparable.
 */
export function insightWindows(asOf: string, days: number): {
  window: InsightWindow;
  previousWindow: InsightWindow;
} {
  const span = Math.max(1, Math.round(days));
  const from = shiftDays(asOf, -(span - 1));
  const previousTo = shiftDays(from, -1);
  const previousFrom = shiftDays(previousTo, -(span - 1));
  return {
    window: { from, to: asOf, days: span },
    previousWindow: { from: previousFrom, to: previousTo, days: span },
  };
}
