/**
 * Repayment income — the loan's own income base.
 *
 * The point of these tests is the SEPARATION. Everything here can be summarised
 * as: taxable income goes in, a bigger number comes out, and the bigger number
 * is only ever used for the loan.
 */

import { describe, it, expect } from 'vitest';
import {
  repaymentIncomeFrom,
  normaliseRepaymentIncomeAdjustments,
  emptyRepaymentIncomeAdjustments,
  hasRepaymentIncomeAdjustments,
  REPAYMENT_INCOME_FIELDS,
} from './repaymentIncome';

const adj = (o: Partial<Record<string, number>> = {}) => ({
  ...emptyRepaymentIncomeAdjustments(),
  ...o,
} as ReturnType<typeof emptyRepaymentIncomeAdjustments>);

describe('repaymentIncomeFrom', () => {
  it('is taxable income when nothing has been supplied', () => {
    const r = repaymentIncomeFrom(85_000);
    expect(r.total).toBe(85_000);
    expect(r.adjustments).toBe(0);
    expect(r.unadjusted).toBe(true);
    expect(r.components).toEqual([{ key: 'taxableIncome', label: 'Taxable income', amount: 85_000 }]);
  });

  it('adds each of the ATO terms', () => {
    expect(repaymentIncomeFrom(85_000, adj({ reportableFringeBenefits: 5_400 })).total).toBe(90_400);
    expect(repaymentIncomeFrom(85_000, adj({ totalNetInvestmentLoss: 1_330 })).total).toBe(86_330);
    expect(repaymentIncomeFrom(85_000, adj({ reportableSuperContributions: 16_500 })).total).toBe(101_500);
    expect(repaymentIncomeFrom(85_000, adj({ exemptForeignEmploymentIncome: 2_680 })).total).toBe(87_680);
  });

  it("reproduces the ATO's own worked sum", () => {
    // "In the 2026-27 financial year, Christina has: taxable income of $60,470,
    // total reportable fringe benefits of $5,400, total net investment loss of
    // $1,330, reportable super contributions of $16,500, exempt foreign
    // employment income of $2,680 … repayment income is $86,380."
    // (The page's sum line misprints the first term as $60,720; $60,470 is the
    // figure that produces the $86,380 it then uses.)
    const r = repaymentIncomeFrom(60_470, adj({
      reportableFringeBenefits: 5_400,
      totalNetInvestmentLoss: 1_330,
      reportableSuperContributions: 16_500,
      exemptForeignEmploymentIncome: 2_680,
    }));
    expect(r.total).toBe(86_380);
    expect(r.adjustments).toBe(25_910);
    expect(r.unadjusted).toBe(false);
  });

  it('takes an FHSS release back OFF, the one term that subtracts', () => {
    const r = repaymentIncomeFrom(85_000, adj({ assessableFHSSReleased: 15_000 }));
    expect(r.total).toBe(70_000);
    expect(r.adjustments).toBe(-15_000);
    expect(r.components[1].amount).toBe(-15_000);
  });

  it('never returns a negative income, however the figures are entered', () => {
    expect(repaymentIncomeFrom(10_000, adj({ assessableFHSSReleased: 50_000 })).total).toBe(0);
    expect(repaymentIncomeFrom(-5_000).total).toBe(0);
  });

  it('itemises only what was supplied, in the ATO order', () => {
    const r = repaymentIncomeFrom(50_000, adj({
      reportableSuperContributions: 10_000,
      reportableFringeBenefits: 2_000,
    }));
    expect(r.components.map(c => c.key)).toEqual([
      'taxableIncome', 'reportableFringeBenefits', 'reportableSuperContributions',
    ]);
  });

  it('keeps cents exact', () => {
    const r = repaymentIncomeFrom(85_000.10, adj({ reportableSuperContributions: 0.25 }));
    expect(r.total).toBe(85_000.35);
  });

  it('covers every field the editor renders — a new term cannot be silently ignored', () => {
    for (const f of REPAYMENT_INCOME_FIELDS) {
      const r = repaymentIncomeFrom(50_000, adj({ [f.key]: 1_000 }));
      expect(r.total).toBe(50_000 + 1_000 * f.sign);
      expect(r.unadjusted).toBe(false);
    }
  });
});

describe('normalising what came out of storage', () => {
  it('reads a well-formed record', () => {
    const r = normaliseRepaymentIncomeAdjustments({ reportableFringeBenefits: 1_200 });
    expect(r.reportableFringeBenefits).toBe(1_200);
    expect(r.reportableSuperContributions).toBe(0);
  });

  it('degrades a corrupt record to zeros, never to a guess', () => {
    for (const bad of [null, undefined, 'nonsense', 42, { reportableFringeBenefits: 'lots' }]) {
      const r = normaliseRepaymentIncomeAdjustments(bad);
      expect(r).toEqual(emptyRepaymentIncomeAdjustments());
    }
  });

  it('rejects negative and non-finite amounts', () => {
    const r = normaliseRepaymentIncomeAdjustments({
      reportableFringeBenefits: -500,
      totalNetInvestmentLoss: NaN,
      reportableSuperContributions: Infinity,
    });
    expect(r).toEqual(emptyRepaymentIncomeAdjustments());
  });

  it('drops unknown keys', () => {
    const r = normaliseRepaymentIncomeAdjustments({ somethingElse: 9_999 }) as unknown as Record<string, number>;
    expect(r.somethingElse).toBeUndefined();
  });

  it('knows when a year has anything in it', () => {
    expect(hasRepaymentIncomeAdjustments(null)).toBe(false);
    expect(hasRepaymentIncomeAdjustments(emptyRepaymentIncomeAdjustments())).toBe(false);
    expect(hasRepaymentIncomeAdjustments(adj({ totalNetInvestmentLoss: 1 }))).toBe(true);
  });
});
