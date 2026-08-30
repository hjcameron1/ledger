/**
 * CORPORATE ACTIONS — splits and consolidations, applied automatically.
 *
 * A share split changes how many units you hold and nothing else. The company
 * is worth what it was worth, you own what you owned, and the price per share
 * moves by exactly the ratio the unit count moves by. Which means the feed does
 * half the job on its own — Apple's quote went from $499.23 to $129.04 on
 * 31 August 2020 — and if nothing does the other half, a holding's value falls
 * by three quarters with no sale and no market move. That drop is then recorded
 * in the net-worth history, reported by the movers as the day's biggest loser,
 * and carried until somebody notices.
 *
 * ─── THE RULES, IN THE ORDER THEY MATTER ────────────────────────────────────
 *
 * 1. UNITS MOVE. COST NEVER DOES. 400 shares that cost $69,320 become 1,600
 *    shares that cost $69,320. The parcel book records the split as an EVENT
 *    rather than rewriting the parcels, so every acquisition keeps its own date
 *    and its own money — which is what the CGT discount is decided on.
 *
 * 2. NOTHING IS EVER APPLIED TWICE. Four separate guards, because this one
 *    mistake silently multiplies somebody's net worth — a 4:1 applied twice is
 *    sixteen times the shares, and nothing on the screen contradicts it:
 *      • a per-holding WATERMARK (`split_checked_through`) that only moves
 *        forward, and the update that moves it is a compare-and-set — two
 *        processes racing on the same split, one wins and one is refused;
 *      • the same update requires the unit count to be the one we read, so a
 *        user's edit landing mid-flight is never overwritten, only deferred —
 *        and a deferred split holds the watermark back, so it is retried rather
 *        than skipped;
 *      • the PARCEL BOOK is consulted first: a split of this ratio around this
 *        date, recorded by anyone — the user, another device, an earlier run —
 *        means the units already reflect it and must not be touched;
 *      • the `cgt_splits` row is written under an id DERIVED from the holding,
 *        the date and the ratio, so it is the same id on every device and in
 *        every process, and an upsert of it can only ever land once.
 *
 * 3. NOTHING IS APPLIED RETROSPECTIVELY. The first time a holding is seen the
 *    watermark is set to today and no split is applied, whatever history the
 *    feed reports. A unit count the user typed in is already post-split — it
 *    came off their broker's statement — and "correcting" it would be the
 *    double-application this whole file exists to prevent. Ledger adjusts for
 *    splits that happen while it is watching, and says so.
 *
 * 4. A SPIN-OFF IS NOT A SPLIT, though the feed serves it in the same field.
 *    Yahoo reports GE's 2023 HealthCare separation as "1281:1000" and its 2024
 *    Vernova separation as "1253:1000" — price-adjustment factors, because value
 *    left the company, not shares arriving in anybody's account. Applying them
 *    would have inflated a GE holding by 28% and then another 25%. Only ratios
 *    that are real splits are acted on — see `isShareSplit` — and the rest are
 *    logged and left alone, because doing nothing to the units is the correct
 *    answer for a spin-off.
 *
 * 5. REVERSE SPLITS ARE THE SAME EVENT WITH A RATIO BELOW ONE. Sirius XM's
 *    1-for-10 on 10 September 2024 comes back as numerator 1, denominator 10;
 *    General Electric's 1-for-8 on 2 August 2021 as 1 and 8. Units are
 *    multiplied by 0.1 and 0.125, cost is untouched, and the fractional unit
 *    that leaves behind is KEPT. A broker pays cash in lieu of it; Ledger does
 *    not invent that payment, because inventing a deposit that never appears in
 *    the bank feed is worse than a holding that is 0.4 units generous.
 *
 * WHAT STAYS CONTINUOUS. `current_price` is divided by the same ratio the units
 * are multiplied by, in the same write, so units × price is unchanged and a
 * net-worth snapshot taken in the seconds between the split and the next quote
 * records no jump. Cost is untouched, so profit and loss is unchanged. The
 * parcels keep their dates, so the CGT discount is unchanged. Nothing about the
 * holding's worth moves — only the number of pieces it is divided into.
 *
 * ACROSS DEVICES. Both halves are server-side and both are synced: the unit
 * count is on the holding, which every device replaces from the server on
 * bootstrap, and the split is a `cgt_splits` row, which every device adopts
 * whole. A phone that was offline through the split gets both when it next
 * opens, in one bootstrap, and never sees a moment where one arrived without
 * the other.
 */
import { createHash } from 'crypto';
import { supabase } from '../utils/supabase';
import { MARKET_SUFFIX } from './marketSymbols';

/** One split, as the feed reported it. */
export interface DetectedSplit {
  /** Effective date, the exchange's own local date. */
  date: string;
  numerator: number;
  denominator: number;
  /** New units per old unit: 4 for a 4:1 split, 0.1 for a 1-for-10 reverse. */
  ratio: number;
}

export interface SplitSyncResult {
  /** Holdings that were eligible and had not been checked today. */
  checked: number;
  /** Splits actually applied to a unit count. */
  applied: number;
  /** Feed events that were not share splits (spin-off factors and the like). */
  ignored: number;
  /** Holdings seen for the first time — watermarked, nothing applied. */
  firstSeen: number;
}

/** How far back a re-check looks, to finish a split whose record never landed. */
const HEAL_WINDOW_DAYS = 7;

/** The largest whole-number side a real split ratio is stated with. */
const MAX_SPLIT_TERM = 10;

const day = (iso: string): string => iso.slice(0, 10);
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Whether a feed event is a share split rather than a price-adjustment factor.
 *
 * Real splits are announced in small whole numbers: 2:1, 3:1, 4:1, 5:1, 10:1,
 * 20:1, 3:2, and their reverses 1:5, 1:8, 1:10, 1:20. A spin-off's factor is a
 * fraction nobody would announce — 1281:1000, 1253:1000, 104:100 — because it
 * is a ratio of prices, not a count of shares. Reduced, a real split has a 1 on
 * one side or two single-digit terms; a spin-off factor has neither.
 *
 * Erring towards ignoring is deliberate. A split not applied leaves a holding
 * visibly wrong — the value falls by the ratio and the user can see it and fix
 * it. A spin-off applied as a split leaves a holding invisibly wrong, inflated
 * by a plausible-looking percentage that nothing on the screen contradicts.
 */
export function isShareSplit(numerator: number, denominator: number): boolean {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return false;
  if (numerator <= 0 || denominator <= 0) return false;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return false;
  if (numerator === denominator) return false;          // moves nothing
  const g = gcd(Math.max(numerator, denominator), Math.min(numerator, denominator));
  const n = numerator / g, d = denominator / g;
  if (n === 1 || d === 1) return true;                  // n-for-1, or 1-for-n
  return n <= MAX_SPLIT_TERM && d <= MAX_SPLIT_TERM;    // 3:2 and its kin
}

/** New units per old unit. 4 for 4:1; 0.1 for 1-for-10. */
export function splitRatio(numerator: number, denominator: number): number {
  return parseFloat((numerator / denominator).toFixed(8));
}

/**
 * The splits in a Yahoo v8 chart body, oldest first. A pure parser, so the
 * shapes the feed really returns can be tested without the network.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSplitEvents(body: any): DetectedSplit[] {
  const events = body?.chart?.result?.[0]?.events?.splits;
  if (!events || typeof events !== 'object') return [];
  const out: DetectedSplit[] = [];
  for (const raw of Object.values(events as Record<string, unknown>)) {
    const ev = raw as { date?: unknown; numerator?: unknown; denominator?: unknown };
    const at = Number(ev.date);
    const numerator = Number(ev.numerator);
    const denominator = Number(ev.denominator);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) continue;
    out.push({
      date: new Date(at * 1000).toISOString().slice(0, 10),
      numerator, denominator,
      ratio: splitRatio(numerator, denominator),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Splits for one symbol between two dates. Uses the v8 chart endpoint directly:
 * it needs no cookie-and-crumb handshake, which is the whole reason the quote
 * path has a second door (see services/yahooChart). Null on any failure —
 * never an empty list, because "the feed did not answer" and "there were no
 * splits" must not advance the watermark alike.
 */
export async function fetchSplits(
  symbol: string,
  fromISO: string,
  toISO: string,
): Promise<DetectedSplit[] | null> {
  const p1 = Math.floor(Date.parse(`${day(fromISO)}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${day(toISO)}T23:59:59Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${p1}&period2=${p2}&interval=1d&events=split`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseSplitEvents(await res.json());
  } catch {
    return null;
  }
}

/**
 * The id a split is recorded under — derived from the holding, the effective
 * date and the ratio, never minted. Two processes, two devices and two years
 * apart all compute the same one, so the row can only exist once however many
 * times the split is seen. Shaped as a v5 UUID because the column is a UUID.
 */
export function splitRecordId(investmentId: string, date: string, ratio: number): string {
  const h = createHash('sha1')
    .update(`ledger:split:${investmentId}:${date}:${ratio.toFixed(8)}`)
    .digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8), h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/**
 * `recorded_at` for the split's parcel-book entry: midnight on the effective
 * date. The CGT engine scales whatever was written down BEFORE this instant, so
 * a parcel for a purchase made on or after the split — already in new units —
 * is correctly left alone, and everything bought before it is scaled.
 */
export function splitRecordedAt(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** Asset types that are not units of a listed security and never split. */
const NON_SPLITTING_TYPES = new Set([
  'cash', 'crypto', 'precious_metal', 'art', 'wine', 'jewellery', 'bond',
  'managed_fund', 'private', 'other',
]);

/**
 * Whether a holding is the kind of thing that can split: units of a security on
 * an exchange the feed reports corporate actions for.
 */
export function isSplitEligible(market: string | null | undefined, assetType: string | null | undefined): boolean {
  const m = String(market ?? '');
  const listed = m === 'NYSE' || m === 'NASDAQ' || m in MARKET_SUFFIX;
  return listed && !NON_SPLITTING_TYPES.has(String(assetType ?? '').toLowerCase());
}

export interface SplitCandidate {
  id: string;
  user_id: string;
  name?: string | null;
  ticker?: string | null;
  market?: string | null;
  asset_type?: string | null;
  shares_owned?: number | null;
  current_price?: number | null;
}

/** The migration has not been run — say so once per process, not per holding. */
let warnedMissingColumn = false;

function isUnknownColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? '');
  return error.code === '42703' || /column .* does not exist/i.test(msg);
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? '');
  return error.code === '42P01' || /relation .* does not exist/i.test(msg);
}

/**
 * Make sure the parcel book carries this split. Idempotent by construction: the
 * id is derived, so an upsert either writes the row or rewrites it identically.
 * Run for splits already applied too, so a record that failed to land after the
 * units moved is repaired on the next check rather than being lost.
 */
async function recordSplitInBook(
  inv: SplitCandidate,
  split: DetectedSplit,
): Promise<void> {
  const { error } = await supabase.from('cgt_splits').upsert({
    id: splitRecordId(inv.id, split.date, split.ratio),
    user_id: inv.user_id,
    investment_id: inv.id,
    label: inv.name ?? inv.ticker ?? 'Holding',
    ticker: inv.ticker ? String(inv.ticker).toUpperCase() : null,
    ratio: split.ratio,
    recorded_at: splitRecordedAt(split.date),
  });
  if (error && !isMissingTable(error)) {
    console.error(`[SPLITS] could not record ${inv.ticker} ${split.ratio}× in the parcel book:`, error.message);
  }
}

/**
 * Whether this split has ALREADY been accounted for, by anyone.
 *
 * The dangerous case this exists for is a user who beats us to it. They see the
 * price halve, work out what happened, and double the unit count themselves —
 * which `investmentsDS.update` correctly reads as a split and writes into the
 * parcel book. If the refresh then applied the same split to the count they had
 * already doubled, the holding would be four times what they own. The watermark
 * cannot see that, because their edit is not a watermark; the book is where it
 * shows up.
 *
 * So before any unit count is touched, the book is asked whether this holding
 * already carries a split of this ratio around this date — from the user, from
 * another device, or from an earlier run of this very function. If it does, the
 * split is done: the watermark moves and the units are left exactly alone.
 *
 * The date window is generous (a fortnight either side) and the ratio is matched
 * within a tenth of a percent, because a hand-recorded split carries the day it
 * was NOTICED and a unit count divided by hand does not land on a round number.
 * Being generous errs towards not applying, which is the direction that leaves a
 * visible, correctable holding rather than a silently inflated one.
 */
const ACCOUNTED_WINDOW_DAYS = 14;

async function alreadyAccountedFor(inv: SplitCandidate, split: DetectedSplit): Promise<boolean> {
  const { data, error } = await supabase
    .from('cgt_splits')
    .select('id, ratio, recorded_at')
    .eq('investment_id', inv.id);
  // No book to consult (not migrated, or the read failed) is not evidence that
  // nothing is recorded — decline rather than guess.
  if (isMissingTable(error)) return false;
  if (error) {
    console.error('[SPLITS] could not read the parcel book; not applying:', error.message);
    return true;
  }
  const from = addDays(split.date, -ACCOUNTED_WINDOW_DAYS);
  const to = addDays(split.date, ACCOUNTED_WINDOW_DAYS);
  return (data ?? []).some(row => {
    const r = Number((row as { ratio: unknown }).ratio);
    if (!Number.isFinite(r) || Math.abs(r / split.ratio - 1) > 0.001) return false;
    const at = (row as { recorded_at?: string | null }).recorded_at;
    // A split with no stamp at all is still a split of this ratio on this
    // holding, and there is no second one to confuse it with.
    if (!at) return true;
    const d = day(at);
    return d >= from && d <= to;
  });
}

/**
 * Move one holding's watermark forward. A compare-and-set: it only lands if the
 * watermark is still where we read it, so the loser of a race writes nothing.
 */
async function advanceWatermark(inv: SplitCandidate, to: string): Promise<boolean> {
  const q = supabase.from('investments')
    .update({ split_checked_through: to })
    .eq('id', inv.id)
    .or(`split_checked_through.is.null,split_checked_through.lt.${to}`)
    .select('id');
  const { data, error } = await q;
  if (isUnknownColumn(error)) {
    if (!warnedMissingColumn) {
      warnedMissingColumn = true;
      console.warn('[SPLITS] investments.split_checked_through is not migrated — automatic split detection is off');
    }
    return false;
  }
  if (error) { console.error('[SPLITS] watermark write failed:', error.message); return false; }
  return (data?.length ?? 0) > 0;
}

/**
 * The three ways one split can end.
 *
 * The distinction that matters is `deferred` versus `settled`. Everything about
 * the write is conditional — the watermark must still be behind the split, and
 * the unit count must still be the one we read — and when a condition fails,
 * this split has NOT been dealt with. Letting the watermark run on to today
 * after a deferral would skip it silently and for ever, which is the quiet half
 * of the same bug double-application is the loud half of.
 */
type SplitOutcome = 'applied' | 'settled' | 'deferred';

async function applyOne(inv: SplitCandidate, split: DetectedSplit): Promise<SplitOutcome> {
  const units = Number(inv.shares_owned);
  const price = Number(inv.current_price);
  if (!Number.isFinite(units) || units <= 0) {
    // Nothing to multiply. Still watermark past it, or the holding is re-checked
    // against the same split every day for ever.
    await advanceWatermark(inv, split.date);
    return 'settled';
  }

  if (await alreadyAccountedFor(inv, split)) {
    console.log(`[SPLITS] ${inv.ticker ?? inv.id} ${split.numerator}:${split.denominator} on ${split.date} is already in the book — units left alone`);
    await advanceWatermark(inv, split.date);
    return 'settled';
  }

  const newUnits = parseFloat((units * split.ratio).toFixed(8));
  // Price moves the other way by the same ratio, in the same write, so units ×
  // price — the holding's whole worth — does not change for an instant.
  const newPrice = Number.isFinite(price) && price > 0
    ? parseFloat((price / split.ratio).toFixed(8))
    : price;

  const update: Record<string, unknown> = {
    shares_owned: newUnits,
    split_checked_through: split.date,
  };
  if (Number.isFinite(newPrice) && newPrice > 0) {
    update.current_price = newPrice;
    update.current_value = parseFloat((newUnits * newPrice).toFixed(2));
  }

  const { data, error } = await supabase.from('investments')
    .update(update)
    .eq('id', inv.id)
    .eq('shares_owned', units)
    .or(`split_checked_through.is.null,split_checked_through.lt.${split.date}`)
    .select('id');

  if (isUnknownColumn(error)) {
    if (!warnedMissingColumn) {
      warnedMissingColumn = true;
      console.warn('[SPLITS] investments.split_checked_through is not migrated — automatic split detection is off');
    }
    return 'deferred';
  }
  if (error) { console.error(`[SPLITS] ${inv.ticker} ${split.ratio}× failed:`, error.message); return 'deferred'; }
  // Somebody else got there first, or the units moved under us. Either way this
  // split is unfinished business: the watermark must not run past it.
  if ((data?.length ?? 0) === 0) return 'deferred';

  // The units have moved; the book must say why. Written second on purpose — if
  // this fails, the heal window brings us back to it, whereas a book entry
  // without the unit change would scale the parcels past the holding.
  await recordSplitInBook(inv, split);

  // The caller is mid-refresh with this row in hand; keep it truthful.
  inv.shares_owned = newUnits;
  if (update.current_price != null) inv.current_price = newPrice;
  console.log(`[SPLITS] ${inv.ticker ?? inv.id} ${split.numerator}:${split.denominator} on ${split.date} — ${units} → ${newUnits} units`);
  return 'applied';
}

/**
 * Every holding's watermark, in one read. Null — not an empty map — when the
 * column is not migrated, so the caller does nothing at all rather than
 * mistaking "no watermark anywhere" for "every holding is new".
 */
async function loadWatermarks(ids: string[]): Promise<Map<string, string | null> | null> {
  const { data, error } = await supabase
    .from('investments')
    .select('id, split_checked_through')
    .in('id', ids);
  if (isUnknownColumn(error)) {
    if (!warnedMissingColumn) {
      warnedMissingColumn = true;
      console.warn('[SPLITS] investments.split_checked_through is not migrated — automatic split detection is off');
    }
    return null;
  }
  if (error) { console.error('[SPLITS] could not read watermarks:', error.message); return null; }
  const out = new Map<string, string | null>();
  for (const row of data ?? []) {
    out.set(String((row as { id: string }).id), (row as { split_checked_through?: string | null }).split_checked_through ?? null);
  }
  return out;
}

/**
 * Check every eligible holding for splits and apply the ones that are real.
 *
 * Bounded: a holding is checked at most once a calendar day, so this costs one
 * request per holding per day however often the refresh runs, and nothing at
 * all for a holding already checked. Fail-soft per holding — one bad ticker
 * never stops the rest, and a feed that does not answer leaves the watermark
 * exactly where it was so the same window is asked for again next time.
 *
 * `holdings` is updated IN PLACE when a split lands, because the caller is
 * usually a price refresh that is about to write `shares_owned × price` and
 * would otherwise stamp a value built from the old unit count.
 */
export async function syncSplits(
  holdings: SplitCandidate[],
  resolveSymbol: (ticker: string, market: string) => string,
  nowISO: string = new Date().toISOString(),
): Promise<SplitSyncResult> {
  const today = day(nowISO);
  const out: SplitSyncResult = { checked: 0, applied: 0, ignored: 0, firstSeen: 0 };

  const eligible = holdings.filter(h => h.ticker && isSplitEligible(h.market, h.asset_type));
  if (eligible.length === 0) return out;

  // The watermarks are read in a query of their own, never as one more column on
  // the caller's select. Naming a column PostgREST does not have fails the WHOLE
  // statement, and the caller here is the price refresh: an un-run migration
  // would have stopped every quote in the app rather than only this feature.
  const watermarks = await loadWatermarks(eligible.map(h => h.id));
  if (!watermarks) return out;

  for (const inv of eligible) {
    const stamp = watermarks.get(inv.id);
    const watermark = stamp ? day(stamp) : null;

    // Rule 3: the first sighting only starts the clock. A unit count typed in
    // today already reflects every split that ever happened.
    if (!watermark) {
      if (await advanceWatermark(inv, today)) out.firstSeen += 1;
      continue;
    }
    if (watermark >= today) continue;   // already looked today
    out.checked += 1;

    // Reach back a week further than the watermark so a split whose book entry
    // never landed is repaired, without its units being touched a second time.
    const events = await fetchSplits(
      resolveSymbol(String(inv.ticker), String(inv.market ?? '')),
      addDays(watermark, -HEAL_WINDOW_DAYS),
      today,
    );
    if (events === null) continue;      // the feed did not answer; ask again later

    let deferred = false;
    for (const ev of events) {
      if (!isShareSplit(ev.numerator, ev.denominator)) {
        // A spin-off factor or something else that is not a share count.
        if (ev.date > watermark) {
          out.ignored += 1;
          console.log(
            `[SPLITS] ${inv.ticker} ${ev.numerator}:${ev.denominator} on ${ev.date} is not a share split `
            + '— price adjusted, unit count left alone',
          );
        }
        continue;
      }
      if (ev.date <= watermark) {
        // Already applied. Only make sure the parcel book agrees.
        await recordSplitInBook(inv, ev);
        continue;
      }
      const outcome = await applyOne(inv, ev);
      if (outcome === 'applied') out.applied += 1;
      if (outcome === 'deferred') { deferred = true; break; }
    }

    // Nothing left to find before today — unless a split was left unfinished, in
    // which case the window has to stay open so the next run sees it again.
    if (!deferred) await advanceWatermark(inv, today);
  }

  if (out.applied || out.ignored) {
    console.log(`[SPLITS] ${out.checked} checked, ${out.applied} applied, ${out.ignored} ignored`);
  }
  return out;
}
