/**
 * Phase 5.2 — ESTIMATED REFUND OR AMOUNT OWING (pure engine).
 *
 * One subtraction, made auditable:
 *
 *     liability (income tax + Medicare levy + study loan repayment)
 *   − credits   (PAYG withheld + instalments + franking credits + other tax paid)
 *   = owing (positive) or refund (negative)
 *
 * It COMPUTES NO TAX and it READS NO STORE. The liability arrives already worked
 * out by utils/taxRates.ts (via dataService.calculateTax) and the income side
 * arrives already assembled by utils/taxYear.ts, so this module cannot disagree
 * with either — it can only add them up and explain the result. That is the
 * whole point of keeping it separate: "what do I owe" is a different question
 * from "what am I taxed on" and "what is the rate".
 *
 * WHEN THE YEAR HAS NO RATES the answer is `outcome: 'unknown'` and a null
 * liability — never a refund computed against a borrowed year's scales. What
 * has already been paid is still real, so the credits side is returned in full.
 *
 * OFFSETS AND THE HEALTH ADJUSTMENTS (Phase 5.3) arrive the same way: already
 * worked out, by utils/taxOffsets.ts, as three separate groups that this module
 * only places on the right side of the subtraction —
 *
 *     gross liability   income tax + Medicare levy + surcharge + loan repayment
 *                       + any private health rebate over-claimed
 *   − offsets           LITO, LMITO, SAPTO — non-refundable, so they reduce the
 *                       income tax and no further
 *   = net liability
 *   − credits           PAYG and everything else already paid, plus a private
 *                       health rebate under-claimed, which IS refundable
 *
 * Offsets are kept as their own group rather than folded into either side,
 * because they are neither: they are not money paid and they are not tax owed,
 * and a reader who cannot see them separately cannot check the arithmetic.
 *
 * Called WITHOUT an offset position, the engine behaves exactly as it did in
 * Phase 5.2 and says out loud that offsets are missing.
 */

import type { RateConfidence } from './taxRates';
import type { OffsetPosition, OffsetWarningKind } from './taxOffsets';
import type { IncomeSourceKind, TaxYearPosition } from './taxYear';
import { TAX_CREDIT_FIELDS, normaliseTaxCredits, type TaxCredits } from './taxCredits';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The already-computed tax for the year, as the settlement needs it. A narrow
 * shape rather than dataService's TaxCalculationResult, so this module stays in
 * utils/ with no dependency on the service layer. `null` figures mean "no rates
 * for this year" and must arrive together with `ratesAvailable: false`.
 */
export interface SettlementTaxInput {
  ratesAvailable: boolean;
  /** What income tax and the levy were assessed on. */
  taxableIncome: number;
  incomeTax: number | null;
  medicareLevy: number | null;
  studentLoanRepayment: number | null;
  confidence: RateConfidence | null;
  /** Rate-provenance notes, passed straight through to the UI. */
  notes: string[];
}

export type SettlementOutcome = 'refund' | 'owing' | 'square' | 'unknown';

/** One line of either side of the subtraction. */
export interface SettlementComponent {
  key: string;
  label: string;
  amount: number;
  /** Why this line is what it is, when that isn't obvious. */
  detail: string | null;
}

/** One income source, and the tax withheld from it. The drill-down row. */
export interface WithholdingSource {
  /** The income line's own key, so React keys stay stable across rebuilds. */
  key: string;
  kind: IncomeSourceKind;
  label: string;
  category: string;
  date: string;
  income: number;
  withheld: number;
  /** withheld ÷ income × 100, 0 when there is no income. */
  effectiveRate: number;
  /** The backing transaction, when the line has one — for drill-down. */
  transactionId: string | null;
  detail: string | null;
}

export type SettlementWarningKind =
  | OffsetWarningKind
  | 'no-rates'
  | 'provisional-rates'
  | 'year-in-progress'
  | 'nothing-withheld'
  | 'income-without-withholding'
  | 'multiple-tax-free-thresholds'
  | 'pending-income'
  | 'franking-gross-up'
  | 'offsets-excluded';

export interface SettlementWarning {
  kind: SettlementWarningKind;
  /**
   * 'warn' — the outcome shown could be materially wrong until the user acts.
   * 'info' — a limitation worth knowing, needing nothing from the user.
   */
  severity: 'warn' | 'info';
  /** Plain text, free of dollar figures — the UI formats `amount`. */
  message: string;
  amount?: number;
  count?: number;
}

export interface TaxSettlement {
  fy: string;
  ratesAvailable: boolean;
  confidence: RateConfidence | null;
  /** Rate-provenance notes from the registry (an indexed-estimate year, etc). */
  notes: string[];

  /**
   * GROSS tax for the year: income tax + Medicare levy + the surcharge + a loan
   * repayment + any private health rebate over-claimed. `total` is null with no
   * rates. This is the figure BEFORE offsets, so the two groups can be read
   * against each other.
   */
  liability: { components: SettlementComponent[]; total: number | null };
  /** Non-refundable offsets actually applied. Empty without an offset position. */
  offsets: { components: SettlementComponent[]; total: number };
  /** liability − offsets: what the year really costs. Null with no rates. */
  netLiability: number | null;
  /** PAYG withheld + everything else already paid. Always known. */
  credits: { components: SettlementComponent[]; total: number };

  /** The PAYG part of the credits, split out because it is the derived one. */
  paygWithheld: number;
  /** The user-supplied part of the credits. */
  otherCredits: number;

  /** netLiability − credits, rounded. Positive is owing, negative a refund. */
  net: number | null;
  outcome: SettlementOutcome;
  /** The headline figure, always positive. Zero unless the outcome matches. */
  refund: number;
  owing: number;

  /** Every counted income source, with what was withheld from it. */
  withholdingSources: WithholdingSource[];
  /** Counted income that had no tax withheld from it at all. */
  unwithheldIncome: number;
  /**
   * Net liability ÷ taxable income × 100 — the rate AFTER offsets, because that
   * is the rate actually paid. Null with no rates, 0 with no income.
   */
  effectiveTaxRate: number | null;

  warnings: SettlementWarning[];
}

/**
 * Build the settlement for one financial year.
 *
 * `asOf` (an ISO date, normally today) only decides whether the year is still
 * running — a mid-year position is a snapshot of income and withholding so far,
 * and saying so is the difference between a useful number and a misleading one.
 * Omit it and no such claim is made.
 *
 * `taxFreeThresholdClaims` is how many employers the user claims the tax-free
 * threshold from; it lives in localStorage (payroll.ts) so the caller reads it.
 * Two or more is the single most common reason a wage earner gets a bill.
 */
export function buildTaxSettlement(input: {
  position: TaxYearPosition;
  tax: SettlementTaxInput;
  credits?: TaxCredits | null;
  /**
   * Phase 5.3 — offsets, the surcharge and the private health reconciliation,
   * already worked out by utils/taxOffsets.buildOffsetPosition. Omit it and the
   * settlement is the Phase 5.2 one, with a warning that offsets are missing.
   */
  offsets?: OffsetPosition | null;
  taxFreeThresholdClaims?: number;
  asOf?: string | null;
}): TaxSettlement {
  const { position, tax } = input;
  const credits = normaliseTaxCredits(input.credits);
  // Only an offset position for a year that HAS rates can change the answer: a
  // surcharge with no scale to compare it against is not an estimate.
  const offsets = tax.ratesAvailable ? (input.offsets ?? null) : null;

  // ── Liability ──────────────────────────────────────────────────────────────
  const liabilityComponents: SettlementComponent[] = [];
  let liabilityTotal: number | null = null;

  if (tax.ratesAvailable) {
    const incomeTax = tax.incomeTax ?? 0;
    const medicare = tax.medicareLevy ?? 0;
    const loan = tax.studentLoanRepayment ?? 0;
    liabilityComponents.push({
      key: 'income-tax',
      label: 'Income tax',
      amount: round2(incomeTax),
      detail: 'On taxable income',
    });
    liabilityComponents.push({
      key: 'medicare-levy',
      label: 'Medicare levy',
      amount: round2(medicare),
      // A levy of exactly zero is a result, not a gap — say which.
      detail: medicare === 0 ? 'Below the low-income threshold' : 'On taxable income',
    });
    // The surcharge sits with the levy it is charged on top of, and an
    // over-claimed health rebate is a real amount added to the bill — both are
    // extra TAX, so they belong on this side and not netted off the offsets.
    for (const line of offsets?.extraLiability ?? []) {
      liabilityComponents.push({
        key: line.key,
        label: line.label,
        amount: line.amount,
        detail: line.detail,
      });
    }
    if (loan > 0) {
      liabilityComponents.push({
        key: 'study-loan',
        label: 'Study and training loan repayment',
        amount: round2(loan),
        detail: 'On repayment income, not taxable income',
      });
    }
    liabilityTotal = round2(
      incomeTax + medicare + loan + (offsets?.extraLiabilityTotal ?? 0),
    );
  }

  // ── Offsets: neither tax owed nor money paid ───────────────────────────────
  const offsetComponents: SettlementComponent[] = (offsets?.applied ?? []).map(o => ({
    key: o.key,
    label: o.label,
    amount: o.amount,
    detail: o.detail,
  }));
  const offsetsTotal = round2(offsets?.appliedTotal ?? 0);
  const netLiability = liabilityTotal == null ? null : round2(liabilityTotal - offsetsTotal);

  // ── Credits: what has already been paid ────────────────────────────────────
  const paygWithheld = round2(position.taxWithheld);
  const creditComponents: SettlementComponent[] = [];
  const withheldFrom = position.income.lines.filter(l => !l.excluded && l.taxWithheld > 0);
  if (paygWithheld > 0 || withheldFrom.length > 0) {
    creditComponents.push({
      key: 'payg-withheld',
      label: 'PAYG withheld',
      amount: paygWithheld,
      detail: `From ${withheldFrom.length} income source${withheldFrom.length === 1 ? '' : 's'}`,
    });
  }
  for (const f of TAX_CREDIT_FIELDS) {
    const value = credits[f.key];
    if (value <= 0) continue;
    creditComponents.push({
      key: f.key,
      label: f.label,
      amount: value,
      detail: f.grossesUp ? 'Also added to your assessable income' : null,
    });
  }
  // A private health rebate that was UNDER-claimed is refundable, so it belongs
  // with the money already paid rather than with the non-refundable offsets.
  for (const line of offsets?.refundableCredits ?? []) {
    creditComponents.push({
      key: line.key,
      label: line.label,
      amount: line.amount,
      detail: line.detail,
    });
  }
  const otherCredits = round2(
    TAX_CREDIT_FIELDS.reduce((s, f) => s + credits[f.key], 0)
    + (offsets?.refundableCreditsTotal ?? 0),
  );
  const creditsTotal = round2(paygWithheld + otherCredits);

  // ── The subtraction ────────────────────────────────────────────────────────
  const net = netLiability == null ? null : round2(netLiability - creditsTotal);
  const outcome: SettlementOutcome =
    net == null ? 'unknown' : net > 0 ? 'owing' : net < 0 ? 'refund' : 'square';

  // ── Drill-down: every counted source and what it withheld ──────────────────
  const withholdingSources: WithholdingSource[] = position.income.lines
    .filter(l => !l.excluded && (l.amount > 0 || l.taxWithheld > 0))
    .map(l => ({
      key: l.key,
      kind: l.kind,
      label: l.label,
      category: l.category,
      date: l.date,
      income: round2(l.amount),
      withheld: round2(l.taxWithheld),
      effectiveRate: l.amount > 0 ? round2((l.taxWithheld / l.amount) * 100) : 0,
      transactionId: l.transactionId,
      detail: l.detail,
    }))
    .sort((a, b) => b.withheld - a.withheld || b.income - a.income || a.label.localeCompare(b.label));

  const unwithheldIncome = round2(
    withholdingSources.reduce((s, w) => s + (w.withheld > 0 ? 0 : w.income), 0),
  );

  const effectiveTaxRate =
    netLiability == null
      ? null
      : tax.taxableIncome > 0
        ? round2((netLiability / tax.taxableIncome) * 100)
        : 0;

  // ── Warnings, most consequential first ─────────────────────────────────────
  const warnings: SettlementWarning[] = [];

  if (!tax.ratesAvailable) {
    warnings.push({
      kind: 'no-rates',
      severity: 'warn',
      message:
        'Ledger holds no tax rates for this year, so there is no liability to compare against. ' +
        'What has already been paid is still shown.',
    });
  } else if (tax.confidence === 'indexed-estimate') {
    warnings.push({
      kind: 'provisional-rates',
      severity: 'warn',
      message:
        'Some of this year’s thresholds are not final, so the outcome can move once the ATO publishes them.',
    });
  }

  if (isYearInProgress(position, input.asOf)) {
    warnings.push({
      kind: 'year-in-progress',
      severity: 'info',
      message:
        'This year is still running. Income and tax withheld are what you have recorded so far, ' +
        'so this is a snapshot rather than a year-end result.',
    });
  }

  if (position.assessableIncome > 0 && creditsTotal === 0) {
    warnings.push({
      kind: 'nothing-withheld',
      severity: 'warn',
      message:
        'No tax has been withheld or paid against this year’s income, so the whole liability ' +
        'is still outstanding. Add your payslips if tax was in fact withheld.',
      amount: position.assessableIncome,
    });
  } else if (unwithheldIncome > 0) {
    const n = withholdingSources.filter(w => w.withheld === 0 && w.income > 0).length;
    warnings.push({
      kind: 'income-without-withholding',
      severity: 'info',
      count: n,
      amount: unwithheldIncome,
      message:
        `${n} income source${n === 1 ? '' : 's'} had no tax withheld, so the tax on ` +
        (n === 1 ? 'it' : 'them') + ' falls due at lodgement.',
    });
  }

  const claims = input.taxFreeThresholdClaims ?? 0;
  if (claims > 1) {
    warnings.push({
      kind: 'multiple-tax-free-thresholds',
      severity: 'warn',
      count: claims,
      message:
        `You claim the tax-free threshold from ${claims} employers. Each withholds as if it were ` +
        'your only job, which usually leaves a bill at lodgement.',
    });
  }

  const pending = position.notes.find(n => n.kind === 'pending-income');
  if (pending) {
    warnings.push({
      kind: 'pending-income',
      severity: 'warn',
      count: pending.count,
      amount: pending.amount,
      message:
        `${pending.count} pending income ${pending.count === 1 ? 'entry is' : 'entries are'} not in this ` +
        'result. Approving them raises the liability and shrinks any refund.',
    });
  }

  if (credits.frankingCredits > 0) {
    warnings.push({
      kind: 'franking-gross-up',
      severity: 'info',
      amount: credits.frankingCredits,
      message:
        'Franking credits are counted twice over, as the ATO does it: added to your assessable ' +
        'income and then credited against the bill.',
    });
  }

  // The offset engine's own warnings — the surcharge, the health reconciliation,
  // relief that had nowhere to go — read the same way as the ones above, so they
  // are simply appended rather than re-worded here.
  if (offsets) {
    warnings.push(...offsets.warnings);
  } else if (tax.ratesAvailable) {
    warnings.push({
      kind: 'offsets-excluded',
      severity: 'info',
      message:
        'Tax offsets — the low income tax offset and the private health rebate among them — are not ' +
        'included. They can only reduce what you owe, so the real outcome is this or better.',
    });
  }

  return {
    fy: position.fy,
    ratesAvailable: tax.ratesAvailable,
    confidence: tax.confidence,
    notes: offsets ? [...tax.notes, ...offsets.notes] : tax.notes,
    liability: { components: liabilityComponents, total: liabilityTotal },
    offsets: { components: offsetComponents, total: offsetsTotal },
    netLiability,
    credits: { components: creditComponents, total: creditsTotal },
    paygWithheld,
    otherCredits,
    net,
    outcome,
    refund: net != null && net < 0 ? round2(-net) : 0,
    owing: net != null && net > 0 ? net : 0,
    withholdingSources,
    unwithheldIncome,
    effectiveTaxRate,
    warnings,
  };
}

/**
 * Whether `asOf` falls inside the position's own financial year. Compared as ISO
 * strings against the 1 July / 30 June bounds the position already carries, so a
 * time zone can never move the answer.
 */
function isYearInProgress(position: TaxYearPosition, asOf?: string | null): boolean {
  const day = (asOf ?? '').trim().slice(0, 10);
  if (day.length !== 10) return false;
  // 30 June counts as in progress: the year has not closed until 1 July.
  return day >= position.start && day <= position.end;
}

/** Headline wording for an outcome, so every surface says the same thing. */
export function settlementHeadline(outcome: SettlementOutcome): string {
  switch (outcome) {
    case 'refund': return 'Estimated refund';
    case 'owing': return 'Estimated amount owing';
    case 'square': return 'Estimated outcome';
    default: return 'Estimated outcome';
  }
}
