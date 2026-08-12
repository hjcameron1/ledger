/**
 * Phase 2C — Recurring series (pure helpers).
 *
 * Phase 2A/2B already detect recurrence WELL (recurringDetection.ts:
 * detectRecurringPatterns / classifyFrequency / calcNextChargeDate). Phase 2C
 * does NOT re-implement any of that — it PERSISTS the outcome as a
 * `recurring_series` row and links occurrences.
 *
 * This module is the thin, pure glue between a detected RecurringPattern and a
 * stored RecurringSeries: the identity key both share, kind inference, and the
 * suppression test that keeps a confirmed OR dismissed pattern from being
 * re-suggested (the cross-device "stays dismissed" guarantee).
 */

import type { RecurringSeries, RecurringKind, Transaction } from '../types';
import type { RecurringPattern } from './recurringDetection';
import { normaliseMerchant, calcNextChargeDate, isTransferMerchant } from './recurringDetection';

/**
 * The identity of a recurring series: its normalised merchant + frequency. Two
 * charges belong to the same series iff they share this key. It is what the DB
 * unique index (user_id, merchant_normalized, frequency) enforces and what
 * suggestion-suppression matches on.
 */
export function seriesKey(merchant_normalized: string, frequency: string): string {
  return `${merchant_normalized}::${frequency}`;
}

/** The identity key of a detected pattern (mirrors seriesKey for a series row). */
export function patternKey(pattern: Pick<RecurringPattern, 'merchant' | 'frequency'>): string {
  // detectRecurringPatterns already stores the normalised merchant (or raw-upper
  // for transfers) in pattern.merchant, so normalise defensively and reuse it.
  return seriesKey(normaliseMerchant(pattern.merchant) || pattern.merchant, pattern.frequency);
}

/**
 * Infer the most likely kind from a detected pattern. Conservative and
 * overridable by the user at confirm time — income for positive clusters,
 * loan/investment/subscription from obvious merchant hints, else 'other'.
 */
export function inferKind(pattern: Pick<RecurringPattern, 'displayMerchant' | 'amount'>): RecurringKind {
  const name = (pattern.displayMerchant || '').toLowerCase();
  if (pattern.amount > 0) return 'income';
  if (/\b(loan|mortgage|repay|hecs|help debt)\b/.test(name)) return 'loan_repayment';
  if (/\b(super|vanguard|vas|vgs|betashares|invest|brokerage|stake|pearler|contribution)\b/.test(name)) {
    return 'investment_contribution';
  }
  if (isTransferMerchant(name)) return 'other';
  if (/\b(netflix|spotify|stan|disney|binge|kayo|youtube|prime|apple|adobe|patreon|gym|fitness)\b/.test(name)) {
    return 'subscription';
  }
  if (/\b(insurance|electricity|energy|water|gas|internet|nbn|telstra|optus|vodafone|rent|council|rates)\b/.test(name)) {
    return 'bill';
  }
  return 'subscription';
}

/**
 * Build the fields for a new RecurringSeries from a detected pattern. Reuses the
 * EXISTING calcNextChargeDate for next_expected_date so the prediction logic
 * stays in one place. `expected_amount` keeps the pattern's sign.
 */
export function seriesFromPattern(
  pattern: RecurringPattern,
  kind?: RecurringKind,
): Omit<RecurringSeries, 'id' | 'user_id' | 'created_at' | 'updated_at'> {
  const sorted = [...pattern.matchingTransactions].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const lastDate = last?.date ?? new Date().toISOString().split('T')[0];
  const freq = pattern.frequency;
  return {
    merchant_id: last?.merchant_id ?? null,
    merchant_normalized: normaliseMerchant(pattern.merchant) || pattern.merchant,
    name: pattern.displayMerchant,
    original_name: pattern.displayMerchant,
    kind: kind ?? inferKind(pattern),
    frequency: freq,
    expected_amount: pattern.amount,
    last_transaction_date: lastDate,
    next_expected_date: freq === 'irregular' ? null : calcNextChargeDate(lastDate, freq),
    account_id: pattern.accountId ?? last?.account_id ?? null,
    status: 'active',
  };
}

/**
 * Should a detected pattern be SUPPRESSED from the suggestion queue? True when a
 * series already exists for its key with status 'active' (already tracked) or
 * 'dismissed' (the user said no — and because series rows sync, this holds on
 * EVERY device). 'ended' series do NOT suppress — the pattern re-surfacing means
 * it started again.
 */
export function isSuggestionSuppressed(
  pattern: Pick<RecurringPattern, 'merchant' | 'frequency'>,
  series: RecurringSeries[],
): boolean {
  const key = patternKey(pattern);
  return series.some(s =>
    (s.status === 'active' || s.status === 'dismissed') &&
    seriesKey(s.merchant_normalized, s.frequency) === key,
  );
}

/**
 * Transaction ids that belong to a series (its occurrences), by matching the
 * series' normalised merchant. Used at confirm time to stamp recurring_series_id
 * on every current occurrence. Sign-aware: a positive series (income) links
 * inflows, a negative series links outflows.
 */
export function occurrenceIdsForSeries(
  series: Pick<RecurringSeries, 'merchant_normalized' | 'expected_amount'>,
  transactions: Transaction[],
): string[] {
  const wantPositive = (series.expected_amount ?? -1) > 0;
  return transactions
    .filter(t => {
      const key = t.merchant_normalized || normaliseMerchant(t.raw_description || t.merchant || '');
      if (key !== series.merchant_normalized) return false;
      return wantPositive ? t.amount > 0 : t.amount < 0;
    })
    .map(t => t.id);
}
