import { supabase } from '../utils/supabase';
import {
  BucketUnit, floorToBucketMs, localBucketKey, localBucketRangeMs,
  readSnapshotHistory, userTimezone,
} from './netWorthHistoryReader';

/**
 * KEEPING TWENTY YEARS OF HISTORY WITHOUT KEEPING TWENTY YEARS OF ROWS.
 *
 * Snapshots are written by the hourly cron AND by every account, investment, loan
 * and property mutation, so a single active year is thousands of rows in
 * `net_worth_history` and thousands MULTIPLIED BY THE ITEM COUNT in
 * `net_worth_item_history`. On a 25-asset portfolio that is a quarter of a million
 * item rows a year. Left alone, "All time" eventually becomes a request that cannot
 * be served: the reader's row budget runs out, and the oldest history — the part
 * that makes it "all time" at all — is what silently goes missing.
 *
 * The answer is not a bigger budget. It is that nobody needs to know what their net
 * worth was at 3pm on a Tuesday nine years ago, while everybody needs to know what
 * it was that MONTH, and what the biggest move in that month was. So history is kept
 * at three grains:
 *
 *   • the last 14 days   — every reading, untouched. This is the Daily chart, the
 *                          movers, and anything an import or a bad price feed may
 *                          need to be audited against.
 *   • 14 to 400 days     — one reading per calendar day, in the OWNER'S timezone:
 *                          that day's CLOSE.
 *   • older than 400     — one bucket per calendar month, keeping that month's
 *                          CLOSE, its HIGH and its LOW.
 *
 * The close is what the chart draws. `readPctHistory` already reduces every
 * timeframe except the intraday one to a single point per local day — the last
 * reading of that day — so keeping each day's close means the line drawn from
 * compacted history is bit-for-bit the line that was drawn from the full history.
 * Nothing that was ever ON the chart between 14 and 400 days ago is lost, which is
 * why the daily grain does not need the extremes as well: a spike that had reverted
 * before the day closed was never drawn on any view but the last-24-hours one, and
 * that view only ever looks at readings this policy does not touch.
 *
 * A month is different. Month closes alone would draw a flat line straight through
 * a crash and its recovery, because the two ends of the month look ordinary; the
 * extreme is the movement. So a compacted month keeps its own high and its own low
 * as well, and both of them ARE drawn — they fall on their own days, and the chart
 * has a point per day. The shape of what happened survives even where the
 * hour-by-hour detail does not.
 *
 * Three rules make this safe to run against real money:
 *
 *   1. NOTHING IS EVER REWRITTEN OR SYNTHESISED. Compaction only ever DELETES rows.
 *      Every row that survives is a reading the engine actually recorded at the
 *      instant it says, with the value it actually had. There is no averaging, no
 *      resampling, no interpolation — no number in this history was ever computed
 *      by this file.
 *   2. THE TWO TABLES STAY IN LOCKSTEP. The same instants are kept in
 *      `net_worth_history` and `net_worth_item_history`, so the invariant the write
 *      path maintains — a total on the chart always has its breakdown beside it —
 *      holds for compacted history too, and the adjusted series has a point
 *      wherever the raw series does.
 *   3. THE FIRST READING IS PINNED FOREVER. Every percentage on the Overview is
 *      measured against the earliest recorded total; deleting it would silently
 *      re-base the entire chart. It is added to the keep set of every run, as is
 *      the earliest non-zero reading that `readPctHistory` actually uses.
 *
 * The one thing genuinely lost is a move that both began and ended INSIDE a single
 * compacted bucket without being that bucket's extreme — an intraday spike that had
 * reverted before the day closed, more than a fortnight ago. That is the price of
 * the policy, and it is stated here rather than discovered later.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Younger than this and a snapshot is never touched. */
export const FULL_RESOLUTION_MS = 14 * DAY;
/**
 * Younger than this and a snapshot is kept at daily grain. Comfortably more than
 * the 365 days the yearly chart and the yearly movers window ask for, so every
 * timeframe short of "all" is answered entirely out of daily-or-finer rows.
 */
export const DAILY_RESOLUTION_MS = 400 * DAY;

/**
 * How many rows one compaction pass will look at per tier.
 *
 * Compaction has to converge from two directions at once: a brand-new day ages out
 * of the full-resolution window every day, and a user who has been recording since
 * long before this policy existed has years of uncompacted rows behind that. Both
 * are served by reading the compactable region NEWEST-FIRST with a budget: the newly
 * aged-out bucket is always in the first page, and because compaction shrinks what
 * it touches, the same budget reaches further back on every subsequent run until the
 * backlog is gone. No cursor to persist, no migration, and a bounded cost per run.
 */
export const COMPACTION_ROW_BUDGET = 2_000;

/** Buckets per DELETE. Each one contributes at most three timestamps to the
 *  filter, so fifty is a comfortably short URL and a hundredth of the round trips. */
export const COMPACTION_BUCKETS_PER_DELETE = 50;

export interface RetentionRow { recorded_at: string; total_value: number | string | null }

export interface BucketPlan {
  key: string;
  startMs: number;
  endMs: number;
  /** The instants that survive. */
  keep: string[];
  /** Every instant the bucket holds, `keep` included. */
  instants: string[];
  /** How many of the bucket's rows the POLICY would remove. The number actually
   *  removed can be lower — see `pinnedInstants`, which outranks the policy. */
  drop: number;
}

/**
 * Which rows of each bucket survive. Pure: rows in, plan out, nothing read or
 * written, so the policy can be tested without a database.
 *
 * A day keeps its close. A month keeps its close, its high and its low — see the
 * note at the top of the file for why the two grains differ.
 *
 * `rows` must be ascending by `recorded_at` — the order every reader returns.
 */
export function planBuckets(rows: RetentionRow[], timeZone: string, unit: BucketUnit): BucketPlan[] {
  const buckets = new Map<string, RetentionRow[]>();
  for (const r of rows) {
    const key = localBucketKey(r.recorded_at, timeZone, unit);
    const list = buckets.get(key);
    if (list) list.push(r); else buckets.set(key, [r]);
  }

  const plans: BucketPlan[] = [];
  for (const [key, list] of buckets) {
    const { startMs, endMs } = localBucketRangeMs(key, timeZone, unit);
    // The close is the LAST reading of the bucket — the same row the chart's own
    // day-bucketing already picks, which is why compacting cannot move the line.
    const survivors = [list[list.length - 1]];
    if (unit === 'month') {
      let high = list[0], low = list[0];
      for (const r of list) {
        if (Number(r.total_value) > Number(high.total_value)) high = r;
        if (Number(r.total_value) < Number(low.total_value)) low = r;
      }
      survivors.push(high, low);
    }
    const keep = Array.from(new Set(survivors.map(r => r.recorded_at)));
    plans.push({
      key, startMs, endMs, keep,
      instants: list.map(r => r.recorded_at),
      drop: list.length - keep.length,
    });
  }
  plans.sort((a, b) => a.startMs - b.startMs);
  return plans;
}

/** PostgREST's `in` list, with every value quoted — timestamps carry colons. */
function inList(values: string[]): string {
  return `(${values.map(v => `"${v}"`).join(',')})`;
}

export interface TierResult { unit: BucketUnit; examined: number; buckets: number; dropped: number; }
export interface CompactionResult { userId: string; timezone: string; tiers: TierResult[]; dropped: number; }

/**
 * Compact one tier of one user's history.
 *
 * `fromMs`/`toMs` are the tier's half-open bounds and are ALIGNED TO BUCKET
 * BOUNDARIES by the caller, so no bucket ever spans two tiers and no bucket is ever
 * planned from a partial view of itself.
 */
async function compactTier(
  userId: string, timeZone: string, unit: BucketUnit,
  fromMs: number | undefined, toMs: number, pinned: string[],
): Promise<TierResult> {
  const { rows, truncated } = await readSnapshotHistory<{ recorded_at: string; total_value: number }>({
    table: 'net_worth_history',
    userId,
    columns: 'recorded_at, total_value',
    fromAt: fromMs == null ? undefined : new Date(fromMs).toISOString(),
    toAt: new Date(toMs).toISOString(),
    maxRows: COMPACTION_ROW_BUDGET,
  });

  let plans = planBuckets(rows, timeZone, unit);
  // A budget-limited read stops mid-history, and the oldest bucket it returned is
  // therefore only partly visible — its real high, low or (never) close may be in
  // the rows that were not read. Leave it for the next run, which will reach it
  // with room to spare once the buckets in front of it have collapsed.
  if (truncated && plans.length) plans = plans.slice(1);

  let dropped = 0;

  for (let i = 0; i < plans.length; i += COMPACTION_BUCKETS_PER_DELETE) {
    const chunk = plans.slice(i, i + COMPACTION_BUCKETS_PER_DELETE);
    const startIso = new Date(chunk[0].startMs).toISOString();
    const endIso = new Date(chunk[chunk.length - 1].endMs).toISOString();
    const keep = new Set<string>();
    for (const p of chunk) for (const k of p.keep) keep.add(k);
    // The first-ever reading is the 0% reference for every percentage on the page.
    // Compared as INSTANTS, never as strings: Postgres hands a timestamp back in
    // its own format ("…T00:00:00+00:00"), which sorts differently from the ISO
    // this file writes ("…T00:00:00.000Z") while naming the very same moment.
    for (const p of pinned) {
      const at = Date.parse(p);
      if (at >= chunk[0].startMs && at < chunk[chunk.length - 1].endMs) keep.add(p);
    }
    const keepList = inList(Array.from(keep));
    // What will REALLY go, which is not the same as what the policy proposed: a
    // pinned reading stays whatever its bucket says. Counting the policy's number
    // here instead left the bucket holding the first-ever snapshot reporting one
    // droppable row on every run forever, deleting nothing and never converging.
    const toDrop = chunk.reduce(
      (n, p) => n + p.instants.filter(i => !keep.has(i)).length, 0);

    // Nothing to drop in the totals: the chunk is already compacted. Before moving
    // on, check the ITEM table — a run that died between the two deletes below
    // leaves item rows whose total is gone, and this is what heals them.
    if (toDrop === 0 && !(await hasStrayItems(userId, startIso, endIso, keepList))) continue;

    // ── TOTALS FIRST, THEN THE ITEMS ─────────────────────────────────────────
    // The mirror image of the write path's ordering, for the same reason. Removing
    // the total UN-COMMITS the snapshot; if the process dies before the items go,
    // what is left behind is item rows with no total, which no chart reads and the
    // next run sweeps up. Removing the items first would leave the opposite — a
    // total on the chart with no breakdown under it — permanently.
    const { error: totalErr } = await supabase
      .from('net_worth_history').delete()
      .eq('user_id', userId)
      .gte('recorded_at', startIso).lt('recorded_at', endIso)
      .not('recorded_at', 'in', keepList);
    if (totalErr) {
      console.error('[NW COMPACT] totals delete failed, items left intact:', totalErr.message);
      continue;
    }

    const { error: itemErr } = await supabase
      .from('net_worth_item_history').delete()
      .eq('user_id', userId)
      .gte('recorded_at', startIso).lt('recorded_at', endIso)
      .not('recorded_at', 'in', keepList);
    if (itemErr) console.error('[NW COMPACT] item delete failed (healed on the next run):', itemErr.message);

    dropped += toDrop;
  }

  return { unit, examined: rows.length, buckets: plans.length, dropped };
}

/** Item rows in a range whose snapshot has already been compacted away. */
async function hasStrayItems(userId: string, startIso: string, endIso: string, keepList: string): Promise<boolean> {
  const { data } = await supabase
    .from('net_worth_item_history')
    .select('recorded_at')
    .eq('user_id', userId)
    .gte('recorded_at', startIso).lt('recorded_at', endIso)
    .not('recorded_at', 'in', keepList)
    .limit(1);
  return (data ?? []).length > 0;
}

/**
 * The readings that must outlive every retention rule: the first one ever recorded,
 * and the first non-zero one — which is the divisor behind every percentage the
 * Overview prints (see `readPctHistory`). Compacting either of them away would
 * change what "since you started tracking" means without changing a single value.
 */
async function pinnedInstants(userId: string): Promise<string[]> {
  const first = supabase
    .from('net_worth_history').select('recorded_at').eq('user_id', userId)
    .order('recorded_at', { ascending: true }).limit(1);
  const firstNonZero = supabase
    .from('net_worth_history').select('recorded_at').eq('user_id', userId)
    .neq('total_value', 0)
    .order('recorded_at', { ascending: true }).limit(1);
  const [a, b] = await Promise.all([first, firstNonZero]);
  const out: string[] = [];
  for (const res of [a, b]) {
    const at = (res.data as { recorded_at?: string }[] | null)?.[0]?.recorded_at;
    if (at) out.push(at);
  }
  return Array.from(new Set(out));
}

/**
 * Bring one user's history back within the retention policy. Safe to run as often
 * as the cron likes: it is idempotent, bounded, and does nothing at all once the
 * history it can see is already compacted.
 */
export async function compactNetWorthHistory(userId: string, nowMs = Date.now()): Promise<CompactionResult> {
  const timeZone = await userTimezone(userId);

  // Cutoffs land on bucket boundaries so a bucket is never split across two tiers:
  // the day containing "14 days ago" stays whole in the full-resolution tier until
  // it has passed entirely, and likewise for the month at 400 days.
  const dayCutoff = floorToBucketMs(nowMs - FULL_RESOLUTION_MS, timeZone, 'day');
  const monthCutoff = floorToBucketMs(nowMs - DAILY_RESOLUTION_MS, timeZone, 'month');

  const tiers: TierResult[] = [];
  // Oldest tier first: rows beyond 400 days are compacted straight to months rather
  // than being taken to days by the tier above and re-read again next run.
  const pinned = await pinnedInstants(userId);
  tiers.push(await compactTier(userId, timeZone, 'month', undefined, monthCutoff, pinned));
  tiers.push(await compactTier(userId, timeZone, 'day', monthCutoff, dayCutoff, pinned));

  const dropped = tiers.reduce((n, t) => n + t.dropped, 0);
  if (dropped) {
    console.log(`[NW COMPACT] ${userId}: ${dropped} row(s) compacted away (${timeZone})`);
  }
  return { userId, timezone: timeZone, tiers, dropped };
}

/** Compact every user's history. Called from the hourly cron, after the snapshot. */
export async function compactAllNetWorthHistory(nowMs = Date.now()): Promise<number> {
  const { data: users } = await supabase.from('users').select('id');
  let dropped = 0;
  for (const u of users ?? []) {
    try {
      const res = await compactNetWorthHistory(u.id as string, nowMs);
      dropped += res.dropped;
    } catch (err) {
      console.error('[NW COMPACT] failed for user:', err);
    }
  }
  return dropped;
}
