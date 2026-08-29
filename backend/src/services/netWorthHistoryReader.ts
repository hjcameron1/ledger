import { supabase } from '../utils/supabase';

/**
 * READING THE NET-WORTH HISTORY WITHOUT LOSING THE END OF IT.
 *
 * Both history tables are append-only and grow at the cron's cadence — one row an
 * hour in `net_worth_history`, one row an hour PER ITEM in `net_worth_item_history`.
 * Over years that is a table no single request can return, and every previous way of
 * asking for it failed in the same direction:
 *
 *   • `.order('recorded_at', { ascending: true }).limit(N)` returns the OLDEST N rows.
 *     The chart then stopped dead N rows after tracking began and drew the last ten
 *     months as one straight line to the live point, while the numbers underneath it
 *     stayed right — a stale series that looks calm rather than broken.
 *   • Paging ascending with a fixed page budget has the same shape one level up: it
 *     runs out at the NEW end, so the newest snapshot the reader ever sees is frozen
 *     at whatever day the budget expired.
 *
 * So this module reads BACKWARDS. Newest first, page by page, and the caller is
 * handed the rows oldest-first at the end. If a budget is ever exhausted it is the
 * OLDEST rows that are missing — the line starts later, which is visible — and never
 * the newest, so a point on the chart is never stale and the reader says so via
 * `truncated` rather than leaving the caller to guess.
 *
 * Reads are windowed wherever the caller only needs a window (see
 * `latestSnapshotAtOrBefore`): a "last 30 days" question reads thirty days of rows,
 * not the whole history, which is what keeps this cheap as the years accumulate.
 */

/** Supabase's PostgREST caps one response at 1000 rows; page at exactly that. */
export const HISTORY_PAGE = 1000;

/**
 * Backstop against a runaway read, not a design limit: 500,000 rows is ~57 years of
 * hourly totals, or ~4.7 years of hourly snapshots on 12 items. Hitting it sets
 * `truncated`, and because the read runs newest-first what is missing is the far end
 * of the past.
 */
export const HISTORY_MAX_ROWS = 500_000;

export interface HistoryRead<T> {
  /** Ascending by `recorded_at`, which is the order every builder expects. */
  rows: T[];
  /** The budget ran out. Oldest rows are absent; the newest are always present. */
  truncated: boolean;
}

export interface HistoryReadOptions {
  table: 'net_worth_history' | 'net_worth_item_history';
  userId: string;
  columns: string;
  /** Read only rows at/after this instant (ISO). Omit to read the whole history. */
  fromAt?: string;
  /** A second, unique-per-row sort key, so paging is stable when many rows share
   *  one `recorded_at` — every item of a snapshot does. */
  tieBreaker?: string;
  maxRows?: number;
}

/**
 * Every row of one snapshot carries the SAME `recorded_at`, so a budget that expires
 * mid-way through one leaves a snapshot that was never taken: a point assembled from
 * 8 of 12 accounts, which reads downstream as "four accounts left net worth". Drop
 * the boundary group so a truncated read still ends on whole snapshots only.
 */
function dropPartialBoundary<T extends { recorded_at: string }>(descending: T[]): T[] {
  if (descending.length === 0) return descending;
  const oldest = descending[descending.length - 1].recorded_at;
  let end = descending.length;
  while (end > 0 && descending[end - 1].recorded_at === oldest) end--;
  // Everything read shares one timestamp — keep it rather than return nothing; a
  // single snapshot is complete or it is all the caller can have either way.
  return end === 0 ? descending : descending.slice(0, end);
}

/** Read a user's snapshot history newest-first, hand it back oldest-first. */
export async function readSnapshotHistory<T extends { recorded_at: string }>(
  opts: HistoryReadOptions,
): Promise<HistoryRead<T>> {
  const max = opts.maxRows ?? HISTORY_MAX_ROWS;
  const out: T[] = [];
  let truncated = false;

  for (let page = 0; ; page++) {
    if (out.length >= max) { truncated = true; break; }
    let q = supabase
      .from(opts.table)
      .select(opts.columns)
      .eq('user_id', opts.userId)
      .order('recorded_at', { ascending: false });
    if (opts.tieBreaker) q = q.order(opts.tieBreaker, { ascending: false });
    if (opts.fromAt) q = q.gte('recorded_at', opts.fromAt);

    const { data, error } = await q.range(page * HISTORY_PAGE, page * HISTORY_PAGE + HISTORY_PAGE - 1);
    if (error) {
      console.error(`[NW HISTORY] ${opts.table} page ${page} failed:`, error.message);
      truncated = true;
      break;
    }
    const chunk = (data ?? []) as unknown as T[];
    if (chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < HISTORY_PAGE) break;
  }

  const kept = truncated ? dropPartialBoundary(out) : out;
  if (truncated) {
    console.warn(
      `[NW HISTORY] ${opts.table} read hit the ${max}-row budget for ${opts.userId} — ` +
      `the oldest rows are not in this series (the newest always are).`,
    );
  }
  kept.reverse();
  return { rows: kept, truncated };
}

/**
 * The `recorded_at` of the last snapshot at/before `ms`, or null if the user has
 * none that old. A windowed question needs this one row from BEFORE the window as
 * its baseline — "what was this worth when the window opened" — and reading from it
 * rather than from the window edge is what lets every other row stay unread.
 */
export async function latestSnapshotAtOrBefore(
  table: 'net_worth_history' | 'net_worth_item_history',
  userId: string,
  ms: number,
): Promise<string | null> {
  const { data } = await supabase
    .from(table)
    .select('recorded_at')
    .eq('user_id', userId)
    .lte('recorded_at', new Date(ms).toISOString())
    .order('recorded_at', { ascending: false })
    .limit(1);
  const at = (data as { recorded_at?: string }[] | null)?.[0]?.recorded_at;
  return at ?? null;
}

// ─── days, in the timezone the user actually lives in ────────────────────────

/** Matches the default the briefing settings already ship with. */
export const DEFAULT_TIMEZONE = 'Australia/Sydney';

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** A validated IANA zone, falling back to the app's default rather than throwing. */
export function resolveTimezone(tz: string | null | undefined): string {
  const candidate = tz && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * The calendar day a snapshot falls on FOR THE PERSON WHO OWNS IT.
 *
 * Bucketing by `toISOString().split('T')[0]` buckets by UTC, so for a Sydney user
 * every "daily" point on the monthly and yearly charts was the last snapshot before
 * about 10am local — the middle of their morning presented as the close of their
 * day, and two genuinely different days merged whenever the UTC boundary fell mid
 * afternoon. Format in the user's own zone instead; 'en-CA' yields YYYY-MM-DD.
 */
export function localDayKey(iso: string, timeZone: string): string {
  let fmt = dayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, fmt);
  }
  return fmt.format(new Date(iso));
}

/** The user's timezone preference, validated. */
export async function userTimezone(userId: string): Promise<string> {
  const { data } = await supabase.from('users').select('timezone').eq('id', userId).maybeSingle();
  return resolveTimezone((data as { timezone?: string | null } | null)?.timezone);
}
