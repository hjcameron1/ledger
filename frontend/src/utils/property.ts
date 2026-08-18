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
 *      normally contributes its value and lets the loans side net the balance:
 *
 *        net-worth contribution  =  current_value × ownership share
 *        equity                  =  that value − the linked balance   (DISPLAY)
 *
 *      With ONE exception, because a loan carries its own net-worth switch: when
 *      that switch is off the loans total skips the mortgage, so the property
 *      subtracts it instead (`uncountedMortgage`). Either the loans total nets it
 *      or the property does — never both, and never neither. A $1m house with
 *      $800k owing moves net worth by $200k however the switches are set.
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
 *
 * ── Rent is a separate question from expenses ───────────────────────────────
 * Every property has costs; only a let one has income. So the two are matched
 * by two different rules, and one of them doesn't exist for a home:
 *
 *   EXPENSES  `match_terms` / `match_account_ids` — strata, council rates,
 *             water, insurance, maintenance, utilities and anything else.
 *             Available to every property, owner-occupied included.
 *   RENT      `rent_match_terms` (who pays it, normally captured by pointing at
 *             a real rent transaction), `rent_account_id` (where it lands) and
 *             an expected amount + frequency. Investment property only:
 *             `isOwnerOccupied` makes a credit against a home un-rentable, so
 *             an insurance payout on the family house can never be reported as
 *             rental income, whatever the user typed in the expense rules.
 *
 * The expected amount is not stored income — nothing is derived from it alone.
 * It vouches for a credit in a SHARED account (where salary lands too), caps
 * what a single payment can plausibly be, and lets the screen say whether the
 * rent actually banked is running behind the rent that was agreed.
 *
 * ── Expenses are a LIST, not a blob ─────────────────────────────────────────
 * A property doesn't have "some costs": it has a strata levy, a council rate
 * notice, a water bill, an insurance premium and whatever the plumber charged.
 * Each is its own rule (`property_expenses`) carrying a name, the kind of cost
 * it is, what one bill should be, how often it falls due, the account it's paid
 * from and the biller as it appears on the statement. That is what lets the card
 * say a cost came in above what was expected, and what lets the NEXT one be
 * recognised the day it lands. The single `match_terms` box these replaced is
 * still honoured for properties saved before them, and nothing else.
 *
 * ── One payment is one match ────────────────────────────────────────────────
 * Everything above runs over `uniqueRealTransactions` — money that actually
 * moved, once. A payment can reach the store more than once (a bill marked paid
 * by hand and then imported from the bank, a statement re-imported over a synced
 * account), and counting those copies would report rent that was never received.
 * See uniqueRealTransactions for exactly which copy survives and why.
 */

import type {
  Property, PropertyType, PropertyHeldBy, Loan, Transaction,
  PropertyExpenseRule, PropertyExpenseKind, PropertyExpenseFrequency,
} from '../types';
import { PERIODS_PER_YEAR, addPeriods, monthsBetween, todayISO } from './loanEngine';
import { contentHashOf } from './transactionCore';
import { normaliseMerchant } from './recurringDetection';

export type { PropertyExpenseRule, PropertyExpenseKind, PropertyExpenseFrequency };

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
 * The linked mortgage that the LOANS total is NOT going to subtract.
 *
 * Net worth subtracts every loan the user has opted in, and a property's mortgage
 * is one of those loans — which is why a property normally contributes its whole
 * owned value and lets the loans term do the netting. But the loan carries its own
 * `include_in_net_worth` switch, and when that is off nothing subtracts the
 * mortgage at all: a $1,000,000 house with $800,000 owing against it would add the
 * full $1,000,000, as though it were owned outright.
 *
 * So the debt falls to the property instead. The two are mutually exclusive by
 * construction — either the loans total subtracts the balance or this does, never
 * both — which is what makes "counted exactly once" true for every combination of
 * the two switches rather than only the default one.
 *
 * Zero when the property is unencumbered, when the loan can't be resolved (a list
 * that wasn't supplied, or a loan since deleted — in which case there is no
 * balance to trust), and when the loan is counted, as it is by default: rows saved
 * before the flag existed read undefined, which means included.
 */
export function uncountedMortgage(
  p: Pick<Property, 'loan_id'>,
  loans: Pick<Loan, 'id' | 'current_balance' | 'include_in_net_worth'>[],
): number {
  if (!p.loan_id) return 0;
  const loan = loans.find(l => l.id === p.loan_id);
  if (!loan) return 0;
  if (loan.include_in_net_worth !== false) return 0;
  return r2(Number(loan.current_balance) || 0);
}

/**
 * What the property adds to net worth.
 *
 * Its owned value, less any mortgage the loans total won't subtract (see
 * `uncountedMortgage` — normally none, so this is normally the owned value and
 * the debt is netted once, over on the loans side).
 *
 * Zero when the user opted the property out (the same switch loans and super
 * carry) — the debt is left to the loans total then, because switching an asset
 * off is not a claim that the money owed against it stopped being owed.
 *
 * When the holding fund is already counting the value there is no asset to add
 * here, but an uncounted mortgage is still subtracted: the fund's balance carries
 * what the property is WORTH, not what is owed against it.
 *
 * Can therefore be negative — a property mortgaged for more than it is worth
 * reduces net worth, which is the truth about it.
 */
export function netWorthValue(
  p: Pick<Property, 'ownership_percent' | 'current_value' | 'include_in_net_worth' | 'held_by' | 'smsf_fund_id' | 'super_fund_id' | 'counted_in_fund_balance' | 'loan_id'>,
  loans: Pick<Loan, 'id' | 'current_balance' | 'include_in_net_worth'>[] = [],
): number {
  if (p.include_in_net_worth === false) return 0;
  const asset = countedInFund(p) ? 0 : ownedValue(p);
  return r2(asset - uncountedMortgage(p, loans));
}

/** What the properties add between them, i.e. the `property` line of net worth. */
export function propertyNetWorthTotal(
  properties: Property[],
  loans: Pick<Loan, 'id' | 'current_balance' | 'include_in_net_worth'>[] = [],
): number {
  return r2(properties.reduce((sum, p) => sum + netWorthValue(p, loans), 0));
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
export type PropertyMatchReason = 'account' | 'rent' | 'expense' | 'term';

export interface PropertyMatch {
  reason: PropertyMatchReason;
  /** The term that matched, when it was a term match. */
  term: string | null;
  /** The expense rule that claimed it, when one did. */
  ruleId: string | null;
  /** How specific the match was. Higher wins when two properties both claim it. */
  strength: number;
}

/** An account match is stronger than any term, however long that term is. */
const ACCOUNT_MATCH_STRENGTH = 10_000;
/**
 * A rent rule beats any expense term but not a wholly dedicated account — and a
 * NAMED payer beats a credit that only fits the expected amount.
 *
 * That gap matters when two properties are paid into the same account: without
 * it, a credit from one property's agent fits the other's expected rent just as
 * well, and whichever property happened to be listed first would take it.
 */
const RENT_PAYER_STRENGTH = 9_000;
const RENT_ACCOUNT_STRENGTH = 8_000;
/**
 * A named expense rule outranks the legacy free-text box (which scores only by
 * term length) and is outranked by rent — a credit from the rent payer is rent,
 * even when the strata manager's name happens to appear on it too.
 */
const EXPENSE_RULE_STRENGTH = 7_000;
const EXPENSE_ACCOUNT_STRENGTH = 6_000;

/**
 * Every field that decides which transactions a property owns.
 *
 * Partial on purpose: a half-filled form in the modal is checked against exactly
 * the same rules as a saved property, so what the preview shows is what the card
 * will show.
 */
export type PropertyRules = Partial<Pick<Property,
  | 'property_type'
  | 'match_terms'
  | 'match_account_ids'
  | 'rent_match_terms'
  | 'rent_account_id'
  | 'expected_rent_amount'
  | 'expected_rent_frequency'
  | 'property_expenses'
  | 'excluded_transaction_ids'
>>;

/**
 * A home the user lives in. It has costs and no income, so nothing about rent —
 * neither the setup nor the figures — belongs to it.
 *
 * Deliberately the narrowest possible reading: only `home` is owner-occupied.
 * A holiday house can be let for half the year and land is leased, so hiding
 * rent from those would take away a real answer; hiding it from a home only ever
 * removes a wrong one. A property with no type recorded is treated as a home,
 * because that is the safer mistake: no invented income.
 */
export function isOwnerOccupied(p: Pick<PropertyRules, 'property_type'>): boolean {
  return (p.property_type ?? 'home') === 'home';
}

/** True when this property can earn rent at all — the opposite of a home. */
export function canEarnRent(p: Pick<PropertyRules, 'property_type'>): boolean {
  return !isOwnerOccupied(p);
}

// ── Rent rules ───────────────────────────────────────────────────────────────

/** Who pays the rent, where it lands, and what one payment should look like. */
export interface RentRules {
  /** The payer, lowercased for matching. */
  terms: string[];
  /** The account rent arrives in, which may be shared with everything else. */
  accountId: string | null;
  /** What one payment should be. 0 when the user hasn't said. */
  amount: number;
  frequency: RentFrequency | null;
  /** amount × payments a year, or 0 when either half is missing. */
  annual: number;
}

/** How a credit was recognised as rent: by who sent it, or by where and how much. */
export type RentMatchReason = 'payer' | 'account';

export interface RentMatch {
  reason: RentMatchReason;
  /** The payer term that matched, when that's what identified it. */
  term: string | null;
}

/**
 * The band a payment must fall in to be claimed by the ACCOUNT ALONE.
 *
 * Tight, because on that path there is nothing else: no payer, no biller, just
 * "money moved in the account this property's money moves in". Half to
 * one-and-a-half times — the range this used to allow — is where a fortnight's
 * pay, a tax refund and a transfer from savings all sit alongside a week's
 * rent, which is exactly how somebody's salary ended up counted as rental
 * income. Within a tenth of the figure the user gave, on the cycle they gave it
 * for, is a coincidence worth acting on; anything looser is a guess dressed up
 * as a fact.
 */
const AMOUNT_FIT_MIN = 0.9;
const AMOUNT_FIT_MAX = 1.1;

/**
 * No single payment can be more than a third of the year's rent.
 *
 * This is what keeps a bond, an insurance settlement or a deposit from being
 * read as rent just because the agent sent it: even quarterly rent is a quarter
 * of the year, so a third leaves room for a catch-up payment and stops well
 * short of the lump sums that aren't rent at all.
 */
const RENT_MAX_SHARE_OF_YEAR = 1 / 3;

/** The rent rules as the engine reads them — trimmed, lowercased, de-duplicated. */
export function rentRules(p: PropertyRules): RentRules {
  const terms = [...new Set((p.rent_match_terms ?? []).map(t => clean(t).toLowerCase()).filter(Boolean))];
  const amount = Math.max(0, Number(p.expected_rent_amount) || 0);
  const frequency = p.expected_rent_frequency ?? null;
  return {
    terms,
    accountId: clean(p.rent_account_id) || null,
    amount,
    frequency,
    annual: amount > 0 && frequency ? r2(amount * RENT_PERIODS_PER_YEAR[frequency]) : 0,
  };
}

/** True when the user has said how to recognise the rent. */
export function hasRentRules(p: PropertyRules): boolean {
  if (!canEarnRent(p)) return false;
  const rules = rentRules(p);
  return rules.terms.length > 0 || !!rules.accountId;
}

/** What the agreed rent is worth over a year, or null when it isn't set. */
export function expectedAnnualRent(p: PropertyRules): number | null {
  const annual = rentRules(p).annual;
  return canEarnRent(p) && annual > 0 ? annual : null;
}

/**
 * The transaction's text reduced to the shape a match term is already in:
 * lower case, punctuation turned to spaces, padded so a word can be looked for
 * whole.
 *
 * Terms are NORMALISED when they are derived (`derivePayerTerm`) but the
 * statement text is not, so comparing one against the other with `includes`
 * quietly failed for every payer of more than one word: "rent property
 * broadbeach" is not a substring of "Rent - Property Broadbeach". The rule then
 * matched nothing by payer and fell through to the account, which is how a
 * property came to count somebody's pay as rent.
 */
function matchableText(t: Transaction): string {
  return ` ${searchableText(t).replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * The most specific payer term this credit carries, or null for none.
 *
 * Every word of the term must appear as a WHOLE word: "ray white" matches
 * "RAY WHITE 4471 NSW AUS" whatever reference the agent tacks on, and "rent"
 * is not found inside "Current Account". Requiring all of them is what keeps
 * one payer from answering for another — the near miss is a payment left for
 * the user to add, which the matched-payments list shows them; the near hit is
 * income they never earned.
 */
function matchedTerm(t: Transaction, terms: string[]): string | null {
  const text = matchableText(t);
  let best: string | null = null;
  for (const term of terms) {
    const words = term.split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length === 0) continue;
    if (!words.every(word => text.includes(` ${word} `))) continue;
    if (best === null || term.length > best.length) best = term;
  }
  return best;
}

/**
 * The user has already said what this money is, and it wasn't rent.
 *
 * Only ever asked on the account path, which is a guess by construction. A
 * credit filed under Salary is somebody's pay and no coincidence of amount
 * should overrule that; a credit filed under Rent corroborates the guess. An
 * unfiled credit says nothing either way and is left to the amount to decide.
 */
function filedAsSomethingElse(t: Transaction): boolean {
  const category = clean(t.category).toLowerCase();
  if (!category || category === 'uncategorised') return false;
  return !category.includes('rent');
}

/**
 * Whether this credit is a rent payment.
 *
 * The payer identifies rent. Nothing else does.
 *
 * A credit from the named agent is rent whatever it comes to, because the user
 * pointed at that payer themselves — which is what lets the rent change, arrive
 * late, or come through short after the agent has taken their fee and still be
 * counted. The one guard on that trust is the ceiling above, so a lump sum from
 * the same agent isn't read as a year's rent.
 *
 * Once a payer is named, a credit that isn't from them is NOT rent, however
 * well it fits otherwise. The account is where the money landed, not what the
 * money was: the rent almost always arrives in the everyday account, and "about
 * the right size, in the right account" is true of a fortnight's pay, a tax
 * refund and a transfer from savings as often as it is of a week's rent. Reading
 * those as rental income doesn't just add a row — it inflates the yield, the
 * cash flow and the figure that goes on a tax return.
 *
 * The account can still claim on its own, but only for a property where no payer
 * has been named at all, only against an amount within a tenth of the agreed
 * rent, and only for money the user hasn't already filed as something else.
 *
 * Returns HOW it matched, because the two are not equally strong: see
 * RENT_PAYER_STRENGTH.
 */
export function rentMatch(t: Transaction, rules: RentRules): RentMatch | null {
  const amount = txAmount(t);
  if (amount <= 0) return null;
  if (!countsAsPropertyMoney(t)) return null;
  if (rules.annual > 0 && amount > rules.annual * RENT_MAX_SHARE_OF_YEAR) return null;

  const payer = matchedTerm(t, rules.terms);
  if (payer !== null) return { reason: 'payer', term: payer };
  if (rules.terms.length > 0) return null;

  if (!rules.accountId || t.account_id !== rules.accountId) return null;
  if (rules.amount <= 0) return null;
  if (filedAsSomethingElse(t)) return null;

  const fits = amount >= rules.amount * AMOUNT_FIT_MIN && amount <= rules.amount * AMOUNT_FIT_MAX;
  return fits ? { reason: 'account', term: null } : null;
}

/** Whether this credit is rent at all — see rentMatch for how it was decided. */
export function isRentCredit(t: Transaction, rules: RentRules): boolean {
  return rentMatch(t, rules) !== null;
}

// ── Expense rules ────────────────────────────────────────────────────────────
//
// One rule per cost the property has. A rule is a QUESTION about the user's
// transactions, never a record of a payment: it says "the strata levy is about
// $1,100 a quarter, paid to Strata Plus from the offset account" so that the
// levy which arrives next quarter is recognised, sorted under strata, and
// compared with what was expected. Delete the rule and the transaction is
// untouched; correct the transaction and the figures follow it.

/** How many of each cost fall in a year. `irregular` has no cycle by design. */
export const PROPERTY_EXPENSE_PERIODS_PER_YEAR: Record<PropertyExpenseFrequency, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  quarterly: 4,
  annually: 1,
  irregular: 0,
};

export const EXPENSE_FREQUENCY_LABELS: Record<PropertyExpenseFrequency, string> = {
  weekly: 'a week',
  fortnightly: 'a fortnight',
  monthly: 'a month',
  quarterly: 'a quarter',
  annually: 'a year',
  irregular: 'as it comes',
};

/** An expense rule as the engine reads it — trimmed, lowercased, de-duplicated. */
export interface ExpenseRule {
  id: string;
  name: string;
  kind: PropertyExpenseKind;
  /** The biller, lowercased for matching. */
  terms: string[];
  accountId: string | null;
  /** True when that account is this property's alone. */
  wholeAccount: boolean;
  /** What one bill should be. 0 when the user hasn't said. */
  amount: number;
  frequency: PropertyExpenseFrequency | null;
  /** amount × bills a year. 0 for an irregular cost, which has no yearly figure. */
  annual: number;
}

/**
 * The property's expense rules, normalised.
 *
 * A rule with neither a biller nor a dedicated account matches nothing, and is
 * kept rather than dropped: it is a cost the user has told us about but not yet
 * taught us to spot, and the screen says so rather than quietly forgetting it.
 */
export function expenseRules(p: PropertyRules): ExpenseRule[] {
  const out: ExpenseRule[] = [];
  for (const raw of p.property_expenses ?? []) {
    if (!raw || !raw.id) continue;
    const amount = Math.max(0, Number(raw.expected_amount) || 0);
    const frequency = raw.frequency ?? null;
    const periods = frequency ? PROPERTY_EXPENSE_PERIODS_PER_YEAR[frequency] ?? 0 : 0;
    out.push({
      id: raw.id,
      name: clean(raw.name) || EXPENSE_KIND_LABELS[raw.kind] || 'Cost',
      kind: raw.kind ?? 'other',
      terms: [...new Set((raw.match_terms ?? []).map(t => clean(t).toLowerCase()).filter(Boolean))],
      accountId: clean(raw.account_id) || null,
      wholeAccount: raw.whole_account === true && !!clean(raw.account_id),
      amount,
      frequency,
      annual: amount > 0 && periods > 0 ? r2(amount * periods) : 0,
    });
  }
  return out;
}

/** How an expense rule claimed a transaction. */
export interface ExpenseRuleMatch {
  rule: ExpenseRule;
  reason: 'account' | 'term';
  term: string | null;
  strength: number;
}

/**
 * Which of the property's expense rules claims this transaction.
 *
 * Three ways, strongest first — and the third is deliberately hard to reach:
 *
 *   • a WHOLE account: the user said the account is this property's alone, so
 *     everything on it is, whatever the description says. This is what the old
 *     "accounts used only for this property" setting became.
 *   • the BILLER named on the rule, found in the merchant, description or notes.
 *     The most specific biller wins when two rules could both take it.
 *   • the paying account TOGETHER WITH an amount that fits what the bill should
 *     be. An account shared with the weekly shop must not hand the property
 *     every debit on it, so without an expected amount to check against, the
 *     account alone claims nothing.
 */
export function expenseRuleMatch(t: Transaction, rules: ExpenseRule[]): ExpenseRuleMatch | null {
  if (!countsAsPropertyMoney(t)) return null;
  const magnitude = Math.abs(txAmount(t));
  let best: ExpenseRuleMatch | null = null;

  const take = (candidate: ExpenseRuleMatch) => {
    if (!best || candidate.strength > best.strength) best = candidate;
  };

  for (const rule of rules) {
    const onAccount = !!rule.accountId && t.account_id === rule.accountId;
    if (rule.wholeAccount && onAccount) {
      take({ rule, reason: 'account', term: null, strength: ACCOUNT_MATCH_STRENGTH });
      continue;
    }

    // Whole words, on normalised text — a biller of more than one word ("strata
    // plus") is never a substring of the statement's own punctuation.
    const term = matchedTerm(t, rule.terms);
    if (term !== null) {
      take({ rule, reason: 'term', term, strength: EXPENSE_RULE_STRENGTH + term.length });
      continue;
    }

    // Only when no biller was named. Once the user has said WHO this cost is
    // paid to, a debit to somebody else is not that cost, however well it fits
    // the amount — the same rule that stops a salary being read as rent.
    if (rule.terms.length === 0 && onAccount && rule.amount > 0
      && magnitude >= rule.amount * AMOUNT_FIT_MIN && magnitude <= rule.amount * AMOUNT_FIT_MAX) {
      take({ rule, reason: 'account', term: null, strength: EXPENSE_ACCOUNT_STRENGTH });
    }
  }
  return best;
}

// ═════════════════════════════════════════════════════════════════════════════
//  One payment, one match
// ═════════════════════════════════════════════════════════════════════════════
//
// The same payment can reach the store more than once, and every copy would be
// counted as another month's rent if nothing stopped it:
//
//   • a bill marked paid by hand, then imported from the bank a day later;
//   • a statement re-imported over an account that is also live-synced;
//   • any manual entry the reconciler has already paired with its bank twin.
//
// None of these are deleted — the ledger keeps what the user entered, and
// Accounts shows the reconciliation — but a property card must count the MONEY,
// and the money moved once.

/**
 * True when this row is a second representation of a payment counted elsewhere.
 *
 * `conflict` and `resolved` are precisely the reconciler's two words for "the
 * bank's copy of this is the one that counts" (see utils/reconcile.ts, where
 * both are excluded from the account balance for the same reason).
 */
export function isDuplicateRepresentation(t: Transaction): boolean {
  return t.reconcile_state === 'conflict' || t.reconcile_state === 'resolved';
}

/** The provider's own id for a transaction — the only strict identity there is. */
function strongId(t: Transaction): string | null {
  return clean(t.source_ref) || clean(t.basiq_tx_id) || null;
}

/**
 * One row per payment that really happened.
 *
 * Rows are grouped by content hash — the same account, day, signed amount and
 * normalised merchant — and within a group:
 *
 *   • rows carrying a provider id are DISTINCT events, one per id. Two tenants
 *     paying the same rent on the same day are two payments, and the bank says
 *     so by giving them two ids;
 *   • rows without one collapse to a single copy, and are dropped outright when
 *     a provider-id row is present — the bank's copy is the payment, and the
 *     hand-entered one is the user's note of the same money.
 *
 * That is the same identity policy the importer uses (see transactionCore's
 * classifyDuplicate), applied at read time. Where it can err it errs towards
 * counting once: two indistinguishable hand-entered payments on the same day
 * become one, which understates by a payment. Reporting the rent twice would
 * overstate the yield, the cash flow and the tax position, and would look
 * exactly like a rise that never happened.
 */
export function uniqueRealTransactions(transactions: Transaction[]): Transaction[] {
  const out: Transaction[] = [];
  const seenIds = new Set<string>();
  const seenStrong = new Set<string>();
  const hashHasStrong = new Set<string>();
  const hashTakenWeak = new Set<string>();

  // Provider-id rows first, so a hash group's authoritative copy is known before
  // the hand-entered copies of it are judged — whatever order they arrive in.
  const ordered = [...transactions].sort((a, b) => (strongId(a) ? 0 : 1) - (strongId(b) ? 0 : 1));

  for (const t of ordered) {
    if (!t || seenIds.has(t.id)) continue;
    if (isDuplicateRepresentation(t)) continue;
    seenIds.add(t.id);

    const hash = contentHashOf(t);
    const id = strongId(t);
    if (id) {
      const key = `${t.account_id ?? ''}|${id}`;
      if (seenStrong.has(key)) continue;
      seenStrong.add(key);
      hashHasStrong.add(hash);
      out.push(t);
      continue;
    }

    if (hashHasStrong.has(hash) || hashTakenWeak.has(hash)) continue;
    hashTakenWeak.add(hash);
    out.push(t);
  }

  // Sorting for the pass above must not change the order the caller gave us:
  // every list the user sees is ordered by the caller, not by whether the bank
  // happened to supply an id.
  const kept = new Set(out.map(t => t.id));
  const emitted = new Set<string>();
  return transactions.filter(t => {
    if (!kept.has(t.id) || emitted.has(t.id)) return false;
    emitted.add(t.id);
    return true;
  });
}

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

/** True when the property has some way to recognise a transaction of its own. */
export function hasMatchRules(p: PropertyRules): boolean {
  if (matchTerms(p).length > 0 || matchAccountIds(p).length > 0 || hasRentRules(p)) return true;
  return expenseRules(p).some(r => r.terms.length > 0 || (r.accountId && (r.wholeAccount || r.amount > 0)));
}

/** Transactions the user has taken back off this property, by id. */
export function excludedTransactionIds(p: PropertyRules): Set<string> {
  return new Set((p.excluded_transaction_ids ?? []).map(clean).filter(Boolean));
}

/** Everything about a transaction a match term is allowed to look at. */
function searchableText(t: Transaction): string {
  return `${t.merchant ?? ''} ${t.raw_description ?? ''} ${t.notes ?? ''}`.toLowerCase();
}

/** How this property claims that transaction, or null when it doesn't. */
export function matchProperty(t: Transaction, p: PropertyRules): PropertyMatch | null {
  // The user's own veto, checked before every rule: a payment they took off this
  // property stays off it, however well the rules would otherwise fit. Correcting
  // a wrong match must not require weakening a rule that is right about
  // everything else.
  if (t.id && excludedTransactionIds(p).has(t.id)) return null;

  if (t.account_id && matchAccountIds(p).includes(t.account_id)) {
    return { reason: 'account', term: null, ruleId: null, strength: ACCOUNT_MATCH_STRENGTH };
  }
  // A rent rule claims the rent and NOTHING else on that account: the account
  // rent lands in is usually the everyday one, so claiming everything there
  // would file the weekly shop as a property expense.
  const rent = canEarnRent(p) ? rentMatch(t, rentRules(p)) : null;
  if (rent) {
    return {
      reason: 'rent',
      term: rent.term,
      ruleId: null,
      strength: rent.reason === 'payer'
        ? RENT_PAYER_STRENGTH + (rent.term?.length ?? 0)
        : RENT_ACCOUNT_STRENGTH,
    };
  }

  const expense = expenseRuleMatch(t, expenseRules(p));
  if (expense) {
    return { reason: 'expense', term: expense.term, ruleId: expense.rule.id, strength: expense.strength };
  }

  const text = searchableText(t);
  let best: PropertyMatch | null = null;
  for (const term of matchTerms(p)) {
    if (!text.includes(term)) continue;
    // The longest matching term wins even within one property, so the strength a
    // property brings to a contest is its most specific claim, not its first.
    if (!best || term.length > best.strength) {
      best = { reason: 'term', term, ruleId: null, strength: term.length };
    }
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
  properties: (PropertyRules & { id: string })[],
  transactions: Transaction[],
): Map<string, Transaction[]> {
  const out = new Map<string, Transaction[]>();
  for (const p of properties) out.set(p.id, []);

  // Deduplicated ONCE, here, so nothing downstream can count a payment twice:
  // every figure, preview and payment list a property shows is built from what
  // this returns.
  for (const t of uniqueRealTransactions(transactions)) {
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

// ── What a property costs, in the words a landlord uses ──────────────────────
//
// The app's own categories are built for a household budget: strata, council
// rates and water all land in "Bills", which is right for a budget and useless
// on a property card. So every claimed expense is ALSO sorted into the costs a
// property actually has. Nothing is re-filed — the transaction keeps its own
// category everywhere else in Ledger; this is a second reading of the same row.

export const PROPERTY_EXPENSE_KINDS: PropertyExpenseKind[] = [
  'strata', 'council', 'water', 'insurance', 'maintenance', 'utilities', 'other',
];

export const EXPENSE_KIND_LABELS: Record<PropertyExpenseKind, string> = {
  strata: 'Strata / body corporate',
  council: 'Council rates',
  water: 'Water',
  insurance: 'Insurance',
  maintenance: 'Maintenance & repairs',
  utilities: 'Utilities',
  other: 'Other costs',
};

/**
 * Matched in this order, most specific first: an electrician is maintenance and
 * electricity is a utility, so "electrician" has to be asked before "electric".
 * Word boundaries throughout — "rates" must not match "corporates".
 */
const EXPENSE_KIND_PATTERNS: [PropertyExpenseKind, RegExp][] = [
  ['strata', /\b(strata|body\s*corp\w*|owners?\s*corp\w*|levies|levy)\b/],
  ['council', /\b(council|shire|rates?\s*(notice|instal\w*)?|land\s*tax)\b/],
  ['water', /\b(water|sewer\w*)\b/],
  ['insurance', /\b(insur\w*|landlord\s*policy|underwrit\w*)\b/],
  ['maintenance', /\b(repair\w*|maintenance|plumb\w*|electrician|handyman|garden\w*|lawn|mowing|pest|painter|painting|builder|carpet|clean\w*|locksmith|tradie)\b/],
  ['utilities', /\b(electricity|energy|power|gas|nbn|internet|broadband|telstra|optus|agl|origin|utilit\w*)\b/],
];

/** The app's own categories, when the description gave nothing away. */
const CATEGORY_EXPENSE_KIND: Record<string, PropertyExpenseKind> = {
  insurance: 'insurance',
  utilities: 'utilities',
  water: 'water',
  maintenance: 'maintenance',
  'home maintenance': 'maintenance',
  repairs: 'maintenance',
  rates: 'council',
  strata: 'strata',
};

/**
 * Which property cost this transaction is. Falls back to `other` rather than
 * guessing — "other costs" is an honest bucket, a wrong label isn't.
 */
export function classifyPropertyExpense(t: Transaction): PropertyExpenseKind {
  const text = searchableText(t);
  for (const [kind, pattern] of EXPENSE_KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return CATEGORY_EXPENSE_KIND[clean(t.category).toLowerCase()] ?? 'other';
}

/** One kind of cost, totalled. */
export interface PropertyExpenseKindLine {
  kind: PropertyExpenseKind;
  label: string;
  amount: number;
  count: number;
}

/**
 * One expense RULE, against what it actually caught.
 *
 * A rule that has caught nothing is still reported (count 0): a strata levy the
 * user has set up and Ledger has never seen is the most useful line on the
 * screen, because it means the biller isn't being recognised.
 */
export interface PropertyExpenseRuleLine {
  id: string;
  name: string;
  kind: PropertyExpenseKind;
  kindLabel: string;
  /** What was actually paid to this biller inside the window, net of refunds. */
  amount: number;
  count: number;
  /** What the user said one bill should be, and what that comes to a year. */
  expectedAmount: number;
  expectedAnnual: number;
  frequency: PropertyExpenseFrequency | null;
  /** Paid against expected, %. Null when there is no expectation to compare to. */
  vsExpectedPercent: number | null;
  latest: { date: string; amount: number } | null;
}

/**
 * One transaction a property claimed, ready to be listed for review.
 *
 * This is what makes a wrong match fixable: the user sees the payments that were
 * counted, and takes the wrong one off (see `excluded_transaction_ids`) instead
 * of having to guess which word in a rule caught it.
 */
export interface PropertyPaymentLine {
  id: string;
  date: string;
  /** Always positive — `kind` says which way the money went. */
  amount: number;
  merchant: string;
  accountId: string | null;
  /** rent in, an expense out, or a refund coming back off the costs. */
  kind: 'rent' | 'expense' | 'refund';
  /** What claimed it: the payer term, the expense rule's name, or the account. */
  via: string;
  /** The expense rule that claimed it, when one did. */
  ruleId: string | null;
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

/**
 * How rent was recognised for this property.
 *
 *   off        an owner-occupied home: no credit is ever rent.
 *   rules      the user named the payer (and/or the account it lands in), so
 *              only credits that answer to that are rent.
 *   anyCredit  no rent rules, so every credit the property claimed is taken as
 *              rent. This is what a dedicated investment account means, and it
 *              is what properties set up before rent rules existed keep doing.
 */
export type RentMode = 'off' | 'rules' | 'anyCredit';

/** Everything a property earned, spent and cost over the window. */
export interface PropertyPerformance {
  window: PerformanceWindow;
  /** True when the user has told us how to recognise this property's transactions. */
  matched: boolean;
  /** How a credit was decided to be rent — 'off' for an owner-occupied home. */
  rentMode: RentMode;
  /** Rent actually banked inside the window. */
  rentReceived: number;
  /**
   * Expenses paid inside the window, NET of money that came back.
   *
   * A claimed credit that isn't rent — a council refund, an insurance
   * reimbursement, an overpaid strata levy — is money the property didn't
   * ultimately cost, so it reduces the cost rather than being reported as
   * income. On an owner-occupied home every credit is of this kind.
   */
  expensesPaid: number;
  /** What came back: those non-rent credits, and how many there were. */
  refunds: number;
  refundCount: number;
  /**
   * The rent this property earns over a year — the AGREED rent when the user
   * has stated one, and only otherwise what the bank actually saw.
   *
   * $1,200 a week is $62,400 a year. Deriving that from the payments instead
   * would divide the same tenancy by however much of the year Ledger happens to
   * hold: a property set up last month reads as nearly vacant, a fortnight the
   * agent paid late drags the yield down, and the number moves every time an
   * old statement is imported. The user has told us the terms of the lease —
   * arithmetic on them beats a sample of them.
   *
   * What actually arrived is not lost: it is `bankedAnnualRent`, and the gap
   * between the two is `rentVsExpectedPercent`, which is where arrears and
   * vacancies belong.
   */
  annualRent: number;
  /** rentReceived scaled to a full year — identical to it over a full window. */
  bankedAnnualRent: number;
  /** Which of the two `annualRent` is, so the card can say so. */
  annualRentBasis: 'agreed' | 'banked';
  /**
   * What this property costs to run over a year.
   *
   * Read the same way as `annualRent`, and for the same reason: a cost the user
   * has set up — "$1,100 of strata, quarterly" — is a fact about the year, and
   * counting instead the levies that happen to have landed inside the window
   * makes the holding cost lurch every quarter and understates it on a property
   * only just added. Each COSTED rule contributes what it is worth over a year;
   * everything else the property caught — the one-off plumber, a cost with no
   * expected amount, a rule left on `as it comes` — contributes what was
   * actually paid. So nothing is counted twice and nothing is dropped.
   */
  annualExpenses: number;
  /** expensesPaid scaled to a full year — what the bank actually saw. */
  bankedAnnualExpenses: number;
  /** Whether any costed rule fed `annualExpenses`, so the card can say so. */
  annualExpensesBasis: 'agreed' | 'banked';
  monthlyRent: number;
  monthlyExpenses: number;
  /** Expenses split across the categories they were already filed under. */
  expensesByCategory: PropertyExpenseLine[];
  /** The same money read as property costs: strata, rates, water, insurance… */
  expensesByKind: PropertyExpenseKindLine[];
  /** Every expense rule set up on the property, against what it caught. */
  expensesByRule: PropertyExpenseRuleLine[];
  /** Every claimed transaction, newest first — the list a wrong match is fixed from. */
  payments: PropertyPaymentLine[];
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
  /** What the agreed rent should come to over a year. Null when unset. */
  expectedAnnualRent: number | null;
  /**
   * The rent actually banked as a % of the rent that was agreed. Null when
   * there is nothing to compare against.
   *
   * Below 100 means the property is not earning what it is let for — arrears, a
   * vacancy, or the agent's fees coming out before the money is passed on — and
   * it says so without anyone having to reconcile a statement.
   */
  rentVsExpectedPercent: number | null;
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
  /**
   * Rent payments counted — one per real transaction, after duplicate copies of
   * the same payment have been collapsed (see uniqueRealTransactions).
   */
  rentPayments: number;
  /**
   * Distinct DAYS rent arrived on. Two payments on one day are one rent day,
   * which is what keeps the cycle and the vacancy honest — but they are still
   * two payments, so this is not the same number as `rentPayments`.
   */
  rentDays: number;
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
  /**
   * The property's own rules — its type and how it recognises rent.
   *
   * Omitted entirely (the pre-refinement call), every credit is rent, which is
   * what the earlier behaviour was. Supplied, an owner-occupied home earns
   * nothing and a property with rent rules only counts what answers to them.
   */
  rules?: PropertyRules;
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
const EMPTY_KIND_LINES: PropertyExpenseKindLine[] = [];

/** Work out one property's performance from the transactions it claimed. */
export function buildPerformance(input: PerformanceInput): PropertyPerformance {
  const asOf = input.asOf ?? todayISO();
  const window = performanceWindow({ purchase_date: input.purchaseDate ?? null }, asOf);
  const factor = 12 / window.months;

  const inWindow = input.transactions.filter(t => {
    const d = clean(t.date).slice(0, 10);
    return !!d && d > window.start && d <= window.end && countsAsPropertyMoney(t);
  });

  // How a credit is read. With no rules at all this is the pre-refinement
  // behaviour — every credit is rent — which is what a dedicated investment
  // account has always meant and what already-configured properties expect.
  const rules = input.rules;
  const rr = rules ? rentRules(rules) : null;
  const rentMode: RentMode = !rules
    ? 'anyCredit'
    : !canEarnRent(rules) ? 'off'
      : hasRentRules(rules) ? 'rules' : 'anyCredit';

  // Rent by DAY, not by transaction: an agent paying two lots on the same date is
  // one rent day, which keeps the cycle inference (and vacancy) honest. The
  // PAYMENTS are counted separately — two lots are still two payments.
  const rentByDay = new Map<string, number>();
  let rentPayments = 0;
  let expensesPaid = 0;
  let expenseCount = 0;
  let refunds = 0;
  let refundCount = 0;
  const byCategory = new Map<string, { amount: number; count: number }>();
  const byKind = new Map<PropertyExpenseKind, { amount: number; count: number }>();
  const byRule = new Map<string, { amount: number; count: number; latest: { date: string; amount: number } | null }>();
  const payments: PropertyPaymentLine[] = [];

  const rules_ = rules ? expenseRules(rules) : [];

  /** Add to (or, for a refund, take off) one bucket of the expense breakdown. */
  const recordExpense = (t: Transaction, amount: number, counts: boolean, rule: ExpenseRule | null) => {
    const category = clean(t.category) || 'Uncategorised';
    const line = byCategory.get(category) ?? { amount: 0, count: 0 };
    byCategory.set(category, { amount: r2(line.amount + amount), count: line.count + (counts ? 1 : 0) });

    // The rule's own kind wins over the description: the user said what this
    // cost IS, and a guess from the wording has no business overruling them.
    const kind = rule ? rule.kind : classifyPropertyExpense(t);
    const kindLine = byKind.get(kind) ?? { amount: 0, count: 0 };
    byKind.set(kind, { amount: r2(kindLine.amount + amount), count: kindLine.count + (counts ? 1 : 0) });

    if (rule) {
      const ruleLine = byRule.get(rule.id) ?? { amount: 0, count: 0, latest: null };
      const day = clean(t.date).slice(0, 10);
      byRule.set(rule.id, {
        amount: r2(ruleLine.amount + amount),
        count: ruleLine.count + (counts ? 1 : 0),
        latest: counts && (!ruleLine.latest || day >= ruleLine.latest.date)
          ? { date: day, amount }
          : ruleLine.latest,
      });
    }
  };

  for (const t of inWindow) {
    const amount = txAmount(t);
    const day = clean(t.date).slice(0, 10);
    const rule = rules_.length > 0 ? expenseRuleMatch(t, rules_)?.rule ?? null : null;

    if (amount > 0) {
      const isRent = rentMode === 'anyCredit' || (rentMode === 'rules' && isRentCredit(t, rr!));
      if (isRent) {
        rentByDay.set(day, r2((rentByDay.get(day) ?? 0) + amount));
        rentPayments += 1;
        payments.push({
          id: t.id, date: day, amount: r2(amount), merchant: clean(t.merchant) || clean(t.raw_description) || 'Payment',
          accountId: t.account_id ?? null, kind: 'rent',
          via: rentMode === 'anyCredit' ? 'this property’s account' : (rentMatch(t, rr!)?.term ?? 'the rent account'),
          ruleId: null,
        });
      } else {
        // Not income. Money the property gave back, so it comes off what the
        // property cost — in the same bucket the cost was counted in.
        refunds = r2(refunds + amount);
        refundCount += 1;
        expensesPaid = r2(expensesPaid - amount);
        recordExpense(t, -amount, false, rule);
        payments.push({
          id: t.id, date: day, amount: r2(amount), merchant: clean(t.merchant) || clean(t.raw_description) || 'Refund',
          accountId: t.account_id ?? null, kind: 'refund',
          via: rule ? rule.name : 'money that came back', ruleId: rule?.id ?? null,
        });
      }
    } else if (amount < 0) {
      const magnitude = Math.abs(amount);
      expensesPaid = r2(expensesPaid + magnitude);
      expenseCount += 1;
      recordExpense(t, magnitude, true, rule);
      payments.push({
        id: t.id, date: day, amount: r2(magnitude), merchant: clean(t.merchant) || clean(t.raw_description) || 'Payment',
        accountId: t.account_id ?? null, kind: 'expense',
        via: rule ? rule.name : 'this property’s expenses', ruleId: rule?.id ?? null,
      });
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

  const bankedAnnualRent = r2(rentReceived * factor);
  const expectedAnnual = rules ? expectedAnnualRent(rules) : null;

  // The agreed rent wins when there is one. See `annualRent` on the interface:
  // a lease is a fact about the year, the payments so far are a sample of it.
  const useAgreed = expectedAnnual !== null && expectedAnnual > 0;
  const annualRent = useAgreed ? expectedAnnual : bankedAnnualRent;

  // The costs the user has actually put a figure and a cycle against. A rule
  // left on `as it comes`, or with no expected amount, has no annual worth by
  // design and stays in the measured half below.
  const costedRules = rules_.filter(rule => rule.annual > 0);
  const agreedExpenses = r2(costedRules.reduce((sum, rule) => sum + rule.annual, 0));
  // What those same rules actually caught, so it can be taken back out — this is
  // the half being REPLACED by the agreed figure, not added to it.
  const costedSpend = r2(costedRules.reduce((sum, rule) => sum + (byRule.get(rule.id)?.amount ?? 0), 0));

  const bankedAnnualExpenses = r2(expensesPaid * factor);
  const annualExpenses = costedRules.length > 0
    ? r2(agreedExpenses + (expensesPaid - costedSpend) * factor)
    : bankedAnnualExpenses;
  const annualMortgage = annualMortgageCost(input.loan);
  const owned = Number(input.ownedValue) || 0;

  // No rent means no yield — an owner-occupied home has none, and printing 0%
  // would read as a bad investment rather than as a house someone lives in.
  const canYield = annualRent > 0 && owned > 0;

  return {
    window,
    matched: input.matched !== false,
    rentMode,
    rentReceived,
    expensesPaid,
    refunds,
    refundCount,
    expectedAnnualRent: expectedAnnual,
    // Measured against what the bank saw, never against `annualRent` — which is
    // now the agreed figure itself, and would report every property as exactly
    // on target however little of the rent had turned up.
    rentVsExpectedPercent: useAgreed ? r2((bankedAnnualRent / expectedAnnual!) * 100) : null,
    annualRent,
    bankedAnnualRent,
    annualRentBasis: useAgreed ? 'agreed' : 'banked',
    annualExpenses,
    bankedAnnualExpenses,
    annualExpensesBasis: costedRules.length > 0 ? 'agreed' : 'banked',
    monthlyRent: r2(annualRent / 12),
    monthlyExpenses: r2(annualExpenses / 12),
    expensesByCategory: byCategory.size === 0 ? EMPTY_LINES : [...byCategory.entries()]
      .map(([category, line]) => ({ category, amount: line.amount, count: line.count }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    // Biggest cost first, and `other` last however big it is: it is the bucket
    // for what couldn't be named, so it shouldn't head a list of named costs.
    expensesByKind: byKind.size === 0 ? EMPTY_KIND_LINES : [...byKind.entries()]
      .map(([kind, line]) => ({ kind, label: EXPENSE_KIND_LABELS[kind], amount: line.amount, count: line.count }))
      .sort((a, b) => {
        if ((a.kind === 'other') !== (b.kind === 'other')) return a.kind === 'other' ? 1 : -1;
        return b.amount - a.amount || a.label.localeCompare(b.label);
      }),
    // Every rule the user set up, in the order they set it up — including the
    // ones that caught nothing, which are the ones worth looking at.
    expensesByRule: rules_.map(rule => {
      const line = byRule.get(rule.id) ?? { amount: 0, count: 0, latest: null };
      const paidAnnual = r2(line.amount * factor);
      return {
        id: rule.id,
        name: rule.name,
        kind: rule.kind,
        kindLabel: EXPENSE_KIND_LABELS[rule.kind],
        amount: line.amount,
        count: line.count,
        expectedAmount: rule.amount,
        expectedAnnual: rule.annual,
        frequency: rule.frequency,
        vsExpectedPercent: rule.annual > 0 ? r2((paidAnnual / rule.annual) * 100) : null,
        latest: line.latest,
      };
    }),
    payments: payments.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount),
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
    rentPayments,
    rentDays: rentDays.length,
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
  /** A home the user lives in: it has costs, no rent, and no rent setup. */
  ownerOccupied: boolean;
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
  /**
   * What this property itself contributes to net worth: 0 if excluded or already
   * counted by its fund, otherwise the owned value — less its mortgage in the one
   * case where the loans total won't subtract it (`mortgageNettedHere`).
   */
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
   * True when the mortgage was subtracted HERE, inside `netWorthValue`, because
   * the loan is opted out of net worth and the loans total therefore skips it.
   * False in the ordinary case, where the loans total does the netting. Never
   * both — that is the whole point of the flag.
   */
  mortgageNettedHere: boolean;
  /**
   * The property's TRUE effect on net worth, counting the asset here or in its
   * fund and the mortgage wherever it lands: netWorthValue − (debt, if the loans
   * total counts it).
   *
   * For a property that counts toward net worth this is its EQUITY, whichever way
   * the two switches are set — which is what makes double-counting detectable:
   * net worth may move by this and no more.
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
    /**
     * The portfolio's gearing: total debt ÷ total OWNED value, %.
     *
     * Measured across EVERY property, the unencumbered ones included — the
     * opposite of how the yields below are measured, and deliberately so. A yield
     * counts only what earns because a home the user lives in produces no rent to
     * average in. Gearing is the other way round: a house with no mortgage on it
     * is real security standing behind the same debt, so leaving it out would
     * report the portfolio as riskier than it is. This is the figure a lender
     * works out, and it is the sum of the parts — not the average of the per-row
     * LVRs, which would weight a small flat the same as a large house.
     *
     * Null when nothing is owned, because a ratio against nothing has no answer.
     */
    lvr: number | null;
    /** How many of the properties have a mortgage linked. */
    mortgaged: number;
    /**
     * Owned value the user has switched OUT of net worth.
     *
     * Separate from `countedInFunds`, which is value a fund is already carrying:
     * that value is still counted, just once and somewhere else. This is value
     * counted nowhere, by choice, and the summary says so rather than letting the
     * portfolio total and the net-worth total differ in silence.
     */
    excludedFromNetWorth: number;
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
    // Nets the mortgage itself only when `debtCounts` is false, so the debt is
    // subtracted exactly once between this and the loans total below.
    const contributed = netWorthValue(p, loans);

    const performance = buildPerformance({
      transactions: claimed.get(p.id) ?? [],
      ownedValue: owned,
      loan,
      purchaseDate: p.purchase_date ?? null,
      asOf,
      matched: hasMatchRules(p),
      rules: p,
    });

    return {
      id: p.id,
      name: propertyLabel(p),
      nickname: clean(p.name) || null,
      address: formatAddress(p),
      addressParts: addressParts(p),
      type: p.property_type,
      typeLabel: PROPERTY_TYPE_LABELS[p.property_type] ?? 'Property',
      ownerOccupied: isOwnerOccupied(p),
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
      mortgageNettedHere: counts && !!loan && !debtCounts && debt > 0,
      netWorthEffect: r2(contributed - (debtCounts ? debt : 0)),
      performance,
    };
  });

  const earning = rows.filter(r => r.performance.isIncomeProducing);
  const earningValue = r2(earning.reduce((s, r) => s + r.ownedValue, 0));
  const ownedTotal = r2(rows.reduce((s, r) => s + r.ownedValue, 0));
  const debtTotal = r2(rows.reduce((s, r) => s + r.debt, 0));
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
      ownedValue: ownedTotal,
      countedInFunds: r2(rows.reduce((s, r) => s + (r.countedInFundBalance ? r.ownedValue : 0), 0)),
      netWorthValue: r2(rows.reduce((s, r) => s + r.netWorthValue, 0)),
      excludedFromNetWorth: r2(rows.reduce((s, r) => s + (r.countsTowardNetWorth ? 0 : r.ownedValue), 0)),
      debt: debtTotal,
      lvr: ownedTotal > 0 ? r2((debtTotal / ownedTotal) * 100) : null,
      mortgaged: rows.filter(r => r.loan !== null).length,
      equity: r2(rows.reduce((s, r) => s + r.equity, 0)),
      netWorthEffect: r2(rows.reduce((s, r) => s + r.netWorthEffect, 0)),
      count: rows.length,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Setting the rules up: who pays the rent, and what the rules catch
// ═════════════════════════════════════════════════════════════════════════════
//
// Asking a user to TYPE the agent's trading name off a bank statement is asking
// them to get it wrong. They already have the rent in front of them — it arrived
// twelve times last year — so the setup is: here are the people who have paid
// you, which one is the rent? Picking one fills in the payer, the account it
// landed in and what it comes to, from the transaction itself.

/**
 * The text that identifies whoever is on a transaction, ready to be a rule.
 *
 * The statement string itself is nearly always WRONG as a rule: "RAY WHITE
 * 4471 NSW AUS" and "RAY WHITE 4623 NSW AUS" are the same agent paying the same
 * rent, and a rule made from either catches one month and misses the other —
 * which is exactly how one rent payment came to look like a list of unrelated
 * ones. `normaliseMerchant` strips the reference numbers, card tails, dates and
 * location codes the bank appends, leaving "ray white": the part that will still
 * be there next month.
 *
 * Falls back to the raw text when normalising leaves too little to be safe —
 * better a term the user can see and edit than a two-letter one that matches
 * half the statement.
 */
export function derivePayerTerm(t: Pick<Transaction, 'merchant' | 'raw_description'>): string {
  const raw = clean(t.merchant) || clean(t.raw_description);
  if (!raw) return '';
  const normalised = normaliseMerchant(raw);
  return normalised.length >= MIN_MATCH_TERM_LENGTH ? normalised : raw;
}

/** A payer who might be the rent, worked out from credits that already arrived. */
export interface RentPayerSuggestion {
  /** The payer, normalised — what becomes the match term. */
  term: string;
  /** The payer as the statement writes it, for the user to recognise. */
  label: string;
  /** The account those payments landed in. */
  accountId: string | null;
  /** How many separate payments this payer has made. */
  payments: number;
  total: number;
  latestDate: string;
  latestAmount: number;
  /** The transaction the suggestion was built from — the one the user pointed at. */
  latestId: string;
  /** The cycle those payments came on, when there are enough to tell. */
  frequency: RentFrequency | null;
  /** True when the user has already filed this payer's money under Rent. */
  rentFiled: boolean;
}

/** Payments smaller than this are noise, not a tenancy. */
const MIN_RENT_CANDIDATE = 50;

/**
 * Who has been paying money in, most likely rent payer first.
 *
 * Grouped by the NORMALISED payer, so a year of rent from one agent is one row
 * offering one rule — not twelve rows, one per statement reference, of which the
 * user could only ever pick the month they happened to click.
 *
 * Ranked by how many payments each one made rather than by size: rent is the
 * thing that arrives over and over, and a single large credit is far more likely
 * to be a sale, a refund or a transfer. A payer whose transactions the user has
 * already filed under Rent is lifted above the rest.
 */
export function suggestRentPayers(
  transactions: Transaction[],
  opts: { asOf?: string; limit?: number; accountId?: string | null; query?: string } = {},
): RentPayerSuggestion[] {
  const asOf = opts.asOf ?? todayISO();
  const from = addPeriods(asOf, 'monthly', -12);
  const query = clean(opts.query).toLowerCase();

  const groups = new Map<string, {
    term: string; label: string; accountId: string | null; total: number; dates: string[];
    payments: number; latestDate: string; latestAmount: number; latestId: string; rentFiled: boolean;
  }>();

  // Deduplicated first: a payment the user entered by hand and the bank then
  // imported must offer ONE suggestion, saying it arrived once.
  for (const t of uniqueRealTransactions(transactions)) {
    const date = clean(t.date).slice(0, 10);
    if (!date || date <= from || date > asOf) continue;
    if (!countsAsPropertyMoney(t)) continue;
    const amount = txAmount(t);
    if (amount < MIN_RENT_CANDIDATE) continue;
    if (opts.accountId && t.account_id !== opts.accountId) continue;

    const term = derivePayerTerm(t);
    if (term.length < MIN_MATCH_TERM_LENGTH) continue;
    const label = clean(t.merchant) || clean(t.raw_description);
    if (query && !`${label} ${term}`.toLowerCase().includes(query)) continue;

    const key = term.toLowerCase();
    const group = groups.get(key) ?? {
      term: key, label, accountId: t.account_id ?? null, total: 0, dates: [], payments: 0,
      latestDate: '', latestAmount: 0, latestId: t.id, rentFiled: false,
    };
    group.total = r2(group.total + amount);
    group.dates.push(date);
    group.payments += 1;
    if (date >= group.latestDate) {
      group.latestDate = date;
      group.latestAmount = amount;
      group.latestId = t.id;
      group.label = label || group.label;
    }
    if (clean(t.category).toLowerCase().includes('rent')) group.rentFiled = true;
    groups.set(key, group);
  }

  const score = (g: { dates: string[]; rentFiled: boolean }) =>
    new Set(g.dates).size + (g.rentFiled ? 1_000 : 0);

  return [...groups.values()]
    .sort((a, b) => score(b) - score(a) || b.total - a.total || b.latestDate.localeCompare(a.latestDate))
    .slice(0, opts.limit ?? 6)
    .map(g => ({
      term: g.term,
      label: g.label || g.term,
      accountId: g.accountId,
      payments: g.payments,
      total: g.total,
      latestDate: g.latestDate,
      latestAmount: g.latestAmount,
      latestId: g.latestId,
      frequency: inferRentFrequency(g.dates),
      rentFiled: g.rentFiled,
    }));
}

/**
 * Everything one rent transaction tells us, ready to be saved as the rule.
 *
 * This is the whole of "select one real rent payment": the payer comes from the
 * transaction, the receiving account comes from the transaction, the amount
 * comes from the transaction, and the cycle comes from every OTHER payment the
 * same payer has made. Nothing is typed, and nothing is guessed from a name.
 */
export interface RentRuleFromTransaction {
  term: string;
  label: string;
  accountId: string | null;
  amount: number;
  frequency: RentFrequency | null;
  /** How many payments in the last year this rule would claim, this one included. */
  matches: number;
}

/**
 * Turn the payment the user pointed at into a rent rule.
 *
 * `transactions` is the rest of their money, used only to read the cycle and to
 * say how many payments the rule catches — so the user is told what they are
 * agreeing to before they save it, not after.
 */
export function rentRuleFromTransaction(
  t: Transaction,
  transactions: Transaction[] = [],
  asOf?: string,
): RentRuleFromTransaction | null {
  const term = derivePayerTerm(t);
  if (term.length < MIN_MATCH_TERM_LENGTH) return null;

  const amount = Math.abs(txAmount(t));
  const key = term.toLowerCase();
  const end = asOf ?? todayISO();
  const from = addPeriods(end, 'monthly', -12);

  const dates: string[] = [];
  let matches = 0;
  for (const other of uniqueRealTransactions(transactions.length > 0 ? transactions : [t])) {
    const date = clean(other.date).slice(0, 10);
    if (!date || date <= from || date > end) continue;
    if (!countsAsPropertyMoney(other)) continue;
    if (txAmount(other) <= 0) continue;
    if (matchedTerm(other, [key]) === null) continue;
    dates.push(date);
    matches += 1;
  }

  return {
    term: key,
    label: clean(t.merchant) || clean(t.raw_description) || key,
    accountId: t.account_id ?? null,
    amount: r2(amount),
    frequency: inferRentFrequency(dates),
    matches: Math.max(1, matches),
  };
}

/** A biller the user might want an expense rule for, from money already spent. */
export interface ExpenseBillerSuggestion {
  /** The biller, normalised — what becomes the rule's match term. */
  term: string;
  /** How the statement writes it, and what the rule gets named. */
  label: string;
  /** What kind of property cost it looks like — the user can change it. */
  kind: PropertyExpenseKind;
  accountId: string | null;
  payments: number;
  total: number;
  /** The middle payment, which is what a bill usually is — not the average, so
   *  one catch-up quarter doesn't set the expectation for the rest. */
  typicalAmount: number;
  frequency: PropertyExpenseFrequency | null;
  latestDate: string;
  latestAmount: number;
}

/** The middle value — steadier than a mean when one bill is an outlier. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return r2(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** The cost cycle behind a set of payment dates, or null when there isn't one. */
export function inferExpenseFrequency(dates: string[]): PropertyExpenseFrequency | null {
  const rent = inferRentFrequency(dates);
  if (rent) return rent;
  const days = [...new Set(dates)].sort();
  if (days.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    gaps.push((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY_MS);
  }
  const mid = median(gaps);
  // Past a quarter, yearly is the only cycle a property cost has — rates and
  // insurance. Anything longer than that isn't a cycle, it's two coincidences.
  return mid > 130 && mid <= 400 ? 'annually' : null;
}

/**
 * Who the user has been PAYING, most likely property cost first.
 *
 * The same idea as the rent picker and for the same reason: the biller is read
 * off a payment that already happened rather than typed from a rates notice.
 * Ranked so the things a property actually costs — a strata manager, a council,
 * a water authority, an insurer — come first, then whatever recurs.
 *
 * `query` is what makes this usable on a real statement: the list is every
 * merchant the user has paid, so the picker is a search, not a scroll.
 */
export function suggestExpenseBillers(
  transactions: Transaction[],
  opts: { asOf?: string; limit?: number; accountId?: string | null; query?: string } = {},
): ExpenseBillerSuggestion[] {
  const asOf = opts.asOf ?? todayISO();
  const from = addPeriods(asOf, 'monthly', -12);
  const query = clean(opts.query).toLowerCase();

  const groups = new Map<string, {
    term: string; label: string; kind: PropertyExpenseKind; accountId: string | null;
    amounts: number[]; dates: string[]; total: number; latestDate: string; latestAmount: number;
  }>();

  for (const t of uniqueRealTransactions(transactions)) {
    const date = clean(t.date).slice(0, 10);
    if (!date || date <= from || date > asOf) continue;
    if (!countsAsPropertyMoney(t)) continue;
    const amount = txAmount(t);
    if (amount >= 0) continue;
    if (opts.accountId && t.account_id !== opts.accountId) continue;

    const term = derivePayerTerm(t);
    if (term.length < MIN_MATCH_TERM_LENGTH) continue;
    const label = clean(t.merchant) || clean(t.raw_description);
    if (query && !`${label} ${term}`.toLowerCase().includes(query)) continue;

    const magnitude = Math.abs(amount);
    const key = term.toLowerCase();
    const group = groups.get(key) ?? {
      term: key, label, kind: classifyPropertyExpense(t), accountId: t.account_id ?? null,
      amounts: [], dates: [], total: 0, latestDate: '', latestAmount: 0,
    };
    group.amounts.push(magnitude);
    group.dates.push(date);
    group.total = r2(group.total + magnitude);
    if (date >= group.latestDate) {
      group.latestDate = date;
      group.latestAmount = magnitude;
      group.label = label || group.label;
      if (group.kind === 'other') group.kind = classifyPropertyExpense(t);
    }
    groups.set(key, group);
  }

  const score = (g: { kind: PropertyExpenseKind; dates: string[] }) =>
    (g.kind === 'other' ? 0 : 1_000) + new Set(g.dates).size;

  return [...groups.values()]
    .sort((a, b) => score(b) - score(a) || b.total - a.total || b.latestDate.localeCompare(a.latestDate))
    .slice(0, opts.limit ?? 8)
    .map(g => ({
      term: g.term,
      label: g.label || g.term,
      kind: g.kind,
      accountId: g.accountId,
      payments: g.amounts.length,
      total: g.total,
      typicalAmount: median(g.amounts),
      frequency: inferExpenseFrequency(g.dates),
      latestDate: g.latestDate,
      latestAmount: g.latestAmount,
    }));
}

/**
 * Turn the bill the user pointed at into an expense rule, ready to save.
 *
 * The kind is a first guess from the wording and the user can change it; nothing
 * else is guessed. Amount and cycle come from what this biller has actually
 * charged, so an annual rates notice arrives as annual rather than as a mystery.
 */
export function expenseRuleFromTransaction(
  t: Transaction,
  transactions: Transaction[] = [],
  asOf?: string,
): PropertyExpenseRule | null {
  const term = derivePayerTerm(t);
  if (term.length < MIN_MATCH_TERM_LENGTH) return null;

  const match = suggestExpenseBillers(transactions.length > 0 ? transactions : [t], { asOf, limit: 50 })
    .find(b => b.term === term.toLowerCase());

  return {
    id: newRuleId(),
    name: clean(t.merchant) || clean(t.raw_description) || term,
    kind: match?.kind ?? classifyPropertyExpense(t),
    expected_amount: match?.typicalAmount ?? r2(Math.abs(txAmount(t))),
    frequency: match?.frequency ?? null,
    account_id: t.account_id ?? null,
    whole_account: false,
    match_terms: [term.toLowerCase()],
  };
}

/**
 * A new expense rule's id.
 *
 * Local, because an expense rule lives INSIDE the property row — there is no
 * table to get an id from, and one generated here survives the offline write
 * queue exactly like the property it belongs to.
 */
export function newRuleId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `pex_${Date.now().toString(36)}${rand}`;
}

/** An empty expense rule, for the "add a cost" button. */
export function blankExpenseRule(kind: PropertyExpenseKind = 'other'): PropertyExpenseRule {
  return {
    id: newRuleId(),
    name: '',
    kind,
    expected_amount: null,
    frequency: null,
    account_id: null,
    whole_account: false,
    match_terms: [],
  };
}

/**
 * The expense rules a legacy property's free-text box becomes.
 *
 * Properties set up before this refinement have one blob of match text and a
 * list of dedicated accounts. Both are still matched by the engine, but the form
 * no longer edits them, so opening such a property converts them into the rules
 * they always meant: one per biller, plus one per dedicated account with
 * `whole_account` set, which is precisely what those accounts did before.
 * Nothing is lost and nothing needs the user's attention for it to keep working.
 */
export function convertLegacyRules(
  p: Pick<Property, 'match_terms' | 'match_account_ids'>,
  accountName: (id: string) => string = id => id,
): PropertyExpenseRule[] {
  const out: PropertyExpenseRule[] = [];
  for (const raw of p.match_terms ?? []) {
    const term = clean(raw);
    if (!term) continue;
    out.push({
      id: newRuleId(),
      name: term,
      kind: classifyPropertyExpense({ merchant: term } as Transaction),
      expected_amount: null,
      frequency: null,
      account_id: null,
      whole_account: false,
      match_terms: [term.toLowerCase()],
    });
  }
  for (const id of p.match_account_ids ?? []) {
    const accountId = clean(id);
    if (!accountId) continue;
    out.push({
      id: newRuleId(),
      name: accountName(accountId),
      kind: 'other',
      expected_amount: null,
      frequency: null,
      account_id: accountId,
      whole_account: true,
      match_terms: [],
    });
  }
  return out;
}

/** What a set of rules actually catches, so the user can see it before saving. */
export interface RulePreview {
  rent: { count: number; total: number; latest: { date: string; amount: number } | null };
  expenses: {
    count: number; total: number;
    byKind: PropertyExpenseKindLine[];
    byRule: PropertyExpenseRuleLine[];
  };
  /** Every payment the rules claim, newest first — so a wrong one can be taken
   *  off before the property is even saved. */
  payments: PropertyPaymentLine[];
  /**
   * Credits the rules claim that are NOT rent. Usually the sign of an expense
   * rule wide enough to be sweeping up refunds — or, on a home, simply money
   * that came back.
   */
  otherCredits: { count: number; total: number };
}

/**
 * Run a DRAFT's rules over the user's transactions and report what they catch.
 *
 * The same engine the card uses, so the preview in the form can't promise
 * something the card then contradicts.
 */
export function previewRules(
  draft: PropertyRules & Pick<Property, 'purchase_date'>,
  transactions: Transaction[],
  asOf?: string,
): RulePreview {
  const claimed = attributeTransactions([{ id: 'preview', ...draft }], transactions).get('preview') ?? [];
  const p = buildPerformance({
    transactions: claimed,
    ownedValue: 0,
    loan: null,
    purchaseDate: draft.purchase_date ?? null,
    asOf,
    rules: draft,
  });

  return {
    rent: { count: p.rentPayments, total: p.rentReceived, latest: p.latestRent },
    expenses: {
      count: p.expenseCount, total: p.expensesPaid,
      byKind: p.expensesByKind, byRule: p.expensesByRule,
    },
    payments: p.payments,
    otherCredits: { count: p.refundCount, total: p.refunds },
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
  property_type?: PropertyType;
  rent_match_terms?: string[] | null;
  rent_account_id?: string | null;
  expected_rent_amount?: number | null;
  expected_rent_frequency?: RentFrequency | null;
  property_expenses?: PropertyExpenseRule[] | null;
  excluded_transaction_ids?: string[] | null;
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

  // ── Rent ───────────────────────────────────────────────────────────────────
  // Only an investment property has any of this. Nothing is refused for a home:
  // the form hides the rent fields and clears them on save, so a leftover rule
  // from a property that used to be let is dropped rather than argued with.
  if (canEarnRent(draft)) {
    const shortPayer = (draft.rent_match_terms ?? [])
      .map(t => clean(t))
      .filter(t => t.length > 0 && t.length < MIN_MATCH_TERM_LENGTH);
    if (shortPayer.length > 0) {
      errors.push(`The rent payer must be at least ${MIN_MATCH_TERM_LENGTH} characters — "${shortPayer[0]}" is too broad.`);
    }

    const rent = draft.expected_rent_amount;
    if (rent != null && (!Number.isFinite(rent) || rent < 0)) {
      errors.push('Expected rent must be zero or more.');
    } else if (rent != null && rent > 0 && !draft.expected_rent_frequency) {
      // Without a cycle the amount can't be turned into a year, so it can
      // neither vouch for a credit nor be compared with what came in.
      errors.push('Choose how often that rent arrives.');
    }
  }

  // ── Expenses ───────────────────────────────────────────────────────────────
  // A rule the user can't tell apart from another one is a rule they can't
  // correct later, so each needs a name; the rest is refused for the same reason
  // the match text is — a rule that catches the wrong money is worse than no
  // rule, and it is invisible until it has already changed the figures.
  const rules = draft.property_expenses ?? [];
  if (rules.some(rule => !clean(rule?.name))) {
    errors.push('Give every expense a name — "Strata", "Council rates", "Water".');
  }
  const shortBiller = rules
    .flatMap(rule => (rule?.match_terms ?? []).map(t => clean(t)))
    .filter(t => t.length > 0 && t.length < MIN_MATCH_TERM_LENGTH);
  if (shortBiller.length > 0) {
    errors.push(`Who you pay must be at least ${MIN_MATCH_TERM_LENGTH} characters — "${shortBiller[0]}" is too broad.`);
  }
  if (rules.some(rule => rule?.expected_amount != null
    && (!Number.isFinite(Number(rule.expected_amount)) || Number(rule.expected_amount) < 0))) {
    errors.push('An expected cost must be zero or more.');
  }
  // An amount with no cycle can't become a yearly figure, so it could neither
  // recognise a payment from a shared account nor be compared with what was paid.
  const amountWithoutCycle = rules.find(rule =>
    rule?.expected_amount != null && Number(rule.expected_amount) > 0 && !rule.frequency);
  if (amountWithoutCycle) {
    errors.push(`Choose how often "${clean(amountWithoutCycle.name) || 'that cost'}" falls due.`);
  }
  // A whole-account rule hands the property EVERY transaction on that account,
  // so it must actually name one — otherwise it silently claims nothing.
  if (rules.some(rule => rule?.whole_account && !clean(rule.account_id))) {
    errors.push('Choose the account before saying it is used only for this property.');
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
