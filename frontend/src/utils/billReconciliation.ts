/**
 * Bill ↔ Subscription reconciliation (pure).
 *
 * A recurring charge can end up represented TWICE: once as an auto-detected
 * `Subscription` (from the bank feed) and once as a manually-added `Bill` in
 * Bills & Reminders. When they describe the SAME payment the user sees a
 * duplicate — in the list AND double-counted in the cash-flow forecast.
 *
 * This module decides, from EVIDENCE, whether an unlinked bill and subscription
 * are the same commitment. It deliberately NEVER links on amount or date alone:
 * a merchant/name signal is required, corroborated by amount tolerance and/or a
 * matching cadence, with the account as a tie-breaker. Two same-amount bills that
 * merely fall in the same week are never called the same.
 *
 * Nothing here mutates state or auto-links — it produces a verdict the UI surfaces
 * for the user to confirm ("Same bill" / "Different bills"). The DS layer applies
 * the confirmed decision (set subscription_id + unify the name) and persists a
 * "Different bills" decision so the pair is not suggested again.
 */

import { normaliseMerchant, editDistance } from './recurringDetection';

// ── Frequency normalisation ───────────────────────────────────────────────────
// Subscriptions and bills both store frequency as a free-ish string. Fold the
// known synonyms to a canonical period so "fortnightly" and "biweekly" compare
// equal and "monthly" ≠ "weekly".

const FREQ_ALIASES: Record<string, string> = {
  weekly: 'weekly', week: 'weekly',
  fortnightly: 'fortnightly', biweekly: 'fortnightly', 'bi-weekly': 'fortnightly', '2weekly': 'fortnightly',
  monthly: 'monthly', month: 'monthly',
  quarterly: 'quarterly', quarter: 'quarterly',
  'semi-annually': 'semiannually', semiannually: 'semiannually', biannually: 'semiannually',
  annually: 'annually', annual: 'annually', yearly: 'annually', year: 'annually',
};

export function normaliseFrequency(freq?: string | null): string | null {
  if (!freq) return null;
  const key = freq.trim().toLowerCase();
  return FREQ_ALIASES[key] ?? key;
}

// ── The two records we reconcile (structural subsets — keeps the module pure and
//    trivially testable without the full Bill/Subscription types). ─────────────

export interface ReconBill {
  id: string;
  name: string;
  original_name?: string | null;
  amount: number;
  frequency?: string | null;
  is_recurring?: boolean;
  account_id?: string | null;
  subscription_id?: string | null;
  kind?: 'bill' | 'reminder';
  is_paid?: boolean;
}

export interface ReconSubscription {
  id: string;
  name: string;
  original_name?: string | null;
  amount: number;
  display_amount?: number;
  frequency?: string | null;
  account_id?: string | null;
}

export type MatchVerdict = 'same' | 'possible' | 'none';

export interface MatchEvidence {
  /** Name/merchant similarity, 0..1. The necessary signal — 0 means no name match. */
  name: number;
  /** Amount closeness, 0..1 (1 = within tight tolerance, decays with relative gap). */
  amount: number;
  /** Cadence agreement: 1 same period, 0 different, 0.5 unknown on one side. */
  cadence: number;
  /** Account agreement: 1 same, 0 known-different, 0.5 unknown on one side. */
  account: number;
}

export interface MatchResult {
  verdict: MatchVerdict;
  /** Overall confidence 0..1 (only meaningful when verdict ≠ 'none'). */
  score: number;
  evidence: MatchEvidence;
  /** Human-readable evidence bullets, strongest first — drives the banner copy. */
  reasons: string[];
}

// ── Signals ───────────────────────────────────────────────────────────────────

/** Best comparable name for a record — the user-edited name if present, else the
 *  original. Both are compared; we take the strongest match so a rename on either
 *  side still lines up with the other's original import text. */
function names(r: { name: string; original_name?: string | null }): string[] {
  const out = [r.name];
  if (r.original_name && r.original_name.trim()) out.push(r.original_name);
  return out;
}

function tokenSet(s: string): Set<string> {
  return new Set(normaliseMerchant(s).split(' ').filter(Boolean));
}

/** Name similarity 0..1 across the record's name variants. Exact normalised match
 *  = 1; strong token overlap or a close edit distance scales down from there. */
export function nameSignal(a: ReconBill, b: ReconSubscription): number {
  let best = 0;
  for (const an of names(a)) {
    for (const bn of names(b)) {
      const na = normaliseMerchant(an);
      const nb = normaliseMerchant(bn);
      if (!na || !nb) continue;
      if (na === nb) return 1;

      // Token (Jaccard-ish) overlap — robust to suffixes like "Netflix" vs
      // "Netflix Premium" and to word re-ordering.
      const ta = tokenSet(an), tb = tokenSet(bn);
      const inter = [...ta].filter(t => tb.has(t)).length;
      const union = new Set([...ta, ...tb]).size;
      const jaccard = union ? inter / union : 0;

      // Whole-string edit distance, normalised by the longer string.
      const dist = editDistance(na, nb);
      const edit = 1 - dist / Math.max(na.length, nb.length, 1);

      // One name being a clean prefix of the other (e.g. "Optus" vs "Optus Mobile").
      const prefix = na.startsWith(nb) || nb.startsWith(na);

      let sim = Math.max(jaccard, edit * 0.9);
      if (prefix) sim = Math.max(sim, 0.8);
      // A single shared token out of many (e.g. "the") is weak — require the
      // overlap to be meaningful before it counts as a name match.
      if (inter === 0 && !prefix && edit < 0.6) sim = 0;
      best = Math.max(best, sim);
    }
  }
  return best;
}

/** Amount closeness 0..1. Within ~2% (or $1) → 1, decaying to 0 by a 25% gap. */
export function amountSignal(billAmount: number, subAmount: number): number {
  const a = Math.abs(billAmount);
  const b = Math.abs(subAmount);
  const denom = Math.max(a, b, 1);
  const rel = Math.abs(a - b) / denom;
  const abs = Math.abs(a - b);
  if (abs <= 1 || rel <= 0.02) return 1;
  if (rel >= 0.25) return 0;
  return 1 - (rel - 0.02) / (0.25 - 0.02);
}

/** Cadence agreement. Unknown on either side is neutral (0.5), not disqualifying —
 *  a manually-added bill may not carry a frequency. */
export function cadenceSignal(billFreq?: string | null, subFreq?: string | null): number {
  const a = normaliseFrequency(billFreq);
  const b = normaliseFrequency(subFreq);
  if (!a || !b) return 0.5;
  return a === b ? 1 : 0;
}

// ── Verdict ───────────────────────────────────────────────────────────────────

const WEIGHTS = { name: 0.45, amount: 0.3, cadence: 0.15, account: 0.1 };

/**
 * Score an unlinked (bill, subscription) pair. `sameAccount` is supplied by the
 * caller (true / false / null-unknown) because account-id equivalence needs the
 * store; the pure scorer stays free of it.
 *
 * Rules that keep this SAFE:
 *  - a name signal is REQUIRED (≥ 0.5) — never link on amount/date alone;
 *  - some corroboration is REQUIRED — amount close OR cadence matching;
 *  - a known-different account caps the verdict at 'possible' and docks the score.
 */
export function scoreBillSubscriptionMatch(
  bill: ReconBill,
  sub: ReconSubscription,
  opts: { sameAccount?: boolean | null } = {},
): MatchResult {
  const subAmount = sub.display_amount ?? sub.amount;
  const evidence: MatchEvidence = {
    name: nameSignal(bill, sub),
    amount: amountSignal(bill.amount, subAmount),
    cadence: cadenceSignal(bill.frequency, sub.frequency),
    account: opts.sameAccount == null ? 0.5 : opts.sameAccount ? 1 : 0,
  };

  const none: MatchResult = { verdict: 'none', score: 0, evidence, reasons: [] };

  // Necessary: a real merchant/name signal.
  if (evidence.name < 0.5) return none;
  // Necessary: corroboration beyond the name — amount close OR same cadence.
  const corroborated = evidence.amount >= 0.5 || evidence.cadence >= 1;
  if (!corroborated) return none;

  let score =
    WEIGHTS.name * evidence.name +
    WEIGHTS.amount * evidence.amount +
    WEIGHTS.cadence * evidence.cadence +
    WEIGHTS.account * evidence.account;

  const accountConflict = opts.sameAccount === false;
  if (accountConflict) score -= 0.15;
  score = Math.max(0, Math.min(1, score));

  const reasons: string[] = [];
  if (evidence.name >= 0.95) reasons.push('Same name');
  else if (evidence.name >= 0.5) reasons.push('Similar name');
  if (evidence.amount >= 0.95) reasons.push('Same amount');
  else if (evidence.amount >= 0.5) reasons.push('Close amount');
  if (evidence.cadence >= 1) reasons.push('Same frequency');
  if (opts.sameAccount === true) reasons.push('Same account');
  if (accountConflict) reasons.push('Different accounts');

  // 'same' — high confidence AND every strong signal aligned AND no account
  // conflict. Otherwise 'possible' (ambiguous → user decides).
  const strong =
    !accountConflict &&
    score >= 0.85 &&
    evidence.name >= 0.85 &&
    evidence.amount >= 0.85 &&
    evidence.cadence >= 1;

  if (strong) return { verdict: 'same', score, evidence, reasons };
  if (score >= 0.6) return { verdict: 'possible', score, evidence, reasons };
  return none;
}

// ── Candidate finding ─────────────────────────────────────────────────────────

export interface ReconCandidate {
  bill: ReconBill;
  subscription: ReconSubscription;
  result: MatchResult;
}

/**
 * All unlinked (bill, subscription) pairs that score as the same commitment,
 * best match per bill, strongest first. Excludes:
 *  - reminders, paid bills, and bills already linked to a subscription;
 *  - pairs the user has marked "Different bills" (`isDifferent` returns true).
 *
 * `sameAccount(bill, sub)` is injected so the store-dependent account-equivalence
 * check lives in the DS layer while this stays pure.
 */
export function findReconciliationCandidates(
  bills: ReconBill[],
  subs: ReconSubscription[],
  opts: {
    isDifferent?: (bill: ReconBill, sub: ReconSubscription) => boolean;
    sameAccount?: (bill: ReconBill, sub: ReconSubscription) => boolean | null;
  } = {},
): ReconCandidate[] {
  const isDifferent = opts.isDifferent ?? (() => false);
  const sameAccount = opts.sameAccount ?? (() => null);
  const out: ReconCandidate[] = [];

  for (const bill of bills) {
    if (bill.is_paid) continue;
    if (bill.kind === 'reminder') continue;
    if (bill.subscription_id) continue; // already linked

    let best: ReconCandidate | null = null;
    for (const sub of subs) {
      if (isDifferent(bill, sub)) continue;
      const result = scoreBillSubscriptionMatch(bill, sub, { sameAccount: sameAccount(bill, sub) });
      if (result.verdict === 'none') continue;
      if (!best || result.score > best.result.score) best = { bill, subscription: sub, result };
    }
    if (best) out.push(best);
  }

  return out.sort((a, b) => b.result.score - a.result.score);
}

// ── Persisted "Different bills" identity ──────────────────────────────────────

/** A stable signature for a bill↔subscription pair that survives id churn (a
 *  recurring occurrence gets a fresh id each cycle) and renames (keyed on the
 *  import anchor). Used as the localStorage key for a "Different bills" decision. */
export function differentDecisionKey(bill: ReconBill, sub: ReconSubscription): string {
  const billAnchor = normaliseMerchant(bill.original_name || bill.name) || bill.name.toLowerCase().trim();
  const subAnchor = normaliseMerchant(sub.original_name || sub.name) || sub.name.toLowerCase().trim();
  return `${billAnchor}::${subAnchor}`;
}

/**
 * The canonical name a linked pair should share. Prefers a name the USER edited
 * (has an original_name snapshot ⇒ was renamed) over raw auto-detected text, so
 * linking never clobbers the user's chosen label. Subscription wins ties (it is
 * the merchant-facing record).
 */
export function preferredCanonicalName(bill: ReconBill, sub: ReconSubscription): string {
  const subRenamed = !!(sub.original_name && sub.original_name.trim());
  const billRenamed = !!(bill.original_name && bill.original_name.trim());
  if (subRenamed) return sub.name;
  if (billRenamed) return bill.name;
  return sub.name;
}
