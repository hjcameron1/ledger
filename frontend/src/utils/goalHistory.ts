/**
 * Phase 4.3 — savings-goal HISTORY (pure engine).
 *
 * The ledger of a single goal, turned into something a history panel can draw:
 * each movement in order, a running balance, and a series for a progress chart.
 *
 * It obeys the SAME counting rule as `savingsGoals.ts` so the two can never
 * disagree. A movement whose source is one of the goal's CURRENT links is
 * already visible in that account's balance (`isReflected`), so it is shown for
 * the record but never moves the running balance — exactly as it is never added
 * to `saved`. Everything else (cash, a non-linked account) counts, in or out.
 *
 * The running balance therefore tracks `manualSaved` — the hand-recorded part of
 * a goal — not the linked part, which has no dated history to plot. For an
 * unlinked goal that IS the whole saved figure; for a linked goal the panel
 * shows the live linked balance separately.
 *
 * Pure and dependency-injected (no store, no clock): the caller passes the
 * normalised ledger, the goal's links and its opening amount, mirroring the rest
 * of the goal engine so it is node-testable.
 */

import { round2 } from './cashFlowForecast';
import { isReflected, type GoalLink, type GoalSourceType } from './savingsGoals';

/** One normalised ledger row fed in. `createdAt` breaks ties between two
 *  movements dated the same day so ordering is stable. */
export interface HistoryContribution {
  id: string;
  /** SIGNED: + paid in, − withdrawn. */
  amount: number;
  /** `YYYY-MM-DD`. */
  date: string;
  source: { type: GoalSourceType; id: string } | null;
  note: string | null;
  /** ISO timestamp, for tie-breaking same-day rows. */
  createdAt: string | null;
}

export interface GoalHistoryRow {
  id: string;
  date: string;
  /** SIGNED movement. */
  amount: number;
  /** Already inside a linked balance, so recorded but not counted here. */
  reflected: boolean;
  source: { type: GoalSourceType; id: string } | null;
  note: string | null;
  /** The hand-tracked balance AFTER this row. Null for a reflected row, which
   *  deliberately does not move it. */
  runningBalance: number | null;
}

export interface GoalHistoryPoint {
  date: string;
  balance: number;
}

export interface GoalHistory {
  /** Newest first — the order the table reads. */
  rows: GoalHistoryRow[];
  /** Oldest first: the opening point, then one point per COUNTED movement.
   *  The shape a progress-over-time line is drawn from. */
  series: GoalHistoryPoint[];
  /** Sum of every deposit (positive amount), counted or not. */
  deposited: number;
  /** Sum of every withdrawal (as a positive number), counted or not. */
  withdrawn: number;
  /** The final hand-tracked balance (opening + every counted movement). Equal to
   *  the engine's `manualSaved`. */
  counted: number;
  /** True when at least one row is reflected — the panel then explains why a
   *  logged movement did not change the running balance. */
  hasReflected: boolean;
}

/** Oldest first, `created_at` breaking same-day ties. */
function chronological(a: HistoryContribution, b: HistoryContribution): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

/**
 * Build the history view for one goal.
 *
 * @param contributions the goal's ledger (any order)
 * @param links         the goal's CURRENT links — reflection is judged against
 *                      these, never a write-time flag
 * @param openingAmount the manually typed starting balance
 * @param isLinked      whether the goal draws from linked assets; a linked goal's
 *                      opening amount is ignored, matching the engine
 */
export function buildGoalHistory(params: {
  contributions: HistoryContribution[];
  links: GoalLink[];
  openingAmount: number;
  isLinked: boolean;
}): GoalHistory {
  const { contributions, links, openingAmount, isLinked } = params;

  const opening = isLinked ? 0 : round2(openingAmount || 0);
  const ordered = [...contributions].sort(chronological);

  const asc: GoalHistoryRow[] = [];
  const series: GoalHistoryPoint[] = [];
  let running = opening;
  let deposited = 0;
  let withdrawn = 0;
  let hasReflected = false;

  // A starting point so a chart shows where the goal began, even with one
  // movement. Its date is the first movement's (or empty when there are none).
  if (ordered.length > 0) series.push({ date: ordered[0].date, balance: opening });

  for (const c of ordered) {
    if (c.amount >= 0) deposited += c.amount; else withdrawn += -c.amount;
    const reflected = isReflected({ id: c.id, goalId: '', amount: c.amount, date: c.date, source: c.source }, links);
    if (reflected) {
      hasReflected = true;
      asc.push({ id: c.id, date: c.date, amount: c.amount, reflected: true, source: c.source, note: c.note, runningBalance: null });
      continue;
    }
    running = round2(running + c.amount);
    asc.push({ id: c.id, date: c.date, amount: c.amount, reflected: false, source: c.source, note: c.note, runningBalance: running });
    series.push({ date: c.date, balance: running });
  }

  return {
    rows: asc.reverse(),
    series,
    deposited: round2(deposited),
    withdrawn: round2(withdrawn),
    counted: round2(running),
    hasReflected,
  };
}
