/**
 * Phase 5.6 — the tax return / accountant pack.
 *
 * The pack computes no tax, so these tests are not about arithmetic. They are
 * about the three promises it makes:
 *
 *   1. it RECONCILES — what the document shows adds up to what the Tax page
 *      holds, and when it doesn't, it says so instead of exporting anyway;
 *   2. every figure DRILLS to a source, and an entered figure is never dressed
 *      up as a derived one;
 *   3. a year with missing data or no rates still produces an honest pack,
 *      with the gaps named rather than the sections quietly zeroed.
 *
 * The fixtures build REAL positions from the real 5.1–5.5 engines and then run
 * the Tax page's own pipeline over them, so "reconciles to the Tax page" is
 * tested against the page's actual arithmetic and not a restatement of it.
 */

import { describe, it, expect } from 'vitest';
import type { IncomeEntry, Loan, Property, Transaction } from '../types';
import { buildTaxYearPosition, fyBounds } from './taxYear';
import { buildTaxSettlement } from './taxSettlement';
import { buildOffsetPosition } from './taxOffsets';
import { estimateTaxForFY } from './taxRates';
import { repaymentIncomeFrom, emptyRepaymentIncomeAdjustments,
  type RepaymentIncomeAdjustments } from './repaymentIncome';
import { grossUpFor, emptyTaxCredits, type TaxCredits } from './taxCredits';
import { emptyTaxProfile, type TaxProfile } from './taxProfile';
import { buildCapitalGains, type CgtDisposal, type CgtParcel } from './capitalGains';
import { buildRentalPosition, emptyRentalSettings, type RentalPropertySettings } from './rentalProperty';
import type { DividendStatement } from './dividendIncome';
import type { ManualDeduction } from './taxDeductions';
import type { PayslipCore } from './payroll';
import {
  buildTaxPack, packSection, flattenPackLines, sumOfLines, RECONCILE_TOLERANCE,
  type TaxPack, type TaxPackInput, type TaxPackLine,
} from './taxPack';
import {
  taxPackToCsv, taxPackSourcesToCsv, taxPackToHtml, taxPackFilename,
} from './taxPackExport';

const FY = '2024-2025';
const PREPARED = '2026-08-19';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  user_id: 'u1', account_id: 'acc1', account_type: 'bank',
  date: '2024-12-01', merchant: 'Something', category: 'Other', currency: 'AUD',
  ...o,
} as Transaction);

const payslip = (o: Partial<PayslipCore> = {}): PayslipCore => ({
  employer: 'Acme Pty Ltd', employment_type: 'full-time', pay_frequency: 'monthly',
  payment_date: '2025-06-15', gross_pay: 10_000, net_pay: 7_000,
  tax_withheld: 3_000, super_amount: 1_150,
  ytd_gross: 120_000, ytd_tax: 30_000,
  ...o,
});

const deduction = (o: Partial<ManualDeduction> & { id: string }): ManualDeduction => ({
  name: 'Work laptop', amount: 1_200, category: 'Equipment', date: '2025-02-01',
  ...o,
});

const property = (o: Partial<Property> & { id: string }): Property => ({
  user_id: 'u1', name: 'Bondi', property_type: 'investment',
  purchase_price: 800_000, purchase_date: '2018-03-01', current_value: 1_000_000,
  ownership_percent: 100, rent_match_terms: ['ray white'],
  property_expenses: [{ id: 'e1', name: 'Strata Plus', kind: 'strata', match_terms: ['strata plus'] }],
  ...o,
} as Property);

const loanFor = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: 'u1', name: 'Bondi mortgage', loan_type: 'mortgage',
  original_amount: 700_000, current_balance: 620_000, interest_rate: 6.1,
  minimum_repayment: 3_400, repayment_frequency: 'monthly',
  ...o,
} as Loan);

interface FixtureOptions {
  fy?: string;
  transactions?: Transaction[];
  manualDeductions?: ManualDeduction[];
  incomeEntries?: IncomeEntry[];
  payslips?: PayslipCore[];
  disposals?: CgtDisposal[];
  parcels?: CgtParcel[];
  dividendStatements?: DividendStatement[];
  properties?: { property: Property; transactions: Transaction[]; loan?: Loan | null;
    interestTransactions?: Transaction[]; settings?: RentalPropertySettings }[];
  credits?: Partial<TaxCredits>;
  adjustments?: Partial<RepaymentIncomeAdjustments>;
  profile?: Partial<TaxProfile>;
  hasStudentLoan?: boolean;
  asOf?: string;
}

/**
 * The Tax page's pipeline, in test form: position → credits → tax → offsets →
 * settlement → pack, in exactly the order and with exactly the arithmetic
 * pages/Tax.tsx uses. If this drifts from the page, the integration test that
 * runs the REAL calculateTax over a seeded store catches it.
 */
function makeInput(o: FixtureOptions = {}): TaxPackInput {
  const fy = o.fy ?? FY;
  const credits: TaxCredits = { ...emptyTaxCredits(), ...o.credits };
  const adjustments: RepaymentIncomeAdjustments = {
    ...emptyRepaymentIncomeAdjustments(), ...o.adjustments,
  };
  const profile: TaxProfile = { ...emptyTaxProfile(), ...o.profile };

  const capitalGains = o.disposals?.length
    ? buildCapitalGains({ fy, disposals: o.disposals, parcels: o.parcels ?? [] })
    : null;

  const rental = o.properties?.length
    ? buildRentalPosition({
        fy,
        asOf: o.asOf ?? fyBounds(fy).end,
        properties: o.properties.map(p => ({
          property: p.property,
          transactions: p.transactions,
          loan: p.loan ?? null,
          interestTransactions: p.interestTransactions,
          settings: p.settings ?? emptyRentalSettings(),
        })),
      })
    : null;

  const position = buildTaxYearPosition({
    fy,
    transactions: o.transactions ?? [],
    manualDeductions: o.manualDeductions ?? [],
    incomeEntries: o.incomeEntries ?? [],
    payslips: o.payslips ?? [],
    capitalGains,
    dividendStatements: o.dividendStatements,
    manualFrankingCredit: credits.frankingCredits,
    rental,
  });

  const dividends = position.income.dividends;
  const effectiveCredits: TaxCredits = dividends
    ? { ...credits, frankingCredits: dividends.effectiveFrankingCredit }
    : credits;
  const grossUp = grossUpFor(effectiveCredits);

  const taxableIncome = Math.max(
    0, position.assessableIncome + grossUp - position.deductibleExpenses,
  );

  const derivedLoss = position.income.rental?.netRentalLoss ?? 0;
  const effectiveAdjustments = derivedLoss > 0
    ? { ...adjustments,
        totalNetInvestmentLoss: Math.max(adjustments.totalNetInvestmentLoss, derivedLoss) }
    : adjustments;

  const repayment = repaymentIncomeFrom(taxableIncome, effectiveAdjustments);
  const estimate = estimateTaxForFY(fy, taxableIncome, {
    studentLoan: o.hasStudentLoan ?? false,
    repaymentIncome: repayment.total,
  });

  const offsets = buildOffsetPosition({
    fy,
    taxableIncome,
    incomeTax: estimate?.incomeTax ?? 0,
    adjustments: effectiveAdjustments,
    profile,
  });

  const settlement = buildTaxSettlement({
    position,
    tax: {
      ratesAvailable: !!estimate,
      taxableIncome,
      incomeTax: estimate?.incomeTax ?? null,
      medicareLevy: estimate?.medicareLevy ?? null,
      studentLoanRepayment: estimate?.studentLoanRepayment ?? null,
      confidence: estimate?.confidence ?? null,
      notes: estimate?.notes ?? [],
    },
    credits: effectiveCredits,
    offsets,
    asOf: PREPARED,
  });

  return {
    position,
    settlement,
    offsets,
    repayment,
    hasStudentLoan: o.hasStudentLoan ?? false,
    currency: 'AUD',
    grossUp,
    taxableIncome,
    preparedOn: PREPARED,
    taxpayer: 'Test Taxpayer',
  };
}

const makePack = (o: FixtureOptions = {}): TaxPack => buildTaxPack(makeInput(o));

/** A realistic year: salary, a deduction, a share sale, a dividend, a rental. */
function richOptions(): FixtureOptions {
  return {
    payslips: [payslip()],
    manualDeductions: [deduction({ id: 'd1' })],
    transactions: [
      tx({ id: 't-sub', amount: -600, date: '2025-03-01', merchant: 'Xero',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
    ],
    disposals: [{
      id: 's1', investmentId: 'i1', label: 'BHP', ticker: 'BHP', assetType: 'stock',
      quantity: 100, proceeds: 5_000, fees: 20, costBase: 3_000,
      acquiredDate: '2020-01-15', saleDate: '2025-03-10', currency: 'AUD',
    }],
    dividendStatements: [{
      id: 'dv1', investmentId: 'i1', label: 'BHP', ticker: 'BHP',
      paymentDate: '2025-02-20', frankedAmount: 700, unfrankedAmount: 0,
      frankingCredit: 300, withheld: 0,
    } as DividendStatement],
    properties: [{
      property: property({ id: 'p1' }),
      transactions: [
        ...Array.from({ length: 12 }, (_, i) => tx({
          id: `r${i}`, amount: 2_600, merchant: 'Ray White',
          date: `${i < 6 ? 2024 : 2025}-${String(((i + 6) % 12) + 1).padStart(2, '0')}-05`,
          category: 'Rent',
        })),
        tx({ id: 'x1', amount: -1_400, date: '2024-09-10', merchant: 'Strata Plus',
          category: 'Property' }),
      ],
      loan: loanFor(),
    }],
  };
}

// ─── Shape ───────────────────────────────────────────────────────────────────

describe('taxPack — shape', () => {
  it('lays the year out in the order a return runs', () => {
    expect(makePack().sections.map(s => s.id)).toEqual([
      'income', 'withholding', 'deductions', 'capital-gains', 'dividends', 'rental',
      'taxable-income', 'tax', 'offsets', 'student-loan', 'settlement',
    ]);
  });

  it('separates the return from the schedules behind it', () => {
    const pack = makePack(richOptions());
    const roles = Object.fromEntries(pack.sections.map(s => [s.id, s.role]));
    expect(roles['income']).toBe('return');
    expect(roles['deductions']).toBe('return');
    expect(roles['taxable-income']).toBe('return');
    expect(roles['tax']).toBe('return');
    expect(roles['settlement']).toBe('return');
    // These are working, already counted inside a return section above.
    expect(roles['withholding']).toBe('schedule');
    expect(roles['capital-gains']).toBe('schedule');
    expect(roles['dividends']).toBe('schedule');
    expect(roles['rental']).toBe('schedule');
    expect(roles['student-loan']).toBe('schedule');
  });

  it('makes every schedule say which figure it supports', () => {
    for (const s of makePack(richOptions()).sections.filter(s => s.role === 'schedule')) {
      expect(s.supports, s.id).toBeTruthy();
    }
  });

  it('carries the financial year bounds and the date it was prepared', () => {
    const pack = makePack();
    expect(pack.fy).toBe(FY);
    expect(pack.start).toBe('2024-07-01');
    expect(pack.end).toBe('2025-06-30');
    expect(pack.preparedOn).toBe(PREPARED);
    expect(pack.taxpayer).toBe('Test Taxpayer');
  });

  it('never invents a taxpayer name', () => {
    expect(buildTaxPack({ ...makeInput(), taxpayer: '   ' }).taxpayer).toBeNull();
  });

  it('counts only add and subtract lines towards a section total', () => {
    const lines: TaxPackLine[] = [
      { key: 'a', label: 'a', amount: 100, role: 'add', provenance: 'derived',
        detail: null, date: null, drill: null, children: [] },
      { key: 'b', label: 'b', amount: 30, role: 'subtract', provenance: 'derived',
        detail: null, date: null, drill: null, children: [] },
      { key: 'c', label: 'c', amount: 999, role: 'info', provenance: 'derived',
        detail: null, date: null, drill: null, children: [] },
      { key: 'd', label: 'd', amount: 70, role: 'total', provenance: 'derived',
        detail: null, date: null, drill: null, children: [] },
    ];
    expect(sumOfLines(lines)).toBe(70);
  });

  it('never sums a child twice — the parent already carries it', () => {
    const pack = makePack(richOptions());
    const income = packSection(pack, 'income')!;
    expect(income.lines.some(l => l.children.length > 0)).toBe(true);
    expect(sumOfLines(income.lines)).toBeCloseTo(income.total!, 2);
  });
});

// ─── Income ──────────────────────────────────────────────────────────────────

describe('taxPack — income', () => {
  it('totals to assessable income plus the franking gross-up', () => {
    const pack = makePack(richOptions());
    const s = packSection(pack, 'income')!;
    expect(s.total).toBeCloseTo(
      pack.taxableIncome! + packSection(pack, 'deductions')!.total!, 2,
    );
  });

  it('groups by income category, with each source as a child', () => {
    const s = packSection(makePack({ payslips: [payslip()] }), 'income')!;
    const salary = s.lines.find(l => /salary|wage/i.test(l.label)) ?? s.lines[0];
    expect(salary.amount).toBe(120_000);
    expect(salary.children.map(c => c.label)).toContain('Acme Pty Ltd');
  });

  it('shows an excluded income line rather than dropping it, with the reason', () => {
    const pack = makePack({
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Consulting', amount: 5_000,
          date: '2025-01-10', status: 'pending', category: 'Business' } as any,
      ],
    });
    const s = packSection(pack, 'income')!;
    const all = flattenPackLines(s).map(f => f.line);
    const pending = all.find(l => l.label === 'Consulting')!;
    expect(pending.role).toBe('info');
    expect(pending.detail).toMatch(/not counted/i);
    expect(pending.detail).toMatch(/pending/i);
    expect(s.total).toBe(0);
  });

  it('adds the franking gross-up and marks it derived when statements back it', () => {
    const pack = makePack(richOptions());
    const line = packSection(pack, 'income')!.lines
      .find(l => l.key === 'income:franking-gross-up')!;
    expect(line.amount).toBe(300);
    expect(line.provenance).toBe('derived');
    expect(line.drill).toEqual({ kind: 'section', id: 'dividends' });
  });

  it('marks a hand-typed franking credit as entered, not derived', () => {
    const pack = makePack({ payslips: [payslip()], credits: { frankingCredits: 450 } });
    const line = packSection(pack, 'income')!.lines
      .find(l => l.key === 'income:franking-gross-up')!;
    expect(line.provenance).toBe('entered');
    expect(line.drill).toEqual({ kind: 'entry', id: 'credits.frankingCredits' });
  });

  it('omits the gross-up line entirely when there are no franking credits', () => {
    const s = packSection(makePack({ payslips: [payslip()] }), 'income')!;
    expect(s.lines.some(l => l.key === 'income:franking-gross-up')).toBe(false);
  });

  it('sends rent and the capital gain to the schedules that work them out', () => {
    const s = packSection(makePack(richOptions()), 'income')!;
    expect(s.lines.find(l => l.label === 'Rent')!.drill)
      .toEqual({ kind: 'section', id: 'rental' });
    expect(s.lines.find(l => l.label === 'Net capital gain')!.drill)
      .toEqual({ kind: 'section', id: 'capital-gains' });
  });

  it('says so plainly when there is no income at all', () => {
    const s = packSection(makePack(), 'income')!;
    expect(s.empty).toBe(true);
    expect(s.note).toMatch(/no income/i);
    expect(s.total).toBe(0);
  });
});

// ─── PAYG withholding ────────────────────────────────────────────────────────

describe('taxPack — PAYG withholding', () => {
  it('totals to the withholding on the position', () => {
    const pack = makePack(richOptions());
    const s = packSection(pack, 'withholding')!;
    expect(s.total).toBe(30_000);
    expect(sumOfLines(s.lines)).toBeCloseTo(30_000, 2);
  });

  it('names the rate withheld from each source', () => {
    const s = packSection(makePack({ payslips: [payslip()] }), 'withholding')!;
    expect(s.lines[0].detail).toMatch(/25\.0%/);
  });

  it('lists income that had nothing withheld, at zero, rather than hiding it', () => {
    const pack = makePack({
      payslips: [payslip()],
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Interest', amount: 900,
          date: '2025-01-10', status: 'approved', category: 'Interest' } as any,
      ],
    });
    const s = packSection(pack, 'withholding')!;
    const interest = s.lines.find(l => l.label === 'Interest')!;
    expect(interest.role).toBe('info');
    expect(interest.amount).toBe(0);
    expect(interest.detail).toMatch(/nothing withheld/i);
    expect(s.total).toBe(30_000);
  });

  it('is empty, with a reason, when nothing was withheld all year', () => {
    const s = packSection(makePack({
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Interest', amount: 900,
          date: '2025-01-10', status: 'approved', category: 'Interest' } as any,
      ],
    }), 'withholding')!;
    expect(s.empty).toBe(true);
    expect(s.note).toMatch(/no tax was withheld/i);
  });
});

// ─── Deductions ──────────────────────────────────────────────────────────────

describe('taxPack — deductions', () => {
  it('totals to the deductible expenses on the position', () => {
    const pack = makePack(richOptions());
    const s = packSection(pack, 'deductions')!;
    expect(s.total).toBe(pack.checks.find(c => c.key === 'deductions')!.page);
    expect(sumOfLines(s.lines)).toBeCloseTo(s.total!, 2);
  });

  it('marks a manual deduction as entered and a transaction as derived', () => {
    const pack = makePack({
      manualDeductions: [deduction({ id: 'd1' })],
      transactions: [tx({ id: 't1', amount: -600, date: '2025-03-01', merchant: 'Xero',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any)],
    });
    const leaves = packSection(pack, 'deductions')!.lines.flatMap(l => l.children);
    expect(leaves.find(l => l.label === 'Work laptop')!.provenance).toBe('entered');
    expect(leaves.find(l => l.label === 'Xero')!.provenance).toBe('derived');
  });

  it('shows a refund against a claim on the line it reduced', () => {
    const pack = makePack({
      transactions: [
        tx({ id: 't1', amount: -1_000, date: '2025-03-01', merchant: 'Tools R Us',
          category: 'Equipment', is_tax_deductible: true, deduction_category: 'Equipment' } as any),
        tx({ id: 't2', amount: 250, date: '2025-04-01', merchant: 'Tools R Us',
          category: 'Equipment', transaction_type: 'refund', refund_of: 't1' } as any),
      ],
    });
    const leaf = packSection(pack, 'deductions')!.lines[0].children[0];
    expect(leaf.amount).toBe(750);
    expect(leaf.detail).toMatch(/refunded/);
  });

  it('keeps a rental-claimed transaction visible, uncounted, with the reason', () => {
    const opts = richOptions();
    opts.transactions = [
      tx({ id: 'x1', amount: -1_400, date: '2024-09-10', merchant: 'Strata Plus',
        category: 'Property', is_tax_deductible: true, deduction_category: 'Property' } as any),
    ];
    opts.properties![0].transactions = [
      ...opts.properties![0].transactions.filter(t => t.id !== 'x1'),
      opts.transactions[0],
    ];
    const pack = makePack(opts);
    const all = flattenPackLines(packSection(pack, 'deductions')!).map(f => f.line);
    const strata = all.find(l => l.label === 'Strata Plus' && l.role === 'info');
    expect(strata).toBeTruthy();
    expect(strata!.detail).toMatch(/rental schedule/i);
  });

  it('says so plainly when there are no deductions', () => {
    const s = packSection(makePack({ payslips: [payslip()] }), 'deductions')!;
    expect(s.empty).toBe(true);
    expect(s.note).toMatch(/no deductions/i);
  });
});

// ─── Capital gains ───────────────────────────────────────────────────────────

describe('taxPack — capital gains and losses', () => {
  it('walks the ATO steps down to the net capital gain', () => {
    const s = packSection(makePack(richOptions()), 'capital-gains')!;
    const by = (k: string) => s.lines.find(l => l.key === k)!;
    expect(by('cgt:gross-gains').role).toBe('add');
    expect(by('cgt:losses-applied').role).toBe('subtract');
    expect(by('cgt:discount').role).toBe('subtract');
    // 5,000 − 20 fees − 3,000 = 1,980 gain, held over 12 months → 990 discount.
    expect(by('cgt:gross-gains').amount).toBeCloseTo(1_980, 2);
    expect(by('cgt:discount').amount).toBeCloseTo(990, 2);
    expect(s.total).toBeCloseTo(990, 2);
    expect(sumOfLines(s.lines)).toBeCloseTo(s.total!, 2);
  });

  it('names the discount as a rate, not something Ledger decided', () => {
    const s = packSection(makePack(richOptions()), 'capital-gains')!;
    expect(s.lines.find(l => l.key === 'cgt:discount')!.provenance).toBe('rates');
  });

  it('lists each disposal under the gains, with its sale date', () => {
    const s = packSection(makePack(richOptions()), 'capital-gains')!;
    const event = s.lines.find(l => l.key === 'cgt:gross-gains')!.children[0];
    expect(event.label).toBe('BHP');
    expect(event.date).toBe('2025-03-10');
    expect(event.drill).toEqual({ kind: 'cgt-event', id: 's1' });
  });

  it('says which losses were set against which gains', () => {
    const pack = makePack({
      disposals: [
        { id: 'w', investmentId: null, label: 'Winner', ticker: 'W', assetType: 'stock',
          quantity: 10, proceeds: 6_000, fees: 0, costBase: 2_000,
          acquiredDate: '2019-01-01', saleDate: '2025-03-01', currency: 'AUD' },
        { id: 'l', investmentId: null, label: 'Loser', ticker: 'L', assetType: 'stock',
          quantity: 10, proceeds: 1_000, fees: 0, costBase: 2_500,
          acquiredDate: '2024-09-01', saleDate: '2025-03-02', currency: 'AUD' },
      ],
    });
    const applied = packSection(pack, 'capital-gains')!.lines
      .find(l => l.key === 'cgt:losses-applied')!;
    expect(applied.amount).toBeCloseTo(1_500, 2);
    expect(applied.children[0].label).toMatch(/this year’s loss/i);
  });

  it('carries unused losses forward and says so', () => {
    const pack = makePack({
      disposals: [{ id: 'l', investmentId: null, label: 'Loser', ticker: 'L',
        assetType: 'stock', quantity: 10, proceeds: 500, fees: 0, costBase: 3_000,
        acquiredDate: '2024-09-01', saleDate: '2025-03-02', currency: 'AUD' }],
    });
    const s = packSection(pack, 'capital-gains')!;
    expect(s.lines.find(l => l.key === 'cgt:carried-forward')!.amount).toBeCloseTo(2_500, 2);
    expect(s.total).toBe(0);
  });

  it('is empty, and its check skipped, in a year with no disposals', () => {
    const pack = makePack({ payslips: [payslip()] });
    expect(packSection(pack, 'capital-gains')!.empty).toBe(true);
    expect(packSection(pack, 'capital-gains')!.note).toMatch(/no disposals/i);
    const check = pack.checks.find(c => c.key === 'capital-gains')!;
    expect(check.skipped).toBeTruthy();
    expect(check.agrees).toBe(true);
  });
});

// ─── Dividends ───────────────────────────────────────────────────────────────

describe('taxPack — dividends and franking', () => {
  it('adds franked, unfranked and the credit to the grossed-up total', () => {
    const s = packSection(makePack(richOptions()), 'dividends')!;
    expect(s.lines.find(l => l.key === 'div:franked')!.amount).toBe(700);
    expect(s.lines.find(l => l.key === 'div:credit')!.amount).toBe(300);
    expect(s.total).toBe(1_000);
    expect(sumOfLines(s.lines)).toBeCloseTo(1_000, 2);
  });

  it('lists each statement, with the cash split out', () => {
    const s = packSection(makePack(richOptions()), 'dividends')!;
    const stmt = s.lines.find(l => l.key === 'div:stmt:dv1')!;
    expect(stmt.label).toBe('BHP (BHP)');
    expect(stmt.role).toBe('info');
    expect(stmt.detail).toMatch(/700\.00 franked/);
    expect(stmt.drill).toEqual({ kind: 'dividend', id: 'dv1' });
  });

  it('says how much dividend cash the statements actually added to income', () => {
    const s = packSection(makePack(richOptions()), 'dividends')!;
    const added = s.lines.find(l => l.key === 'div:added')!;
    expect(added.amount).toBe(700);
    expect(added.detail).toMatch(/not added twice/i);
  });

  it('is empty, and its check skipped, with no statements', () => {
    const pack = makePack({ payslips: [payslip()] });
    expect(packSection(pack, 'dividends')!.empty).toBe(true);
    expect(pack.checks.find(c => c.key === 'dividends')!.skipped).toBeTruthy();
  });

  it('treats a lone typed franking figure as no statements at all', () => {
    const pack = makePack({ payslips: [payslip()], credits: { frankingCredits: 450 } });
    expect(packSection(pack, 'dividends')!.empty).toBe(true);
  });
});

// ─── Rental ──────────────────────────────────────────────────────────────────

describe('taxPack — rental schedules', () => {
  it('gives each property a line that nets its own income and deductions', () => {
    const s = packSection(makePack(richOptions()), 'rental')!;
    const bondi = s.lines.find(l => l.key === 'rent:p1')!;
    expect(bondi.amount).toBeCloseTo(31_200 - 1_400, 2);
    expect(bondi.drill).toEqual({ kind: 'property', id: 'p1' });
    expect(bondi.children.find(c => c.label === 'Rent received')!.amount).toBe(31_200);
    expect(bondi.children.find(c => c.label === 'Body corporate fees')!.amount)
      .toBe(1_400);
  });

  it('lists every rent payment under the rent, each drilling to its transaction', () => {
    const s = packSection(makePack(richOptions()), 'rental')!;
    const rent = s.lines[0].children.find(c => c.label === 'Rent received')!;
    expect(rent.children).toHaveLength(12);
    expect(rent.children[0].drill!.kind).toBe('transaction');
    expect(rent.children[0].date).toBeTruthy();
  });

  it('totals the properties to the schedule’s net result', () => {
    const pack = makePack(richOptions());
    const s = packSection(pack, 'rental')!;
    expect(sumOfLines(s.lines)).toBeCloseTo(s.total!, 2);
    expect(pack.checks.find(c => c.key === 'rental')!.agrees).toBe(true);
  });

  it('never sums two properties into each other', () => {
    const opts = richOptions();
    opts.properties!.push({
      property: property({ id: 'p2', name: 'Coogee', rent_match_terms: ['jones re'] }),
      transactions: [tx({ id: 'r2a', amount: 1_000, date: '2025-01-05', merchant: 'Jones RE' })],
      loan: null,
    });
    const s = packSection(makePack(opts), 'rental')!;
    expect(s.lines.find(l => l.key === 'rent:p1')!.amount).toBeCloseTo(29_800, 2);
    expect(s.lines.find(l => l.key === 'rent:p2')!.amount).toBeCloseTo(1_000, 2);
    expect(sumOfLines(s.lines)).toBeCloseTo(s.total!, 2);
  });

  it('reports the loan principal beside the interest, never as a deduction', () => {
    const opts = richOptions();
    opts.properties![0].settings = {
      ...emptyRentalSettings(),
      byFY: { [FY]: { interestPaid: 30_000, interestPrivatePercent: 0,
        availableForRent: true, otherIncome: 0, otherDeductions: [] } },
    } as RentalPropertySettings;
    const bondi = packSection(makePack(opts), 'rental')!.lines[0];
    const principal = bondi.children.find(c => c.key === 'rent:p1:principal')!;
    expect(principal.role).toBe('info');
    expect(principal.amount).toBeCloseTo(40_800 - 30_000, 2);
    expect(principal.detail).toMatch(/not deductible|checked/i);
    const interest = bondi.children.find(c => c.label === 'Interest on loans')!;
    expect(interest.amount).toBeCloseTo(30_000, 2);
    expect(interest.provenance).toBe('entered');
  });

  it('lists an excluded property with the reason, at nil', () => {
    const opts = richOptions();
    opts.properties!.push({
      property: property({ id: 'home', name: 'Home', property_type: 'home',
        rent_match_terms: [] }),
      transactions: [],
      loan: null,
    });
    const s = packSection(makePack(opts), 'rental')!;
    const home = s.lines.find(l => l.key === 'rent:home')!;
    expect(home.role).toBe('info');
    expect(home.amount).toBe(0);
    expect(home.detail).toMatch(/not in the schedule/i);
  });

  it('calls a negatively geared year a loss, in the total label', () => {
    const opts = richOptions();
    opts.properties![0].settings = {
      ...emptyRentalSettings(),
      byFY: { [FY]: { interestPaid: 45_000, interestPrivatePercent: 0,
        availableForRent: true, otherIncome: 0, otherDeductions: [] } },
    } as RentalPropertySettings;
    const s = packSection(makePack(opts), 'rental')!;
    expect(s.total).toBeLessThan(0);
    expect(s.totalLabel).toMatch(/net rental loss/i);
  });

  it('is empty, and its check skipped, with no properties', () => {
    const pack = makePack({ payslips: [payslip()] });
    expect(packSection(pack, 'rental')!.empty).toBe(true);
    expect(pack.checks.find(c => c.key === 'rental')!.skipped).toBeTruthy();
  });
});

// ─── Taxable income ──────────────────────────────────────────────────────────

describe('taxPack — taxable income', () => {
  it('writes the subtraction out, and lands on the tax page’s figure', () => {
    const input = makeInput(richOptions());
    const pack = buildTaxPack(input);
    const s = packSection(pack, 'taxable-income')!;
    expect(s.lines.map(l => l.role)).toEqual(['add', 'subtract']);
    expect(s.total).toBe(input.taxableIncome);
    expect(sumOfLines(s.lines)).toBeCloseTo(input.taxableIncome!, 2);
  });

  it('sends each side back to the section it came from', () => {
    const s = packSection(makePack(richOptions()), 'taxable-income')!;
    expect(s.lines[0].drill).toEqual({ kind: 'section', id: 'income' });
    expect(s.lines[1].drill).toEqual({ kind: 'section', id: 'deductions' });
  });

  it('floors at nil when deductions exceed income, and says the excess is not a refund', () => {
    const pack = makePack({
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Side work', amount: 4_000,
          date: '2025-01-10', status: 'approved', category: 'Business' } as any,
      ],
      manualDeductions: [deduction({ id: 'd1', amount: 9_000 })],
    });
    const s = packSection(pack, 'taxable-income')!;
    expect(s.total).toBe(0);
    const floored = s.lines.find(l => l.key === 'ti:floored')!;
    expect(floored.amount).toBeCloseTo(5_000, 2);
    expect(floored.detail).toMatch(/not a refund/i);
    // The check compares AFTER the floor, so a nil year still reconciles.
    expect(pack.checks.find(c => c.key === 'taxable-income')!.agrees).toBe(true);
  });
});

// ─── Tax, offsets, the loan, and the outcome ─────────────────────────────────

describe('taxPack — tax, offsets and the settlement', () => {
  it('takes the tax components straight from the settlement, marked as rates', () => {
    const input = makeInput(richOptions());
    const s = packSection(buildTaxPack(input), 'tax')!;
    expect(s.lines.map(l => l.label)).toEqual(input.settlement.liability.components.map(c => c.label));
    expect(s.lines.every(l => l.provenance === 'rates')).toBe(true);
    expect(s.total).toBe(input.settlement.liability.total);
    expect(sumOfLines(s.lines)).toBeCloseTo(s.total!, 2);
  });

  it('sends the study-loan liability to the schedule that explains its income base', () => {
    const pack = makePack({ ...richOptions(), hasStudentLoan: true });
    const loanLine = packSection(pack, 'tax')!.lines.find(l => l.key === 'tax:study-loan')!;
    expect(loanLine.drill).toEqual({ kind: 'section', id: 'student-loan' });
  });

  it('itemises repayment income, and says which parts are outside taxable income', () => {
    const pack = makePack({
      ...richOptions(),
      hasStudentLoan: true,
      adjustments: { reportableSuperContributions: 12_000 },
    });
    const s = packSection(pack, 'student-loan')!;
    const superLine = s.lines.find(l => l.key === 'help:reportableSuperContributions')!;
    expect(superLine.amount).toBe(12_000);
    expect(superLine.provenance).toBe('entered');
    expect(superLine.detail).toMatch(/not inside taxable income/i);
    expect(pack.checks.find(c => c.key === 'student-loan')!.agrees).toBe(true);
  });

  it('excludes an FHSS release from repayment income as a subtraction', () => {
    const pack = makePack({
      payslips: [payslip()], hasStudentLoan: true,
      adjustments: { assessableFHSSReleased: 8_000 },
    });
    const s = packSection(pack, 'student-loan')!;
    const fhss = s.lines.find(l => l.key === 'help:assessableFHSSReleased')!;
    expect(fhss.role).toBe('subtract');
    expect(fhss.detail).toMatch(/excluded from repayment income/i);
    expect(s.total).toBeCloseTo(120_000 - 8_000, 2);
  });

  it('skips the loan schedule, and its check, when there is no loan', () => {
    const pack = makePack(richOptions());
    expect(packSection(pack, 'student-loan')!.empty).toBe(true);
    expect(pack.checks.find(c => c.key === 'student-loan')!.skipped).toBeTruthy();
  });

  it('shows offsets as a positive total, and the settlement does the subtracting', () => {
    const input = makeInput({
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Part-time', amount: 25_000,
          date: '2025-01-10', status: 'approved', category: 'Salary' } as any,
      ],
    });
    const pack = buildTaxPack(input);
    const offsets = packSection(pack, 'offsets')!;
    expect(offsets.total).toBe(input.settlement.offsets.total);
    expect(offsets.lines.filter(l => l.role === 'add').length).toBeGreaterThan(0);
    expect(packSection(pack, 'settlement')!.lines.find(l => l.key === 'net:offsets')!.role)
      .toBe('subtract');
  });

  it('explains the surcharge tier and what it was tested on', () => {
    const pack = makePack({
      payslips: [payslip({ ytd_gross: 200_000, ytd_tax: 60_000 })],
      profile: { hospitalCover: 'none' },
    });
    const surcharge = packSection(pack, 'offsets')!.lines
      .find(l => l.key === 'off:surcharge-basis')!;
    expect(surcharge.amount).toBeGreaterThan(0);
    expect(surcharge.detail).toMatch(/income for surcharge purposes/i);
    expect(surcharge.detail).toMatch(/threshold/i);
  });

  it('ends on the settlement’s own number, and the arithmetic reaches it', () => {
    const input = makeInput(richOptions());
    const pack = buildTaxPack(input);
    const s = packSection(pack, 'settlement')!;
    expect(s.total).toBe(input.settlement.net);
    expect(sumOfLines(s.lines)).toBeCloseTo(input.settlement.net!, 2);
    expect(pack.outcome).toBe(input.settlement.outcome);
    expect(pack.refund).toBe(input.settlement.refund);
    expect(pack.owing).toBe(input.settlement.owing);
  });

  it('marks PAYG as derived and a typed credit as entered, on the same list', () => {
    const pack = makePack({ ...richOptions(), credits: { paygInstalments: 4_000 } });
    const lines = packSection(pack, 'settlement')!.lines;
    expect(lines.find(l => l.key === 'net:payg-withheld')!.provenance).toBe('derived');
    expect(lines.find(l => l.key === 'net:paygInstalments')!.provenance).toBe('entered');
  });
});

// ─── Reconciliation ──────────────────────────────────────────────────────────

describe('taxPack — reconciliation to the Tax page', () => {
  it('reconciles on a full year, with every check either agreeing or skipped', () => {
    const pack = makePack({ ...richOptions(), hasStudentLoan: true,
      credits: { paygInstalments: 500 } });
    expect(pack.reconciles).toBe(true);
    for (const c of pack.checks) expect(c.agrees, c.key).toBe(true);
    expect(pack.checks.filter(c => !c.skipped).length).toBeGreaterThanOrEqual(8);
  });

  it('reconciles on an empty year too', () => {
    expect(makePack().reconciles).toBe(true);
  });

  it('compares each section against the engine figure it claims to represent', () => {
    const input = makeInput(richOptions());
    const pack = buildTaxPack(input);
    const check = (k: string) => pack.checks.find(c => c.key === k)!;
    expect(check('income').page)
      .toBeCloseTo(input.position.assessableIncome + input.grossUp, 2);
    expect(check('deductions').page).toBe(input.position.deductibleExpenses);
    expect(check('withholding').page).toBe(input.position.taxWithheld);
    expect(check('tax').page).toBe(input.settlement.liability.total);
    expect(check('settlement').page).toBe(input.settlement.net);
  });

  it('fails loudly when the document stops matching the position it came from', () => {
    const input = makeInput(richOptions());
    // Exactly the drift the checks exist for: the position says one thing, the
    // lines the pack is displaying add to another.
    const pack = buildTaxPack({
      ...input,
      position: { ...input.position, assessableIncome: input.position.assessableIncome + 1_000 },
    });
    expect(pack.reconciles).toBe(false);
    const failed = pack.checks.filter(c => !c.agrees);
    expect(failed.map(c => c.key)).toContain('income');
    expect(failed[0].pack).not.toBe(failed[0].page);
  });

  it('tolerates a cent of rounding and nothing more', () => {
    const input = makeInput(richOptions());
    const nudge = (by: number) => buildTaxPack({
      ...input,
      position: { ...input.position, assessableIncome: input.position.assessableIncome + by },
    }).checks.find(c => c.key === 'income')!.agrees;
    expect(nudge(RECONCILE_TOLERANCE)).toBe(true);
    expect(nudge(0.05)).toBe(false);
  });

  it('never counts a skipped check as a pass in disguise', () => {
    const pack = makePack({ payslips: [payslip()] });
    const skipped = pack.checks.filter(c => c.skipped);
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of skipped) {
      expect(c.pack).toBeNull();
      expect(c.page).toBeNull();
      expect(c.skipped).toMatch(/\w/);
    }
  });
});

// ─── Unsupported years ───────────────────────────────────────────────────────

describe('taxPack — a year Ledger holds no rates for', () => {
  const UNSUPPORTED = '2015-2016';
  const oldYear = (): FixtureOptions => ({
    fy: UNSUPPORTED,
    payslips: [payslip({ payment_date: '2016-06-15', ytd_gross: 80_000, ytd_tax: 18_000 })],
    manualDeductions: [deduction({ id: 'd1', date: '2016-02-01' })],
  });

  it('still produces the year’s own income, withholding and deductions', () => {
    const pack = makePack(oldYear());
    expect(packSection(pack, 'income')!.total).toBe(80_000);
    expect(packSection(pack, 'withholding')!.total).toBe(18_000);
    expect(packSection(pack, 'deductions')!.total).toBe(1_200);
    expect(pack.taxableIncome).toBe(78_800);
  });

  it('leaves the tax, offset and settlement sections empty, and says why', () => {
    const pack = makePack(oldYear());
    for (const id of ['tax', 'offsets', 'settlement'] as const) {
      const s = packSection(pack, id)!;
      expect(s.empty, id).toBe(true);
      expect(s.total, id).toBeNull();
      expect(s.note, id).toMatch(/rates/i);
    }
  });

  it('skips the rate-dependent checks rather than failing them', () => {
    const pack = makePack(oldYear());
    for (const key of ['tax', 'offsets', 'settlement']) {
      const c = pack.checks.find(x => x.key === key)!;
      expect(c.skipped, key).toMatch(/no rates/i);
      expect(c.agrees, key).toBe(true);
    }
    expect(pack.reconciles).toBe(true);
  });

  it('checks the parts that do not need rates, exactly as usual', () => {
    const pack = makePack(oldYear());
    for (const key of ['income', 'deductions', 'withholding', 'taxable-income']) {
      const c = pack.checks.find(x => x.key === key)!;
      expect(c.skipped, key).toBeNull();
      expect(c.agrees, key).toBe(true);
    }
  });

  it('reports no outcome rather than a plausible wrong one', () => {
    const pack = makePack(oldYear());
    expect(pack.ratesAvailable).toBe(false);
    expect(pack.outcome).toBe('unknown');
    expect(pack.refund).toBe(0);
    expect(pack.owing).toBe(0);
  });

  it('flags an indexed-estimate year as an estimate, not a legislated rate', () => {
    const pack = makePack({ fy: '2027-2028', payslips: [
      payslip({ payment_date: '2028-06-15', ytd_gross: 120_000, ytd_tax: 30_000 }),
    ] });
    expect(pack.ratesAvailable).toBe(true);
    expect(pack.confidence).toBe('indexed-estimate');
    expect(pack.rateNotes.length).toBeGreaterThan(0);
  });
});

// ─── Missing data ────────────────────────────────────────────────────────────

describe('taxPack — missing data', () => {
  it('says plainly when the year holds nothing at all', () => {
    const pack = makePack();
    const gap = pack.gaps.find(g => g.key === 'empty-year')!;
    expect(gap.severity).toBe('warn');
    expect(gap.message).toMatch(/nothing to lodge/i);
  });

  it('does not cry "empty" on a year that has records', () => {
    expect(makePack(richOptions()).gaps.some(g => g.key === 'empty-year')).toBe(false);
  });

  it('gathers the engines’ own warnings instead of inventing its own', () => {
    const pack = makePack({
      ...richOptions(),
      // No lender statement, so the rental engine has something to say about the
      // largest deduction on the property.
      profile: { hospitalCover: 'none' },
    });
    expect(pack.gaps.some(g => g.key.startsWith('rental:'))).toBe(true);
    expect(pack.gaps.length).toBeGreaterThan(0);
  });

  it('puts what needs doing above what is merely worth knowing', () => {
    const severities = makePack({ ...richOptions(), profile: { hospitalCover: 'none' } })
      .gaps.map(g => g.severity);
    const firstInfo = severities.indexOf('info');
    if (firstInfo >= 0) expect(severities.slice(firstInfo)).not.toContain('warn');
  });

  it('never says the same thing twice', () => {
    const messages = makePack(richOptions()).gaps.map(g => g.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('counts the figures that were typed rather than derived', () => {
    const pack = makePack({
      payslips: [payslip()],
      credits: { paygInstalments: 2_000 },
      manualDeductions: [deduction({ id: 'd1' })],
    });
    const gap = pack.gaps.find(g => g.key === 'entered-figures')!;
    expect(gap.count).toBeGreaterThanOrEqual(2);
    expect(gap.message).toMatch(/entered/i);
  });

  it('raises a pending income entry as something to resolve', () => {
    const pack = makePack({
      payslips: [payslip()],
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Consulting', amount: 5_000,
          date: '2025-01-10', status: 'pending', category: 'Business' } as any,
      ],
    });
    const gap = pack.gaps.find(g => g.key.endsWith('pending-income'))!;
    expect(gap.severity).toBe('warn');
    expect(gap.message).toMatch(/pending income/i);
  });

  it('raises a possible duplicate deduction against the deductions section', () => {
    const pack = makePack({
      payslips: [payslip()],
      manualDeductions: [deduction({ id: 'd1', amount: 600, date: '2025-03-01', name: 'Xero' })],
      transactions: [tx({ id: 't1', amount: -600, date: '2025-03-01', merchant: 'Xero',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any)],
    });
    const gap = pack.gaps.find(g => g.key === 'note:duplicate')!;
    expect(gap.severity).toBe('warn');
    expect(gap.section).toBe('deductions');
  });
});

// ─── Several financial years ─────────────────────────────────────────────────

describe('taxPack — several financial years', () => {
  const spanning = (fy: string): FixtureOptions => ({
    fy,
    transactions: [
      tx({ id: 'a', amount: -500, date: '2024-06-30', merchant: 'June expense',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
      tx({ id: 'b', amount: -700, date: '2024-07-01', merchant: 'July expense',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
      tx({ id: 'c', amount: -900, date: '2025-06-30', merchant: 'Last day',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
      tx({ id: 'd', amount: -1_100, date: '2025-07-01', merchant: 'Next year',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
    ],
  });

  it('puts 30 June and 1 July on the right sides of the boundary', () => {
    expect(packSection(makePack(spanning('2023-2024')), 'deductions')!.total).toBe(500);
    expect(packSection(makePack(spanning('2024-2025')), 'deductions')!.total).toBe(1_600);
    expect(packSection(makePack(spanning('2025-2026')), 'deductions')!.total).toBe(1_100);
  });

  it('stamps each pack with its own period', () => {
    expect(makePack({ fy: '2023-2024' }).start).toBe('2023-07-01');
    expect(makePack({ fy: '2023-2024' }).end).toBe('2024-06-30');
    expect(makePack({ fy: '2025-2026' }).start).toBe('2025-07-01');
  });

  it('assesses each year on its own scale', () => {
    const income = (fy: string) => ({
      fy,
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Contract', amount: 90_000,
          date: `${fy.slice(0, 4)}-09-01`, status: 'approved', category: 'Business' } as any,
      ],
    });
    const before = packSection(makePack(income('2023-2024')), 'tax')!.total!;
    const after = packSection(makePack(income('2024-2025')), 'tax')!.total!;
    // The stage-3 rescale cut the tax on $90,000 — same income, different year.
    expect(after).toBeLessThan(before);
  });

  it('carries a capital loss into the next year’s pack rather than the same one', () => {
    const loss: CgtDisposal = {
      id: 'l', investmentId: null, label: 'Loser', ticker: 'L', assetType: 'stock',
      quantity: 10, proceeds: 500, fees: 0, costBase: 3_000,
      acquiredDate: '2023-09-01', saleDate: '2024-03-02', currency: 'AUD',
    };
    const gain: CgtDisposal = {
      id: 'g', investmentId: null, label: 'Winner', ticker: 'W', assetType: 'stock',
      quantity: 10, proceeds: 4_000, fees: 0, costBase: 2_000,
      acquiredDate: '2024-08-01', saleDate: '2025-03-02', currency: 'AUD',
    };
    const first = makePack({ fy: '2023-2024', disposals: [loss, gain] });
    const second = makePack({ fy: '2024-2025', disposals: [loss, gain] });
    expect(packSection(first, 'capital-gains')!.total).toBe(0);
    expect(packSection(first, 'capital-gains')!.lines
      .find(l => l.key === 'cgt:carried-forward')!.amount).toBeCloseTo(2_500, 2);
    // The next year meets the same loss as brought-forward, not as its own.
    expect(packSection(second, 'capital-gains')!.lines
      .find(l => l.key === 'cgt:brought-forward')!.amount).toBeCloseTo(2_500, 2);
    expect(packSection(second, 'capital-gains')!.total).toBe(0);
  });

  it('reconciles in every year it is asked about', () => {
    for (const fy of ['2022-2023', '2023-2024', '2024-2025', '2025-2026', '2015-2016']) {
      expect(makePack({ ...richOptions(), fy }).reconciles, fy).toBe(true);
    }
  });
});

// ─── Exports ─────────────────────────────────────────────────────────────────

const rows = (csv: string) => csv.split('\n');

describe('taxPackToCsv', () => {
  it('leads with the year, the period and how it was prepared', () => {
    const csv = taxPackToCsv(makePack(richOptions()));
    expect(csv).toContain('Ledger tax pack');
    expect(csv).toContain('FY 2024–25');
    expect(csv).toContain('2024-07-01 to 2025-06-30');
    expect(csv).toContain(PREPARED);
    expect(csv).toContain('Test Taxpayer');
  });

  it('states whether the pack reconciles, in words, near the top', () => {
    expect(taxPackToCsv(makePack(richOptions()))).toMatch(/Reconciles to the Tax page,Yes/);
    const input = makeInput(richOptions());
    const broken = buildTaxPack({
      ...input,
      position: { ...input.position, assessableIncome: 1 },
    });
    expect(taxPackToCsv(broken)).toMatch(/Reconciles to the Tax page,NO/);
    expect(taxPackToCsv(broken)).toContain('DOES NOT AGREE');
  });

  it('writes every check with both sides of the comparison', () => {
    const csv = taxPackToCsv(makePack(richOptions()));
    expect(csv).toContain('Reconciliation check,Pack,Tax page,Result');
    expect(csv).toMatch(/Income adds to assessable income,[\d.]+,[\d.]+,agrees/);
  });

  it('says a skipped check was not run, and why', () => {
    expect(taxPackToCsv(makePack({ payslips: [payslip()] })))
      .toMatch(/not run — No disposals this year/);
  });

  it('carries every line with its level, treatment and provenance', () => {
    const csv = taxPackToCsv(makePack(richOptions()));
    expect(csv).toContain('Section,Section role,Level,Line,Date,Amount,Treatment,Source,Detail,Drills to');
    expect(csv).toContain('entered by you');
    expect(csv).toContain('ATO rates for the year');
    expect(csv).toContain('derived from your records');
  });

  it('closes each section with its own total row', () => {
    const csv = taxPackToCsv(makePack(richOptions()));
    expect(csv).toMatch(/Income,return,0,Total assessable income,,[\d.]+,total/);
    expect(csv).toMatch(/Deductions,return,0,Total deductions,,[\d.]+,total/);
  });

  it('writes the amount column as bare numbers a spreadsheet can add', () => {
    const csv = taxPackToCsv(makePack(richOptions()));
    expect(csv).toMatch(/,31200\.00,/);
    // Only the AMOUNT column has to be bare — a detail line is prose, and prose
    // about money reads better with the currency in it.
    const amounts = rows(csv)
      .filter(r => /^(Income|Deductions|Rental properties),(return|schedule),\d,/.test(r))
      .map(r => r.split(',')[5]);
    expect(amounts.length).toBeGreaterThan(5);
    for (const a of amounts) expect(a, a).toMatch(/^-?\d+\.\d{2}$/);
  });

  it('lists the open questions at the end', () => {
    const csv = taxPackToCsv(makePack(richOptions()));
    expect(csv).toContain('For your accountant,Severity,Section,Amount,Count');
  });

  it('says "nothing outstanding" rather than leaving the block blank', () => {
    const pack = makePack(richOptions());
    const csv = taxPackToCsv({ ...pack, gaps: [] });
    expect(csv).toContain('Nothing outstanding.');
  });

  it('quotes a field containing a comma, and doubles an embedded quote', () => {
    const pack = makePack({
      manualDeductions: [deduction({ id: 'd1', name: 'Desk, chair and a "riser"' })],
    });
    const csv = taxPackToCsv(pack);
    expect(csv).toContain('"Desk, chair and a ""riser"""');
  });

  it('defuses a merchant name a spreadsheet would run as a formula', () => {
    const pack = makePack({
      manualDeductions: [deduction({ id: 'd1', name: '=HYPERLINK("http://x","click")' })],
    });
    const csv = taxPackToCsv(pack);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('keeps a newline inside a quoted field instead of breaking the row', () => {
    const pack = makePack({ manualDeductions: [deduction({ id: 'd1', name: 'Line one\nLine two' })] });
    expect(taxPackToCsv(pack)).toContain('"Line one\nLine two"');
  });
});

describe('taxPackSourcesToCsv', () => {
  it('emits leaves only, so the amounts never overlap', () => {
    const csv = taxPackSourcesToCsv(makePack(richOptions()));
    // "Rent received" is a heading over twelve payments; the payments are rows,
    // it is not.
    expect(csv).toContain('Rent received');           // as the Heading column
    expect(csv).not.toMatch(/,Rent received,,/);      // never as the Record column
  });

  it('carries the heading path so a row can be placed without the pack', () => {
    const csv = taxPackSourcesToCsv(makePack(richOptions()));
    expect(csv).toMatch(/Rental properties,Bondi › Rent received,/);
  });

  it('puts the transaction id in its own column for the rows that have one', () => {
    const csv = taxPackSourcesToCsv(makePack(richOptions()));
    const header = rows(csv).find(r => r.startsWith('Section,Heading,'))!;
    expect(header).toContain('Transaction ID');
    expect(csv).toMatch(/,r0,/);
  });

  it('marks an uncounted record as not counted rather than dropping it', () => {
    const pack = makePack({
      payslips: [payslip()],
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Consulting', amount: 5_000,
          date: '2025-01-10', status: 'pending', category: 'Business' } as any,
      ],
    });
    const row = rows(taxPackSourcesToCsv(pack)).find(r => r.includes('Consulting'))!;
    expect(row).toContain(',info,no,');
  });

  it('adds the counted income rows back to assessable income', () => {
    const pack = makePack(richOptions());
    const total = rows(taxPackSourcesToCsv(pack))
      .filter(r => r.startsWith('Income,'))
      .map(r => r.split(','))
      // Amount is column 5 (0-indexed 4) and Counted is column 7.
      .filter(c => c[6] === 'yes')
      .reduce((s, c) => s + Number(c[4] || 0), 0);
    expect(total).toBeCloseTo(packSection(pack, 'income')!.total!, 2);
  });

  it('names itself for the year it covers', () => {
    const pack = makePack(richOptions());
    expect(taxPackFilename(pack, 'pack')).toBe('ledger-tax-pack-fy-2024-2025.csv');
    expect(taxPackFilename(pack, 'sources')).toBe('ledger-tax-sources-fy-2024-2025.csv');
  });
});

describe('taxPackToHtml', () => {
  const html = (pack: TaxPack, detail: 'summary' | 'full' = 'summary') =>
    taxPackToHtml(pack, { currency: 'AUD', detail });

  it('is a complete, standalone document', () => {
    const doc = html(makePack(richOptions()));
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('</html>');
    expect(doc).toContain('<style>');
    // Nothing to fetch and nothing to run: it must print the same everywhere.
    expect(doc).not.toContain('<script');
    expect(doc).not.toMatch(/src=["']http/);
  });

  it('leads with the outcome, not with a table', () => {
    const doc = html(makePack(richOptions()));
    expect(doc).toMatch(/class="headline">Estimated (refund|\$)/);
  });

  it('carries every section heading', () => {
    const doc = html(makePack(richOptions()));
    for (const title of ['Income', 'PAYG withholding', 'Deductions',
      'Capital gains and losses', 'Dividends and franking credits',
      'Rental properties', 'Taxable income', 'Tax on your taxable income',
      'Tax offsets', 'Estimated refund or amount owing']) {
      expect(doc, title).toContain(`>${title}`);
    }
  });

  it('says the pack reconciles when it does, and refuses to bury it when it does not', () => {
    expect(html(makePack(richOptions()))).toContain('class="ok"');
    const input = makeInput(richOptions());
    const broken = buildTaxPack({
      ...input, position: { ...input.position, assessableIncome: 1 },
    });
    const doc = html(broken);
    expect(doc).toContain('This pack does not reconcile');
    expect(doc).toContain('do not lodge');
  });

  it('marks an entered figure so it cannot pass for a derived one', () => {
    const doc = html(makePack({ payslips: [payslip()], credits: { paygInstalments: 2_000 } }));
    expect(doc).toContain('prov-entered');
  });

  it('prints the headings by default and the whole audit trail on request', () => {
    const pack = makePack(richOptions());
    const summary = html(pack, 'summary');
    const full = html(pack, 'full');
    expect(full.length).toBeGreaterThan(summary.length);
    // A rent payment is three levels down: only the full document has it.
    expect(summary).not.toContain('Ray White</span>');
    expect(full).toContain('Ray White');
  });

  it('escapes a merchant name that looks like markup', () => {
    const pack = makePack({
      manualDeductions: [deduction({ id: 'd1', name: '<img src=x onerror=alert(1)>' })],
    });
    const doc = html(pack);
    expect(doc).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(doc).not.toContain('<img src=x');
  });

  it('says on the page that it is an estimate and not a lodgement', () => {
    const doc = html(makePack(richOptions()));
    expect(doc).toMatch(/not a lodgement/i);
    expect(doc).toMatch(/not tax advice/i);
  });

  it('says outright when a year has no rates instead of printing a blank bill', () => {
    const doc = html(makePack({
      fy: '2015-2016',
      payslips: [payslip({ payment_date: '2016-06-15', ytd_gross: 80_000, ytd_tax: 18_000 })],
    }));
    expect(doc).toMatch(/no rates held for this year/i);
    expect(doc).toContain('Outcome not estimated for this year');
  });

  it('formats money in the user’s own currency', () => {
    const pack = makePack(richOptions());
    expect(taxPackToHtml(pack, { currency: 'USD' })).toMatch(/USD\s?[\d,]/);
    expect(taxPackToHtml(pack, { currency: 'AUD' })).toMatch(/\$[\d,]/);
  });
});

describe('taxPack — one warning, one line', () => {
  it('does not restate a warning a later engine re-raised in its own words', () => {
    const pack = makePack({
      payslips: [payslip()],
      incomeEntries: [
        { id: 'ie1', user_id: 'u1', source: 'Consulting', amount: 5_000,
          date: '2025-01-10', status: 'pending', category: 'Business' } as any,
      ],
    });
    // The settlement re-raises the FY position's own pending-income note; the
    // reader should be told once, by whichever is closest to the outcome.
    const pending = pack.gaps.filter(g => g.key.endsWith('pending-income'));
    expect(pending).toHaveLength(1);
    expect(pending[0].key).toBe('settlement:pending-income');
  });
});

describe('taxPack — wording that could mislead', () => {
  it('does not report an unanswered hospital-cover question as being covered', () => {
    const pack = makePack({ payslips: [payslip({ ytd_gross: 200_000, ytd_tax: 60_000 })] });
    const line = packSection(pack, 'offsets')!.lines
      .find(l => l.key === 'off:surcharge-basis')!;
    expect(line.detail).toMatch(/not answered/i);
    expect(line.detail).not.toMatch(/covered all year/i);
    // And it names what the silence could cost.
    expect(line.detail).toMatch(/a full year without it would add/i);
  });

  it('says "covered all year" only when the user actually said so', () => {
    const pack = makePack({
      payslips: [payslip({ ytd_gross: 200_000, ytd_tax: 60_000 })],
      profile: { hospitalCover: 'full-year' },
    });
    expect(packSection(pack, 'offsets')!.lines
      .find(l => l.key === 'off:surcharge-basis')!.detail).toMatch(/covered all year/i);
  });

  it('keeps an acronym intact in the credit lines, and lowers an ordinary word', () => {
    const labels = packSection(
      makePack({ ...richOptions(), credits: { otherTaxPaid: 200 } }), 'settlement',
    )!.lines.map(l => l.label);
    expect(labels).toContain('Less PAYG withheld');
    expect(labels).toContain('Less franking credits');
    expect(labels).toContain('Less other tax paid or withheld');
    expect(labels.some(l => /payg withheld/.test(l))).toBe(false);
  });

  it('calls a statement-backed franking credit derived on both sides of the return', () => {
    const pack = makePack(richOptions());
    const credit = packSection(pack, 'settlement')!.lines
      .find(l => l.key === 'net:frankingCredits')!;
    expect(credit.provenance).toBe('derived');
    expect(credit.drill).toEqual({ kind: 'section', id: 'dividends' });
    // The same figure it was grossed up by, and marked the same way.
    expect(packSection(pack, 'income')!.lines
      .find(l => l.key === 'income:franking-gross-up')!.provenance).toBe('derived');
  });

  it('calls a typed franking credit entered on both sides of the return', () => {
    const pack = makePack({ payslips: [payslip()], credits: { frankingCredits: 450 } });
    expect(packSection(pack, 'settlement')!.lines
      .find(l => l.key === 'net:frankingCredits')!.provenance).toBe('entered');
    expect(packSection(pack, 'income')!.lines
      .find(l => l.key === 'income:franking-gross-up')!.provenance).toBe('entered');
  });
});
