/**
 * Phase 5.5 — rental property tax (pure engine).
 *
 * Turns the properties Ledger already has, and the transactions they already
 * claim, into the RENTAL SCHEDULE of an Australian tax return: gross rent,
 * deductible expenses by the ATO's own headings, the deductible part of the
 * mortgage, and the net rental income or loss that goes into taxable income.
 *
 * It stores nothing and re-derives nothing. The Property tab's engine
 * (utils/property.ts) already decides which transactions belong to which
 * property, which credit is rent and which debit is a strata levy; this module
 * takes that answer and reads it a second way — as a tax return rather than as
 * an investment.
 *
 * ── The one rule that shapes this file ───────────────────────────────────────
 * TAX IS ON WHAT HAPPENED, NOT ON WHAT WAS AGREED.
 *
 * The property card deliberately prefers the AGREED rent ($1,200 a week is
 * $62,400 a year) over the payments that happen to have landed, because a lease
 * is a better description of a year than a sample of it. That is right for a
 * yield and WRONG for a tax return: rental income is assessable when it is
 * RECEIVED, and a deduction is claimable when it is INCURRED. A vacancy, a month
 * in arrears and a tenant who left owing three weeks are all facts about the
 * year's income, and the return has to show them.
 *
 * So every figure here is measured, never expected. `expected_rent_amount`,
 * `PropertyExpenseRule.expected_amount` and the annualised figures on
 * PropertyPerformance are used for ONE thing only: naming a cost's kind. Nothing
 * a user typed as an expectation ever becomes income or a deduction.
 *
 * ── The mortgage: interest yes, principal never ──────────────────────────────
 * A repayment is not a deduction. Only the interest part is, and Ledger cannot
 * see the split — the bank feed shows one debit and the loan row holds today's
 * balance, not last year's interest. Three sources, most explicit first:
 *
 *   1. THE LENDER'S ANNUAL INTEREST STATEMENT, entered per FY. Every lender
 *      issues one and it is the figure the ATO expects. It wins outright.
 *   2. INTEREST CHARGES Ledger actually holds — debits on a loan account that
 *      read as interest. Real money, from the bank, so they are used when no
 *      statement was given, and superseded (visibly) when one was.
 *   3. NOTHING. An estimate from the balance and the rate is COMPUTED and SHOWN
 *      as a fill-in for the statement field, and is never counted: guessing the
 *      largest deduction on a rental property is how a return becomes wrong.
 *
 * Whichever is used, `principalNotDeductible` reports what the repayments came
 * to LESS that interest, so the card can show the split rather than assert it.
 *
 * ── Ownership: the recorded amount is the user's, unless they say otherwise ──
 * Co-owners declare income and expenses in proportion to their legal interest.
 * Ledger's transactions are what moved through the user's OWN accounts, so a
 * half-owner whose agent pays them half the rent has already recorded half the
 * rent, and scaling it again would halve it twice. That is why the default is
 * `recordedBasis: 'my-share'` and nothing is scaled.
 *
 * But the other arrangement is just as common — the whole rent lands in one
 * account and the co-owners settle up privately — and there is no way to tell
 * them apart from a bank feed. So a property owned less than 100% raises a
 * warning naming the exact amount at stake until the user picks, and choosing
 * `'whole'` applies the ownership share to income AND expenses alike.
 *
 * ── Private use ──────────────────────────────────────────────────────────────
 * A holiday house let for part of the year is deductible for part of the year.
 * Apportionment applies to EXPENSES ONLY and never to income: every dollar of
 * rent received is assessable however the property was used.
 *
 * The days method is the ATO's own formula, denominator included:
 *
 *   (days used to produce income + days held to produce income)
 *   ─────────────────────────────────────────────────────────── × expenses
 *      days in the income year you OWNED the property
 *
 * The denominator is days OWNED, not days accounted for. Dividing by
 * rented + private would quietly claim a property nobody rented and nobody used
 * as if it had been let all year.
 *
 * Two costs are never apportioned, because they exist only because the property
 * was let: the agent's commission and advertising for tenants.
 *
 * ── Verified against ato.gov.au, 19 August 2026 ──────────────────────────────
 *   • "How to claim rental expenses" (last updated 23 July 2026) — the three
 *     expense categories, the time-based formula, co-ownership by legal
 *     interest, and the two costs that are never apportioned;
 *   • "Rental income you must declare" (21 May 2026) — declare rent in the year
 *     the TENANT pays (the agent receiving it counts), declare the GROSS rent
 *     before the agent's fee, retained bonds and loss-of-rent payouts are
 *     income, and below-market rent to family caps deductions at the rent;
 *   • "Repair and maintenance expenses" / TR 97/23 — an initial repair is
 *     capital.
 *   The governing rulings are TR 2026/1, PCG 2026/2 and PCG 2026/3.
 *   FY 2026-27 onward carries a note that the 2026–27 Budget's announced
 *   negative-gearing changes are not modelled — the ATO says they do not apply
 *   to the 2025–26 return and has published no guidance.
 *
 * ── Available for rent ───────────────────────────────────────────────────────
 * Deductions belong to a property that is rented or GENUINELY AVAILABLE for
 * rent. A year with no rent at all is therefore a question, not an answer: an
 * `investment` property is taken to be available (that is what the type means,
 * and it is the user's own word for it), and any other kind of property is not,
 * until the user says so. Either way the reason is reported, so a year whose
 * deductions were left out says why rather than showing zero.
 *
 * ── What is deliberately NOT counted ─────────────────────────────────────────
 *   • capital works (Div 43) and depreciation (Div 40): they are not cash and
 *     no bank feed contains them. They are user-entered per FY, as a list;
 *   • borrowing expenses spread over five years, stamp duty, and the cost base
 *     items that belong to CGT (see utils/capitalGains.ts) rather than here;
 *   • a property held in an SMSF, which lodges its own return. The fund's
 *     property is reported and excluded rather than silently dropped.
 *
 * PURE — no store, no network, no localStorage. rentalTaxDS (dataService)
 * gathers the inputs; utils/taxYear.ts folds the result into the FY position.
 */

import type { Loan, Property, PropertyExpenseKind, PropertyType, Transaction } from '../types';
import { financialYearOf } from './format';
import { PERIODS_PER_YEAR, monthsBetween } from './loanEngine';
import {
  canEarnRent,
  classifyPropertyExpense,
  countsAsPropertyMoney,
  expenseRuleMatch,
  expenseRules,
  hasRentRules,
  isRentCredit,
  propertyLabel,
  rentMatch,
  rentRules,
  type PropertyRules,
} from './property';

const r2 = (n: number): number => Math.round(((Number.isFinite(n) ? n : 0) + Number.EPSILON) * 100) / 100;
const clean = (s: unknown): string => String(s ?? '').trim();
const day = (s: unknown): string => clean(s).slice(0, 10);

// ═════════════════════════════════════════════════════════════════════════════
//  Financial year
// ═════════════════════════════════════════════════════════════════════════════

/** The inclusive ISO bounds of an FY label. Local so this module never has to
 *  import taxYear.ts, which imports it. */
/**
 * The first year the 2026–27 Budget's announced negative-gearing changes could
 * bite. Nothing here models them: the ATO says plainly they do not apply to the
 * 2025–26 return and has published no guidance, so a year from here on carries a
 * note rather than a guess.
 */
export const ANNOUNCED_CHANGES_FROM_FY = '2026-2027';

export function rentalFYBounds(fy: string): { start: string; end: string } {
  const y = Number(String(fy).split('-')[0]);
  if (!Number.isFinite(y)) throw new Error(`Invalid financial year: ${fy}`);
  return { start: `${y}-07-01`, end: `${y + 1}-06-30` };
}

function inFY(date: unknown, fy: string): boolean {
  const d = day(date);
  if (d.length !== 10) return false;
  const { start, end } = rentalFYBounds(fy);
  return d >= start && d <= end;
}

// ═════════════════════════════════════════════════════════════════════════════
//  The ATO's rental-schedule headings
// ═════════════════════════════════════════════════════════════════════════════
//
// NOT the app's budget categories, and not quite the property card's either.
// The card has no heading for interest (a mortgage is not one of its costs) and
// none for management fees (they land in "other"), and both are among the
// largest deductions a landlord claims. So the return gets its own list, and
// every claimed cost is sorted into it a second time.

export type RentalDeductionKind =
  | 'interest'
  | 'council'
  | 'land-tax'
  | 'water'
  | 'strata'
  | 'insurance'
  | 'repairs'
  | 'management'
  | 'advertising'
  | 'utilities'
  | 'capital-works'
  | 'depreciation'
  | 'other';

export const RENTAL_DEDUCTION_LABELS: Record<RentalDeductionKind, string> = {
  interest: 'Interest on loans',
  council: 'Council rates',
  'land-tax': 'Land tax',
  water: 'Water charges',
  strata: 'Body corporate fees',
  insurance: 'Insurance',
  repairs: 'Repairs and maintenance',
  management: 'Property agent fees and commission',
  advertising: 'Advertising for tenants',
  utilities: 'Utilities',
  'capital-works': 'Capital works (Division 43)',
  depreciation: 'Decline in value (Division 40)',
  other: 'Other rental deductions',
};

/** The order the schedule lists them in — interest first, because it is nearly
 *  always the largest, and the two non-cash claims last because they are the
 *  only ones the user had to type in. */
export const RENTAL_DEDUCTION_ORDER: RentalDeductionKind[] = [
  'interest', 'council', 'land-tax', 'water', 'strata', 'insurance',
  'repairs', 'management', 'advertising', 'utilities',
  'capital-works', 'depreciation', 'other',
];

/**
 * A property expense rule's kind, as a rental heading.
 *
 * `other` is deliberately absent: the user picked it because the card offers
 * nothing better, so the text still gets a say (that is where a management fee
 * lives). Every other kind is the user's own statement of what the cost is and
 * outranks anything the wording suggests.
 */
const RULE_KIND_TO_RENTAL: Partial<Record<PropertyExpenseKind, RentalDeductionKind>> = {
  strata: 'strata',
  council: 'council',
  water: 'water',
  insurance: 'insurance',
  maintenance: 'repairs',
  utilities: 'utilities',
};

/**
 * Read in order, most specific first. These only run on costs the property has
 * ALREADY claimed, so they never have to decide whether a payment is the
 * property's — only which heading it belongs under.
 */
const RENTAL_TEXT_PATTERNS: [RentalDeductionKind, RegExp][] = [
  ['management', /\b(management\s*fee|managements?\s*charge|letting\s*fee|leasing\s*fee|agent\s*fee|agency\s*fee|property\s*manage\w*|commission|admin\w*\s*fee|statement\s*fee)\b/],
  ['advertising', /\b(advertis\w*|listing\s*fee|tenant\s*find|realestate\s*com|domain\s*com)\b/],
  ['land-tax', /\b(land\s*tax|state\s*revenue|revenue\s*(nsw|vic|qld|sa|wa|tas|nt|act))\b/],
  ['interest', /\b(interest\s*(charge\w*|paid|debit)?|loan\s*interest|mortgage\s*interest)\b/],
];

/** Which heading a claimed cost belongs under. */
export function rentalDeductionKindOf(
  t: Transaction,
  ruleKind: PropertyExpenseKind | null,
): RentalDeductionKind {
  if (ruleKind) {
    const mapped = RULE_KIND_TO_RENTAL[ruleKind];
    if (mapped) return mapped;
  }
  const text = `${t.merchant ?? ''} ${t.raw_description ?? ''} ${t.notes ?? ''}`.toLowerCase();
  for (const [kind, pattern] of RENTAL_TEXT_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  // Nothing in the wording, so fall back on the property card's own classifier —
  // the same reading the user already sees on the property, mapped across.
  const fallback = RULE_KIND_TO_RENTAL[classifyPropertyExpense(t)];
  return fallback ?? 'other';
}

/**
 * Costs that exist ONLY because the property was let, and are therefore never
 * apportioned for private use — the ATO says so in as many words ("You don't
 * need to apportion expenses that relate solely to renting out the property,
 * such as advertising for tenants and real estate commissions").
 */
export const NEVER_APPORTIONED: ReadonlySet<RentalDeductionKind> = new Set<RentalDeductionKind>([
  'management', 'advertising',
]);

/** True when a debit on a loan account is an interest charge rather than a
 *  repayment. Repayments move principal and are never deductible. */
export function isInterestCharge(t: Transaction): boolean {
  const text = `${t.merchant ?? ''} ${t.raw_description ?? ''} ${t.category ?? ''} ${t.notes ?? ''}`.toLowerCase();
  if (/\brepayment\b|\bprincipal\b|\bredraw\b/.test(text)) return false;
  return /\binterest\b/.test(text);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Settings — the facts a bank feed cannot contain
// ═════════════════════════════════════════════════════════════════════════════

/**
 * How the recorded amounts relate to the user's share.
 *
 *   my-share  the transactions are already the user's own slice (the default —
 *             they are, after all, the user's own accounts);
 *   whole     the transactions are the whole property's, so income AND expenses
 *             are scaled by the ownership percentage.
 */
export type RecordedBasis = 'my-share' | 'whole';

export type ApportionmentMode = 'full' | 'percent' | 'days';

/** How much of this property's costs is deductible, once private use is out. */
export interface RentalApportionment {
  mode: ApportionmentMode;
  /** mode 'percent': the deductible share, 0–100. */
  percent: number;
  /**
   * mode 'days': the ATO's numerator — days the property was occupied for rent
   * PLUS days it stood unoccupied but genuinely available for rent on
   * commercial terms. The denominator is not here: it is the days of the year
   * the property was owned, which the engine works out for itself.
   */
  daysRented: number;
  /** Nights the owner, their family or their friends had it. Recorded for the
   *  screen and to catch a total that exceeds the year; NOT the denominator. */
  daysPrivate: number;
}

export function emptyApportionment(): RentalApportionment {
  return { mode: 'full', percent: 100, daysRented: 0, daysPrivate: 0 };
}

/** One deduction Ledger cannot see — capital works, depreciation, borrowing
 *  costs. Entered by the user, per year, with the heading it belongs under. */
export interface RentalOtherDeduction {
  id: string;
  label: string;
  kind: RentalDeductionKind;
  amount: number;
}

/** The per-year facts: the lender's statement, availability, and the non-cash
 *  claims. All of them are annual figures, so all of them are stored per FY. */
export interface RentalFYSettings {
  /** Interest from the lender's annual statement. Null ⇒ not supplied. */
  interestPaid: number | null;
  /** The share of that loan that was NOT used for this property, % — a redraw
   *  for a car makes that much of the interest private and non-deductible. */
  interestPrivatePercent: number;
  /** Genuinely available for rent this year. Null ⇒ use the default for the
   *  property type. */
  availableForRent: boolean | null;
  /** Rental income with no bank record of its own — a rent-default insurance
   *  payout, a bond retained for unpaid rent, a reimbursement from a tenant. */
  otherIncome: number;
  /**
   * Let to family or friends for less than the market rate. The ATO accepts
   * deductions only up to the rent received in that case, so the year can make
   * neither a rental profit nor a rental loss.
   */
  rentBelowMarket?: boolean;
  otherDeductions: RentalOtherDeduction[];
}

export interface RentalPropertySettings {
  recordedBasis: RecordedBasis;
  apportionment: RentalApportionment;
  /** Per-expense-rule deductible share, 0–100, overriding the property's own.
   *  The electricity on a part-let holiday house is shared; the landlord
   *  insurance on it is not. */
  ruleDeductiblePercent: Record<string, number>;
  byFY: Record<string, RentalFYSettings>;
}

export function emptyFYSettings(): RentalFYSettings {
  return {
    interestPaid: null,
    interestPrivatePercent: 0,
    availableForRent: null,
    otherIncome: 0,
    rentBelowMarket: false,
    otherDeductions: [],
  };
}

export function emptyRentalSettings(): RentalPropertySettings {
  return {
    recordedBasis: 'my-share',
    apportionment: emptyApportionment(),
    ruleDeductiblePercent: {},
    byFY: {},
  };
}

/** One property's settings for one year, with every default filled in. */
export function fySettingsFor(
  settings: RentalPropertySettings | null | undefined,
  fy: string,
): RentalFYSettings {
  const raw = settings?.byFY?.[fy];
  const base = emptyFYSettings();
  if (!raw) return base;
  return {
    interestPaid: raw.interestPaid == null ? null : Math.max(0, Number(raw.interestPaid) || 0),
    interestPrivatePercent: clampPercent(raw.interestPrivatePercent),
    availableForRent: raw.availableForRent == null ? null : raw.availableForRent === true,
    otherIncome: Math.max(0, Number(raw.otherIncome) || 0),
    rentBelowMarket: raw.rentBelowMarket === true,
    otherDeductions: (raw.otherDeductions ?? [])
      .filter(d => d && clean(d.id) !== '')
      .map(d => ({
        id: clean(d.id),
        label: clean(d.label) || RENTAL_DEDUCTION_LABELS[d.kind] || 'Deduction',
        kind: RENTAL_DEDUCTION_ORDER.includes(d.kind) ? d.kind : 'other',
        amount: Math.max(0, Number(d.amount) || 0),
      })),
  };
}

function clampPercent(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * The share of this property's costs that is deductible.
 *
 * `days` is the ATO's time-based method: the nights it earned or stood ready to
 * earn, over the nights it was OWNED. `daysOwned` comes from the engine, not
 * from the user — it is a fact about the calendar and the settlement date, and
 * asking for it again would let the two disagree.
 *
 * A year with no nights recorded at all falls back to fully deductible rather
 * than to zero: an unanswered question must not silently wipe out a claim.
 */
export function deductibleShareOf(
  a: RentalApportionment | null | undefined,
  daysOwned: number,
): number {
  const app = a ?? emptyApportionment();
  if (app.mode === 'percent') return clampPercent(app.percent) / 100;
  if (app.mode === 'days') {
    const rented = Math.max(0, Number(app.daysRented) || 0);
    if (rented <= 0 && Math.max(0, Number(app.daysPrivate) || 0) <= 0) return 1;
    if (daysOwned <= 0) return 1;
    return Math.min(1, rented / daysOwned);
  }
  return 1;
}

/** Days of the FY this property was owned — the denominator above. Inclusive of
 *  both ends, never before settlement, never past today in a year still running. */
export function daysOwnedInFY(purchaseDate: string | null, fy: string, asOf: string): number {
  const { start, end } = rentalFYBounds(fy);
  const from = purchaseDate && purchaseDate > start ? purchaseDate : start;
  const to = asOf && asOf < end ? asOf : end;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / 86_400_000) + 1;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Results
// ═════════════════════════════════════════════════════════════════════════════

/** One transaction the schedule counted, for drill-down back to the source. */
export interface RentalPaymentLine {
  id: string;
  date: string;
  /** Always positive; `flow` says which way the money went. */
  amount: number;
  merchant: string;
  flow: 'rent' | 'expense' | 'refund' | 'interest';
  /** The heading it was counted under. Null for rent. */
  kind: RentalDeductionKind | null;
  /** What claimed it — the payer term, the expense rule's name, the account. */
  via: string;
  /** The expense rule that claimed it, when one did. */
  ruleId: string | null;
}

/** One heading of the schedule, with the payments behind it. */
export interface RentalDeductionLine {
  key: string;
  kind: RentalDeductionKind;
  label: string;
  /** What actually left the bank under this heading, before anything is taken
   *  off it. */
  paid: number;
  /** Money that came back under this heading inside the year. */
  refunded: number;
  /** paid − refunded, floored at 0. */
  net: number;
  /** net × the ownership factor × the deductible share. What is claimed. */
  claimed: number;
  count: number;
  /** True when `claimed` is less than `net` — the card says why. */
  apportioned: boolean;
  /** Where the figure came from, when it isn't simply "n payments". */
  detail: string | null;
  payments: RentalPaymentLine[];
}

export type RentalInterestBasis = 'statement' | 'transactions' | 'none';

export interface RentalInterest {
  /** The lender's annual statement figure, when the user supplied one. */
  statement: number | null;
  /** Interest charges Ledger holds for this loan inside the year. */
  fromTransactions: number;
  transactionIds: string[];
  /**
   * Balance × rate over the year. SHOWN as a fill-in for the statement field and
   * NEVER counted — see the header. Null with no rate or no balance on file.
   */
  estimate: number | null;
  basis: RentalInterestBasis;
  /** The interest before the private share and the ownership factor. */
  gross: number;
  privatePercent: number;
  /** What is actually deducted. */
  deductible: number;
  /** Scheduled repayments over the year, from the loan's own terms. */
  repayments: number;
  /**
   * repayments − gross, floored at 0. The part of the mortgage that is NOT a
   * deduction, reported rather than merely omitted so the card can show the
   * split instead of asserting it.
   */
  principalNotDeductible: number;
}

export type RentalWarningKind =
  | 'no-interest'
  | 'interest-superseded'
  | 'ownership-unapportioned'
  | 'not-available-for-rent'
  | 'private-use'
  | 'vacant-year'
  | 'refund-exceeds-cost'
  | 'initial-repairs'
  | 'rent-net-of-fees'
  | 'no-rent-rules'
  | 'held-in-fund'
  | 'below-market-rent'
  | 'announced-changes'
  | 'net-rental-loss';

export interface RentalWarning {
  kind: RentalWarningKind;
  severity: 'info' | 'warn';
  message: string;
  /** The sum at stake, when the warning has one. The engine never formats money. */
  amount?: number;
  /** The property it is about. Null for a warning about the whole schedule. */
  propertyId?: string | null;
}

/** Why a property contributed nothing to the schedule. */
export type RentalExclusionReason =
  | 'owner-occupied'
  | 'not-available-for-rent'
  | 'held-in-fund'
  | 'no-activity';

export interface RentalPropertyResult {
  id: string;
  label: string;
  fy: string;
  /** True when this property's figures are in the schedule's totals. */
  inSchedule: boolean;
  excludedReason: RentalExclusionReason | null;
  propertyType: PropertyType | null;
  ownershipPercent: number;
  recordedBasis: RecordedBasis;
  /** What every recorded amount was multiplied by — 1, or the ownership share. */
  shareFactor: number;
  /** What the expenses were then multiplied by, for private use. */
  deductibleShare: number;
  /** Rent received inside the year, after the ownership factor. */
  grossRent: number;
  /** Rent the bank never saw — a payout, a retained bond — from the settings. */
  otherIncome: number;
  /** grossRent + otherIncome. */
  income: number;
  deductions: RentalDeductionLine[];
  totalDeductions: number;
  /** income − totalDeductions. NEGATIVE for a negatively geared property. */
  netRent: number;
  interest: RentalInterest;
  rentPayments: RentalPaymentLine[];
  /** Months of the year this property was owned, and how many brought rent in. */
  monthsOwned: number;
  monthsWithRent: number;
  vacantMonths: number;
  warnings: RentalWarning[];
}

export interface RentalPosition {
  fy: string;
  properties: RentalPropertyResult[];
  /** Every property that contributed, and every one that did not, is in
   *  `properties`; these totals only count the ones that did. */
  grossIncome: number;
  totalDeductions: number;
  /** grossIncome − totalDeductions. Negative when negatively geared. */
  netRent: number;
  /**
   * The loss as a POSITIVE number, or 0. This is the net rental loss the ATO
   * adds back for study-loan repayments, the Medicare levy surcharge and the
   * seniors offset — the one figure here that leaves the tax calculation and
   * turns up in a different income base entirely.
   */
  netRentalLoss: number;
  /**
   * Transactions the schedule has counted. Anything in here must not ALSO be
   * counted by the general deduction view or as ordinary income, so the FY
   * position uses it as a suppression set.
   */
  claimedTransactionIds: string[];
  /** Transactions a manual deduction explicitly links to, which the schedule
   *  therefore released rather than claimed. */
  releasedTransactionIds: string[];
  warnings: RentalWarning[];
}

// ═════════════════════════════════════════════════════════════════════════════
//  Input
// ═════════════════════════════════════════════════════════════════════════════

export interface RentalPropertyInput {
  property: Property;
  /** The transactions this property claimed, already attributed and deduped by
   *  utils/property.ts. Any year; this module filters to the FY itself. */
  transactions: Transaction[];
  /** The linked mortgage, for the interest estimate and the principal split. */
  loan: Loan | null;
  /** Interest charges Ledger holds against that loan — debits on a loan account.
   *  Excluded from `transactions` by countsAsPropertyMoney, so they arrive
   *  separately. */
  interestTransactions?: Transaction[];
  settings?: RentalPropertySettings | null;
}

export interface RentalPositionInput {
  fy: string;
  properties: RentalPropertyInput[];
  /**
   * Transactions a manual deduction explicitly links to. An explicit link is the
   * most explicit record there is, so the schedule steps aside for it rather
   * than claiming the same payment a second time.
   */
  manuallyLinkedTransactionIds?: Set<string> | string[];
  /** Today, for a year still running: an unfinished year has fewer months in it
   *  and must not read as eleven months of vacancy. */
  asOf?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Interest
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What this loan would charge over a full year at today's balance and rate.
 *
 * A fill-in for the statement field and nothing else — it is today's balance,
 * not the balance the year was actually charged on, and it knows nothing of the
 * repayments made during it. Null when the loan has no rate or no balance, and
 * null for an indexed debt (HECS has no interest at all).
 */
export function estimateAnnualInterest(loan: Loan | null): number | null {
  if (!loan) return null;
  const balance = Math.max(0, Number(loan.current_balance) || 0);
  const rate = Number(loan.interest_rate) || 0;
  if (balance <= 0 || rate <= 0) return null;
  const offset = Math.max(0, Number(loan.offset_balance) || 0);
  return r2(Math.max(0, balance - offset) * (rate / 100));
}

/** Scheduled repayments over a full year, from the loan's own terms. The
 *  denominator of the interest/principal split, never a deduction itself. */
export function annualRepayments(loan: Loan | null): number {
  if (!loan) return 0;
  const ppy = PERIODS_PER_YEAR[loan.repayment_frequency ?? 'monthly'] ?? 12;
  const per = (Number(loan.minimum_repayment) || 0) + (Number(loan.extra_repayment) || 0);
  return r2(Math.max(0, per) * ppy);
}

function buildInterest(input: {
  fy: string;
  loan: Loan | null;
  interestTransactions: Transaction[];
  settings: RentalFYSettings;
  shareFactor: number;
  deductibleShare: number;
}): { interest: RentalInterest; payments: RentalPaymentLine[] } {
  const charges = input.interestTransactions.filter(
    t => inFY(t.date, input.fy) && isInterestCharge(t),
  );
  const fromTransactions = r2(
    charges.reduce((s, t) => s + Math.abs(Number(t.display_amount ?? t.amount) || 0), 0),
  );
  const statement = input.settings.interestPaid;
  const basis: RentalInterestBasis = statement != null
    ? 'statement'
    : fromTransactions > 0 ? 'transactions' : 'none';
  const gross = basis === 'statement' ? r2(statement!) : basis === 'transactions' ? fromTransactions : 0;
  const privatePercent = input.settings.interestPrivatePercent;

  // Private use of the BORROWED MONEY and private use of the PROPERTY are two
  // different reductions and both apply: a redraw for a car makes part of the
  // interest private whatever the house is used for, and a house let for half
  // the year is deductible for half of whatever is left.
  const deductible = r2(
    gross * (1 - privatePercent / 100) * input.shareFactor * input.deductibleShare,
  );

  const repayments = annualRepayments(input.loan);
  const payments: RentalPaymentLine[] = basis === 'transactions'
    ? charges.map(t => ({
        id: t.id,
        date: day(t.date),
        amount: r2(Math.abs(Number(t.display_amount ?? t.amount) || 0)),
        merchant: clean(t.merchant) || clean(t.raw_description) || 'Interest charged',
        flow: 'interest' as const,
        kind: 'interest' as const,
        via: 'an interest charge on the loan account',
        ruleId: null,
      }))
    : [];

  return {
    interest: {
      statement,
      fromTransactions,
      transactionIds: charges.map(t => t.id),
      estimate: estimateAnnualInterest(input.loan),
      basis,
      gross,
      privatePercent,
      deductible,
      repayments,
      principalNotDeductible: r2(Math.max(0, repayments - gross)),
    },
    payments,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  One property, one year
// ═════════════════════════════════════════════════════════════════════════════

/** Months of the FY this property was owned for — never before it was bought,
 *  never past today in a year still running. */
function monthsOwnedInFY(purchaseDate: string | null, fy: string, asOf: string): number {
  const { start, end } = rentalFYBounds(fy);
  const from = purchaseDate && purchaseDate > start ? purchaseDate : start;
  const to = asOf < end ? asOf : end;
  if (to <= from) return 0;
  return Math.max(1, Math.min(12, monthsBetween(from, to) + (to === end ? 1 : 0)));
}

/**
 * A property with no rent at all this year is only in the schedule if it was
 * genuinely available for rent. The user's explicit answer wins; failing that,
 * `investment` means available (it is the user's own word for what the property
 * is FOR) and nothing else does.
 */
export function defaultAvailableForRent(propertyType: PropertyType | null | undefined): boolean {
  return propertyType === 'investment';
}

export function buildRentalProperty(
  input: RentalPropertyInput & { fy: string; asOf: string; manuallyLinked: Set<string> },
): RentalPropertyResult {
  const { fy, property } = input;
  const label = propertyLabel(property);
  const rules: PropertyRules = property;
  const settings = input.settings ?? emptyRentalSettings();
  const fySettings = fySettingsFor(settings, fy);
  const warnings: RentalWarning[] = [];
  const warn = (kind: RentalWarningKind, severity: 'info' | 'warn', message: string, amount?: number) => {
    warnings.push({ kind, severity, message, amount, propertyId: property.id });
  };

  const ownershipPercent = (() => {
    const n = Number(property.ownership_percent);
    return Number.isFinite(n) && n > 0 && n <= 100 ? n : 100;
  })();
  const recordedBasis = settings.recordedBasis === 'whole' ? 'whole' : 'my-share';
  const shareFactor = recordedBasis === 'whole' ? ownershipPercent / 100 : 1;
  const daysOwned = daysOwnedInFY(day(property.purchase_date) || null, fy, input.asOf);
  const deductibleShare = deductibleShareOf(settings.apportionment, daysOwned);
  const monthsOwned = monthsOwnedInFY(day(property.purchase_date) || null, fy, input.asOf);

  const empty = (reason: RentalExclusionReason): RentalPropertyResult => ({
    id: property.id,
    label,
    fy,
    inSchedule: false,
    excludedReason: reason,
    propertyType: property.property_type ?? null,
    ownershipPercent,
    recordedBasis,
    shareFactor,
    deductibleShare,
    grossRent: 0,
    otherIncome: 0,
    income: 0,
    deductions: [],
    totalDeductions: 0,
    netRent: 0,
    interest: {
      statement: fySettings.interestPaid,
      fromTransactions: 0,
      transactionIds: [],
      estimate: estimateAnnualInterest(input.loan),
      basis: 'none',
      gross: 0,
      privatePercent: fySettings.interestPrivatePercent,
      deductible: 0,
      repayments: annualRepayments(input.loan),
      principalNotDeductible: 0,
    },
    rentPayments: [],
    monthsOwned,
    monthsWithRent: 0,
    vacantMonths: 0,
    warnings,
  });

  // A home earns nothing and claims nothing. Nothing about it is a question.
  if (!canEarnRent(rules)) return empty('owner-occupied');

  // An SMSF lodges its own return; the fund's rent is not the member's income.
  if (property.held_by === 'smsf') {
    warn('held-in-fund', 'info',
      'This property is held in your SMSF, which lodges its own return. Its rent and expenses are ' +
      'not part of your personal rental schedule.');
    return empty('held-in-fund');
  }

  // ── Split the claimed transactions into rent, refunds and costs ────────────
  const rr = rentRules(rules);
  const rentByRules = hasRentRules(rules);
  const exRules = expenseRules(rules);

  const claimed = input.transactions.filter(
    t => inFY(t.date, fy) && countsAsPropertyMoney(t),
  );

  const rentPayments: RentalPaymentLine[] = [];
  const rentMonths = new Set<number>();
  let grossRentRaw = 0;

  interface Bucket { paid: number; refunded: number; count: number; payments: RentalPaymentLine[] }
  const buckets = new Map<RentalDeductionKind, Bucket>();
  const bucket = (k: RentalDeductionKind): Bucket => {
    const b = buckets.get(k) ?? { paid: 0, refunded: 0, count: 0, payments: [] };
    buckets.set(k, b);
    return b;
  };

  const claimedIds: string[] = [];
  const releasedIds: string[] = [];
  /** Per-rule deductible shares, so one cost can differ from the property's. */
  const ruleShare = (ruleId: string | null, kind: RentalDeductionKind): number => {
    // A cost that only exists because the property was let is never apportioned,
    // whatever the property's own split is.
    if (NEVER_APPORTIONED.has(kind)) return 1;
    if (!ruleId) return deductibleShare;
    const raw = settings.ruleDeductiblePercent?.[ruleId];
    return raw == null ? deductibleShare : clampPercent(raw) / 100;
  };
  const shareByKind = new Map<RentalDeductionKind, { weighted: number; net: number }>();

  const purchase = day(property.purchase_date);
  let initialRepairs = 0;

  for (const t of claimed) {
    const amount = Number(t.display_amount ?? t.amount) || 0;
    const d = day(t.date);
    const rule = exRules.length > 0 ? expenseRuleMatch(t, exRules)?.rule ?? null : null;

    if (amount > 0) {
      // Rent is recognised exactly as the property card recognises it, so the
      // two screens can never disagree about which credit was rent. With no rent
      // rules at all, every credit the property claimed is rent — the same
      // reading, and the same reason: a dedicated account.
      const isRent = rentByRules ? isRentCredit(t, rr) : true;
      if (isRent) {
        grossRentRaw = r2(grossRentRaw + amount);
        rentMonths.add(Math.max(0, monthsBetween(rentalFYBounds(fy).start, d)));
        claimedIds.push(t.id);
        rentPayments.push({
          id: t.id,
          date: d,
          amount: r2(amount),
          merchant: clean(t.merchant) || clean(t.raw_description) || 'Rent',
          flow: 'rent',
          kind: null,
          via: rentByRules ? (rentMatch(t, rr)?.term ?? 'the rent account') : 'this property’s account',
          ruleId: null,
        });
        continue;
      }
      // Not rent, so it is money the property gave back: it reduces the cost it
      // came back against rather than being declared as income. A council
      // refund is not rental income and never was.
      const kind = rentalDeductionKindOf(t, rule?.kind ?? null);
      const b = bucket(kind);
      b.refunded = r2(b.refunded + amount);
      claimedIds.push(t.id);
      b.payments.push({
        id: t.id,
        date: d,
        amount: r2(amount),
        merchant: clean(t.merchant) || clean(t.raw_description) || 'Refund',
        flow: 'refund',
        kind,
        via: rule ? rule.name : 'money that came back',
        ruleId: rule?.id ?? null,
      });
      continue;
    }

    if (amount >= 0) continue;

    // An explicit manual-deduction link is the user saying "this payment is
    // already claimed, here". The schedule releases it rather than claiming the
    // same money twice — see the header of utils/taxYear.ts on which record wins.
    if (input.manuallyLinked.has(t.id)) {
      releasedIds.push(t.id);
      continue;
    }

    const magnitude = Math.abs(amount);
    const kind = rentalDeductionKindOf(t, rule?.kind ?? null);
    const b = bucket(kind);
    b.paid = r2(b.paid + magnitude);
    b.count += 1;
    claimedIds.push(t.id);
    b.payments.push({
      id: t.id,
      date: d,
      amount: r2(magnitude),
      merchant: clean(t.merchant) || clean(t.raw_description) || 'Payment',
      flow: 'expense',
      kind,
      via: rule ? rule.name : 'this property’s expenses',
      ruleId: rule?.id ?? null,
    });

    // Track the deductible share this cost carries, weighted by what it came to,
    // so a heading holding two rules with different shares apportions correctly.
    const share = ruleShare(rule?.id ?? null, kind);
    const agg = shareByKind.get(kind) ?? { weighted: 0, net: 0 };
    shareByKind.set(kind, { weighted: r2(agg.weighted + magnitude * share), net: r2(agg.net + magnitude) });

    // An INITIAL REPAIR — putting right something that was already wrong when
    // the property was bought — is CAPITAL, not a deduction (TR 97/23). The
    // ATO's test is the state of the property at acquisition, which no bank feed
    // records, so the first year of ownership is only a PROMPT to check. The
    // cost is still claimed: leaving a genuine repair out would overstate the
    // tax on every landlord who fixed a tap.
    if (kind === 'repairs' && purchase && d >= purchase && monthsBetween(purchase, d) < 12) {
      initialRepairs = r2(initialRepairs + magnitude);
    }
  }

  // ── Was it in the schedule at all? ────────────────────────────────────────
  const hasActivity = grossRentRaw > 0 || buckets.size > 0
    || fySettings.otherIncome > 0 || fySettings.otherDeductions.length > 0
    || fySettings.interestPaid != null;
  if (!hasActivity) return empty('no-activity');

  const availableForRent = fySettings.availableForRent
    ?? (grossRentRaw > 0 ? true : defaultAvailableForRent(property.property_type));
  if (!availableForRent) {
    const atStake = r2(
      [...buckets.values()].reduce((s, b) => s + Math.max(0, b.paid - b.refunded), 0),
    );
    const result = empty('not-available-for-rent');
    result.warnings.push({
      kind: 'not-available-for-rent',
      severity: 'warn',
      propertyId: property.id,
      amount: atStake,
      message:
        `${label} brought in no rent this year, so nothing has been claimed for it. Deductions belong ` +
        'to a property that was rented or genuinely available for rent — say so on the property and ' +
        'this much goes back in:',
    });
    return result;
  }

  // ── Interest ───────────────────────────────────────────────────────────────
  const { interest, payments: interestPayments } = buildInterest({
    fy,
    loan: input.loan,
    interestTransactions: input.interestTransactions ?? [],
    settings: fySettings,
    shareFactor,
    deductibleShare,
  });

  // ── The schedule's headings ────────────────────────────────────────────────
  const lines: RentalDeductionLine[] = [];

  if (interest.deductible > 0 || interest.gross > 0 || interestPayments.length > 0) {
    lines.push({
      key: `${property.id}:interest`,
      kind: 'interest',
      label: RENTAL_DEDUCTION_LABELS.interest,
      paid: interest.gross,
      refunded: 0,
      net: interest.gross,
      claimed: interest.deductible,
      count: interest.basis === 'transactions' ? interestPayments.length : 0,
      apportioned: interest.deductible < interest.gross,
      detail: interest.basis === 'statement'
        ? 'from your lender’s annual interest statement'
        : interest.basis === 'transactions'
          ? null
          : 'no figure entered — nothing claimed',
      payments: interestPayments,
    });
  }

  for (const [kind, b] of buckets) {
    const net = r2(Math.max(0, b.paid - b.refunded));
    const agg = shareByKind.get(kind);
    // The weighted share of the costs that actually make up this heading. A
    // heading holding nothing but refunds has no costs to weight, so it takes
    // the property's own share.
    const share = agg && agg.net > 0
      ? agg.weighted / agg.net
      : NEVER_APPORTIONED.has(kind) ? 1 : deductibleShare;
    const claimedAmount = r2(net * shareFactor * share);
    lines.push({
      key: `${property.id}:${kind}`,
      kind,
      label: RENTAL_DEDUCTION_LABELS[kind],
      paid: b.paid,
      refunded: b.refunded,
      net,
      claimed: claimedAmount,
      count: b.count,
      apportioned: claimedAmount < net,
      detail: null,
      payments: b.payments.sort((x, y) => y.date.localeCompare(x.date) || y.amount - x.amount),
    });

    if (b.refunded > b.paid) {
      warn('refund-exceeds-cost', 'warn',
        `More came back under ${RENTAL_DEDUCTION_LABELS[kind]} than went out this year. A refund of a ` +
        'cost you claimed in an EARLIER year is income in the year you receive it, not a reduction of ' +
        'this one — check which year the original bill was in:',
        r2(b.refunded - b.paid));
    }
  }

  // The two claims no bank feed can contain. They are apportioned for private
  // use like every other cost, but never scaled by the ownership factor: the
  // user entered their own figure, so it is already their own share.
  for (const extra of fySettings.otherDeductions) {
    if (extra.amount <= 0) continue;
    const claimedAmount = r2(extra.amount * (NEVER_APPORTIONED.has(extra.kind) ? 1 : deductibleShare));
    lines.push({
      key: `${property.id}:manual:${extra.id}`,
      kind: extra.kind,
      label: extra.label,
      paid: extra.amount,
      refunded: 0,
      net: extra.amount,
      claimed: claimedAmount,
      count: 0,
      apportioned: claimedAmount < extra.amount,
      detail: 'entered by you — no bank feed contains it',
      payments: [],
    });
  }

  lines.sort((a, b) =>
    RENTAL_DEDUCTION_ORDER.indexOf(a.kind) - RENTAL_DEDUCTION_ORDER.indexOf(b.kind)
    || b.claimed - a.claimed
    || a.label.localeCompare(b.label));

  const grossRent = r2(grossRentRaw * shareFactor);
  const otherIncome = fySettings.otherIncome;
  const income = r2(grossRent + otherIncome);
  const claimedBeforeCap = r2(lines.reduce((s, l) => s + l.claimed, 0));

  // Let to family or friends below the market rate: the ATO accepts deductions
  // only up to the rent received, so the year makes neither a profit nor a loss.
  // The lines keep their own figures — the cap is stated, not hidden inside them.
  const capped = fySettings.rentBelowMarket === true && claimedBeforeCap > income;
  const totalDeductions = capped ? r2(income) : claimedBeforeCap;
  const netRent = r2(income - totalDeductions);

  const monthsWithRent = rentMonths.size;
  const vacantMonths = Math.max(0, monthsOwned - monthsWithRent);

  // ── What the user should look at ───────────────────────────────────────────
  if (capped) {
    warn('below-market-rent', 'info',
      `${label} is let below the market rate, so its deductions are capped at the rent it earned — ` +
      'it can make neither a rental profit nor a rental loss. The costs above it are not carried ' +
      'anywhere; this much simply cannot be claimed:',
      r2(claimedBeforeCap - income));
  }
  if (ownershipPercent < 100 && recordedBasis === 'my-share') {
    warn('ownership-unapportioned', 'warn',
      `You own ${ownershipPercent}% of ${label}, and these figures are being read as your share ` +
      'already — nothing has been divided. If the whole property’s rent and bills go through these ' +
      'accounts and you settle up with your co-owner privately, say so and your share becomes:',
      r2(Math.abs(netRent) * (ownershipPercent / 100)));
  }
  if (interest.basis === 'none' && input.loan) {
    warn('no-interest', 'warn',
      'No interest has been claimed on this property’s mortgage. Interest is normally the largest ' +
      'deduction a landlord has — enter the figure from your lender’s annual interest statement. ' +
      (interest.estimate != null ? 'At this loan’s current balance and rate a full year would be about:' : ''),
      interest.estimate ?? undefined);
  }
  if (interest.basis === 'statement' && interest.fromTransactions > 0) {
    warn('interest-superseded', 'info',
      'Your lender’s statement figure is being used, not the interest charges in your transactions — ' +
      'they are two records of the same charge, so they are not added together. The charges came to:',
      interest.fromTransactions);
  }
  if (deductibleShare < 1) {
    warn('private-use', 'warn',
      `${label} is apportioned for private use, so only ${r2(deductibleShare * 100)}% of its costs is ` +
      (settings.apportionment.mode === 'days'
        ? `being claimed — ${settings.apportionment.daysRented} nights let or available out of the `
          + `${daysOwned} you owned it. `
        : 'being claimed. ')
      + 'The rent is not apportioned — every dollar you received is assessable. Agent fees and ' +
      'advertising are not apportioned either, because they only exist because you let it:',
      r2([...lines].reduce((s, l) => s + (l.net - l.claimed), 0)));
  }
  if (grossRentRaw === 0 && availableForRent) {
    warn('vacant-year', 'info',
      `${label} received no rent this year. Its costs are still claimed because it was available for ` +
      'rent, which is what the ATO asks — but be sure it genuinely was.');
  } else if (vacantMonths > 0) {
    warn('vacant-year', 'info',
      `${vacantMonths} of the ${monthsOwned} months you owned ${label} this year brought in no rent. ` +
      'Only the rent that arrived is counted, so a vacancy reduces the income here on its own.');
  }
  if (initialRepairs > 0) {
    warn('initial-repairs', 'warn',
      `${label} had repairs within a year of being bought. Putting right something that was already ` +
      'wrong when you bought it is a CAPITAL cost, not a repair — it goes to capital works and the CGT ' +
      'cost base. This much has been claimed as a repair; check it was damage that happened while you ' +
      'were letting it, not a fault you inherited:',
      r2(initialRepairs * shareFactor * deductibleShare));
  }
  if (grossRentRaw > 0 && !lines.some(l => l.kind === 'management' && l.claimed > 0) && rentByRules) {
    warn('rent-net-of-fees', 'info',
      'If your agent takes their commission before passing the rent on, the rent counted here is the ' +
      'net amount. The ATO wants the gross rent with the fee as a deduction — the net figure and the ' +
      'tax on it are identical either way, so nothing below is wrong; only the two lines are missing.');
  }
  if (!rentByRules && grossRentRaw > 0) {
    warn('no-rent-rules', 'info',
      `Every credit ${label} claimed has been counted as rent, because no rent payer is set up on it. ` +
      'Name the payer on the property if anything other than rent lands in that account.');
  }

  return {
    id: property.id,
    label,
    fy,
    inSchedule: true,
    excludedReason: null,
    propertyType: property.property_type ?? null,
    ownershipPercent,
    recordedBasis,
    shareFactor,
    deductibleShare,
    grossRent,
    otherIncome,
    income,
    deductions: lines,
    totalDeductions,
    netRent,
    interest,
    rentPayments: rentPayments.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount),
    monthsOwned,
    monthsWithRent,
    vacantMonths,
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  The whole schedule
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every property's rental position for one year.
 *
 * Properties that contributed nothing are still returned, with the reason —
 * a schedule that silently omits the holiday house is indistinguishable from
 * one that forgot it.
 */
export function buildRentalPosition(input: RentalPositionInput): RentalPosition {
  const fy = input.fy;
  const asOf = day(input.asOf) || rentalFYBounds(fy).end;
  const manuallyLinked = new Set(
    input.manuallyLinkedTransactionIds instanceof Set
      ? [...input.manuallyLinkedTransactionIds]
      : (input.manuallyLinkedTransactionIds ?? []),
  );

  const properties = input.properties.map(p =>
    buildRentalProperty({ ...p, fy, asOf, manuallyLinked }));

  const counted = properties.filter(p => p.inSchedule);
  const grossIncome = r2(counted.reduce((s, p) => s + p.income, 0));
  const totalDeductions = r2(counted.reduce((s, p) => s + p.totalDeductions, 0));
  const netRent = r2(grossIncome - totalDeductions);

  const claimedTransactionIds: string[] = [];
  const releasedTransactionIds: string[] = [];
  for (const p of counted) {
    for (const line of p.rentPayments) claimedTransactionIds.push(line.id);
    for (const d of p.deductions) {
      for (const line of d.payments) claimedTransactionIds.push(line.id);
    }
  }
  // A released transaction is one the schedule chose not to claim, so it is
  // collected from the raw input rather than from the result.
  for (const p of input.properties) {
    for (const t of p.transactions) {
      if (manuallyLinked.has(t.id) && inFY(t.date, fy)) releasedTransactionIds.push(t.id);
    }
  }

  const warnings: RentalWarning[] = properties.flatMap(p => p.warnings);
  if (counted.length > 0 && fy >= ANNOUNCED_CHANGES_FROM_FY) {
    warnings.push({
      kind: 'announced-changes',
      severity: 'info',
      propertyId: null,
      message:
        'The negative-gearing changes announced in the 2026–27 Federal Budget are not applied here. ' +
        'The ATO says they do not affect the 2025–26 return and has not published guidance for later ' +
        'years, so this schedule uses the rules as they stand.',
    });
  }
  if (netRent < 0) {
    warnings.push({
      kind: 'net-rental-loss',
      severity: 'info',
      propertyId: null,
      amount: r2(-netRent),
      message:
        'Your properties cost more than they earned this year. Unlike a capital loss, a net rental loss ' +
        'DOES reduce your other income — it is already in the estimate below. It is also added back for ' +
        'study loan repayments, the Medicare levy surcharge and the seniors offset, which is why those ' +
        'are assessed on more than your taxable income:',
    });
  }

  return {
    fy,
    properties,
    grossIncome,
    totalDeductions,
    netRent,
    netRentalLoss: r2(Math.max(0, -netRent)),
    claimedTransactionIds: [...new Set(claimedTransactionIds)],
    releasedTransactionIds: [...new Set(releasedTransactionIds)],
    warnings,
  };
}

/** Every FY any property earned or spent anything in — so a year whose only
 *  event was a rental one still appears in the tax-year switcher. */
export function rentalActivityDates(properties: RentalPropertyInput[]): string[] {
  const out: string[] = [];
  for (const p of properties) {
    if (!canEarnRent(p.property)) continue;
    for (const t of p.transactions) {
      const d = day(t.date);
      if (d.length === 10) out.push(d);
    }
    for (const t of p.interestTransactions ?? []) {
      const d = day(t.date);
      if (d.length === 10) out.push(d);
    }
    for (const fy of Object.keys(p.settings?.byFY ?? {})) {
      if (/^\d{4}-\d{4}$/.test(fy)) out.push(rentalFYBounds(fy).end);
    }
  }
  return [...new Set(out)];
}

/** Which FY a date falls in — re-exported so callers need only this module. */
export const rentalFinancialYearOf = financialYearOf;
