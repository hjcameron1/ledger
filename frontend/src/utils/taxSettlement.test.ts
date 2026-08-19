/**
 * Phase 5.2 — estimated refund or amount owing.
 *
 * The engine is one subtraction, so these tests are mostly about the two things
 * that make it wrong in practice: what counts as "already paid", and when the
 * answer must be refused rather than guessed.
 *
 * Liabilities are NOT stubbed. Every case runs the real rate engine
 * (utils/taxRates.ts) for a real financial year, so a case like "$95,000 in
 * 2024-25 costs $21,188" is checking the whole chain, and the hand-worked
 * figures in the comments can be re-derived from the ATO's own table.
 */
import { describe, it, expect } from 'vitest';
import type { Transaction, IncomeEntry } from '../types';
import type { PayslipCore } from './payroll';
import type { ManualDeduction } from './taxDeductions';
import { buildTaxYearPosition } from './taxYear';
import { estimateTaxForFY } from './taxRates';
import { grossUpFor, emptyTaxCredits, type TaxCredits } from './taxCredits';
import { buildOffsetPosition } from './taxOffsets';
import { emptyTaxProfile, type TaxProfile } from './taxProfile';
import { emptyRepaymentIncomeAdjustments, type RepaymentIncomeAdjustments } from './repaymentIncome';
import {
  buildTaxSettlement,
  settlementHeadline,
  type SettlementComponent,
  type SettlementTaxInput,
  type TaxSettlement,
} from './taxSettlement';

let seq = 0;

function payslip(p: Partial<PayslipCore> & { gross_pay: number }): PayslipCore {
  seq += 1;
  return {
    id: p.id ?? `p${seq}`,
    employer: 'Acme Pty Ltd', employment_type: 'full_time', pay_frequency: 'fortnightly',
    payment_date: '2024-09-01', net_pay: p.gross_pay * 0.7,
    tax_withheld: 0, super_amount: 0, ...p,
  };
}

function income(p: Partial<IncomeEntry> & { amount: number }): IncomeEntry {
  seq += 1;
  return {
    id: p.id ?? `i${seq}`, source: 'Acme Pty Ltd', currency: 'AUD', category: 'Salary',
    is_recurring: false, date: '2024-09-01', status: 'approved', ...p,
  };
}

function tx(p: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: p.id ?? `t${seq}`, user_id: 'u1', account_id: 'acc', account_type: 'bank',
    date: '2024-09-01', merchant: 'Client', currency: 'AUD', category: 'Uncategorised',
    is_duplicate_flagged: false, is_subscription: false, ...p,
  } as Transaction;
}

function md(p: Partial<ManualDeduction> & { amount: number }): ManualDeduction {
  seq += 1;
  return { id: p.id ?? `d${seq}`, name: 'Manual', category: 'Working from home', date: '2024-09-01', ...p };
}

/**
 * The whole page in one call: position → rate engine → offsets → settlement,
 * wired exactly as pages/Tax.tsx wires them (including the franking gross-up,
 * which the page applies to the income the estimate runs on, and the offset
 * position, which the page always supplies).
 *
 * Because the offsets are always built, LITO is in every one of these results
 * whenever the income is low enough to attract it — the same as the real page.
 */
function settle(input: {
  fy?: string;
  payslips?: PayslipCore[];
  incomeEntries?: IncomeEntry[];
  transactions?: Transaction[];
  manualDeductions?: ManualDeduction[];
  credits?: Partial<TaxCredits>;
  profile?: Partial<TaxProfile>;
  adjustments?: Partial<RepaymentIncomeAdjustments>;
  studentLoan?: boolean;
  taxFreeThresholdClaims?: number;
  asOf?: string;
}): TaxSettlement {
  const fy = input.fy ?? '2024-2025';
  const position = buildTaxYearPosition({
    fy,
    transactions: input.transactions ?? [],
    manualDeductions: input.manualDeductions ?? [],
    incomeEntries: input.incomeEntries ?? [],
    payslips: input.payslips ?? [],
  });
  const credits: TaxCredits = { ...emptyTaxCredits(), ...input.credits };
  const taxable = Math.max(
    0,
    position.assessableIncome + grossUpFor(credits) - position.deductibleExpenses,
  );
  const est = estimateTaxForFY(fy, taxable, {
    studentLoan: input.studentLoan,
    repaymentIncome: taxable,
  });
  const tax: SettlementTaxInput = est
    ? {
        ratesAvailable: true,
        taxableIncome: est.taxableIncome,
        incomeTax: est.incomeTax,
        medicareLevy: est.medicareLevy,
        studentLoanRepayment: est.studentLoanRepayment,
        confidence: est.confidence,
        notes: est.notes,
      }
    : {
        ratesAvailable: false, taxableIncome: taxable, incomeTax: null,
        medicareLevy: null, studentLoanRepayment: null, confidence: null, notes: [],
      };
  const offsets = buildOffsetPosition({
    fy,
    taxableIncome: tax.taxableIncome,
    incomeTax: tax.incomeTax,
    adjustments: { ...emptyRepaymentIncomeAdjustments(), ...input.adjustments },
    profile: { ...emptyTaxProfile(), ...input.profile },
  });
  return buildTaxSettlement({
    position,
    tax,
    credits,
    offsets,
    taxFreeThresholdClaims: input.taxFreeThresholdClaims,
    asOf: input.asOf,
  });
}

const kinds = (s: TaxSettlement) => s.warnings.map(w => w.kind);
const component = (list: SettlementComponent[], key: string) => list.find(c => c.key === key);

// $95,000 taxable in 2024-25, from the ATO's own scale:
//   income tax  4,288 + (95,000 − 45,000) × 30c = 19,288
//   Medicare    2% × 95,000                     =  1,900
//                                                 ───────
//                                                  21,188
const LIABILITY_95K = 21_188;

// ─── The subtraction ─────────────────────────────────────────────────────────

describe('liability against what has been paid', () => {
  it('over-withholding is a refund', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });

    expect(s.liability.total).toBe(LIABILITY_95K);
    expect(s.credits.total).toBe(24_000);
    expect(s.net).toBe(-2_812);
    expect(s.outcome).toBe('refund');
    expect(s.refund).toBe(2_812);
    expect(s.owing).toBe(0);
  });

  it('under-withholding is a bill', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 15_000 })] });

    expect(s.net).toBe(6_188);
    expect(s.outcome).toBe('owing');
    expect(s.owing).toBe(6_188);
    expect(s.refund).toBe(0);
  });

  it('withholding the exact liability is square, not a $0 refund', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: LIABILITY_95K })] });

    expect(s.net).toBe(0);
    expect(s.outcome).toBe('square');
    expect(s.refund).toBe(0);
    expect(s.owing).toBe(0);
  });

  it('reports the liability by component, and the effective rate on taxable income', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });

    expect(component(s.liability.components, 'income-tax')!.amount).toBe(19_288);
    expect(component(s.liability.components, 'medicare-levy')!.amount).toBe(1_900);
    // No loan, so no loan line at all — not a zero row.
    expect(component(s.liability.components, 'study-loan')).toBeUndefined();
    expect(s.effectiveTaxRate).toBeCloseTo(22.3, 1);
  });

  it('a zero Medicare levy is shown as a result, not omitted', () => {
    // $26,000 in 2024-25 sits under the 27,222 low-income threshold, so the levy
    // is nil and the whole liability is the 16c bracket: (26,000 − 18,200) × 16c.
    const s = settle({ payslips: [payslip({ gross_pay: 26_000, tax_withheld: 2_000 })] });

    const levy = component(s.liability.components, 'medicare-levy')!;
    expect(levy.amount).toBe(0);
    expect(levy.detail).toMatch(/low-income threshold/i);
    expect(s.liability.total).toBe(1_248);
    // LITO is the full $700 at this income and there is $1,248 of income tax to
    // set it against, so the year really costs $548 and the refund is what is
    // left of the $2,000 withheld.
    expect(s.offsets.total).toBe(700);
    expect(s.netLiability).toBe(548);
    expect(s.refund).toBe(1_452);
  });

  it('no income at all is square, with nothing owing', () => {
    const s = settle({});
    expect(s.liability.total).toBe(0);
    expect(s.credits.total).toBe(0);
    expect(s.outcome).toBe('square');
    expect(s.effectiveTaxRate).toBe(0);
  });
});

// ─── Multiple employers ──────────────────────────────────────────────────────

describe('multiple employers', () => {
  const twoJobs = [
    payslip({ employer: 'Acme Pty Ltd', gross_pay: 60_000, tax_withheld: 12_000 }),
    payslip({ employer: 'Beta Cafe', gross_pay: 35_000, tax_withheld: 4_000 }),
  ];

  it('adds both jobs into one liability and one credit', () => {
    const s = settle({ payslips: twoJobs });

    expect(s.paygWithheld).toBe(16_000);
    expect(s.liability.total).toBe(LIABILITY_95K);
    expect(s.owing).toBe(5_188);
  });

  it('drills down to each employer, largest withholder first', () => {
    const s = settle({ payslips: twoJobs });

    expect(s.withholdingSources.map(w => w.label)).toEqual(['Acme Pty Ltd', 'Beta Cafe']);
    expect(s.withholdingSources[0]).toMatchObject({ kind: 'payslip', income: 60_000, withheld: 12_000 });
    expect(s.withholdingSources[0].effectiveRate).toBe(20);
    expect(s.withholdingSources[1].effectiveRate).toBeCloseTo(11.43, 2);
  });

  it('two employers both claiming the tax-free threshold is called out', () => {
    const s = settle({ payslips: twoJobs, taxFreeThresholdClaims: 2 });
    expect(kinds(s)).toContain('multiple-tax-free-thresholds');
    expect(s.warnings.find(w => w.kind === 'multiple-tax-free-thresholds')!.count).toBe(2);
  });

  it('one claim across two jobs is correct, so nothing is said', () => {
    const s = settle({ payslips: twoJobs, taxFreeThresholdClaims: 1 });
    expect(kinds(s)).not.toContain('multiple-tax-free-thresholds');
  });

  it('the same employer spelled two ways is one source, not two', () => {
    const s = settle({
      payslips: [
        payslip({ employer: 'Acme Pty Ltd', gross_pay: 50_000, tax_withheld: 9_000, payment_date: '2024-08-01' }),
        payslip({ employer: 'ACME', gross_pay: 45_000, tax_withheld: 7_000, payment_date: '2024-09-01' }),
      ],
    });

    expect(s.withholdingSources).toHaveLength(1);
    expect(s.paygWithheld).toBe(16_000);
  });
});

// ─── Missing withholding ─────────────────────────────────────────────────────

describe('income with no tax withheld', () => {
  it('names the sources that withheld nothing and totals them', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 80_000, tax_withheld: 18_000 })],
      incomeEntries: [income({ id: 'div', source: 'CBA', category: 'Dividends', amount: 4_000 })],
    });

    const w = s.warnings.find(x => x.kind === 'income-without-withholding')!;
    expect(w.count).toBe(1);
    expect(w.amount).toBe(4_000);
    expect(s.unwithheldIncome).toBe(4_000);
  });

  it('escalates when NOTHING has been paid against a year with income', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 0 })] });

    const w = s.warnings.find(x => x.kind === 'nothing-withheld')!;
    expect(w.severity).toBe('warn');
    expect(w.amount).toBe(95_000);
    expect(s.owing).toBe(LIABILITY_95K);
    // The softer note would be redundant next to the hard one.
    expect(kinds(s)).not.toContain('income-without-withholding');
  });

  it('a credit paid outside PAYG stops the "nothing withheld" alarm', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 0 })],
      credits: { paygInstalments: 20_000 },
    });

    expect(kinds(s)).not.toContain('nothing-withheld');
    expect(s.credits.total).toBe(20_000);
    expect(s.owing).toBe(1_188);
  });

  it('excluded income is not counted as unwithheld — it is not counted at all', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 80_000, tax_withheld: 18_000 })],
      incomeEntries: [income({ id: 'p1', amount: 5_000, status: 'pending' })],
    });

    expect(s.unwithheldIncome).toBe(0);
    expect(s.withholdingSources.map(w => w.label)).toEqual(['Acme Pty Ltd']);
    expect(kinds(s)).toContain('pending-income');
    expect(s.warnings.find(w => w.kind === 'pending-income')!.amount).toBe(5_000);
  });

  it('business income keeps its transaction, so the row can open its source', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 80_000, tax_withheld: 18_000 })],
      transactions: [tx({ id: 'biz-1', amount: 6_000, transaction_type: 'income', entity: 'business' })],
    });

    const biz = s.withholdingSources.find(w => w.kind === 'transaction')!;
    expect(biz.transactionId).toBe('biz-1');
    expect(biz.withheld).toBe(0);
    expect(s.unwithheldIncome).toBe(6_000);
  });
});

// ─── Study and training loan ─────────────────────────────────────────────────

describe('a study loan on top', () => {
  it('adds its own liability line and can turn a refund into a bill', () => {
    const without = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    const withLoan = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      studentLoan: true,
    });

    expect(without.outcome).toBe('refund');
    // 2024-25 charges 5.5% of the WHOLE repayment income in the 94,504 band.
    expect(component(withLoan.liability.components, 'study-loan')!.amount).toBe(5_225);
    expect(withLoan.liability.total).toBe(LIABILITY_95K + 5_225);
    expect(withLoan.outcome).toBe('owing');
    expect(withLoan.owing).toBe(2_413);
  });

  it('below the threshold there is no repayment, and so no line', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 50_000, tax_withheld: 7_000 })],
      studentLoan: true,
    });

    expect(component(s.liability.components, 'study-loan')).toBeUndefined();
    expect(s.liability.components).toHaveLength(2);
  });

  it('says the repayment is assessed on a different income base', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      studentLoan: true,
    });
    expect(component(s.liability.components, 'study-loan')!.detail)
      .toMatch(/repayment income, not taxable income/i);
  });
});

// ─── Deductions ──────────────────────────────────────────────────────────────

describe('deductions', () => {
  it('grow the refund by the tax on them, not by their face value', () => {
    const base = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    const claimed = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      manualDeductions: [md({ amount: 5_000, date: '2024-09-01' })],
    });

    // $5,000 off the top of the 30c bracket, plus 2c of Medicare = $1,600.
    expect(claimed.liability.total).toBe(LIABILITY_95K - 1_600);
    expect(claimed.refund).toBe(base.refund + 1_600);
  });

  it('cannot push the liability below zero, however large', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 40_000, tax_withheld: 4_000 })],
      manualDeductions: [md({ amount: 90_000, date: '2024-09-01' })],
    });

    expect(s.liability.total).toBe(0);
    expect(s.refund).toBe(4_000);
  });

  it('leave the credits side untouched — a deduction is not a payment', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      manualDeductions: [md({ amount: 5_000, date: '2024-09-01' })],
    });
    expect(s.credits.total).toBe(24_000);
    expect(s.paygWithheld).toBe(24_000);
  });
});

// ─── Other tax paid ──────────────────────────────────────────────────────────

describe('tax paid outside PAYG', () => {
  it('counts instalments and other withheld amounts as credits', () => {
    const s = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 15_000 })],
      credits: { paygInstalments: 4_000, otherTaxPaid: 500 },
    });

    expect(s.paygWithheld).toBe(15_000);
    expect(s.otherCredits).toBe(4_500);
    expect(s.credits.total).toBe(19_500);
    expect(s.owing).toBe(1_688);
    expect(component(s.credits.components, 'paygInstalments')!.amount).toBe(4_000);
    expect(component(s.credits.components, 'otherTaxPaid')!.amount).toBe(500);
  });

  it('lists only the credits that exist', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 15_000 })] });
    expect(s.credits.components.map(c => c.key)).toEqual(['payg-withheld']);
  });

  it('grosses a franking credit into income as well as crediting it', () => {
    const plain = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    const franked = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      credits: { frankingCredits: 700 },
    });

    // The credit is in income too, so tax rises 700 × 32c = 224 …
    expect(franked.liability.total).toBe(plain.liability.total! + 224);
    // … while the credit itself is worth the full 700.
    expect(franked.credits.total).toBe(24_700);
    expect(franked.refund).toBe(plain.refund + 476);
    expect(kinds(franked)).toContain('franking-gross-up');
    expect(component(franked.credits.components, 'frankingCredits')!.detail)
      .toMatch(/assessable income/i);
  });

  it('says nothing about franking when there is none', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    expect(kinds(s)).not.toContain('franking-gross-up');
  });
});

// ─── Years Ledger cannot assess ──────────────────────────────────────────────

describe('unsupported and provisional years', () => {
  it('refuses an outcome for a year with no rates, but still shows what was paid', () => {
    const s = settle({
      fy: '2015-2016',
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000, payment_date: '2015-09-01' })],
    });

    expect(s.ratesAvailable).toBe(false);
    expect(s.liability.total).toBeNull();
    expect(s.liability.components).toEqual([]);
    expect(s.net).toBeNull();
    expect(s.outcome).toBe('unknown');
    expect(s.refund).toBe(0);
    expect(s.owing).toBe(0);
    expect(s.effectiveTaxRate).toBeNull();
    // The credits side is the user's own money and is unaffected.
    expect(s.credits.total).toBe(24_000);
    expect(s.paygWithheld).toBe(24_000);
    expect(kinds(s)).toContain('no-rates');
  });

  it('never claims a limitation it cannot have — no offset note without rates', () => {
    const s = settle({ fy: '2015-2016', payslips: [payslip({ gross_pay: 95_000, payment_date: '2015-09-01' })] });
    expect(kinds(s)).not.toContain('offsets-excluded');
    expect(kinds(s)).not.toContain('provisional-rates');
  });

  it('flags a year whose thresholds are still indexed estimates, and passes the notes through', () => {
    const s = settle({
      fy: '2026-2027',
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000, payment_date: '2026-09-01' })],
    });

    expect(s.confidence).toBe('indexed-estimate');
    expect(kinds(s)).toContain('provisional-rates');
    expect(s.notes.length).toBeGreaterThan(0);
    // Still a real answer — provisional is not unavailable.
    expect(s.liability.total).toBeGreaterThan(0);
    expect(s.outcome).toBe('refund');
  });

  it('says offsets are excluded only when it was given none to apply', () => {
    // The page always supplies an offset position, so this warning belongs to
    // the bare Phase 5.2 call — and must NOT survive once offsets are modelled,
    // or the card would apologise for something it just did.
    const position = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [],
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
    });
    const est = estimateTaxForFY('2024-2025', 95_000)!;
    const bare = buildTaxSettlement({
      position,
      tax: {
        ratesAvailable: true, taxableIncome: est.taxableIncome, incomeTax: est.incomeTax,
        medicareLevy: est.medicareLevy, studentLoanRepayment: est.studentLoanRepayment,
        confidence: est.confidence, notes: est.notes,
      },
    });
    const w = bare.warnings.find(x => x.kind === 'offsets-excluded')!;
    expect(w.severity).toBe('info');
    expect(w.message).toMatch(/only reduce/i);
    expect(bare.offsets.components).toEqual([]);
    expect(bare.netLiability).toBe(bare.liability.total);

    const withOffsets = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    expect(kinds(withOffsets)).not.toContain('offsets-excluded');
    expect(kinds(withOffsets)).toContain('offsets-not-modelled');
  });
});

// ─── A year that is still running ────────────────────────────────────────────

describe('a snapshot of a year in progress', () => {
  it('says so on any day inside the year, including the last one', () => {
    const mid = settle({
      payslips: [payslip({ gross_pay: 40_000, tax_withheld: 9_000 })],
      asOf: '2025-01-15',
    });
    const lastDay = settle({
      payslips: [payslip({ gross_pay: 40_000, tax_withheld: 9_000 })],
      asOf: '2025-06-30',
    });

    expect(kinds(mid)).toContain('year-in-progress');
    expect(kinds(lastDay)).toContain('year-in-progress');
  });

  it('stays quiet once the year has closed, or with no date at all', () => {
    const closed = settle({
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      asOf: '2025-07-01',
    });
    const undated = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });

    expect(kinds(closed)).not.toContain('year-in-progress');
    expect(kinds(undated)).not.toContain('year-in-progress');
  });

  it('is advice, not a caveat that changes the arithmetic', () => {
    const a = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })], asOf: '2025-01-15' });
    const b = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    expect(a.net).toBe(b.net);
    expect(a.warnings.find(w => w.kind === 'year-in-progress')!.severity).toBe('info');
  });
});

// ─── Invariants ──────────────────────────────────────────────────────────────

// ─── Phase 5.3: offsets, the surcharge and the health adjustments ────────────

describe('offsets are their own group, not netted into either side', () => {
  it('reduces what the year costs without touching what was paid', () => {
    // $38,000 in 2024-25: income tax (38,000 − 18,200) × 16c = $3,168, levy 2%
    // of $38,000 = $760, so $3,928 gross. LITO is 700 − 500 × 5c = $675.
    const s = settle({ payslips: [payslip({ gross_pay: 38_000, tax_withheld: 3_000 })] });

    expect(s.liability.total).toBe(3_928);
    expect(s.offsets.components.map(c => [c.key, c.amount])).toEqual([['lito', 675]]);
    expect(s.netLiability).toBe(3_253);
    expect(s.credits.total).toBe(3_000);
    expect(s.owing).toBe(253);
  });

  it('reports the rate actually paid, after the offsets', () => {
    const s = settle({ payslips: [payslip({ gross_pay: 38_000, tax_withheld: 3_000 })] });
    expect(s.effectiveTaxRate).toBeCloseTo((3_253 / 38_000) * 100, 2);
  });

  it('turns a senior’s bill into a refund', () => {
    const before = settle({ payslips: [payslip({ gross_pay: 38_000, tax_withheld: 3_000 })] });
    expect(before.owing).toBe(253);

    // Rebate income $38,000: SAPTO is 2,230 − 3,081 × 12.5c = $1,844.875, rounded
    // up to $1,845, and there is $3,168 of income tax for it and LITO to sit in.
    const after = settle({
      payslips: [payslip({ gross_pay: 38_000, tax_withheld: 3_000 })],
      profile: { saptoEligible: true },
    });
    expect(after.offsets.components.map(c => [c.key, c.amount])).toEqual([['sapto', 1845], ['lito', 675]]);
    expect(after.netLiability).toBe(1_408);
    expect(after.refund).toBe(1_592);
  });

  it('shows nothing at all in a year that granted none', () => {
    // $95,000 is well past the LITO cut-out, so the section is absent rather
    // than a row of zeroes.
    const s = settle({ payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] });
    expect(s.offsets.components).toEqual([]);
    expect(s.offsets.total).toBe(0);
    expect(s.netLiability).toBe(s.liability.total);
  });

  it('never lets an offset become a refund of its own', () => {
    // $21,000: income tax is $448 and LITO is the full $700. The year costs
    // nothing, and the $252 of unused relief goes nowhere — the refund is the
    // withholding back, not the withholding plus the offset.
    const s = settle({ payslips: [payslip({ gross_pay: 21_000, tax_withheld: 500 })] });
    expect(s.liability.total).toBe(448);
    expect(s.offsets.total).toBe(448);
    expect(s.netLiability).toBe(0);
    expect(s.refund).toBe(500);
    expect(kinds(s)).toContain('offsets-capped');
  });
});

describe('the Medicare levy surcharge on the liability side', () => {
  const highEarner = { payslips: [payslip({ gross_pay: 120_000, tax_withheld: 30_000 })] };

  it('is left out, loudly, until hospital cover is answered', () => {
    const s = settle(highEarner);
    expect(component(s.liability.components, 'medicare-levy-surcharge')).toBeUndefined();
    expect(s.refund).toBe(812);   // 26,788 income tax + 2,400 levy against 30,000
    const w = s.warnings.find(x => x.kind === 'hospital-cover-unknown')!;
    expect(w.severity).toBe('warn');
    expect(w.amount).toBe(1_500);
  });

  it('turns that refund into a bill once the answer is "no cover"', () => {
    const s = settle({ ...highEarner, profile: { hospitalCover: 'none' } });
    const line = component(s.liability.components, 'medicare-levy-surcharge')!;
    expect(line.amount).toBe(1_500);
    expect(line.detail).toMatch(/Tier 2/);
    expect(s.liability.total).toBe(30_688);
    expect(s.owing).toBe(688);
  });

  it('sits next to the levy it is charged on top of, never inside it', () => {
    const s = settle({ ...highEarner, profile: { hospitalCover: 'none' } });
    expect(component(s.liability.components, 'medicare-levy')!.amount).toBe(2_400);
    expect(component(s.liability.components, 'medicare-levy-surcharge')!.amount).toBe(1_500);
  });

  it('goes away when the family thresholds apply', () => {
    // $120,000 is Tier 2 alone; with a $60,000 spouse the couple's $180,000 is
    // under the $194,000 family base threshold and nothing is charged.
    const s = settle({
      ...highEarner,
      profile: { hospitalCover: 'none', hasSpouse: true, spouseSurchargeIncome: 60_000 },
    });
    expect(component(s.liability.components, 'medicare-levy-surcharge')).toBeUndefined();
    expect(s.refund).toBe(812);
  });
});

describe('the private health rebate lands on whichever side it belongs', () => {
  // 2024-25, Tier 2, under 65: $3,000 at 8.202% + $1,000 at 8.095% = $327.01.
  const withPolicy = (rebateReceived: number) => settle({
    payslips: [payslip({ gross_pay: 120_000, tax_withheld: 30_000 })],
    profile: {
      hospitalCover: 'full-year',
      premiumsFirstPeriod: 3_000,
      premiumsSecondPeriod: 1_000,
      rebateReceived,
    },
  });

  it('adds an over-claimed rebate to the bill', () => {
    const s = withPolicy(400);
    const line = component(s.liability.components, 'excess-health-rebate')!;
    expect(line.amount).toBeCloseTo(72.99, 2);
    expect(line.detail).toMatch(/entitles you to/);
    expect(kinds(s)).toContain('excess-health-rebate');
  });

  it('gives an under-claimed rebate back as a credit, not an offset', () => {
    const s = withPolicy(200);
    expect(component(s.offsets.components, 'health-rebate-shortfall')).toBeUndefined();
    const line = component(s.credits.components, 'health-rebate-shortfall')!;
    expect(line.amount).toBeCloseTo(127.01, 2);
    // Refundable, so it lifts the refund rather than being lost against nil tax.
    expect(s.refund).toBeCloseTo(812 + 127.01, 2);
  });

  it('leaves both sides alone when the insurer got it right', () => {
    const s = withPolicy(327.01);
    expect(component(s.liability.components, 'excess-health-rebate')).toBeUndefined();
    expect(component(s.credits.components, 'health-rebate-shortfall')).toBeUndefined();
    expect(s.refund).toBe(812);
  });
});

describe('offsets follow the financial year switcher', () => {
  const senior = (fy: string) => settle({
    fy,
    payslips: [payslip({ gross_pay: 33_000, tax_withheld: 2_000, payment_date: `${fy.slice(0, 4)}-09-01` })],
    profile: { saptoEligible: true },
  });

  it('assesses the same senior differently in two years, on each year’s own table', () => {
    // $33,000 is past the 2023-24 shade-out ($32,279) and under the 2024-25 one
    // ($34,919), so the same income buys $2,140 of SAPTO in one year and the
    // full $2,230 in the other. Never one year's table applied to another.
    expect(component(senior('2023-2024').offsets.components, 'sapto')!.amount).toBe(2_140);
    expect(component(senior('2024-2025').offsets.components, 'sapto')!.amount).toBe(2_230);
  });

  it('withdraws offsets entirely in a year Ledger has no rules for', () => {
    const s = settle({
      fy: '2015-2016',
      payslips: [payslip({ gross_pay: 33_000, tax_withheld: 2_000, payment_date: '2015-09-01' })],
      profile: { saptoEligible: true, hospitalCover: 'none' },
    });
    expect(s.offsets.components).toEqual([]);
    expect(s.netLiability).toBeNull();
    expect(s.outcome).toBe('unknown');
    // What was withheld is still real, and is still shown.
    expect(s.credits.total).toBe(2_000);
  });

  it('carries the offset registry’s own provenance notes', () => {
    const s = settle({
      fy: '2027-2028',
      payslips: [payslip({ gross_pay: 60_000, tax_withheld: 12_000, payment_date: '2027-09-01' })],
    });
    expect(s.notes.join(' ')).toMatch(/surcharge thresholds/i);
    expect(kinds(s)).toContain('provisional-offset-rates');
  });
});

describe('invariants that must hold whatever the inputs', () => {
  const cases: Array<[string, Parameters<typeof settle>[0]]> = [
    ['nothing at all', {}],
    ['one job', { payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })] }],
    ['two jobs', { payslips: [
      payslip({ employer: 'A', gross_pay: 60_000, tax_withheld: 12_000 }),
      payslip({ employer: 'B', gross_pay: 35_000, tax_withheld: 4_000 }),
    ] }],
    ['no withholding', { payslips: [payslip({ gross_pay: 95_000, tax_withheld: 0 })] }],
    ['a loan', { payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })], studentLoan: true }],
    ['deductions', {
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      manualDeductions: [md({ amount: 5_000 })],
    }],
    ['every credit', {
      payslips: [payslip({ gross_pay: 95_000, tax_withheld: 24_000 })],
      credits: { paygInstalments: 1_000, frankingCredits: 700, otherTaxPaid: 250 },
    }],
    ['an unsupported year', { fy: '2015-2016', payslips: [payslip({ gross_pay: 95_000, payment_date: '2015-09-01' })] }],
    ['an offset that outruns the tax', { payslips: [payslip({ gross_pay: 21_000, tax_withheld: 500 })] }],
    ['the surcharge', {
      payslips: [payslip({ gross_pay: 160_000, tax_withheld: 45_000 })],
      profile: { hospitalCover: 'none' as const },
    }],
    ['a family with a health statement', {
      payslips: [payslip({ gross_pay: 120_000, tax_withheld: 30_000 })],
      profile: {
        hasSpouse: true, spouseSurchargeIncome: 90_000, dependentChildren: 2,
        hospitalCover: 'part-year' as const, hospitalCoverDays: 180,
        premiumsFirstPeriod: 3_000, premiumsSecondPeriod: 1_000, rebateReceived: 400,
      },
    }],
    ['a senior', {
      payslips: [payslip({ gross_pay: 38_000, tax_withheld: 3_000 })],
      profile: { saptoEligible: true },
    }],
  ];

  it.each(cases)('%s: refund and owing are never both non-zero', (_name, input) => {
    const s = settle(input);
    expect(s.refund === 0 || s.owing === 0).toBe(true);
    expect(s.refund).toBeGreaterThanOrEqual(0);
    expect(s.owing).toBeGreaterThanOrEqual(0);
  });

  it.each(cases)('%s: the headline is exactly liability minus offsets minus credits', (_name, input) => {
    const s = settle(input);
    if (s.liability.total == null) {
      expect(s.net).toBeNull();
      expect(s.netLiability).toBeNull();
      expect(s.outcome).toBe('unknown');
      return;
    }
    expect(s.netLiability).toBeCloseTo(s.liability.total - s.offsets.total, 2);
    expect(s.net).toBeCloseTo(s.netLiability! - s.credits.total, 2);
    expect(s.owing - s.refund).toBeCloseTo(s.net!, 2);
  });

  it.each(cases)('%s: offsets never turn the year’s cost negative', (_name, input) => {
    // Non-refundable relief stops at zero. Anything below it would be a refund
    // the ATO does not pay, arriving through the wrong side of the subtraction.
    const s = settle(input);
    if (s.netLiability != null) expect(s.netLiability).toBeGreaterThanOrEqual(0);
    expect(s.offsets.total).toBeGreaterThanOrEqual(0);
    expect(s.offsets.total).toBeLessThanOrEqual((s.liability.total ?? 0) + 0.001);
  });

  it.each(cases)('%s: each side equals the sum of the lines shown for it', (_name, input) => {
    const s = settle(input);
    const sum = (xs: { amount: number }[]) => xs.reduce((t, x) => t + x.amount, 0);
    if (s.liability.total != null) {
      expect(sum(s.liability.components)).toBeCloseTo(s.liability.total, 2);
    }
    expect(sum(s.offsets.components)).toBeCloseTo(s.offsets.total, 2);
    expect(sum(s.credits.components)).toBeCloseTo(s.credits.total, 2);
    expect(s.paygWithheld + s.otherCredits).toBeCloseTo(s.credits.total, 2);
  });

  it.each(cases)('%s: the drill-down accounts for every dollar of PAYG', (_name, input) => {
    const s = settle(input);
    const withheld = s.withholdingSources.reduce((t, w) => t + w.withheld, 0);
    expect(withheld).toBeCloseTo(s.paygWithheld, 2);
  });
});

describe('settlementHeadline', () => {
  it('names each outcome', () => {
    expect(settlementHeadline('refund')).toBe('Estimated refund');
    expect(settlementHeadline('owing')).toBe('Estimated amount owing');
    expect(settlementHeadline('square')).toBe('Estimated outcome');
    expect(settlementHeadline('unknown')).toBe('Estimated outcome');
  });
});
