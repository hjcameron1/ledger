/**
 * REPAYMENT INCOME — the income base a compulsory study and training loan
 * repayment is assessed on. It is NOT taxable income, and the difference is not
 * academic: salary sacrificing into super, packaging a car, or negatively
 * gearing all cut taxable income while leaving repayment income untouched, which
 * is precisely why the ATO defines a separate base.
 *
 * From the ATO ("Study and training loan repayment thresholds and rates",
 * verified 19 August 2026), repayment income is the sum of:
 *
 *   • taxable income (excluding assessable First Home Super Saver released amounts)
 *   • reportable fringe benefits (regardless of the employer's exempt status)
 *   • total net investment loss (including net rental losses)
 *   • reportable super contributions
 *   • exempt foreign employment income
 *
 * Ledger can derive the first term — utils/taxYear.ts computes it — and cannot
 * derive any of the others: reportable fringe benefits and reportable super
 * contributions come off a payment summary, and a net investment loss is a
 * return-level figure, none of which a bank feed or a payslip contains. So they
 * are USER-SUPPLIED, default to nothing, and are recorded per financial year
 * because every one of them is an annual figure.
 *
 * Nothing here knows a rate or a threshold. This module answers "what income is
 * the loan assessed on"; utils/taxRates.ts answers "what does that cost". The
 * separation is the same one taxYear.ts keeps for income tax.
 */

/**
 * The per-FY figures the user adds to taxable income. Every field is an annual
 * dollar amount, entered positive — including the investment loss, which is a
 * loss added back, not a negative number.
 */
export interface RepaymentIncomeAdjustments {
  reportableFringeBenefits: number;
  totalNetInvestmentLoss: number;
  reportableSuperContributions: number;
  exemptForeignEmploymentIncome: number;
  /**
   * Assessable First Home Super Saver amounts released this year. The one term
   * that comes OUT: it sits inside taxable income but the ATO excludes it from
   * repayment income.
   */
  assessableFHSSReleased: number;
}

export type RepaymentIncomeField = keyof RepaymentIncomeAdjustments;

/** One line of the breakdown, signed as it applies to the total. */
export interface RepaymentIncomeComponent {
  key: 'taxableIncome' | RepaymentIncomeField;
  label: string;
  amount: number;
}

export interface RepaymentIncomeBreakdown {
  /** The figure to assess the loan repayment on. Never negative. */
  total: number;
  /** The taxable income it was built from — the other base, kept visible. */
  taxableIncome: number;
  /** total − taxableIncome. Zero when nothing was supplied. */
  adjustments: number;
  /** Taxable income plus every non-zero adjustment, in ATO order. */
  components: RepaymentIncomeComponent[];
  /** True when repayment income is just taxable income. */
  unadjusted: boolean;
}

/**
 * Field metadata, in the ATO's own order and wording. The editor renders this
 * list rather than hard-coding five inputs, so adding a term is a data change.
 */
export const REPAYMENT_INCOME_FIELDS: {
  key: RepaymentIncomeField;
  label: string;
  help: string;
  /** Whether the amount is added to, or taken off, taxable income. */
  sign: 1 | -1;
}[] = [
  {
    key: 'reportableFringeBenefits',
    label: 'Reportable fringe benefits',
    help: 'The grossed-up amount from your income statement — counted even if your employer is FBT-exempt.',
    sign: 1,
  },
  {
    key: 'totalNetInvestmentLoss',
    label: 'Total net investment loss',
    help: 'Net rental and other investment losses, entered as a positive amount.',
    sign: 1,
  },
  {
    key: 'reportableSuperContributions',
    label: 'Reportable super contributions',
    help: 'Salary-sacrificed super and personal contributions you claim a deduction for. Employer SG is not included.',
    sign: 1,
  },
  {
    key: 'exemptForeignEmploymentIncome',
    label: 'Exempt foreign employment income',
    help: 'Foreign employment income exempt from Australian tax but still counted for loan repayments.',
    sign: 1,
  },
  {
    key: 'assessableFHSSReleased',
    label: 'First Home Super Saver released',
    help: 'Assessable FHSS amounts released to you this year. These are taken back OFF taxable income.',
    sign: -1,
  },
];

export function emptyRepaymentIncomeAdjustments(): RepaymentIncomeAdjustments {
  return {
    reportableFringeBenefits: 0,
    totalNetInvestmentLoss: 0,
    reportableSuperContributions: 0,
    exemptForeignEmploymentIncome: 0,
    assessableFHSSReleased: 0,
  };
}

/** A non-negative, finite number — anything else reads as nothing supplied. */
function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Coerce whatever came out of storage (or a form) into the record. Unknown keys
 * are dropped and bad values read as zero, so a corrupted bucket can degrade the
 * estimate to "taxable income only" but can never produce a wrong number.
 */
export function normaliseRepaymentIncomeAdjustments(raw: unknown): RepaymentIncomeAdjustments {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = emptyRepaymentIncomeAdjustments();
  for (const f of REPAYMENT_INCOME_FIELDS) out[f.key] = amount(src[f.key]);
  return out;
}

/** True when nothing has been entered — used to keep the UI quiet by default. */
export function hasRepaymentIncomeAdjustments(a: RepaymentIncomeAdjustments | null | undefined): boolean {
  if (!a) return false;
  return REPAYMENT_INCOME_FIELDS.some(f => amount(a[f.key]) > 0);
}

/**
 * Repayment income from taxable income plus the year's adjustments.
 *
 * With no adjustments the total is exactly the taxable income passed in — which
 * is the ONLY circumstance under which assessing a loan on taxable income is
 * correct, and it is stated here rather than assumed by the caller.
 */
export function repaymentIncomeFrom(
  taxableIncome: number,
  adjustments?: RepaymentIncomeAdjustments | null,
): RepaymentIncomeBreakdown {
  const base = Math.max(0, Number.isFinite(taxableIncome) ? taxableIncome : 0);
  const adj = normaliseRepaymentIncomeAdjustments(adjustments);

  const components: RepaymentIncomeComponent[] = [
    { key: 'taxableIncome', label: 'Taxable income', amount: base },
  ];
  let total = base;
  for (const f of REPAYMENT_INCOME_FIELDS) {
    const value = adj[f.key];
    if (value <= 0) continue;
    const signed = value * f.sign;
    total += signed;
    components.push({ key: f.key, label: f.label, amount: signed });
  }

  // An FHSS release bigger than the whole taxable income can only mean a typo;
  // floor at zero rather than hand the loan schedule a negative income.
  total = Math.max(0, round2(total));

  return {
    total,
    taxableIncome: base,
    adjustments: round2(total - base),
    components,
    unadjusted: components.length === 1,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
