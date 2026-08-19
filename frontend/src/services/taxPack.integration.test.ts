/**
 * Phase 5.6 — the accountant pack, against the real Tax page.
 *
 * utils/taxPack.test.ts proves the pack re-presents its inputs correctly. What
 * it cannot prove is that those inputs are the ones the PAGE has: it builds the
 * position with a hand-written harness, and a harness can drift from the screen
 * it is imitating.
 *
 * So these tests run the page's own pipeline — the store, taxYearDS, the real
 * calculateTax, the real settlement and offsets — and then check that every
 * headline figure in the pack is the identical number the Tax page renders.
 * That is what "reconciles to the Tax page" has to mean to be worth anything.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomeEntry, Loan, Property, Transaction } from '../types';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import {
  calculateTax, deductionsDS, rentalTaxDS, taxCreditsDS, taxYearDS,
} from './dataService';
import { buildTaxSettlement } from '../utils/taxSettlement';
import { buildOffsetPosition } from '../utils/taxOffsets';
import { emptyTaxProfile } from '../utils/taxProfile';
import { emptyTaxCredits } from '../utils/taxCredits';
import { grossUpFor } from '../utils/taxCredits';
import {
  repaymentIncomeFrom, emptyRepaymentIncomeAdjustments,
  type RepaymentIncomeAdjustments,
} from '../utils/repaymentIncome';
import { emptyRentalSettings, type RentalPropertySettings } from '../utils/rentalProperty';
import { buildTaxPack, packSection, type TaxPack } from '../utils/taxPack';
import { taxPackToCsv, taxPackSourcesToCsv } from '../utils/taxPackExport';
import type { PayslipCore } from '../utils/payroll';

const ME = 'user-ME';
const FY = '2024-2025';
const PREPARED = '2026-08-19';

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  user_id: ME, account_id: 'acc1', account_type: 'bank',
  date: '2024-12-01', merchant: 'Something', category: 'Other', currency: 'AUD',
  ...o,
} as Transaction);

const payslip = (o: Partial<PayslipCore> = {}): PayslipCore => ({
  employer: 'Acme Pty Ltd', employment_type: 'full-time', pay_frequency: 'monthly',
  payment_date: '2025-06-15', gross_pay: 10_000, net_pay: 7_000,
  tax_withheld: 3_000, super_amount: 1_150, ytd_gross: 120_000, ytd_tax: 30_000,
  ...o,
});

const property = (o: Partial<Property> & { id: string }): Property => ({
  user_id: ME, name: 'Bondi', property_type: 'investment',
  purchase_price: 800_000, purchase_date: '2018-03-01', current_value: 1_000_000,
  ownership_percent: 100, rent_match_terms: ['ray white'],
  property_expenses: [{ id: 'e1', name: 'Strata Plus', kind: 'strata', match_terms: ['strata plus'] }],
  ...o,
} as Property);

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: ME, name: 'Bondi mortgage', loan_type: 'mortgage',
  original_amount: 700_000, current_balance: 620_000, interest_rate: 6.1,
  minimum_repayment: 3_400, repayment_frequency: 'monthly',
  ...o,
} as Loan);

function seed(o: {
  transactions?: Transaction[];
  properties?: Property[];
  loans?: Loan[];
  incomeEntries?: IncomeEntry[];
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com', name: 'Harry Test' } as any,
    transactions: o.transactions ?? [],
    properties: o.properties ?? [],
    loans: o.loans ?? [],
    incomeEntries: o.incomeEntries ?? [],
    investments: [], investmentSales: [],
    merchants: [], merchantAliases: [], customCategories: [], transactionRules: [],
  } as any);
}

/**
 * pages/Tax.tsx, minus the JSX. Every line here has a counterpart in the render
 * path, in the same order, using the same functions — which is the point: the
 * pack is handed the objects the page renders, so `page` below IS the screen.
 */
function renderTaxPage(opts: {
  fy?: string;
  payslips?: PayslipCore[];
  hasStudentLoan?: boolean;
  adjustments?: Partial<RepaymentIncomeAdjustments>;
} = {}) {
  const fy = opts.fy ?? FY;
  const payslips = opts.payslips ?? [];
  const position = taxYearDS.build({ fy, payslips });

  const credits = taxCreditsDS.forFY(fy);
  const dividends = position.income.dividends;
  const effectiveCredits = dividends
    ? { ...credits, frankingCredits: dividends.effectiveFrankingCredit }
    : credits;
  const grossUp = grossUpFor(effectiveCredits);

  const loanAdjustments: RepaymentIncomeAdjustments = {
    ...emptyRepaymentIncomeAdjustments(), ...opts.adjustments,
  };
  const derivedLoss = position.income.rental?.netRentalLoss ?? 0;
  const effectiveAdjustments = derivedLoss > 0
    ? { ...loanAdjustments,
        totalNetInvestmentLoss: Math.max(loanAdjustments.totalNetInvestmentLoss, derivedLoss) }
    : loanAdjustments;

  const taxData = calculateTax(opts.hasStudentLoan ?? false, {
    fy,
    total_income: position.assessableIncome + grossUp,
    tax_withheld: position.taxWithheld,
    total_deductions: position.deductions.total,
    repayment_income_adjustments: effectiveAdjustments,
  });
  const repayment = repaymentIncomeFrom(taxData.total_income, effectiveAdjustments);

  const offsets = buildOffsetPosition({
    fy,
    taxableIncome: taxData.total_income,
    incomeTax: taxData.income_tax ?? 0,
    adjustments: effectiveAdjustments,
    profile: emptyTaxProfile(),
  });

  const settlement = buildTaxSettlement({
    position,
    tax: {
      ratesAvailable: taxData.rates_available,
      taxableIncome: taxData.total_income,
      incomeTax: taxData.income_tax,
      medicareLevy: taxData.medicare_levy,
      studentLoanRepayment: taxData.hecs_repayment,
      confidence: taxData.rates_confidence,
      notes: taxData.rates_notes,
    },
    credits: effectiveCredits,
    offsets,
    asOf: PREPARED,
  });

  const pack = buildTaxPack({
    position, settlement, offsets, repayment,
    hasStudentLoan: opts.hasStudentLoan ?? false,
    currency: 'AUD',
    grossUp,
    taxableIncome: taxData.total_income,
    preparedOn: PREPARED,
    taxpayer: 'Harry Test',
  });

  return { position, taxData, settlement, offsets, repayment, grossUp, pack };
}

/** A year with something of everything in it. */
function seedRichYear() {
  const rent = Array.from({ length: 12 }, (_, i) => tx({
    id: `r${i}`, amount: 2_600, merchant: 'Ray White', category: 'Rent',
    date: `${i < 6 ? 2024 : 2025}-${String(((i + 6) % 12) + 1).padStart(2, '0')}-05`,
  }));
  seed({
    properties: [property({ id: 'p1' })],
    loans: [loan()],
    transactions: [
      ...rent,
      tx({ id: 'x1', amount: -1_400, date: '2024-09-10', merchant: 'Strata Plus',
        category: 'Property' }),
      tx({ id: 'sw', amount: -600, date: '2025-03-01', merchant: 'Xero',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
    ],
  });
  deductionsDS.add({ name: 'Work laptop', amount: 1_200, category: 'Equipment',
    date: '2025-02-01' } as any);
}

beforeEach(() => {
  localStorage.clear();
  seed();
});

// ─── The pack is the page ────────────────────────────────────────────────────

describe('tax pack — reconciliation to the Tax page', () => {
  it('shows the same assessable income, deductions and withholding as the page', () => {
    seedRichYear();
    const { position, pack, grossUp } = renderTaxPage({ payslips: [payslip()] });
    expect(packSection(pack, 'income')!.total)
      .toBeCloseTo(position.assessableIncome + grossUp, 2);
    expect(packSection(pack, 'deductions')!.total).toBe(position.deductibleExpenses);
    expect(packSection(pack, 'withholding')!.total).toBe(position.taxWithheld);
  });

  it('shows the same taxable income the tax calculation was run on', () => {
    seedRichYear();
    const { taxData, pack } = renderTaxPage({ payslips: [payslip()] });
    expect(pack.taxableIncome).toBe(taxData.total_income);
    expect(packSection(pack, 'taxable-income')!.total).toBe(taxData.total_income);
  });

  it('shows the same tax, offsets and final position as the settlement card', () => {
    seedRichYear();
    const { settlement, pack } = renderTaxPage({ payslips: [payslip()] });
    expect(packSection(pack, 'tax')!.total).toBe(settlement.liability.total);
    expect(packSection(pack, 'offsets')!.total).toBe(settlement.offsets.total);
    expect(packSection(pack, 'settlement')!.total).toBe(settlement.net);
    expect(pack.outcome).toBe(settlement.outcome);
    expect(pack.refund).toBe(settlement.refund);
    expect(pack.owing).toBe(settlement.owing);
  });

  it('reconciles every check when built from the real page pipeline', () => {
    seedRichYear();
    const { pack } = renderTaxPage({ payslips: [payslip()], hasStudentLoan: true });
    expect(pack.reconciles).toBe(true);
    for (const c of pack.checks) expect(c.agrees, c.key).toBe(true);
  });

  it('carries the rental schedule the Property tab and the Tax page agree on', () => {
    seedRichYear();
    const { position, pack } = renderTaxPage({ payslips: [payslip()] });
    const rental = position.income.rental!;
    expect(packSection(pack, 'rental')!.total).toBe(rental.netRent);
    expect(packSection(pack, 'rental')!.lines[0].label).toBe('Bondi');
  });

  it('does not count a strata levy twice when it is also ticked deductible', () => {
    seedRichYear();
    // The same payment, now also flagged on the transaction itself.
    useStore.setState({
      transactions: useStore.getState().transactions.map(t =>
        t.id === 'x1'
          ? ({ ...t, is_tax_deductible: true, deduction_category: 'Property' } as Transaction)
          : t),
    } as any);
    const { pack, position } = renderTaxPage({ payslips: [payslip()] });
    expect(pack.reconciles).toBe(true);
    // Once on the rental schedule, and nowhere else.
    const claimed = packSection(pack, 'deductions')!.lines
      .flatMap(l => l.children)
      .filter(l => l.label === 'Strata Plus' && l.role !== 'info');
    expect(claimed).toHaveLength(0);
    expect(position.deductions.countedInRental).toContain('x1');
  });
});

// ─── The rental loss leaving the tax calculation ─────────────────────────────

describe('tax pack — a negatively geared year', () => {
  it('reports the loss, the reduced tax and the added-back repayment income', () => {
    seedRichYear();
    const settings: RentalPropertySettings = {
      ...emptyRentalSettings(),
      byFY: {
        [FY]: { interestPaid: 45_000, interestPrivatePercent: 0,
          availableForRent: true, otherIncome: 0, otherDeductions: [] },
      },
    } as RentalPropertySettings;
    rentalTaxDS.save('p1', settings);

    const { pack, position, taxData } = renderTaxPage({
      payslips: [payslip()], hasStudentLoan: true,
    });
    const loss = position.income.rental!.netRentalLoss;
    expect(loss).toBeGreaterThan(0);

    // The loss is inside the deductions, so it reduces taxable income...
    expect(taxData.total_income).toBeLessThan(120_000);
    expect(packSection(pack, 'rental')!.totalLabel).toMatch(/net rental loss/i);

    // ...and the ATO adds it straight back for the loan.
    const help = packSection(pack, 'student-loan')!;
    const addBack = help.lines.find(l => l.key === 'help:totalNetInvestmentLoss')!;
    expect(addBack.amount).toBeCloseTo(loss, 2);
    expect(help.total).toBeCloseTo(taxData.total_income + loss, 2);
    expect(pack.reconciles).toBe(true);
  });
});

// ─── Several years out of one store ──────────────────────────────────────────

describe('tax pack — several financial years', () => {
  it('builds a different, self-consistent pack per year from the same records', () => {
    seed({
      transactions: [
        tx({ id: 'a', amount: -500, date: '2024-06-30', merchant: 'June',
          category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
        tx({ id: 'b', amount: -900, date: '2025-06-30', merchant: 'Last day',
          category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any),
      ],
    });
    const prior = renderTaxPage({ fy: '2023-2024' });
    const current = renderTaxPage({ fy: FY });

    expect(packSection(prior.pack, 'deductions')!.total).toBe(500);
    expect(packSection(current.pack, 'deductions')!.total).toBe(900);
    expect(prior.pack.start).toBe('2023-07-01');
    expect(current.pack.start).toBe('2024-07-01');
    expect(prior.pack.reconciles && current.pack.reconciles).toBe(true);
  });

  it('offers a pack for every year the switcher offers', () => {
    seedRichYear();
    for (const fy of taxYearDS.financialYears({ payslips: [payslip()] })) {
      const { pack } = renderTaxPage({ fy, payslips: [payslip()] });
      expect(pack.fy, fy).toBe(fy);
      expect(pack.reconciles, fy).toBe(true);
    }
  });
});

// ─── Missing data and unsupported years ──────────────────────────────────────

describe('tax pack — thin and unsupported years', () => {
  it('produces an honest empty pack for a year with nothing in it', () => {
    const { pack } = renderTaxPage({ fy: '2022-2023' });
    expect(pack.reconciles).toBe(true);
    expect(packSection(pack, 'income')!.empty).toBe(true);
    expect(pack.gaps.some(g => g.key === 'empty-year')).toBe(true);
    // And it still exports.
    expect(taxPackToCsv(pack)).toContain('Ledger tax pack');
  });

  it('keeps the year’s own records when Ledger holds no rates for it', () => {
    seed({
      transactions: [tx({ id: 'a', amount: -500, date: '2016-03-01', merchant: 'Old',
        category: 'Software', is_tax_deductible: true, deduction_category: 'Software' } as any)],
    });
    const { pack, taxData } = renderTaxPage({ fy: '2015-2016' });
    expect(taxData.rates_available).toBe(false);
    expect(packSection(pack, 'deductions')!.total).toBe(500);
    expect(packSection(pack, 'settlement')!.total).toBeNull();
    expect(pack.outcome).toBe('unknown');
    expect(pack.reconciles).toBe(true);
  });

  it('is built even with no payslips, no properties and no investments', () => {
    seed({
      incomeEntries: [
        { id: 'ie1', user_id: ME, source: 'Freelance', amount: 40_000,
          date: '2025-01-10', status: 'approved', category: 'Business' } as any,
      ],
    });
    const { pack } = renderTaxPage();
    expect(packSection(pack, 'income')!.total).toBe(40_000);
    expect(packSection(pack, 'capital-gains')!.empty).toBe(true);
    expect(packSection(pack, 'rental')!.empty).toBe(true);
    expect(pack.reconciles).toBe(true);
  });
});

// ─── The files ───────────────────────────────────────────────────────────────

describe('tax pack — exports carry the page’s figures', () => {
  let pack: TaxPack;
  beforeEach(() => {
    seedRichYear();
    pack = renderTaxPage({ payslips: [payslip()] }).pack;
  });

  it('writes the page’s taxable income into the spreadsheet', () => {
    expect(taxPackToCsv(pack)).toContain(`Taxable income,${pack.taxableIncome!.toFixed(2)}`);
  });

  it('writes every section total into the spreadsheet', () => {
    const csv = taxPackToCsv(pack);
    for (const s of pack.sections) {
      if (s.total == null) continue;
      expect(csv, s.id).toContain(`${s.totalLabel},,${s.total.toFixed(2)},total`);
    }
  });

  it('gives the source spreadsheet a row for every rent payment, with its id', () => {
    const csv = taxPackSourcesToCsv(pack);
    for (let i = 0; i < 12; i += 1) expect(csv).toContain(`,r${i},`);
  });

  it('does not carry one user’s rental settings onto another user’s pack', () => {
    rentalTaxDS.save('p1', {
      ...emptyRentalSettings(),
      byFY: { [FY]: { interestPaid: 45_000, interestPrivatePercent: 0,
        availableForRent: true, otherIncome: 0, otherDeductions: [] } },
    } as RentalPropertySettings);
    expect(packSection(renderTaxPage({ payslips: [payslip()] }).pack, 'rental')!.total)
      .toBeLessThan(0);

    // Same device, different user. The interest figure is one person's lender
    // statement: it is keyed to them, and neither it nor the property it
    // belongs to may appear on anybody else's pack.
    useStore.setState({ user: { id: 'user-OTHER', email: 'o@x.com', name: 'Other' } as any });
    expect(rentalTaxDS.settingsFor('p1').byFY).toEqual({});
    const other = renderTaxPage({ payslips: [payslip()] }).pack;
    expect(packSection(other, 'rental')!.empty).toBe(true);
    expect(packSection(other, 'rental')!.total).toBe(0);
    expect(other.reconciles).toBe(true);
  });
});
