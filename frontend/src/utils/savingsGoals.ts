/**
 * Phase 4.3 — savings goals (pure engine).
 *
 * ONE engine that answers, for every goal: how much is saved, how much is left,
 * what has to go in each week/month to land on the target date, and whether the
 * money to do that actually exists. It is pure and dependency-injected (`asOf`
 * passed in, no store, no network), mirroring cashFlowForecast.ts / budgeting.ts
 * so the whole thing is node-testable and the UI holds no arithmetic.
 *
 * ── The one hard problem: not counting the same dollar twice ─────────────────
 * A goal can be funded two ways, and they overlap.
 *
 *  • LINKED — the money sits in a real account/investment/super fund, and the
 *    goal claims a slice of it (a % or a fixed $). The saved figure is DERIVED
 *    from the live balance, so it already moves on its own.
 *  • MANUAL — the user tells us what they have put aside. Nothing else knows
 *    about it.
 *
 * Move $500 into a linked savings account and record it as a contribution, and
 * a naive sum counts it twice: once in the balance the link reads, once in the
 * ledger. So a contribution is counted only when it is NOT already represented
 * by one of the goal's links — see `isReflected`. The test is evaluated against
 * the goal's CURRENT links, never frozen at write time, so linking an account
 * later retroactively stops double-counting the deposits already made into it,
 * and unlinking it starts counting them.
 *
 * For the same reason a linked goal's typed opening amount is ignored: it is a
 * snapshot of the balance the links already read.
 *
 * Withdrawals are contributions with a negative amount and obey the identical
 * rule — a withdrawal from a linked account is visible in the balance, so
 * subtracting it again would double-count the loss.
 *
 * ── What "on track" means here ───────────────────────────────────────────────
 * Not "have you saved fast enough so far" (which punishes a goal created
 * yesterday) but "does the money to finish this exist". The cash-flow forecast
 * says how much spare cash a month is expected to produce; that capacity is
 * shared out across the goals, earliest deadline first, and a goal is on track
 * when its share covers what its deadline requires. Goals therefore COMPETE:
 * adding a second urgent goal can knock the first off track, which is the true
 * position and the thing a per-goal calculation would hide.
 */

import { addDays, round2 } from './cashFlowForecast';
import type { Goal, GoalContribution } from '../types';

/** Anything a goal can draw a balance from. */
export type GoalSourceType = 'account' | 'investment' | 'super';

/** A goal's claim on one asset: a % of its balance, or a fixed $ slice of it. */
export interface GoalLink {
  type: GoalSourceType;
  id: string;
  link_type: 'percent' | 'amount';
  link_value: number;
}

/** A goal, normalised. The DS maps the stored row onto this. */
export interface GoalInput {
  id: string;
  name: string;
  targetAmount: number;
  /** `YYYY-MM-DD`, or null for an open-ended goal. */
  targetDate: string | null;
  /** The manually typed starting balance. IGNORED when `links` is non-empty —
   *  for a linked goal it is only ever a stale mirror of the linked balances. */
  openingAmount: number;
  links: GoalLink[];
}

/** One recorded movement of money toward (or out of) a goal. */
export interface ContributionInput {
  id: string;
  goalId: string;
  /** SIGNED: + paid in, − taken out. */
  amount: number;
  date: string;
  /** Where the money actually moved. Null = cash the app cannot see, which is
   *  the only kind that can never be double-counted. */
  source: { type: GoalSourceType; id: string } | null;
}

/** The live value of one linkable asset, in display currency. */
export interface SourceValue {
  type: GoalSourceType;
  id: string;
  value: number;
}

/** Spare cash the forecast expects to produce, and over how many days. */
export interface GoalCapacity {
  /** Net cash change across `days` (may be ≤ 0 — that is a real answer). */
  surplus: number;
  days: number;
}

export interface GoalReportParams {
  /** Today, `YYYY-MM-DD`. Injected for determinism. */
  asOf: string;
  goals: GoalInput[];
  contributions: ContributionInput[];
  balances: SourceValue[];
  /** Omit when there is no forecast to lean on — affordability is then unknown
   *  rather than assumed, and every goal reports `capacityKnown: false`. */
  capacity?: GoalCapacity | null;
}

export type GoalStatus =
  /** Saved ≥ target. Nothing further required. */
  | 'complete'
  /** The target date has passed and the goal is still short. */
  | 'overdue'
  /** No target date, so there is no pace to be on or off. */
  | 'no-deadline'
  /** The projected spare cash covers what the deadline requires. */
  | 'on-track'
  /** Some spare cash is available, but not enough. */
  | 'at-risk'
  /** Nothing spare is expected to reach this goal. */
  | 'behind'
  /** There is no forecast to judge affordability against, so we don't claim to
   *  know. Reported instead of guessing "on track" or "behind". */
  | 'unknown';

/** A link whose asset no longer exists (deleted account, sold holding). */
export interface BrokenLink {
  type: GoalSourceType;
  id: string;
}

export interface GoalLine {
  id: string;
  name: string;
  targetAmount: number;
  targetDate: string | null;

  /** Total saved: the linked slice plus every contribution that isn't already
   *  inside it. Can be negative if withdrawals exceed deposits — reported
   *  honestly rather than clamped, because a hidden overdraw is a lie. */
  saved: number;
  /** The part derived live from linked balances. */
  linkedSaved: number;
  /** The part tracked by hand (opening amount + contributions that count). */
  manualSaved: number;
  /** Contributions already visible inside `linkedSaved`, so deliberately not
   *  added again. Shown to the user as the reason a deposit "did nothing". */
  reflectedTotal: number;

  remaining: number;
  /** 0–100, clamped. A negative balance reads as 0%, not as a negative bar. */
  progressPct: number;

  /** Whole days from `asOf` to the target date. Negative once it has passed. */
  daysRemaining: number | null;
  /** What must go in per week / per month to finish on time. Null when there is
   *  no deadline to hit, or none left (complete / overdue). */
  requiredPerWeek: number | null;
  requiredPerMonth: number | null;

  /** This goal's share of the forecast's monthly spare cash. */
  allocatedPerMonth: number;
  /** How far that share falls short of `requiredPerMonth` (0 when it doesn't). */
  shortfallPerMonth: number;
  /** When the goal completes at `allocatedPerMonth`. Null if never, or already
   *  complete, or there is no forecast to project from. */
  projectedDate: string | null;
  /** False when no forecast was supplied — affordability is unknown, and the
   *  status falls back to what the dates alone can prove. */
  capacityKnown: boolean;

  status: GoalStatus;

  /** Ledger totals, for the history panel. */
  depositedTotal: number;
  withdrawnTotal: number;
  contributionCount: number;
  /** Links pointing at an asset that is no longer there. */
  brokenLinks: BrokenLink[];
}

export interface GoalReport {
  asOf: string;
  lines: GoalLine[];
  /** Spare cash per month the forecast expects, or null when unknown. */
  monthlyCapacity: number | null;
  /** Sum of every `requiredPerMonth`. */
  totalRequiredPerMonth: number;
  /** How much of the monthly capacity no goal claimed. */
  unallocatedPerMonth: number;
  /** How far the capacity falls short of the total requirement. */
  shortfallPerMonth: number;
  totalTarget: number;
  totalSaved: number;
  completeCount: number;
}

export const DAYS_PER_WEEK = 7;
/** 365.25 / 12 — the same average-month convention the forecast uses. */
export const DAYS_PER_MONTH = 30.4375;
/** Rounding noise: below half a cent is nothing. */
const EPSILON = 0.005;

// ─── Small helpers ───────────────────────────────────────────────────────────

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Whole days from `from` to `to` (negative when `to` is in the past). Null on
 *  an unparseable date, so a bad value can never masquerade as "due today". */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

const sourceKey = (type: GoalSourceType, id: string): string => `${type}:${id}`;

/**
 * Is this contribution's money already inside the goal's linked balances?
 *
 * Judged against the links the goal has RIGHT NOW, which is what makes
 * re-linking safe: the same ledger row flips from counted to reflected the
 * moment its account becomes a funding source, and back again if it stops.
 */
export function isReflected(c: ContributionInput, links: GoalLink[]): boolean {
  if (!c.source) return false;
  const key = sourceKey(c.source.type, c.source.id);
  return links.some(l => sourceKey(l.type, l.id) === key);
}

/**
 * What one link contributes at the current balance.
 *  • percent → that share of the balance
 *  • amount  → the fixed slice, but never more than the asset actually holds
 * Negative balances (an overdrawn account) contribute nothing rather than
 * eating into the goal — the money isn't there, but neither is a debt to it.
 */
export function linkValue(link: GoalLink, balance: number): number {
  const bal = Math.max(0, balance);
  const part = link.link_type === 'percent'
    ? (bal * link.link_value) / 100
    : Math.min(link.link_value, bal);
  return Math.max(0, round2(part));
}

// ─── Reading the stored shapes ───────────────────────────────────────────────

/**
 * A goal's links, whichever era it was saved in.
 *
 * `linked_sources` superseded the single `linked_account_id` + `link_type` +
 * `link_value` trio, but goals saved before that are still out there and must
 * keep funding themselves. A goal carrying both uses the newer array.
 */
export function goalLinks(goal: Goal): GoalLink[] {
  if (goal.linked_sources && goal.linked_sources.length) {
    return goal.linked_sources.map(s => ({
      type: s.type,
      id: s.id,
      link_type: s.link_type,
      link_value: Number(s.link_value) || 0,
    }));
  }
  if (goal.linked_account_id && goal.link_type && goal.link_value != null) {
    return [{
      type: 'account',
      id: goal.linked_account_id,
      link_type: goal.link_type,
      link_value: Number(goal.link_value) || 0,
    }];
  }
  return [];
}

/** True when the goal draws its balance from real assets. */
export function isLinkedGoal(goal: Goal): boolean {
  return goalLinks(goal).length > 0;
}

export function toGoalInput(goal: Goal): GoalInput {
  return {
    id: goal.id,
    name: goal.name,
    targetAmount: Number(goal.target_amount) || 0,
    targetDate: goal.target_date || null,
    openingAmount: Number(goal.current_amount) || 0,
    links: goalLinks(goal),
  };
}

export function toContributionInput(c: GoalContribution): ContributionInput {
  return {
    id: c.id,
    goalId: c.goal_id,
    amount: Number(c.amount) || 0,
    date: (c.date || '').slice(0, 10),
    source: c.source_type && c.source_id
      ? { type: c.source_type, id: c.source_id }
      : null,
  };
}

// ─── The report ──────────────────────────────────────────────────────────────

interface Working {
  line: GoalLine;
  /** Sort key: earliest deadline first, deadline-less last. */
  order: number;
}

/**
 * Build the full picture for every goal.
 *
 * Two passes, because the second needs the first: work out what each goal is
 * worth and requires on its own, then share the forecast's spare cash between
 * them to decide who is actually on track.
 */
export function buildGoalReport(params: GoalReportParams): GoalReport {
  const { asOf, goals, contributions, balances, capacity } = params;

  const balanceOf = new Map(balances.map(b => [sourceKey(b.type, b.id), b.value]));
  const byGoal = new Map<string, ContributionInput[]>();
  for (const c of contributions) {
    const list = byGoal.get(c.goalId);
    if (list) list.push(c); else byGoal.set(c.goalId, [c]);
  }

  const working: Working[] = goals.map(goal => {
    const links = goal.links ?? [];
    const ledger = byGoal.get(goal.id) ?? [];

    // ── Saved ──
    let linkedSaved = 0;
    const brokenLinks: BrokenLink[] = [];
    for (const l of links) {
      const bal = balanceOf.get(sourceKey(l.type, l.id));
      if (bal === undefined) { brokenLinks.push({ type: l.type, id: l.id }); continue; }
      linkedSaved += linkValue(l, bal);
    }
    linkedSaved = round2(linkedSaved);

    let counted = 0;
    let reflectedTotal = 0;
    let depositedTotal = 0;
    let withdrawnTotal = 0;
    for (const c of ledger) {
      if (c.amount >= 0) depositedTotal += c.amount; else withdrawnTotal += -c.amount;
      if (isReflected(c, links)) reflectedTotal += c.amount; else counted += c.amount;
    }

    // A linked goal's typed opening amount duplicates the balances the links
    // already read, so only an unlinked goal keeps it.
    const opening = links.length > 0 ? 0 : (goal.openingAmount || 0);
    const manualSaved = round2(opening + counted);
    const saved = round2(linkedSaved + manualSaved);

    const target = goal.targetAmount || 0;
    const remaining = round2(Math.max(0, target - saved));
    const progressPct = target > 0 ? clamp((saved / target) * 100, 0, 100) : 0;

    // ── Time ──
    const daysRemaining = goal.targetDate ? daysBetween(asOf, goal.targetDate) : null;
    const complete = target > 0 && remaining <= EPSILON;
    const overdue = !complete && daysRemaining !== null && daysRemaining <= 0;

    // Required only means something while there is still time to spread it
    // over. A goal due today needs the whole remainder now, not "per week".
    const spreadable = !complete && !overdue && daysRemaining !== null && daysRemaining > 0;
    const requiredPerWeek = spreadable
      ? round2(remaining / (daysRemaining! / DAYS_PER_WEEK))
      : null;
    const requiredPerMonth = spreadable
      ? round2(remaining / (daysRemaining! / DAYS_PER_MONTH))
      : null;

    const line: GoalLine = {
      id: goal.id,
      name: goal.name,
      targetAmount: target,
      targetDate: goal.targetDate,
      saved,
      linkedSaved,
      manualSaved,
      reflectedTotal: round2(reflectedTotal),
      remaining,
      progressPct: round2(progressPct),
      daysRemaining,
      requiredPerWeek,
      requiredPerMonth,
      allocatedPerMonth: 0,
      shortfallPerMonth: 0,
      projectedDate: null,
      capacityKnown: !!capacity,
      status: complete ? 'complete' : overdue ? 'overdue' : goal.targetDate ? 'behind' : 'no-deadline',
      depositedTotal: round2(depositedTotal),
      withdrawnTotal: round2(withdrawnTotal),
      contributionCount: ledger.length,
      brokenLinks,
    };

    // Deadline-less goals sort last; among dated goals, soonest first.
    return { line, order: goal.targetDate ? Date.parse(`${goal.targetDate}T00:00:00Z`) : Infinity };
  });

  // ── Share out the forecast's spare cash ────────────────────────────────────
  const monthlyCapacity = capacity && capacity.days > 0
    ? round2(capacity.surplus / (capacity.days / DAYS_PER_MONTH))
    : null;

  allocate(working, monthlyCapacity, asOf);

  const lines = working.map(w => w.line);
  const totalRequiredPerMonth = round2(
    lines.reduce((sum, l) => sum + (l.requiredPerMonth ?? 0), 0),
  );
  const allocatedTotal = round2(lines.reduce((sum, l) => sum + l.allocatedPerMonth, 0));

  // The SAME clamped pool `allocate` shared out. A forecast that expects to lose
  // money frees up nothing — it does not owe the goals money — so a negative
  // capacity is zero spare cash, not a negative one. Measuring the shortfall
  // against the raw figure instead would inflate it by the expected loss and, for
  // goals that require nothing at all, conjure a gap out of nothing.
  const spare = monthlyCapacity === null ? 0 : Math.max(0, monthlyCapacity);

  return {
    asOf,
    lines,
    monthlyCapacity,
    totalRequiredPerMonth,
    unallocatedPerMonth: monthlyCapacity === null ? 0 : round2(Math.max(0, spare - allocatedTotal)),
    shortfallPerMonth: monthlyCapacity === null ? 0 : round2(Math.max(0, totalRequiredPerMonth - spare)),
    totalTarget: round2(lines.reduce((sum, l) => sum + l.targetAmount, 0)),
    totalSaved: round2(lines.reduce((sum, l) => sum + l.saved, 0)),
    completeCount: lines.filter(l => l.status === 'complete').length,
  };
}

/**
 * Give each goal a share of the monthly spare cash and settle its status.
 *
 * Earliest deadline first: the goal that runs out of time soonest has the
 * strongest claim, and funding a distant goal ahead of an imminent one would
 * report both as fine right up until the near one fails. A goal takes only what
 * it needs; whatever is left over flows to the next. Deadline-less goals divide
 * the remainder between them — enough to project a finish date, never enough to
 * starve a dated goal.
 */
function allocate(working: Working[], monthlyCapacity: number | null, asOf: string): void {
  const open = working
    .filter(w => w.line.status !== 'complete')
    .sort((a, b) => a.order - b.order);

  // No forecast, or no spare cash: nothing to allocate. A dated goal is then
  // 'behind' (nothing is expected to reach it) unless the dates already settled
  // it as overdue, and status stays honest about affordability being unknown.
  const pool = monthlyCapacity === null ? 0 : Math.max(0, monthlyCapacity);
  let left = pool;

  const dated = open.filter(w => w.line.targetDate && w.line.status !== 'overdue');
  for (const w of dated) {
    const need = w.line.requiredPerMonth ?? 0;
    const give = Math.min(need, left);
    left = round2(left - give);
    w.line.allocatedPerMonth = round2(give);
    w.line.shortfallPerMonth = round2(Math.max(0, need - give));
    if (monthlyCapacity === null) {
      // No forecast: we know what the goal needs but nothing about whether the
      // money exists. Claiming either answer would be invention.
      w.line.status = 'unknown';
      w.line.shortfallPerMonth = 0;
    } else if (w.line.shortfallPerMonth <= EPSILON) {
      w.line.status = 'on-track';
    } else {
      w.line.status = give > EPSILON ? 'at-risk' : 'behind';
    }
  }

  // Whatever survives the dated goals is split evenly between the open-ended
  // ones, purely so they can show a projected finish date.
  const undated = open.filter(w => !w.line.targetDate);
  if (undated.length > 0 && left > EPSILON) {
    const share = round2(left / undated.length);
    for (const w of undated) w.line.allocatedPerMonth = share;
  }

  // Overdue goals get nothing: their deadline is gone, so a monthly rate is
  // meaningless — what they need is the whole remainder now.
  for (const w of open) {
    if (w.line.status === 'overdue') {
      w.line.allocatedPerMonth = 0;
      w.line.shortfallPerMonth = 0;
    }
    w.line.projectedDate = projectCompletion(w.line, asOf);
  }
}

/** When the goal lands at its allocated rate. Null when the rate is zero (it
 *  never does) or there is nothing to project. */
function projectCompletion(line: GoalLine, asOf: string): string | null {
  if (line.status === 'complete' || line.remaining <= EPSILON) return null;
  // `> EPSILON` (not `<= EPSILON` negated) so a NaN rate — from a corrupt
  // balance upstream — falls through to null instead of asking addDays for a
  // date `Math.ceil(NaN)` days away, which throws.
  if (!(line.allocatedPerMonth > EPSILON)) return null;
  const months = line.remaining / line.allocatedPerMonth;
  if (!Number.isFinite(months)) return null;
  return addDays(asOf, Math.ceil(months * DAYS_PER_MONTH));
}
