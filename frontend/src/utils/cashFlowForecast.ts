/**
 * Phase 3.1 — Cash-flow forecast foundation (pure engine).
 *
 * ONE engine that projects the user's BANK-account cash balances 30 / 60 / 90
 * days forward from their known recurring inflows and outflows. It is a pure,
 * dependency-injected function (no localStorage, no network, `asOf` passed in)
 * so it is fully node-testable — mirroring the taxDeductions.ts / payroll.ts
 * "pure engine + thin DS wrapper" pattern used across this codebase.
 *
 * The DS layer (dataService.forecastDS) is responsible for GATHERING the raw
 * records — bank accounts, income, bills, subscriptions, recurring series,
 * loans and credit-card minimum payments — normalising each into a
 * `RecurringInput` (signed display-currency amount, a frequency, an anchor date,
 * an owning account, a confidence and any source links) and calling
 * `buildCashFlowForecast`. This module knows nothing about those record shapes;
 * it only understands the normalised input.
 *
 * ── Scope decisions (deliberate for the 3.1 foundation) ──────────────────────
 *  • Cash accounts only. We project BANK balances. A loan/credit-card *payment*
 *    is a cash outflow from a bank account and IS included; projecting the
 *    liability balance itself (debt paydown) is out of scope for 3.1.
 *  • Everything is in the user's DISPLAY currency — the DS converts before it
 *    reaches here, so the engine never does FX.
 *  • Amounts are SIGNED: +inflow, −outflow. We never infer direction from a
 *    record type; the DS sets the sign.
 *  • Account allocation: an input names the bank account its cash moves on.
 *    Inputs with no known account fall into a single `__unallocated__` bucket
 *    that still moves the household TOTAL but is not attributed to one account.
 *  • Transfers between the user's OWN accounts must not be double-counted. A
 *    transfer is EXCLUDED from the total-cash net (it does not change household
 *    cash); at the per-account level it debits its source account and credits
 *    the counterpart account when that account is known.
 *  • Duplicate recurring records (a bill mirrored from a loan or subscription; a
 *    detected series that is really a user-managed subscription/income) are
 *    de-duplicated so a single obligation is counted once. Nothing is deleted —
 *    the suppressed input and WHY it was suppressed are returned for audit, and
 *    each input's source links are preserved.
 */

export const UNALLOCATED = '__unallocated__';

/** How far apart a manual credit-card bill's due date and the card's own
 *  minimum-payment due date may be while still counting as the same payment.
 *  Kept small so only genuinely-aligned dates match. */
export const DUP_DUE_WINDOW_DAYS = 5;

export type ForecastFrequency =
  | 'once'
  | 'weekly'
  | 'fortnightly'
  | 'monthly'
  | 'quarterly'
  | 'annually';

export type ForecastSourceType =
  | 'income'
  | 'bill'
  | 'subscription'
  | 'recurring_series'
  | 'loan'
  | 'credit_card'
  // ── Phase 3.3: adaptive (learned from transaction history) ──────────────────
  /** A regular salary/pay deposit inferred from repeated inflows. */
  | 'learned_income'
  /** A category's typical variable spend, learned from recent history. */
  | 'learned_spend';

/** Explicit links back to the records a normalised input was derived from.
 *  Preserved unchanged through de-duplication so the UI can trace provenance. */
export interface ForecastSourceLinks {
  subscription_id?: string | null;
  loan_id?: string | null;
  recurring_series_id?: string | null;
}

/** One normalised recurring money movement fed into the forecast. */
export interface RecurringInput {
  id: string;
  sourceType: ForecastSourceType;
  name: string;
  /** SIGNED magnitude in display currency: +inflow, −outflow. */
  amount: number;
  frequency: ForecastFrequency;
  /** Next occurrence / due date, `YYYY-MM-DD`. For `once`, the single date. */
  anchorDate: string;
  /** Bank account this cash moves on; null → the unallocated bucket. */
  accountId: string | null;
  /** 0..1 estimate this movement will occur as described. Preserved on events. */
  confidence: number;
  /** Optional spending category (e.g. a bill's or subscription's category). The
   *  core projection IGNORES this — it exists so the adaptive learner
   *  (utils/adaptiveForecast.ts) can subtract the monthly amount a known
   *  obligation already covers from a learned category average, and so never
   *  double-count a category that a bill/subscription already forecasts. */
  category?: string | null;
  /** Provenance, preserved through de-duplication. */
  links?: ForecastSourceLinks;
  /** Present ⇒ this is an internal transfer between the user's own accounts:
   *  excluded from the total net; per-account it debits `accountId` and credits
   *  `counterpartAccountId` (when known). */
  transfer?: { counterpartAccountId?: string | null };
  /** Skip the anchor occurrence (e.g. a recurring bill already paid this cycle)
   *  but still project the following ones. For `once`, skips it entirely. */
  skipAnchor?: boolean;
  /** The anchor is a due date that has already PASSED and the obligation is
   *  still unsettled. The forecast is future-only, so such a record would
   *  otherwise contribute nothing — an unpaid overdue tax bill would simply
   *  vanish from the balance line. Set this and the engine carries the missed
   *  occurrence forward to the next day. Exactly ONE catch-up is emitted however
   *  many cycles were missed, so a long-neglected record cannot stack up a
   *  fictional backlog. Ignored when `skipAnchor` is set (already settled). */
  overdue?: boolean;
  /** Bill-only reference signal: the DS believes this bill IS a credit-card
   *  payment (e.g. categorised "Credit Card"). Lets the de-duper match it to a
   *  card's minimum-payment projection even when the bill name doesn't contain
   *  the card's name. Ignored on non-bill inputs. */
  creditCardPayment?: boolean;
}

/** A bank account's current cash position (display currency). */
export interface AccountBalanceInput {
  accountId: string;
  name: string;
  balance: number;
}

/** A single projected cash movement on a future date. */
export interface ForecastEvent {
  date: string;
  /** SIGNED display-currency amount. */
  amount: number;
  accountId: string | null;
  name: string;
  sourceType: ForecastSourceType;
  sourceId: string;
  confidence: number;
  isTransfer: boolean;
  /** For a transfer, the account credited by this movement (when known). */
  counterpartAccountId?: string | null;
}

/** Total household-cash projection at one horizon. */
export interface HorizonTotal {
  days: number;
  date: string;
  /** Sum of positive (inflow) events up to this horizon. */
  inflow: number;
  /** Sum of negative (outflow) events up to this horizon (≤ 0). */
  outflow: number;
  net: number;
  openingBalance: number;
  projectedBalance: number;
  /** Lowest the running total dips to between `asOf` and this horizon — the
   *  liquidity-risk figure. Includes the opening balance as the starting point. */
  lowestBalance: number;
  lowestDate: string;
}

/** Per-account balance projection at each horizon. */
export interface AccountProjection {
  accountId: string;
  name: string;
  openingBalance: number;
  d30: number;
  d60: number;
  d90: number;
}

/** An input removed by de-duplication, with the reason and the record kept. */
export interface SuppressedInput {
  id: string;
  sourceType: ForecastSourceType;
  reason:
    | 'mirrors-loan'
    | 'mirrors-subscription'
    | 'series-matches-subscription'
    | 'series-matches-income'
    | 'series-matches-loan'
    | 'mirrors-card';
  keptId: string;
}

export interface CashFlowForecast {
  asOf: string;
  horizonDays: number[];
  openingTotal: number;
  horizons: HorizonTotal[];
  accounts: AccountProjection[];
  /** Every projected event within the widest horizon, sorted by date. */
  events: ForecastEvent[];
  /** De-duplication audit — nothing is deleted, only excluded from totals. */
  suppressed: SuppressedInput[];
}

export interface ForecastParams {
  /** Today, `YYYY-MM-DD`. Injected for determinism/testability. */
  asOf: string;
  accounts: AccountBalanceInput[];
  inputs: RecurringInput[];
  /** Days forward to report. Defaults to [30, 60, 90]. */
  horizons?: number[];
}

// ── Date helpers (UTC, to avoid any local-timezone drift) ────────────────────

function toUTC(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function iso(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Add `days` to a `YYYY-MM-DD` date in UTC. Exported so the adaptive learner
 *  and view helpers share one date implementation (no drift between layers). */
export function addDays(dateStr: string, days: number): string {
  const d = toUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/**
 * Add `months` calendar months, preserving day-of-month and clamping to the
 * target month's last day (31 Jan + 1 month → 28/29 Feb). Mirrors the
 * addMonthsUTC semantics in recurringDetection so a monthly charge keeps its
 * day-of-month instead of drifting on a fixed 30-day step.
 */
export function addMonths(dateStr: string, months: number): string {
  const d = toUTC(dateStr);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return iso(d);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Absolute gap in whole/fractional days between two ISO dates. Returns Infinity
 *  when either date is unparseable (so it never accidentally matches). */
function daysApart(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / 86_400_000;
}

/**
 * Every occurrence of an input strictly AFTER `fromExclusive` and up to and
 * including `toInclusive`. `fromExclusive` is `asOf`: today's balance already
 * reflects anything dated today, so we only project the future.
 *
 * `once` yields at most its anchor. For recurring inputs each occurrence is
 * computed as `anchor + k·interval` from the ORIGINAL anchor — never by
 * re-stepping a clamped cursor — so a charge on the 31st that clamps to the
 * 30th in a short month recovers to the 31st the following month instead of
 * permanently drifting earlier. Weekly/fortnightly step in days; monthly/
 * quarterly/annually step in calendar months.
 *
 * An `overdue` input additionally yields one catch-up occurrence on the day
 * after `fromExclusive` — see the field's documentation.
 */
export function generateOccurrences(
  input: Pick<RecurringInput, 'anchorDate' | 'frequency' | 'skipAnchor' | 'overdue'>,
  fromExclusive: string,
  toInclusive: string,
): string[] {
  const { frequency, anchorDate } = input;
  const out: string[] = [];

  // A missed, still-unsettled obligation is real money that has not left the
  // account yet. Carry it to the next day so the balance line reflects it,
  // ahead of any future occurrence (keeping `out` in date order).
  if (input.overdue && !input.skipAnchor && anchorDate <= fromExclusive) {
    const catchUp = addDays(fromExclusive, 1);
    if (catchUp <= toInclusive) out.push(catchUp);
  }

  if (frequency === 'once') {
    if (!input.skipAnchor && anchorDate > fromExclusive && anchorDate <= toInclusive) out.push(anchorDate);
    return out;
  }

  const monthStep = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : frequency === 'annually' ? 12 : 0;
  const dayStep = frequency === 'weekly' ? 7 : frequency === 'fortnightly' ? 14 : 0;
  const nth = (k: number): string => (monthStep ? addMonths(anchorDate, k * monthStep) : addDays(anchorDate, k * dayStep));

  let k = input.skipAnchor ? 1 : 0;

  // Jump straight to the live cycle instead of stepping one period at a time.
  // A weekly series anchored years ago is over a thousand periods old; stepping
  // through them burned the loop's safety cap and returned NOTHING, silently
  // dropping the obligation. The estimate deliberately UNDER-shoots (and backs
  // off one more period for month-length clamping), so the walk below still
  // lands on the true first future occurrence.
  const behind = daysApart(anchorDate, fromExclusive);
  if (anchorDate < fromExclusive && Number.isFinite(behind)) {
    if (dayStep) {
      k = Math.max(k, Math.floor(behind / dayStep));
    } else if (monthStep) {
      const a = toUTC(anchorDate);
      const f = toUTC(fromExclusive);
      const months = (f.getUTCFullYear() - a.getUTCFullYear()) * 12 + (f.getUTCMonth() - a.getUTCMonth());
      if (months > 0) k = Math.max(k, Math.floor(months / monthStep) - 1);
    }
  }

  const MAX = 1000;
  let guard = 0;
  while (nth(k) <= fromExclusive && guard++ < MAX) k += 1;
  guard = 0;
  while (guard++ < MAX) {
    const d = nth(k);
    if (d > toInclusive) break;
    out.push(d);
    k += 1;
  }
  return out;
}

// ── De-duplication ───────────────────────────────────────────────────────────

const STOPWORDS = new Set(['the', 'and', 'for', 'payment', 'repayment', 'direct', 'debit', 'bill', 'auto']);

function tokens(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(w => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** True when two names share a significant (non-stopword) token. Exported for
 *  the adaptive learner to match a learned income stream against a declared one. */
export function nameOverlap(a: string, b: string): boolean {
  const ta = tokens(a);
  for (const w of tokens(b)) if (ta.has(w)) return true;
  return false;
}

/** Same magnitude within the larger of $1 or 2% — tolerant of small drift in a
 *  detected series vs a user-entered subscription/income amount. Exported so the
 *  adaptive learner suppresses a learned income that a declared one already covers. */
export function amountsClose(a: number, b: number): boolean {
  const x = Math.abs(a);
  const y = Math.abs(b);
  return Math.abs(x - y) <= Math.max(1, Math.max(x, y) * 0.02);
}

function sameSign(a: number, b: number): boolean {
  return (a >= 0) === (b >= 0);
}

/**
 * Remove records that describe the SAME obligation so it is counted once:
 *  1. A bill mirrored from a loan (`links.loan_id`) or a subscription
 *     (`links.subscription_id`) — the authoritative loan/subscription is kept,
 *     the mirror bill is suppressed. If the linked record is absent (deleted),
 *     the bill is kept as the sole survivor.
 *  2. A detected `recurring_series` that matches a user-managed `subscription`,
 *     recurring `income`, or a `loan` repayment on frequency + amount + name —
 *     the user-managed record wins; the series is suppressed.
 *  3. A manual `bill` that represents the same payment as a `credit_card`
 *     minimum-payment projection. Bills carry no card link in the schema, so
 *     this matches CONSERVATIVELY on amount + due date (within
 *     DUP_DUE_WINDOW_DAYS) + a name/reference signal (the bill names the card,
 *     or the DS flagged it `creditCardPayment`). The authoritative card wins;
 *     the bill is suppressed. All three gates are required, so a same-amount
 *     utility bill that merely falls near the card's due date is never removed.
 *
 * Nothing is mutated or dropped from the caller's array; suppressed inputs are
 * returned separately so they can be surfaced for review.
 */
export function dedupeInputs(inputs: RecurringInput[]): {
  kept: RecurringInput[];
  suppressed: SuppressedInput[];
} {
  const byId = new Map(inputs.map(i => [i.id, i]));
  const dropped = new Set<string>();
  const suppressed: SuppressedInput[] = [];
  const present = (id?: string | null): id is string => !!id && byId.has(id) && !dropped.has(id);

  // 1. Explicit-link mirrors (bill → loan / subscription).
  for (const inp of inputs) {
    if (inp.sourceType !== 'bill') continue;
    if (present(inp.links?.loan_id)) {
      dropped.add(inp.id);
      suppressed.push({ id: inp.id, sourceType: inp.sourceType, reason: 'mirrors-loan', keptId: inp.links!.loan_id! });
    } else if (present(inp.links?.subscription_id)) {
      dropped.add(inp.id);
      suppressed.push({ id: inp.id, sourceType: inp.sourceType, reason: 'mirrors-subscription', keptId: inp.links!.subscription_id! });
    }
  }

  // 2. Heuristic: a detected series that duplicates a user-managed record.
  for (const inp of inputs) {
    if (inp.sourceType !== 'recurring_series' || dropped.has(inp.id)) continue;
    const match = inputs.find(o =>
      o.id !== inp.id &&
      !dropped.has(o.id) &&
      (o.sourceType === 'subscription' || o.sourceType === 'income' || o.sourceType === 'loan') &&
      o.frequency === inp.frequency &&
      sameSign(o.amount, inp.amount) &&
      amountsClose(o.amount, inp.amount) &&
      nameOverlap(o.name, inp.name),
    );
    if (match) {
      dropped.add(inp.id);
      const reason = match.sourceType === 'subscription'
        ? 'series-matches-subscription'
        : match.sourceType === 'income'
          ? 'series-matches-income'
          : 'series-matches-loan';
      suppressed.push({ id: inp.id, sourceType: inp.sourceType, reason, keptId: match.id });
    }
  }

  // 3. Heuristic: a manual bill that duplicates a credit-card minimum payment.
  //    Each card is consumed at most once (one-to-one) so two cards with the
  //    same minimum can't both be cancelled by a single bill.
  const consumedCard = new Set<string>();
  for (const inp of inputs) {
    if (inp.sourceType !== 'bill' || dropped.has(inp.id)) continue;
    const card = inputs.find(o =>
      o.sourceType === 'credit_card' &&
      !dropped.has(o.id) &&
      !consumedCard.has(o.id) &&
      sameSign(o.amount, inp.amount) &&
      amountsClose(o.amount, inp.amount) &&
      daysApart(o.anchorDate, inp.anchorDate) <= DUP_DUE_WINDOW_DAYS &&
      (inp.creditCardPayment === true || nameOverlap(inp.name, o.name)),
    );
    if (card) {
      dropped.add(inp.id);
      consumedCard.add(card.id);
      suppressed.push({ id: inp.id, sourceType: inp.sourceType, reason: 'mirrors-card', keptId: card.id });
    }
  }

  return { kept: inputs.filter(i => !dropped.has(i.id)), suppressed };
}

// ── Main projection ──────────────────────────────────────────────────────────

/**
 * Build the 30/60/90-day cash-flow forecast. See the module header for the
 * scope and treatment of transfers, allocation and de-duplication.
 */
export function buildCashFlowForecast(params: ForecastParams): CashFlowForecast {
  const { asOf, accounts } = params;
  const horizonDays = (params.horizons?.length ? params.horizons : [30, 60, 90])
    .slice()
    .sort((a, b) => a - b);
  const maxDays = horizonDays[horizonDays.length - 1] ?? 0;
  const toInclusive = addDays(asOf, maxDays);

  const openingTotal = round2(accounts.reduce((s, a) => s + a.balance, 0));

  const { kept, suppressed } = dedupeInputs(params.inputs);

  // Expand recurring inputs into concrete dated events.
  const events: ForecastEvent[] = [];
  for (const inp of kept) {
    for (const date of generateOccurrences(inp, asOf, toInclusive)) {
      events.push({
        date,
        amount: round2(inp.amount),
        accountId: inp.accountId,
        name: inp.name,
        sourceType: inp.sourceType,
        sourceId: inp.id,
        confidence: inp.confidence,
        isTransfer: !!inp.transfer,
        counterpartAccountId: inp.transfer?.counterpartAccountId ?? null,
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));

  const horizons = horizonDays.map(days => computeHorizon(events, openingTotal, asOf, days));
  const accountProjections = projectAccounts(events, accounts, asOf, horizonDays);

  return {
    asOf,
    horizonDays,
    openingTotal,
    horizons,
    accounts: accountProjections,
    events,
    suppressed,
  };
}

/** Total household-cash projection at a single horizon. Transfers are excluded
 *  (they don't change total cash). */
function computeHorizon(
  events: ForecastEvent[],
  openingTotal: number,
  asOf: string,
  days: number,
): HorizonTotal {
  const date = addDays(asOf, days);
  const upto = events.filter(e => !e.isTransfer && e.date <= date);

  // Accrue the totals event by event, but track the trough DAY BY DAY. Several
  // movements routinely land on the same date (rent and payday, say), and the
  // order the engine holds them in is alphabetical by name — not the order they
  // clear. Walking events one at a time therefore reported a dip that never
  // happens, and one that flipped with a rename. Netting each day first makes
  // the reported low a balance that genuinely occurs, and makes it agree with
  // the day-by-day line the Forecast chart draws (utils/forecastView.ts).
  let inflow = 0;
  let outflow = 0;
  const netByDate = new Map<string, number>();
  for (const e of upto) {
    if (e.amount >= 0) inflow += e.amount;
    else outflow += e.amount;
    netByDate.set(e.date, (netByDate.get(e.date) ?? 0) + e.amount);
  }

  let running = openingTotal;
  let lowestBalance = openingTotal;
  let lowestDate = asOf;
  for (const d of [...netByDate.keys()].sort()) {
    running = round2(running + (netByDate.get(d) ?? 0));
    if (running < lowestBalance) {
      lowestBalance = running;
      lowestDate = d;
    }
  }

  return {
    days,
    date,
    inflow: round2(inflow),
    outflow: round2(outflow),
    net: round2(inflow + outflow),
    openingBalance: openingTotal,
    projectedBalance: round2(openingTotal + inflow + outflow),
    lowestBalance: round2(lowestBalance),
    lowestDate,
  };
}

/** Per-account balance at each horizon. A transfer debits its source account and
 *  credits its counterpart (when the counterpart is a known account). */
function projectAccounts(
  events: ForecastEvent[],
  accounts: AccountBalanceInput[],
  asOf: string,
  horizonDays: number[],
): AccountProjection[] {
  const opening = new Map<string, number>();
  const names = new Map<string, string>();
  for (const a of accounts) {
    opening.set(a.accountId, a.balance);
    names.set(a.accountId, a.name);
  }

  // Ledger of (accountId, date, amount) postings — each event may post to one or
  // two accounts. An event on an unknown account routes to the unallocated bucket.
  interface Posting { accountId: string; date: string; amount: number; }
  const postings: Posting[] = [];
  const seen = new Set<string>();
  const route = (id: string | null): string => (id && opening.has(id) ? id : UNALLOCATED);

  for (const e of events) {
    const src = route(e.accountId);
    postings.push({ accountId: src, date: e.date, amount: e.amount });
    seen.add(src);
    if (e.isTransfer) {
      // ALWAYS post the receiving leg. When the counterpart is unknown — which
      // is what a detected transfer-like series gives us — it routes to the
      // unallocated bucket. Dropping it instead made the account roll-up lose
      // cash the household total had kept, so the two views disagreed.
      const dst = route(e.counterpartAccountId ?? null);
      postings.push({ accountId: dst, date: e.date, amount: -e.amount });
      seen.add(dst);
    }
  }

  const accountIds = new Set<string>([...opening.keys(), ...seen]);
  const balanceAt = (accountId: string, horizonDate: string): number => {
    let bal = opening.get(accountId) ?? 0;
    for (const p of postings) {
      if (p.accountId === accountId && p.date <= horizonDate) bal += p.amount;
    }
    return round2(bal);
  };

  const [d30d, d60d, d90d] = [
    addDays(asOf, horizonDays[0] ?? 30),
    addDays(asOf, horizonDays[1] ?? horizonDays[0] ?? 60),
    addDays(asOf, horizonDays[2] ?? horizonDays[1] ?? horizonDays[0] ?? 90),
  ];

  return [...accountIds]
    .sort((a, b) => (a === UNALLOCATED ? 1 : b === UNALLOCATED ? -1 : a.localeCompare(b)))
    .map(accountId => ({
      accountId,
      name: names.get(accountId) ?? (accountId === UNALLOCATED ? 'Unallocated' : accountId),
      openingBalance: round2(opening.get(accountId) ?? 0),
      d30: balanceAt(accountId, d30d),
      d60: balanceAt(accountId, d60d),
      d90: balanceAt(accountId, d90d),
    }));
}
