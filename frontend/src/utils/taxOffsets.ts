/**
 * Phase 5.3 — AUSTRALIAN TAX OFFSETS AND HEALTH ADJUSTMENTS (data + pure maths).
 *
 * Four things the Phase 5.1/5.2 engines deliberately left out, because each one
 * needs a fact about the PERSON that no bank feed or payslip carries:
 *
 *   • LITO   — the low income tax offset. Needs nothing but taxable income, and
 *              was still excluded until now because there was nowhere to put a
 *              non-refundable offset in the settlement.
 *   • LMITO  — the low and middle income tax offset. Existed for 2018-19 to
 *              2021-22 only; two of those years are in Ledger's range, so the
 *              years it applied to are wrong without it.
 *   • SAPTO  — the seniors and pensioners tax offset. Needs age-pension
 *              eligibility and whether the taxpayer is a member of a couple.
 *   • MLS +  — the Medicare levy surcharge, and the private health insurance
 *     health   rebate reconciliation. Both need private hospital cover, family
 *              income and the figures off a private health statement.
 *
 * This module is STRUCTURED LIKE utils/taxRates.ts AND FOLLOWS ITS TWO RULES:
 *
 *  1. A year Ledger has no offset settings for returns `null` from
 *     `offsetSettingsFor`. It never falls back to a neighbouring year — a
 *     2019-20 senior assessed on 2025-26 shade-out thresholds is worse than no
 *     offset at all, because it looks like an answer. `taxOffsets.audit.test.ts`
 *     asserts this registry covers exactly the same years as taxRates.ts, so the
 *     two can never drift apart.
 *  2. Every year declares its `confidence` and says WHICH figures are carried.
 *     The surcharge thresholds are indexed each year and the private health
 *     rebate percentage is re-set every 1 April, so a future year holds the last
 *     published figure and the UI says so.
 *
 * VERIFIED against the ATO's own tables on 19 August 2026:
 *   • LITO             ato.gov.au/individuals-and-families/income-deductions-offsets-and-
 *                      records/tax-offsets/low-income-tax-offset
 *   • LMITO            ato.gov.au/forms-and-instructions/low-and-middle-income-earner-tax-offsets
 *   • SAPTO            ato.gov.au/individuals-and-families/income-deductions-offsets-and-
 *                      records/tax-offsets/seniors-and-pensioners-tax-offset
 *   • MLS thresholds   ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/
 *                      medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates
 *   • Rebate rates     ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/
 *                      private-health-insurance-rebate/income-thresholds-and-rates-for-the-
 *                      private-health-insurance-rebate
 * Years the ATO no longer publishes (2020-21 to 2023-24 rebate percentages, the
 * pre-2024-25 SAPTO thresholds) come from that same page as it stood at the
 * time, via the Internet Archive. taxOffsets.audit.test.ts holds every one of
 * those tables transcribed row for row.
 *
 * THREE INCOME BASES, none of them taxable income:
 *   • LITO and LMITO run on TAXABLE INCOME.
 *   • SAPTO runs on REBATE INCOME    = taxable income + reportable super
 *     contributions + net investment loss + adjusted fringe benefits.
 *   • The surcharge and the rebate run on INCOME FOR SURCHARGE PURPOSES, which
 *     adds exempt foreign employment income on top of those, and is COMBINED
 *     with a spouse's when there is one.
 * All three are built from the same five figures utils/repaymentIncome.ts
 * already collects for the study loan — that is not a coincidence, it is the
 * ATO reusing one income test, so Ledger reuses one input. Income for surcharge
 * purposes and repayment income are in fact the SAME sum, and taxOffsets.test.ts
 * pins that so neither definition can drift without the other being noticed.
 *
 * WHAT IT DOES NOT MODEL, all in the direction of a SMALLER refund:
 *   • transferring a spouse's unused SAPTO (only ever increases the offset)
 *   • the seniors and pensioners Medicare levy thresholds, and the family
 *     Medicare levy thresholds (only ever reduce the levy)
 *   • the s.57A gross-down of exempt employers' fringe benefits in rebate
 *     income — the whole reported amount is counted, which can only raise the
 *     rebate income and shrink SAPTO
 *   • every other offset (beneficiary, invalid carer, zone, foreign income tax)
 * Each is stated by the engine rather than left for the user to discover.
 */

import type { RepaymentIncomeAdjustments } from './repaymentIncome';
import { taxSettingsFor, type RateConfidence } from './taxRates';
// The person's own answers live in taxProfile.ts, which knows no rates. The two
// enums below key this registry's tables, so they are defined there — that keeps
// the dependency running one way, from the rules to the facts they read.
import type { RebateAgeBand, SaptoStatus, TaxProfile } from './taxProfile';

export type { RebateAgeBand, SaptoStatus } from './taxProfile';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

/**
 * One step of a tapered offset, in the ATO's own terms: "$X plus/minus Nc for
 * each $1 over `from`". `from` is the EXCLUSIVE lower edge — the "above
 * $37,500" figure, not the "$37,501" figure — which is what keeps `base` and
 * `rate` consistent between adjacent steps. `rate` is signed: positive phases
 * the offset in, negative phases it out, zero is a flat step.
 */
export interface OffsetBand {
  from: number;
  /** Inclusive upper edge, or null for the last step. Display only. */
  to: number | null;
  base: number;
  rate: number;
}

export type LowIncomeOffsetKey = 'lito' | 'lmito';

export interface LowIncomeOffsetSettings {
  key: LowIncomeOffsetKey;
  label: string;
  /** Nil above this taxable income, whatever the last band would give. */
  cutOut: number;
  bands: OffsetBand[];
}

export interface SaptoRow {
  maxOffset: number;
  /** Full offset at or below this rebate income. */
  shadeOut: number;
  /** Nil at or above this rebate income. */
  cutOut: number;
}

export interface SaptoSettings {
  /** Cents of offset lost per dollar of rebate income above the shade-out. */
  taperRate: number;
  byStatus: Record<SaptoStatus, SaptoRow>;
}

export type SurchargeTierKey = 'base' | 'tier-1' | 'tier-2' | 'tier-3';

export interface SurchargeTier {
  key: SurchargeTierKey;
  label: string;
  /**
   * Exclusive lower edge of the SINGLE threshold. The family edge is exactly
   * double it — that is the ATO's own rule, published as its own row every
   * year, and the audit test checks this registry reproduces those rows.
   */
  singleFrom: number;
  /** Inclusive upper edge of the single threshold, null at the top. */
  singleTo: number | null;
  /** Surcharge rate on the surcharge base. Zero for the base tier. */
  rate: number;
}

export interface SurchargeSettings {
  tiers: SurchargeTier[];
  /** Added to the family threshold per dependent child after the first. */
  perChildIncrease: number;
}

/** Rebate percentages for one period, [base tier, tier 1, tier 2]. Tier 3 is nil. */
export interface RebateGrid {
  'under-65': [number, number, number];
  '65-69': [number, number, number];
  '70-plus': [number, number, number];
}

/**
 * The rebate percentage is re-set on 1 April, so every financial year has two
 * periods — and a private health statement reports the premiums for each of
 * them separately, under its own benefit code. Ledger asks for the same split.
 */
export interface RebatePeriod {
  key: 'first' | 'second';
  /** Human label, e.g. "1 July 2024 – 31 March 2025". */
  label: string;
  grid: RebateGrid;
  /** True when this period's percentage has not been published yet. */
  provisional?: true;
}

export interface FinancialYearOffsetSettings {
  fy: string;
  confidence: RateConfidence;
  /** Caveats worth showing the user. Empty for a settled year. */
  notes: string[];
  /** Every taper-by-taxable-income offset that ran this year, ATO order. */
  lowIncomeOffsets: LowIncomeOffsetSettings[];
  sapto: SaptoSettings;
  surcharge: SurchargeSettings;
  /** Always exactly two periods, in date order. */
  rebatePeriods: RebatePeriod[];
}

// ─── LITO and LMITO ──────────────────────────────────────────────────────────

/**
 * $700, tapering at 5c then 1.5c. Unchanged since 2020-21 and not indexed, so
 * every year in Ledger's range shares this object.
 */
const LITO: LowIncomeOffsetSettings = {
  key: 'lito',
  label: 'Low income tax offset',
  cutOut: 66667,
  bands: [
    { from: 0,     to: 37500, base: 700, rate: 0      },
    { from: 37500, to: 45000, base: 700, rate: -0.05  },
    { from: 45000, to: 66667, base: 325, rate: -0.015 },
  ],
};

/** LMITO as it ran for 2018-19 to 2020-21: $255 base, $1,080 full. */
const LMITO_255: LowIncomeOffsetSettings = {
  key: 'lmito',
  label: 'Low and middle income tax offset',
  cutOut: 126000,
  bands: [
    { from: 0,     to: 37000,  base: 255,  rate: 0     },
    { from: 37000, to: 48000,  base: 255,  rate: 0.075 },
    { from: 48000, to: 90000,  base: 1080, rate: 0     },
    { from: 90000, to: 126000, base: 1080, rate: -0.03 },
  ],
};

/**
 * 2021-22 only: the one-off $420 cost-of-living offset was bolted onto LMITO,
 * lifting the base to $675 and the full amount to $1,500 without touching the
 * 3c taper. That leaves a genuine CLIFF at the top — the formula still pays
 * $420 at exactly $126,000 and the offset is nil one dollar later. It is not a
 * transcription slip; $420 at the cut-out is the cost-of-living amount itself.
 */
const LMITO_675: LowIncomeOffsetSettings = {
  key: 'lmito',
  label: 'Low and middle income tax offset',
  cutOut: 126000,
  bands: [
    { from: 0,     to: 37000,  base: 675,  rate: 0     },
    { from: 37000, to: 48000,  base: 675,  rate: 0.075 },
    { from: 48000, to: 90000,  base: 1500, rate: 0     },
    { from: 90000, to: 126000, base: 1500, rate: -0.03 },
  ],
};

// ─── SAPTO ───────────────────────────────────────────────────────────────────

const sapto = (single: [number, number], couple: [number, number], illness: [number, number]): SaptoSettings => ({
  taperRate: 0.125,
  byStatus: {
    'single':             { maxOffset: 2230, shadeOut: single[0],  cutOut: single[1]  },
    'couple':             { maxOffset: 1602, shadeOut: couple[0],  cutOut: couple[1]  },
    'illness-separated':  { maxOffset: 2040, shadeOut: illness[0], cutOut: illness[1] },
  },
});

/**
 * The thresholds that ran unchanged from 2012-13 to 2023-24. The maximum offset
 * amounts have never moved; only the shade-out point does, because it tracks
 * where a senior's tax and levy actually start under the scale of the day.
 */
const SAPTO_TO_2023_24 = sapto([32279, 50119], [28974, 41790], [31279, 47599]);

/** Lifted for 2024-25 when the Stage 3 scale changed where tax starts. */
const SAPTO_FROM_2024_25 = sapto([34919, 52759], [30994, 43810], [33732, 50052]);

// ─── Medicare levy surcharge ─────────────────────────────────────────────────

const SURCHARGE_TIER_LABELS: Record<SurchargeTierKey, string> = {
  'base': 'Base tier',
  'tier-1': 'Tier 1',
  'tier-2': 'Tier 2',
  'tier-3': 'Tier 3',
};

/**
 * A year's surcharge scale from its three SINGLE threshold edges. The rates
 * themselves — nil, 1%, 1.25%, 1.5% — have never changed; only the edges are
 * indexed, and only from 2023-24 (they were frozen for the eight years before).
 */
function surchargeScale(base: number, tier1To: number, tier2To: number): SurchargeSettings {
  return {
    perChildIncrease: 1500,
    tiers: [
      { key: 'base',   label: SURCHARGE_TIER_LABELS['base'],   singleFrom: 0,        singleTo: base,     rate: 0      },
      { key: 'tier-1', label: SURCHARGE_TIER_LABELS['tier-1'], singleFrom: base,     singleTo: tier1To,  rate: 0.01   },
      { key: 'tier-2', label: SURCHARGE_TIER_LABELS['tier-2'], singleFrom: tier1To,  singleTo: tier2To,  rate: 0.0125 },
      { key: 'tier-3', label: SURCHARGE_TIER_LABELS['tier-3'], singleFrom: tier2To,  singleTo: null,     rate: 0.015  },
    ],
  };
}

// ─── Private health insurance rebate ─────────────────────────────────────────

const grid = (
  under65: [number, number, number],
  age6569: [number, number, number],
  age70: [number, number, number],
): RebateGrid => ({ 'under-65': under65, '65-69': age6569, '70-plus': age70 });

/** 1 July 2019 – 31 March 2021. */
const REBATE_25_059 = grid([25.059, 16.706, 8.352], [29.236, 20.883, 12.529], [33.413, 25.059, 16.706]);
/** 1 April 2021 – 31 March 2025 — four years with no adjustment factor at all. */
const REBATE_24_608 = grid([24.608, 16.405, 8.202], [28.710, 20.507, 12.303], [32.812, 24.608, 16.405]);
/** 1 April 2025 – 31 March 2026. */
const REBATE_24_288 = grid([24.288, 16.192, 8.095], [28.337, 20.240, 12.143], [32.385, 24.288, 16.192]);
/** From 1 April 2026. */
const REBATE_24_118 = grid([24.118, 16.079, 8.038], [28.139, 20.098, 12.058], [32.158, 24.118, 16.079]);

/** The two periods of one financial year, labelled the way a statement is. */
function rebateYear(startYear: number, first: RebateGrid, second: RebateGrid, provisional?: 'second' | 'both'): RebatePeriod[] {
  return [
    {
      key: 'first',
      label: `1 July ${startYear} – 31 March ${startYear + 1}`,
      grid: first,
      ...(provisional === 'both' ? { provisional: true as const } : {}),
    },
    {
      key: 'second',
      label: `1 April ${startYear + 1} – 30 June ${startYear + 1}`,
      grid: second,
      ...(provisional ? { provisional: true as const } : {}),
    },
  ];
}

// ─── Notes ───────────────────────────────────────────────────────────────────

const SURCHARGE_CARRIED_NOTE =
  'Medicare levy surcharge thresholds for this year are not published yet — the '
  + '2026–27 figures are used, so the surcharge may move once the ATO releases them.';

const SAPTO_CARRIED_NOTE =
  'Seniors and pensioners offset thresholds for this year are not published yet — the '
  + '2025–26 figures are used. They usually move when the tax scale does.';

const REBATE_APRIL_NOTE =
  'The private health rebate percentage is re-set every 1 April and this year’s April '
  + 'figure is not published yet — the current percentage is carried forward.';

const LMITO_FINAL_NOTE =
  'The low and middle income tax offset ended on 30 June 2022. It is included for this '
  + 'year because it applied then, and is gone from every year after.';

const LMITO_COST_OF_LIVING_NOTE =
  'The low and middle income tax offset carried a one-off $420 cost-of-living increase '
  + 'this year, so it is $1,500 rather than $1,080 at its full rate.';

// ─── The registry ────────────────────────────────────────────────────────────

export const OFFSET_SETTINGS_BY_FY: Record<string, FinancialYearOffsetSettings> = {
  '2020-2021': {
    fy: '2020-2021',
    confidence: 'legislated',
    notes: [],
    lowIncomeOffsets: [LITO, LMITO_255],
    sapto: SAPTO_TO_2023_24,
    surcharge: surchargeScale(90000, 105000, 140000),
    rebatePeriods: rebateYear(2020, REBATE_25_059, REBATE_24_608),
  },
  '2021-2022': {
    fy: '2021-2022',
    confidence: 'legislated',
    notes: [LMITO_COST_OF_LIVING_NOTE, LMITO_FINAL_NOTE],
    lowIncomeOffsets: [LITO, LMITO_675],
    sapto: SAPTO_TO_2023_24,
    surcharge: surchargeScale(90000, 105000, 140000),
    rebatePeriods: rebateYear(2021, REBATE_24_608, REBATE_24_608),
  },
  '2022-2023': {
    fy: '2022-2023',
    confidence: 'legislated',
    notes: [],
    lowIncomeOffsets: [LITO],
    sapto: SAPTO_TO_2023_24,
    surcharge: surchargeScale(90000, 105000, 140000),
    rebatePeriods: rebateYear(2022, REBATE_24_608, REBATE_24_608),
  },
  '2023-2024': {
    fy: '2023-2024',
    confidence: 'legislated',
    notes: [],
    lowIncomeOffsets: [LITO],
    sapto: SAPTO_TO_2023_24,
    surcharge: surchargeScale(93000, 108000, 144000),
    rebatePeriods: rebateYear(2023, REBATE_24_608, REBATE_24_608),
  },
  '2024-2025': {
    fy: '2024-2025',
    confidence: 'legislated',
    notes: [],
    lowIncomeOffsets: [LITO],
    sapto: SAPTO_FROM_2024_25,
    surcharge: surchargeScale(97000, 113000, 151000),
    rebatePeriods: rebateYear(2024, REBATE_24_608, REBATE_24_288),
  },
  '2025-2026': {
    fy: '2025-2026',
    confidence: 'legislated',
    notes: [],
    lowIncomeOffsets: [LITO],
    sapto: SAPTO_FROM_2024_25,
    surcharge: surchargeScale(101000, 118000, 158000),
    rebatePeriods: rebateYear(2025, REBATE_24_288, REBATE_24_118),
  },
  '2026-2027': {
    // Thresholds and the July rebate rate are the ATO's own; only next April's
    // rebate adjustment and the SAPTO shade-out are still to come.
    fy: '2026-2027',
    confidence: 'indexed-estimate',
    notes: [REBATE_APRIL_NOTE, SAPTO_CARRIED_NOTE],
    lowIncomeOffsets: [LITO],
    sapto: SAPTO_FROM_2024_25,
    surcharge: surchargeScale(105000, 123000, 164000),
    rebatePeriods: rebateYear(2026, REBATE_24_118, REBATE_24_118, 'second'),
  },
  '2027-2028': {
    fy: '2027-2028',
    confidence: 'indexed-estimate',
    notes: [SURCHARGE_CARRIED_NOTE, REBATE_APRIL_NOTE, SAPTO_CARRIED_NOTE],
    lowIncomeOffsets: [LITO],
    sapto: SAPTO_FROM_2024_25,
    surcharge: surchargeScale(105000, 123000, 164000),
    rebatePeriods: rebateYear(2027, REBATE_24_118, REBATE_24_118, 'both'),
  },
};

/** Every FY Ledger can apply offsets for, oldest first. */
export function supportedOffsetYears(): string[] {
  return Object.keys(OFFSET_SETTINGS_BY_FY).sort();
}

/** Offset settings for a year, or null when Ledger has none. Never falls back. */
export function offsetSettingsFor(fy: string | null | undefined): FinancialYearOffsetSettings | null {
  if (!fy) return null;
  return OFFSET_SETTINGS_BY_FY[fy.trim()] ?? null;
}

/**
 * Days in an Australian FY: 1 July of `startYear` to 30 June of the next. It
 * contains the following February, so the LATER year decides the leap.
 */
export function daysInFinancialYear(fy: string): number {
  const y = Number(String(fy).split('-')[0]) + 1;
  if (!Number.isFinite(y)) return 365;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return leap ? 366 : 365;
}

// ─── The three income bases ──────────────────────────────────────────────────

/**
 * Every base below is TAXABLE INCOME plus some of the five figures the user
 * already supplies for the study loan (utils/repaymentIncome.ts). That overlap
 * is the ATO's, not Ledger's: one set of income-test amounts feeds the loan, the
 * offsets and the surcharge, and the tests differ only in which of them count.
 * Assessable First Home Super Saver amounts come OUT of all three.
 */
function baseIncome(taxableIncome: number, a: RepaymentIncomeAdjustments | null | undefined): number {
  const ti = Math.max(0, taxableIncome);
  const fhss = Math.max(0, a?.assessableFHSSReleased ?? 0);
  return Math.max(0, ti - fhss);
}

/**
 * REBATE INCOME — what SAPTO is tested on. Taxable income plus reportable super
 * contributions, net investment loss and the adjusted fringe benefits total.
 *
 * Ledger holds ONE reportable-fringe-benefits figure and counts all of it. The
 * ATO would gross an exempt employer's amount DOWN by 0.53 first, so for anyone
 * packaging through a hospital or charity this rebate income is too high — which
 * shrinks SAPTO and can only understate a refund, never invent one.
 */
export function rebateIncomeFrom(
  taxableIncome: number,
  a?: RepaymentIncomeAdjustments | null,
): number {
  return round2(
    baseIncome(taxableIncome, a)
    + Math.max(0, a?.reportableFringeBenefits ?? 0)
    + Math.max(0, a?.totalNetInvestmentLoss ?? 0)
    + Math.max(0, a?.reportableSuperContributions ?? 0),
  );
}

/**
 * INCOME FOR SURCHARGE PURPOSES — what the Medicare levy surcharge and the
 * private health rebate tier are tested on. Rebate income plus exempt foreign
 * employment income, which the ATO adds only when taxable income is $1 or more.
 *
 * For every income above zero this equals REPAYMENT INCOME exactly, because the
 * ATO defines the two from the same list. taxOffsets.test.ts asserts that, so if
 * one definition ever moves the other cannot follow it silently.
 */
export function surchargeIncomeFrom(
  taxableIncome: number,
  a?: RepaymentIncomeAdjustments | null,
): number {
  const foreign = Math.max(0, taxableIncome) >= 1 ? Math.max(0, a?.exemptForeignEmploymentIncome ?? 0) : 0;
  return round2(rebateIncomeFrom(taxableIncome, a) + foreign);
}

// ─── Calculators (year-agnostic — they only read the shapes above) ───────────

/** One tapered offset, evaluated. Never negative, nil above the cut-out. */
export function lowIncomeOffsetFor(taxableIncome: number, offset: LowIncomeOffsetSettings): number {
  const income = Math.max(0, taxableIncome);
  if (income > offset.cutOut) return 0;
  let hit = offset.bands[0];
  for (const b of offset.bands) {
    if (income > b.from) hit = b;
  }
  return round2(Math.max(0, hit.base + (income - hit.from) * hit.rate));
}

/** Every taper-by-taxable-income offset the year ran, largest first. */
export function lowIncomeOffsetsFor(
  taxableIncome: number,
  settings: FinancialYearOffsetSettings,
): { key: LowIncomeOffsetKey; label: string; amount: number }[] {
  return settings.lowIncomeOffsets
    .map(o => ({ key: o.key, label: o.label, amount: lowIncomeOffsetFor(taxableIncome, o) }))
    .filter(o => o.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

export interface SaptoResult {
  status: SaptoStatus;
  row: SaptoRow;
  /** Your own rebate income — what the taper runs on. */
  rebateIncome: number;
  /**
   * The income the CUT-OUT is tested against: your own when single, half the
   * combined when one of a couple. The ATO tests entitlement on the couple and
   * then reduces each partner on their own income, which is why a low earner
   * still gets the full offset while their partner gets none.
   */
  testedIncome: number;
  amount: number;
  /** Set when the offset is nil, so the UI can say which test failed. */
  reason: 'not-eligible' | 'above-cut-out' | 'tapered-to-nil' | null;
}

/**
 * SAPTO for one person. `spouseRebateIncome` is only read for a couple.
 *
 * The ATO rounds the tapered amount UP to the nearest dollar — its own worked
 * example turns $1,719.875 into $1,720 — so this uses Math.ceil, not round().
 */
export function saptoFor(input: {
  eligible: boolean;
  status: SaptoStatus;
  rebateIncome: number;
  spouseRebateIncome?: number;
  settings: FinancialYearOffsetSettings;
}): SaptoResult {
  const { settings } = input;
  const status = input.status;
  const row = settings.sapto.byStatus[status];
  const rebateIncome = round2(Math.max(0, input.rebateIncome));
  const couple = status !== 'single';
  const testedIncome = couple
    ? round2((rebateIncome + Math.max(0, input.spouseRebateIncome ?? 0)) / 2)
    : rebateIncome;

  const nil = (reason: SaptoResult['reason']): SaptoResult =>
    ({ status, row, rebateIncome, testedIncome, amount: 0, reason });

  if (!input.eligible) return nil('not-eligible');
  if (testedIncome >= row.cutOut) return nil('above-cut-out');
  if (rebateIncome <= row.shadeOut) {
    return { status, row, rebateIncome, testedIncome, amount: row.maxOffset, reason: null };
  }
  const reduced = row.maxOffset - (rebateIncome - row.shadeOut) * settings.sapto.taperRate;
  if (reduced <= 0) return nil('tapered-to-nil');
  return { status, row, rebateIncome, testedIncome, amount: Math.ceil(reduced), reason: null };
}

export interface SurchargeThresholds {
  /** True when the family thresholds apply (a spouse or a dependent child). */
  family: boolean;
  /** The tier edges actually in force, after doubling and the per-child lift. */
  edges: { tier: SurchargeTier; from: number; to: number | null }[];
  /** The base-tier ceiling — the "you pay nothing at or below this" figure. */
  baseThreshold: number;
}

/**
 * The year's thresholds as they apply to this household. A family threshold is
 * exactly double the single one, lifted by $1,500 for each dependent child
 * AFTER the first.
 */
export function surchargeThresholdsFor(
  settings: FinancialYearOffsetSettings,
  opts: { family: boolean; dependentChildren: number },
): SurchargeThresholds {
  const lift = opts.family
    ? settings.surcharge.perChildIncrease * Math.max(0, opts.dependentChildren - 1)
    : 0;
  const scale = (n: number) => (opts.family ? n * 2 + lift : n);
  const edges = settings.surcharge.tiers.map(tier => ({
    tier,
    from: tier.singleFrom === 0 ? 0 : scale(tier.singleFrom),
    to: tier.singleTo == null ? null : scale(tier.singleTo),
  }));
  return { family: opts.family, edges, baseThreshold: edges[0].to ?? 0 };
}

export interface SurchargeAssessment {
  tier: SurchargeTierKey;
  tierLabel: string;
  rate: number;
  /** The income the tier was chosen on — combined when there is a spouse. */
  testedIncome: number;
  /** The base-tier ceiling for this household. */
  threshold: number;
  familyThresholds: boolean;
  /** What the rate is charged on: taxable income + reportable fringe benefits. */
  base: number;
  daysWithoutCover: number;
  daysInYear: number;
  amount: number;
  /**
   * What the surcharge WOULD be with no cover at all. Equal to `amount` when it
   * is charged; the point of it is the "answer this or it could cost you" note.
   */
  fullYearAmount: number;
  /** Why the amount is nil, when the tier alone does not explain it. */
  exemptReason: 'hospital-cover' | 'below-threshold' | 'low-own-income' | 'not-answered' | null;
}

/**
 * The Medicare levy surcharge.
 *
 * THREE DIFFERENT NUMBERS, and confusing any two of them is the classic error:
 *   • the TIER is chosen on income for surcharge purposes, COMBINED with a
 *     spouse's, against a threshold that doubles for a family;
 *   • the CHARGE is levied on taxable income plus reportable fringe benefits —
 *     not on the income that chose the tier;
 *   • the DAYS are only those without appropriate hospital cover.
 * The ATO's own worked example: $90,000 taxable plus $27,000 of fringe benefits
 * is $117,000 of surcharge income, which is Tier 1, and the 1% is charged on the
 * whole $117,000.
 */
export function medicareLevySurchargeFor(input: {
  fy: string;
  settings: FinancialYearOffsetSettings;
  taxableIncome: number;
  reportableFringeBenefits: number;
  surchargeIncome: number;
  spouseSurchargeIncome: number;
  profile: TaxProfile;
}): SurchargeAssessment {
  const { settings, profile } = input;
  const family = profile.hasSpouse || profile.dependentChildren > 0;
  const thresholds = surchargeThresholdsFor(settings, {
    family,
    dependentChildren: profile.dependentChildren,
  });
  const testedIncome = round2(
    input.surchargeIncome + (family ? Math.max(0, input.spouseSurchargeIncome) : 0),
  );

  let hit = thresholds.edges[0];
  for (const e of thresholds.edges) {
    if (testedIncome > e.from) hit = e;
  }

  const daysInYear = daysInFinancialYear(input.fy);
  const covered = profile.hospitalCover === 'full-year'
    ? daysInYear
    : profile.hospitalCover === 'part-year'
      ? Math.min(Math.max(0, profile.hospitalCoverDays), daysInYear)
      : 0;
  const daysWithoutCover = profile.hospitalCover === 'unknown' ? daysInYear : daysInYear - covered;

  const base = round2(Math.max(0, input.taxableIncome) + Math.max(0, input.reportableFringeBenefits));
  const fullYearAmount = round2(base * hit.tier.rate);

  // A member of a family whose OWN income is at or below the year's Medicare
  // levy low-income threshold pays no surcharge, however high the family income.
  const ownIncomeExempt =
    family && input.surchargeIncome <= (taxSettingsFor(input.fy)?.medicare.lowerThreshold ?? 0);

  const exemptReason: SurchargeAssessment['exemptReason'] =
    hit.tier.rate === 0 ? 'below-threshold'
      : profile.hospitalCover === 'unknown' ? 'not-answered'
        : ownIncomeExempt ? 'low-own-income'
          : daysWithoutCover === 0 ? 'hospital-cover'
            : null;

  return {
    tier: hit.tier.key,
    tierLabel: hit.tier.label,
    rate: hit.tier.rate,
    testedIncome,
    threshold: thresholds.baseThreshold,
    familyThresholds: family,
    base,
    daysWithoutCover: exemptReason === 'not-answered' ? 0 : daysWithoutCover,
    daysInYear,
    amount: exemptReason ? 0 : round2((base * hit.tier.rate * daysWithoutCover) / daysInYear),
    fullYearAmount,
    exemptReason,
  };
}

export interface RebatePeriodResult {
  key: 'first' | 'second';
  label: string;
  premiums: number;
  /** The rebate percentage that applied in this period, e.g. 24.608. */
  percentage: number;
  entitled: number;
  provisional: boolean;
}

export interface HealthRebateAssessment {
  tier: SurchargeTierKey;
  tierLabel: string;
  ageBand: RebateAgeBand;
  periods: RebatePeriodResult[];
  premiums: number;
  entitled: number;
  received: number;
  /**
   * received − entitled. POSITIVE means the insurer gave a bigger rebate than
   * this year's income turned out to justify, and the excess is added to the
   * bill. NEGATIVE means too little was taken off the premiums, and the
   * shortfall comes back as a refundable offset.
   */
  adjustment: number;
}

const TIER_ORDER: SurchargeTierKey[] = ['base', 'tier-1', 'tier-2', 'tier-3'];

/**
 * Reconcile the private health rebate: what the year's income actually entitled
 * the taxpayer to, against what the insurer already took off the premiums.
 *
 * The percentage is re-set every 1 April, so the entitlement is worked out
 * separately for each half of the statement — which is exactly why the statement
 * reports two premium figures rather than one.
 */
export function privateHealthRebateFor(input: {
  settings: FinancialYearOffsetSettings;
  tier: SurchargeTierKey;
  profile: TaxProfile;
}): HealthRebateAssessment {
  const { settings, profile } = input;
  const tierIndex = TIER_ORDER.indexOf(input.tier);
  const premiumsFor = (key: 'first' | 'second') =>
    key === 'first' ? profile.premiumsFirstPeriod : profile.premiumsSecondPeriod;

  const periods: RebatePeriodResult[] = settings.rebatePeriods.map(p => {
    // Tier 3 has no rebate at all, and is not a column in the ATO's table.
    const percentage = tierIndex >= 0 && tierIndex < 3 ? p.grid[profile.healthAgeBand][tierIndex] : 0;
    const premiums = Math.max(0, premiumsFor(p.key));
    return {
      key: p.key,
      label: p.label,
      premiums: round2(premiums),
      percentage,
      entitled: round2((premiums * percentage) / 100),
      provisional: p.provisional === true,
    };
  });

  const entitled = round2(periods.reduce((s, p) => s + p.entitled, 0));
  const received = round2(Math.max(0, profile.rebateReceived));
  return {
    tier: input.tier,
    tierLabel: settings.surcharge.tiers.find(t => t.key === input.tier)?.label ?? input.tier,
    ageBand: profile.healthAgeBand,
    periods,
    premiums: round2(periods.reduce((s, p) => s + p.premiums, 0)),
    entitled,
    received,
    adjustment: round2(received - entitled),
  };
}

// ─── The whole position for one year ─────────────────────────────────────────

export type OffsetWarningKind =
  | 'no-offset-rates'
  | 'provisional-offset-rates'
  | 'hospital-cover-unknown'
  | 'surcharge-applies'
  | 'surcharge-part-year'
  | 'offsets-capped'
  | 'excess-health-rebate'
  | 'health-rebate-shortfall'
  | 'health-rebate-no-premiums'
  | 'sapto-above-cut-out'
  | 'sapto-couple-without-spouse'
  | 'spouse-income-missing'
  | 'offsets-not-modelled';

export interface OffsetWarning {
  kind: OffsetWarningKind;
  severity: 'warn' | 'info';
  /** Plain text, free of dollar figures — the UI formats `amount`. */
  message: string;
  amount?: number;
  count?: number;
}

/** One offset or adjustment, as the settlement will show it. */
export interface OffsetLine {
  key: string;
  label: string;
  /** Always positive; which side it falls on is the list it is in. */
  amount: number;
  detail: string;
}

export interface OffsetPosition {
  fy: string;
  ratesAvailable: boolean;
  confidence: RateConfidence | null;
  notes: string[];

  /** The three bases, exposed so the UI can show what each test was run on. */
  taxableIncome: number;
  rebateIncome: number;
  surchargeIncome: number;
  /** Yours plus a spouse's, or just yours when there is none. */
  familySurchargeIncome: number;

  /** Non-refundable offsets at full entitlement, before any cap. */
  entitlements: OffsetLine[];
  entitlementsTotal: number;
  /** What survives the cap at this year's income tax — what actually applies. */
  applied: OffsetLine[];
  appliedTotal: number;
  /** Entitlement with nowhere to go. Non-refundable relief is simply lost. */
  unusedOffsets: number;

  /** Extra tax: the surcharge, and any private health rebate over-claimed. */
  extraLiability: OffsetLine[];
  extraLiabilityTotal: number;
  /** Refundable: a private health rebate that was under-claimed. */
  refundableCredits: OffsetLine[];
  refundableCreditsTotal: number;

  sapto: SaptoResult | null;
  surcharge: SurchargeAssessment | null;
  health: HealthRebateAssessment | null;
  warnings: OffsetWarning[];
}

const NOT_MODELLED_NOTE =
  'Transferring a spouse’s unused seniors offset, the seniors and family Medicare levy '
  + 'thresholds, and offsets like the beneficiary and zone offsets are not included. Every '
  + 'one of them reduces tax, so the real outcome is this or better.';

/**
 * Build the offsets, the surcharge and the health reconciliation for one year.
 *
 * `incomeTax` is the year's basic income tax, and it is the ONLY thing the
 * non-refundable offsets can be set against: they cannot touch the Medicare
 * levy, the surcharge or a study loan repayment, and any excess is lost rather
 * than refunded. Pass null (with no rates) and nothing is capped because nothing
 * is claimed.
 */
export function buildOffsetPosition(input: {
  fy: string;
  taxableIncome: number;
  incomeTax: number | null;
  adjustments?: RepaymentIncomeAdjustments | null;
  profile?: TaxProfile | null;
}): OffsetPosition {
  const settings = offsetSettingsFor(input.fy);
  const profile = input.profile ?? null;
  const adjustments = input.adjustments ?? null;
  const taxableIncome = round2(Math.max(0, input.taxableIncome));
  const rebateIncome = rebateIncomeFrom(taxableIncome, adjustments);
  const surchargeIncome = surchargeIncomeFrom(taxableIncome, adjustments);
  const spouseIncome = profile?.hasSpouse ? Math.max(0, profile.spouseSurchargeIncome) : 0;
  const warnings: OffsetWarning[] = [];

  const empty = (): OffsetPosition => ({
    fy: input.fy,
    ratesAvailable: false,
    confidence: null,
    notes: [],
    taxableIncome,
    rebateIncome,
    surchargeIncome,
    familySurchargeIncome: round2(surchargeIncome + spouseIncome),
    entitlements: [],
    entitlementsTotal: 0,
    applied: [],
    appliedTotal: 0,
    unusedOffsets: 0,
    extraLiability: [],
    extraLiabilityTotal: 0,
    refundableCredits: [],
    refundableCreditsTotal: 0,
    sapto: null,
    surcharge: null,
    health: null,
    warnings: [{
      kind: 'no-offset-rates',
      severity: 'info',
      message:
        'Ledger holds no offset or surcharge rules for this year, so no offsets, Medicare levy '
        + 'surcharge or private health rebate are included.',
    }],
  });

  if (!settings || !profile) return empty();

  // ── Non-refundable offsets ────────────────────────────────────────────────
  const entitlements: OffsetLine[] = lowIncomeOffsetsFor(taxableIncome, settings).map(o => ({
    key: o.key,
    label: o.label,
    amount: o.amount,
    detail: `On ${money(taxableIncome)} taxable income`,
  }));

  const sapto = saptoFor({
    eligible: profile.saptoEligible,
    status: profile.saptoStatus,
    rebateIncome,
    spouseRebateIncome: spouseIncome,
    settings,
  });
  if (sapto.amount > 0) {
    entitlements.push({
      key: 'sapto',
      label: 'Seniors and pensioners tax offset',
      amount: sapto.amount,
      detail: `On ${money(rebateIncome)} rebate income, not taxable income`,
    });
  }

  // Largest first, so the offset doing most of the work reads first and is the
  // one the cap fills. The ORDER only decides which line is shown as unused; the
  // total applied, and therefore the outcome, is the same whatever order it is.
  entitlements.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));

  const entitlementsTotal = round2(entitlements.reduce((s, o) => s + o.amount, 0));
  // Offsets can only be set against income tax — never the levy, the surcharge
  // or a loan repayment — and anything left over is lost, not refunded.
  const cap = Math.max(0, input.incomeTax ?? 0);
  const applied: OffsetLine[] = [];
  let remaining = cap;
  for (const o of entitlements) {
    if (remaining <= 0) break;
    const used = Math.min(o.amount, remaining);
    applied.push({ ...o, amount: round2(used) });
    remaining = round2(remaining - used);
  }
  const appliedTotal = round2(applied.reduce((s, o) => s + o.amount, 0));
  const unusedOffsets = round2(entitlementsTotal - appliedTotal);

  // ── Surcharge and the private health reconciliation ───────────────────────
  const surcharge = medicareLevySurchargeFor({
    fy: input.fy,
    settings,
    taxableIncome,
    reportableFringeBenefits: Math.max(0, adjustments?.reportableFringeBenefits ?? 0),
    surchargeIncome,
    spouseSurchargeIncome: spouseIncome,
    profile,
  });

  const holdsPolicy =
    profile.premiumsFirstPeriod > 0 || profile.premiumsSecondPeriod > 0 || profile.rebateReceived > 0;
  const health = holdsPolicy
    ? privateHealthRebateFor({ settings, tier: surcharge.tier, profile })
    : null;

  const extraLiability: OffsetLine[] = [];
  if (surcharge.amount > 0) {
    const partYear = surcharge.daysWithoutCover < surcharge.daysInYear;
    extraLiability.push({
      key: 'medicare-levy-surcharge',
      label: 'Medicare levy surcharge',
      amount: surcharge.amount,
      detail:
        `${surcharge.tierLabel} · ${(surcharge.rate * 100).toFixed(2).replace(/\.?0+$/, '')}% of `
        + `${money(surcharge.base)}`
        + (partYear ? ` for ${surcharge.daysWithoutCover} days without hospital cover` : ''),
    });
  }
  if (health && health.adjustment > 0) {
    extraLiability.push({
      key: 'excess-health-rebate',
      label: 'Private health rebate to repay',
      amount: health.adjustment,
      detail: `Your insurer allowed ${money(health.received)}; this year's income entitles you to ${money(health.entitled)}`,
    });
  }

  const refundableCredits: OffsetLine[] = [];
  if (health && health.adjustment < 0) {
    refundableCredits.push({
      key: 'health-rebate-shortfall',
      label: 'Private health rebate to claim',
      amount: round2(-health.adjustment),
      detail: `Entitled to ${money(health.entitled)}, your insurer allowed ${money(health.received)}`,
    });
  }

  // ── Warnings, most consequential first ────────────────────────────────────
  if (settings.confidence === 'indexed-estimate') {
    warnings.push({
      kind: 'provisional-offset-rates',
      severity: 'info',
      message:
        'Some of this year’s offset and surcharge figures are carried forward from last year, '
        + 'so they can move once the ATO publishes them.',
    });
  }

  if (surcharge.exemptReason === 'not-answered' && surcharge.fullYearAmount > 0) {
    warnings.push({
      kind: 'hospital-cover-unknown',
      severity: 'warn',
      amount: surcharge.fullYearAmount,
      message:
        `Your income is in ${surcharge.tierLabel} for the Medicare levy surcharge. `
        + 'Tell Ledger whether you held private hospital cover — until then no surcharge is included, '
        + 'and a full year without cover would add',
    });
  } else if (surcharge.amount > 0) {
    warnings.push({
      kind: surcharge.daysWithoutCover < surcharge.daysInYear ? 'surcharge-part-year' : 'surcharge-applies',
      severity: 'warn',
      amount: surcharge.amount,
      count: surcharge.daysWithoutCover,
      message:
        surcharge.daysWithoutCover < surcharge.daysInYear
          ? `You were without hospital cover for ${surcharge.daysWithoutCover} of ${surcharge.daysInYear} days, `
            + 'so the surcharge is charged for those days:'
          : 'No hospital cover and income above the surcharge threshold, so the surcharge applies:',
    });
  }

  if (unusedOffsets > 0) {
    warnings.push({
      kind: 'offsets-capped',
      severity: 'info',
      amount: unusedOffsets,
      message:
        'Your offsets are worth more than the income tax they can be set against. Offsets cannot '
        + 'reduce the Medicare levy or a loan repayment and are not refundable, so this much is unused:',
    });
  }

  if (health && health.adjustment > 0) {
    warnings.push({
      kind: 'excess-health-rebate',
      severity: 'warn',
      amount: health.adjustment,
      message:
        'Your insurer gave you a bigger private health rebate than this year’s income entitles you to. '
        + 'The difference is added to your bill:',
    });
  } else if (health && health.adjustment < 0) {
    warnings.push({
      kind: 'health-rebate-shortfall',
      severity: 'info',
      amount: round2(-health.adjustment),
      message: 'You claimed less private health rebate than you were entitled to, so the rest comes back:',
    });
  }
  if (!health && profile.rebateReceived === 0
      && (profile.hospitalCover === 'full-year' || profile.hospitalCover === 'part-year')) {
    warnings.push({
      kind: 'health-rebate-no-premiums',
      severity: 'info',
      message:
        'Add the premiums and rebate from your private health statement and Ledger will check the '
        + 'rebate you received against the one your income entitles you to.',
    });
  }

  if (profile.saptoEligible && sapto.amount === 0 && sapto.reason !== 'not-eligible') {
    warnings.push({
      kind: 'sapto-above-cut-out',
      severity: 'info',
      message:
        sapto.reason === 'above-cut-out'
          ? 'Your rebate income is above the seniors and pensioners cut-out, so no offset applies.'
          : 'The seniors and pensioners offset tapers to nothing at your rebate income.',
    });
  }
  if (profile.saptoEligible && profile.saptoStatus !== 'single' && !profile.hasSpouse) {
    warnings.push({
      kind: 'sapto-couple-without-spouse',
      severity: 'warn',
      message:
        'You chose a couple’s seniors offset but have not recorded a spouse, so the couple test is '
        + 'running on your income alone. Add your spouse above.',
    });
  }
  if (profile.hasSpouse && spouseIncome === 0) {
    warnings.push({
      kind: 'spouse-income-missing',
      severity: 'warn',
      message:
        'No income recorded for your spouse. The surcharge and rebate are family income tests, so a '
        + 'missing spouse income can put you in the wrong tier.',
    });
  }

  warnings.push({ kind: 'offsets-not-modelled', severity: 'info', message: NOT_MODELLED_NOTE });

  return {
    fy: settings.fy,
    ratesAvailable: true,
    confidence: settings.confidence,
    notes: settings.notes,
    taxableIncome,
    rebateIncome,
    surchargeIncome,
    familySurchargeIncome: round2(surchargeIncome + spouseIncome),
    entitlements,
    entitlementsTotal,
    applied,
    appliedTotal,
    unusedOffsets,
    extraLiability,
    extraLiabilityTotal: round2(extraLiability.reduce((s, o) => s + o.amount, 0)),
    refundableCredits,
    refundableCreditsTotal: round2(refundableCredits.reduce((s, o) => s + o.amount, 0)),
    sapto,
    surcharge,
    health,
    warnings,
  };
}

/**
 * Plain dollars for the `detail` strings above. The UI formats every AMOUNT
 * itself, in the user's own currency; these are explanations of a calculation
 * that is defined in Australian dollars whatever the display currency is.
 */
function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-AU')}`;
}
