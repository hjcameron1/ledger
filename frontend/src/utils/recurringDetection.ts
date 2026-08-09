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

function editDistance(a: string, b: string): number {
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

// ─── Frequency classification ────────────────────────────────────────────────

function classifyFrequency(avgGap: number): 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | null {
  // Ranges are contiguous (no dead zones) so a gap that lands between two
  // classic intervals — e.g. ~21 days, or a 4-weekly (28d) "monthly" bill — is
  // still classified rather than silently demoted to 'irregular'. The monthly
  // band is generous because calendar months span 28–31 days and many billers
  // drift a few days around weekends/holidays.
  if (avgGap >= 4   && avgGap <= 9)   return 'weekly';
  if (avgGap >= 10  && avgGap <= 20)  return 'fortnightly';
  if (avgGap >= 21  && avgGap <= 45)  return 'monthly';
  if (avgGap >= 75  && avgGap <= 110) return 'quarterly';
  if (avgGap >= 330 && avgGap <= 400) return 'annually';
  return null;
}

/**
 * Allowed gap spread (max − min across all intervals) for each frequency.
 * A spread exceeding this means the intervals are too irregular to be considered
 * reliably periodic at that frequency.
 */
const MAX_SPREAD: Record<string, number> = {
  weekly:      4,
  fortnightly: 8,
  monthly:     16,
  quarterly:   24,
  annually:    40,
};

/**
 * Best-guess frequency for a set of charge dates, using the SAME gap ranges and
 * spread tolerance as auto-detection. Returns null when the dates are too few or
 * too irregular to assert a period. Exposed so the manual "pick transactions"
 * flow can pre-fill a sensible frequency from the selected occurrences instead of
 * re-implementing (and drifting from) the classifier.
 */
export function suggestFrequencyFromDates(
  dates: string[],
): 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | null {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 2) return null;
  const gaps = uniq.slice(1).map((d, i) =>
    (new Date(d).getTime() - new Date(uniq[i]).getTime()) / 86400000,
  );
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const freq = classifyFrequency(avgGap);
  if (!freq) return null;
  if (gaps.length >= 2) {
    const spread = Math.max(...gaps) - Math.min(...gaps);
    if (spread > (MAX_SPREAD[freq] ?? 8)) return null;
  }
  return freq;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecurringPattern {
  /** Grouping key — normalised merchant name (or raw uppercased for transfers) */
  merchant: string;
  /** Raw merchant name from the first matching transaction */
  displayMerchant: string;
  amount: number;
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | 'irregular';
  transactionIds: string[];
  /** All matching transactions, sorted by date — shown as evidence in the modal */
  matchingTransactions: Transaction[];
  /** Primary account_id from the cluster — used to scope dismissal */
  accountId: string;
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
  // Round to nearest dollar at large amounts, nearest 10c otherwise —
  // actual tolerance check is done per-cluster, not here.
  return parseFloat(Math.abs(amount).toFixed(2));
}

/**
 * Scan a list of transactions for recurring expense patterns not yet tracked
 * as subscriptions.
 *
 * Grouping rules:
 *  - Transfer/PayID merchants: key = raw uppercased name + exact amount
 *    (preserves payee suffix so xx1368 ≠ xx2319)
 *  - All other merchants: key = normaliseMerchant(name)
 *    Amount clusters within 2% tolerance are then found inside each group;
 *    each distinct amount cluster becomes its own RecurringPattern.
 *
 * Two transactions are in the same cluster only when BOTH:
 *  1. normalised names are within edit distance 2  (or exact for transfers)
 *  2. amounts are within 2% of each other
 */
export function detectRecurringPatterns(
  transactions: Transaction[],
  subscriptions: Subscription[]
): RecurringPattern[] {
  // Build set of already-subscribed normalised merchant names (for regular merchants).
  // Include original_name so a renamed subscription ("Gym" from "GLOFOXPAYMENT")
  // still suppresses its pattern from re-surfacing.
  const subNormNames = new Set([
    ...subscriptions.map(s => normaliseMerchant(s.name)),
    ...subscriptions.filter(s => s.original_name).map(s => normaliseMerchant(s.original_name!)),
  ]);

  // Build a separate set for transfer subscriptions, keyed on the PAYEE only
  // (matching the amount-free grouping key) so a "For University" transfer already
  // tracked as a subscription is suppressed regardless of its (varying) amount.
  const subTransferKeys = new Set<string>();
  for (const s of subscriptions) {
    const rawName = (s.original_name ?? s.name).toUpperCase().trim();
    subTransferKeys.add(`TRANSFER::${rawName}`);
  }

  // ── Build grouping buckets ──────────────────────────────────────────────────
  // For transfers: key = "TRANSFER::<rawUpper>::<amountStr>" (exact payee + exact amount)
  // For others:    key = normalisedMerchant  (amount clustering happens inside the loop)
  const groups = new Map<string, Transaction[]>();

  // NOTE: internal transfers (money to an account the user ALSO tracks in Ledger)
  // are intentionally NOT excluded here. A *recurring* transfer — a fortnightly
  // deposit into your own savings/investment account — is a genuine regular
  // commitment the user wants surfaced, and the 2+ occurrence / interval gating
  // below already keeps one-off shuffles between accounts out. Excluding them made
  // detection depend on whether the DESTINATION account happened to be tracked:
  // a transfer to an untracked account was detected, an identical transfer to a
  // tracked one silently vanished (its debit got paired with the matching credit
  // leg). Internal-transfer exclusion still applies to SPEND totals — that filter
  // lives at each spend call site (see Accounts.tsx), not in recurring detection.
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;                       // skip credits/income (a transfer's
                                                        // return leg is a credit → never double-counted)

    let key: string;
    if (isTransferMerchant(tx.merchant)) {
      // Key on the PAYEE only (full description, numbers included) — NOT the
      // amount. A "Transfer to xx1368 For University" is one recurring commitment
      // even when the amount changes month to month (e.g. $400 then $200), so all
      // transfers to the same payee/purpose must share a bucket. Different payees
      // (xx1368 vs xx2319) still keep distinct keys because the raw text differs.
      const rawUpper = tx.merchant.toUpperCase().trim();
      key = `TRANSFER::${rawUpper}`;
    } else {
      key = normaliseMerchant(tx.merchant);
      if (!key || key.length < 3) continue;             // skip noise
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }

  // ── Merge groups that share the same first normalised word (e.g. Shopify) ───
  // "shopify" and "shopify sydney vi" both start with "shopify" — fold them into
  // the longer-key group so amount clustering can treat them as one merchant.
  // Transfer groups are never merged here (their keys start with "TRANSFER::").
  const mergedGroups = new Map<string, Transaction[]>();
  for (const [key, txs] of groups) {
    if (key.startsWith('TRANSFER::')) { mergedGroups.set(key, txs); continue; }
    const firstWord = key.split(' ')[0];
    let target: string | undefined;
    for (const existingKey of mergedGroups.keys()) {
      if (!existingKey.startsWith('TRANSFER::') && existingKey.split(' ')[0] === firstWord) {
        target = existingKey; break;
      }
    }
    if (target) {
      mergedGroups.get(target)!.push(...txs);
    } else {
      mergedGroups.set(key, [...txs]);
    }
  }

  const patterns: RecurringPattern[] = [];

  for (const [groupKey, txs] of mergedGroups) {
    // Skip if already tracked as a subscription.
    // Transfers: key is TRANSFER::<RAW> (payee only) — suppress when a subscription
    // exists for that same payee, regardless of amount.
    // Others: check normalised merchant name set.
    if (groupKey.startsWith('TRANSFER::')) {
      if (subTransferKeys.has(groupKey)) continue;
    } else {
      if (subNormNames.has(groupKey)) continue;
    }
    if (txs.length < 2) continue;

    const isTransfer = groupKey.startsWith('TRANSFER::');

    // ── Clustering by payee/merchant identity (amount-agnostic) ───────────────
    // The whole group is one recurring commitment; we no longer split it by
    // amount. The anchor loop remains so name-fuzzy merchant variants still fold
    // together via edit distance, but amounts never partition a cluster.
    const processed = new Set<string>();

    for (const anchor of txs) {
      if (processed.has(anchor.id)) continue;

      const cluster = txs.filter(t => {
        if (processed.has(t.id)) return false;
        // Cluster purely on WHO/WHAT, never on amount. Both ordinary merchants
        // (KMART, Woolworths) and transfers (a "For University" transfer) recur
        // with DIFFERENT amounts each time, so an amount filter would wrongly split
        // a single recurring commitment into unseen singletons. Transfers already
        // share an exact payee key; ordinary merchants match within edit distance 2.
        if (!isTransfer) {
          const normAnchor = normaliseMerchant(anchor.merchant);
          const normT      = normaliseMerchant(t.merchant);
          if (editDistance(normAnchor, normT) > 2) return false;
        }
        return true;
      });

      cluster.forEach(t => processed.add(t.id));
      if (cluster.length < 2) continue;

      // Sort by date
      const sorted = [...cluster].sort((a, b) => a.date.localeCompare(b.date));

      // Unique dates sorted
      const dates = [...new Set(sorted.map(t => t.date))].sort();
      if (dates.length < 2) continue;

      const gaps = dates.slice(1).map((d, i) =>
        (new Date(d).getTime() - new Date(dates[i]).getTime()) / 86400000
      );
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

      // Classify frequency by average gap.
      // For exactly 2 occurrences (1 gap) there's no spread to check.
      let freq = classifyFrequency(avgGap);

      if (freq && gaps.length >= 2) {
        // Consistency check: if the gaps are too irregular to confidently assert a
        // fixed period, DON'T discard the pattern — just demote it to "irregular".
        // A merchant you visit repeatedly at uneven intervals (e.g. KMART on the
        // 16th, 17th, 24th, then 3 weeks later) is still a place you regularly
        // spend, so the user should still be asked about it; we simply don't claim
        // it's "weekly". Previously this path dropped the pattern entirely, which
        // is why irregular-but-real recurring spend was never surfaced.
        const spread = Math.max(...gaps) - Math.min(...gaps);
        if (spread > (MAX_SPREAD[freq] ?? 8)) {
          freq = null;
        }
      }
      // freq === null here means 2+ distinct dates but no reliable period → the
      // pattern is still surfaced below as 'irregular'.

      const effectiveFreq: RecurringPattern['frequency'] = freq ?? 'irregular';

      const avgAmt = cluster.reduce((s, t) => s + Math.abs(t.amount), 0) / cluster.length;

      // Most common account_id in the cluster (for scoped dismissal)
      const accountIdCounts = new Map<string, number>();
      for (const t of cluster) accountIdCounts.set(t.account_id, (accountIdCounts.get(t.account_id) ?? 0) + 1);
      const primaryAccountId = [...accountIdCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

      // Stable key for dismissal: use normalised merchant + bucketed amount
      const merchantKey = isTransfer
        ? `TRANSFER::${anchor.merchant.toUpperCase().trim()}`
        : normaliseMerchant(anchor.merchant);

      patterns.push({
        merchant: `${merchantKey}::${amountBucket(avgAmt)}`,
        displayMerchant: anchor.merchant,
        amount: parseFloat(avgAmt.toFixed(2)),
        frequency: effectiveFreq,
        transactionIds: cluster.map(t => t.id),
        matchingTransactions: sorted,
        accountId: primaryAccountId,
      });
    }
  }

  return patterns;
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
