/**
 * The foreign income tax offset. The thing under test is the difference between
 * an OFFSET and a CREDIT — the difference Ledger used to miss entirely.
 */
import { describe, it, expect } from 'vitest';
import {
  buildForeignTaxOffset,
  emptyForeignTaxOffset,
  FITO_NO_CALCULATION_LIMIT,
} from './foreignIncomeTax';

/** A flat 30% "Australian tax", so the limit is arithmetic anyone can check. */
const flat30 = (income: number) => income * 0.3;

describe('no foreign tax at all', () => {
  it('answers nothing, and says nothing', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 0, foreignIncome: 0, taxableIncome: 90_000, taxOn: flat30,
    });
    expect(f.offset).toBe(0);
    expect(f.limit).toBe(0);
    expect(f.assumptions).toEqual([]);
    expect(f).toEqual({ ...emptyForeignTaxOffset() });
  });

  it('keeps the foreign income visible even when no tax was taken', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 0, foreignIncome: 5_000, taxableIncome: 90_000, taxOn: flat30,
    });
    expect(f.foreignIncome).toBe(5_000);
    expect(f.offset).toBe(0);
  });
});

describe('the $1,000 no-calculation limit', () => {
  it('claims a small amount in full without working anything out', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 79.41, foreignIncome: 450, taxableIncome: 90_000, taxOn: flat30,
    });
    expect(f.offset).toBe(79.41);
    expect(f.underNoCalculationLimit).toBe(true);
    expect(f.limit).toBe(FITO_NO_CALCULATION_LIMIT);
    expect(f.unclaimable).toBe(0);
    // The comparison was never run, so it is not reported as though it had been.
    expect(f.taxWithForeignIncome).toBeNull();
    expect(f.taxWithoutForeignIncome).toBeNull();
  });

  it('is a floor, not a threshold — exactly $1,000 is still claimed in full', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 1_000, foreignIncome: 1_200, taxableIncome: 20_000, taxOn: flat30,
    });
    expect(f.offset).toBe(1_000);
    expect(f.underNoCalculationLimit).toBe(true);
  });

  it('holds the limit at $1,000 even when the foreign income attracted less tax', () => {
    // $1,000 of foreign income at a flat 30% attracts $300 of Australian tax,
    // but the floor is the floor: $1,000 may still be claimed.
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 1_400, foreignIncome: 1_000, taxableIncome: 25_000, taxOn: flat30,
    });
    expect(f.limit).toBe(1_000);
    expect(f.offset).toBe(1_000);
    expect(f.unclaimable).toBe(400);
  });
});

describe('the limit above $1,000 — the tax the foreign income actually attracted', () => {
  it('is the difference between the tax with the income and the tax without it', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 20_000, foreignIncome: 40_000, taxableIncome: 100_000, taxOn: flat30,
    });
    expect(f.taxWithForeignIncome).toBe(30_000);
    expect(f.taxWithoutForeignIncome).toBe(18_000);
    expect(f.limit).toBe(12_000);
    expect(f.offset).toBe(12_000);
    expect(f.unclaimable).toBe(8_000);
    expect(f.underNoCalculationLimit).toBe(false);
  });

  it('claims the foreign tax itself when it is under the limit', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 5_000, foreignIncome: 40_000, taxableIncome: 100_000, taxOn: flat30,
    });
    expect(f.limit).toBe(12_000);
    expect(f.offset).toBe(5_000);
    expect(f.unclaimable).toBe(0);
  });

  it('never loses a cent — what is claimed plus what is lost is what was paid', () => {
    for (const paid of [1_001, 4_321.55, 12_000, 99_999.99]) {
      const f = buildForeignTaxOffset({
        foreignTaxPaid: paid, foreignIncome: 40_000, taxableIncome: 100_000, taxOn: flat30,
      });
      expect(Math.round((f.offset + f.unclaimable) * 100) / 100).toBe(paid);
    }
  });

  it('falls back to the floor when there is no foreign income to take out', () => {
    // Foreign tax recorded against no foreign income: the comparison has nothing
    // to remove, so the difference is zero and only the floor survives.
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 3_000, foreignIncome: 0, taxableIncome: 100_000, taxOn: flat30,
    });
    expect(f.limit).toBe(1_000);
    expect(f.offset).toBe(1_000);
    expect(f.assumptions.join(' ')).toContain('No foreign income was recorded');
  });

  it('never goes negative when the foreign income exceeds taxable income', () => {
    // Deductions can leave taxable income below the gross foreign income. The
    // "without" figure floors at zero rather than producing negative tax.
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 9_000, foreignIncome: 50_000, taxableIncome: 20_000, taxOn: flat30,
    });
    expect(f.taxWithoutForeignIncome).toBe(0);
    expect(f.limit).toBe(6_000);
    expect(f.offset).toBe(6_000);
  });
});

describe('what it refuses to pretend', () => {
  it('says the deductions it did not take out, rather than hiding the effect', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 20_000, foreignIncome: 40_000, taxableIncome: 100_000, taxOn: flat30,
    });
    const said = f.assumptions.join(' ');
    expect(said).toContain('Deductions that relate to the foreign income are not taken out');
    // And it names the direction it errs in, which is towards allowing a claim.
    expect(said).toContain('the most you could be entitled to');
  });

  it('offers only the floor when the year has no tax rates', () => {
    const f = buildForeignTaxOffset({
      foreignTaxPaid: 20_000, foreignIncome: 40_000, taxableIncome: 100_000, taxOn: null,
    });
    expect(f.limit).toBe(1_000);
    expect(f.offset).toBe(1_000);
    expect(f.unclaimable).toBe(19_000);
    expect(f.assumptions.join(' ')).toContain('no tax rates for this year');
  });

  it('reads a negative or nonsense figure as nothing paid', () => {
    for (const bad of [-500, NaN, Infinity, undefined as unknown as number]) {
      const f = buildForeignTaxOffset({
        foreignTaxPaid: bad, foreignIncome: 40_000, taxableIncome: 100_000, taxOn: flat30,
      });
      expect(f.offset).toBe(0);
    }
  });
});
