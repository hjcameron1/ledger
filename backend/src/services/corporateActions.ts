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
 * 4. A SPIN-OFF IS NOT A SPLIT, though the feed serves it in the same field,
 *    with the same keys, and no flag to tell them apart. Yahoo reports GE's 2023
 *    HealthCare separation as "1281:1000" and its 2024 Vernova separation as
 *    "1253:1000" — price-adjustment factors, because value left the company, not
 *    shares arriving in anybody's account. Applying them would have inflated a
 *    GE holding by 28% and then another 25%.
 *
 *    So the ratio is all there is to go on, and it does not always say. There
 *    are THREE answers, not two — see `classifyCorporateAction`:
 *
 *      • SPLIT   — a ratio a company could have announced: a whole number of
 *        shares on each side, both counts small. Applied automatically.
 *      • IGNORE  — a ratio of exactly one, which moves nothing whatever it
 *        marks, or a number that is not a ratio at all.
 *      • REVIEW  — everything else: a many-figure decimal that is far more
 *        likely a price factor, or an announced ratio too unusual to be sure of.
 *        Ledger does NOT touch the unit count, and does not swallow the event
 *        either — it records it against the holding and asks. Because the third
 *        answer used to be "ignore it quietly", and quietly ignoring ASML's real
 *        77-for-100 consolidation left that holding 30% overstated with nothing
 *        on the screen to say why.
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

/** What Ledger may do about a corporate action the feed reported. */
export type CorporateActionKind =
  /** A share count. Apply it. */
  | 'split'
  /** Moves nothing at all. Say nothing. */
  | 'ignore'
  /** Might be either. Touch no units; ask the holder. */
  | 'review';

/** One corporate action, as the feed reported it. */
export interface DetectedSplit {
  /** Effective date, in the exchange's own local calendar. */
  date: string;
  numerator: number;
  denominator: number;
  /** New units per old unit: 4 for a 4:1 split, 0.1 for a 1-for-10 reverse. */
  ratio: number;
  /** What Ledger will do about it. */
  kind: CorporateActionKind;
}

/**
 * A corporate action Ledger declined to apply, held against the holding until
 * its owner says what really happened. Stored as JSON on `investments`, so it
 * reaches every device in the same bootstrap the unit count does.
 */
export interface PendingCorporateAction {
  /** The id the split WOULD be recorded under — derived, so re-seeing it is a no-op. */
  id: string;
  date: string;
  numerator: number;
  denominator: number;
  ratio: number;
  seen_at: string;
  /** Set once the holder has answered. Kept, so the answer is not asked for twice. */
  resolved?: 'applied' | 'ignored' | null;
  resolved_at?: string | null;
}

export interface SplitSyncResult {
  /** Holdings that were eligible and had not been checked today. */
  checked: number;
  /** Splits actually applied to a unit count. */
  applied: number;
  /** Feed events that were not share splits (spin-off factors and the like). */
  ignored: number;
  /** Events Ledger would not classify, recorded against the holding to be asked about. */
  review: number;
  /** Holdings seen for the first time — watermarked, nothing applied. */
  firstSeen: number;
}

/** How far back a re-check looks, to finish a split whose record never landed. */
const HEAL_WINDOW_DAYS = 7;

/**
 * The largest count of shares either side of an announced ratio.
 *
 * A split is announced as whole shares for whole shares — "eleven new for every
 * ten held", "six new for every eleven" — and the counts are small, because
 * somebody has to be able to say them. A price factor is a ratio of MONEY, so it
 * arrives with as many figures as the arithmetic produced: 1281:1000, 41:40,
 * 1748175:1000000. Eleven is where the two sets stop touching in 143 real events
 * off four decades and five regions: the largest announced term among them is
 * Vodafone's 6-for-11, and the smallest price factor that reduces to whole
 * numbers at all is GE's Wabtec 104:100, which is 26:25.
 *
 * The margin between 11 and 26 is the whole safety story, so it is stated here
 * and measured in `corporateActionsRealWorld.test.ts` rather than assumed.
 */
const ANNOUNCED_TERM_MAX = 11;

const day = (iso: string): string => iso.slice(0, 10);
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * The ratio as the exact fraction the feed wrote down, in lowest terms.
 *
 * The same event arrives in more than one shape. Yahoo serves Keyence's
 * one-for-ten bonus issue as "11:10" in 2006 and 2009 and as "1.1:1" in 2012 —
 * the same corporate action, and the old integer-only guard read the third one
 * as unusable and dropped a real 10% rise in the share count.
 *
 * So a decimal is scaled up until both sides are whole, and NOTHING is rounded
 * to get there. That distinction is the safety: 1.1 becomes exactly 11:10, and
 * Origin's demerger factor of 1.6667 becomes exactly 16667:10000 — not the 5:3
 * it is within two thousandths of. Approximating would have turned a demerger
 * into a five-for-three split and inflated that holding by two thirds.
 */
export function rationaliseRatio(
  numerator: number,
  denominator: number,
): { n: number; d: number } | null {
  let n = numerator, d = denominator;
  if (!Number.isFinite(n) || !Number.isFinite(d)) return null;
  if (n <= 0 || d <= 0) return null;
  // Nine decimal places is past anything the feed serves and well inside the
  // range where an integer is still exact.
  for (let k = 0; k < 9 && (!Number.isInteger(n) || !Number.isInteger(d)); k++) {
    n = Number((n * 10).toPrecision(15));
    d = Number((d * 10).toPrecision(15));
  }
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) return null;
  const g = gcd(Math.max(n, d), Math.min(n, d));
  return { n: n / g, d: d / g };
}

/**
 * What Ledger should do about one feed event — and, when it does not know, that
 * it does not know.
 *
 * There used to be two answers and the wrong one was silent. A ratio that did
 * not look like a split was logged on the server and dropped, which is correct
 * for a spin-off factor and quietly destructive for a real consolidation: the
 * feed's price falls by the ratio, the unit count does not rise to meet it, and
 * the holding sits at the wrong value for ever with nothing on any screen to
 * say so. Vodafone's 6-for-11 of February 2014 left a holding 83% overstated
 * exactly that way.
 *
 *   • SPLIT  — one side reduces to 1 (n-for-1, 1-for-n), or both sides are
 *     small whole counts of shares. Applied.
 *   • IGNORE — a ratio of exactly one, which is a marker rather than an event,
 *     or a pair of numbers that is not a ratio at all. Nothing to do and
 *     nothing to say.
 *   • REVIEW — anything else. Almost always a price factor, occasionally a real
 *     announcement in an awkward ratio, and the feed carries nothing that tells
 *     them apart. The unit count is not touched either way; the event is
 *     recorded against the holding and its owner is asked.
 */
export function classifyCorporateAction(
  numerator: number,
  denominator: number,
): CorporateActionKind {
  const r = rationaliseRatio(numerator, denominator);
  if (!r) return 'ignore';
  if (r.n === r.d) return 'ignore';                       // moves nothing
  if (r.n === 1 || r.d === 1) return 'split';             // n-for-1, or 1-for-n
  if (Math.max(r.n, r.d) <= ANNOUNCED_TERM_MAX) return 'split';
  return 'review';
}

/** Whether a feed event is a share split Ledger will apply on its own. */
export function isShareSplit(numerator: number, denominator: number): boolean {
  return classifyCorporateAction(numerator, denominator) === 'split';
}

/**
 * New units per old unit. 4 for 4:1; 0.1 for 1-for-10.
 *
 * Twelve places, not eight, and the reason is 6-for-11. Eleven shares becoming
 * six is 0.545454…, and rounded to eight places it is 0.54545455 — a hair HIGH.
 * The holding is scaled by the terms and lands on exactly 2,400 units, but the
 * parcel book is scaled by this number, and 4,400 × 0.54545455 is 2,400.00002.
 * The book and the holding then disagree, which is how a full sale leaves a
 * phantom fraction behind and a disposal is costed against units nobody holds.
 * Twelve places is inside a double's exactness and rounds back to the same
 * answer the terms give.
 */
export function splitRatio(numerator: number, denominator: number): number {
  return parseFloat((numerator / denominator).toFixed(12));
}

/**
 * The calendar date an instant falls on AT THE EXCHANGE.
 *
 * The feed stamps an event at the moment its market opened, not at midnight, and
 * that instant belongs to the exchange's own day. Yahoo puts ASX events at 23:00
 * UTC — 10:00 the NEXT morning in Sydney — so reading the epoch as a UTC date
 * dated eight of the ASX events in the sample a day early, Wesfarmers' 2:1
 * among them. That date is not cosmetic: it becomes the split's `recorded_at`,
 * and the CGT engine scales the parcels written down before that instant.
 *
 * The zone comes from the payload's own `exchangeTimezoneName`, so no table of
 * markets can fall out of step with the feed. UTC when it is absent — which is
 * what the old behaviour was, so a missing field loses nothing.
 */
export function exchangeDay(epochSeconds: number, timeZone?: string | null): string {
  const at = new Date(epochSeconds * 1000);
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD, which is the shape the whole file uses.
      return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(at);
    } catch {
      // An unknown zone name is not worth failing a split over.
    }
  }
  return at.toISOString().slice(0, 10);
}

/**
 * The corporate actions in a Yahoo v8 chart body, oldest first, each already
 * classified. A pure parser, so the shapes the feed really returns can be
 * tested without the network.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSplitEvents(body: any): DetectedSplit[] {
  const result = body?.chart?.result?.[0];
  const events = result?.events?.splits;
  if (!events || typeof events !== 'object') return [];
  const tz = typeof result?.meta?.exchangeTimezoneName === 'string'
    ? result.meta.exchangeTimezoneName
    : null;
  const out: DetectedSplit[] = [];
  for (const raw of Object.values(events as Record<string, unknown>)) {
    const ev = raw as { date?: unknown; numerator?: unknown; denominator?: unknown };
    const at = Number(ev.date);
    const numerator = Number(ev.numerator);
    const denominator = Number(ev.denominator);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) continue;
    out.push({
      date: exchangeDay(at, tz),
      numerator, denominator,
      ratio: splitRatio(numerator, denominator),
      kind: classifyCorporateAction(numerator, denominator),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * What the feed said when asked about one symbol.
 *
 * "There were no corporate actions" and "the feed did not answer" must never be
 * the same value — one may advance the watermark and the other must not — and
 * "there is no such symbol any more" is a third thing again, because it is the
 * only one that will still be true tomorrow.
 */
export type FeedAnswer =
  | {
      ok: true;
      events: DetectedSplit[];
      /** The instrument the feed thinks it answered about, for the identity check. */
      currency: string | null;
      exchangeTimezone: string | null;
    }
  | { ok: false; reason: 'missing' | 'unavailable' };

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
): Promise<FeedAnswer> {
  const p1 = Math.floor(Date.parse(`${day(fromISO)}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${day(toISO)}T23:59:59Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${p1}&period2=${p2}&interval=1d&events=split`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    // 404 is the feed saying the symbol does not exist — a delisting, a merger,
    // a redomicile. Every other failure is a bad afternoon.
    if (!res.ok) return { ok: false, reason: res.status === 404 ? 'missing' : 'unavailable' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    const meta = body?.chart?.result?.[0]?.meta;
    return {
      ok: true,
      events: parseSplitEvents(body),
      currency: typeof meta?.currency === 'string' ? meta.currency : null,
      exchangeTimezone: typeof meta?.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : null,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
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
  /** The currency the holding is quoted in — half of the instrument-identity check. */
  native_currency?: string | null;
}

/** The migration has not been run — say so once per process, not per holding. */
let warnedMissingColumn = false;
/** The review column is a separate migration and fails separately. */
let warnedMissingReviewColumn = false;
/** Symbols the feed has no record of — said once each, not once a day for ever. */
const reportedMissingSymbols = new Set<string>();

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
 * Sterling is quoted in pence and stored in pounds; a few other markets do the
 * same trick. Comparing the minor unit to the major one would refuse every
 * London holding, so both fold to the major currency before they are compared.
 */
function majorCurrency(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  return c ? c.toUpperCase() : null;
}

/**
 * Whether the feed answered about the instrument this holding actually is.
 *
 * The request is a STRING, and a string outlives the company that used it.
 * Tickers are recycled: a delisting frees one, and the next listing to want it
 * gets it. Nothing in the old code noticed — whatever the feed said about the
 * letters was applied to the holding, so a reused symbol's 10:1 would have
 * multiplied somebody's units in a company that never split.
 *
 * The feed states the currency it is quoting in. It is not an instrument id and
 * it will not catch a reuse within the same market and currency, but it does
 * catch the reuses that move a holding's value — a London holding whose symbol
 * now belongs to a US listing, and the like. Unknown on either side is not
 * evidence of a mismatch, so it does not refuse.
 */
function sameInstrument(inv: SplitCandidate, answer: { currency: string | null }): boolean {
  const held = majorCurrency(inv.native_currency);
  const feed = majorCurrency(answer.currency);
  if (!held || !feed) return true;
  return held === feed;
}

/**
 * Hold an event Ledger will not classify against the holding, so its owner can
 * say what really happened.
 *
 * The id is the one the split WOULD have been recorded under — derived from the
 * holding, the date and the ratio — so the same event seen again on the next
 * run, on another device or in the heal window matches the entry already there
 * and changes nothing. An answered entry is KEPT, marked with the answer, for
 * the same reason: the question must not come back a week later.
 *
 * Returns whether a NEW question was recorded.
 */
async function recordForReview(inv: SplitCandidate, ev: DetectedSplit): Promise<boolean> {
  const id = splitRecordId(inv.id, ev.date, ev.ratio);

  const { data, error } = await supabase
    .from('investments')
    .select('pending_corporate_actions')
    .eq('id', inv.id)
    .maybeSingle();
  if (isUnknownColumn(error)) {
    // Said once per process, not once per holding — but never latched, because a
    // migration can be run while this server is up and the next check must find
    // the column there.
    if (!warnedMissingReviewColumn) {
      warnedMissingReviewColumn = true;
      console.warn('[SPLITS] investments.pending_corporate_actions is not migrated — unclassified corporate actions cannot be raised');
    }
    return false;
  }
  if (error) {
    console.error('[SPLITS] could not read pending corporate actions:', error.message);
    return false;
  }

  const raw = (data as { pending_corporate_actions?: unknown } | null)?.pending_corporate_actions;
  const pending: PendingCorporateAction[] = Array.isArray(raw) ? (raw as PendingCorporateAction[]) : [];
  if (pending.some(p => p?.id === id)) return false;         // already asked, or already answered

  // The holder may have dealt with it before Ledger ever saw it — a unit count
  // they corrected themselves is in the parcel book, and that is an answer.
  if (await alreadyAccountedFor(inv, ev)) return false;

  const next = [...pending, {
    id,
    date: ev.date,
    numerator: ev.numerator,
    denominator: ev.denominator,
    ratio: ev.ratio,
    seen_at: new Date().toISOString(),
    resolved: null,
    resolved_at: null,
  } satisfies PendingCorporateAction];

  const { error: writeError } = await supabase
    .from('investments')
    .update({ pending_corporate_actions: next })
    .eq('id', inv.id);
  if (writeError) {
    console.error('[SPLITS] could not raise a corporate action for review:', writeError.message);
    return false;
  }
  console.log(
    `[SPLITS] ${inv.ticker ?? inv.id} ${ev.numerator}:${ev.denominator} on ${ev.date} could not be classified `
    + '— units left alone, raised for the holder to answer',
  );
  return true;
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

  // Multiply by the ratio's TERMS, not by the decimal it rounds to. Eleven
  // shares becoming six is 1100 × 6 ÷ 11 = 600 exactly, where 1100 × 0.54545455
  // is 600.000005 — five millionths of a share conjured out of a rounding, on
  // every consolidation whose ratio does not divide evenly.
  const terms = rationaliseRatio(split.numerator, split.denominator);
  const scale = (x: number, up: number, down: number) => parseFloat(((x * up) / down).toFixed(8));
  const newUnits = terms
    ? scale(units, terms.n, terms.d)
    : parseFloat((units * split.ratio).toFixed(8));
  // Price moves the other way by the same ratio, in the same write, so units ×
  // price — the holding's whole worth — does not change for an instant.
  const newPrice = Number.isFinite(price) && price > 0
    ? (terms ? scale(price, terms.d, terms.n) : parseFloat((price / split.ratio).toFixed(8)))
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
  const out: SplitSyncResult = { checked: 0, applied: 0, ignored: 0, review: 0, firstSeen: 0 };

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
    const symbol = resolveSymbol(String(inv.ticker), String(inv.market ?? ''));
    const answer = await fetchSplits(symbol, addDays(watermark, -HEAL_WINDOW_DAYS), today);
    if (!answer.ok) {
      // The watermark stays exactly where it was, so the same window is asked
      // for again — including for a symbol the feed has never heard of, because
      // a suspension ends and a ticker can be corrected. What changed is that it
      // is no longer silent: a dead symbol says so once, and keeps quiet after.
      if (answer.reason === 'missing' && !reportedMissingSymbols.has(symbol)) {
        reportedMissingSymbols.add(symbol);
        console.warn(
          `[SPLITS] the feed has no symbol "${symbol}" (${inv.ticker} on ${inv.market}) — `
          + 'corporate actions cannot be checked for this holding until its ticker is corrected',
        );
      }
      continue;
    }

    // The feed answered about a string, not about an instrument. If the letters
    // now belong to something quoted in another currency, this is not the same
    // holding and none of its history may be applied.
    if (!sameInstrument(inv, answer)) {
      console.warn(
        `[SPLITS] "${symbol}" now quotes in ${answer.currency} but ${inv.ticker} is held in `
        + `${inv.native_currency} — the ticker looks reused, so nothing was applied`,
      );
      continue;
    }

    let deferred = false;
    for (const ev of answer.events) {
      if (ev.kind === 'ignore') {
        // A ratio of one, or a pair of numbers that is not a ratio. Moves nothing.
        if (ev.date > watermark) out.ignored += 1;
        continue;
      }
      if (ev.kind === 'review') {
        // Might be a price factor, might be an announcement in an awkward ratio.
        // The unit count is not touched either way — but the event is not
        // swallowed either. It is held against the holding and its owner asked.
        if (ev.date > watermark && await recordForReview(inv, ev)) out.review += 1;
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

  if (out.applied || out.ignored || out.review) {
    console.log(
      `[SPLITS] ${out.checked} checked, ${out.applied} applied, ${out.ignored} ignored, `
      + `${out.review} raised for review`,
    );
  }
  return out;
}
