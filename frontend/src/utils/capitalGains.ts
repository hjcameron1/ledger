/**
 * Phase 5.4 — CAPITAL GAINS TAX (pure engine).
 *
 * Answers "what is my net capital gain for financial year X", from the parcels
 * the user acquired and the disposals they recorded, and hands ONE number to the
 * FY position: the net capital gain, which is assessable income like any other.
 *
 * It computes no tax. Once the gain is inside `estimatedTaxableIncome`, the
 * existing stack does the rest — that year's brackets and Medicare levy
 * (taxRates.ts), the repayment/rebate/surcharge income bases, LITO/SAPTO
 * (taxOffsets.ts) and the settlement. There is deliberately no marginal rate
 * anywhere in this module: the panel it replaces had a hard-coded five-row rate
 * dropdown, which was a second, worse copy of a registry Ledger already audits.
 *
 * ─── THE ATO's OWN ORDER OF OPERATIONS ──────────────────────────────────────
 * Verified against ato.gov.au 19 August 2026 ("How to calculate your CGT",
 * QC 104071; "Using capital losses to reduce capital gains", QC 66025; "CGT
 * discount", QC 66019). The steps, and where each lives here:
 *
 *   1–4. Per disposal: capital proceeds − cost base = gain or loss.  → CgtEvent
 *   5.   Subtract capital losses from gains, BEFORE any discount. You choose
 *        which gains to reduce; the ATO states plainly that reducing the gains
 *        that are NOT discount-eligible first gives the lowest tax, so that is
 *        what this does.                                             → applyLosses
 *   6.   Below zero, the remainder is a net capital loss.
 *   7.   Apply the 50% discount to what is left of the eligible gains.
 *   8.   A net capital gain is assessable; a net capital loss carries forward
 *        indefinitely and can never touch other income.
 *
 * TWO POOLS, NOT ONE. A capital loss on a COLLECTABLE (Ledger's art, wine and
 * jewellery holdings) can only ever be deducted from a gain on a collectable —
 * it is quarantined and carried forward in its own pool. The reverse is not
 * true: an ordinary loss can reduce any gain, collectable ones included. That
 * asymmetry is the whole reason the buckets below are shaped the way they are.
 *
 * THE 12-MONTH TEST IS A CALENDAR TEST, NOT A DAY COUNT. The ATO excludes both
 * the day of acquisition and the day of the CGT event, so the discount needs the
 * disposal to fall strictly after the first anniversary. Ledger used to test
 * `heldDays > 365`, which quietly grants the discount to anything bought and
 * sold across a 29 February — 1 July 2023 → 1 July 2024 is 366 days but is not
 * twelve months and a day. `ownedTwelveMonths` compares anniversaries instead.
 *
 * MATCHING RUNS OVER ALL OF HISTORY, NOT ONE YEAR. A parcel bought in 2020 and
 * half sold in 2022 has half left for a 2024 sale, so disposals are matched
 * against parcels in date order across every year first, and the financial year
 * is applied afterwards, to the events. Doing it the other way round would let
 * the same units be sold twice.
 *
 * WHAT IT DOES WITHOUT ANY NEW DATA. Parcels are an improvement, not a
 * prerequisite: a disposal that matches no parcel falls back to the cost base
 * and acquisition date already recorded on the sale itself, which is exactly
 * what Ledger has stored since the Sell dialog was written. Recording parcels
 * changes a pro-rata average into real parcel identification — which matters
 * most for the DATE, because that is what decides the discount.
 *
 * EVERY UNKNOWN COSTS THE USER MONEY, ON PURPOSE. No acquisition date means no
 * discount. No cost base means the whole proceeds are a gain. Both are stated
 * out loud as warnings carrying the amount at stake, so an under-recorded
 * holding reads as "you are being taxed too much until you fill this in" rather
 * than quietly inventing a refund.
 *
 * NOT MODELLED, and all of it named in `notes` rather than assumed away:
 * indexation for assets held since before 21 September 1999, personal-use assets
 * (Ledger has no such asset type), the main-residence exemption and property
 * disposals generally (Ledger's properties record no sale), small business
 * concessions, deceased-estate and relationship-breakdown ownership inheritance,
 * the apportioned discount for part-year foreign residents, and the affordable
 * housing uplift to 60%.
 *
 * PURE — no store, no network, no localStorage.
 */

import { financialYearOf } from './format';

// ─── Rates and rules that are not per-year ──────────────────────────────────

/** The individual/trust discount. 50% since 1999; complying super funds get 33⅓%. */
export const CGT_DISCOUNT_RATE = 0.5;

/**
 * A collectable acquired for this or less is outside CGT entirely — both its
 * gain and its loss are ignored.
 */
export const COLLECTABLE_EXEMPT_COST = 500;

/**
 * The 2026–27 Federal Budget announced changes to CGT. The ATO's own pages carry
 * an alert saying they do not apply to Tax Time 2026 and that guidance is not
 * available yet, so nothing here is changed for them — but the year says so.
 */
export const ANNOUNCED_CHANGES_FROM_FY = '2026-2027';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** A finite, non-negative number, or 0. Anything else is "not supplied". */
function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/** A finite number of units, or 0. Quantities keep 8 decimals for crypto. */
function quantity(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? parseFloat(n.toFixed(8)) : 0;
}

/** A plain YYYY-MM-DD, or null. Never parsed as a Date — no time zone can shift it. */
export function isoDay(v: unknown): string | null {
  const s = String(v ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ─── Ownership period ───────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month !== 2) return DAYS_IN_MONTH[month - 1];
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

/**
 * The same date `years` later, as a string. 29 February has no anniversary, so
 * it clamps to 28 February — the reading the Acts Interpretation Act takes of a
 * period of twelve months starting on a leap day.
 */
export function anniversaryOf(date: string | null | undefined, years = 1): string | null {
  const day = isoDay(date);
  if (!day) return null;
  const y = Number(day.slice(0, 4)) + years;
  const m = Number(day.slice(5, 7));
  const d = Math.min(Number(day.slice(8, 10)), daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Whether the asset was owned for at least twelve months before the CGT event.
 * Returns null when the acquisition date is unknown — which is NOT the same as
 * false, and the caller says so differently.
 *
 * The ATO excludes both the acquisition day and the event day, so twelve months
 * of ownership means the disposal falls strictly AFTER the first anniversary:
 * bought 1 July 2023, the discount starts on 2 July 2024.
 */
export function ownedTwelveMonths(
  acquired: string | null | undefined,
  disposed: string | null | undefined,
): boolean | null {
  const from = isoDay(acquired);
  const to = isoDay(disposed);
  if (!from || !to) return null;
  const anniversary = anniversaryOf(from, 1)!;
  return to > anniversary;
}

/** Whole days between two dates, for display only — never for the discount test. */
export function daysHeld(
  acquired: string | null | undefined,
  disposed: string | null | undefined,
): number | null {
  const from = isoDay(acquired);
  const to = isoDay(disposed);
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ─── Asset classes ──────────────────────────────────────────────────────────

/**
 * Ordinary asset or collectable. Ledger's own `asset_type` decides it: art, wine
 * and jewellery are the ATO's collectables (artwork, antiques, coins or medallions,
 * rare folios, jewellery). A precious-metal holding is NOT a collectable — bullion
 * is bought for its metal content, not as a coin collection — and Ledger's metal
 * rows are spot-priced by weight, which is the same distinction.
 */
export type CgtAssetClass = 'ordinary' | 'collectable';

const COLLECTABLE_TYPES = new Set(['art', 'wine', 'jewellery']);

export function cgtAssetClassOf(assetType: string | null | undefined): CgtAssetClass {
  return COLLECTABLE_TYPES.has(String(assetType ?? '').trim().toLowerCase())
    ? 'collectable'
    : 'ordinary';
}

// ─── Parcels and disposals ──────────────────────────────────────────────────

/**
 * One acquisition. A holding bought in three lots on three dates is three
 * parcels, which is the only way the discount can be right on a partial sale:
 * the units sold have their own acquisition date, not the holding's average.
 */
export interface CgtParcel {
  id: string;
  /** The holding it belongs to, when it came from one. */
  investmentId: string | null;
  /** Display name for the asset. */
  label: string;
  ticker: string | null;
  assetType: string | null;
  quantity: number;
  /** What the parcel cost, brokerage and stamp duty included. */
  costBase: number;
  acquiredDate: string | null;
  /**
   * When the parcel was WRITTEN DOWN, which is not when it was acquired. It is
   * the clock a share split is measured on — see CgtSplit.
   */
  recordedAt?: string | null;
  /**
   * Where the parcel came from. 'holding' is the placeholder Ledger opens when a
   * purchase is recorded — the whole holding as one parcel, which is exactly
   * right until the user says otherwise. 'user' is a parcel somebody typed in,
   * and it supersedes the placeholder: the same units must never be counted
   * twice. Missing means 'user' (every parcel written before this existed was
   * typed in by hand).
   */
  origin?: 'holding' | 'user';
}

/** One disposal (a sale, in Ledger's language) — partial or whole. */
export interface CgtDisposal {
  id: string;
  investmentId: string | null;
  label: string;
  ticker: string | null;
  assetType: string | null;
  quantity: number;
  /** Capital proceeds before selling costs. */
  proceeds: number;
  /** Brokerage and other costs of selling. */
  fees: number;
  /**
   * The cost base recorded on the sale itself. Used only for units no parcel
   * covers — the pro-rata figure Ledger's Sell dialog has always written.
   */
  costBase: number;
  /** The acquisition date recorded on the sale itself. Same fallback role. */
  acquiredDate: string | null;
  saleDate: string;
  currency: string | null;
  /**
   * Parcels the user nominated for this disposal. The ATO lets you identify
   * which parcel you sold; with nothing nominated, the oldest parcels go first,
   * which is the ATO's own fallback when you cannot distinguish them.
   */
  parcelIds?: string[] | null;
  /**
   * When the disposal was WRITTEN DOWN. Its `quantity` is in the units that were
   * current at that moment, so a split recorded afterwards has to scale it — see
   * CgtSplit.
   */
  recordedAt?: string | null;
  /**
   * The parcels this disposal ACTUALLY drew on, settled when it was recorded.
   *
   * WITHOUT THIS, HISTORY MOVES. Matching re-derives every disposal from the
   * parcel book on every read, so recording a parcel today changes what a sale
   * three years ago cost — a figure that may already be on a return the ATO has
   * accepted. A settled disposal is not re-costed: its slices stand as written,
   * they still consume their parcels so later disposals see the right remainder,
   * and only the units they do not cover fall back to the sale's own figures.
   *
   * Quantities are in the units that were current when the sale was recorded, so
   * a later split scales them exactly as it scales `quantity`. Cost never moves.
   */
  settled?: CgtSettledAllocation[] | null;
}

/** One slice of a disposal as it was settled at the time — the audit trail. */
export interface CgtSettledAllocation {
  /** The parcel these units came out of. Null = the sale's own figures were used. */
  parcelId: string | null;
  quantity: number;
  costBase: number;
  acquiredDate: string | null;
  source?: AllocationSource;
}

/**
 * A share split or consolidation. It is not a CGT event: no cost moves and no
 * acquisition date changes, only the number of units the same cost is spread
 * across ("Ledger's" 10:1 split turns 1,000 units at $19,600 into 10,000 units
 * at $19,600, all still acquired on the original day).
 *
 * THE CLOCK IS WHEN IT WAS RECORDED, NOT WHEN IT HAPPENED. Everything already
 * written down — parcels and disposals both — is expressed in pre-split units
 * and is scaled by the ratio; everything written down afterwards is already in
 * post-split units and is left alone. That is what a user actually does: the
 * units they type into a sale are the units their broker is showing them that
 * day. Using the split's calendar date instead would mis-scale every row
 * entered late, which is most of them.
 */
export interface CgtSplit {
  id: string;
  investmentId: string | null;
  label: string;
  ticker: string | null;
  /** New units per old unit. 10 for a 10:1 split, 0.1 for a 1:10 consolidation. */
  ratio: number;
  /** ISO timestamp. Missing sorts earliest, so the split applies to everything. */
  recordedAt?: string | null;
}

/**
 * The key that decides which parcels a disposal can draw on. The holding id when
 * both have one — that is the only identity Ledger guarantees — otherwise the
 * ticker, otherwise the name. Two different holdings never share a key.
 */
export function assetKeyOf(
  x: Pick<CgtParcel, 'investmentId' | 'ticker' | 'label'>,
): string {
  if (x.investmentId) return `inv:${x.investmentId}`;
  const ticker = String(x.ticker ?? '').trim().toUpperCase();
  if (ticker) return `tkr:${ticker}`;
  return `nam:${String(x.label ?? '').trim().toLowerCase()}`;
}

/**
 * EVERY identity a parcel or disposal answers to, not just its best one. A
 * disposal and a parcel belong to the same asset when ANY of their identities
 * match.
 *
 * This is what makes a hand-recorded parcel usable. The Tax page's parcel editor
 * knows a ticker; every sale the Sell dialog records knows a holding id. Keyed on
 * the single best identity, one says `tkr:AAPL` and the other says `inv:<uuid>`,
 * the two can never meet, and the parcel is silently ignored — the acquisition
 * dates the user typed in thrown away and the sale left on its averaged cost
 * base. Two holdings with different tickers still never share a parcel, because
 * no key of one appears in the other.
 */
export function assetKeysOf(
  x: Pick<CgtParcel, 'investmentId' | 'ticker' | 'label'>,
): string[] {
  const keys: string[] = [];
  if (x.investmentId) keys.push(`inv:${x.investmentId}`);
  const ticker = String(x.ticker ?? '').trim().toUpperCase();
  if (ticker) keys.push(`tkr:${ticker}`);
  if (keys.length === 0) {
    const name = String(x.label ?? '').trim().toLowerCase();
    if (name) keys.push(`nam:${name}`);
  }
  return keys;
}

/**
 * The order parcels are consumed in: oldest acquisition first, and an undated
 * parcel last, because it cannot be discounted and spending it first would waste
 * a datable one.
 *
 * WHEN THE DATES TIE, THE ORDER THEY WERE RECORDED IN DECIDES — which for two
 * undated parcels is the only FIFO Ledger has. Falling through to the parcel's
 * id sorted them by a random UUID instead, so a holding bought twice without
 * dates would sell whichever parcel happened to sort first: the same portfolio
 * could produce two different tax answers.
 */
function parcelOrder(a: CgtParcel, b: CgtParcel): number {
  const da = isoDay(a.acquiredDate) ?? '9999-12-31';
  const db = isoDay(b.acquiredDate) ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  const ra = String(a.recordedAt ?? '');
  const rb = String(b.recordedAt ?? '');
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** The product of every split recorded AFTER `recordedAt` — see CgtSplit. */
function splitScale(splits: CgtSplit[], recordedAt: string | null | undefined): number {
  const at = String(recordedAt ?? '');
  let scale = 1;
  for (const s of splits) {
    if (String(s.recordedAt ?? '') > at) scale *= s.ratio;
  }
  return scale;
}

// ─── Matching a disposal to the parcels it came out of ──────────────────────

/** Where an allocation's cost base and date came from. */
export type AllocationSource =
  /** A recorded parcel — the acquisition date is that parcel's own. */
  | 'parcel'
  /** No parcel covered these units; the sale's own recorded figures were used. */
  | 'recorded'
  /** No parcel and no recorded cost base: the whole proceeds are a gain. */
  | 'unmatched';

/**
 * One slice of a disposal with a single acquisition date behind it. A sale that
 * spans two parcels bought eighteen months apart produces two of these, and only
 * one of them is discountable — which is the entire point of parcel matching.
 */
export interface CgtAllocation {
  key: string;
  parcelId: string | null;
  source: AllocationSource;
  quantity: number;
  /** Share of the disposal's net proceeds, pro-rata by quantity. */
  proceeds: number;
  costBase: number;
  acquiredDate: string | null;
  heldDays: number | null;
  /** proceeds − costBase. Negative is a capital loss. */
  gain: number;
  /** Whether the 50% discount applies: a gain, held twelve months and a day. */
  discountEligible: boolean;
  /** True when the discount was refused only because the date is unknown. */
  dateUnknown: boolean;
  /** A collectable acquired for $500 or less — gain and loss both ignored. */
  exempt: boolean;
}

/** One disposal, resolved into the allocations that make it up. */
export interface CgtEvent {
  disposalId: string;
  investmentId: string | null;
  label: string;
  ticker: string | null;
  assetType: string | null;
  assetClass: CgtAssetClass;
  saleDate: string;
  fy: string;
  quantity: number;
  /** Gross proceeds, before selling costs. */
  proceeds: number;
  fees: number;
  /** Proceeds net of selling costs — what the gain is actually measured against. */
  netProceeds: number;
  costBase: number;
  /** Net of every allocation, exempt ones excluded. */
  gain: number;
  /** The part of `gain` that is a gain and carries the discount. */
  discountableGain: number;
  /** The part of `gain` that is a gain and does not. */
  otherGain: number;
  /** The part that is a loss, as a positive number. */
  loss: number;
  /** Gains and losses ignored because the collectable was under $500. */
  exemptAmount: number;
  allocations: CgtAllocation[];
  /** Units this disposal could not draw from any parcel. */
  unparcelledQuantity: number;
  /**
   * Whether the asset had ANY parcel available at the sale date. It separates
   * "no parcels recorded, so the sale's own figures were used" — normal, and only
   * costing the user accuracy — from "the parcels ran out", which means more units
   * were sold than were ever bought.
   */
  hadParcels: boolean;
}

/** What is left of each parcel once every disposal has been matched. */
export interface ParcelRemainder {
  parcelId: string;
  quantityRemaining: number;
  costBaseRemaining: number;
  /** Units sold out of this parcel across all years. */
  quantitySold: number;
}

export interface DisposalMatch {
  events: CgtEvent[];
  remainders: ParcelRemainder[];
}

/**
 * Resolve every disposal against the parcels available at its sale date, in sale
 * order, across all of history. Later years see only what earlier years left.
 *
 * Selection order within an asset:
 *   0. a disposal that was SETTLED when it was recorded keeps what it drew on —
 *      it is history, not a question to be re-answered (see CgtDisposal.settled);
 *   1. parcels the user nominated on the disposal, in the order given;
 *   2. otherwise the oldest parcel acquired on or before the sale date (FIFO —
 *      the ATO's fallback when the parcels cannot be distinguished);
 *   3. a parcel with no acquisition date, last, because it cannot be discounted
 *      and using it first would waste a datable parcel;
 *   4. anything the parcels cannot cover falls back to the sale's own figures.
 */
export function matchDisposals(input: {
  parcels: CgtParcel[];
  disposals: CgtDisposal[];
  splits?: CgtSplit[] | null;
}): DisposalMatch {
  // Working copies — the engine consumes parcels as it walks the disposals, and
  // must never mutate what the caller handed in.
  const pool = new Map<string, {
    parcel: CgtParcel;
    quantityLeft: number;
    costLeft: number;
    sold: number;
  }>();
  const byAsset = new Map<string, string[]>();

  // Splits, per asset identity, so a parcel or a disposal can be re-expressed in
  // the units that are current now. Cost never moves — only the unit count.
  const splitsByKey = new Map<string, CgtSplit[]>();
  for (const s of (input.splits ?? [])) {
    if (!Number.isFinite(s.ratio) || s.ratio <= 0 || s.ratio === 1) continue;
    for (const key of assetKeysOf(s)) {
      const arr = splitsByKey.get(key);
      if (arr) arr.push(s);
      else splitsByKey.set(key, [s]);
    }
  }
  /** Every split touching this asset, deduplicated across its identities. */
  const splitsFor = (x: Pick<CgtParcel, 'investmentId' | 'ticker' | 'label'>): CgtSplit[] => {
    if (splitsByKey.size === 0) return [];
    const seen = new Map<string, CgtSplit>();
    for (const key of assetKeysOf(x)) {
      for (const s of splitsByKey.get(key) ?? []) seen.set(s.id, s);
    }
    return [...seen.values()];
  };

  const sortedParcels = input.parcels
    .filter(p => quantity(p.quantity) > 0)
    .slice()
    .sort(parcelOrder);

  for (const p of sortedParcels) {
    pool.set(p.id, {
      parcel: p,
      // Units as they stand TODAY: what was written down, times every split
      // recorded since. The cost base is untouched — that is the whole point.
      quantityLeft: parseFloat((quantity(p.quantity) * splitScale(splitsFor(p), p.recordedAt)).toFixed(8)),
      costLeft: amount(p.costBase),
      sold: 0,
    });
    for (const key of assetKeysOf(p)) {
      const arr = byAsset.get(key);
      if (arr) arr.push(p.id);
      else byAsset.set(key, [p.id]);
    }
  }

  const sortedDisposals = input.disposals
    .slice()
    .sort((a, b) => {
      const da = isoDay(a.saleDate) ?? '';
      const db = isoDay(b.saleDate) ?? '';
      return da === db ? a.id.localeCompare(b.id) : da < db ? -1 : 1;
    });

  const events: CgtEvent[] = [];

  for (const d of sortedDisposals) {
    const saleDate = isoDay(d.saleDate);
    if (!saleDate) continue; // A disposal with no date belongs to no year.

    const recordedQty = quantity(d.quantity);
    // The disposal's own units are whatever was current when it was written
    // down; a split recorded since has to scale them, or the parcels it drew on
    // (which were scaled) would over-supply it.
    const scale = splitScale(splitsFor(d), d.recordedAt);
    const qty = parseFloat((recordedQty * scale).toFixed(8));
    const proceeds = amount(d.proceeds);
    const fees = amount(d.fees);
    const netProceeds = round2(Math.max(0, proceeds - fees));
    const assetClass = cgtAssetClassOf(d.assetType);

    // Candidate parcels: nominated ones first (in the user's order), then the
    // rest of this asset's parcels oldest-first, skipping any acquired after the
    // sale — you cannot sell units you had not bought yet. "This asset" means
    // any parcel sharing ANY identity with the disposal (see assetKeysOf).
    const nominated = (d.parcelIds ?? []).filter(id => pool.has(id));
    const matched = new Set<string>();
    for (const key of assetKeysOf(d)) {
      for (const id of byAsset.get(key) ?? []) matched.add(id);
    }
    const rest = [...matched]
      .filter(id => !nominated.includes(id))
      .sort((a, b) => parcelOrder(pool.get(a)!.parcel, pool.get(b)!.parcel));
    const candidates = [...nominated, ...rest].filter(id => {
      const acquired = isoDay(pool.get(id)!.parcel.acquiredDate);
      return acquired == null || acquired <= saleDate;
    });

    const allocations: CgtAllocation[] = [];
    let left = qty;

    // ── A disposal that was already settled is not re-costed. ────────────────
    // What it drew on was written down when it happened; replaying FIFO over
    // today's book would let a parcel recorded this morning change the cost base
    // of a sale from three years ago. The slices stand as written and still
    // consume their parcels, so everything after them sees the right remainder.
    const settled = (d.settled ?? []).filter(a => quantity(a.quantity) > 0 || amount(a.costBase) > 0);
    for (const a of settled) {
      const take = parseFloat((quantity(a.quantity) * scale).toFixed(8));
      const cost = amount(a.costBase);
      const slot = a.parcelId ? pool.get(a.parcelId) : undefined;
      if (slot) {
        // Never below zero: the parcel may have been edited since, and a
        // disposal cannot un-sell units by having been recorded generously.
        slot.quantityLeft = parseFloat(Math.max(0, slot.quantityLeft - take).toFixed(8));
        slot.costLeft = round2(Math.max(0, slot.costLeft - cost));
        slot.sold = parseFloat((slot.sold + take).toFixed(8));
      }
      allocations.push(makeAllocation({
        key: `${d.id}:${a.parcelId ?? 'recorded'}`,
        parcelId: a.parcelId,
        source: a.source ?? (a.parcelId ? 'parcel' : cost > 0 ? 'recorded' : 'unmatched'),
        quantity: take,
        costBase: cost,
        // The date the slice was settled with. A parcel that has since been
        // dated fills a blank, and the sale's own date is the last resort.
        acquiredDate: isoDay(a.acquiredDate)
          ?? isoDay(slot?.parcel.acquiredDate)
          ?? isoDay(d.acquiredDate),
        saleDate,
        assetClass,
        proceeds: 0,
      }));
      left = parseFloat((left - take).toFixed(8));
    }
    // Rounding, not a shortfall: a settled disposal covers itself.
    if (Math.abs(left) < 1e-6) left = 0;
    if (left < 0) left = 0;

    // FIFO is the default, and it is what an unsettled disposal gets.
    const fifoCandidates: string[] = settled.length > 0 ? [] : candidates;
    for (const id of fifoCandidates) {
      if (left <= 1e-9) break;
      const slot = pool.get(id)!;
      if (slot.quantityLeft <= 1e-9) continue;
      const take = Math.min(left, slot.quantityLeft);
      // Cost comes out of the parcel in the same proportion as the units, and
      // the LAST unit takes whatever cents are left so the parcel closes at zero.
      const share = take >= slot.quantityLeft - 1e-9 ? 1 : take / slot.quantityLeft;
      const cost = share === 1 ? slot.costLeft : round2(slot.costLeft * share);
      slot.quantityLeft = parseFloat((slot.quantityLeft - take).toFixed(8));
      slot.costLeft = round2(slot.costLeft - cost);
      slot.sold = parseFloat((slot.sold + take).toFixed(8));
      left = parseFloat((left - take).toFixed(8));
      allocations.push(makeAllocation({
        key: `${d.id}:${id}`,
        parcelId: id,
        source: 'parcel',
        quantity: take,
        costBase: cost,
        // The parcel's own date when it has one — that is the truth, and it is
        // why parcels exist. When it does not, the date recorded on the sale is
        // the only statement the user has made about these units, and throwing
        // it away would cost them the discount they had already earned. A parcel
        // that knows nothing must not contradict a date; it must defer to it.
        acquiredDate: isoDay(slot.parcel.acquiredDate) ?? isoDay(d.acquiredDate),
        saleDate,
        assetClass,
        // Proceeds are apportioned after the loop, once the split is known.
        proceeds: 0,
      }));
    }

    // Whatever the parcels could not cover falls back to the sale's own record.
    // A disposal with no quantity at all still gets one allocation, so recorded
    // proceeds are never silently dropped on the floor.
    if (left > 1e-9 || allocations.length === 0) {
      const recordedCost = amount(d.costBase);
      // Only the unmatched share of the recorded cost base — the rest of the sale
      // has already been costed from parcels.
      const shareOfSale = qty > 0 ? left / qty : 1;
      // …AND never more than the recorded figure has left to give. The cost base
      // written on a sale covers the WHOLE disposal, so once parcels have paid
      // for part of it, only the remainder can be claimed again. Without this
      // ceiling a parcel whose unit count is stale — the classic case being a
      // share split the parcel never heard about — is counted twice: 100 units
      // at $30,000 plus 300 leftover units at 75% of the same $30,000 makes a
      // $52,500 cost base out of a $30,000 purchase. Capping can only ever
      // raise the gain, which is the direction an unknown should always cost.
      const headroom = round2(Math.max(0, recordedCost - round2(allocations.reduce((s, a) => s + a.costBase, 0))));
      const cost = allocations.length === 0
        ? recordedCost
        : Math.min(round2(recordedCost * shareOfSale), headroom);
      allocations.push(makeAllocation({
        key: `${d.id}:recorded`,
        parcelId: null,
        source: recordedCost > 0 ? 'recorded' : 'unmatched',
        quantity: left,
        costBase: cost,
        acquiredDate: isoDay(d.acquiredDate),
        saleDate,
        assetClass,
        proceeds: 0,
      }));
    }

    // Apportion net proceeds across the allocations by quantity, giving the last
    // one the rounding remainder so the parts always add back to the whole.
    const totalQty = allocations.reduce((s, a) => s + a.quantity, 0);
    let assigned = 0;
    allocations.forEach((a, i) => {
      const p = i === allocations.length - 1
        ? round2(netProceeds - assigned)
        : round2(totalQty > 0 ? (netProceeds * a.quantity) / totalQty : 0);
      assigned = round2(assigned + p);
      a.proceeds = p;
      a.gain = round2(p - a.costBase);
      a.discountEligible = !a.exempt && a.gain > 0 && ownedTwelveMonths(a.acquiredDate, saleDate) === true;
      a.dateUnknown = !a.exempt && a.gain > 0 && a.acquiredDate == null;
    });

    const counted = allocations.filter(a => !a.exempt);
    const gain = round2(counted.reduce((s, a) => s + a.gain, 0));

    events.push({
      disposalId: d.id,
      investmentId: d.investmentId,
      label: d.label,
      ticker: d.ticker,
      assetType: d.assetType,
      assetClass,
      saleDate,
      fy: financialYearOf(saleDate),
      quantity: qty,
      proceeds,
      fees,
      netProceeds,
      costBase: round2(counted.reduce((s, a) => s + a.costBase, 0)),
      gain,
      discountableGain: round2(counted.filter(a => a.discountEligible).reduce((s, a) => s + a.gain, 0)),
      otherGain: round2(counted.filter(a => !a.discountEligible && a.gain > 0).reduce((s, a) => s + a.gain, 0)),
      loss: round2(counted.filter(a => a.gain < 0).reduce((s, a) => s - a.gain, 0)),
      exemptAmount: round2(allocations.filter(a => a.exempt).reduce((s, a) => s + a.gain, 0)),
      allocations,
      unparcelledQuantity: parseFloat(
        allocations.filter(a => a.source !== 'parcel').reduce((s, a) => s + a.quantity, 0).toFixed(8),
      ),
      hadParcels: candidates.length > 0,
    });
  }

  const remainders: ParcelRemainder[] = [...pool.values()].map(s => ({
    parcelId: s.parcel.id,
    quantityRemaining: s.quantityLeft,
    costBaseRemaining: s.costLeft,
    quantitySold: s.sold,
  }));

  // Back into the caller's own order, so a UI list does not reshuffle.
  const order = new Map(input.disposals.map((d, i) => [d.id, i]));
  events.sort((a, b) => (order.get(a.disposalId) ?? 0) - (order.get(b.disposalId) ?? 0));

  return { events, remainders };
}

/**
 * What a disposal that has not happened yet would draw on — the same matcher,
 * with the pending sale appended to the history so it sees exactly what earlier
 * disposals have already consumed.
 *
 * ONE PIECE OF ARITHMETIC, THREE CALLERS. The Sell dialog's preview, the cost
 * base written onto the sale, and the Tax page's return are all this function,
 * so the number the user is shown before they click is the number they are
 * taxed on. A second implementation of FIFO for the dialog is exactly how the
 * page came to average a two-parcel holding while the Tax page did not.
 */
export function previewDisposal(input: {
  parcels: CgtParcel[];
  /** Disposals already recorded. The pending one must NOT be among them. */
  disposals: CgtDisposal[];
  splits?: CgtSplit[] | null;
  pending: Omit<CgtDisposal, 'id'> & { id?: string };
}): CgtEvent {
  const id = input.pending.id ?? '__pending__';
  const { events } = matchDisposals({
    parcels: input.parcels,
    disposals: [...input.disposals.filter(d => d.id !== id), { ...input.pending, id }],
    splits: input.splits ?? [],
  });
  return events.find(e => e.disposalId === id)!;
}

/**
 * The single acquisition date to stamp on a disposal that spans parcels, and
 * whether the row may call itself discountable.
 *
 * A sale row carries ONE date and the Tax page carries the truth, so the date
 * chosen here is the NEWEST parcel the sale consumed: the only single date whose
 * discount answer can never be more generous than the return's. The row then
 * reads "held at least this long", never "held longer than it was".
 */
export function summariseAcquisition(event: CgtEvent): {
  acquiredDate: string | null;
  discountEligible: boolean;
  /** True when some units qualified for the discount and others did not. */
  mixed: boolean;
} {
  const counted = event.allocations.filter(a => !a.exempt);
  if (counted.length === 0) return { acquiredDate: null, discountEligible: false, mixed: false };
  const dates = counted.map(a => a.acquiredDate);
  const acquiredDate = dates.includes(null)
    ? null
    : dates.reduce((newest, d) => (d! > newest! ? d : newest), dates[0]);
  const gains = counted.filter(a => a.gain > 0);
  return {
    acquiredDate,
    discountEligible: event.gain > 0 && gains.length > 0 && gains.every(a => a.discountEligible),
    mixed: new Set(counted.map(a => `${a.acquiredDate}`)).size > 1,
  };
}

function makeAllocation(x: {
  key: string;
  parcelId: string | null;
  source: AllocationSource;
  quantity: number;
  costBase: number;
  acquiredDate: string | null;
  saleDate: string;
  assetClass: CgtAssetClass;
  proceeds: number;
}): CgtAllocation {
  // A collectable acquired for $500 or less is outside CGT — its gain AND its
  // loss are both ignored. Tested on what the parcel cost, which is what the
  // ATO's "acquired it for $500 or less" means.
  const exempt = x.assetClass === 'collectable' && x.costBase > 0 && x.costBase <= COLLECTABLE_EXEMPT_COST;
  return {
    key: x.key,
    parcelId: x.parcelId,
    source: x.source,
    quantity: x.quantity,
    proceeds: x.proceeds,
    costBase: x.costBase,
    acquiredDate: x.acquiredDate,
    heldDays: daysHeld(x.acquiredDate, x.saleDate),
    gain: 0,
    discountEligible: false,
    dateUnknown: false,
    exempt,
  };
}

// ─── The financial-year position ────────────────────────────────────────────

/** The two loss pools. Collectable losses can only ever reduce collectable gains. */
export interface CapitalLossPools {
  ordinary: number;
  collectable: number;
}

export function emptyLossPools(): CapitalLossPools {
  return { ordinary: 0, collectable: 0 };
}

/** The four buckets a gain can sit in once the discount question is settled. */
export type GainBucket = 'other' | 'collectable-other' | 'discount' | 'collectable-discount';

/** One loss, applied to one bucket — the audit trail for step 5. */
export interface LossApplication {
  key: string;
  pool: keyof CapitalLossPools;
  source: 'current-year' | 'brought-forward';
  against: GainBucket;
  amount: number;
}

export type CapitalGainsWarningKind =
  /** A gain could be discounted but Ledger does not know when it was bought. */
  | 'acquisition-date-missing'
  /** A disposal with no cost base anywhere — the whole proceeds are being taxed. */
  | 'cost-base-missing'
  /** Units were sold that no parcel covers. */
  | 'unparcelled-units'
  /** More units disposed of than the recorded parcels ever held. */
  | 'over-disposed'
  /** Collectable losses that no collectable gain could absorb. */
  | 'collectable-loss-quarantined'
  /** The year ends in a net capital loss — nothing is assessable. */
  | 'net-capital-loss'
  /** Losses brought in from a lodged return are being applied. */
  | 'brought-forward-applied'
  /** Disposals in more than one currency were added together. */
  | 'mixed-currency'
  /** A collectable was ignored entirely because it cost $500 or less. */
  | 'collectable-exempt'
  /** Announced changes exist for this year that Ledger does not model. */
  | 'announced-changes';

export interface CapitalGainsWarning {
  kind: CapitalGainsWarningKind;
  severity: 'warn' | 'info';
  /** Plain text with no dollar figures — the engine has no display currency. */
  message: string;
  amount?: number;
  count?: number;
}

export interface CapitalGainsPosition {
  fy: string;
  /** Every disposal that fell in this financial year, in the caller's order. */
  events: CgtEvent[];
  /** Gross proceeds and cost base for the year — the return's labels, not the tax. */
  proceeds: number;
  costBase: number;

  /** Gains before any loss or discount, split the four ways losses care about. */
  grossGains: Record<GainBucket, number>;
  grossGainsTotal: number;
  /** Losses made this year, by pool. */
  currentYearLosses: CapitalLossPools;
  /** Unapplied losses carried into the year, by pool. */
  broughtForward: CapitalLossPools;

  /** Step 5, line by line: which loss reduced which gain. */
  lossApplications: LossApplication[];
  lossesApplied: number;
  /** What is left of each bucket after step 5. */
  gainsAfterLosses: Record<GainBucket, number>;
  gainsAfterLossesTotal: number;

  /** Step 7 — 50% of whatever survived in the two discountable buckets. */
  discount: number;
  /** Step 8 — the assessable figure. Never negative. */
  netCapitalGain: number;
  /** Unapplied losses leaving the year, by pool. Carried forward indefinitely. */
  carriedForward: CapitalLossPools;
  carriedForwardTotal: number;

  /** Gains and losses ignored under the $500 collectable rule. */
  exemptAmount: number;
  warnings: CapitalGainsWarning[];
  /** Provenance and scope, rendered by the UI beside the number. */
  notes: string[];
}

function emptyBuckets(): Record<GainBucket, number> {
  return { 'other': 0, 'collectable-other': 0, 'discount': 0, 'collectable-discount': 0 };
}

/** Which bucket an allocation's gain belongs in. */
function bucketFor(assetClass: CgtAssetClass, discountEligible: boolean): GainBucket {
  if (assetClass === 'collectable') return discountEligible ? 'collectable-discount' : 'collectable-other';
  return discountEligible ? 'discount' : 'other';
}

/**
 * Build the year's CGT position from events that have ALREADY been matched
 * against parcels (see matchDisposals — the matching spans every year, so it
 * cannot be done inside a single financial year).
 *
 * `broughtForward` is what an earlier year left unapplied. Nothing here goes
 * looking for it; `rollForwardCapitalGains` chains the years, and the opening
 * balance for the first year comes off the user's last lodged return.
 */
export function buildCapitalGainsPosition(input: {
  fy: string;
  events: CgtEvent[];
  broughtForward?: Partial<CapitalLossPools> | null;
}): CapitalGainsPosition {
  const { fy } = input;
  const events = input.events.filter(e => e.fy === fy);

  const broughtForward: CapitalLossPools = {
    ordinary: amount(input.broughtForward?.ordinary),
    collectable: amount(input.broughtForward?.collectable),
  };

  // ── Steps 1–4: sort every allocation into a gain bucket or a loss pool. ──
  const grossGains = emptyBuckets();
  const currentYearLosses = emptyLossPools();
  let proceeds = 0;
  let costBase = 0;
  let exemptAmount = 0;
  let dateUnknownGain = 0;
  let dateUnknownCount = 0;
  let noCostBase = 0;
  let noCostBaseCount = 0;
  let unparcelled = 0;
  let overDisposed = 0;
  let exemptCount = 0;

  for (const e of events) {
    proceeds = round2(proceeds + e.proceeds);
    costBase = round2(costBase + e.costBase);
    exemptAmount = round2(exemptAmount + e.exemptAmount);
    if (e.unparcelledQuantity > 1e-9) { if (e.hadParcels) overDisposed += 1; else unparcelled += 1; }
    for (const a of e.allocations) {
      if (a.exempt) { exemptCount += 1; continue; }
      if (a.gain > 0) {
        grossGains[bucketFor(e.assetClass, a.discountEligible)] =
          round2(grossGains[bucketFor(e.assetClass, a.discountEligible)] + a.gain);
        if (a.dateUnknown) { dateUnknownGain = round2(dateUnknownGain + a.gain); dateUnknownCount += 1; }
      } else if (a.gain < 0) {
        const pool = e.assetClass === 'collectable' ? 'collectable' : 'ordinary';
        currentYearLosses[pool] = round2(currentYearLosses[pool] - a.gain);
      }
      if (a.source === 'unmatched') { noCostBase = round2(noCostBase + a.proceeds); noCostBaseCount += 1; }
    }
  }

  // ── Step 5: apply losses, non-discount gains first. ──────────────────────
  const remaining = { ...grossGains };
  const pools = {
    'collectable:current-year': currentYearLosses.collectable,
    'collectable:brought-forward': broughtForward.collectable,
    'ordinary:current-year': currentYearLosses.ordinary,
    'ordinary:brought-forward': broughtForward.ordinary,
  };
  const lossApplications: LossApplication[] = [];

  /**
   * Which buckets each pool may touch, in the order that minimises the tax.
   * A collectable loss is quarantined to collectable gains; an ordinary loss may
   * go anywhere, and goes to the undiscounted gains first because a dollar of
   * loss spent there saves a whole dollar of assessable gain instead of fifty
   * cents. Within a pool, this year's losses are spent before losses brought in,
   * following the statute; the totals are identical either way, because whatever
   * is not spent carries forward regardless.
   */
  const ORDER: Record<keyof CapitalLossPools, GainBucket[]> = {
    collectable: ['collectable-other', 'collectable-discount'],
    ordinary: ['other', 'collectable-other', 'discount', 'collectable-discount'],
  };

  for (const pool of ['collectable', 'ordinary'] as const) {
    for (const source of ['current-year', 'brought-forward'] as const) {
      const slot = `${pool}:${source}` as keyof typeof pools;
      for (const bucket of ORDER[pool]) {
        if (pools[slot] <= 0) break;
        if (remaining[bucket] <= 0) continue;
        const used = round2(Math.min(pools[slot], remaining[bucket]));
        pools[slot] = round2(pools[slot] - used);
        remaining[bucket] = round2(remaining[bucket] - used);
        lossApplications.push({
          key: `${slot}:${bucket}`,
          pool,
          source,
          against: bucket,
          amount: used,
        });
      }
    }
  }

  const lossesApplied = round2(lossApplications.reduce((s, l) => s + l.amount, 0));
  const carriedForward: CapitalLossPools = {
    ordinary: round2(pools['ordinary:current-year'] + pools['ordinary:brought-forward']),
    collectable: round2(pools['collectable:current-year'] + pools['collectable:brought-forward']),
  };

  // ── Step 7: the discount, on what survived in the discountable buckets. ──
  const discountable = round2(remaining['discount'] + remaining['collectable-discount']);
  const discount = round2(discountable * CGT_DISCOUNT_RATE);
  const gainsAfterLossesTotal = round2(
    (Object.keys(remaining) as GainBucket[]).reduce((s, b) => s + remaining[b], 0),
  );
  const netCapitalGain = round2(Math.max(0, gainsAfterLossesTotal - discount));

  // ── What the user should know before treating it as final. ───────────────
  const warnings: CapitalGainsWarning[] = [];
  if (dateUnknownGain > 0) {
    warnings.push({
      kind: 'acquisition-date-missing',
      severity: 'warn',
      count: dateUnknownCount,
      amount: dateUnknownGain,
      message:
        `${dateUnknownCount} gain${dateUnknownCount === 1 ? '' : 's'} ` +
        (dateUnknownCount === 1 ? 'has' : 'have') +
        ' no acquisition date, so no CGT discount was applied. Record when you bought' +
        ' those units — held twelve months and a day, half of this would not be taxed:',
    });
  }
  if (noCostBase > 0) {
    warnings.push({
      kind: 'cost-base-missing',
      severity: 'warn',
      count: noCostBaseCount,
      amount: noCostBase,
      message:
        `${noCostBaseCount} disposal${noCostBaseCount === 1 ? '' : 's'} ` +
        (noCostBaseCount === 1 ? 'has' : 'have') +
        ' no cost base recorded, so the entire proceeds are being counted as a gain:',
    });
  }
  if (unparcelled > 0) {
    warnings.push({
      kind: 'unparcelled-units',
      severity: 'info',
      count: unparcelled,
      message:
        `${unparcelled} disposal${unparcelled === 1 ? '' : 's'} used the cost base recorded on the sale ` +
        'rather than a parcel. Add the parcels you bought and each sale gets its real acquisition date.',
    });
  }
  if (overDisposed > 0) {
    warnings.push({
      kind: 'over-disposed',
      severity: 'warn',
      count: overDisposed,
      message:
        `${overDisposed} disposal${overDisposed === 1 ? '' : 's'} sold more units than your recorded ` +
        'parcels ever held. The extra units used the cost base on the sale itself — check the parcels.',
    });
  }
  if (carriedForward.collectable > 0) {
    warnings.push({
      kind: 'collectable-loss-quarantined',
      severity: 'info',
      amount: carriedForward.collectable,
      message:
        'A capital loss on a collectable can only be deducted from a gain on another collectable, ' +
        'so it carries forward separately:',
    });
  }
  if (netCapitalGain === 0 && carriedForward.ordinary > 0) {
    warnings.push({
      kind: 'net-capital-loss',
      severity: 'info',
      amount: carriedForward.ordinary,
      message:
        'This year is a net capital loss. It cannot reduce your other income, but it carries ' +
        'forward indefinitely against future capital gains:',
    });
  }
  const bfApplied = round2(
    lossApplications.filter(l => l.source === 'brought-forward').reduce((s, l) => s + l.amount, 0),
  );
  if (bfApplied > 0) {
    warnings.push({
      kind: 'brought-forward-applied',
      severity: 'info',
      amount: bfApplied,
      message: 'Capital losses carried in from earlier years were applied to this year\'s gains:',
    });
  }
  if (exemptCount > 0) {
    warnings.push({
      kind: 'collectable-exempt',
      severity: 'info',
      count: exemptCount,
      message:
        `${exemptCount} collectable${exemptCount === 1 ? '' : 's'} acquired for $500 or less ` +
        (exemptCount === 1 ? 'was' : 'were') + ' left out entirely — a gain or loss on one is ignored.',
    });
  }
  const notes: string[] = [];
  if (fy >= ANNOUNCED_CHANGES_FROM_FY) {
    notes.push(
      'Capital gains changes announced in the 2026–27 Federal Budget are not modelled. ' +
      'The ATO states they do not apply to Tax Time 2026 and has not published guidance yet.',
    );
    warnings.push({
      kind: 'announced-changes',
      severity: 'info',
      message:
        'Announced CGT changes for this year are not modelled — the ATO has not published the rules yet.',
    });
  }
  notes.push(
    'Indexation for assets held since before 21 September 1999, personal-use assets, ' +
    'the main-residence exemption, property disposals and small-business concessions are not modelled.',
  );

  return {
    fy,
    events,
    proceeds,
    costBase,
    grossGains,
    grossGainsTotal: round2(
      (Object.keys(grossGains) as GainBucket[]).reduce((s, b) => s + grossGains[b], 0),
    ),
    currentYearLosses,
    broughtForward,
    lossApplications,
    lossesApplied,
    gainsAfterLosses: remaining,
    gainsAfterLossesTotal,
    discount,
    netCapitalGain,
    carriedForward,
    carriedForwardTotal: round2(carriedForward.ordinary + carriedForward.collectable),
    exemptAmount,
    warnings,
    notes,
  };
}

// ─── Chaining the years ─────────────────────────────────────────────────────

/** The opening position: what a lodged return says was unapplied, and when. */
export interface OpeningCapitalLosses {
  /** The first financial year Ledger is responsible for. */
  fy: string;
  ordinary: number;
  collectable: number;
}

export function emptyOpeningLosses(fy: string): OpeningCapitalLosses {
  return { fy, ordinary: 0, collectable: 0 };
}

/**
 * Every financial year with a disposal in it, oldest first. The chain has to
 * start somewhere earlier than the year being asked about, or a loss made two
 * years ago would never reach it.
 */
export function capitalGainsYears(events: CgtEvent[]): string[] {
  return [...new Set(events.map(e => e.fy))].sort();
}

/**
 * Roll the loss pools forward from the opening balance through to `fy`, and
 * return that year's position. Every year in between is computed, in order,
 * because each one's carry-forward is the next one's opening balance.
 *
 * A LOSS NEVER TRAVELS BACKWARDS. Years before the opening year are computed
 * with no brought-forward balance at all: the opening figure came off a lodged
 * return, and re-deriving an already-filed year from Ledger's own records would
 * silently contradict it. Same rule as the deduction engine's refunds.
 */
export function rollForwardCapitalGains(input: {
  fy: string;
  events: CgtEvent[];
  opening?: OpeningCapitalLosses | null;
}): { position: CapitalGainsPosition; history: CapitalGainsPosition[] } {
  // An opening balance measured at the start of FY X says nothing about FY X−1,
  // and applying it backwards would contradict a return the ATO has accepted.
  const declared = input.opening ?? null;
  const opening = declared && input.fy >= declared.fy ? declared : null;
  const years = capitalGainsYears(input.events)
    .filter(y => y <= input.fy && (!opening || y >= opening.fy));
  if (!years.includes(input.fy)) years.push(input.fy);
  years.sort();

  let carried: CapitalLossPools = opening
    ? { ordinary: amount(opening.ordinary), collectable: amount(opening.collectable) }
    : emptyLossPools();

  const history: CapitalGainsPosition[] = [];
  let position: CapitalGainsPosition | null = null;

  for (const y of years) {
    const p = buildCapitalGainsPosition({ fy: y, events: input.events, broughtForward: carried });
    carried = p.carriedForward;
    history.push(p);
    if (y === input.fy) position = p;
  }

  return { position: position!, history };
}

/**
 * The one call the rest of Ledger makes: parcels and disposals in, this year's
 * position out, with every earlier year rolled forward on the way.
 */
export function buildCapitalGains(input: {
  fy: string;
  parcels?: CgtParcel[] | null;
  disposals: CgtDisposal[];
  splits?: CgtSplit[] | null;
  opening?: OpeningCapitalLosses | null;
}): CapitalGainsPosition & { remainders: ParcelRemainder[]; history: CapitalGainsPosition[] } {
  const { events, remainders } = matchDisposals({
    parcels: input.parcels ?? [],
    disposals: input.disposals,
    splits: input.splits ?? [],
  });
  const { position, history } = rollForwardCapitalGains({
    fy: input.fy,
    events,
    opening: input.opening ?? null,
  });

  // Currencies are checked here rather than inside the year, because the mixed
  // set is a property of the disposals the user recorded, not of the arithmetic.
  const currencies = new Set(
    input.disposals
      .filter(d => financialYearOf(isoDay(d.saleDate) ?? '') === input.fy)
      .map(d => (d.currency ?? '').trim().toUpperCase())
      .filter(Boolean),
  );
  const warnings = currencies.size > 1
    ? [...position.warnings, {
        kind: 'mixed-currency' as const,
        severity: 'warn' as const,
        count: currencies.size,
        message:
          `Disposals in ${currencies.size} different currencies were added together without ` +
          'converting them. Record the proceeds and cost in one currency.',
      }]
    : position.warnings;

  return { ...position, warnings, remainders, history };
}
