/**
 * Phase 5.5 — rental property tax, end to end.
 *
 * The engine is unit-tested on its own (utils/rentalProperty.test.ts). These are
 * the things it CANNOT prove by itself — what only exists once the store, the
 * property attribution, the FY position and the tax calculation are wired up:
 *
 *   • a rent payment sitting in the ordinary transaction list reaches the Tax
 *     page without anybody tagging it as income;
 *   • the same strata levy is not claimed twice when the user also ticked "tax
 *     deductible" on it;
 *   • a net rental loss reduces the tax AND is added back for the study loan;
 *   • two properties never claim the same payment;
 *   • settings persist, and belong to one user.
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
import { calculateTax, rentalTaxDS, taxYearDS, deductionsDS } from './dataService';
import { emptyRentalSettings, type RentalPropertySettings } from '../utils/rentalProperty';
import { repaymentIncomeFrom, emptyRepaymentIncomeAdjustments } from '../utils/repaymentIncome';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const FY = '2024-2025';

const property = (o: Partial<Property> & { id: string }): Property => ({
  user_id: ME,
  name: 'Bondi',
  property_type: 'investment',
  purchase_price: 800_000,
  purchase_date: '2018-03-01',
  current_value: 1_000_000,
  ownership_percent: 100,
  rent_match_terms: ['ray white'],
  property_expenses: [{ id: 'e1', name: 'Strata Plus', kind: 'strata', match_terms: ['strata plus'] }],
  ...o,
} as Property);

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  user_id: ME, account_id: 'acc1', account_type: 'bank',
  date: '2024-12-01', merchant: 'Ray White', category: 'Rent', currency: 'AUD',
  ...o,
} as Transaction);

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: ME, name: 'Bondi mortgage', loan_type: 'mortgage',
  original_amount: 600_000, current_balance: 500_000, interest_rate: 6,
  minimum_repayment: 3_000, repayment_frequency: 'monthly',
  ...o,
} as Loan);

function seed(opts: {
  userId?: string;
  properties?: Property[];
  transactions?: Transaction[];
  loans?: Loan[];
  incomeEntries?: IncomeEntry[];
} = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    transactions: opts.transactions ?? [],
    properties: opts.properties ?? [],
    loans: opts.loans ?? [],
    incomeEntries: opts.incomeEntries ?? [],
    investments: [], investmentSales: [],
    merchants: [], merchantAliases: [], customCategories: [], transactionRules: [],
  } as any);
}

const RENT = tx({ id: 'rent1', amount: 24_000 });
const STRATA = tx({
  id: 'strata1', amount: -4_000, date: '2024-08-01',
  merchant: 'Strata Plus', category: 'Bills',
});

beforeEach(() => {
  localStorage.clear();
  seed();
});

// ─── An ordinary transaction becomes a rental schedule ───────────────────────

describe('rent in the transaction list reaches the Tax page', () => {
  it('needs no tagging at all — the property’s own rules find it', () => {
    seed({ properties: [property({ id: 'p1' })], transactions: [RENT, STRATA] });
    const p = taxYearDS.build({ fy: FY });
    expect(p.rental!.grossIncome).toBe(24_000);
    expect(p.rental!.totalDeductions).toBe(4_000);
    expect(p.assessableIncome).toBe(24_000);
    expect(p.deductibleExpenses).toBe(4_000);
    expect(p.estimatedTaxableIncome).toBe(20_000);
  });

  it('is taxed at the user’s own marginal rate, not a flat one', () => {
    seed({
      properties: [property({ id: 'p1' })],
      transactions: [RENT, STRATA],
      incomeEntries: [{
        id: 'i1', user_id: ME, source: 'Acme', amount: 90_000, currency: 'AUD',
        category: 'Salary', is_recurring: false, date: '2024-09-01', status: 'approved',
      } as IncomeEntry],
    });
    const p = taxYearDS.build({ fy: FY });
    const noRent = calculateTax(false, { fy: FY, total_income: 90_000, tax_withheld: 0, total_deductions: 0 });
    const withRent = calculateTax(false, {
      fy: FY, total_income: p.assessableIncome, tax_withheld: 0, total_deductions: p.deductibleExpenses,
    });
    expect(withRent.total_income).toBe(110_000);
    // $20,000 more taxable income, all inside FY 2024-25's 30c bracket
    // (45,001–135,000), plus the 2% levy on it. Nothing here is a flat rate.
    expect(withRent.income_tax! - noRent.income_tax!).toBeCloseTo(20_000 * 0.30, 0);
    expect(withRent.medicare_levy! - noRent.medicare_levy!).toBeCloseTo(400, 2);
  });

  it('offers the year in the FY switcher even with nothing else in it', () => {
    seed({ properties: [property({ id: 'p1' })], transactions: [RENT] });
    expect(taxYearDS.financialYears()).toContain(FY);
  });
});

// ─── The double-count seams ──────────────────────────────────────────────────

describe('a rental cost is only ever claimed once', () => {
  it('does not add the "tax deductible" tick to the rental line', () => {
    const ticked = { ...STRATA, is_tax_deductible: true, deduction_category: 'Other' } as Transaction;
    seed({ properties: [property({ id: 'p1' })], transactions: [RENT, ticked] });
    const p = taxYearDS.build({ fy: FY });
    expect(p.deductibleExpenses).toBe(4_000);
    expect(p.deductions.countedInRental).toEqual(['strata1']);
  });

  it('leaves the payment to a manual deduction that explicitly links to it', () => {
    const ticked = { ...STRATA, is_tax_deductible: true } as Transaction;
    seed({ properties: [property({ id: 'p1' })], transactions: [RENT, ticked] });
    deductionsDS.add({ name: 'Strata', amount: 4_000, category: 'Other', date: '2024-08-01', source_transaction_id: 'strata1' });
    const p = taxYearDS.build({ fy: FY });
    expect(p.deductibleExpenses).toBe(4_000);
    expect(p.deductions.manualTotal).toBe(4_000);
    expect(p.deductions.externalTotal).toBe(0);
  });

  it('never lets two properties claim the same rent', () => {
    // Both name the same payer. Attribution settles it once, before the schedule.
    seed({
      properties: [property({ id: 'p1', name: 'Bondi' }), property({ id: 'p2', name: 'Coogee' })],
      transactions: [RENT],
    });
    const p = taxYearDS.build({ fy: FY });
    expect(p.rental!.grossIncome).toBe(24_000);
    expect(p.rental!.properties.filter(x => x.inSchedule)).toHaveLength(1);
  });

  it('counts a duplicated rent payment once', () => {
    // The same money, imported twice: one hand-entered copy and one from the bank.
    seed({
      properties: [property({ id: 'p1' })],
      transactions: [
        RENT,
        { ...RENT, id: 'rent1-copy', source_ref: 'bank-999' } as Transaction,
      ],
    });
    expect(taxYearDS.build({ fy: FY }).rental!.grossIncome).toBe(24_000);
  });
});

// ─── The mortgage ────────────────────────────────────────────────────────────

describe('the mortgage', () => {
  it('claims nothing until the lender’s figure is entered, then only the interest', () => {
    seed({
      properties: [property({ id: 'p1', loan_id: 'l1' })],
      transactions: [RENT],
      loans: [loan()],
    });
    expect(taxYearDS.build({ fy: FY }).deductibleExpenses).toBe(0);

    const s: RentalPropertySettings = {
      ...emptyRentalSettings(),
      byFY: { [FY]: { interestPaid: 28_400, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } },
    };
    rentalTaxDS.save('p1', s);
    const p = taxYearDS.build({ fy: FY });
    expect(p.deductibleExpenses).toBe(28_400);
    // $36,000 of repayments a year; only the interest reached the return.
    expect(p.rental!.properties[0].interest.principalNotDeductible).toBe(7_600);
  });

  it('reads interest charges off the loan account when Ledger holds them', () => {
    seed({
      properties: [property({ id: 'p1', loan_id: 'l1' })],
      transactions: [
        RENT,
        tx({ id: 'i1', amount: -2_400, date: '2024-08-31', merchant: 'Interest charged', account_type: 'loan', account_id: 'loanacc', category: 'Bills' }),
        tx({ id: 'm1', amount: -3_000, date: '2024-08-31', merchant: 'Loan repayment', account_type: 'loan', account_id: 'loanacc', category: 'Bills' }),
      ],
      loans: [loan({ basiq_account_id: 'loanacc' })],
    });
    const p = taxYearDS.build({ fy: FY });
    expect(p.rental!.properties[0].interest.basis).toBe('transactions');
    expect(p.deductibleExpenses).toBe(2_400);
  });
});

// ─── Negative gearing reaches BOTH income bases ──────────────────────────────

describe('a net rental loss', () => {
  function lossPosition() {
    seed({
      properties: [property({ id: 'p1', loan_id: 'l1' })],
      transactions: [tx({ id: 'rent1', amount: 12_000 }), STRATA],
      loans: [loan()],
      incomeEntries: [{
        id: 'i1', user_id: ME, source: 'Acme', amount: 90_000, currency: 'AUD',
        category: 'Salary', is_recurring: false, date: '2024-09-01', status: 'approved',
      } as IncomeEntry],
    });
    rentalTaxDS.save('p1', {
      ...emptyRentalSettings(),
      byFY: { [FY]: { interestPaid: 28_000, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } },
    });
    return taxYearDS.build({ fy: FY });
  }

  it('reduces taxable income', () => {
    const p = lossPosition();
    expect(p.assessableIncome).toBe(102_000);
    expect(p.deductibleExpenses).toBe(32_000);
    expect(p.estimatedTaxableIncome).toBe(70_000);
    expect(p.rental!.netRentalLoss).toBe(20_000);
  });

  it('is added BACK for the study loan, exactly as the Tax page does it', () => {
    const p = lossPosition();
    const typed = emptyRepaymentIncomeAdjustments();
    const effective = {
      ...typed,
      totalNetInvestmentLoss: Math.max(typed.totalNetInvestmentLoss, p.rental!.netRentalLoss),
    };
    const repayment = repaymentIncomeFrom(p.estimatedTaxableIncome, effective);
    expect(repayment.total).toBe(90_000);
    expect(repayment.taxableIncome).toBe(70_000);
  });

  it('keeps the user’s own larger figure, which may cover losses Ledger can’t see', () => {
    const p = lossPosition();
    const typed = { ...emptyRepaymentIncomeAdjustments(), totalNetInvestmentLoss: 26_000 };
    const effective = {
      ...typed,
      totalNetInvestmentLoss: Math.max(typed.totalNetInvestmentLoss, p.rental!.netRentalLoss),
    };
    expect(effective.totalNetInvestmentLoss).toBe(26_000);
  });
});

// ─── Persistence and isolation ───────────────────────────────────────────────

describe('settings belong to one user and survive a reload', () => {
  const withInterest = (n: number): RentalPropertySettings => ({
    ...emptyRentalSettings(),
    byFY: { [FY]: { interestPaid: n, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } },
  });

  it('reads back what was saved', () => {
    seed({ properties: [property({ id: 'p1' })] });
    rentalTaxDS.save('p1', withInterest(9_999));
    expect(rentalTaxDS.settingsFor('p1').byFY[FY].interestPaid).toBe(9_999);
  });

  it('is invisible to another user', () => {
    seed({ properties: [property({ id: 'p1' })] });
    rentalTaxDS.save('p1', withInterest(9_999));
    seed({ userId: OTHER, properties: [property({ id: 'p1', user_id: OTHER })] });
    expect(rentalTaxDS.settingsFor('p1').byFY[FY]).toBeUndefined();
  });

  it('gives the first user their own back afterwards', () => {
    seed({ properties: [property({ id: 'p1' })] });
    rentalTaxDS.save('p1', withInterest(9_999));
    seed({ userId: OTHER });
    rentalTaxDS.save('p1', withInterest(1_111));
    seed({ properties: [property({ id: 'p1' })] });
    expect(rentalTaxDS.settingsFor('p1').byFY[FY].interestPaid).toBe(9_999);
  });

  it('never lets another user’s property into the schedule', () => {
    useStore.setState({
      user: { id: ME, email: 'me@example.com' } as any,
      properties: [property({ id: 'p1' }), property({ id: 'p2', user_id: OTHER, name: 'Theirs' })],
      transactions: [RENT, { ...RENT, id: 'rent-theirs', user_id: OTHER } as Transaction],
      loans: [], incomeEntries: [], investments: [], investmentSales: [],
      merchants: [], merchantAliases: [], customCategories: [], transactionRules: [],
    } as any);
    const p = taxYearDS.build({ fy: FY });
    expect(p.rental!.properties.map(x => x.id)).toEqual(['p1']);
    expect(p.rental!.grossIncome).toBe(24_000);
  });

  it('degrades to nothing entered when the stored bucket is corrupt', () => {
    seed({ properties: [property({ id: 'p1' })], transactions: [RENT, STRATA] });
    localStorage.setItem(`ledger-rental-tax-${ME}`, '{{{not json');
    expect(rentalTaxDS.settingsFor('p1')).toEqual(emptyRentalSettings());
    expect(taxYearDS.build({ fy: FY }).deductibleExpenses).toBe(4_000);
  });
});

// ─── Years ───────────────────────────────────────────────────────────────────

describe('financial years', () => {
  it('keeps each year’s rent in its own year', () => {
    seed({
      properties: [property({ id: 'p1' })],
      transactions: [
        tx({ id: 'a', amount: 24_000, date: '2024-12-01' }),
        tx({ id: 'b', amount: 26_000, date: '2025-12-01' }),
      ],
    });
    expect(taxYearDS.build({ fy: '2024-2025' }).rental!.grossIncome).toBe(24_000);
    expect(taxYearDS.build({ fy: '2025-2026' }).rental!.grossIncome).toBe(26_000);
  });

  it('keeps each year’s interest figure separate', () => {
    seed({ properties: [property({ id: 'p1', loan_id: 'l1' })], transactions: [RENT], loans: [loan()] });
    rentalTaxDS.save('p1', {
      ...emptyRentalSettings(),
      byFY: {
        '2024-2025': { interestPaid: 28_000, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] },
        '2025-2026': { interestPaid: 24_000, interestPrivatePercent: 0, availableForRent: true, otherIncome: 0, otherDeductions: [] },
      },
    });
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(28_000);
    expect(taxYearDS.build({ fy: '2025-2026' }).deductibleExpenses).toBe(24_000);
  });
});
