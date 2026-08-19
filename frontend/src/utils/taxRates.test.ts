/**
 * Per-FY Australian tax rates.
 *
 * Two kinds of test here, and the split matters:
 *
 *   • **Registry integrity** — invariants every year must satisfy (brackets
 *     contiguous, each `base` equal to the tax actually payable at that
 *     bracket's edge, HELP bands non-overlapping, Medicare shade-in meeting the
 *     flat rate). These run over EVERY year in the registry, so adding 2028-29
 *     with a typo fails here rather than quietly under-taxing someone.
 *   • **Known-figure checks** — specific incomes in specific years, against
 *     hand-worked ATO arithmetic. These pin the data itself.
 */

import { describe, it, expect } from 'vitest';
import {
  TAX_SETTINGS_BY_FY,
  supportedTaxYears,
  supportedTaxYearRange,
  taxSettingsFor,
  isTaxYearSupported,
  bracketFor,
  incomeTaxFor,
  medicareLevyFor,
  studentLoanRepaymentFor,
  estimateTaxForFY,
  displayBracketsFor,
} from './taxRates';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const years = supportedTaxYears();

describe('registry integrity — holds for every year, present and future', () => {
  it('has at least the years Ledger claims to support, sorted oldest first', () => {
    expect(years.length).toBeGreaterThan(0);
    expect([...years].sort()).toEqual(years);
    for (const fy of years) expect(fy).toMatch(/^\d{4}-\d{4}$/);
  });

  it('keys the registry by the same FY string each entry carries', () => {
    for (const [key, settings] of Object.entries(TAX_SETTINGS_BY_FY)) {
      expect(settings.fy).toBe(key);
    }
  });

  it('numbers each FY label as consecutive years', () => {
    for (const fy of years) {
      const [a, b] = fy.split('-').map(Number);
      expect(b).toBe(a + 1);
    }
  });

  it.each(years)('%s brackets are contiguous, ascending and open-ended at the top', fy => {
    const { brackets } = taxSettingsFor(fy)!;
    expect(brackets.length).toBeGreaterThan(1);
    expect(brackets[0].from).toBe(0);
    expect(brackets[brackets.length - 1].to).toBeNull();

    for (let i = 0; i < brackets.length - 1; i++) {
      // No gap and no overlap: one bracket's ceiling is the next one's floor.
      expect(brackets[i].to).toBe(brackets[i + 1].from);
      expect(brackets[i + 1].rate).toBeGreaterThan(brackets[i].rate);
    }
  });

  it.each(years)('%s bracket bases equal the tax actually payable at the bracket edge', fy => {
    const { brackets } = taxSettingsFor(fy)!;
    for (let i = 1; i < brackets.length; i++) {
      const prev = brackets[i - 1];
      const expected = round2(prev.base + (brackets[i].from - prev.from) * prev.rate);
      expect(brackets[i].base).toBe(expected);
    }
  });

  it.each(years)('%s income tax is continuous across every bracket edge', fy => {
    const settings = taxSettingsFor(fy)!;
    for (const b of settings.brackets.slice(1)) {
      // A dollar either side of an edge must differ by the marginal rate, not by
      // a step. (Allow a cent: the calculator rounds to cents, and 32.5c doesn't
      // land on one.)
      const below = incomeTaxFor(b.from, settings);
      const above = incomeTaxFor(b.from + 1, settings);
      expect(Math.abs(above - below - b.rate)).toBeLessThanOrEqual(0.01);
    }
  });

  it.each(years)('%s Medicare shade-in meets the flat rate at the upper threshold', fy => {
    const settings = taxSettingsFor(fy)!;
    const { lowerThreshold, upperThreshold, rate, shadeInRate } = settings.medicare;
    expect(upperThreshold).toBeGreaterThan(lowerThreshold);
    // The two formulas must agree at the crossover, or income just past the
    // upper threshold would jump or drop.
    const shaded = shadeInRate * (upperThreshold - lowerThreshold);
    expect(shaded).toBeCloseTo(rate * upperThreshold, 0);
  });

  it.each(years)('%s student-loan bands are non-overlapping with rising rates', fy => {
    const loan = taxSettingsFor(fy)!.studentLoan;
    if (loan.model === 'income-bands') {
      expect(loan.bands[0].from).toBe(loan.minThreshold);
      expect(loan.bands[loan.bands.length - 1].to).toBeNull();
      for (let i = 0; i < loan.bands.length - 1; i++) {
        expect(loan.bands[i].to).toBe(loan.bands[i + 1].from - 1);
        expect(loan.bands[i + 1].rate).toBeGreaterThan(loan.bands[i].rate);
      }
    } else {
      expect(loan.tiers[0].from).toBe(loan.minThreshold);
      expect(loan.tiers[0].base).toBe(0);
      expect(loan.tiers[loan.tiers.length - 1].to).toBeNull();
      // Rates rise across the marginal tiers. The final "10% of the whole income"
      // row is excluded — its rate is not comparable, because it is charged on a
      // different quantity. Continuity is what proves it lines up, below.
      const marginal = loan.tiers.filter(t => !t.wholeIncome);
      for (let i = 1; i < marginal.length; i++) {
        expect(marginal[i].rate).toBeGreaterThan(marginal[i - 1].rate);
      }
      for (let i = 1; i < loan.tiers.length; i++) {
        const prev = loan.tiers[i - 1];
        const tier = loan.tiers[i];
        expect(prev.to).toBe(tier.from);
        // The ATO states each base as whole dollars ($9,028 where the arithmetic
        // gives $9,028.35), so allow a dollar — enough to catch a transposed
        // figure, tight enough that a wrong threshold still fails.
        if (!tier.wholeIncome) {
          const exact = prev.base + (tier.from - prev.from) * prev.rate;
          expect(Math.abs(tier.base - exact)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it.each(years)('%s student-loan repayment is continuous at every threshold', fy => {
    const settings = taxSettingsFor(fy)!;
    const loan = settings.studentLoan;
    // Nothing at the minimum threshold under the marginal model, and a step of
    // at most 1% of income under the old whole-income bands (which really did
    // jump — 1% of the whole income the moment you crossed). Either way, the
    // TOP of the marginal schedule must not jump: the "10% of the whole income"
    // row is designed to meet the tier below it, so a wrong top threshold shows
    // up here as a cliff.
    if (loan.model === 'marginal') {
      expect(studentLoanRepaymentFor(loan.minThreshold, settings)).toBe(0);
      for (const tier of loan.tiers.slice(1)) {
        const below = studentLoanRepaymentFor(tier.from, settings);
        const above = studentLoanRepaymentFor(tier.from + 1, settings);
        expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
      }
    } else {
      expect(studentLoanRepaymentFor(loan.minThreshold - 1, settings)).toBe(0);
      expect(studentLoanRepaymentFor(loan.minThreshold, settings)).toBeCloseTo(loan.minThreshold * 0.01, 2);
    }
  });

  it.each(years)('%s never returns a negative amount for any of the three components', fy => {
    const settings = taxSettingsFor(fy)!;
    for (const income of [0, 1, 18_200, 30_000, 67_000, 150_000, 500_000]) {
      expect(incomeTaxFor(income, settings)).toBeGreaterThanOrEqual(0);
      expect(medicareLevyFor(income, settings)).toBeGreaterThanOrEqual(0);
      expect(studentLoanRepaymentFor(income, settings)).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(years)('%s tax rises monotonically with income', fy => {
    const settings = taxSettingsFor(fy)!;
    let prev = -1;
    for (let income = 0; income <= 250_000; income += 2_500) {
      const tax = incomeTaxFor(income, settings) + medicareLevyFor(income, settings);
      expect(tax).toBeGreaterThanOrEqual(prev);
      prev = tax;
    }
  });

  it('marks any year with unpublished indexed thresholds, and explains why', () => {
    for (const fy of years) {
      const s = taxSettingsFor(fy)!;
      // A provisional year must say so. A settled year MAY still carry a note —
      // 2025-26 is fully published but the repayment model changed under it, and
      // that is worth telling the user.
      if (s.confidence === 'indexed-estimate') expect(s.notes.length).toBeGreaterThan(0);
      for (const note of s.notes) expect(note.trim().length).toBeGreaterThan(0);
      expect(new Set(s.notes).size).toBe(s.notes.length);
    }
  });
});

describe('looking a year up', () => {
  it('returns the settings for a supported year', () => {
    expect(taxSettingsFor('2024-2025')?.fy).toBe('2024-2025');
    expect(isTaxYearSupported('2024-2025')).toBe(true);
  });

  it('tolerates stray whitespace around the key', () => {
    expect(taxSettingsFor('  2024-2025 ')?.fy).toBe('2024-2025');
  });

  it('returns null for a year Ledger has no rates for — it never borrows another', () => {
    for (const fy of ['2015-2016', '2019-2020', '2099-2100', 'not-a-year', '', null, undefined]) {
      expect(taxSettingsFor(fy)).toBeNull();
      expect(isTaxYearSupported(fy)).toBe(false);
    }
  });

  it('reports the supported range so the UI can say what it does hold', () => {
    const range = supportedTaxYearRange()!;
    expect(range.earliest).toBe(years[0]);
    expect(range.latest).toBe(years[years.length - 1]);
  });
});

describe('income tax — bracket boundaries', () => {
  it('charges nothing up to and including the tax-free threshold (2024-25)', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(incomeTaxFor(0, s)).toBe(0);
    expect(incomeTaxFor(18_199, s)).toBe(0);
    expect(incomeTaxFor(18_200, s)).toBe(0);
  });

  it('charges the first cent only above the threshold (2024-25)', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(incomeTaxFor(18_201, s)).toBe(0.16);
  });

  it('lands exactly on the published figure at each 2024-25 edge', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(incomeTaxFor(45_000, s)).toBe(4_288);
    expect(incomeTaxFor(135_000, s)).toBe(31_288);
    expect(incomeTaxFor(190_000, s)).toBe(51_638);
    expect(incomeTaxFor(190_001, s)).toBe(51_638.45);
  });

  it('lands exactly on the published figure at each pre-Stage-3 edge (2023-24)', () => {
    const s = taxSettingsFor('2023-2024')!;
    expect(incomeTaxFor(45_000, s)).toBe(5_092);
    expect(incomeTaxFor(120_000, s)).toBe(29_467);
    expect(incomeTaxFor(180_000, s)).toBe(51_667);
  });

  it('treats negative income as zero rather than producing a negative tax', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(incomeTaxFor(-5_000, s)).toBe(0);
  });

  it('picks the bracket containing the income', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(bracketFor(0, s).rate).toBe(0);
    expect(bracketFor(18_200, s).rate).toBe(0);
    expect(bracketFor(18_201, s).rate).toBe(0.16);
    expect(bracketFor(45_001, s).rate).toBe(0.30);
    expect(bracketFor(1_000_000, s).rate).toBe(0.45);
  });
});

describe('switching financial year changes the answer', () => {
  it('taxes the same $85,000 differently in 2023-24 and 2024-25', () => {
    // 2023-24: 5,092 + 40,000 × 32.5%.  2024-25: 4,288 + 40,000 × 30%.
    expect(incomeTaxFor(85_000, taxSettingsFor('2023-2024')!)).toBe(18_092);
    expect(incomeTaxFor(85_000, taxSettingsFor('2024-2025')!)).toBe(16_288);
  });

  it('applies the legislated 15% bottom rate from 2026-27', () => {
    expect(incomeTaxFor(85_000, taxSettingsFor('2026-2027')!)).toBe(16_020);
    expect(incomeTaxFor(40_000, taxSettingsFor('2026-2027')!)).toBe(round2(21_800 * 0.15));
  });

  it('applies the legislated 14% bottom rate from 2027-28', () => {
    expect(incomeTaxFor(45_000, taxSettingsFor('2027-2028')!)).toBe(3_752);
  });

  it('carries the whole estimate, not just income tax, across the switch', () => {
    const a = estimateTaxForFY('2023-2024', 85_000)!;
    const b = estimateTaxForFY('2024-2025', 85_000)!;
    expect(a.total).toBe(19_792);   // 18,092 + 1,700 Medicare
    expect(b.total).toBe(17_988);   // 16,288 + 1,700 Medicare
    expect(a.total).not.toBe(b.total);
  });
});

describe('Medicare levy', () => {
  const s = () => taxSettingsFor('2024-2025')!;   // lower 27,222 / upper 34,027

  it('charges nothing at or below the low-income threshold', () => {
    expect(medicareLevyFor(0, s())).toBe(0);
    expect(medicareLevyFor(27_221, s())).toBe(0);
    expect(medicareLevyFor(27_222, s())).toBe(0);
  });

  it('shades in at 10c per dollar just above the threshold', () => {
    // The reason the shade-in exists: one dollar over must not cost $544.
    expect(medicareLevyFor(27_223, s())).toBe(0.1);
    expect(medicareLevyFor(30_000, s())).toBe(277.8);
  });

  it('reaches the full 2% by the upper threshold', () => {
    const levy = medicareLevyFor(34_027, s());
    expect(levy).toBeCloseTo(0.02 * 34_027, 0);
  });

  it('charges a flat 2% of the whole income above the upper threshold', () => {
    expect(medicareLevyFor(34_028, s())).toBe(680.56);
    expect(medicareLevyFor(85_000, s())).toBe(1_700);
  });

  it('uses each year’s own threshold, not a fixed one', () => {
    // $26,500 is above 2023-24's threshold but below 2024-25's.
    expect(medicareLevyFor(26_500, taxSettingsFor('2023-2024')!)).toBe(50);
    expect(medicareLevyFor(26_500, taxSettingsFor('2024-2025')!)).toBe(0);
  });

  it('is included in the estimate total', () => {
    const e = estimateTaxForFY('2024-2025', 85_000)!;
    expect(e.medicareLevy).toBe(1_700);
    expect(e.total).toBe(round2(e.incomeTax + e.medicareLevy + e.studentLoanRepayment));
  });
});

describe('HECS/HELP', () => {
  it('charges nothing below the repayment threshold', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(studentLoanRepaymentFor(54_434, s)).toBe(0);
    expect(studentLoanRepaymentFor(0, s)).toBe(0);
  });

  it('charges a flat percentage of the WHOLE income under the pre-2025-26 bands', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(studentLoanRepaymentFor(54_435, s)).toBe(544.35);       // 1%
    expect(studentLoanRepaymentFor(85_000, s)).toBe(3_825);        // 4.5%
    expect(studentLoanRepaymentFor(200_000, s)).toBe(20_000);      // top band, 10%
  });

  it('does not stop at 6% for high earners the way the old hard-coded table did', () => {
    const s = taxSettingsFor('2024-2025')!;
    expect(studentLoanRepaymentFor(160_000, s)).toBe(16_000);
    expect(studentLoanRepaymentFor(160_000, s)).toBeGreaterThan(160_000 * 0.06);
  });

  it('charges marginally on income above $67,000 from 2025-26', () => {
    const s = taxSettingsFor('2025-2026')!;
    expect(studentLoanRepaymentFor(66_999, s)).toBe(0);
    expect(studentLoanRepaymentFor(67_000, s)).toBe(0);
    expect(studentLoanRepaymentFor(85_000, s)).toBe(2_700);        // 18,000 × 15%
    expect(studentLoanRepaymentFor(125_000, s)).toBe(8_700);
    expect(studentLoanRepaymentFor(150_000, s)).toBe(round2(8_700 + 25_000 * 0.17));
  });

  it('makes the same income cheaper under the marginal model than the band model', () => {
    // The whole point of the 2025-26 change — a real, testable difference.
    const bands = studentLoanRepaymentFor(85_000, taxSettingsFor('2024-2025')!);
    const marginal = studentLoanRepaymentFor(85_000, taxSettingsFor('2025-2026')!);
    expect(marginal).toBeLessThan(bands);
  });

  it('is only added to the estimate when the user says they have a debt', () => {
    const without = estimateTaxForFY('2024-2025', 85_000)!;
    const withDebt = estimateTaxForFY('2024-2025', 85_000, { studentLoan: true })!;
    expect(without.studentLoanRepayment).toBe(0);
    expect(withDebt.studentLoanRepayment).toBe(3_825);
    expect(withDebt.total).toBe(round2(without.total + 3_825));
  });

  it('integrates with brackets and Medicare in one total', () => {
    const e = estimateTaxForFY('2024-2025', 85_000, { studentLoan: true })!;
    expect(e.incomeTax).toBe(16_288);
    expect(e.medicareLevy).toBe(1_700);
    expect(e.studentLoanRepayment).toBe(3_825);
    expect(e.total).toBe(21_813);
  });
});

describe('unsupported years', () => {
  it('produces no estimate at all rather than one from a neighbouring year', () => {
    expect(estimateTaxForFY('2019-2020', 85_000)).toBeNull();
    expect(estimateTaxForFY('2019-2020', 85_000, { studentLoan: true })).toBeNull();
    expect(estimateTaxForFY('2099-2100', 85_000)).toBeNull();
  });

  it('returns an empty bracket table so the UI has nothing to render', () => {
    expect(displayBracketsFor('2019-2020')).toEqual([]);
    expect(displayBracketsFor('2024-2025').length).toBeGreaterThan(0);
  });

  it('does not fall back to the nearest supported year', () => {
    // 2019-20 sits one year before the earliest supported year. If any fallback
    // ever creeps in, this is where it shows up.
    const earliest = supportedTaxYearRange()!.earliest;
    const [start] = earliest.split('-').map(Number);
    expect(estimateTaxForFY(`${start - 1}-${start}`, 85_000)).toBeNull();
  });
});

describe('display bracket table', () => {
  it('reads back in ATO form — inclusive bounds, top bracket open', () => {
    const rows = displayBracketsFor('2024-2025');
    expect(rows[0]).toEqual({ min: 0, max: 18_200, rate: 0 });
    expect(rows[1]).toEqual({ min: 18_201, max: 45_000, rate: 0.16 });
    expect(rows[rows.length - 1]).toEqual({ min: 190_001, max: null, rate: 0.45 });
  });

  it('shows the selected year’s own scale', () => {
    expect(displayBracketsFor('2023-2024')[1]).toEqual({ min: 18_201, max: 45_000, rate: 0.19 });
    expect(displayBracketsFor('2026-2027')[1]).toEqual({ min: 18_201, max: 45_000, rate: 0.15 });
  });

  it('covers the income line without gaps', () => {
    for (const fy of years) {
      const rows = displayBracketsFor(fy);
      for (let i = 0; i < rows.length - 1; i++) {
        expect(rows[i + 1].min).toBe((rows[i].max ?? 0) + 1);
      }
    }
  });
});
