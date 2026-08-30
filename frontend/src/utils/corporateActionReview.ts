/**
 * CORPORATE ACTIONS THE FEED WOULD NOT EXPLAIN — the question, and what it costs.
 *
 * Splits arrive from the price feed with no label. Most are unmistakable — a
 * whole number of shares for a whole number of shares, "four for one", "one for
 * ten" — and Ledger applies those on its own. Some are not: a ratio like
 * 1281:1000 is almost certainly a spin-off's price factor, where value left the
 * company and the share count never moved, and a ratio like 77:100 is almost
 * certainly a real consolidation, where it did. Almost. The feed serves both in
 * the same field with the same shape, and nothing in it says which.
 *
 * Ledger used to guess, silently, in the direction of doing nothing — and doing
 * nothing to a real consolidation leaves the holding at the wrong value for
 * ever, because the price moved and the unit count did not follow. Vodafone's
 * 6-for-11 in February 2014 left a holding 83% overstated exactly that way.
 *
 * So the unanswerable ones are asked instead. This module turns what the server
 * recorded into that question: which holding, what the feed said, and — the part
 * that makes it answerable by somebody who is not a registrar — what the unit
 * count would become, and how far out the holding is if the answer is yes and
 * nothing is done.
 *
 * Pure. The store, the network and the parcel book are the caller's business.
 */
import type { Investment, PendingCorporateAction } from '../types';

export type { PendingCorporateAction };

/** A pending action with everything needed to ask about it in plain words. */
export interface CorporateActionQuestion {
  investmentId: string;
  label: string;
  ticker: string | null;
  action: PendingCorporateAction;
  /** The announcement as it would have been made: "6 for 11". */
  terms: string;
  unitsNow: number;
  /** What the count becomes if the holder says the action was real. */
  unitsIfApplied: number;
  /**
   * How far out the holding is TODAY if the action really was a share-count
   * change: the price already moved by the ratio, so a count that did not move
   * with it is out by the ratio's reciprocal. 0.833 for Vodafone's 6-for-11.
   */
  overstatement: number;
}

/** Units after the action, rounded the same eight places the server rounds to. */
export function applyRatio(units: number, ratio: number): number {
  return parseFloat((units * ratio).toFixed(8));
}

/**
 * The ratio as an announcement. The feed's own terms when they are whole and
 * small enough to say — "6 for 11" — and the plain multiple when they are not,
 * because "1281 for 1000" is not a sentence anybody would recognise.
 */
export function actionTerms(action: Pick<PendingCorporateAction, 'numerator' | 'denominator' | 'ratio'>): string {
  const { numerator: n, denominator: d, ratio } = action;
  if (Number.isInteger(n) && Number.isInteger(d) && n > 0 && d > 0 && Math.max(n, d) <= 1000) {
    return `${n} for ${d}`;
  }
  return `${parseFloat(ratio.toFixed(6))}×`;
}

const list = (inv: Investment): PendingCorporateAction[] => {
  const raw = (inv as { pending_corporate_actions?: unknown }).pending_corporate_actions;
  return Array.isArray(raw) ? (raw as PendingCorporateAction[]) : [];
};

/**
 * Every question still waiting on an answer, newest event first.
 *
 * Answered entries are kept on the row rather than deleted — that is how the
 * same event stops being raised again on the next refresh — so they are filtered
 * out here rather than in the store. A holding with no units is not asked about:
 * multiplying nothing by a ratio is still nothing, and the question would be an
 * interruption with no possible consequence.
 */
export function pendingQuestions(investments: Investment[], ownerId?: string | null): CorporateActionQuestion[] {
  const out: CorporateActionQuestion[] = [];
  for (const inv of investments) {
    // A holding somebody else owns is not this user's to answer for.
    if (ownerId && inv.user_id && inv.user_id !== ownerId) continue;
    const units = Number(inv.shares_owned) || 0;
    if (units <= 0) continue;
    for (const action of list(inv)) {
      if (!action || action.resolved) continue;
      const ratio = Number(action.ratio);
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) continue;
      out.push({
        investmentId: inv.id,
        label: inv.name,
        ticker: inv.ticker ?? null,
        action,
        terms: actionTerms({ numerator: action.numerator, denominator: action.denominator, ratio }),
        unitsNow: units,
        unitsIfApplied: applyRatio(units, ratio),
        overstatement: 1 / ratio - 1,
      });
    }
  }
  return out.sort((a, b) => (a.action.date < b.action.date ? 1 : a.action.date > b.action.date ? -1 : 0));
}

/**
 * The holding's list with one entry answered. The entry STAYS — marked, not
 * removed — because its id is what stops the server raising the same event
 * again on the next check.
 */
export function markResolved(
  actions: PendingCorporateAction[],
  id: string,
  resolved: 'applied' | 'ignored',
  atISO: string,
): PendingCorporateAction[] {
  return actions.map(a => (a.id === id ? { ...a, resolved, resolved_at: atISO } : a));
}

/** The answered list for a holding, ready to send back as an update. */
export function resolveOn(
  inv: Investment,
  id: string,
  resolved: 'applied' | 'ignored',
  atISO: string,
): PendingCorporateAction[] {
  return markResolved(list(inv), id, resolved, atISO);
}
