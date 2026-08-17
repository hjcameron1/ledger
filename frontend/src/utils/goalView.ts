/**
 * Phase 4.3 — the savings-goal VIEW MODEL.
 *
 * How a goal is DRAWN: its tone, its bar, the one line of text under it, and
 * the order goals appear in. Separated from the React component for the same
 * reason `budgetView.ts` is separated from `BudgetSection.tsx` — the component
 * is then left with no arithmetic and no branching worth testing, and every
 * rule below is exercised directly by `goalView.test.ts`.
 *
 * NOTHING here re-derives money. Every figure arrives already computed by
 * `buildGoalReport` — the single source of truth for saved / remaining /
 * required / allocated / status. This module only decides how to say it.
 */

import type { GoalLine, GoalReport, GoalStatus } from './savingsGoals';

/** The visual register of a goal row. */
export type GoalTone =
  /** Done, or funded well enough to land on time. */
  | 'good'
  /** Some money is heading here, but not enough. */
  | 'warn'
  /** Past its date, or nothing at all is reaching it. */
  | 'bad'
  /** Nothing to judge: no deadline, or no forecast. */
  | 'neutral';

const TONE_BY_STATUS: Record<GoalStatus, GoalTone> = {
  complete: 'good',
  'on-track': 'good',
  'at-risk': 'warn',
  behind: 'bad',
  overdue: 'bad',
  'no-deadline': 'neutral',
  unknown: 'neutral',
};

export function toneFor(status: GoalStatus): GoalTone {
  return TONE_BY_STATUS[status] ?? 'neutral';
}

/** Short label for the status pill. */
const LABEL_BY_STATUS: Record<GoalStatus, string> = {
  complete: 'Reached',
  'on-track': 'On track',
  'at-risk': 'At risk',
  behind: 'Behind',
  overdue: 'Overdue',
  'no-deadline': 'No deadline',
  unknown: 'No forecast',
};

export function labelFor(status: GoalStatus): string {
  return LABEL_BY_STATUS[status] ?? '';
}

// ─── Bar ─────────────────────────────────────────────────────────────────────

export interface GoalBar {
  /** Filled portion, 0–100 — the engine's clamped progress. */
  fillPct: number;
  /**
   * Where the goal is projected to be by its target date, on the same scale, or
   * null when it says nothing new: no projection, already past today's fill, or
   * off the end of the bar.
   */
  markerPct: number | null;
  tone: GoalTone;
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/**
 * Bar geometry for one goal.
 *
 * The marker shows where the allocated contributions land the goal ON ITS
 * TARGET DATE — the honest visual for "you'll get most of the way there",
 * which a fill-only bar cannot express.
 */
export function barFor(line: GoalLine): GoalBar {
  const tone = toneFor(line.status);
  const target = line.targetAmount;
  const fillPct = clampPct(line.progressPct);

  if (!(target > 0) || line.daysRemaining === null || line.daysRemaining <= 0) {
    return { fillPct, markerPct: null, tone };
  }

  const months = line.daysRemaining / 30.4375;
  const projected = line.saved + line.allocatedPerMonth * months;
  const projectedPct = (projected / target) * 100;

  const markerPct = projectedPct > line.progressPct + 0.5 && projectedPct < 100
    ? clampPct(projectedPct)
    : null;

  return { fillPct, markerPct, tone };
}

// ─── The one line of text ────────────────────────────────────────────────────

/**
 * WHAT TO SAY under a goal, as DATA rather than a string: this module owns
 * which of the seven things is worth saying, the component owns currency and
 * date formatting (and therefore the user's locale).
 */
export type GoalMessage =
  /** Target reached. */
  | { kind: 'complete'; over: number }
  /** Date has passed, still short by `short`, `daysPast` days ago. */
  | { kind: 'overdue'; short: number; daysPast: number }
  /** No date set — just what is left to find. */
  | { kind: 'open'; remaining: number }
  /** Funded: `perMonth` a month gets there by the target date. */
  | { kind: 'on-track'; perMonth: number }
  /** Underfunded: needs `required` a month, only `allocated` is spare. */
  | { kind: 'short'; required: number; allocated: number; shortfall: number }
  /** Needs `required` a month and nothing spare is expected. */
  | { kind: 'unfunded'; required: number }
  /** Needs `required` a month; no forecast exists to say whether that's there. */
  | { kind: 'unknown'; required: number };

export function messageFor(line: GoalLine): GoalMessage {
  if (line.status === 'complete') {
    return { kind: 'complete', over: Math.max(0, line.saved - line.targetAmount) };
  }
  if (line.status === 'overdue') {
    return { kind: 'overdue', short: line.remaining, daysPast: Math.abs(line.daysRemaining ?? 0) };
  }
  if (!line.targetDate) return { kind: 'open', remaining: line.remaining };

  const required = line.requiredPerMonth ?? 0;
  if (line.status === 'unknown') return { kind: 'unknown', required };
  if (line.status === 'on-track') return { kind: 'on-track', perMonth: required };
  if (line.allocatedPerMonth > 0) {
    return {
      kind: 'short',
      required,
      allocated: line.allocatedPerMonth,
      shortfall: line.shortfallPerMonth,
    };
  }
  return { kind: 'unfunded', required };
}

// ─── Order ───────────────────────────────────────────────────────────────────

/**
 * Goals needing a decision first, finished goals last.
 *
 * Within the live goals it is the deadline that orders them — the same order
 * the engine funds them in, so the list reads top-to-bottom as "this is who
 * gets the money first". Sorting by progress instead would put the goal that
 * is about to fail at the bottom of the card.
 */
const RANK: Record<GoalStatus, number> = {
  overdue: 0,
  behind: 1,
  'at-risk': 2,
  unknown: 3,
  'on-track': 4,
  'no-deadline': 5,
  complete: 6,
};

export function sortLines(lines: GoalLine[]): GoalLine[] {
  return [...lines].sort((a, b) => {
    const byRank = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
    if (byRank !== 0) return byRank;
    const ad = a.targetDate ?? '9999-12-31';
    const bd = b.targetDate ?? '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── The whole card ──────────────────────────────────────────────────────────

export interface GoalLineView extends GoalLine {
  tone: GoalTone;
  statusLabel: string;
  bar: GoalBar;
  message: GoalMessage;
}

export interface GoalView {
  asOf: string;
  lines: GoalLineView[];
  isEmpty: boolean;
  /** True when at least one live goal is not fully funded — the card's headline
   *  warning, and the reason the capacity summary is worth showing at all. */
  hasShortfall: boolean;
  summary: {
    totalTarget: number;
    totalSaved: number;
    /** 0–100 across every goal together. */
    progressPct: number;
    completeCount: number;
    totalRequiredPerMonth: number;
    monthlyCapacity: number | null;
    shortfallPerMonth: number;
    unallocatedPerMonth: number;
  };
}

export function toGoalView(report: GoalReport): GoalView {
  const lines = sortLines(report.lines).map(line => ({
    ...line,
    tone: toneFor(line.status),
    statusLabel: labelFor(line.status),
    bar: barFor(line),
    message: messageFor(line),
  }));

  return {
    asOf: report.asOf,
    lines,
    isEmpty: lines.length === 0,
    hasShortfall: report.shortfallPerMonth > 0 || lines.some(l => l.status === 'overdue'),
    summary: {
      totalTarget: report.totalTarget,
      totalSaved: report.totalSaved,
      progressPct: report.totalTarget > 0
        ? clampPct((report.totalSaved / report.totalTarget) * 100)
        : 0,
      completeCount: report.completeCount,
      totalRequiredPerMonth: report.totalRequiredPerMonth,
      monthlyCapacity: report.monthlyCapacity,
      shortfallPerMonth: report.shortfallPerMonth,
      unallocatedPerMonth: report.unallocatedPerMonth,
    },
  };
}
