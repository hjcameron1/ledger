/**
 * Australian tax rates and thresholds, by financial year.
 *
 * This file is DATA plus the small pure functions that read it. Adding a new
 * financial year — or correcting an old one — means editing `TAX_SETTINGS_BY_FY`
 * and nothing else: the calculators below are written against the shape, never
 * against a particular year. That is the whole point of the module. If you find
 * yourself adding an `if (fy === …)` anywhere in this file, the shape is wrong.
 *
 * Two rules the rest of Ledger relies on:
 *
 *  1. A year Ledger has no rates for returns `null` from `taxSettingsFor`. It
 *     must never fall back to a neighbouring year — a 2019-20 position quietly
 *     assessed on 2024-25 scales is worse than no estimate at all, because it
 *     looks like an answer.
 *  2. Every year declares its `confidence`. Thresholds that are indexed each
 *     year (Medicare low-income, student-loan repayment) are only published
 *     part-way through the year they apply to, so a future year carries the
 *     last published figure and says so. The UI surfaces that.
 *
 * VERIFIED against the ATO's own tables on 19 August 2026:
 *   • Resident rates      ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents
 *   • Medicare low income ato.gov.au/individuals-and-families/medicare-and-private-health-
 *                         insurance/medicare-levy/medicare-levy-reduction/
 *                         medicare-levy-reduction-for-low-income-earners
 *   • Study/training loan ato.gov.au/tax-rates-and-codes/study-and-training-support-loans-
 *                         rates-and-repayment-thresholds
 * taxRates.audit.test.ts holds those tables transcribed row for row and asserts
 * this registry reproduces them, so re-auditing a year is a diff, not a re-read.
 *
 * TWO INCOME BASES, never interchangeable. Income tax and the Medicare levy are
 * assessed on TAXABLE INCOME; a study and training loan repayment is assessed on
 * REPAYMENT INCOME, which is taxable income plus reportable fringe benefits, net
 * investment losses, reportable super contributions and exempt foreign employment
 * income (see utils/repaymentIncome.ts). They are passed separately everywhere in
 * this file — `estimateTaxForFY` takes the second as its own argument rather than
 * deriving it, because Ledger cannot derive it.
 *
 * Scope: resident individual rates, and only what is assessed on income alone.
 * Anything that needs a fact about the PERSON — offsets, the Medicare levy
 * surcharge, the private health rebate — lives in utils/taxOffsets.ts, which
 * keeps its own per-FY registry under the same two rules and is audited the same
 * way. Both registries must cover the same years; taxOffsets.audit.test.ts
 * asserts it.
 *
 * Still not modelled anywhere: non-resident and working-holiday-maker scales,
 * and the seniors/pensioners and family Medicare LEVY thresholds (as opposed to
 * the surcharge), which would lower the levy for the households that qualify.
 */

export type RateConfidence = 'legislated' | 'indexed-estimate';

/**
 * One step of the resident income-tax scale, in the ATO's own terms:
 * "$X plus Nc for each $1 over `from`". `from` is therefore the *exclusive*
 * lower edge — the "over $45,000" figure, not the "$45,001" figure — which is
 * what keeps `base` and `rate` consistent between adjacent brackets.
 */
export interface IncomeTaxBracket {
  /** Income above this attracts `rate`. Exclusive lower edge. */
  from: number;
  /** Inclusive upper edge, or null for the top bracket. Display only. */
  to: number | null;
  /** Tax payable on income of exactly `from`. */
  base: number;
  /** Marginal rate on each dollar above `from`. */
  rate: number;
}

/**
 * Medicare levy for a single with no dependants. Below `lowerThreshold` there
 * is no levy; between the thresholds it shades in at `shadeInRate` of the
 * excess; above `upperThreshold` the full `rate` applies to the whole income.
 */
export interface MedicareLevySettings {
  rate: number;
  lowerThreshold: number;
  upperThreshold: number;
  shadeInRate: number;
}

/** A band of the pre-2025-26 schedule: a flat % of the WHOLE repayment income. */
export interface StudentLoanBand {
  /** Inclusive lower edge of the band. */
  from: number;
  /** Inclusive upper edge, or null for the top band. */
  to: number | null;
  rate: number;
}

/** A tier of the 2025-26-onwards schedule: a % of income ABOVE the tier edge. */
export interface StudentLoanTier {
  /** Exclusive lower edge — income above this attracts `rate`. */
  from: number;
  to: number | null;
  /** Repayment owed at exactly `from`. Ignored when `wholeIncome` is set. */
  base: number;
  rate: number;
  /**
   * The ATO's top row — "10% of your total repayment income" — is a flat rate on
   * the WHOLE income, not on the excess, so the marginal schedule reverts to the
   * old whole-income form at the very top. It is continuous with the tier below
   * it (both give the same figure at the edge), so this is a change of formula,
   * not a cliff. Marked in the data rather than special-cased in the calculator.
   */
  wholeIncome?: boolean;
}

/**
 * HELP/HECS repayments changed model, not just numbers, on 1 July 2025: the
 * old schedule charged a flat percentage of your entire repayment income once
 * you crossed a threshold (so one dollar of extra income could cost hundreds),
 * the new one charges marginally on the income above it. Both are kept because
 * both are correct — for their own years.
 */
export type StudentLoanSettings =
  | { model: 'income-bands'; minThreshold: number; bands: StudentLoanBand[] }
  | { model: 'marginal'; minThreshold: number; tiers: StudentLoanTier[] };

export interface FinancialYearTaxSettings {
  /** 'YYYY-YYYY', matching the rest of Ledger. */
  fy: string;
  confidence: RateConfidence;
  /** Caveats worth showing the user. Empty for a settled year. */
  notes: string[];
  brackets: IncomeTaxBracket[];
  medicare: MedicareLevySettings;
  studentLoan: StudentLoanSettings;
}

// ─── Income tax scales ───────────────────────────────────────────────────────

/** The scale that ran unchanged from 2020-21 to 2023-24. */
const SCALE_PRE_STAGE_3: IncomeTaxBracket[] = [
  { from: 0,      to: 18200,  base: 0,     rate: 0     },
  { from: 18200,  to: 45000,  base: 0,     rate: 0.19  },
  { from: 45000,  to: 120000, base: 5092,  rate: 0.325 },
  { from: 120000, to: 180000, base: 29467, rate: 0.37  },
  { from: 180000, to: null,   base: 51667, rate: 0.45  },
];

/** Stage 3 as legislated in 2024: 16% bottom rate, wider 30% band. */
const SCALE_STAGE_3: IncomeTaxBracket[] = [
  { from: 0,      to: 18200,  base: 0,     rate: 0    },
  { from: 18200,  to: 45000,  base: 0,     rate: 0.16 },
  { from: 45000,  to: 135000, base: 4288,  rate: 0.30 },
  { from: 135000, to: 190000, base: 31288, rate: 0.37 },
  { from: 190000, to: null,   base: 51638, rate: 0.45 },
];

/** Bottom rate cut to 15% from 1 July 2026. Thresholds unchanged. */
const SCALE_BOTTOM_RATE_15: IncomeTaxBracket[] = [
  { from: 0,      to: 18200,  base: 0,     rate: 0    },
  { from: 18200,  to: 45000,  base: 0,     rate: 0.15 },
  { from: 45000,  to: 135000, base: 4020,  rate: 0.30 },
  { from: 135000, to: 190000, base: 31020, rate: 0.37 },
  { from: 190000, to: null,   base: 51370, rate: 0.45 },
];

/** Bottom rate cut again to 14% from 1 July 2027. */
const SCALE_BOTTOM_RATE_14: IncomeTaxBracket[] = [
  { from: 0,      to: 18200,  base: 0,     rate: 0    },
  { from: 18200,  to: 45000,  base: 0,     rate: 0.14 },
  { from: 45000,  to: 135000, base: 3752,  rate: 0.30 },
  { from: 135000, to: 190000, base: 30752, rate: 0.37 },
  { from: 190000, to: null,   base: 51102, rate: 0.45 },
];

// ─── Medicare levy ───────────────────────────────────────────────────────────

const medicare = (lower: number, upper: number): MedicareLevySettings =>
  ({ rate: 0.02, lowerThreshold: lower, upperThreshold: upper, shadeInRate: 0.10 });

// ─── Student loan (HELP/HECS) ────────────────────────────────────────────────

/**
 * The 1%–10% schedule. Written as [lower edge, rate] pairs and expanded, so a
 * year's table is one readable column instead of eighteen brace-heavy objects.
 */
function bands(pairs: [number, number][]): StudentLoanSettings {
  return {
    model: 'income-bands',
    minThreshold: pairs[0][0],
    bands: pairs.map(([from, rate], i) => ({
      from,
      to: i + 1 < pairs.length ? pairs[i + 1][0] - 1 : null,
      rate,
    })),
  };
}

const HELP_2020_21 = bands([
  [46620, 0.01], [53827, 0.02], [57056, 0.025], [60480, 0.03], [64109, 0.035],
  [67955, 0.04], [72032, 0.045], [76355, 0.05], [80936, 0.055], [85793, 0.06],
  [90940, 0.065], [96397, 0.07], [102180, 0.075], [108310, 0.08], [114810, 0.085],
  [121699, 0.09], [129000, 0.095], [136740, 0.10],
]);

const HELP_2021_22 = bands([
  [47014, 0.01], [54283, 0.02], [57539, 0.025], [60992, 0.03], [64652, 0.035],
  [68530, 0.04], [72642, 0.045], [77002, 0.05], [81621, 0.055], [86519, 0.06],
  [91710, 0.065], [97213, 0.07], [103046, 0.075], [109228, 0.08], [115782, 0.085],
  [122729, 0.09], [130093, 0.095], [137898, 0.10],
]);

const HELP_2022_23 = bands([
  [48361, 0.01], [55837, 0.02], [59187, 0.025], [62739, 0.03], [66503, 0.035],
  [70493, 0.04], [74723, 0.045], [79207, 0.05], [83959, 0.055], [88997, 0.06],
  [94337, 0.065], [99997, 0.07], [105997, 0.075], [112356, 0.08], [119098, 0.085],
  [126244, 0.09], [133819, 0.095], [141848, 0.10],
]);

const HELP_2023_24 = bands([
  [51550, 0.01], [59519, 0.02], [63090, 0.025], [66876, 0.03], [70889, 0.035],
  [75141, 0.04], [79650, 0.045], [84430, 0.05], [89495, 0.055], [94866, 0.06],
  [100558, 0.065], [106591, 0.07], [112986, 0.075], [119765, 0.08], [126951, 0.085],
  [134569, 0.09], [142643, 0.095], [151201, 0.10],
]);

const HELP_2024_25 = bands([
  [54435, 0.01], [62851, 0.02], [66621, 0.025], [70619, 0.03], [74856, 0.035],
  [79347, 0.04], [84108, 0.045], [89155, 0.05], [94504, 0.055], [100175, 0.06],
  [106186, 0.065], [112557, 0.07], [119310, 0.075], [126468, 0.08], [134057, 0.085],
  [142101, 0.09], [150627, 0.095], [159664, 0.10],
]);

/** The marginal system that replaced the bands on 1 July 2025. */
const HELP_MARGINAL_2025_26: StudentLoanSettings = {
  model: 'marginal',
  minThreshold: 67000,
  tiers: [
    { from: 67000,  to: 125000, base: 0,    rate: 0.15 },
    { from: 125000, to: 179285, base: 8700, rate: 0.17 },
    { from: 179285, to: null,   base: 0,    rate: 0.10, wholeIncome: true },
  ],
};

/** Same shape, this year's published (indexed) thresholds. */
const HELP_MARGINAL_2026_27: StudentLoanSettings = {
  model: 'marginal',
  minThreshold: 69528,
  tiers: [
    { from: 69528,  to: 129717, base: 0,    rate: 0.15 },
    { from: 129717, to: 186050, base: 9028, rate: 0.17 },
    { from: 186050, to: null,   base: 0,    rate: 0.10, wholeIncome: true },
  ],
};

// ─── The registry ────────────────────────────────────────────────────────────

// Indexed thresholds are published part-way through the year they apply to, so a
// future year has to borrow the last published figures. Say WHICH ones, rather
// than vaguely flagging the whole estimate: in 2026-27 the brackets and the loan
// schedule are the ATO's own, and only the levy thresholds are carried forward.
const MEDICARE_CARRIED_NOTE =
  'Medicare levy low-income thresholds for this year are not published yet — the '
  + '2025–26 figures are used, so the levy may move once the ATO releases them.';

const HELP_CARRIED_NOTE =
  'Study and training loan thresholds for this year are not published yet — the '
  + '2026–27 figures are used, so a repayment may move once the ATO releases them.';

const BRACKETS_LEGISLATED_NOTE =
  'These rates are legislated but the ATO has not published this year\'s table yet.';

const HELP_MODEL_CHANGE_NOTE =
  'HELP repayments moved to a marginal rate above $67,000 this year — only the '
  + 'income above the threshold is counted, not the whole amount.';

export const TAX_SETTINGS_BY_FY: Record<string, FinancialYearTaxSettings> = {
  '2020-2021': {
    fy: '2020-2021',
    confidence: 'legislated',
    notes: [],
    brackets: SCALE_PRE_STAGE_3,
    medicare: medicare(23226, 29032),
    studentLoan: HELP_2020_21,
  },
  '2021-2022': {
    fy: '2021-2022',
    confidence: 'legislated',
    notes: [],
    brackets: SCALE_PRE_STAGE_3,
    medicare: medicare(23365, 29206),
    studentLoan: HELP_2021_22,
  },
  '2022-2023': {
    fy: '2022-2023',
    confidence: 'legislated',
    notes: [],
    brackets: SCALE_PRE_STAGE_3,
    medicare: medicare(24276, 30345),
    studentLoan: HELP_2022_23,
  },
  '2023-2024': {
    fy: '2023-2024',
    confidence: 'legislated',
    notes: [],
    brackets: SCALE_PRE_STAGE_3,
    medicare: medicare(26000, 32500),
    studentLoan: HELP_2023_24,
  },
  '2024-2025': {
    fy: '2024-2025',
    confidence: 'legislated',
    notes: [],
    brackets: SCALE_STAGE_3,
    medicare: medicare(27222, 34027),
    studentLoan: HELP_2024_25,
  },
  '2025-2026': {
    fy: '2025-2026',
    confidence: 'legislated',
    notes: [HELP_MODEL_CHANGE_NOTE],
    brackets: SCALE_STAGE_3,
    medicare: medicare(28011, 35013),
    studentLoan: HELP_MARGINAL_2025_26,
  },
  '2026-2027': {
    // Brackets and the loan schedule are published; only the levy is carried.
    fy: '2026-2027',
    confidence: 'indexed-estimate',
    notes: [MEDICARE_CARRIED_NOTE],
    brackets: SCALE_BOTTOM_RATE_15,
    medicare: medicare(28011, 35013),
    studentLoan: HELP_MARGINAL_2026_27,
  },
  '2027-2028': {
    fy: '2027-2028',
    confidence: 'indexed-estimate',
    notes: [BRACKETS_LEGISLATED_NOTE, MEDICARE_CARRIED_NOTE, HELP_CARRIED_NOTE],
    brackets: SCALE_BOTTOM_RATE_14,
    medicare: medicare(28011, 35013),
    studentLoan: HELP_MARGINAL_2026_27,
  },
};

/** Every FY Ledger can produce an estimate for, oldest first. */
export function supportedTaxYears(): string[] {
  return Object.keys(TAX_SETTINGS_BY_FY).sort();
}

/** Rates for a financial year, or null when Ledger has none. Never falls back. */
export function taxSettingsFor(fy: string | null | undefined): FinancialYearTaxSettings | null {
  if (!fy) return null;
  return TAX_SETTINGS_BY_FY[fy.trim()] ?? null;
}

export function isTaxYearSupported(fy: string | null | undefined): boolean {
  return taxSettingsFor(fy) != null;
}

/** Oldest and newest supported FY — for "Ledger has rates for X to Y" messages. */
export function supportedTaxYearRange(): { earliest: string; latest: string } | null {
  const years = supportedTaxYears();
  if (years.length === 0) return null;
  return { earliest: years[0], latest: years[years.length - 1] };
}

// ─── Calculators (year-agnostic — they only read the shape above) ────────────

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The bracket a taxable income falls in. */
export function bracketFor(taxableIncome: number, settings: FinancialYearTaxSettings): IncomeTaxBracket {
  const income = Math.max(0, taxableIncome);
  let hit = settings.brackets[0];
  for (const b of settings.brackets) {
    if (income > b.from) hit = b;
  }
  return hit;
}

export function incomeTaxFor(taxableIncome: number, settings: FinancialYearTaxSettings): number {
  const income = Math.max(0, taxableIncome);
  const b = bracketFor(income, settings);
  return round2(Math.max(0, b.base + (income - b.from) * b.rate));
}

export function medicareLevyFor(taxableIncome: number, settings: FinancialYearTaxSettings): number {
  const income = Math.max(0, taxableIncome);
  const { rate, lowerThreshold, upperThreshold, shadeInRate } = settings.medicare;
  if (income <= lowerThreshold) return 0;
  // Shade-in: the levy phases in over the gap rather than switching on in full,
  // so crossing the threshold by a dollar costs cents, not hundreds.
  if (income <= upperThreshold) return round2(shadeInRate * (income - lowerThreshold));
  return round2(rate * income);
}

/**
 * Compulsory study and training loan (HELP/VSL/SFSS/SSL/AASL) repayment.
 *
 * Assessed on REPAYMENT INCOME, which is not taxable income — see
 * utils/repaymentIncome.ts for the definition and `repaymentIncomeFrom` for the
 * sum. Pass the repayment income in; this function must never be handed taxable
 * income on the assumption the two are the same, because for anyone salary
 * sacrificing, negatively gearing or packaging benefits they are not.
 */
export function studentLoanRepaymentFor(repaymentIncome: number, settings: FinancialYearTaxSettings): number {
  const income = Math.max(0, repaymentIncome);
  const loan = settings.studentLoan;
  if (income < loan.minThreshold) return 0;

  if (loan.model === 'income-bands') {
    let hit: StudentLoanBand | null = null;
    for (const b of loan.bands) {
      if (income >= b.from) hit = b;
    }
    return hit ? round2(income * hit.rate) : 0;
  }

  let hit = loan.tiers[0];
  for (const t of loan.tiers) {
    if (income > t.from) hit = t;
  }
  // The top tier charges a flat rate on the whole income; the rest charge only
  // on the excess above their edge.
  if (hit.wholeIncome) return round2(income * hit.rate);
  return round2(Math.max(0, hit.base + (income - hit.from) * hit.rate));
}

export interface TaxEstimate {
  fy: string;
  /** What income tax and the Medicare levy were assessed on. */
  taxableIncome: number;
  /** What the loan repayment was assessed on — taxable income when unadjusted. */
  repaymentIncome: number;
  incomeTax: number;
  medicareLevy: number;
  studentLoanRepayment: number;
  /** incomeTax + medicareLevy + studentLoanRepayment. */
  total: number;
  confidence: RateConfidence;
  notes: string[];
}

/**
 * The whole estimate for one year. Returns null when Ledger has no rates for
 * `fy` — callers must show "estimate unavailable", not substitute another year.
 */
export function estimateTaxForFY(
  fy: string,
  taxableIncome: number,
  opts?: {
    studentLoan?: boolean;
    /**
     * Repayment income for the loan repayment only. Omit ONLY when there is
     * nothing to add to taxable income: for a wage earner with no packaged
     * benefits, no reportable super and no investment losses the two are equal,
     * and that is the sole reason the fallback is safe.
     */
    repaymentIncome?: number;
  },
): TaxEstimate | null {
  const settings = taxSettingsFor(fy);
  if (!settings) return null;

  const income = Math.max(0, taxableIncome);
  // Two bases, kept apart: the levy and the brackets never see the repayment
  // income, and the loan schedule never sees the taxable income.
  const loanIncome = Math.max(0, opts?.repaymentIncome ?? income);
  const incomeTax = incomeTaxFor(income, settings);
  const medicareLevy = medicareLevyFor(income, settings);
  const studentLoanRepayment = opts?.studentLoan ? studentLoanRepaymentFor(loanIncome, settings) : 0;

  return {
    fy: settings.fy,
    taxableIncome: income,
    repaymentIncome: loanIncome,
    incomeTax,
    medicareLevy,
    studentLoanRepayment,
    total: round2(incomeTax + medicareLevy + studentLoanRepayment),
    confidence: settings.confidence,
    notes: settings.notes,
  };
}

/**
 * The bracket table for display: ATO-style inclusive bounds, so the row reads
 * "$18,201 – $45,000" rather than exposing the exclusive `from` edge.
 */
export interface DisplayBracket { min: number; max: number | null; rate: number }

export function displayBracketsFor(fy: string): DisplayBracket[] {
  const settings = taxSettingsFor(fy);
  if (!settings) return [];
  return settings.brackets.map(b => ({
    min: b.from === 0 ? 0 : b.from + 1,
    max: b.to,
    rate: b.rate,
  }));
}
