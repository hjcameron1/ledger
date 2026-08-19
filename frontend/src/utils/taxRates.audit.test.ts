/**
 * THE AUDIT — the ATO's own tables, transcribed, and the registry checked against
 * them row by row.
 *
 * taxRates.test.ts proves the registry is internally consistent (contiguous
 * bands, continuous tax, no negative amounts). It cannot prove the numbers are
 * the RIGHT numbers: a table that is wrong but tidy passes every one of those
 * invariants. This file is the other half. Each table below was copied from the
 * ATO page named above it on 19 August 2026 and is the source of truth here — if
 * a figure in taxRates.ts disagrees with one of these rows, taxRates.ts is what
 * changes.
 *
 * Re-auditing a year, or adding one, is therefore a two-line job: paste the new
 * ATO row in here, and make the registry match.
 *
 * Sources:
 *   ato.gov.au/tax-rates-and-codes/study-and-training-support-loans-rates-and-repayment-thresholds
 *   ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents
 *   ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/
 *     medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners
 */

import { describe, it, expect } from 'vitest';
import {
  taxSettingsFor,
  incomeTaxFor,
  medicareLevyFor,
  studentLoanRepaymentFor,
  supportedTaxYears,
  estimateTaxForFY,
} from './taxRates';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ─── ATO: study and training loan, whole-income years (2024-25 and earlier) ──
// "Compulsory repayments for 2024–25 and earlier years were based on applying
// the relevant repayment rate to your total repayment income."

interface AtoBandRow { from: number; to: number | null; rate: number }

const ATO_LOAN_BANDS: Record<string, AtoBandRow[]> = {
  '2020-2021': [
    { from: 46620, to: 53826, rate: 0.01 },
    { from: 53827, to: 57055, rate: 0.02 },
    { from: 57056, to: 60479, rate: 0.025 },
    { from: 60480, to: 64108, rate: 0.03 },
    { from: 64109, to: 67954, rate: 0.035 },
    { from: 67955, to: 72031, rate: 0.04 },
    { from: 72032, to: 76354, rate: 0.045 },
    { from: 76355, to: 80935, rate: 0.05 },
    { from: 80936, to: 85792, rate: 0.055 },
    { from: 85793, to: 90939, rate: 0.06 },
    { from: 90940, to: 96396, rate: 0.065 },
    { from: 96397, to: 102179, rate: 0.07 },
    { from: 102180, to: 108309, rate: 0.075 },
    { from: 108310, to: 114809, rate: 0.08 },
    { from: 114810, to: 121698, rate: 0.085 },
    { from: 121699, to: 128999, rate: 0.09 },
    { from: 129000, to: 136739, rate: 0.095 },
    { from: 136740, to: null, rate: 0.1 },
  ],
  '2021-2022': [
    { from: 47014, to: 54282, rate: 0.01 },
    { from: 54283, to: 57538, rate: 0.02 },
    { from: 57539, to: 60991, rate: 0.025 },
    { from: 60992, to: 64651, rate: 0.03 },
    { from: 64652, to: 68529, rate: 0.035 },
    { from: 68530, to: 72641, rate: 0.04 },
    { from: 72642, to: 77001, rate: 0.045 },
    { from: 77002, to: 81620, rate: 0.05 },
    { from: 81621, to: 86518, rate: 0.055 },
    { from: 86519, to: 91709, rate: 0.06 },
    { from: 91710, to: 97212, rate: 0.065 },
    { from: 97213, to: 103045, rate: 0.07 },
    { from: 103046, to: 109227, rate: 0.075 },
    { from: 109228, to: 115781, rate: 0.08 },
    { from: 115782, to: 122728, rate: 0.085 },
    { from: 122729, to: 130092, rate: 0.09 },
    { from: 130093, to: 137897, rate: 0.095 },
    { from: 137898, to: null, rate: 0.1 },
  ],
  '2022-2023': [
    { from: 48361, to: 55836, rate: 0.01 },
    { from: 55837, to: 59186, rate: 0.02 },
    { from: 59187, to: 62738, rate: 0.025 },
    { from: 62739, to: 66502, rate: 0.03 },
    { from: 66503, to: 70492, rate: 0.035 },
    { from: 70493, to: 74722, rate: 0.04 },
    { from: 74723, to: 79206, rate: 0.045 },
    { from: 79207, to: 83958, rate: 0.05 },
    { from: 83959, to: 88996, rate: 0.055 },
    { from: 88997, to: 94336, rate: 0.06 },
    { from: 94337, to: 99996, rate: 0.065 },
    { from: 99997, to: 105996, rate: 0.07 },
    { from: 105997, to: 112355, rate: 0.075 },
    { from: 112356, to: 119097, rate: 0.08 },
    { from: 119098, to: 126243, rate: 0.085 },
    { from: 126244, to: 133818, rate: 0.09 },
    { from: 133819, to: 141847, rate: 0.095 },
    { from: 141848, to: null, rate: 0.1 },
  ],
  '2023-2024': [
    { from: 51550, to: 59518, rate: 0.01 },
    { from: 59519, to: 63089, rate: 0.02 },
    { from: 63090, to: 66875, rate: 0.025 },
    { from: 66876, to: 70888, rate: 0.03 },
    { from: 70889, to: 75140, rate: 0.035 },
    { from: 75141, to: 79649, rate: 0.04 },
    { from: 79650, to: 84429, rate: 0.045 },
    { from: 84430, to: 89494, rate: 0.05 },
    { from: 89495, to: 94865, rate: 0.055 },
    { from: 94866, to: 100557, rate: 0.06 },
    { from: 100558, to: 106590, rate: 0.065 },
    { from: 106591, to: 112985, rate: 0.07 },
    { from: 112986, to: 119764, rate: 0.075 },
    { from: 119765, to: 126950, rate: 0.08 },
    { from: 126951, to: 134568, rate: 0.085 },
    { from: 134569, to: 142642, rate: 0.09 },
    { from: 142643, to: 151200, rate: 0.095 },
    { from: 151201, to: null, rate: 0.1 },
  ],
  '2024-2025': [
    { from: 54435, to: 62850, rate: 0.01 },
    { from: 62851, to: 66620, rate: 0.02 },
    { from: 66621, to: 70618, rate: 0.025 },
    { from: 70619, to: 74855, rate: 0.03 },
    { from: 74856, to: 79346, rate: 0.035 },
    { from: 79347, to: 84107, rate: 0.04 },
    { from: 84108, to: 89154, rate: 0.045 },
    { from: 89155, to: 94503, rate: 0.05 },
    { from: 94504, to: 100174, rate: 0.055 },
    { from: 100175, to: 106185, rate: 0.06 },
    { from: 106186, to: 112556, rate: 0.065 },
    { from: 112557, to: 119309, rate: 0.07 },
    { from: 119310, to: 126467, rate: 0.075 },
    { from: 126468, to: 134056, rate: 0.08 },
    { from: 134057, to: 142100, rate: 0.085 },
    { from: 142101, to: 150626, rate: 0.09 },
    { from: 150627, to: 159663, rate: 0.095 },
    { from: 159664, to: null, rate: 0.1 },
  ],
};

// ─── ATO: study and training loan, marginal years (2025-26 onwards) ──────────
// "From the 2025–26 income year, compulsory repayments are calculated using
// marginal rates." The top row of each table reverts to a flat rate on the whole
// repayment income.

type AtoLoanRow =
  | { from: number; to: number | null; kind: 'nil' }
  | { from: number; to: number | null; kind: 'marginal'; base: number; rate: number; over: number }
  | { from: number; to: number | null; kind: 'whole'; rate: number };

const ATO_LOAN_MARGINAL: Record<string, AtoLoanRow[]> = {
  '2025-2026': [
    { from: 0, to: 67000, kind: 'nil' },
    { from: 67001, to: 125000, kind: 'marginal', base: 0, rate: 0.15, over: 67000 },
    { from: 125001, to: 179285, kind: 'marginal', base: 8700, rate: 0.17, over: 125000 },
    { from: 179286, to: null, kind: 'whole', rate: 0.1 },
  ],
  '2026-2027': [
    { from: 0, to: 69528, kind: 'nil' },
    { from: 69529, to: 129717, kind: 'marginal', base: 0, rate: 0.15, over: 69528 },
    { from: 129718, to: 186050, kind: 'marginal', base: 9028, rate: 0.17, over: 129717 },
    { from: 186051, to: null, kind: 'whole', rate: 0.1 },
  ],
};

// ─── ATO: resident income tax scales ─────────────────────────────────────────
// Transcribed as "$base plus Nc for each $1 over `over`", the ATO's own form.

interface AtoTaxRow { min: number; max: number | null; base: number; rate: number; over: number }

const ATO_TAX_SCALES: Record<string, AtoTaxRow[]> = {
  '2020-2021': PRE_STAGE_3(),
  '2021-2022': PRE_STAGE_3(),
  '2022-2023': PRE_STAGE_3(),
  '2023-2024': PRE_STAGE_3(),
  '2024-2025': STAGE_3(),
  '2025-2026': STAGE_3(),
  '2026-2027': [
    { min: 0,      max: 18200,  base: 0,     rate: 0,    over: 0 },
    { min: 18201,  max: 45000,  base: 0,     rate: 0.15, over: 18200 },
    { min: 45001,  max: 135000, base: 4020,  rate: 0.30, over: 45000 },
    { min: 135001, max: 190000, base: 31020, rate: 0.37, over: 135000 },
    { min: 190001, max: null,   base: 51370, rate: 0.45, over: 190000 },
  ],
};

function PRE_STAGE_3(): AtoTaxRow[] {
  return [
    { min: 0,      max: 18200,  base: 0,     rate: 0,     over: 0 },
    { min: 18201,  max: 45000,  base: 0,     rate: 0.19,  over: 18200 },
    { min: 45001,  max: 120000, base: 5092,  rate: 0.325, over: 45000 },
    { min: 120001, max: 180000, base: 29467, rate: 0.37,  over: 120000 },
    { min: 180001, max: null,   base: 51667, rate: 0.45,  over: 180000 },
  ];
}

function STAGE_3(): AtoTaxRow[] {
  return [
    { min: 0,      max: 18200,  base: 0,     rate: 0,    over: 0 },
    { min: 18201,  max: 45000,  base: 0,     rate: 0.16, over: 18200 },
    { min: 45001,  max: 135000, base: 4288,  rate: 0.30, over: 45000 },
    { min: 135001, max: 190000, base: 31288, rate: 0.37, over: 135000 },
    { min: 190001, max: null,   base: 51638, rate: 0.45, over: 190000 },
  ];
}

// ─── ATO: Medicare levy thresholds, single with no dependants ────────────────
// "All other taxpayers" row of each year's table.

const ATO_MEDICARE: Record<string, { lower: number; upper: number }> = {
  '2020-2021': { lower: 23226, upper: 29032 },
  '2021-2022': { lower: 23365, upper: 29206 },
  '2022-2023': { lower: 24276, upper: 30345 },
  '2023-2024': { lower: 26000, upper: 32500 },
  '2024-2025': { lower: 27222, upper: 34027 },
  '2025-2026': { lower: 28011, upper: 35013 },
};

// ─────────────────────────────────────────────────────────────────────────────

describe('audit: study and training loan schedule matches the ATO tables', () => {
  const bandYears = Object.keys(ATO_LOAN_BANDS).sort();
  const marginalYears = Object.keys(ATO_LOAN_MARGINAL).sort();

  it.each(bandYears)('%s reproduces every ATO band, edge for edge', fy => {
    const loan = taxSettingsFor(fy)!.studentLoan;
    expect(loan.model).toBe('income-bands');
    if (loan.model !== 'income-bands') return;

    const ato = ATO_LOAN_BANDS[fy];
    expect(loan.bands).toHaveLength(ato.length);
    expect(loan.minThreshold).toBe(ato[0].from);
    loan.bands.forEach((band, i) => {
      expect({ from: band.from, to: band.to, rate: band.rate }).toEqual(ato[i]);
    });
  });

  // The boundary sweep: three probes per band — the dollar below it, its first
  // dollar, and its last. Under the whole-income model a single dollar can move
  // the rate applied to the ENTIRE income, so an edge that is out by one is a
  // real, visible error, and this is what catches it.
  it.each(bandYears)('%s charges the right rate on both sides of every band edge', fy => {
    const settings = taxSettingsFor(fy)!;
    const ato = ATO_LOAN_BANDS[fy];

    expect(studentLoanRepaymentFor(ato[0].from - 1, settings)).toBe(0);
    expect(studentLoanRepaymentFor(0, settings)).toBe(0);

    ato.forEach((row, i) => {
      expect(studentLoanRepaymentFor(row.from, settings)).toBe(round2(row.from * row.rate));
      if (row.to != null) {
        expect(studentLoanRepaymentFor(row.to, settings)).toBe(round2(row.to * row.rate));
        // One dollar past this band's ceiling is the NEXT band's rate.
        const next = ato[i + 1];
        expect(studentLoanRepaymentFor(row.to + 1, settings)).toBe(round2((row.to + 1) * next.rate));
      } else {
        expect(studentLoanRepaymentFor(row.from + 500_000, settings))
          .toBe(round2((row.from + 500_000) * row.rate));
      }
    });
  });

  it.each(marginalYears)('%s reproduces the ATO marginal table', fy => {
    const loan = taxSettingsFor(fy)!.studentLoan;
    expect(loan.model).toBe('marginal');
    if (loan.model !== 'marginal') return;

    const ato = ATO_LOAN_MARGINAL[fy];
    const nil = ato[0] as Extract<AtoLoanRow, { kind: 'nil' }>;
    expect(loan.minThreshold).toBe(nil.to);

    // One registry tier per ATO row, the "Nil" row aside — it is the threshold.
    expect(loan.tiers).toHaveLength(ato.length - 1);
    ato.slice(1).forEach((row, i) => {
      const tier = loan.tiers[i];
      // The registry's `from` is the exclusive edge the ATO words as "over $X"
      // (or, for the top row, the dollar below where it starts applying).
      expect(tier.to).toBe(row.to);
      if (row.kind === 'marginal') {
        expect(tier.from).toBe(row.over);
        expect(tier.rate).toBe(row.rate);
        expect(tier.base).toBe(row.base);
        expect(tier.wholeIncome).toBeFalsy();
      } else if (row.kind === 'whole') {
        expect(tier.from).toBe(row.from - 1);
        expect(tier.rate).toBe(row.rate);
        expect(tier.wholeIncome).toBe(true);
      } else {
        throw new Error('a Nil row can only be the first row of the table');
      }
    });
  });

  it.each(marginalYears)('%s applies the ATO formula on both sides of every edge', fy => {
    const settings = taxSettingsFor(fy)!;
    const ato = ATO_LOAN_MARGINAL[fy];
    const expected = (income: number) => {
      const row = [...ato].reverse().find(r => income >= r.from)!;
      if (row.kind === 'nil') return 0;
      if (row.kind === 'whole') return round2(income * row.rate);
      return round2(row.base + (income - row.over) * row.rate);
    };

    for (const row of ato) {
      for (const income of [row.from - 1, row.from, row.from + 1, row.to ?? row.from + 250_000]) {
        if (income < 0) continue;
        expect(studentLoanRepaymentFor(income, settings)).toBe(expected(income));
      }
    }
  });

  // The ATO's own worked examples, verbatim from the page. These are the only
  // figures on it that were computed rather than tabulated, so they check the
  // arithmetic and the table together.
  it('reproduces the ATO worked examples', () => {
    const y2627 = taxSettingsFor('2026-2027')!;
    // Christina: $86,380 repayment income, in the 15c tier.
    expect(studentLoanRepaymentFor(86_380, y2627)).toBe(2_527.80);
    // Barry: $137,064, in the "$9,028 plus 17c" tier.
    expect(studentLoanRepaymentFor(137_064, y2627)).toBe(10_276.99);
    // Priya: $254,780, above $179,286 — 10% of the whole repayment income.
    expect(studentLoanRepaymentFor(254_780, y2627)).toBe(25_478);
    // Branson: $99,736 in 2024-25, the 5.5% band. The ATO's page prints
    // $5,485.52 for this one, but 99,736 x 5.5% is $5,485.48 — a four-cent slip
    // in their worked example, not in their table. We follow the table.
    expect(studentLoanRepaymentFor(99_736, taxSettingsFor('2024-2025')!)).toBe(5_485.48);
  });

  it('has a loan schedule for every supported year', () => {
    const covered = new Set([...bandYears, ...marginalYears]);
    for (const fy of supportedTaxYears()) {
      // 2027-28 has no published table of its own; it carries 2026-27 forward
      // and says so, which is the one allowed gap.
      if (covered.has(fy)) continue;
      const settings = taxSettingsFor(fy)!;
      expect(settings.confidence).toBe('indexed-estimate');
      expect(settings.notes.join(' ')).toMatch(/loan thresholds for this year are not published/i);
    }
  });
});

describe('audit: resident income tax scales match the ATO tables', () => {
  const years = Object.keys(ATO_TAX_SCALES).sort();

  it.each(years)('%s reproduces the ATO scale', fy => {
    const { brackets } = taxSettingsFor(fy)!;
    const ato = ATO_TAX_SCALES[fy];
    expect(brackets).toHaveLength(ato.length);
    brackets.forEach((b, i) => {
      expect(b.from).toBe(ato[i].over);
      expect(b.to).toBe(ato[i].max);
      expect(b.base).toBe(ato[i].base);
      expect(b.rate).toBe(ato[i].rate);
    });
  });

  it.each(years)('%s charges the ATO amount at every bracket boundary', fy => {
    const settings = taxSettingsFor(fy)!;
    for (const row of ATO_TAX_SCALES[fy]) {
      // "$X plus Nc for each $1 over `over`" — so the first dollar IN the bracket
      // is `over + 1`, and it attracts exactly N cents.
      expect(incomeTaxFor(row.over, settings)).toBe(row.base);
      expect(incomeTaxFor(row.over + 1, settings)).toBe(round2(row.base + row.rate));
      if (row.max != null) {
        expect(incomeTaxFor(row.max, settings)).toBe(round2(row.base + (row.max - row.over) * row.rate));
      }
    }
  });

  it('2027-28 is the legislated 14c scale, flagged as unpublished', () => {
    const settings = taxSettingsFor('2027-2028')!;
    expect(settings.brackets[1].rate).toBe(0.14);
    expect(incomeTaxFor(45_000, settings)).toBe(3_752);
    expect(settings.confidence).toBe('indexed-estimate');
    expect(settings.notes.join(' ')).toMatch(/legislated but the ATO has not published/i);
  });
});

describe('audit: Medicare levy thresholds match the ATO tables', () => {
  const years = Object.keys(ATO_MEDICARE).sort();

  it.each(years)('%s uses the ATO single-taxpayer thresholds', fy => {
    const { medicare } = taxSettingsFor(fy)!;
    expect(medicare.lowerThreshold).toBe(ATO_MEDICARE[fy].lower);
    expect(medicare.upperThreshold).toBe(ATO_MEDICARE[fy].upper);
  });

  it.each(years)('%s pays nothing at the lower threshold and 2%% above the upper', fy => {
    const settings = taxSettingsFor(fy)!;
    const { lower, upper } = ATO_MEDICARE[fy];
    // "You don't have to pay the Medicare levy if your taxable income is EQUAL TO
    // or less than the lower threshold" — the threshold itself is still free.
    expect(medicareLevyFor(lower, settings)).toBe(0);
    expect(medicareLevyFor(lower + 1, settings)).toBe(0.1);
    expect(medicareLevyFor(upper, settings)).toBe(round2(0.1 * (upper - lower)));
    expect(medicareLevyFor(upper + 1, settings)).toBe(round2(0.02 * (upper + 1)));
    // The shade-in and the flat rate meet within a cent at the crossover.
    expect(Math.abs(medicareLevyFor(upper, settings) - 0.02 * upper)).toBeLessThanOrEqual(1);
  });

  it("reproduces the ATO's worked Medicare example", () => {
    // "Angie's taxable income is $29,000 … her Medicare levy will be reduced to
    // $98.90" (2025-26).
    expect(medicareLevyFor(29_000, taxSettingsFor('2025-2026')!)).toBe(98.90);
  });

  it('carries the last published thresholds into unpublished years, and says so', () => {
    for (const fy of ['2026-2027', '2027-2028']) {
      const settings = taxSettingsFor(fy)!;
      expect(settings.medicare.lowerThreshold).toBe(ATO_MEDICARE['2025-2026'].lower);
      expect(settings.notes.join(' ')).toMatch(/Medicare levy low-income thresholds for this year are not published/i);
    }
  });
});

describe('audit: the corrections this pass made', () => {
  // Each of these is a figure that was WRONG before the audit. They are pinned
  // individually so a future edit that reintroduces one fails by name.

  it('2020-21: the 8.5% band starts at $114,810, not $114,708', () => {
    const settings = taxSettingsFor('2020-2021')!;
    // $114,750 sat inside the (fabricated) 8.5% band; the ATO puts it in the 8%.
    expect(studentLoanRepaymentFor(114_750, settings)).toBe(round2(114_750 * 0.08));
    expect(studentLoanRepaymentFor(114_809, settings)).toBe(round2(114_809 * 0.08));
    expect(studentLoanRepaymentFor(114_810, settings)).toBe(round2(114_810 * 0.085));
  });

  it('2025-26: repayments above $179,285 are 10% of the whole income, not 17% of the excess', () => {
    const settings = taxSettingsFor('2025-2026')!;
    expect(studentLoanRepaymentFor(250_000, settings)).toBe(25_000);
    // Without the top row this was $8,700 + 17% of $125,000 = $29,950.
    expect(studentLoanRepaymentFor(250_000, settings)).toBeLessThan(29_950);
  });

  it('2026-27: uses its own published thresholds, not 2025-26 carried forward', () => {
    const settings = taxSettingsFor('2026-2027')!;
    expect(studentLoanRepaymentFor(68_000, settings)).toBe(0);       // under the 69,528 threshold
    expect(studentLoanRepaymentFor(69_528, settings)).toBe(0);
    expect(studentLoanRepaymentFor(70_528, settings)).toBe(150);     // 15c on $1,000
  });

  it('2025-26: the Medicare thresholds are the 2025-26 ones, not 2024-25', () => {
    const settings = taxSettingsFor('2025-2026')!;
    expect(settings.medicare.lowerThreshold).toBe(28_011);
    // $27,500 was levied under the old (carried-forward) threshold; it is free.
    expect(medicareLevyFor(27_500, settings)).toBe(0);
  });

  it('2025-26 is no longer flagged provisional — every one of its tables is published', () => {
    expect(taxSettingsFor('2025-2026')!.confidence).toBe('legislated');
  });
});

describe('audit: the two income bases stay apart', () => {
  it('assesses the loan on repayment income and the tax on taxable income', () => {
    // $95,000 taxable, $25,000 of salary-sacrificed super on top.
    const estimate = estimateTaxForFY('2026-2027', 95_000, {
      studentLoan: true,
      repaymentIncome: 120_000,
    })!;
    expect(estimate.taxableIncome).toBe(95_000);
    expect(estimate.repaymentIncome).toBe(120_000);
    expect(estimate.incomeTax).toBe(incomeTaxFor(95_000, taxSettingsFor('2026-2027')!));
    expect(estimate.medicareLevy).toBe(round2(0.02 * 95_000));
    // 15c on ($120,000 − $69,528) — assessed on the larger base.
    expect(estimate.studentLoanRepayment).toBe(round2(0.15 * (120_000 - 69_528)));
  });

  it('falls back to taxable income only when no repayment income is given', () => {
    const plain = estimateTaxForFY('2026-2027', 95_000, { studentLoan: true })!;
    expect(plain.repaymentIncome).toBe(95_000);
    expect(plain.studentLoanRepayment).toBe(round2(0.15 * (95_000 - 69_528)));
  });

  it('never lets repayment income touch the income tax or the levy', () => {
    const a = estimateTaxForFY('2025-2026', 60_000, { studentLoan: true, repaymentIncome: 200_000 })!;
    const b = estimateTaxForFY('2025-2026', 60_000, { studentLoan: true })!;
    expect(a.incomeTax).toBe(b.incomeTax);
    expect(a.medicareLevy).toBe(b.medicareLevy);
    expect(a.studentLoanRepayment).toBeGreaterThan(b.studentLoanRepayment);
  });
});
