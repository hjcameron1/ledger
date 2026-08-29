import { supabase } from '../utils/supabase';
import {
  latestSnapshotAtOrBefore, localDayKey, readSnapshotHistory, userTimezone,
} from './netWorthHistoryReader';

/**
 * The recorded net-worth series behind the Overview chart.
 *
 * Lifted out of the route so the number the endpoint returns and the number the
 * stress simulation asserts on are produced by the SAME code. The route used to
 * carry sixty lines of reading, bucketing and percentage arithmetic that only a
 * hand-written mirror in the tests ever checked, and a mirror agrees with whatever
 * it was copied from — including the bugs.
 */

export interface PctHistoryPoint {
  recorded_at: string;
  /** Movement since the first tracked reading, as a % of the SIZE of that reading. */
  pct: number;
  value: number;
}

export interface PctHistory {
  timeframe: string;
  baseline: number;
  timezone: string;
  points: PctHistoryPoint[];
  /** True only if the history is so long the row budget ran out — see the reader. */
  truncated: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function pctWindowStart(timeframe: string, nowMs: number): number | undefined {
  const windows: Record<string, number> = {
    daily: nowMs - DAY,
    weekly: nowMs - 7 * DAY,
    monthly: nowMs - 30 * DAY,
    yearly: nowMs - 365 * DAY,
  };
  return windows[timeframe];
}

/**
 * Percentage against the SIZE of the baseline.
 *
 * Dividing by a signed baseline inverts the whole chart for anyone who started
 * tracking in the red: a user climbing from −$40,000 to +$48,000 was drawn falling
 * to −220%, because each step up made the numerator more positive while the divisor
 * stayed negative. The dollar movement and its percentage must always carry the same
 * sign — paying off debt is a gain — so the divisor is |baseline|, exactly as the
 * client's own series already does it.
 */
export function pctAgainstBaseline(value: number, baseline: number): number {
  if (!Number.isFinite(baseline) || Math.abs(baseline) < 0.005) return 0;
  return parseFloat((((value - baseline) / Math.abs(baseline)) * 100).toFixed(4));
}

/** Earliest NON-ZERO recorded total: the 0% reference. Zero-value rows from before
 *  any account existed must never become the divisor. */
async function readBaseline(userId: string): Promise<number> {
  const { data } = await supabase
    .from('net_worth_history')
    .select('total_value')
    .eq('user_id', userId)
    .neq('total_value', 0)
    .order('recorded_at', { ascending: true })
    .limit(1);
  return Number((data as { total_value?: number }[] | null)?.[0]?.total_value ?? 0);
}

export async function readPctHistory(userId: string, timeframe: string, nowMs = Date.now()): Promise<PctHistory> {
  const baseline = await readBaseline(userId);
  const tz = await userTimezone(userId);
  const startMs = pctWindowStart(timeframe, nowMs);

  // Read from the last snapshot at/before the window opens, so the line starts at
  // the value the window really started from rather than at the first snapshot that
  // happened to land inside it. "all" has no window and reads everything.
  let fromAt: string | undefined;
  if (startMs != null) {
    fromAt = (await latestSnapshotAtOrBefore('net_worth_history', userId, startMs))
      ?? new Date(startMs).toISOString();
  }

  const { rows, truncated } = await readSnapshotHistory<{ recorded_at: string; total_value: number }>({
    table: 'net_worth_history',
    userId,
    columns: 'recorded_at, total_value',
    fromAt,
  });

  // Daily is the intraday view and keeps every reading. Every other timeframe draws
  // one point per calendar day IN THE USER'S OWN ZONE — the latest reading of that
  // day, which is that day's close for them.
  let series = rows;
  if (timeframe !== 'daily') {
    const byDay = new Map<string, typeof rows[number]>();
    for (const r of rows) byDay.set(localDayKey(r.recorded_at, tz), r); // ascending ⇒ last wins
    series = Array.from(byDay.values());
  }

  return {
    timeframe,
    baseline,
    timezone: tz,
    truncated,
    points: series.map(r => ({
      recorded_at: r.recorded_at,
      pct: pctAgainstBaseline(Number(r.total_value), baseline),
      value: Number(r.total_value),
    })),
  };
}
