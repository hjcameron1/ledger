/**
 * Pure utility functions for recurring payment detection and duplicate checking.
 * No API calls — operates entirely on the local Zustand store data.
 */

import type { Transaction, Subscription } from '../types';

// ─── Merchant normalisation ──────────────────────────────────────────────────

const STRIP_WORDS = /\b(PAYMENT|PAYMENTS|PAY|INTERNET|ONLINE|TRANSFER|DEBIT|PURCHASE|DIRECT|BPAY|AUS|AU|PTY|LTD|LIMITED|AUSTRALIA|DIGITAL|SERVICES|RECURRING|CHARGE|SUBSCRIPTION|BILLING|BILL)\b/g;

/**
 * Normalise a merchant name for fuzzy matching.
 * Strips common payment suffixes, numbers, and punctuation.
 * e.g. "GLOFOXPAYMENT 3423" → "GLOFOX", "Netflix.com" → "NETFLIX"
 */
export function normaliseMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(STRIP_WORDS, '')
    .replace(/\d+/g, '')          // strip numbers
    .replace(/[^A-Z\s]/g, '')     // strip non-alpha
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Frequency classification ────────────────────────────────────────────────

function classifyFrequency(avgGap: number): 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | null {
  if (avgGap >= 5  && avgGap <= 10)  return 'weekly';
  if (avgGap >= 11 && avgGap <= 20)  return 'fortnightly';
  if (avgGap >= 21 && avgGap <= 45)  return 'monthly';
  if (avgGap >= 60 && avgGap <= 120) return 'quarterly';
  if (avgGap >= 300 && avgGap <= 400) return 'annually';
  return null;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecurringPattern {
  /** Normalised merchant key (for deduplication) */
  merchant: string;
  /** Raw merchant name from the first matching transaction */
  displayMerchant: string;
  amount: number;
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually';
  transactionIds: string[];
  /** Primary account_id from the cluster — used to scope dismissal */
  accountId: string;
}

// ─── Dismissal helpers (localStorage) ───────────────────────────────────────

const LS_PREFIX = 'ledger-dismissed-recurring';

function dismissedKey(pattern: RecurringPattern): string {
  return `${LS_PREFIX}-${pattern.accountId}-${pattern.merchant}-${pattern.amount}`;
}

export function isPatternDismissed(pattern: RecurringPattern): boolean {
  try { return localStorage.getItem(dismissedKey(pattern)) === '1'; }
  catch { return false; }
}

export function dismissPattern(pattern: RecurringPattern): void {
  try { localStorage.setItem(dismissedKey(pattern), '1'); }
  catch { /* storage unavailable */ }
}

/** Call when an account or credit card is deleted — clears all dismissed-pattern
 *  records scoped to that account so they re-surface if the account is re-added. */
export function clearDismissedForAccount(accountId: string): void {
  try {
    const prefix = `${LS_PREFIX}-${accountId}-`;
    Object.keys(localStorage)
      .filter(k => k.startsWith(prefix))
      .forEach(k => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

// ─── Recurring pattern detection ─────────────────────────────────────────────

/**
 * Scan a list of transactions for recurring expense patterns not yet tracked
 * as subscriptions. Returns one RecurringPattern per merchant+amount cluster.
 */
export function detectRecurringPatterns(
  transactions: Transaction[],
  subscriptions: Subscription[]
): RecurringPattern[] {
  // Build set of already-subscribed normalised merchant names
  const subNormNames = new Set(subscriptions.map(s => normaliseMerchant(s.name)));

  // Group expense transactions by normalised merchant
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;                       // skip credits/income
    const key = normaliseMerchant(tx.merchant);
    if (!key || key.length < 3) continue;               // skip noise
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }

  const patterns: RecurringPattern[] = [];

  for (const [normMerchant, txs] of groups) {
    if (subNormNames.has(normMerchant)) continue;       // already a subscription
    if (txs.length < 2) continue;

    // Find amount clusters within 2% tolerance
    const processed = new Set<string>();
    for (const anchor of txs) {
      if (processed.has(anchor.id)) continue;
      const anchorAmt = Math.abs(anchor.amount);
      const cluster = txs.filter(t =>
        Math.abs(Math.abs(t.amount) - anchorAmt) / Math.max(anchorAmt, 0.01) <= 0.02
      );
      cluster.forEach(t => processed.add(t.id));
      if (cluster.length < 2) continue;

      // Unique dates sorted
      const dates = [...new Set(cluster.map(t => t.date))].sort();
      if (dates.length < 2) continue;

      const gaps = dates.slice(1).map((d, i) =>
        (new Date(d).getTime() - new Date(dates[i]).getTime()) / 86400000
      );
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

      // Check consistency (≤3 day variance when 2+ gaps exist)
      if (gaps.length >= 2) {
        const spread = Math.max(...gaps) - Math.min(...gaps);
        if (spread > 3) continue;
      }

      const freq = classifyFrequency(avgGap);
      if (!freq) continue;

      const avgAmt = cluster.reduce((s, t) => s + Math.abs(t.amount), 0) / cluster.length;

      // Most common account_id in the cluster (for scoped dismissal)
      const accountIdCounts = new Map<string, number>();
      for (const t of cluster) accountIdCounts.set(t.account_id, (accountIdCounts.get(t.account_id) ?? 0) + 1);
      const primaryAccountId = [...accountIdCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

      patterns.push({
        merchant: normMerchant,
        displayMerchant: anchor.merchant,
        amount: parseFloat(avgAmt.toFixed(2)),
        frequency: freq,
        transactionIds: cluster.map(t => t.id),
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
