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
 *
 * ── Phase 4.3 — performance ─────────────────────────────────────────────────
 * Rent, expenses, yield and cash flow are added below, and they follow the same
 * rule: a property STORES nothing it doesn't own. There is no property ledger.
 * Rent is the money that already landed in the user's accounts and expenses are
 * the money that already left them — ordinary transactions, in their existing
 * categories. A property only says WHICH of them are its own (`match_terms`,
 * `match_account_ids`), and everything else is derived. The mortgage keeps
 * coming from the loan row, so a repayment is never counted both as a schedule
 * and as a transaction.
 */

import type { Property, PropertyType, PropertyHeldBy, Loan, Transaction } from '../types';
import { PERIODS_PER_YEAR, addPeriods, monthsBetween, todayISO } from './loanEngine';

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
//  Performance — rent, expenses, yield and cash flow (Phase 4.3)
// ═════════════════════════════════════════════════════════════════════════════
//
// ── Where the money comes from ───────────────────────────────────────────────
// Nowhere new. Rent is a credit that already reached a bank account and an
// expense is a debit that already left one, both sitting in `transactions` with
// the categories the rest of Ledger uses. A property claims the ones that are
// its own and derives everything else; nothing here is stored, so correcting a
// transaction corrects the yield, and deleting the property leaves the money
// exactly where it was.
//
// ── How a transaction is claimed ─────────────────────────────────────────────
// Two ways, and both are the user's explicit say-so — a property NEVER guesses,
// because a guessed rent payment is invented income:
//
//   • a dedicated ACCOUNT: everything on it belongs to this property. Exact.
//   • a match TERM ("ray white", "waverley council") found in the merchant, the
//     raw description or the notes. Fuzzy, so the more specific match wins.
//
// A transaction belongs to at most ONE property. When two would claim it the
// stronger match takes it — an account beats any term, a longer term beats a
// shorter one — so two properties can never both count the same rent.
//
// ── What is deliberately NOT counted ─────────────────────────────────────────
//   • transfers, including money the user moved into the property's own account:
//     that is the same dollar arriving, not rent;
//   • anything on a LOAN account: a mortgage repayment is already counted from
//     the loan's schedule, and counting the transaction too would double it.
//
// ── Ownership ────────────────────────────────────────────────────────────────
// Transactions are NOT scaled by ownership share, and that isn't an oversight:
// they are what actually moved through the user's own accounts, so a half-owner
// receiving half the rent has already recorded half the rent. The VALUE is the
// figure that gets scaled, which is why every yield below is quoted against
// `ownedValue` — the user's cash measured against the user's share of the house.

/** How a transaction was claimed by a property. */
export type PropertyMatchReason = 'account' | 'term';

export interface PropertyMatch {
  reason: PropertyMatchReason;
  /** The term that matched, when it was a term match. */
  term: string | null;
  /** How specific the match was. Higher wins when two properties both claim it. */
  strength: number;
}

/** An account match is stronger than any term, however long that term is. */
const ACCOUNT_MATCH_STRENGTH = 10_000;

/** The property's match terms, trimmed, lowercased and de-duplicated. */
export function matchTerms(p: Pick<Property, 'match_terms'>): string[] {
  const seen = new Set<string>();
  for (const raw of p.match_terms ?? []) {
    const term = clean(raw).toLowerCase();
    if (term) seen.add(term);
  }
  return [...seen];
}

/** The accounts wholly dedicated to this property. */
export function matchAccountIds(p: Pick<Property, 'match_account_ids'>): string[] {
  return [...new Set((p.match_account_ids ?? []).map(clean).filter(Boolean))];
}

/** True when the property has no way to recognise a transaction yet. */
export function hasMatchRules(p: Pick<Property, 'match_terms' | 'match_account_ids'>): boolean {
  return matchTerms(p).length > 0 || matchAccountIds(p).length > 0;
}

/** Everything about a transaction a match term is allowed to look at. */
function searchableText(t: Transaction): string {
  return `${t.merchant ?? ''} ${t.raw_description ?? ''} ${t.notes ?? ''}`.toLowerCase();
}

/** How this property claims that transaction, or null when it doesn't. */
export function matchProperty(
  t: Transaction,
  p: Pick<Property, 'match_terms' | 'match_account_ids'>,
): PropertyMatch | null {
  if (t.account_id && matchAccountIds(p).includes(t.account_id)) {
    return { reason: 'account', term: null, strength: ACCOUNT_MATCH_STRENGTH };
  }
  const text = searchableText(t);
  let best: PropertyMatch | null = null;
  for (const term of matchTerms(p)) {
    if (!text.includes(term)) continue;
    // The longest matching term wins even within one property, so the strength a
    // property brings to a contest is its most specific claim, not its first.
    if (!best || term.length > best.strength) best = { reason: 'term', term, strength: term.length };
  }
  return best;
}

/**
 * Sort every transaction into the property that claims it most specifically.
 *
 * Returned as a map of property id → its transactions, in the order they were
 * given. A transaction no property claims simply isn't in the map — it stays an
 * ordinary transaction, counted by budgets and spend reporting exactly as before.
 */
export function attributeTransactions(
  properties: Pick<Property, 'id' | 'match_terms' | 'match_account_ids'>[],
  transactions: Transaction[],
): Map<string, Transaction[]> {
  const out = new Map<string, Transaction[]>();
  for (const p of properties) out.set(p.id, []);

  for (const t of transactions) {
    let winner: { id: string; strength: number } | null = null;
    for (const p of properties) {
      const match = matchProperty(t, p);
      // Strictly greater, so the FIRST property listed keeps a tie — a stable
      // answer beats one that changes when a property is renamed or re-sorted.
      if (match && (!winner || match.strength > winner.strength)) {
        winner = { id: p.id, strength: match.strength };
      }
    }
    if (winner) out.get(winner.id)!.push(t);
  }
  return out;
}

/**
 * True when a claimed transaction is real property money.
 *
 * Excludes the two things that would otherwise be counted twice: an internal
 * transfer (the same dollar arriving somewhere else), and anything on a loan
 * account (the mortgage, which the loan's own schedule already accounts for).
 */
export function countsAsPropertyMoney(t: Transaction): boolean {
  if (t.account_type === 'loan') return false;
  if (t.is_transfer) return false;
  if (clean(t.category).toLowerCase() === 'transfer') return false;
  return true;
}

/** The signed amount, in the user's display currency where one was worked out. */
function txAmount(t: Transaction): number {
  return Number(t.display_amount ?? t.amount) || 0;
}

/** How often rent arrives, inferred from the gaps between payments. */
export type RentFrequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly';

export const RENT_PERIODS_PER_YEAR: Record<RentFrequency, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  quarterly: 4,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rent cycle, read from the dates rent actually arrived on.
 *
 * The MEDIAN gap, not the mean: one late payment or a change of agent shouldn't
 * turn a weekly tenancy into a fortnightly one. Null with fewer than two
 * payments — one payment says nothing about a cycle, and inventing one would put
 * a made-up annual rent on the screen.
 */
export function inferRentFrequency(dates: string[]): RentFrequency | null {
  const days = [...new Set(dates)].sort();
  if (days.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    gaps.push((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY_MS);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;

  if (median <= 0) return null;
  if (median <= 10) return 'weekly';
  if (median <= 20) return 'fortnightly';
  if (median <= 45) return 'monthly';
  if (median <= 130) return 'quarterly';
  return null;
}

/** One category's share of a property's expenses — the app's ordinary categories. */
export interface PropertyExpenseLine {
  category: string;
  amount: number;
  count: number;
}

/**
 * The stretch of time the performance figures cover: (start, end].
 *
 * Half-open on purpose. A window from the 1st of May to the 18th of August is
 * three months, and counting BOTH the 1st of May and the 1st of August would put
 * four monthly rent payments inside three months — a third more income than the
 * property earns. The end is inclusive so today's rent counts today.
 */
export interface PerformanceWindow {
  /** Exclusive: the day the window opens after. */
  start: string;
  /** Inclusive: usually today. */
  end: string;
  /** Whole months in the window, 1–12. */
  months: number;
  /** True when it covers less than a year, so the annual figures are scaled up. */
  partial: boolean;
}

/**
 * The trailing twelve months, never reaching back before the property was bought.
 *
 * Twelve months is what makes vacancy honest: an empty quarter is three months
 * of no rent inside the window, so it drags the annual figure and the yield down
 * on its own — nothing has to detect a vacancy for it to show up.
 *
 * A property bought four months ago gets a four-month window and its annual
 * figures are scaled up from it, which `partial` flags so the screen can say so.
 * Settlement day itself is outside the window (see PerformanceWindow): the
 * arithmetic has to match the months it claims to cover, and nothing that lands
 * on the day of purchase is rent anyway.
 */
export function performanceWindow(
  p: Pick<Property, 'purchase_date'>,
  asOf: string = todayISO(),
): PerformanceWindow {
  const end = asOf;
  const yearAgo = addPeriods(end, 'monthly', -12);
  const purchase = clean(p.purchase_date).slice(0, 10);
  const start = purchase && purchase > yearAgo ? purchase : yearAgo;
  const months = Math.max(1, Math.min(12, monthsBetween(start, end)));
  return { start, end, months, partial: months < 12 };
}

/** Everything a property earned, spent and cost over the window. */
export interface PropertyPerformance {
  window: PerformanceWindow;
  /** True when the user has told us how to recognise this property's transactions. */
  matched: boolean;
  /** Rent actually banked inside the window. */
  rentReceived: number;
  /** Expenses actually paid inside the window. */
  expensesPaid: number;
  /** rentReceived scaled to a full year — identical to it over a full window. */
  annualRent: number;
  annualExpenses: number;
  monthlyRent: number;
  monthlyExpenses: number;
  /** Expenses split across the categories they were already filed under. */
  expensesByCategory: PropertyExpenseLine[];
  /** Months in the window that brought in no rent at all. */
  vacantMonths: number;
  /** Share of the window that was tenanted, %. Null when it never was. */
  occupancyPercent: number | null;
  /** The most recent rent day and what arrived on it. */
  latestRent: { date: string; amount: number } | null;
  /** The cycle rent arrives on, read from the payment dates. */
  rentFrequency: RentFrequency | null;
  /**
   * What the CURRENT rent is worth over a year — the latest payment at its own
   * cycle. This is the figure that moves the moment the rent is put up, while
   * `annualRent` is the year that actually happened and catches up slowly.
   */
  currentAnnualRent: number | null;
  /** Scheduled mortgage repayments over a year, from the linked loan. */
  annualMortgage: number;
  monthlyMortgage: number;
  /** annualRent ÷ owned value, %. Null with no rent or no value. */
  grossYield: number | null;
  /** (annualRent − annualExpenses) ÷ owned value, %. Excludes the mortgage. */
  netYield: number | null;
  /** rent − expenses − mortgage. What the property does to the bank balance. */
  annualCashFlow: number;
  monthlyCashFlow: number;
  /** True when rent came in — an owner-occupied home is false and has no yield. */
  isIncomeProducing: boolean;
  /** Days rent arrived on, and the number of expense transactions counted. */
  rentPayments: number;
  expenseCount: number;
}

export interface PerformanceInput {
  /** Every transaction this property has claimed. Already attributed. */
  transactions: Transaction[];
  /** The user's share of the value — what the yields are measured against. */
  ownedValue: number;
  /** The mortgage, for cash flow. Its schedule is the cost, never a transaction. */
  loan: Loan | null;
  /** When it was bought — the window never reaches back past it. */
  purchaseDate?: string | null;
  asOf?: string;
  /** False when the property has no match rules, so "no rent" means "not set up". */
  matched?: boolean;
}

/**
 * A mortgage's scheduled cost over a year: the minimum plus whatever extra is
 * paid every period, at the loan's own frequency.
 *
 * Deliberately the SCHEDULE and not the interest. Cash flow asks what leaves the
 * account, and the whole repayment leaves it — the part that pays down principal
 * has simply moved into equity rather than being spent. Interest-only, offset
 * and rate changes are the loan engine's business; none of them change what is
 * debited each period, which is all this needs.
 */
export function annualMortgageCost(loan: Pick<Loan, 'minimum_repayment' | 'extra_repayment' | 'repayment_frequency'> | null): number {
  if (!loan) return 0;
  const ppy = PERIODS_PER_YEAR[loan.repayment_frequency ?? 'monthly'] ?? 12;
  const perPeriod = (Number(loan.minimum_repayment) || 0) + (Number(loan.extra_repayment) || 0);
  return r2(Math.max(0, perPeriod) * ppy);
}

const EMPTY_LINES: PropertyExpenseLine[] = [];

/** Work out one property's performance from the transactions it claimed. */
export function buildPerformance(input: PerformanceInput): PropertyPerformance {
  const asOf = input.asOf ?? todayISO();
  const window = performanceWindow({ purchase_date: input.purchaseDate ?? null }, asOf);
  const factor = 12 / window.months;

  const inWindow = input.transactions.filter(t => {
    const d = clean(t.date).slice(0, 10);
    return !!d && d > window.start && d <= window.end && countsAsPropertyMoney(t);
  });

  // Rent by DAY, not by transaction: an agent paying two lots on the same date is
  // one rent day, which keeps the cycle inference (and vacancy) honest.
  const rentByDay = new Map<string, number>();
  let expensesPaid = 0;
  let expenseCount = 0;
  const byCategory = new Map<string, { amount: number; count: number }>();

  for (const t of inWindow) {
    const amount = txAmount(t);
    if (amount > 0) {
      const day = clean(t.date).slice(0, 10);
      rentByDay.set(day, r2((rentByDay.get(day) ?? 0) + amount));
    } else if (amount < 0) {
      const magnitude = Math.abs(amount);
      expensesPaid = r2(expensesPaid + magnitude);
      expenseCount += 1;
      const category = clean(t.category) || 'Uncategorised';
      const line = byCategory.get(category) ?? { amount: 0, count: 0 };
      byCategory.set(category, { amount: r2(line.amount + magnitude), count: line.count + 1 });
    }
  }

  const rentDays = [...rentByDay.keys()].sort();
  const rentReceived = r2(rentDays.reduce((s, d) => s + (rentByDay.get(d) ?? 0), 0));

  // Vacancy is measured in month-buckets counted forward from the start of the
  // window, so the buckets always number exactly `months` however the calendar
  // falls.
  const tenanted = new Set<number>();
  for (const day of rentDays) {
    const bucket = Math.min(window.months - 1, Math.max(0, monthsBetween(window.start, day)));
    tenanted.add(bucket);
  }
  const vacantMonths = Math.max(0, window.months - tenanted.size);

  const rentFrequency = inferRentFrequency(rentDays);
  const latestDay = rentDays[rentDays.length - 1] ?? null;
  const latestRent = latestDay ? { date: latestDay, amount: rentByDay.get(latestDay)! } : null;
  const currentAnnualRent = latestRent && rentFrequency
    ? r2(latestRent.amount * RENT_PERIODS_PER_YEAR[rentFrequency])
    : null;

  const annualRent = r2(rentReceived * factor);
  const annualExpenses = r2(expensesPaid * factor);
  const annualMortgage = annualMortgageCost(input.loan);
  const owned = Number(input.ownedValue) || 0;

  // No rent means no yield — an owner-occupied home has none, and printing 0%
  // would read as a bad investment rather than as a house someone lives in.
  const canYield = annualRent > 0 && owned > 0;

  return {
    window,
    matched: input.matched !== false,
    rentReceived,
    expensesPaid,
    annualRent,
    annualExpenses,
    monthlyRent: r2(annualRent / 12),
    monthlyExpenses: r2(annualExpenses / 12),
    expensesByCategory: byCategory.size === 0 ? EMPTY_LINES : [...byCategory.entries()]
      .map(([category, line]) => ({ category, amount: line.amount, count: line.count }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    vacantMonths,
    occupancyPercent: rentDays.length === 0 ? null : r2(((window.months - vacantMonths) / window.months) * 100),
    latestRent,
    rentFrequency,
    currentAnnualRent,
    annualMortgage,
    monthlyMortgage: r2(annualMortgage / 12),
    grossYield: canYield ? r2((annualRent / owned) * 100) : null,
    netYield: canYield ? r2(((annualRent - annualExpenses) / owned) * 100) : null,
    annualCashFlow: r2(annualRent - annualExpenses - annualMortgage),
    monthlyCashFlow: r2((annualRent - annualExpenses - annualMortgage) / 12),
    isIncomeProducing: annualRent > 0,
    rentPayments: rentDays.length,
    expenseCount,
  };
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
  /**
   * Rent, expenses, yield and cash flow over the trailing year (Phase 4.3).
   *
   * Present on every row: a property with no transactions supplied — or none
   * claimed — reports zeroes and null yields, which is the truthful answer for
   * an owner-occupied home and is what an unconfigured investment looks like
   * until its match rules are set (`performance.matched` tells them apart).
   */
  performance: PropertyPerformance;
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
    /** Rent across the portfolio over the trailing year, and what it costs to hold. */
    annualRent: number;
    annualExpenses: number;
    annualMortgage: number;
    annualCashFlow: number;
    monthlyCashFlow: number;
    /** Portfolio gross yield: total annual rent ÷ the owned value of the
     *  properties that EARN it. A home nobody rents doesn't dilute the figure —
     *  it isn't in the denominator, because it isn't in the numerator either. */
    grossYield: number | null;
    netYield: number | null;
    /** How many properties brought in rent over the window. */
    rented: number;
  };
}

/** The loan backing a property, or null when it is unencumbered. */
export function linkedLoan(p: Pick<Property, 'loan_id'>, loans: Loan[]): Loan | null {
  if (!p.loan_id) return null;
  return loans.find(l => l.id === p.loan_id) ?? null;
}

/** What the report needs beyond the properties themselves (Phase 4.3). */
export interface PropertyReportOptions {
  /**
   * The user's transactions. Every property claims its own out of this one list,
   * so the same transaction can't land on two properties — and any transaction
   * nobody claims goes on being an ordinary transaction everywhere else.
   */
  transactions?: Transaction[];
  /** The day the trailing year ends. Defaults to today. */
  asOf?: string;
}

/** Work out every property against the loans and funds it points at. */
export function buildPropertyReport(
  properties: Property[],
  loans: Loan[],
  funds: FundEntity[] = [],
  opts: PropertyReportOptions = {},
): PropertyReport {
  const asOf = opts.asOf ?? todayISO();
  const claimed = attributeTransactions(properties, opts.transactions ?? []);

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

    const performance = buildPerformance({
      transactions: claimed.get(p.id) ?? [],
      ownedValue: owned,
      loan,
      purchaseDate: p.purchase_date ?? null,
      asOf,
      matched: hasMatchRules(p),
    });

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
      performance,
    };
  });

  const earning = rows.filter(r => r.performance.isIncomeProducing);
  const earningValue = r2(earning.reduce((s, r) => s + r.ownedValue, 0));
  const annualRent = r2(rows.reduce((s, r) => s + r.performance.annualRent, 0));
  const annualExpenses = r2(rows.reduce((s, r) => s + r.performance.annualExpenses, 0));
  const annualMortgage = r2(rows.reduce((s, r) => s + r.performance.annualMortgage, 0));
  const annualCashFlow = r2(rows.reduce((s, r) => s + r.performance.annualCashFlow, 0));

  return {
    rows,
    totals: {
      annualRent,
      annualExpenses,
      annualMortgage,
      annualCashFlow,
      monthlyCashFlow: r2(annualCashFlow / 12),
      // Measured against the value of the properties that actually earn: a home
      // the user lives in has no yield of its own, so letting it into the
      // denominator would report the portfolio as yielding half what it does.
      grossYield: earningValue > 0 ? r2((annualRent / earningValue) * 100) : null,
      netYield: earningValue > 0 ? r2(((annualRent - annualExpenses) / earningValue) * 100) : null,
      rented: earning.length,
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
  match_terms?: string[] | null;
  match_account_ids?: string[] | null;
}

/** The shortest match term that can be trusted to mean one property. */
export const MIN_MATCH_TERM_LENGTH = 3;

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

  // A one- or two-letter term matches half the statement, and every transaction
  // it swept up would be reported as this property's rent or expenses. Refused
  // here rather than quietly ignored, so the user knows the term isn't working.
  const tooShort = (draft.match_terms ?? [])
    .map(t => clean(t))
    .filter(t => t.length > 0 && t.length < MIN_MATCH_TERM_LENGTH);
  if (tooShort.length > 0) {
    errors.push(`Match text must be at least ${MIN_MATCH_TERM_LENGTH} characters — "${tooShort[0]}" is too broad.`);
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
