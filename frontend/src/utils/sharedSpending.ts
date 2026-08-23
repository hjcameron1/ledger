/**
 * Phase 7.2 — shared spending and responsibilities (pure core).
 *
 * Households (7.1) decided who may SEE a row. This file answers the two
 * questions a couple actually argues about at the end of the month: WHO PAID
 * for a shared transaction, and WHOSE SPENDING it really was — possibly split
 * between several members, by dollar amounts or by percentages.
 *
 * Three facts, and the discipline that keeps them honest:
 *
 *   `user_id`               who OWNS the record (7.1, untouched). Decides every
 *                           balance and every net worth, and nothing here can
 *                           reach it.
 *   `paid_by_user_id`       who actually paid. Null = the owner, so every
 *                           pre-7.2 transaction keeps the answer it had.
 *   `responsible_user_id` / whose spending it is. The single-person column is
 *   `responsibility_split`  7.1's; the split is this phase's many-person
 *                           answer, and when present and valid it REPLACES the
 *                           single column in reporting — exactly as category
 *                           split lines replace a parent's category
 *                           (transactionSplits.ts), and with the same sum
 *                           invariant: the lines account for the whole
 *                           transaction, so the money is distributed, never
 *                           multiplied.
 *
 * ALL of it is reporting metadata on the one transaction that already exists.
 * Balances and net worth are read from account rows, never by adding
 * transactions up, so attributing, splitting or re-splitting can move a
 * transaction between members' spending columns and cannot move a dollar of
 * anyone's money. "Net position" below is therefore a STATEMENT, not a debt
 * ledger: Ledger never records that anybody owes anybody, it only shows what
 * the shared rows already say.
 *
 * Pure functions, no store, no React, no I/O — same law as household.ts, so
 * every rule is unit-testable with literals.
 */

import type { ResponsibilityLine, Shareable } from '../types';
import { type HouseholdContext, activeMembers, activeHouseholdId, householdRows, responsibleFor } from './household';

/** Cent-precision equality so float drift never fails a valid split. */
const EPS = 0.005;
/** Percent splits tolerate the same order of drift (e.g. 33.33 × 3 = 99.99). */
const PERCENT_EPS = 0.05;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The slice of a transaction this engine reads. Kept structural so tests and
 *  callers can hand in literals. */
export interface AttributedRow extends Shareable {
  amount: number;
  display_amount?: number;
  responsible_user_id?: string | null;
  paid_by_user_id?: string | null;
  responsibility_split?: ResponsibilityLine[] | null;
  is_transfer?: boolean;
  transaction_type?: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Who paid
// ═════════════════════════════════════════════════════════════════════════════

/** WHO PAID: the explicit attribution when there is one, otherwise whoever owns
 *  the record — the exact mirror of `responsibleFor`. */
export function paidBy(row: AttributedRow, fallbackUserId?: string | null): string | null {
  return row.paid_by_user_id ?? row.user_id ?? fallbackUserId ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
//  The responsibility split
// ═════════════════════════════════════════════════════════════════════════════

/** Which of the two ways a set of lines divides the money — or null when the
 *  lines can't agree on one, which is itself a validation failure. */
export function splitMode(lines: ResponsibilityLine[]): 'amount' | 'percent' | null {
  if (!lines.length) return null;
  const byAmount = lines.every(l => l.amount !== undefined && l.percent === undefined);
  const byPercent = lines.every(l => l.percent !== undefined && l.amount === undefined);
  return byAmount ? 'amount' : byPercent ? 'percent' : null;
}

export interface ResponsibilitySplitValidation {
  ok: boolean;
  mode: 'amount' | 'percent' | null;
  /** Sum of the provided values (absolute dollars, or percent points). */
  total: number;
  /** What they must sum to: |parent amount|, or 100. */
  target: number;
  /** Signed shortfall/overage: target − total (0 when balanced). */
  remaining: number;
  error?:
    | 'no_lines'
    | 'empty_member'
    | 'duplicate_member'
    | 'mixed_modes'
    | 'nonpositive_value'
    | 'sum_mismatch';
}

/**
 * Validate a proposed responsibility split against the parent amount. The core
 * rule is the category-split rule transplanted: the lines must account for the
 * WHOLE transaction — amounts sum to |parent| (or percents to 100) — so a split
 * transaction contributes exactly what an unsplit one does, distributed instead
 * of duplicated. One line is allowed (it means "all theirs", the degenerate
 * case the single column also expresses); the same member twice is not, because
 * two lines for one person are one wrong-looking line.
 */
export function validateResponsibilitySplit(
  lines: ResponsibilityLine[], parentAmount: number,
): ResponsibilitySplitValidation {
  const mode = splitMode(lines);
  const target = mode === 'percent' ? 100 : round2(Math.abs(Number(parentAmount) || 0));
  const value = (l: ResponsibilityLine) =>
    Math.abs(Number(mode === 'percent' ? l.percent : l.amount) || 0);
  const total = round2(lines.reduce((s, l) => s + value(l), 0));
  const base: Omit<ResponsibilitySplitValidation, 'ok' | 'error'> = {
    mode, total, target, remaining: round2(target - total),
  };
  if (lines.length === 0) return { ...base, ok: false, error: 'no_lines' };
  if (lines.some(l => !(l.user_id ?? '').trim())) return { ...base, ok: false, error: 'empty_member' };
  if (new Set(lines.map(l => l.user_id)).size !== lines.length) {
    return { ...base, ok: false, error: 'duplicate_member' };
  }
  if (mode === null) return { ...base, ok: false, error: 'mixed_modes' };
  if (lines.some(l => !(value(l) > 0))) return { ...base, ok: false, error: 'nonpositive_value' };
  const eps = mode === 'percent' ? PERCENT_EPS : EPS;
  if (Math.abs(target - total) > eps) return { ...base, ok: false, error: 'sum_mismatch' };
  return { ...base, ok: true };
}

/** One member's slice of a transaction's money, as a positive magnitude. */
export interface ResponsibilityShare {
  userId: string;
  amount: number;
}

/**
 * How a transaction's money divides between the people responsible for it.
 *
 * Returns positive magnitudes that sum EXACTLY to `value` (default: the
 * transaction's own |amount|) — the last line takes the rounding remainder, so
 * a 3-way percent split of $100 is 33.33 + 33.33 + 33.34 and never invents or
 * loses a cent. A missing or invalid split falls back to the single answer the
 * 7.1 column gives: everything is `responsibleFor`'s, which is exactly what
 * every transaction meant before splits existed. Reporting stays truthful to
 * what is stored rather than silently rescaling a broken split (the UI blocks
 * saving one).
 */
export function responsibilityShares(
  row: AttributedRow, fallbackUserId?: string | null, value?: number,
): ResponsibilityShare[] {
  const magnitude = round2(Math.abs(value ?? row.amount) || 0);
  const lines = row.responsibility_split ?? [];
  const validation = validateResponsibilitySplit(lines, row.amount);
  if (!validation.ok) {
    const who = responsibleFor(row, fallbackUserId);
    return who ? [{ userId: who, amount: magnitude }] : [];
  }

  const fraction = (l: ResponsibilityLine) =>
    validation.mode === 'percent'
      ? Math.abs(Number(l.percent) || 0) / 100
      : Math.abs(Number(l.amount) || 0) / (validation.target || 1);

  const shares: ResponsibilityShare[] = [];
  let allocated = 0;
  lines.forEach((l, i) => {
    const amount = i === lines.length - 1
      ? round2(magnitude - allocated)
      : round2(magnitude * fraction(l));
    allocated = round2(allocated + amount);
    shares.push({ userId: l.user_id, amount });
  });
  return shares;
}

/** True when this row carries any explicit 7.2 attribution at all — what the
 *  row's little chip renders on. */
export function hasAttribution(row: AttributedRow): boolean {
  return row.paid_by_user_id != null
    || row.responsible_user_id != null
    || (row.responsibility_split?.length ?? 0) > 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  What counts as spending
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A transaction's contribution to a SPENDING summary, signed:
 *   money out            → positive (it was spent)
 *   a matched refund in  → negative (it un-spends the purchase it reverses)
 *   transfers            → zero — moving your own money between accounts is
 *                          nobody's spending, the same rule every report uses
 *   other money in       → zero — income is not negative spending
 *
 * Uses the display amount when present so every member's column is in the one
 * currency the summary is shown in.
 */
export function spendingContribution(row: AttributedRow): number {
  if (row.is_transfer || row.transaction_type === 'transfer') return 0;
  const magnitude = Math.abs(row.display_amount ?? row.amount) || 0;
  if (row.amount < 0) return round2(magnitude);
  if (row.transaction_type === 'refund') return round2(-magnitude);
  return 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  The household summary — paid vs responsible, per member
// ═════════════════════════════════════════════════════════════════════════════

export interface MemberSpendingRow {
  userId: string;
  /** What this person actually paid for, of the household's shared spending. */
  paid: number;
  /** Their share of it — the single attribution or their split slices. */
  responsible: number;
  /** paid − responsible. Positive: they covered more than their share; negative:
   *  others covered some of theirs. A statement about the shared rows, not a
   *  recorded debt — Ledger keeps no IOU ledger. */
  net: number;
  /** False for someone no longer in the household whose attributions remain —
   *  removal takes access, never history, so their column still adds up. */
  isMember: boolean;
}

/**
 * The household's shared spending, split two ways at once: by who PAID and by
 * who was RESPONSIBLE. Every counted transaction contributes the same figure to
 * each side, so the two columns always total the same number and `net` sums to
 * zero across the household — the invariant that proves nothing was double-
 * counted and nothing leaked.
 *
 * Only rows in the household's own view are counted (`householdRows` — the same
 * filter every household figure uses), so a member's private spending is
 * invisible here even when a split names them, and the same row shared to two
 * households counts once in each household's OWN summary and never across.
 *
 * Every active member gets a row, zeros included — a summary that omits the
 * flatmate who spent nothing this month reads as a bug, not thrift. Ex-members
 * whose attributions survive get rows too, flagged `isMember: false`.
 */
export function memberSpending(
  rows: AttributedRow[], ctx: HouseholdContext, householdId?: string | null,
): MemberSpendingRow[] {
  const id = householdId ?? activeHouseholdId(ctx);
  const paid = new Map<string, number>();
  const responsible = new Map<string, number>();
  const add = (map: Map<string, number>, who: string, amount: number) =>
    map.set(who, round2((map.get(who) ?? 0) + amount));

  for (const row of householdRows(rows, ctx, id)) {
    const contribution = spendingContribution(row);
    if (contribution === 0) continue;
    const payer = paidBy(row, ctx.userId) ?? 'unknown';
    add(paid, payer, contribution);
    // A refund un-spends along the same split as the money went out — the sign
    // rides the contribution, the split only decides the proportions.
    const sign = contribution < 0 ? -1 : 1;
    for (const share of responsibilityShares(row, ctx.userId, Math.abs(contribution))) {
      add(responsible, share.userId, sign * share.amount);
    }
  }

  const memberIds = id ? activeMembers(ctx.members, id).map(m => m.user_id) : [];
  const extras = [...new Set([...paid.keys(), ...responsible.keys()])]
    .filter(u => !memberIds.includes(u));

  return [...memberIds, ...extras].map(userId => {
    const p = round2(paid.get(userId) ?? 0);
    const r = round2(responsible.get(userId) ?? 0);
    return { userId, paid: p, responsible: r, net: round2(p - r), isMember: memberIds.includes(userId) };
  });
}
