/**
 * Phase 4.1 — the property engine.
 *
 * Pure arithmetic over properties, the loans they point at and the funds that
 * hold them. No store, no React, no I/O — everything the Property tab and net
 * worth show is derived here so the screen can only ever say what the maths says.
 *
 * ── The one rule that shapes this file ──────────────────────────────────────
 * Every figure a property touches must be counted EXACTLY ONCE, and there are
 * two places it could go wrong:
 *
 *   1. THE MORTGAGE. A property is an ASSET; its mortgage is an ORDINARY LOAN
 *      that already reduces net worth through the loans total. So the property
 *      contributes its value and never nets the balance off:
 *
 *        net-worth contribution  =  current_value × ownership share
 *        equity                  =  that value − the linked balance   (DISPLAY)
 *
 *   2. THE FUND. An SMSF-held property is usually already listed among the
 *      fund's assets, and the fund's balance is what net worth counts. When
 *      `counted_in_fund_balance` says so, the property contributes NOTHING of
 *      its own — the fund is carrying the value — while equity, LVR and gain
 *      still display normally.
 *
 * `netWorthEffect` re-derives a property's true effect from BOTH sides (asset
 * here or in the fund, debt via loans) so a test can prove the total never
 * drifts from the sum of its parts.
 *
 * Ownership share applies to the VALUE only, never to the loan. The loan row
 * holds the balance the user actually owes, whatever slice of the house that
 * money bought — scaling it by ownership would invent a debt nobody has.
 */

import type { Property, PropertyType, PropertyHeldBy, Loan } from '../types';

const r2 = (n: number): number => parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));
const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** Human labels for each property type, in the order the picker offers them. */
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  home: 'Home',
  investment: 'Investment',
  holiday: 'Holiday home',
  land: 'Land',
  commercial: 'Commercial',
  other: 'Other',
};

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_LABELS) as PropertyType[];

/** Human labels for who holds the property. */
export const HELD_BY_LABELS: Record<PropertyHeldBy, string> = {
  personal: 'Personal',
  joint: 'Joint',
  smsf: 'SMSF',
};

export const HELD_BY_OPTIONS = Object.keys(HELD_BY_LABELS) as PropertyHeldBy[];

/** How a property is held. Rows written before the field existed are personal. */
export function heldBy(p: Pick<Property, 'held_by'>): PropertyHeldBy {
  return p.held_by === 'joint' || p.held_by === 'smsf' ? p.held_by : 'personal';
}

// ═════════════════════════════════════════════════════════════════════════════
//  Address
// ═════════════════════════════════════════════════════════════════════════════

/** Australian states/territories, offered when the country is Australia. */
export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

export const DEFAULT_COUNTRY = 'Australia';

/** True when the country is Australia, so a state DROPDOWN is the right control. */
export function isAustralia(country: string | null | undefined): boolean {
  const c = clean(country).toLowerCase();
  return c === '' || c === 'australia' || c === 'au' || c === 'aus';
}

export interface AddressParts {
  unit: string;
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  country: string;
}

/** The structured address, trimmed, with the country defaulted. */
export function addressParts(p: Partial<Property>): AddressParts {
  return {
    unit: clean(p.address_unit),
    street: clean(p.address_street),
    suburb: clean(p.address_suburb),
    state: clean(p.address_state),
    postcode: clean(p.address_postcode),
    country: clean(p.address_country) || DEFAULT_COUNTRY,
  };
}

/**
 * Street line: "12/34 Beach Rd" for a unit number, "Lot 7, Beach Rd" for
 * anything wordier. A bare number is the Australian unit convention; joining
 * "Lot 7" with a slash would read as nonsense, so it gets a comma instead.
 */
export function streetLine(parts: Pick<AddressParts, 'unit' | 'street'>): string {
  if (!parts.unit) return parts.street;
  if (!parts.street) return parts.unit;
  return /^[0-9]+[A-Za-z]?$/.test(parts.unit)
    ? `${parts.unit}/${parts.street}`
    : `${parts.unit}, ${parts.street}`;
}

/**
 * The address as one readable line.
 *
 * `short` drops the country and postcode — enough to recognise the place in a
 * list ("12/34 Beach Rd, Bondi"), which is what a derived label needs. Legacy
 * rows with only the old free-text `address` fall back to it, so a property
 * entered before this refinement still reads correctly.
 */
export function formatAddress(p: Partial<Property>, opts: { short?: boolean } = {}): string {
  const parts = addressParts(p);
  const street = streetLine(parts);
  if (!street && !parts.suburb) return clean(p.address);

  const segments = [street];
  if (opts.short) {
    if (parts.suburb) segments.push(parts.suburb);
    return segments.filter(Boolean).join(', ');
  }
  const region = [parts.suburb, parts.state, parts.postcode].filter(Boolean).join(' ');
  if (region) segments.push(region);
  if (parts.country) segments.push(parts.country);
  return segments.filter(Boolean).join(', ');
}

/**
 * What to call this property. The nickname when the user gave one, else the
 * short address — which is why the nickname can stay optional without leaving
 * anything unlabelled.
 */
export function propertyLabel(p: Partial<Property>): string {
  return clean(p.name) || formatAddress(p, { short: true }) || 'Property';
}

// ═════════════════════════════════════════════════════════════════════════════
//  Ownership
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The share of the property the user owns, as a 0–1 fraction.
 *
 * Missing/garbage means sole ownership: a property entered before the field
 * existed, or with a blank box, is the user's own house until they say
 * otherwise. Out-of-range values are clamped rather than trusted, because a
 * typo'd 1000% would otherwise multiply their net worth by ten.
 */
export function ownershipShare(p: Pick<Property, 'ownership_percent'>): number {
  const pct = Number(p.ownership_percent);
  if (!Number.isFinite(pct)) return 1;
  return Math.min(100, Math.max(0, pct)) / 100;
}

/** The slice of the property's value that belongs to this user. */
export function ownedValue(p: Pick<Property, 'ownership_percent' | 'current_value'>): number {
  return r2((Number(p.current_value) || 0) * ownershipShare(p));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Fund holding (the SMSF double-count guard)
// ═════════════════════════════════════════════════════════════════════════════

/** A fund a property can be held in: an SMSF, or a super fund held as a balance. */
export interface FundEntity {
  kind: 'smsf' | 'super';
  id: string;
  name: string;
  /** Whether the fund itself feeds net worth. Display only — see countedInFund. */
  includeInNetWorth?: boolean;
}

/** Which fund this property points at, or null when it isn't held in one. */
export function fundLink(p: Pick<Property, 'smsf_fund_id' | 'super_fund_id'>): { kind: 'smsf' | 'super'; id: string } | null {
  if (p.smsf_fund_id) return { kind: 'smsf', id: p.smsf_fund_id };
  if (p.super_fund_id) return { kind: 'super', id: p.super_fund_id };
  return null;
}

/** The linked fund, resolved against a list of the user's funds. */
export function linkedFund(
  p: Pick<Property, 'smsf_fund_id' | 'super_fund_id'>,
  funds: FundEntity[],
): FundEntity | null {
  const link = fundLink(p);
  if (!link) return null;
  return funds.find(f => f.kind === link.kind && f.id === link.id) ?? null;
}

/**
 * Whether the holding fund's balance already carries this property's value.
 *
 * When true the property must NOT add its value to net worth: the fund's balance
 * (an SMSF's asset rows, or a super fund's balance) is already counting it, and
 * adding it here as well would inflate net worth by the whole property.
 *
 * Deliberately a property-LOCAL question — it never consults the fund's own
 * include_in_net_worth toggle. The backend has that flag and the browser doesn't
 * (SMSF data isn't in the client store), so reading it here would let the two
 * net-worth implementations disagree, which is a worse failure than the honest
 * one this rule has: switch the fund off and the value is excluded on BOTH
 * sides, exactly as if the property were excluded too.
 */
export function countedInFund(p: Pick<Property, 'held_by' | 'smsf_fund_id' | 'super_fund_id' | 'counted_in_fund_balance'>): boolean {
  if (heldBy(p) !== 'smsf') return false;
  if (!fundLink(p)) return false;
  return p.counted_in_fund_balance !== false;
}

/**
 * What the property adds to net worth: its owned value, and nothing else.
 * Zero when the user opted it out (the same switch loans and super carry), and
 * zero when the holding fund is already counting it.
 */
export function netWorthValue(
  p: Pick<Property, 'ownership_percent' | 'current_value' | 'include_in_net_worth' | 'held_by' | 'smsf_fund_id' | 'super_fund_id' | 'counted_in_fund_balance'>,
): number {
  if (p.include_in_net_worth === false) return 0;
  if (countedInFund(p)) return 0;
  return ownedValue(p);
}

/** Owned share of every property, i.e. the `property` line of net worth. */
export function propertyNetWorthTotal(properties: Property[]): number {
  return r2(properties.reduce((sum, p) => sum + netWorthValue(p), 0));
}

// ═════════════════════════════════════════════════════════════════════════════
//  The report
// ═════════════════════════════════════════════════════════════════════════════

/** One property, fully worked out. */
export interface PropertyRow {
  id: string;
  /** Nickname if given, else the short address — never blank. */
  name: string;
  /** The nickname alone, or null when the label came from the address. */
  nickname: string | null;
  /** Full address on one line, or '' when nothing is on file. */
  address: string;
  addressParts: AddressParts;
  type: PropertyType;
  typeLabel: string;
  heldBy: PropertyHeldBy;
  heldByLabel: string;
  /** The fund holding it, when it is SMSF-held and the fund could be resolved. */
  fund: { kind: 'smsf' | 'super'; id: string; name: string } | null;
  /** True when the fund's balance already includes this value (so it isn't added here). */
  countedInFundBalance: boolean;
  /** Full market value, regardless of who owns it. */
  value: number;
  ownershipPercent: number;
  /** The user's slice of `value`. */
  ownedValue: number;
  /** What this property itself contributes to net worth (0 if excluded or in a fund). */
  netWorthValue: number;
  purchasePrice: number;
  purchaseDate: string | null;
  /** Owned value − owned share of the purchase price. Null with no price on file. */
  gain: number | null;
  gainPercent: number | null;
  loan: { id: string; name: string; balance: number } | null;
  /** The linked loan's balance in full (never scaled by ownership). 0 if unlinked. */
  debt: number;
  /** ownedValue − debt. What the user would keep if they sold and repaid. */
  equity: number;
  /** Debt as a % of owned value. Null when unlinked or the value is 0. */
  lvr: number | null;
  countsTowardNetWorth: boolean;
  /** Whether the linked loan is itself counted as debt in net worth. */
  debtCountsTowardNetWorth: boolean;
  /**
   * The property's TRUE effect on net worth once its mortgage is accounted for
   * on the loans side: netWorthValue − (debt, if that loan counts).
   *
   * This equals `equity` in the ordinary case, and is the number that makes
   * double-counting detectable: net worth may move by this and no more.
   */
  netWorthEffect: number;
}

export interface PropertyReport {
  rows: PropertyRow[];
  totals: {
    /** Full market value of everything, ignoring ownership. */
    value: number;
    /** Sum of owned values, whether or not each one feeds net worth. */
    ownedValue: number;
    /** The part of ownedValue a fund is already counting — NOT added by net worth. */
    countedInFunds: number;
    /** Sum of what the properties themselves add — the `property` line of net worth. */
    netWorthValue: number;
    /** Sum of linked loan balances. Each loan appears once: a loan can back one
     *  property, so this can never double-count a mortgage. */
    debt: number;
    equity: number;
    /** Σ netWorthEffect — the amount properties (and their mortgages) move net worth. */
    netWorthEffect: number;
    count: number;
  };
}

/** The loan backing a property, or null when it is unencumbered. */
export function linkedLoan(p: Pick<Property, 'loan_id'>, loans: Loan[]): Loan | null {
  if (!p.loan_id) return null;
  return loans.find(l => l.id === p.loan_id) ?? null;
}

/** Work out every property against the loans and funds it points at. */
export function buildPropertyReport(
  properties: Property[],
  loans: Loan[],
  funds: FundEntity[] = [],
): PropertyReport {
  const rows: PropertyRow[] = properties.map(p => {
    const loan = linkedLoan(p, loans);
    const share = ownershipShare(p);
    const owned = ownedValue(p);
    const debt = loan ? Number(loan.current_balance) || 0 : 0;
    const counts = p.include_in_net_worth !== false;
    // Legacy loans saved before the flag existed have it undefined → included,
    // matching how the net-worth engine reads them.
    const debtCounts = !!loan && loan.include_in_net_worth !== false;
    const inFund = countedInFund(p);
    const link = fundLink(p);
    const fund = linkedFund(p, funds);

    const purchasePrice = Number(p.purchase_price) || 0;
    // The gain is measured on the same footing as the value: the user's slice of
    // what it cost against the user's slice of what it's worth. Comparing an owned
    // value with a whole purchase price would read as a loss on every joint buy.
    const ownedCost = r2(purchasePrice * share);
    const gain = purchasePrice > 0 ? r2(owned - ownedCost) : null;
    const contributed = netWorthValue(p);

    return {
      id: p.id,
      name: propertyLabel(p),
      nickname: clean(p.name) || null,
      address: formatAddress(p),
      addressParts: addressParts(p),
      type: p.property_type,
      typeLabel: PROPERTY_TYPE_LABELS[p.property_type] ?? 'Property',
      heldBy: heldBy(p),
      heldByLabel: HELD_BY_LABELS[heldBy(p)],
      // A link the fund list can't resolve (fund deleted, or the list wasn't
      // supplied) still reports the link, unnamed — so the UI can say "held in a
      // fund" rather than silently presenting it as personally held.
      fund: link ? { kind: link.kind, id: link.id, name: fund?.name ?? 'Fund' } : null,
      countedInFundBalance: inFund,
      value: r2(Number(p.current_value) || 0),
      ownershipPercent: r2(share * 100),
      ownedValue: owned,
      netWorthValue: contributed,
      purchasePrice: r2(purchasePrice),
      purchaseDate: p.purchase_date ?? null,
      gain,
      gainPercent: gain !== null && ownedCost > 0 ? r2((gain / ownedCost) * 100) : null,
      loan: loan ? { id: loan.id, name: loan.name, balance: r2(debt) } : null,
      debt: r2(debt),
      equity: r2(owned - debt),
      lvr: loan && owned > 0 ? r2((debt / owned) * 100) : null,
      countsTowardNetWorth: counts,
      debtCountsTowardNetWorth: debtCounts,
      netWorthEffect: r2(contributed - (debtCounts ? debt : 0)),
    };
  });

  return {
    rows,
    totals: {
      value: r2(rows.reduce((s, r) => s + r.value, 0)),
      ownedValue: r2(rows.reduce((s, r) => s + r.ownedValue, 0)),
      countedInFunds: r2(rows.reduce((s, r) => s + (r.countedInFundBalance ? r.ownedValue : 0), 0)),
      netWorthValue: r2(rows.reduce((s, r) => s + r.netWorthValue, 0)),
      debt: r2(rows.reduce((s, r) => s + r.debt, 0)),
      equity: r2(rows.reduce((s, r) => s + r.equity, 0)),
      netWorthEffect: r2(rows.reduce((s, r) => s + r.netWorthEffect, 0)),
      count: rows.length,
    },
  };
}

/**
 * The loans a property may link to: every loan not already backing a DIFFERENT
 * property, with mortgages first because that is what the user is looking for.
 *
 * Filtering here is what stops one balance being netted against two properties
 * from the UI; the backend refuses the same link independently, so a stale tab
 * can't get around it.
 */
export function availableLoansForProperty(
  loans: Loan[],
  properties: Property[],
  propertyId?: string | null,
): Loan[] {
  const taken = new Set(
    properties.filter(p => p.id !== propertyId && p.loan_id).map(p => p.loan_id as string),
  );
  return loans
    .filter(l => !taken.has(l.id))
    .sort((a, b) => {
      const am = a.loan_type === 'mortgage' ? 0 : 1;
      const bm = b.loan_type === 'mortgage' ? 0 : 1;
      return am !== bm ? am - bm : a.name.localeCompare(b.name);
    });
}

/**
 * Funds a property may be held in, SMSFs first.
 *
 * Unlike a loan, a fund is NOT exclusive — one SMSF commonly holds several
 * properties, so nothing is filtered out here.
 */
export function availableFundsForProperty(funds: FundEntity[]): FundEntity[] {
  return [...funds].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'smsf' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  Validation
// ═════════════════════════════════════════════════════════════════════════════

/** What the user typed, before it becomes a Property. */
export interface PropertyDraft {
  name?: string | null;
  address_unit?: string | null;
  address_street?: string | null;
  address_suburb?: string | null;
  address_state?: string | null;
  address_postcode?: string | null;
  address_country?: string | null;
  current_value: number;
  purchase_price?: number;
  ownership_percent?: number;
  loan_id?: string | null;
  held_by?: PropertyHeldBy;
  smsf_fund_id?: string | null;
  super_fund_id?: string | null;
  counted_in_fund_balance?: boolean;
}

export interface PropertyValidationCtx {
  loans: Loan[];
  properties: Property[];
  propertyId?: string | null;
  /** The user's funds. Omit/empty to skip the "fund still exists" check — used
   *  when the fund list hasn't loaded, so a slow API can't block a save. */
  funds?: FundEntity[];
}

/**
 * Reasons a draft can't be saved, in the order they should be shown. Empty
 * means it's good. The link checks mirror the server's, so the user is told
 * before the write rather than by a rejected sync.
 *
 * The address is required (the nickname isn't): a property is a place, and a
 * half-entered address can't be grouped, sorted or matched later.
 */
export function validateProperty(draft: PropertyDraft, ctx: PropertyValidationCtx): string[] {
  const errors: string[] = [];

  const parts = addressParts(draft);
  if (!parts.street) errors.push('Street address is required.');
  if (!parts.suburb) errors.push('Suburb / locality is required.');
  if (!parts.state) errors.push('State is required.');
  if (!parts.postcode) errors.push('Postcode is required.');
  // Checked against the RAW field, not addressParts: that defaults a blank
  // country to Australia for DISPLAY, which would make this check unreachable and
  // silently file an overseas property in the wrong country.
  if (!clean(draft.address_country)) errors.push('Country is required.');

  if (!Number.isFinite(draft.current_value) || draft.current_value < 0) {
    errors.push('Current value must be zero or more.');
  }
  if (draft.purchase_price != null && (!Number.isFinite(draft.purchase_price) || draft.purchase_price < 0)) {
    errors.push('Purchase price must be zero or more.');
  }
  const pct = draft.ownership_percent;
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    errors.push('Ownership must be between 0% and 100%.');
  }

  if (draft.loan_id) {
    const loan = ctx.loans.find(l => l.id === draft.loan_id);
    if (!loan) {
      errors.push('That loan no longer exists.');
    } else {
      const other = ctx.properties.find(p => p.id !== ctx.propertyId && p.loan_id === draft.loan_id);
      if (other) errors.push(`That loan is already linked to "${propertyLabel(other)}".`);
    }
  }

  // ── Fund link ──────────────────────────────────────────────────────────────
  const held = draft.held_by ?? 'personal';
  const link = fundLink(draft);
  if (draft.smsf_fund_id && draft.super_fund_id) {
    errors.push('A property can be held in only one fund.');
  } else if (held === 'smsf' && !link) {
    errors.push('Choose the SMSF or super fund that holds this property.');
  } else if (held !== 'smsf' && link) {
    errors.push(`A ${HELD_BY_LABELS[held].toLowerCase()} property can't be held in a fund.`);
  } else if (link && ctx.funds !== undefined) {
    const known = ctx.funds.filter(f => f.kind === link.kind);
    // A SUPER link is always checkable: super funds live in the store, already
    // scoped to the signed-in user, so an id that isn't there is somebody else's
    // (or deleted). An SMSF link is only checkable once the fetched SMSF list has
    // arrived — with none known we can't tell "gone" from "not loaded yet", and
    // refusing the save would strand an offline edit of a real property. The
    // server re-checks ownership either way, so nothing crosses users.
    const checkable = link.kind === 'super' || known.length > 0;
    if (checkable && !known.some(f => f.id === link.id)) errors.push('That fund no longer exists.');
  }

  return errors;
}
