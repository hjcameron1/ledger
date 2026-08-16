/**
 * Phase 3.2 — Cash-flow forecast VIEW helpers (pure, presentation-only).
 *
 * These re-shape the output of the pure forecast engine
 * (utils/cashFlowForecast.ts) for the Forecast page. They deliberately do NOT
 * re-derive any forecast maths: occurrence generation, de-duplication, sign
 * inference and transfer netting all remain the engine's responsibility. Here we
 * only CUMULATE the engine's own `events` into a day-by-day balance line and
 * scope them to the household total or one account, so the page has no logic of
 * its own to test in a browser. Kept pure (no React, no `Date.now`) so it is
 * fully node-testable alongside the engine.
 */

import {
  round2,
  type CashFlowForecast,
  type ForecastEvent,
} from './cashFlowForecast';

/** Household total ("all") or a single account id. */
export type Scope = 'all' | string;

/** One signed cash movement on a date, resolved for the current scope. */
export interface ScopedPosting {
  date: string;
  amount: number;
  event: ForecastEvent;
  /** True when this is the receiving leg of a transfer into the scoped account. */
  incoming?: boolean;
}

/** UTC day-add — matches the engine's UTC-based dates so windows line up exactly. */
export function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Re-shape the engine's `events` for a scope.
 *  • "all"   → household cash: non-transfer events only. Transfers net to zero
 *              across the user's own accounts, exactly as the engine excludes
 *              them from horizon totals, so counting them would double-move cash.
 *  • account → that account's cash: its own events, plus the receiving leg of any
 *              transfer whose counterpart is this account (sign flipped),
 *              mirroring the engine's per-account posting rule.
 */
export function scopePostings(forecast: CashFlowForecast, scope: Scope): ScopedPosting[] {
  if (scope === 'all') {
    return forecast.events
      .filter(e => !e.isTransfer)
      .map(e => ({ date: e.date, amount: e.amount, event: e }));
  }
  const out: ScopedPosting[] = [];
  for (const e of forecast.events) {
    if (e.accountId === scope) {
      out.push({ date: e.date, amount: e.amount, event: e });
    } else if (e.isTransfer && e.counterpartAccountId === scope) {
      out.push({ date: e.date, amount: -e.amount, event: e, incoming: true });
    }
  }
  return out;
}

/** Opening balance for a scope — from the engine's own opening figures. */
export function openingFor(forecast: CashFlowForecast, scope: Scope): number {
  if (scope === 'all') return forecast.openingTotal;
  return forecast.accounts.find(a => a.accountId === scope)?.openingBalance ?? 0;
}

export interface Series {
  /** One point per day across [asOf, asOf+days], stepping on event days. */
  series: { date: string; balance: number }[];
  /** Lowest the running balance dips to in the window (liquidity risk). */
  lowest: number;
  lowestDate: string;
  /** Balance at the end of the window. */
  closing: number;
}

/**
 * Daily running-balance series. Day 0 is the opening balance (today already
 * reflects anything dated today — the engine emits events strictly after asOf),
 * and each later day applies that day's postings. Cash is treated as flat
 * between movements, so a stepped line is the honest shape.
 */
export function buildSeries(
  opening: number,
  postings: ScopedPosting[],
  asOf: string,
  days: number,
): Series {
  const end = addDaysISO(asOf, days);
  const byDate = new Map<string, number>();
  for (const p of postings) {
    if (p.date > asOf && p.date <= end) byDate.set(p.date, (byDate.get(p.date) ?? 0) + p.amount);
  }
  const series: { date: string; balance: number }[] = [];
  let running = opening;
  let lowest = opening;
  let lowestDate = asOf;
  for (let i = 0; i <= days; i++) {
    const d = addDaysISO(asOf, i);
    running = round2(running + (byDate.get(d) ?? 0));
    series.push({ date: d, balance: running });
    if (running < lowest) { lowest = running; lowestDate = d; }
  }
  return { series, lowest, lowestDate, closing: series[series.length - 1]?.balance ?? opening };
}

/** Postings falling within the (asOf, asOf+days] window, sorted by date. */
export function windowPostings(
  postings: ScopedPosting[],
  asOf: string,
  days: number,
): ScopedPosting[] {
  const end = addDaysISO(asOf, days);
  return postings
    .filter(p => p.date > asOf && p.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
