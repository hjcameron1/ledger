/**
 * Phase 3.3 — Adaptive forecasting (pure learner).
 *
 * Extends the cash-flow forecast by LEARNING two things from transaction
 * history, then expressing each as an ordinary `RecurringInput` that feeds the
 * SAME engine (utils/cashFlowForecast.ts). All projection maths — occurrence
 * generation, horizon accrual, per-account posting and transfer netting — stay
 * in the engine and are never re-implemented here; this module only decides
 * WHAT to project:
 *
 *   1. Recurring income   — regular salary/pay deposits, detected from repeated,
 *      regularly-spaced inflows from the same payer.
 *   2. Discretionary spend — a representative monthly rate per spending category
 *      from recent history, projected forward as a smooth weekly outflow.
 *
 * Everything is dependency-injected (history + `asOf` + the already-known
 * obligations) and pure, so it is fully node-testable.
 *
 * ── What is deliberately excluded from learning ─────────────────────────────
 *  • Internal transfers — never learned (neither as income nor as spend), so
 *    they contribute nothing and the All-Accounts total still nets to zero.
 *  • Refunds and other inflows — excluded from the spend average.
 *  • Transactions already modelled as a known recurring obligation (e.g. tagged
 *    with a forecast recurring_series) — excluded so we never double-count.
 *  • Abnormal one-off purchases — removed as outliers so a single big-ticket buy
 *    doesn't inflate a category's "normal" rate.
 *
 * ── Blending without double-counting ────────────────────────────────────────
 *  • A learned income stream that matches a user-declared income obligation is
 *    suppressed (the declared record wins).
 *  • For each category, the monthly amount ALREADY covered by known obligations
 *    (bills/subscriptions in that category) is subtracted from the learned
 *    average; only the residual is projected. A category fully covered by a bill
 *    yields no learned spend.
 */

import {
  round2,
  addDays,
  addMonths,
  amountsClose,
  nameOverlap,
  UNALLOCATED,
  type RecurringInput,
  type ForecastFrequency,
} from './cashFlowForecast';

/** Average length of a calendar month — converts between per-period and monthly
 *  rates. Matches the value used across the codebase's recurring maths. */
const DAYS_PER_MONTH = 30.4375;

/**
 * Minimal, source-agnostic view of one historical transaction the learner needs.
 * The DS builds these from stored Transactions using the canonical
 * transactionCore classifiers (isSpendTransaction / isTransferTransaction /
 * isRefundTransaction / effectiveAmount), so "what counts as spend" is decided
 * in exactly one place and this module never re-derives it.
 */
export interface HistoryTxn {
  /** `YYYY-MM-DD`. */
  date: string;
  /** SIGNED display-currency amount: +inflow, −outflow. */
  amount: number;
  category: string;
  accountId: string | null;
  /** Normalised merchant key, for grouping a payer's deposits. */
  merchantKey: string;
  /** Display merchant name, used to label a detected income stream. */
  merchantName?: string;
  /** Genuine discretionary-eligible outflow (transactionCore.isSpendTransaction). */
  isSpend: boolean;
  /** Internal transfer leg — never learned. */
  isTransfer: boolean;
  /** Matched refund inflow — never learned. */
  isRefund: boolean;
  /** Already modelled as a known recurring obligation (e.g. tagged with a
   *  forecast recurring_series) — excluded from learning to avoid double count. */
  committed: boolean;
}

export interface AdaptiveConfig {
  /** How many days back to learn from. Default 90. */
  lookbackDays: number;
  /** Min regularly-spaced deposits before a payer is called recurring income. Default 3. */
  minIncomeOccurrences: number;
  /** Min transactions in a category before its average is trusted. Default 3. */
  minCategoryTxns: number;
  /** Min observed span (days) a category must cover before it is projected. Default 21. */
  minCategorySpanDays: number;
  /** Min residual monthly spend worth projecting (display currency). Default 5. */
  minMonthlySpend: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  lookbackDays: 90,
  minIncomeOccurrences: 3,
  minCategoryTxns: 3,
  minCategorySpanDays: 21,
  minMonthlySpend: 5,
};

/** A learned recurring income stream. */
export interface LearnedIncome {
  merchantKey: string;
  name: string;
  /** Per-occurrence amount (+inflow). */
  amount: number;
  frequency: ForecastFrequency;
  /** First projected occurrence, `YYYY-MM-DD`. */
  nextDate: string;
  accountId: string | null;
  occurrences: number;
  confidence: number;
  /** True when suppressed because a declared income obligation already covers it. */
  suppressed?: boolean;
}

/** A learned per-category discretionary-spend rate. */
export interface LearnedCategory {
  category: string;
  /** Learned monthly rate from history (after outlier removal), before blending. */
  monthlyObserved: number;
  /** Monthly amount already covered by known bills/subscriptions in this category. */
  monthlyKnown: number;
  /** Residual monthly spend actually projected (max(0, observed − known)). */
  monthlyResidual: number;
  accountId: string | null;
  txns: number;
  removedOutliers: number;
}

export interface AdaptiveResult {
  /** Learned movements ready to concat with the known inputs and hand to the engine. */
  learnedInputs: RecurringInput[];
  /** Every income stream considered (incl. suppressed) — for audit / UI. */
  income: LearnedIncome[];
  /** Every category rate learned — for audit / UI. */
  categories: LearnedCategory[];
}

// ── Small statistics helpers (pure) ──────────────────────────────────────────

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Signed day gap between two ISO dates (b − a). NaN when unparseable. */
function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return NaN;
  return (db - da) / 86_400_000;
}

/** Monthly-equivalent magnitude of a recurring amount at a given cadence. `once`
 *  contributes nothing to an ongoing monthly rate. */
export function monthlyEquivalent(amount: number, frequency: ForecastFrequency): number {
  const a = Math.abs(amount);
  switch (frequency) {
    case 'weekly': return a * (DAYS_PER_MONTH / 7);
    case 'fortnightly': return a * (DAYS_PER_MONTH / 14);
    case 'monthly': return a;
    case 'quarterly': return a / 3;
    case 'annually': return a / 12;
    default: return 0; // 'once' — not an ongoing rate
  }
}

/**
 * Drop abnormal one-off purchases from a category's spend magnitudes so a single
 * big-ticket buy doesn't inflate the "normal" rate. One-sided (only the upper
 * tail matters for spend) and robust: uses a median/MAD threshold, falling back
 * to a multiple of the median when the MAD is zero (a cluster of identical
 * charges plus one spike). Fewer than 4 points is too little to judge — keep all.
 */
export function removeOutliers(mags: number[]): { kept: number[]; removed: number } {
  if (mags.length < 4) return { kept: mags, removed: 0 };
  const med = median(mags);
  const mad = median(mags.map(m => Math.abs(m - med)));
  const threshold = mad > 0 ? med + 3.5 * mad : Math.max(med * 4, med + 1);
  const kept = mags.filter(m => m <= threshold);
  return { kept, removed: mags.length - kept.length };
}

function gapToFrequency(gap: number): ForecastFrequency | null {
  if (gap >= 5 && gap <= 9) return 'weekly';
  if (gap >= 12 && gap <= 16) return 'fortnightly';
  if (gap >= 26 && gap <= 33) return 'monthly';
  if (gap >= 84 && gap <= 96) return 'quarterly';
  return null;
}

/**
 * Infer a regular cadence from sorted occurrence dates. Returns null when the
 * spacing is too irregular to trust (so an ad-hoc set of deposits is never
 * mistaken for a salary). Every gap must sit within the larger of 4 days or 25%
 * of the median gap, and the median must map to a known pay cadence.
 */
export function detectCadence(
  datesSorted: string[],
): { frequency: ForecastFrequency; medianGap: number } | null {
  if (datesSorted.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < datesSorted.length; i++) {
    const g = daysBetween(datesSorted[i - 1], datesSorted[i]);
    if (Number.isNaN(g) || g <= 0) return null;
    gaps.push(g);
  }
  const med = median(gaps);
  const tol = Math.max(4, med * 0.25);
  if (!gaps.every(g => Math.abs(g - med) <= tol)) return null;
  const frequency = gapToFrequency(med);
  return frequency ? { frequency, medianGap: med } : null;
}

/** The next date after `lastDate` at a cadence — day-step for weekly/fortnightly,
 *  calendar-month step (with clamping) for monthly/quarterly/annually. */
function nextAfter(lastDate: string, frequency: ForecastFrequency): string {
  switch (frequency) {
    case 'weekly': return addDays(lastDate, 7);
    case 'fortnightly': return addDays(lastDate, 14);
    case 'monthly': return addMonths(lastDate, 1);
    case 'quarterly': return addMonths(lastDate, 3);
    case 'annually': return addMonths(lastDate, 12);
    default: return lastDate;
  }
}

/** The account most of a group's money moved through (by magnitude); null when
 *  that account is the unallocated bucket / unknown. */
function dominantAccount(txns: HistoryTxn[]): string | null {
  const totals = new Map<string, number>();
  for (const t of txns) {
    const id = t.accountId ?? UNALLOCATED;
    totals.set(id, (totals.get(id) ?? 0) + Math.abs(t.amount));
  }
  let best: string | null = null;
  let bestV = -1;
  for (const [id, v] of totals) {
    if (v > bestV) { bestV = v; best = id; }
  }
  return best === UNALLOCATED ? null : best;
}

// ── Learners ─────────────────────────────────────────────────────────────────

/** Detect regular salary/pay deposits: repeated, regularly-spaced inflows from
 *  the same payer, projected forward at the observed cadence and recent amount. */
function detectIncome(
  txns: HistoryTxn[],
  asOf: string,
  knownInputs: RecurringInput[],
  cfg: AdaptiveConfig,
): LearnedIncome[] {
  // Group genuine inflows (positive, not a transfer, not a refund) by payer.
  const groups = new Map<string, HistoryTxn[]>();
  for (const t of txns) {
    if (t.amount <= 0 || t.isTransfer || t.isRefund) continue;
    const key = t.merchantKey || t.category || 'income';
    const list = groups.get(key);
    if (list) list.push(t); else groups.set(key, [t]);
  }

  const declaredIncome = knownInputs.filter(i => i.sourceType === 'income');
  const out: LearnedIncome[] = [];

  for (const [key, list] of groups) {
    if (list.length < cfg.minIncomeOccurrences) continue; // sparse — not a pattern
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const cadence = detectCadence(sorted.map(t => t.date));
    if (!cadence) continue; // irregular spacing — not a salary

    const last = sorted[sorted.length - 1];
    // If the last deposit is much older than one interval, the stream has likely
    // ended — don't keep projecting a job that stopped.
    if (daysBetween(last.date, asOf) > cadence.medianGap * 1.6) continue;

    // Project the CURRENT level: median of the last few amounts. This tracks a
    // pay rise (a step change carries forward) while smoothing a one-off bonus.
    const amount = round2(median(sorted.slice(-3).map(t => t.amount)));
    if (amount <= 0) continue;

    const confidence = Math.min(0.85, 0.5 + 0.1 * (list.length - cfg.minIncomeOccurrences + 1));
    const detection: LearnedIncome = {
      merchantKey: key,
      name: last.merchantName || 'Recurring income',
      amount,
      frequency: cadence.frequency,
      nextDate: nextAfter(last.date, cadence.frequency),
      accountId: dominantAccount(sorted),
      occurrences: list.length,
      confidence,
    };

    // Blend: a declared income obligation covering this stream wins — suppress
    // the learned one so the same pay isn't counted twice.
    if (declaredIncome.some(d =>
      d.frequency === cadence.frequency &&
      amountsClose(d.amount, amount) &&
      nameOverlap(d.name, detection.name),
    )) {
      detection.suppressed = true;
    }

    out.push(detection);
  }

  return out.sort((a, b) => b.amount - a.amount);
}

/** Learn a representative monthly spend rate per category from recent history,
 *  then subtract what known obligations already cover so only the residual
 *  discretionary spend is projected. */
function learnCategories(
  txns: HistoryTxn[],
  asOf: string,
  knownInputs: RecurringInput[],
  cfg: AdaptiveConfig,
): LearnedCategory[] {
  // Monthly obligation already forecast per category (outflows with a category).
  const knownMonthlyByCat = new Map<string, number>();
  for (const i of knownInputs) {
    if (i.amount >= 0 || !i.category) continue;
    knownMonthlyByCat.set(
      i.category,
      (knownMonthlyByCat.get(i.category) ?? 0) + monthlyEquivalent(i.amount, i.frequency),
    );
  }

  // Group genuine spend by category (isSpend already excludes transfers, refunds,
  // income and explicitly non-spend categories).
  const byCat = new Map<string, HistoryTxn[]>();
  for (const t of txns) {
    if (!t.isSpend) continue;
    const cat = t.category || 'Uncategorised';
    const list = byCat.get(cat);
    if (list) list.push(t); else byCat.set(cat, [t]);
  }

  const out: LearnedCategory[] = [];
  for (const [category, list] of byCat) {
    if (list.length < cfg.minCategoryTxns) continue; // sparse — skip

    const { kept, removed } = removeOutliers(list.map(t => Math.abs(t.amount)));
    if (kept.length < cfg.minCategoryTxns) continue;

    // Observed span: earliest txn → asOf. Too short a span can't establish a
    // reliable monthly rate, so we skip rather than annualise a recent burst.
    const earliest = list.reduce((m, t) => (t.date < m ? t.date : m), list[0].date);
    const spanDays = daysBetween(earliest, asOf);
    if (!(spanDays >= cfg.minCategorySpanDays)) continue;

    const sum = kept.reduce((s, m) => s + m, 0);
    const monthlyObserved = round2(sum / (spanDays / DAYS_PER_MONTH));
    const monthlyKnown = round2(knownMonthlyByCat.get(category) ?? 0);
    const monthlyResidual = round2(Math.max(0, monthlyObserved - monthlyKnown));

    out.push({
      category,
      monthlyObserved,
      monthlyKnown,
      monthlyResidual,
      accountId: dominantAccount(list),
      txns: list.length,
      removedOutliers: removed,
    });
  }

  return out.sort((a, b) => b.monthlyResidual - a.monthlyResidual);
}

/**
 * Learn recurring income and typical discretionary spend from transaction
 * history and return them as `RecurringInput`s for the forecast engine, plus the
 * audit detail behind each. Pure and deterministic given `asOf`.
 */
export function learnFromHistory(params: {
  asOf: string;
  history: HistoryTxn[];
  knownInputs: RecurringInput[];
  config?: Partial<AdaptiveConfig>;
}): AdaptiveResult {
  const { asOf, knownInputs } = params;
  const cfg: AdaptiveConfig = { ...DEFAULT_ADAPTIVE_CONFIG, ...params.config };

  const windowStart = addDays(asOf, -cfg.lookbackDays);
  const inWindow = params.history.filter(
    t => t.date > windowStart && t.date <= asOf && !t.committed,
  );

  const income = detectIncome(inWindow, asOf, knownInputs, cfg);
  const categories = learnCategories(inWindow, asOf, knownInputs, cfg);

  const learnedInputs: RecurringInput[] = [];

  for (const inc of income) {
    if (inc.suppressed) continue;
    learnedInputs.push({
      id: `learned-income:${inc.merchantKey}`,
      sourceType: 'learned_income',
      name: inc.name,
      amount: round2(inc.amount), // inflow (+)
      frequency: inc.frequency,
      anchorDate: inc.nextDate,
      accountId: inc.accountId,
      confidence: inc.confidence,
    });
  }

  for (const c of categories) {
    if (c.monthlyResidual < cfg.minMonthlySpend) continue;
    // Spread the residual monthly rate into a smooth WEEKLY outflow so the
    // balance line steps gently rather than lurching once a month, and so the
    // 30/60/90 totals accrue proportionally to the horizon length.
    const weekly = round2(c.monthlyResidual * (7 / DAYS_PER_MONTH));
    if (weekly <= 0) continue;
    learnedInputs.push({
      id: `learned-spend:${c.category}`,
      sourceType: 'learned_spend',
      name: `${c.category} (typical)`,
      amount: -weekly, // outflow (−)
      frequency: 'weekly',
      anchorDate: addDays(asOf, 7),
      accountId: c.accountId,
      confidence: 0.5,
      category: c.category,
    });
  }

  return { learnedInputs, income, categories };
}
