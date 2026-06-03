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
function isTransferMerchant(raw: string): boolean {
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
  if (avgGap >= 5   && avgGap <= 9)   return 'weekly';
  if (avgGap >= 10  && avgGap <= 18)  return 'fortnightly';
  if (avgGap >= 25  && avgGap <= 35)  return 'monthly';
  if (avgGap >= 80  && avgGap <= 100) return 'quarterly';
  if (avgGap >= 350 && avgGap <= 380) return 'annually';
  return null;
}

/**
 * Allowed gap spread (max − min across all intervals) for each frequency.
 * A spread exceeding this means the intervals are too irregular to be considered
 * reliably periodic at that frequency.
 */
const MAX_SPREAD: Record<string, number> = {
  weekly:      4,
  fortnightly: 6,
  monthly:     12,
  quarterly:   20,
  annually:    30,
};

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
 * Given the most recent charge date and a frequency string, return the
 * ISO date string of the next expected charge.
 * Adds one interval, then keeps advancing until the result is in the future.
 */
export function calcNextChargeDate(lastDate: string, frequency: string): string {
  const days = FREQ_DAYS[frequency] ?? 30;
  const d = new Date(lastDate);
  d.setDate(d.getDate() + days);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Advance past today if the naive +1 interval is still in the past
  while (d < today) {
    d.setDate(d.getDate() + days);
  }
  const result = d.toISOString().split('T')[0];
  return result;
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

  // Build a separate set for transfer subscriptions: key = rawUpper::amount (same
  // format as the grouping key) so "Transfer xx1368 $400" and "Transfer xx2319 $200"
  // are suppressed independently and never cross-suppress each other.
  const subTransferKeys = new Set<string>();
  for (const s of subscriptions) {
    const rawName = (s.original_name ?? s.name).toUpperCase().trim();
    const keyBase = `TRANSFER::${rawName}::`;
    // Match against both stored amount and a 2%-tolerance band
    subTransferKeys.add(`${keyBase}${s.amount.toFixed(2)}`);
  }

  // ── Build grouping buckets ──────────────────────────────────────────────────
  // For transfers: key = "TRANSFER::<rawUpper>::<amountStr>" (exact payee + exact amount)
  // For others:    key = normalisedMerchant  (amount clustering happens inside the loop)
  const groups = new Map<string, Transaction[]>();

  for (const tx of transactions) {
    if (tx.amount >= 0) continue;                       // skip credits/income

    let key: string;
    if (isTransferMerchant(tx.merchant)) {
      // Keep payee name (numbers included) + exact amount so different
      // payees / different transfer amounts never share a bucket.
      const rawUpper = tx.merchant.toUpperCase().trim();
      const amt = Math.abs(tx.amount).toFixed(2);
      key = `TRANSFER::${rawUpper}::${amt}`;
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
    // Transfers: check exact raw-name::amount key so "Transfer xx1368 $400" and
    // "Transfer xx2319 $200" are suppressed independently.
    // Others: check normalised merchant name set.
    if (groupKey.startsWith('TRANSFER::')) {
      // groupKey format: TRANSFER::<RAW>::<AMT>  — use it directly
      if (subTransferKeys.has(groupKey)) continue;
      // Also check with 2% tolerance: re-derive raw+amt and compare to stored subs
      const parts = groupKey.split('::');
      const rawUpper = parts[1];
      const amt = parseFloat(parts[2]);
      const alreadyTracked = subscriptions.some(s => {
        const sRaw = (s.original_name ?? s.name).toUpperCase().trim();
        if (sRaw !== rawUpper) return false;
        return Math.abs(s.amount - amt) / Math.max(s.amount, 0.01) <= 0.02;
      });
      if (alreadyTracked) continue;
    } else {
      if (subNormNames.has(groupKey)) continue;
    }
    if (txs.length < 2) continue;

    const isTransfer = groupKey.startsWith('TRANSFER::');

    // ── Amount clustering (2% tolerance) ──────────────────────────────────────
    // Each distinct amount band within this merchant group becomes its own
    // RecurringPattern, so "$400 Transfer" and "$200 Transfer" (same payee)
    // are presented separately if they were somehow grouped.
    const processed = new Set<string>();

    for (const anchor of txs) {
      if (processed.has(anchor.id)) continue;
      const anchorAmt = Math.abs(anchor.amount);

      const cluster = txs.filter(t => {
        if (processed.has(t.id)) return false;
        const tAmt = Math.abs(t.amount);
        // Amount must be within 2%
        if (Math.abs(tAmt - anchorAmt) / Math.max(anchorAmt, 0.01) > 0.02) return false;
        // For non-transfer merchants: normalised names must be within edit distance 2
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
      const freq = classifyFrequency(avgGap);

      if (freq) {
        // Consistency check: gap variance must stay within this frequency's allowed spread
        if (gaps.length >= 2) {
          const spread = Math.max(...gaps) - Math.min(...gaps);
          if (spread > (MAX_SPREAD[freq] ?? 8)) {
            continue;
          }
        }
      } else {
        // No standard frequency matched, but 2+ distinct dates — flag as irregular
        // (no spread check, since we're not asserting a period)
      }

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
