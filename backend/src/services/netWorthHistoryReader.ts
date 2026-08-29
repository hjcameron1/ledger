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

/**
 * How many pages are in flight at once.
 *
 * Paging one page at a time makes the wall-clock cost of a long series the SUM of
 * its round trips: a twenty-year all-time chart is tens of pages, and read one after
 * another that is seconds of latency spent waiting rather than working. The pages of
 * one ordered query are independent slices, so they can be asked for together.
 * Four is deliberately modest — enough to hide most of the latency, few enough that
 * one user's chart cannot monopolise the connection pool.
 *
 * The width RAMPS: one page, then two, then four. Almost every read in the app is a
 * windowed one that fits in a single page, and asking for four pages to discover
 * that would make the common case four times more expensive to save the rare one.
 */
export const HISTORY_READ_CONCURRENCY = 4;

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
  /** Read only rows STRICTLY BEFORE this instant (ISO). Omit for "up to now". */
  toAt?: string;
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

/**
 * Rows read across several pages of the same ordered query can OVERLAP: an insert
 * that lands between two page reads shifts every later row one place along, so the
 * row that was the last of page 3 becomes the first of page 4. Descending order
 * means those inserts land at the top, which is exactly where paging starts, so the
 * duplicate is the common case and a skipped row is not. Key each row by what makes
 * it unique — its instant, plus the tie-breaker when one snapshot spans many rows —
 * and keep the first sighting.
 */
function dedupe<T extends { recorded_at: string }>(rows: T[], tieBreaker?: string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = tieBreaker ? `${r.recorded_at}|${String((r as Record<string, unknown>)[tieBreaker])}` : r.recorded_at;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Read a user's snapshot history newest-first, hand it back oldest-first. */
export async function readSnapshotHistory<T extends { recorded_at: string }>(
  opts: HistoryReadOptions,
): Promise<HistoryRead<T>> {
  const max = opts.maxRows ?? HISTORY_MAX_ROWS;
  const out: T[] = [];
  let truncated = false;
  let done = false;

  const fetchPage = (page: number) => {
    let q = supabase
      .from(opts.table)
      .select(opts.columns)
      .eq('user_id', opts.userId)
      .order('recorded_at', { ascending: false });
    if (opts.tieBreaker) q = q.order(opts.tieBreaker, { ascending: false });
    if (opts.fromAt) q = q.gte('recorded_at', opts.fromAt);
    if (opts.toAt) q = q.lt('recorded_at', opts.toAt);
    return q.range(page * HISTORY_PAGE, page * HISTORY_PAGE + HISTORY_PAGE - 1);
  };

  for (let page = 0, ramp = 1; !done;) {
    const room = max - out.length;
    if (room <= 0) { truncated = true; break; }
    const width = Math.min(ramp, HISTORY_READ_CONCURRENCY, Math.ceil(room / HISTORY_PAGE));
    ramp = Math.min(ramp * 2, HISTORY_READ_CONCURRENCY);
    const batch = await Promise.all(
      Array.from({ length: width }, (_, i) => fetchPage(page + i)),
    );
    for (let i = 0; i < batch.length; i++) {
      const { data, error } = batch[i];
      if (error) {
        console.error(`[NW HISTORY] ${opts.table} page ${page + i} failed:`, error.message);
        truncated = true; done = true; break;
      }
      const chunk = (data ?? []) as unknown as T[];
      out.push(...chunk);
      // A short page is the end of the series. Pages fetched alongside it are past
      // the end and are dropped rather than appended out of order.
      if (chunk.length < HISTORY_PAGE) { done = true; break; }
    }
    page += width;
  }

  const unique = dedupe(out, opts.tieBreaker);
  const kept = truncated ? dropPartialBoundary(unique) : unique;
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

// ─── local calendar buckets ──────────────────────────────────────────────────

/** The two grains history is compacted to. A day for the recent past, a month
 *  beyond it — both in the owner's own calendar, never UTC's. */
export type BucketUnit = 'day' | 'month';

const partFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of an instant in a zone. */
function wallParts(ms: number, timeZone: string) {
  let f = partFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partFormatters.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  // Some runtimes render midnight as hour 24 under hour12:false.
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second),
  };
}

/** How far ahead of UTC the zone is at that instant, in ms. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = wallParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a local wall-clock date begins.
 *
 * A zone's offset depends on the instant, and the instant is what we are solving
 * for, so this is a fixed point: guess with the offset at the naive UTC reading,
 * then re-read the offset at the guess. Two passes settle every real zone,
 * including the days daylight saving starts and ends — which is the whole reason
 * this cannot be `Date.parse(day + 'T00:00:00')` plus a constant.
 */
function wallStartMs(y: number, mo: number, d: number, timeZone: string): number {
  const naive = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const once = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(once, timeZone);
}

/** `YYYY-MM-DD` or `YYYY-MM` — the bucket an instant belongs to, for its owner. */
export function localBucketKey(iso: string, timeZone: string, unit: BucketUnit): string {
  const day = localDayKey(iso, timeZone);
  return unit === 'day' ? day : day.slice(0, 7);
}

/** The half-open instant range `[start, end)` a bucket key covers. Consecutive
 *  buckets tile the timeline exactly: one bucket's end IS the next one's start. */
export function localBucketRangeMs(key: string, timeZone: string, unit: BucketUnit): { startMs: number; endMs: number } {
  const y = Number(key.slice(0, 4));
  const mo = Number(key.slice(5, 7));
  const d = unit === 'day' ? Number(key.slice(8, 10)) : 1;
  const startMs = wallStartMs(y, mo, d, timeZone);
  const endMs = unit === 'day'
    ? wallStartMs(y, mo, d + 1, timeZone)          // Date.UTC rolls day 32 over for us
    : wallStartMs(y, mo + 1, 1, timeZone);         // …and month 13 likewise
  return { startMs, endMs };
}

/** The start of the bucket that CONTAINS `ms`. Cutoffs are aligned with this so
 *  that no bucket ever straddles the line between two retention tiers. */
export function floorToBucketMs(ms: number, timeZone: string, unit: BucketUnit): number {
  return localBucketRangeMs(localBucketKey(new Date(ms).toISOString(), timeZone, unit), timeZone, unit).startMs;
}
