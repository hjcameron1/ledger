/**
 * Phase 6.2 — the financial review (pure engine).
 *
 * A review is a PERIOD, summarised: one week or one calendar month of the
 * user's money, read back to them once it is over. It sits on top of Phase 6.1
 * and adds no arithmetic of its own — every figure it prints was produced by an
 * engine that owns it:
 *
 *   • buildInsights        — what changed, ranked in dollars (6.1)
 *   • transactionCore      — what was spent, what came in, what moved (via the DS)
 *   • buildCashFlowForecast— where cash is heading (3.1)
 *   • buildGoalReport      — what each goal needs, and what is spare for it (4.3)
 *
 * The insights it is handed already carry their own provenance and links, so a
 * review can never disagree with the card, page or engine behind any line in it.
 *
 * ── What a review is FOR ─────────────────────────────────────────────────────
 * Alerts interrupt ("this needs a decision now"). Insights explain ("this is
 * what moved"). A review is the third thing: a bounded, complete period the user
 * can sit down with — what improved, what worsened, the biggest movements, what
 * is coming, and what they could actually do about it. It is the only surface
 * here that is allowed to be quiet and still say something: "a quiet month" is a
 * real answer, and one worth reading.
 *
 * ── Why only COMPLETE periods ────────────────────────────────────────────────
 * A review of a week that is still running compares four days with seven and
 * concludes spending has collapsed. The latest review is therefore the last
 * period that has ENDED, and every earlier one stays available (`reviewPeriods`)
 * so the user can page back through them. Nothing is stored: a past review is
 * re-derived from the same data, which is why it cannot drift from the numbers
 * it describes and why paging back costs nothing but a rebuild.
 *
 * ── Why a past review says less ──────────────────────────────────────────────
 * Standing facts (an offset saving, a property's holding cost, the tax year so
 * far) describe TODAY, not the period being read, and the forecast and the goal
 * report only know about the future from here. Both are therefore dropped from a
 * historical review and the omission is stated rather than left to be inferred —
 * a silent absence reads as "nothing to report", which would be a lie.
 *
 * ── Not saying the same thing twice ──────────────────────────────────────────
 * Three separate rules, each tested:
 *
 *   1. NOT AN ALERT AGAIN — anything a live alert is already shouting about is
 *      left out of the review entirely, and counted. The review points at the
 *      alert card instead of paraphrasing it.
 *   2. ONCE PER REVIEW — an insight appears in exactly one section. The biggest
 *      movements are lifted out first; "what improved" and "what worsened" are
 *      what is LEFT, not a second pass over the same list.
 *   3. NO SECOND VOICE ON ONE SUBJECT — a forward-looking risk is dropped when a
 *      change in the review is already delivering that bad news about the same
 *      thing (a worsening cash-flow insight already carries the forecast's own
 *      figures). If the change is an IMPROVEMENT, the risk survives: "cash flow
 *      is better than it was" and "it still runs out in three weeks" are two
 *      different facts and the user needs both.
 *
 * Pure and dependency-injected (`asOf`, the period, and every report are passed
 * in), so the DS layer (`reviewDS`) is the only thing that touches state.
 */

import { addDays, round2 } from './cashFlowForecast';
import type { CashFlowForecast } from './cashFlowForecast';
import type { GoalReport } from './savingsGoals';
import { sortInsights } from './insights';
import type { Insight, InsightKind, InsightWindow } from './insights';

// ─── Periods ─────────────────────────────────────────────────────────────────

export type ReviewPeriodKind = 'week' | 'month';

/** One reviewable stretch of time. `key` is its stable identity (and its URL). */
export interface ReviewPeriod {
  kind: ReviewPeriodKind;
  /** `2026-W33` for a week, `2026-07` for a month. */
  key: string;
  /** Inclusive first day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  to: string;
  /** Days in the period — 7, or 28–31. */
  days: number;
}

const MS_PER_DAY = 86_400_000;

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both ends counted. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / MS_PER_DAY) + 1;
}

/** The Monday of the ISO week `date` falls in. */
function mondayOf(date: string): string {
  const d = utc(date);
  // getUTCDay() is 0 for Sunday; ISO weeks start on Monday.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return iso(d);
}

/**
 * The ISO-8601 week key for a Monday, `YYYY-Www`.
 *
 * Numbered off the week's own THURSDAY, which is what makes the year in the key
 * right for the weeks that straddle New Year: the last week of December can
 * belong to the next year, and the first days of January to the previous one.
 */
function weekKeyOf(monday: string): string {
  const thursday = utc(addDays(monday, 3));
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * MS_PER_DAY)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Last day of the calendar month `date` falls in. */
function endOfMonth(date: string): string {
  const d = utc(date);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return iso(last);
}

/** The period of the given kind that contains `date` — running or finished. */
export function periodContaining(date: string, kind: ReviewPeriodKind): ReviewPeriod {
  if (kind === 'week') {
    const from = mondayOf(date);
    const to = addDays(from, 6);
    return { kind, key: weekKeyOf(from), from, to, days: 7 };
  }
  const from = `${date.slice(0, 7)}-01`;
  const to = endOfMonth(from);
  return { kind, key: from.slice(0, 7), from, to, days: daysInclusive(from, to) };
}

/** The period immediately before this one. */
export function previousPeriod(period: ReviewPeriod): ReviewPeriod {
  return periodContaining(addDays(period.from, -1), period.kind);
}

/** The period immediately after this one. */
export function nextPeriod(period: ReviewPeriod): ReviewPeriod {
  return periodContaining(addDays(period.to, 1), period.kind);
}

/**
 * The last `count` COMPLETE periods, newest first.
 *
 * Complete means ended: the period `asOf` falls in is still being lived and is
 * never reviewed — see the note at the top about four days against seven.
 */
export function reviewPeriods(asOf: string, kind: ReviewPeriodKind, count: number): ReviewPeriod[] {
  const out: ReviewPeriod[] = [];
  let period = previousPeriod(periodContaining(asOf, kind));
  for (let i = 0; i < Math.max(0, count); i++) {
    out.push(period);
    period = previousPeriod(period);
  }
  return out;
}

/** Parse a period key back into a period. Null when it is not one. */
export function reviewPeriodFor(key: string): ReviewPeriod | null {
  const month = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (month) {
    const monthNumber = Number(month[2]);
    if (monthNumber < 1 || monthNumber > 12) return null;
    return periodContaining(`${key}-01`, 'month');
  }

  const week = /^(\d{4})-W(\d{2})$/.exec(key ?? '');
  if (week) {
    const year = Number(week[1]);
    const number = Number(week[2]);
    if (number < 1 || number > 53) return null;
    // Week 1 is the week containing 4 January, by definition.
    const firstMonday = mondayOf(iso(new Date(Date.UTC(year, 0, 4))));
    const monday = addDays(firstMonday, (number - 1) * 7);
    const period = periodContaining(monday, 'week');
    // 53 exists only in some years; anything that lands in the wrong year is not
    // a real week and is reported as such rather than silently shifted.
    return period.key === key ? period : null;
  }

  return null;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * How much a review may say, and the smallest risk worth naming.
 *
 * The caps are the point: everything reaching this engine has already cleared
 * the 6.1 floors, so the job here is not filtering noise out of the data — it is
 * keeping a summary a summary. What does not fit is counted, never silently
 * dropped (`omitted`).
 */
export interface ReviewThresholds {
  /** The headline movements, lifted out before anything else. */
  maxBiggest: number;
  maxImproved: number;
  maxWorsened: number;
  maxRisks: number;
  maxActions: number;
  /**
   * Net cash going out across the forecast horizon before it is called a risk.
   * Measured over the WIDEST horizon the caller built, so it is a statement
   * about savings being run down rather than about one lumpy fortnight.
   */
  minCashDrain: number;
  /** Monthly shortfall before an off-pace goal is worth naming. */
  minGoalShortfall: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  maxBiggest: 3,
  maxImproved: 3,
  maxWorsened: 3,
  maxRisks: 3,
  maxActions: 4,
  minCashDrain: 1_000,
  minGoalShortfall: 25,
};

// ─── What a review contains ──────────────────────────────────────────────────

/** Which part of the review an insight was placed in. */
export type ReviewSectionName = 'biggest' | 'improved' | 'worsened';

/** The period's totals, and the same totals for the period compared against. */
export interface ReviewTotals {
  spend: number;
  income: number;
  /** Signed net movement — what actually landed in, or left, the accounts. */
  net: number;
  previousSpend: number;
  previousIncome: number;
  previousNet: number;
  /** Signed differences. Positive spend delta means more was spent. */
  spendDelta: number;
  incomeDelta: number;
  netDelta: number;
}

/** The numbers behind a risk, as data rather than a sentence. */
export type ReviewRiskFacts =
  | {
    kind: 'cash-shortfall';
    /** The lowest the forecast expects total bank cash to reach. */
    lowest: number;
    lowestDate: string;
    days: number;
    openingBalance: number;
    projectedBalance: number;
  }
  | {
    kind: 'cash-drain';
    /** Net cash over the horizon — negative, or this is not a risk. */
    net: number;
    days: number;
    openingBalance: number;
    projectedBalance: number;
  }
  | {
    kind: 'goal-shortfall';
    name: string;
    /** True once the target date has passed with the goal still short. */
    overdue: boolean;
    remaining: number;
    requiredPerMonth: number | null;
    allocatedPerMonth: number;
    shortfallPerMonth: number;
    targetDate: string | null;
  };

/**
 * Something the period does not show but the next one will feel.
 *
 * Risks are FORWARD-looking and therefore only produced for the latest review:
 * "what was about to happen in March" is not a thing anyone needs told in
 * August, and the forecast could not answer it honestly anyway.
 */
export interface ReviewRisk {
  key: string;
  /** What it is ABOUT, in the insight engine's terms — `cash`, `goal:<id>`. */
  entity: string;
  severity: 'high' | 'medium';
  source: 'forecast' | 'goals';
  /** Short heading — never contains money, so the component owns all formatting. */
  title: string;
  facts: ReviewRiskFacts;
  link: { to: string; label: string };
  /** Size of the risk in dollars, for ordering. */
  amount: number;
}

/** One thing the user could do next, pointing at the page that does it. */
export interface ReviewAction {
  key: string;
  label: string;
  to: string;
  /** Why this action, in one line. Never contains money. */
  reason: string;
  /** The insight or risk keys that asked for it. */
  sourceKeys: string[];
}

export interface ReviewReport {
  period: ReviewPeriod;
  /** True when this is the most recent COMPLETE period. */
  latest: boolean;
  asOf: string;
  /** The window the period's changes were measured against, when there was one. */
  comparedWith: InsightWindow | null;
  /** False when the loaded history does not reach the start of the period. */
  covered: boolean;
  /** True when the period is covered and nothing in it cleared the floors. */
  quiet: boolean;
  totals: ReviewTotals | null;
  /** The headline movements, biggest first. */
  biggest: Insight[];
  /** Good news that did not make the headline. */
  improved: Insight[];
  /** Bad news that did not make the headline. */
  worsened: Insight[];
  risks: ReviewRisk[];
  actions: ReviewAction[];
  /** How many insights the review had to choose from, after suppression. */
  considered: number;
  /** How many of those did not fit a section — the "and N smaller changes" tail. */
  omitted: number;
  suppressed: {
    /** Left out because a live alert is already saying it. */
    alerts: number;
    /** Left out because something else in this review already says it. */
    duplicates: number;
  };
  /** What was NOT looked at, and why — one line per omission. */
  skipped: string[];
}

export interface BuildReviewParams {
  period: ReviewPeriod;
  /** True when `period` is the most recent complete one. Drives every
   *  forward-looking section — see the note at the top. */
  latest: boolean;
  /** Today, `YYYY-MM-DD`. Injected for determinism. */
  asOf: string;
  /**
   * The oldest date the caller's history actually covers. A review of a period
   * starting before it is reported as uncovered rather than as quiet: unloaded
   * history and a quiet month are identical in the data and opposite in meaning.
   */
  coverageFrom?: string | null;
  /** The 6.1 insights for this period — already ranked, already floored. */
  insights?: Insight[];
  /** The window those insights were measured against. */
  comparedWith?: InsightWindow | null;
  /** Period totals from transactionCore, and the same for the compared window. */
  totals?: {
    current: { spend: number; income: number; net: number };
    previous: { spend: number; income: number; net: number };
  } | null;
  /** Latest review only — where cash is heading from here. */
  forecast?: CashFlowForecast | null;
  /** Latest review only — what the goals need from here. */
  goals?: GoalReport | null;
  /** Entities a live alert is already speaking about — see rule 1 at the top. */
  alertEntities?: string[];
  /**
   * Insights the CALLER already removed for that same reason.
   *
   * The 6.1 engine suppresses before it ranks and supersedes, so those insights
   * never reach this one. Counted here anyway: the review has to be able to say
   * "and two more are already in Needs your attention" rather than quietly
   * showing a shorter list and letting it read as everything there was.
   */
  alreadySuppressed?: number;
  thresholds?: Partial<ReviewThresholds>;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * Why an insight's own link is worth following.
 *
 * The link and its label belong to the insight (and therefore to the engine that
 * produced it); all this adds is the reason, which is about what the user would
 * DO there. No money, so the component still owns every formatted figure.
 */
const ACTION_REASON: Record<InsightKind, string> = {
  'spending-change': 'See what the money actually went on',
  'category-change': 'See what the money actually went on',
  'income-change': 'Check the pay that landed against what you expected',
  'recurring-increase': 'Decide whether it is still worth the new price',
  'unusual-transaction': 'Check the charge was one you meant to make',
  'budget-trend': 'Either the cap or the spending needs to move',
  'cash-flow-trend': 'See where the forecast takes it from here',
  'debt-progress': 'See what the extra repayments are buying you',
  'offset-benefit': 'See what the offset is saving while it sits there',
  'property-performance': 'See what the property costs to hold',
  'tax-deductions': 'Check the claim while the year is still open',
};

/**
 * One action per destination, urgent first.
 *
 * Risks lead: they are the only part of a review about something that has not
 * happened yet. Everything else follows the ranking it already had. Two insights
 * pointing at one page produce ONE action carrying both their keys, because
 * "View transactions" twice is not two actions.
 */
function buildActions(items: Insight[], risks: ReviewRisk[], t: ReviewThresholds): ReviewAction[] {
  const byTarget = new Map<string, ReviewAction>();

  const add = (to: string, label: string, reason: string, sourceKey: string) => {
    const existing = byTarget.get(to);
    if (existing) {
      existing.sourceKeys.push(sourceKey);
      return;
    }
    byTarget.set(to, { key: `action:${to}`, label, to, reason, sourceKeys: [sourceKey] });
  };

  for (const risk of risks) {
    add(
      risk.link.to,
      risk.link.label,
      risk.facts.kind === 'goal-shortfall'
        ? 'Adjust the goal, or what goes into it'
        : 'See when cash gets tight, and what is driving it',
      risk.key,
    );
  }
  for (const insight of items) {
    add(insight.link.to, insight.link.label, ACTION_REASON[insight.kind], insight.key);
  }

  return [...byTarget.values()].slice(0, t.maxActions);
}

// ─── Risks ───────────────────────────────────────────────────────────────────

/**
 * What the forecast says about the period ahead.
 *
 * Read off the widest horizon the caller built, and off its own fields —
 * `lowestBalance` is the liquidity figure the forecast engine already computes,
 * so nothing here re-projects anything. Running OUT of money outranks merely
 * going backwards, and only one of the two is ever reported: they are the same
 * story told at two volumes.
 */
function cashRisks(forecast: CashFlowForecast | null | undefined, t: ReviewThresholds): ReviewRisk[] {
  const horizon = forecast?.horizons?.[forecast.horizons.length - 1];
  if (!horizon) return [];

  if (horizon.lowestBalance < 0) {
    return [{
      key: `risk:cash-shortfall:${horizon.days}`,
      entity: 'cash',
      severity: 'high',
      source: 'forecast',
      title: 'Your forecast has cash running out',
      facts: {
        kind: 'cash-shortfall',
        lowest: round2(horizon.lowestBalance),
        lowestDate: horizon.lowestDate,
        days: horizon.days,
        openingBalance: round2(horizon.openingBalance),
        projectedBalance: round2(horizon.projectedBalance),
      },
      link: { to: '/forecast', label: 'View forecast' },
      amount: Math.abs(round2(horizon.lowestBalance)),
    }];
  }

  if (horizon.net <= -t.minCashDrain) {
    return [{
      key: `risk:cash-drain:${horizon.days}`,
      entity: 'cash',
      severity: 'medium',
      source: 'forecast',
      title: 'More is going out than coming in',
      facts: {
        kind: 'cash-drain',
        net: round2(horizon.net),
        days: horizon.days,
        openingBalance: round2(horizon.openingBalance),
        projectedBalance: round2(horizon.projectedBalance),
      },
      link: { to: '/forecast', label: 'View forecast' },
      amount: Math.abs(round2(horizon.net)),
    }];
  }

  return [];
}

/**
 * Goals the forecast cannot fund in time.
 *
 * The status is the goals engine's own verdict (4.3) — `behind`, `at-risk` and
 * `overdue` are its words, and the shortfall is its figure. Nothing is decided
 * here beyond which of them is worth a line in a summary.
 */
function goalRisks(goals: GoalReport | null | undefined, t: ReviewThresholds): ReviewRisk[] {
  const out: ReviewRisk[] = [];
  for (const line of goals?.lines ?? []) {
    const overdue = line.status === 'overdue';
    if (!overdue && line.status !== 'behind' && line.status !== 'at-risk') continue;
    // An overdue goal is a fact about a date that has passed, so it stands on its
    // own; the others are a claim about pace, and a trivial one is not worth
    // making.
    if (!overdue && line.shortfallPerMonth < t.minGoalShortfall) continue;

    out.push({
      key: `risk:goal:${line.id}`,
      entity: `goal:${line.id}`,
      severity: overdue ? 'high' : 'medium',
      source: 'goals',
      title: overdue ? 'A goal has passed its date' : 'A goal is not on pace',
      facts: {
        kind: 'goal-shortfall',
        name: line.name,
        overdue,
        remaining: round2(line.remaining),
        requiredPerMonth: line.requiredPerMonth != null ? round2(line.requiredPerMonth) : null,
        allocatedPerMonth: round2(line.allocatedPerMonth),
        shortfallPerMonth: round2(line.shortfallPerMonth),
        targetDate: line.targetDate,
      },
      link: { to: `/?focus=goal:${encodeURIComponent(line.id)}`, label: 'View goal' },
      amount: overdue ? round2(line.remaining) : round2(line.shortfallPerMonth),
    });
  }
  return out;
}

const SEVERITY_RANK: Record<ReviewRisk['severity'], number> = { high: 0, medium: 1 };

function sortRisks(risks: ReviewRisk[]): ReviewRisk[] {
  return [...risks].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.amount !== a.amount) return b.amount - a.amount;
    return a.key.localeCompare(b.key);
  });
}

// ─── The review ──────────────────────────────────────────────────────────────

export function buildReview(params: BuildReviewParams): ReviewReport {
  const t = { ...DEFAULT_REVIEW_THRESHOLDS, ...(params.thresholds ?? {}) };
  const { period, latest, asOf } = params;
  const skipped: string[] = [];

  const covered = !params.coverageFrom || params.coverageFrom <= period.from;

  const empty = (): ReviewReport => ({
    period,
    latest,
    asOf,
    comparedWith: params.comparedWith ?? null,
    covered,
    quiet: false,
    totals: null,
    biggest: [], improved: [], worsened: [], risks: [], actions: [],
    considered: 0,
    omitted: 0,
    suppressed: { alerts: 0, duplicates: 0 },
    skipped,
  });

  // A period the history does not reach is not a quiet period. Reporting totals
  // for it would be worse than saying nothing: they would be real figures over
  // a partly-loaded period, and they would look complete.
  if (!covered) {
    skipped.push(`This period is not fully loaded: history only reaches back to ${params.coverageFrom}.`);
    return empty();
  }

  // ── The insights this review may use ──
  let considered = sortInsights(params.insights ?? []);

  // Standing facts describe today, not the period being read.
  if (!latest) {
    const standing = considered.filter(i => i.window === null);
    if (standing.length > 0) {
      skipped.push('Loans, property and tax are only in the latest review — they describe today, not this period.');
    }
    considered = considered.filter(i => i.window !== null);
  }

  // Rule 1 — anything a live alert is already shouting about.
  const spokenFor = new Set(params.alertEntities ?? []);
  let suppressedAlerts = Math.max(0, params.alreadySuppressed ?? 0);
  if (spokenFor.size > 0) {
    const before = considered.length;
    considered = considered.filter(i => !spokenFor.has(i.entity));
    suppressedAlerts += before - considered.length;
  }

  // Rule 2 — the biggest movements come out first, and what is LEFT is split by
  // direction. Nothing is in two sections, so nothing is read twice.
  const biggest = considered.slice(0, t.maxBiggest);
  const lifted = new Set(biggest.map(i => i.key));
  const rest = considered.filter(i => !lifted.has(i.key));
  const improved = rest.filter(i => i.direction === 'improving').slice(0, t.maxImproved);
  const worsened = rest.filter(i => i.direction === 'worsening').slice(0, t.maxWorsened);

  const items = [...biggest, ...improved, ...worsened];
  const shown = new Set(items.map(i => i.key));

  // ── What is coming ──
  let risks: ReviewRisk[] = [];
  let suppressedDuplicates = 0;
  if (!latest) {
    skipped.push('Upcoming risks are only shown for the latest review — the forecast starts from today.');
  } else {
    risks = [...cashRisks(params.forecast, t), ...goalRisks(params.goals, t)];

    const beforeAlerts = risks.length;
    risks = risks.filter(r => !spokenFor.has(r.entity));
    suppressedAlerts += beforeAlerts - risks.length;

    // Rule 3 — a risk about something this review already reports as getting
    // worse is the same bad news in a second voice. An IMPROVING change about
    // the same thing is not: "better than it was" and "still runs out" are both
    // true and only one of them is a warning.
    const alreadyBadNews = new Set(
      items.filter(i => i.direction === 'worsening').map(i => i.entity),
    );
    const beforeDuplicates = risks.length;
    risks = risks.filter(r => !alreadyBadNews.has(r.entity));
    suppressedDuplicates += beforeDuplicates - risks.length;

    risks = sortRisks(risks).slice(0, t.maxRisks);
  }

  const totals: ReviewTotals | null = params.totals
    ? {
      spend: round2(params.totals.current.spend),
      income: round2(params.totals.current.income),
      net: round2(params.totals.current.net),
      previousSpend: round2(params.totals.previous.spend),
      previousIncome: round2(params.totals.previous.income),
      previousNet: round2(params.totals.previous.net),
      spendDelta: round2(params.totals.current.spend - params.totals.previous.spend),
      incomeDelta: round2(params.totals.current.income - params.totals.previous.income),
      netDelta: round2(params.totals.current.net - params.totals.previous.net),
    }
    : null;

  return {
    period,
    latest,
    asOf,
    comparedWith: params.comparedWith ?? null,
    covered,
    // A quiet period is a real answer, not an empty screen: everything was
    // looked at and nothing cleared the floors.
    quiet: items.length === 0 && risks.length === 0,
    totals,
    biggest,
    improved,
    worsened,
    risks,
    actions: buildActions(items, risks, t),
    considered: considered.length,
    omitted: considered.length - shown.size,
    suppressed: { alerts: suppressedAlerts, duplicates: suppressedDuplicates },
    skipped,
  };
}
