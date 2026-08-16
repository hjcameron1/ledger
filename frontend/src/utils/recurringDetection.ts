/**
 * Pure utility functions for recurring payment detection and duplicate checking.
 * No API calls — operates entirely on the local Zustand store data.
 */

import type { Transaction, Subscription } from '../types';

// ─── Merchant normalisation ──────────────────────────────────────────────────

/**
 * Detect whether a merchant string looks like a transfer / PayID / pay-to entry.
 * These need special handling: "Transfer to xx1368" ≠ "Transfer to xx2319".
 */
export function isTransferMerchant(raw: string): boolean {
  return /\b(transfer|payid|pay\s+id|pay\s+to|payment\s+to|tfr|bpay)\b/i.test(raw);
}

/**
 * Normalise a merchant name for fuzzy grouping.
 *
 * Applies a sequence of bank-agnostic stripping rules then keeps only the
 * first 1–3 meaningful words as the key (lowercased).
 *
 * Examples:
 *   "DIRECT DEBIT 123456 NETFLIX"               → "netflix"
 *   "www.snapchat.com wwwsnapfi_UZcAwR1N"        → "snapchat com"
 *   "SPOTIFY AB Card xx1234 NSW AUS"             → "spotify ab"
 *   "GLOFOXPAYMENT 3423 QLD"                     → "glofoxpayment"
 *   "AMZN*PRIME Value Date: 01/06/2026"          → "amzn prime"
 *
 * NOTE: transfer-like merchants are NOT normalised this way — their raw
 * uppercased name (with numbers) is used as the grouping key so that
 * "Transfer to xx1368" and "Transfer to xx2319" stay in separate buckets.
 */
export function normaliseMerchant(raw: string): string {
  let s = raw;

  // 0. Preserve account references (xx0118, xx2319) BEFORE any stripping so
  //    "Transfer to xx0118" and "Transfer to xx2319" keep distinct keys.
  const accountRefs = (s.match(/\bxx\d+\b/gi) ?? []).map(r => r.toLowerCase());

  // 1. Strip "Value Date: DD/MM/YYYY"
  s = s.replace(/\bvalue\s+date\s*:\s*\d{1,2}\/\d{1,2}\/\d{2,4}/gi, '');

  // 2. Strip "Direct Debit" / "Direct Credit" and any standalone number following it
  s = s.replace(/\bdirect\s+(?:debit|credit)\b\s*\d*/gi, '');

  // 3. Strip card references: "Card xx1234", "Visa xxxx1234"
  s = s.replace(/\bcard\s+x+\d+\b/gi, '');
  s = s.replace(/\b(?:visa|mastercard|amex)\s+x+\d+\b/gi, '');

  // 4. Strip URL-like tokens (http/https URLs, www.* prefixes, bare "www" token)
  s = s.replace(/https?:\/\/\S+/gi, '');
  s = s.replace(/www\.\S+/gi, '');
  s = s.replace(/\bwww\b/gi, '');

  // 5. Strip random ID tokens:
  //    a) Any whitespace-delimited token containing an underscore
  s = s.replace(/\S*_\S*/g, '');
  //    b) 6+ char tokens that mix letters AND digits (e.g. "UZcAwR1N", "abc123xyz")
  //       Exception: xx\d+ tokens are already captured above and re-appended below
  s = s.replace(/\b(?=[a-zA-Z\d]*[a-zA-Z])(?=[a-zA-Z\d]*\d)[a-zA-Z\d]{6,}\b/g, '');
  //    c) 8+ char tokens with interior uppercase (camelCase IDs like "UEdWmmUi")
  //       — title-case words (single leading capital) are left intact
  s = s.replace(/\b[a-zA-Z]{8,}\b/g, tok =>
    /[a-z][A-Z]/.test(tok) ? '' : tok
  );

  // 6. Strip standalone numbers of 4+ digits
  s = s.replace(/\b\d{4,}\b/g, '');

  // 7. Strip trailing location / currency codes
  s = s.replace(/\b(AU|AUS|QLD|NSW|VIC|WA|SA|TAS|ACT|NT|USA|GBR|USD)\b/gi, '');

  // 8. Turn asterisks and remaining non-alphanumeric chars into spaces
  s = s.replace(/\*/g, ' ');
  s = s.replace(/[^a-zA-Z0-9\s]/g, ' ');

  // 9. Collect meaningful words (2+ chars, not purely numeric); keep the first 3
  const words = s.split(/\s+/).filter(w => w.length >= 2 && !/^\d+$/.test(w));
  let result = words.slice(0, 3).join(' ').toLowerCase().trim();

  // 10. Re-append any preserved account references so xx0118 ≠ xx2319
  if (accountRefs.length > 0) {
    result = (result + ' ' + accountRefs.join(' ')).trim();
  }

  return result;
}

// ─── Levenshtein edit distance ────────────────────────────────────────────────

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// ─── Cadence model ───────────────────────────────────────────────────────────
//
// A recurring payment is defined by REGULAR TIMING, not by a constant amount. The
// old classifier keyed off the *average* gap plus a crude max−min "spread", which
// (a) mis-handled a single skipped cycle, (b) had dead zones between bands, and
// (c) said nothing about how confident the fit was. This model instead fits the
// observed gaps to an integer number of a canonical period, so a bill paid on the
// 15th that occasionally lands on the 13th or 17th, or skips a month, still fits.

export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually';

interface FreqMeta {
  /** canonical period length in days */
  days: number;
  /** minimum distinct dated occurrences required to assert this cadence */
  minOcc: number;
  /** max mean fractional residual |gap − k·period|/period tolerated */
  tol: number;
}

/**
 * Canonical periods and how strict we are per frequency. Short periods demand ≥3
 * occurrences — two points (one gap) trivially fit ANY period and are not evidence
 * of periodicity — but tolerate more day-drift (weekend/holiday shifts, 28–31 day
 * months). Long periods allow 2 occurrences (waiting for a 3rd annual charge = 3
 * years) but must fit TIGHTLY, because a "yearly" claim from two points is weak.
 */
const FREQ_META: Record<Frequency, FreqMeta> = {
  weekly:      { days: 7,      minOcc: 3, tol: 0.22 },
  fortnightly: { days: 14,     minOcc: 3, tol: 0.20 },
  monthly:     { days: 30.44,  minOcc: 3, tol: 0.28 },
  quarterly:   { days: 91.31,  minOcc: 2, tol: 0.18 },
  annually:    { days: 365.25, minOcc: 2, tol: 0.12 },
};

// Iterate shortest→longest so a clean fortnightly isn't reported as a loose
// monthly: on an equal fit the shorter (more specific) period is kept.
const FREQ_ORDER: Frequency[] = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'];

export interface CadenceFit {
  frequency: Frequency;
  /** 0..1 — how tightly the gaps fit an integer number of periods (1 = perfect). */
  fitScore: number;
  /** mean |gap − k·period| / period across gaps (0 = perfect). */
  meanResidual: number;
  /** distinct dated occurrences used. */
  occurrences: number;
  /** fraction of gaps that spanned >1 period (skipped cycles). */
  skipRatio: number;
}

/**
 * Fit a set of charge dates to the best canonical cadence. Robust to:
 *   • shifted dates — a gap a few days off still fits (residual within tol),
 *   • skipped cycles — a gap ≈ 2×period maps to k=2 rather than breaking the run,
 *   • one-offs / irregular spend — no period fits ⇒ returns null (NOT surfaced).
 * Returns null when there are too few dates or nothing fits within tolerance.
 */
export function fitCadence(dateStrings: string[]): CadenceFit | null {
  const uniq = [...new Set(dateStrings)].sort();
  if (uniq.length < 2) return null;
  const times = uniq.map(d => new Date(`${d}T00:00:00Z`).getTime());
  const gaps = times.slice(1)
    .map((t, i) => (t - times[i]) / 86400000)
    .filter(g => g > 0);
  if (gaps.length === 0) return null;

  let best: CadenceFit | null = null;
  for (const freq of FREQ_ORDER) {
    const { days, minOcc, tol } = FREQ_META[freq];
    if (uniq.length < minOcc) continue;

    let residSum = 0;
    let skips = 0;
    let viable = true;
    for (const g of gaps) {
      const k = Math.max(1, Math.round(g / days));
      if (k > 3) { viable = false; break; }            // a >3-cycle jump isn't "regular"
      const resid = Math.abs(g - k * days) / days;
      if (resid > tol) { viable = false; break; }      // this gap can't be this cadence
      if (k > 1) skips += 1;
      residSum += resid;
    }
    if (!viable) continue;

    const skipRatio = skips / gaps.length;
    if (skipRatio > 0.5) continue;                     // more skips than hits ⇒ not periodic

    const meanResidual = residSum / gaps.length;
    const fitScore = Math.max(0, 1 - meanResidual / tol);
    // Strictly-greater keeps the earlier (shorter) period on ties.
    if (!best || fitScore > best.fitScore + 1e-9) {
      best = { frequency: freq, fitScore, meanResidual, occurrences: uniq.length, skipRatio };
    }
  }
  return best;
}

/**
 * Best-guess frequency for a set of charge dates — the SAME fit used by
 * auto-detection. Returns null when the dates are too few or too irregular to
 * assert a period. Exposed so the manual "pick transactions" flow pre-fills a
 * sensible frequency from the selected occurrences without re-implementing (and
 * drifting from) the detector.
 */
export function suggestFrequencyFromDates(dates: string[]): Frequency | null {
  return fitCadence(dates)?.frequency ?? null;
}

// ─── Amount statistics ───────────────────────────────────────────────────────

interface AmountStats {
  /** robust central amount (magnitude) — used as the reported expected amount. */
  median: number;
  mean: number;
  /** coefficient of variation (stdev/mean) — 0 = identical, higher = varies. */
  cv: number;
}

function amountStats(values: number[]): AmountStats {
  const abs = values.map(v => Math.abs(v)).sort((a, b) => a - b);
  const n = abs.length;
  const median = n % 2 ? abs[(n - 1) / 2] : (abs[n / 2 - 1] + abs[n / 2]) / 2;
  const mean = abs.reduce((s, v) => s + v, 0) / n;
  const variance = abs.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  return { median, mean, cv };
}

/** Amounts varying by more than this CV are treated as a "variable" recurring
 *  charge (a utility bill) rather than a fixed one (a subscription). */
const AMOUNT_VARY_CV = 0.15;

/**
 * Combine cadence fit, evidence count and amount stability into a 0..1 confidence.
 * Cadence regularity dominates (it is what MAKES something recurring); a stable
 * amount and more occurrences raise it. Two-point patterns and heavy skipping are
 * penalised. Used to gate weak suggestions and rank the review queue.
 */
function scoreConfidence(fit: CadenceFit, amt: AmountStats): number {
  const occScore = Math.min(1, (fit.occurrences - 1) / 5);   // 6+ occurrences ⇒ 1
  const amountScore = Math.max(0, 1 - amt.cv / 0.6);         // CV 0 ⇒ 1, CV ≥ 0.6 ⇒ 0
  let conf = 0.55 * fit.fitScore + 0.25 * occScore + 0.20 * amountScore;
  if (fit.occurrences < 3) conf *= 0.8;                      // asserted from 2 points
  if (fit.skipRatio > 0)  conf *= (1 - 0.25 * fit.skipRatio);
  return Math.max(0, Math.min(1, conf));
}

/** Minimum confidence for a detected pattern to be surfaced as a suggestion. */
const CONF_MIN = 0.5;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecurringPattern {
  /** Grouping key — normalised merchant name (or raw uppercased for transfers) */
  merchant: string;
  /** Raw merchant name from the first matching transaction */
  displayMerchant: string;
  /**
   * SIGNED expected amount: negative for an outflow commitment (bill / sub / loan
   * / external transfer), positive for an inflow (salary / income). The sign lets
   * inferKind classify income correctly and lets occurrenceIdsForSeries link the
   * right legs. Display code uses Math.abs().
   */
  amount: number;
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | 'irregular';
  transactionIds: string[];
  /** All matching transactions, sorted by date — shown as evidence in the modal */
  matchingTransactions: Transaction[];
  /** Primary account_id from the cluster — used to scope dismissal */
  accountId: string;
  /** 0..1 detection confidence (cadence fit × evidence × amount stability). */
  confidence: number;
  /** True when the amount varies materially between occurrences (a variable bill). */
  amountVaries: boolean;
  /** Whether this is money leaving (outflow) or arriving (inflow/income). */
  direction: 'outflow' | 'inflow';
}

// ─── Session-skip suppression (sessionStorage) ───────────────────────────────
//
// The ONLY suppression mechanism. Patterns the user ignores via the X / Ignore
// button are hidden for the current browser session only (sessionStorage), and
// re-surface on page reload. There is NO permanent localStorage memory of
// ignored or deleted patterns anywhere — every detection run treats every
// pattern as brand new, except those still skipped in this session and those
// already tracked as a subscription (filtered inside detectRecurringPatterns).

const SESSION_SKIP_PREFIX = 'ledger-session-skip-';

function sessionSkipKey(pattern: RecurringPattern): string {
  return `${SESSION_SKIP_PREFIX}${pattern.merchant}::${pattern.frequency}`;
}

/** Mark a pattern as session-skipped (X / Ignore button pressed). */
export function sessionSkipPattern(pattern: RecurringPattern): void {
  try { sessionStorage.setItem(sessionSkipKey(pattern), '1'); }
  catch { /* storage unavailable */ }
}

/** Returns true if this pattern was session-skipped in the current tab. */
export function isPatternSessionSkipped(pattern: RecurringPattern): boolean {
  try { return sessionStorage.getItem(sessionSkipKey(pattern)) === '1'; }
  catch { return false; }
}

/** Clear all session-skip suppressions (e.g. when "Find recurring payments" is clicked). */
export function clearSessionSkips(): void {
  try {
    Object.keys(sessionStorage)
      .filter(k => k.startsWith(SESSION_SKIP_PREFIX))
      .forEach(k => sessionStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

// ─── Permanent "not a regular payment" dismissals ────────────────────────────
// Unlike session skips, these persist across reloads in localStorage. Used when
// the user explicitly says a detected pattern is NOT a recurring payment, so it
// should never be surfaced again (the transactions themselves are untouched).
const PERMANENT_DISMISS_PREFIX = 'ledger-not-recurring-';

function permanentDismissKey(pattern: RecurringPattern): string {
  return `${PERMANENT_DISMISS_PREFIX}${pattern.merchant}::${pattern.frequency}`;
}

/** Permanently mark a pattern as "not a regular payment" so it never re-surfaces. */
export function dismissPatternPermanently(pattern: RecurringPattern): void {
  try { localStorage.setItem(permanentDismissKey(pattern), '1'); }
  catch { /* storage unavailable */ }
}

/** Returns true if the user permanently marked this pattern as not recurring. */
export function isPatternPermanentlyDismissed(pattern: RecurringPattern): boolean {
  try { return localStorage.getItem(permanentDismissKey(pattern)) === '1'; }
  catch { return false; }
}

// ─── Next-charge-date calculation ────────────────────────────────────────────

const FREQ_DAYS: Record<string, number> = {
  weekly: 7,
  fortnightly: 14,
  monthly: 30,
  quarterly: 90,
  annually: 365,
  irregular: 30, // fallback for display purposes
};

/**
 * Add `months` calendar months to a UTC date, preserving the day-of-month.
 * If the target month is shorter (e.g. 31 Jan + 1 month), clamp to that
 * month's last day rather than spilling into the following month.
 */
function addMonthsUTC(d: Date, months: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1);                               // avoid mid-step overflow
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfMonth));
}

/**
 * Given the most recent charge date and a frequency string, return the
 * ISO date string of the next expected charge.
 *
 * Monthly / quarterly / annual charges advance by CALENDAR months so the
 * predicted date keeps the same day-of-month as the real charge (a bill on
 * the 15th stays on the 15th) instead of drifting earlier each cycle, which
 * is what a fixed 30/90/365-day step does. Weekly/fortnightly use day steps.
 * Adds one interval, then keeps advancing until the result is in the future.
 */
export function calcNextChargeDate(lastDate: string, frequency: string): string {
  const d = new Date(`${lastDate}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const advance = () => {
    switch (frequency) {
      case 'weekly':      d.setUTCDate(d.getUTCDate() + 7);  break;
      case 'fortnightly': d.setUTCDate(d.getUTCDate() + 14); break;
      case 'monthly':     addMonthsUTC(d, 1);  break;
      case 'quarterly':   addMonthsUTC(d, 3);  break;
      case 'annually':    addMonthsUTC(d, 12); break;
      default:            d.setUTCDate(d.getUTCDate() + (FREQ_DAYS[frequency] ?? 30));
    }
  };

  advance();
  // Advance past today if the first interval is still in the past
  while (d < today) advance();
  return d.toISOString().split('T')[0];
}

// ─── Internal transfer detection ─────────────────────────────────────────────

/**
 * Identify transactions that are just money moving between the user's OWN
 * accounts (e.g. everyday → savings). Such a transfer appears twice: a debit on
 * the source account and a matching credit on the destination account. Neither
 * leg is real spending or income, so both should be excluded from spend totals
 * and from recurring-payment detection.
 *
 * A debit is paired with a credit when ALL hold:
 *   - they sit on DIFFERENT accounts
 *   - the amounts are equal to the cent (internal transfers are exact)
 *   - the dates are within 2 days of each other (clearing lag)
 *   - at least one leg looks transfer-like (Transfer/PayID/BPAY/…), which keeps
 *     coincidental same-amount expense/income pairs from being mis-flagged
 *
 * Greedy one-to-one matching: each credit leg is consumed at most once.
 * Returns the set of transaction ids (both legs) that are internal transfers.
 */
export function detectInternalTransferIds(transactions: Transaction[]): Set<string> {
  const ids = new Set<string>();
  const debits = transactions.filter(t => t.amount < 0);
  const credits = transactions.filter(t => t.amount > 0);
  const usedCredit = new Set<string>();

  for (const d of debits) {
    const amt = Math.abs(d.amount);
    const dTime = new Date(d.date).getTime();
    const match = credits.find(c => {
      if (usedCredit.has(c.id)) return false;
      if (c.account_id === d.account_id) return false;
      if (Math.abs(c.amount - amt) > 0.01) return false;
      const gapDays = Math.abs(new Date(c.date).getTime() - dTime) / 86400000;
      if (gapDays > 2) return false;
      return isTransferMerchant(d.merchant) || isTransferMerchant(c.merchant);
    });
    if (match) {
      usedCredit.add(match.id);
      ids.add(d.id);
      ids.add(match.id);
    }
  }
  return ids;
}

// ─── Recurring pattern detection ─────────────────────────────────────────────

/**
 * Round an amount to the nearest "bucket" so that two amounts within 2% of
 * each other land in the same bucket.  We use the anchor's own value rounded
 * to 2 dp as the bucket representative — callers are responsible for grouping
 * by (normMerchant, amountBucket) before calling this.
 */
function amountBucket(amount: number): number {
  // Stable magnitude used only inside the pattern's dismissal key.
  return parseFloat(Math.abs(amount).toFixed(2));
}

/** Canonical grouping key for a transaction — prefer the Phase 2B resolved
 *  `merchant_normalized`, falling back to normalising the raw description. */
function canonicalKey(t: Transaction): string {
  const resolved = (t.merchant_normalized ?? '').trim();
  return resolved || normaliseMerchant(t.raw_description || t.merchant || '');
}

/** An inflow reversing a purchase — money back, not income. Never a series. */
function isRefund(t: Transaction): boolean {
  return t.transaction_type === 'refund' || Boolean(t.refund_of);
}

/** A leg already persisted/typed as an internal transfer. */
function isTaggedTransfer(t: Transaction): boolean {
  return Boolean(t.is_transfer || t.transfer_pair_id || t.transaction_type === 'transfer');
}

function primaryAccountId(group: Transaction[]): string {
  const counts = new Map<string, number>();
  for (const t of group) counts.set(t.account_id, (counts.get(t.account_id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Fold near-duplicate merchant groups into one. Two non-transfer groups merge
 * only when they share a first word AND are close names (edit distance ≤ 2, or
 * one is a prefix of the other) — so "shopify" + "shopify au" become one merchant
 * but "the good guys" + "the warehouse" (same first word "the", far apart) do NOT.
 * Transfer groups (keys starting "TRANSFER::") are never merged — distinct payees
 * must stay distinct.
 */
function mergeMerchantGroups(groups: Map<string, Transaction[]>): Map<string, Transaction[]> {
  const merged = new Map<string, Transaction[]>();
  for (const [key, txs] of groups) {
    if (key.startsWith('TRANSFER::')) { merged.set(key, txs); continue; }
    const firstWord = key.split(' ')[0];
    let target: string | undefined;
    for (const existing of merged.keys()) {
      if (existing.startsWith('TRANSFER::')) continue;
      if (existing.split(' ')[0] !== firstWord) continue;
      if (editDistance(existing, key) <= 2 || existing.startsWith(key) || key.startsWith(existing)) {
        target = existing;
        break;
      }
    }
    if (target) merged.get(target)!.push(...txs);
    else merged.set(key, [...txs]);
  }
  return merged;
}

/**
 * Turn one direction's transactions (all outflows OR all inflows) into recurring
 * patterns. Groups by canonical merchant (external transfers keep a per-payee
 * key), fits a cadence, scores confidence, and emits only patterns that clear the
 * evidence + confidence bar. Appends onto `out`.
 */
function buildDirectionPatterns(
  txns: Transaction[],
  direction: 'outflow' | 'inflow',
  subNormNames: Set<string>,
  subTransferKeys: Set<string>,
  minConfidence: number,
  out: RecurringPattern[],
): void {
  const groups = new Map<string, Transaction[]>();
  for (const tx of txns) {
    let key: string;
    // Only OUTFLOWS get the per-payee transfer key (a recurring transfer OUT to an
    // external account — e.g. rent to a landlord — is a real commitment). Internal
    // transfers were already stripped by the caller.
    if (direction === 'outflow' && isTransferMerchant(tx.merchant)) {
      key = `TRANSFER::${tx.merchant.toUpperCase().trim()}`;
    } else {
      key = canonicalKey(tx);
      if (!key || key.length < 3) continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }

  for (const [key, group] of mergeMerchantGroups(groups)) {
    const isTransfer = key.startsWith('TRANSFER::');
    // Already tracked as a subscription?
    if (isTransfer) { if (subTransferKeys.has(key)) continue; }
    else if (subNormNames.has(key)) continue;

    const fit = fitCadence(group.map(t => t.date));
    if (!fit) continue;                                 // no reliable period ⇒ not recurring

    const amt = amountStats(group.map(t => t.amount));
    // A two-point pattern is only enough evidence when the amount is stable
    // (subscription-like); a pair of differently-sized charges is a coincidence.
    if (fit.occurrences < 3 && amt.cv > AMOUNT_VARY_CV) continue;

    const confidence = scoreConfidence(fit, amt);
    if (confidence < minConfidence) continue;

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const anchor = sorted[sorted.length - 1];           // most recent = display name
    const merchantKey = isTransfer ? key : canonicalKey(anchor);
    const signedAmount = direction === 'inflow' ? amt.median : -amt.median;

    out.push({
      merchant: `${merchantKey}::${amountBucket(amt.median)}`,
      displayMerchant: anchor.merchant,
      amount: parseFloat(signedAmount.toFixed(2)),
      frequency: fit.frequency,
      transactionIds: group.map(t => t.id),
      matchingTransactions: sorted,
      accountId: primaryAccountId(group),
      confidence: parseFloat(confidence.toFixed(3)),
      amountVaries: amt.cv > AMOUNT_VARY_CV,
      direction,
    });
  }
}

/**
 * Scan transactions for recurring commitments not yet tracked as subscriptions.
 *
 * What makes something recurring is REGULAR TIMING (see fitCadence), assessed on
 * the canonical merchant. Both directions are detected:
 *   • OUTFLOWS  → bills, subscriptions, loan repayments, external transfers,
 *   • INFLOWS   → salary and other recurring income.
 *
 * Explicitly IGNORED (never a payment/income):
 *   • internal transfers between the user's own accounts (paired debit+credit),
 *   • refunds (transaction_type='refund' or a matched refund_of),
 *   • persisted transfer legs,
 *   • one-offs and irregular spend (no cadence fits → dropped, never "irregular").
 *
 * Every surfaced pattern carries a 0..1 `confidence`; weak ones are filtered by
 * `minConfidence` and the queue is returned strongest-first. Patterns sharing a
 * series identity (merchant_normalized::frequency) are de-duplicated, keeping the
 * strongest, so one confirm/dismiss covers the series and there are no twins.
 */
export function detectRecurringPatterns(
  transactions: Transaction[],
  subscriptions: Subscription[],
  opts: { minConfidence?: number } = {},
): RecurringPattern[] {
  const minConfidence = opts.minConfidence ?? CONF_MIN;

  // Suppress anything already tracked as a subscription. Include original_name so
  // a renamed subscription ("Gym" from "GLOFOXPAYMENT") still suppresses its pattern.
  const subNormNames = new Set<string>(
    [
      ...subscriptions.map(s => normaliseMerchant(s.name)),
      ...subscriptions.filter(s => s.original_name).map(s => normaliseMerchant(s.original_name!)),
    ].filter(Boolean),
  );
  const subTransferKeys = new Set<string>();
  for (const s of subscriptions) {
    subTransferKeys.add(`TRANSFER::${(s.original_name ?? s.name).toUpperCase().trim()}`);
  }

  // Remove money that is not a real payment or income before grouping.
  const internalIds = detectInternalTransferIds(transactions);
  const clean = transactions.filter(t =>
    !internalIds.has(t.id) && !isRefund(t) && !isTaggedTransfer(t),
  );

  const patterns: RecurringPattern[] = [];
  buildDirectionPatterns(
    clean.filter(t => t.amount < 0), 'outflow',
    subNormNames, subTransferKeys, minConfidence, patterns,
  );
  buildDirectionPatterns(
    clean.filter(t => t.amount > 0), 'inflow',
    subNormNames, subTransferKeys, minConfidence, patterns,
  );

  // De-duplicate by series identity, keeping the strongest, then rank the queue.
  const byKey = new Map<string, RecurringPattern>();
  for (const p of patterns) {
    const id = `${normaliseMerchant(p.merchant) || p.merchant}::${p.frequency}`;
    const prev = byKey.get(id);
    if (!prev || p.confidence > prev.confidence) byKey.set(id, p);
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence);
}

// ─── Subscription matching ────────────────────────────────────────────────────

/**
 * Check whether a transaction matches an existing subscription by normalised
 * merchant name and amount (within 2%). Returns the matched subscription or null.
 */
export function findMatchingSubscription(
  tx: { merchant: string; amount: number },
  subscriptions: Subscription[]
): Subscription | null {
  const norm = normaliseMerchant(tx.merchant);
  const amt = Math.abs(tx.amount);
  if (!norm || norm.length < 3) return null;

  return subscriptions.find(sub => {
    const subNorm = normaliseMerchant(sub.name);
    if (!subNorm) return false;
    const nameMatch = norm === subNorm || norm.includes(subNorm) || subNorm.includes(norm);
    const amtMatch = Math.abs(sub.amount - amt) / Math.max(sub.amount, 0.01) <= 0.02;
    return nameMatch && amtMatch;
  }) ?? null;
}

// ─── Cross-account duplicate detection ───────────────────────────────────────

/**
 * Check whether a transaction already exists on a DIFFERENT account with the
 * same normalised merchant name, similar amount (within 2%), and same date.
 * Returns the name of the other account, or null if no cross-account dup found.
 */
export function findCrossAccountDuplicate(
  tx: { merchant: string; amount: number; date: string; account_id: string },
  transactions: Transaction[],
  resolveAccountName: (id: string) => string | null
): { account: string } | null {
  const norm = normaliseMerchant(tx.merchant);
  const amt = Math.abs(tx.amount);
  if (!norm) return null;

  const match = transactions.find(t =>
    t.account_id !== tx.account_id &&
    normaliseMerchant(t.merchant) === norm &&
    Math.abs(Math.abs(t.amount) - amt) / Math.max(amt, 0.01) <= 0.02 &&
    t.date === tx.date
  );

  if (!match) return null;
  return { account: resolveAccountName(match.account_id) ?? 'another account' };
}
