/**
 * Phase 5.3 — THE FACTS ABOUT THE PERSON that the offsets and the surcharge need.
 *
 * Everything Ledger can derive, it derives: income from payslips and entries,
 * deductions from transactions, withholding from both. None of the following can
 * be derived from money movements at all, so it is asked for and stored PER
 * FINANCIAL YEAR, exactly like the repayment-income figures and the tax credits:
 *
 *   • whether there was a spouse, and their income for surcharge purposes — the
 *     surcharge and the private health rebate are FAMILY income tests, and a
 *     spouse's income is not in Ledger under any circumstances
 *   • dependent children — each one after the first lifts the family threshold
 *   • private patient HOSPITAL cover, and for how much of the year — a health
 *     premium leaving the bank says nothing about whether the policy was
 *     hospital cover or extras-only, and only hospital cover stops the surcharge
 *   • seniors and pensioners eligibility, which turns on age-pension age and
 *     Centrelink/DVA entitlement, and whether the taxpayer is one of a couple
 *   • the figures off the private health statement: premiums eligible for the
 *     rebate in each of the statement's two periods, and the rebate already
 *     received as a reduced premium
 *
 * TWO DEFAULTS, CHOSEN DELIBERATELY AND IN OPPOSITE DIRECTIONS.
 *
 * Everything that GRANTS relief defaults to off — no SAPTO, no premiums, no
 * rebate to claim — so an untouched profile can only understate a refund, which
 * is the same rule utils/taxCredits.ts follows.
 *
 * Hospital cover is the exception. It defaults to `'unknown'` and NO surcharge
 * is charged, even though charging it would be the conservative direction. A
 * surcharge is not an approximation that might be a little off; it is a
 * four-figure charge that either applies or does not, decided by a fact Ledger
 * has no way to observe. Inventing one for the majority of people who do hold
 * cover would make the headline wrong, so the engine leaves it out and says
 * loudly, with the exact amount at stake, that it needs an answer.
 *
 * Nothing here knows a rate or a threshold. This module answers "who is this
 * person"; utils/taxOffsets.ts answers "what is that worth".
 */

/** Which SAPTO row applies — see the ATO's own three-row table. */
export type SaptoStatus = 'single' | 'couple' | 'illness-separated';

/** The age band of the OLDEST person covered by the health policy. */
export type RebateAgeBand = 'under-65' | '65-69' | '70-plus';

/** How much of the year was covered by appropriate private hospital cover. */
export type HospitalCoverStatus = 'unknown' | 'full-year' | 'part-year' | 'none';

export interface TaxProfile {
  /** Had a spouse on 30 June. Switches every income test to family thresholds. */
  hasSpouse: boolean;
  /** The spouse's own income for surcharge purposes, for the family test. */
  spouseSurchargeIncome: number;
  /** Dependent children for surcharge purposes. */
  dependentChildren: number;

  hospitalCover: HospitalCoverStatus;
  /** Days covered, used only when `hospitalCover` is 'part-year'. */
  hospitalCoverDays: number;

  /** Met the age and pension conditions for the seniors and pensioners offset. */
  saptoEligible: boolean;
  saptoStatus: SaptoStatus;

  healthAgeBand: RebateAgeBand;
  /** Premiums eligible for the rebate, 1 July – 31 March, off the statement. */
  premiumsFirstPeriod: number;
  /** Premiums eligible for the rebate, 1 April – 30 June, off the statement. */
  premiumsSecondPeriod: number;
  /** Rebate already received as a reduced premium, off the same statement. */
  rebateReceived: number;
}

export const SAPTO_STATUS_LABELS: Record<SaptoStatus, string> = {
  'single': 'Single',
  'couple': 'Member of a couple',
  'illness-separated': 'Couple living apart due to illness',
};

export const REBATE_AGE_LABELS: Record<RebateAgeBand, string> = {
  'under-65': 'Under 65',
  '65-69': '65 to 69',
  '70-plus': '70 or over',
};

export const HOSPITAL_COVER_LABELS: Record<HospitalCoverStatus, string> = {
  'unknown': 'Not answered',
  'full-year': 'Yes, all year',
  'part-year': 'For part of the year',
  'none': 'No',
};

export function emptyTaxProfile(): TaxProfile {
  return {
    hasSpouse: false,
    spouseSurchargeIncome: 0,
    dependentChildren: 0,
    hospitalCover: 'unknown',
    hospitalCoverDays: 0,
    saptoEligible: false,
    saptoStatus: 'single',
    healthAgeBand: 'under-65',
    premiumsFirstPeriod: 0,
    premiumsSecondPeriod: 0,
    rebateReceived: 0,
  };
}

/** A positive, finite amount — anything else reads as nothing supplied. */
function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function count(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

const SAPTO_STATUSES = ['single', 'couple', 'illness-separated'] as const;
const AGE_BANDS = ['under-65', '65-69', '70-plus'] as const;
const COVER_STATUSES = ['unknown', 'full-year', 'part-year', 'none'] as const;

/**
 * Coerce whatever came out of storage (or a form) into the record. Unknown keys
 * are dropped, bad values fall back to the empty profile's own answer, and an
 * unrecognised enum reads as "not answered" rather than guessing.
 */
export function normaliseTaxProfile(raw: unknown): TaxProfile {
  const src = (raw ?? {}) as Record<string, unknown>;
  // 366 covers a leap financial year; the engine clamps again to the real length.
  const days = count(src.hospitalCoverDays, 366);
  const cover = oneOf(src.hospitalCover, COVER_STATUSES, 'unknown');
  return {
    hasSpouse: src.hasSpouse === true,
    spouseSurchargeIncome: amount(src.spouseSurchargeIncome),
    dependentChildren: count(src.dependentChildren, 20),
    hospitalCover: cover,
    // Days only mean anything for a part year. Storing them under any other
    // answer would let a stale number contradict the answer it sits beside.
    hospitalCoverDays: cover === 'part-year' ? days : 0,
    saptoEligible: src.saptoEligible === true,
    saptoStatus: oneOf(src.saptoStatus, SAPTO_STATUSES, 'single'),
    healthAgeBand: oneOf(src.healthAgeBand, AGE_BANDS, 'under-65'),
    premiumsFirstPeriod: amount(src.premiumsFirstPeriod),
    premiumsSecondPeriod: amount(src.premiumsSecondPeriod),
    rebateReceived: amount(src.rebateReceived),
  };
}

/** True when the user has answered anything — keeps the UI quiet by default. */
export function hasTaxProfile(p: TaxProfile | null | undefined): boolean {
  if (!p) return false;
  const n = normaliseTaxProfile(p);
  const empty = emptyTaxProfile();
  return (Object.keys(empty) as (keyof TaxProfile)[]).some(k => n[k] !== empty[k]);
}

/** True when the private health statement figures have been entered. */
export function hasHealthPolicy(p: TaxProfile | null | undefined): boolean {
  const n = normaliseTaxProfile(p);
  return n.premiumsFirstPeriod > 0 || n.premiumsSecondPeriod > 0 || n.rebateReceived > 0;
}

// ─── Field metadata, so the editor is a loop and the copy lives in one place ──

export type TaxProfileFieldKind = 'toggle' | 'money' | 'count' | 'days' | 'choice';

export interface TaxProfileField {
  key: keyof TaxProfile;
  kind: TaxProfileFieldKind;
  label: string;
  help: string;
  /** For 'choice' fields: the options, in the order the ATO lists them. */
  options?: { value: string; label: string }[];
  /** Hidden until the answer it depends on makes it meaningful. */
  visibleWhen?: (p: TaxProfile) => boolean;
}

export interface TaxProfileGroup {
  key: 'household' | 'health' | 'seniors';
  title: string;
  /** Why Ledger is asking — shown once, above the fields. */
  intro: string;
  fields: TaxProfileField[];
}

export const TAX_PROFILE_GROUPS: TaxProfileGroup[] = [
  {
    key: 'household',
    title: 'Spouse and dependants',
    intro:
      'The Medicare levy surcharge and the private health rebate are family income tests. '
      + 'With a spouse, both run on your combined income against a threshold twice the size.',
    fields: [
      {
        key: 'hasSpouse',
        kind: 'toggle',
        label: 'I had a spouse',
        help: 'A married or de facto partner on 30 June. This switches the surcharge and rebate to the family thresholds.',
      },
      {
        key: 'spouseSurchargeIncome',
        kind: 'money',
        label: 'Spouse’s income for surcharge purposes',
        help: 'Their taxable income plus reportable fringe benefits, net investment losses and reportable super — the same test as yours.',
        visibleWhen: p => p.hasSpouse,
      },
      {
        key: 'dependentChildren',
        kind: 'count',
        label: 'Dependent children',
        help: 'Each child after the first lifts the family threshold by $1,500.',
      },
    ],
  },
  {
    key: 'health',
    title: 'Private health insurance',
    intro:
      'Hospital cover is what stops the surcharge — an extras-only policy does not count. '
      + 'The premium and rebate figures come off the private health statement your insurer sends you.',
    fields: [
      {
        key: 'hospitalCover',
        kind: 'choice',
        label: 'Private patient hospital cover',
        help: 'For you, your spouse and all your dependants. Until this is answered, no surcharge is included in the estimate.',
        options: COVER_STATUSES.filter(c => c !== 'unknown').map(c => ({ value: c, label: HOSPITAL_COVER_LABELS[c] })),
      },
      {
        key: 'hospitalCoverDays',
        kind: 'days',
        label: 'Days covered',
        help: 'The surcharge is charged for the days you were not covered, not the whole year.',
        visibleWhen: p => p.hospitalCover === 'part-year',
      },
      {
        key: 'healthAgeBand',
        kind: 'choice',
        label: 'Oldest person on the policy',
        help: 'The rebate percentage rises at 65 and again at 70, based on the oldest person the policy covers.',
        options: AGE_BANDS.map(a => ({ value: a, label: REBATE_AGE_LABELS[a] })),
        visibleWhen: p => p.hospitalCover === 'full-year' || p.hospitalCover === 'part-year',
      },
      {
        key: 'premiumsFirstPeriod',
        kind: 'money',
        label: 'Premiums eligible for rebate — July to March',
        help: 'From your statement. The rebate percentage changes on 1 April, so the statement splits the year in two.',
      },
      {
        key: 'premiumsSecondPeriod',
        kind: 'money',
        label: 'Premiums eligible for rebate — April to June',
        help: 'The second row on the same statement. Leave blank if your statement has only one.',
      },
      {
        key: 'rebateReceived',
        kind: 'money',
        label: 'Rebate already received',
        help: 'The Australian Government rebate your insurer already took off your premiums. Ledger compares it with what your income actually entitles you to.',
      },
    ],
  },
  {
    key: 'seniors',
    title: 'Seniors and pensioners',
    intro:
      'The seniors and pensioners tax offset needs two things Ledger cannot see: whether you '
      + 'met the age and pension conditions, and whether you were one of a couple.',
    fields: [
      {
        key: 'saptoEligible',
        kind: 'toggle',
        label: 'I was eligible for the seniors and pensioners offset',
        help: 'You reached age-pension age and received an Australian Government pension or allowance, or you meet the veteran conditions.',
      },
      {
        key: 'saptoStatus',
        kind: 'choice',
        label: 'Your situation',
        help: 'A couple gets a smaller maximum each, and is tested on half the combined rebate income.',
        options: SAPTO_STATUSES.map(s => ({ value: s, label: SAPTO_STATUS_LABELS[s] })),
        visibleWhen: p => p.saptoEligible,
      },
    ],
  },
];
