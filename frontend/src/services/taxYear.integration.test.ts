/**
 * Phase 5.1 — the tax-year position end to end through the data service.
 *
 * The engine is unit-tested in isolation (utils/taxYear.test.ts). These are the
 * things it CANNOT prove on its own — the parts that only exist once deductions,
 * the store and localStorage are wired together:
 *
 *   • a deduction entered in one financial year is still there in the next one
 *     (the old per-FY storage key stranded them on 1 July);
 *   • deductions saved under that old key are folded in, once, without doubling;
 *   • the FY switcher offers every year that has anything in it;
 *   • the position reads live store data and never mixes one user with another.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction, IncomeEntry } from '../types';

// A localStorage stub with a WORKING key(i) — the deduction migration enumerates
// keys, so a stub that always returns null would silently pass a broken sweep.
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
  deductionsDS, taxYearDS, calculateTax, getTaxBrackets, estimateTaxForIncome, studentLoanIncomeDS,
  taxCreditsDS, taxProfileDS,
} from './dataService';
import { emptyRepaymentIncomeAdjustments } from '../utils/repaymentIncome';
import { emptyTaxCredits, grossUpFor, type TaxCredits } from '../utils/taxCredits';
import { buildTaxSettlement, type TaxSettlement } from '../utils/taxSettlement';
import { buildOffsetPosition } from '../utils/taxOffsets';
import { emptyTaxProfile, type TaxProfile } from '../utils/taxProfile';
import type { PayslipCore } from '../utils/payroll';

const ME = 'user-ME';
const OTHER = 'user-OTHER';

const tx = (o: Partial<Transaction> & { amount: number }): Transaction => ({
  id: 't1', user_id: ME, account_id: 'acc-1', account_type: 'bank',
  date: '2024-09-01', merchant: 'Officeworks', currency: 'AUD',
  category: 'Uncategorised', is_duplicate_flagged: false, is_subscription: false, ...o,
} as Transaction);

const income = (o: Partial<IncomeEntry> & { amount: number }): IncomeEntry => ({
  id: 'i1', user_id: ME, source: 'Acme Pty Ltd', currency: 'AUD', category: 'Salary',
  is_recurring: false, date: '2024-09-01', status: 'approved', ...o,
} as IncomeEntry);

function seed(opts: { userId?: string; transactions?: Transaction[]; incomeEntries?: IncomeEntry[] } = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    transactions: opts.transactions ?? [],
    incomeEntries: opts.incomeEntries ?? [],
    merchants: [], merchantAliases: [], customCategories: [], transactionRules: [],
  });
}

beforeEach(() => {
  localStorage.clear();
  seed();
});

describe('deductions persist across financial years', () => {
  it('a deduction entered last year is still readable this year', () => {
    deductionsDS.add({ name: 'Laptop', amount: 1_200, category: 'Tools, equipment & assets', date: '2023-11-01' });
    deductionsDS.add({ name: 'Course', amount: 800, category: 'Self-education', date: '2024-10-01' });

    // One list, both years — the switcher decides which is shown, not the store.
    expect(deductionsDS.getAll()).toHaveLength(2);
    expect(taxYearDS.build({ fy: '2023-2024' }).deductibleExpenses).toBe(1_200);
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(800);
  });

  it('survives a reload — nothing lives only in memory', () => {
    deductionsDS.add({ name: 'Union fees', amount: 450, category: 'Union & professional fees', date: '2024-08-01' });
    const raw = localStorage.getItem(`ledger-deductions-${ME}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toHaveLength(1);
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(450);
  });

  it('an edit and a delete stick, per record', () => {
    const a = deductionsDS.add({ name: 'A', amount: 100, category: 'Other work-related', date: '2024-08-01' });
    const b = deductionsDS.add({ name: 'B', amount: 200, category: 'Other work-related', date: '2024-08-02' });

    deductionsDS.update(a.id, { amount: 150 });
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(350);

    deductionsDS.remove(b.id);
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(150);
    expect(deductionsDS.getAll().map(d => d.id)).toEqual([a.id]);
  });

  it('keeps one user\'s deductions out of another\'s position', () => {
    deductionsDS.add({ name: 'Mine', amount: 500, category: 'Self-education', date: '2024-08-01' });

    seed({ userId: OTHER });
    expect(deductionsDS.getAll()).toEqual([]);
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(0);

    seed({ userId: ME });
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(500);
  });
});

// The legacy sweep runs once per user per session (a second read must not
// re-scan every key), so each of these seeds a DIFFERENT user — otherwise the
// first test's sweep would satisfy the guard and the rest would prove nothing.
describe('legacy per-financial-year storage', () => {
  it('folds old per-FY buckets into the single list', () => {
    const u = 'user-LEGACY-A';
    seed({ userId: u });
    localStorage.setItem(`ledger-deductions-${u}-2023-2024`, JSON.stringify([
      { id: 'old-1', name: 'Boots', amount: 220, category: 'Clothing, laundry & dry-cleaning', date: '2023-09-01' },
    ]));
    localStorage.setItem(`ledger-deductions-${u}-2024-2025`, JSON.stringify([
      { id: 'old-2', name: 'Desk', amount: 340, category: 'Working from home', date: '2024-09-01' },
    ]));

    expect(deductionsDS.getAll().map(d => d.id).sort()).toEqual(['old-1', 'old-2']);
    expect(taxYearDS.build({ fy: '2023-2024' }).deductibleExpenses).toBe(220);
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(340);
  });

  it('never doubles a claim, however many times it reads', () => {
    const u = 'user-LEGACY-B';
    seed({ userId: u });
    const record = { id: 'dup', name: 'Desk', amount: 340, category: 'Working from home', date: '2024-09-01' };
    // The same record present in BOTH the legacy bucket and the current list.
    localStorage.setItem(`ledger-deductions-${u}-2024-2025`, JSON.stringify([record]));
    localStorage.setItem(`ledger-deductions-${u}`, JSON.stringify([record]));

    deductionsDS.getAll();
    deductionsDS.getAll();
    expect(deductionsDS.getAll()).toHaveLength(1);
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(340);
  });

  it('a malformed legacy bucket cannot break the list', () => {
    const u = 'user-LEGACY-C';
    seed({ userId: u });
    localStorage.setItem(`ledger-deductions-${u}-2024-2025`, '{ not json');
    expect(() => deductionsDS.getAll()).not.toThrow();
    deductionsDS.add({ name: 'Still works', amount: 90, category: 'Other work-related', date: '2024-08-01' });
    expect(taxYearDS.build({ fy: '2024-2025' }).deductibleExpenses).toBe(90);
  });
});

describe('the position reads live data', () => {
  it('combines store transactions, store income and saved deductions', () => {
    seed({
      transactions: [
        tx({ id: 'gear', amount: -600, date: '2024-09-01', is_tax_deductible: true, deduction_category: 'Tools, equipment & assets' }),
        tx({ id: 'back', amount: 200, date: '2024-09-20', transaction_type: 'refund', refund_of: 'gear' }),
      ],
      incomeEntries: [income({ id: 'sal', amount: 85_000, date: '2024-09-01', tax_withheld: 19_000 })],
    });
    deductionsDS.add({ name: 'WFH hours', amount: 500, category: 'Working from home', date: '2025-02-01' });

    const p = taxYearDS.build({ fy: '2024-2025' });
    expect(p.assessableIncome).toBe(85_000);
    expect(p.deductibleExpenses).toBe(900);            // (600 − 200 refunded) + 500
    expect(p.estimatedTaxableIncome).toBe(84_100);
    expect(p.taxWithheld).toBe(19_000);
  });

  it('feeds the existing tax calculation the estimate it produced', () => {
    seed({ incomeEntries: [income({ id: 'sal', amount: 85_000, date: '2024-09-01', tax_withheld: 19_000 })] });
    deductionsDS.add({ name: 'WFH hours', amount: 5_000, category: 'Working from home', date: '2025-02-01' });

    const p = taxYearDS.build({ fy: '2024-2025' });
    const taxData = calculateTax(false, {
      total_income: p.assessableIncome,
      tax_withheld: p.taxWithheld,
      total_deductions: p.deductibleExpenses,
    });
    // calculateTax nets deductions off itself — the two must agree on what is taxed.
    expect(taxData.total_income).toBe(p.estimatedTaxableIncome);
    expect(taxData.estimated_tax_owing).toBeGreaterThan(0);
  });

  it('excludes an internal transfer tagged as business income', () => {
    seed({
      transactions: [
        tx({ id: 'a', amount: 5_000, date: '2024-09-01', merchant: 'Transfer from savings', transaction_type: 'income', entity: 'business', is_transfer: true, transfer_pair_id: 'pair-1' }),
      ],
    });
    expect(taxYearDS.build({ fy: '2024-2025' }).assessableIncome).toBe(0);
  });

  it('offers every financial year that has something in it, current year included', () => {
    seed({
      transactions: [tx({ id: 'gear', amount: -600, date: '2022-09-01', is_tax_deductible: true })],
      incomeEntries: [income({ id: 'sal', amount: 1_000, date: '2023-09-01' })],
    });
    deductionsDS.add({ name: 'Old claim', amount: 100, category: 'Self-education', date: '2021-09-01' });

    const years = taxYearDS.financialYears();
    expect(years).toEqual([...years].sort().reverse());       // newest first
    expect(years).toEqual(expect.arrayContaining(['2021-2022', '2022-2023', '2023-2024']));
    expect(years.length).toBe(4);                              // …plus the current FY
  });
});

/**
 * Rates by financial year, through the data service.
 *
 * The rate tables themselves are unit-tested (utils/taxRates.test.ts). What is
 * proved here is the wiring the Tax page depends on: the FY the user picked is
 * the FY that gets assessed, and a year with no rates yields no estimate rather
 * than a plausible one borrowed from a neighbour.
 */
describe('calculateTax — financial-year-specific rates', () => {
  beforeEach(() => { seed(); });

  const at = (fy: string, income: number, hecs = false) =>
    calculateTax(hecs, { fy, total_income: income, tax_withheld: 0, total_deductions: 0 });

  it('assesses the FY it was asked for, not the current one', () => {
    expect(at('2023-2024', 85_000).financial_year).toBe('2023-2024');
    expect(at('2024-2025', 85_000).financial_year).toBe('2024-2025');
  });

  it('gives a different answer for the same income in a different year', () => {
    // Stage 3 cut the rate on this slice of income from 32.5% to 30%.
    expect(at('2023-2024', 85_000).estimated_tax_owing).toBe(19_792);
    expect(at('2024-2025', 85_000).estimated_tax_owing).toBe(17_988);
  });

  it('breaks the estimate into components that add back up', () => {
    const r = at('2024-2025', 85_000, true);
    expect(r.income_tax).toBe(16_288);
    expect(r.medicare_levy).toBe(1_700);
    expect(r.hecs_repayment).toBe(3_825);
    expect(r.estimated_tax_owing).toBe(21_813);
  });

  it('uses the selected year’s HELP schedule, including the 2025-26 model change', () => {
    expect(at('2024-2025', 85_000, true).hecs_repayment).toBe(3_825);   // 4.5% of the lot
    expect(at('2025-2026', 85_000, true).hecs_repayment).toBe(2_700);   // 15% above 67,000
  });

  it('uses the selected year’s Medicare threshold', () => {
    // $26,500: over 2023-24's low-income threshold, under 2024-25's.
    expect(at('2023-2024', 26_500).medicare_levy).toBe(50);
    expect(at('2024-2025', 26_500).medicare_levy).toBe(0);
  });

  it('taxes income after deductions, on the selected year’s scale', () => {
    const r = calculateTax(false, {
      fy: '2024-2025', total_income: 90_000, tax_withheld: 19_000, total_deductions: 5_000,
    });
    expect(r.total_income).toBe(85_000);
    expect(r.estimated_tax_owing).toBe(17_988);
  });

  it('reports an unsupported year as unavailable, with every rate figure null', () => {
    const r = at('2019-2020', 85_000, true);
    expect(r.rates_available).toBe(false);
    expect(r.estimated_tax_owing).toBeNull();
    expect(r.income_tax).toBeNull();
    expect(r.medicare_levy).toBeNull();
    expect(r.hecs_repayment).toBeNull();
    expect(r.rates_confidence).toBeNull();
  });

  it('still reports the user’s own figures for an unsupported year', () => {
    // The position is real even when the rates aren't — only the tax is unknown.
    const r = calculateTax(false, {
      fy: '2019-2020', total_income: 90_000, tax_withheld: 19_000, total_deductions: 5_000,
    });
    expect(r.total_income).toBe(85_000);
    expect(r.tax_withheld).toBe(19_000);
    expect(r.total_deductions).toBe(5_000);
  });

  it('flags a year whose indexed thresholds are not published yet', () => {
    const settled = at('2024-2025', 85_000);
    expect(settled.rates_available).toBe(true);
    expect(settled.rates_confidence).toBe('legislated');
    expect(settled.rates_notes).toEqual([]);

    const provisional = at('2026-2027', 85_000);
    expect(provisional.rates_available).toBe(true);
    expect(provisional.rates_confidence).toBe('indexed-estimate');
    expect(provisional.rates_notes.length).toBeGreaterThan(0);
  });

  it('hands the FY position straight to the right year’s rates', () => {
    seed({ incomeEntries: [income({ id: 'sal', amount: 85_000, date: '2023-09-01', tax_withheld: 19_000 })] });
    const p = taxYearDS.build({ fy: '2023-2024' });
    const r = calculateTax(false, {
      fy: '2023-2024',
      total_income: p.assessableIncome,
      tax_withheld: p.taxWithheld,
      total_deductions: p.deductibleExpenses,
    });
    expect(r.total_income).toBe(p.estimatedTaxableIncome);
    expect(r.estimated_tax_owing).toBe(19_792);     // 2023-24 scale, not 2024-25's
  });

  it('offers a bracket table per year, and none for a year it has no rates for', () => {
    expect(getTaxBrackets('2024-2025')[1]).toEqual({ min: 18_201, max: 45_000, rate: 0.16 });
    expect(getTaxBrackets('2023-2024')[1]).toEqual({ min: 18_201, max: 45_000, rate: 0.19 });
    expect(getTaxBrackets('2019-2020')).toEqual([]);
  });

  it('estimateTaxForIncome follows the same rules', () => {
    expect(estimateTaxForIncome(85_000, false, '2023-2024')).toBe(19_792);
    expect(estimateTaxForIncome(85_000, false, '2024-2025')).toBe(17_988);
    expect(estimateTaxForIncome(85_000, false, '2019-2020')).toBeNull();
  });
});

// ─── Repayment income (the loan's own base) ─────────────────────────────────

describe('calculateTax — a study loan is assessed on repayment income', () => {
  beforeEach(() => { seed(); });

  const at = (fy: string, income: number, adjustments?: Partial<ReturnType<typeof emptyRepaymentIncomeAdjustments>>) =>
    calculateTax(true, {
      fy,
      total_income: income,
      tax_withheld: 0,
      total_deductions: 0,
      repayment_income_adjustments: adjustments
        ? { ...emptyRepaymentIncomeAdjustments(), ...adjustments }
        : undefined,
    });

  it('reports both bases, and they are equal only when nothing was supplied', () => {
    const plain = at('2026-2027', 95_000);
    expect(plain.total_income).toBe(95_000);
    expect(plain.repayment_income).toBe(95_000);
    expect(plain.repayment_income_adjustments).toBe(0);
  });

  it('salary sacrifice raises the repayment without touching the tax', () => {
    const plain = at('2026-2027', 95_000);
    const sacrificing = at('2026-2027', 95_000, { reportableSuperContributions: 25_000 });

    expect(sacrificing.repayment_income).toBe(120_000);
    expect(sacrificing.repayment_income_adjustments).toBe(25_000);
    // The brackets and the levy never see the bigger number.
    expect(sacrificing.income_tax).toBe(plain.income_tax);
    expect(sacrificing.medicare_levy).toBe(plain.medicare_levy);
    // 15c on ($120,000 − $69,528), against 15c on ($95,000 − $69,528).
    expect(sacrificing.hecs_repayment).toBe(7_570.80);
    expect(plain.hecs_repayment).toBe(3_820.80);
    expect(sacrificing.estimated_tax_owing! - plain.estimated_tax_owing!)
      .toBeCloseTo(3_750, 2);
  });

  it('adds every ATO term, together', () => {
    const r = at('2026-2027', 60_470, {
      reportableFringeBenefits: 5_400,
      totalNetInvestmentLoss: 1_330,
      reportableSuperContributions: 16_500,
      exemptForeignEmploymentIncome: 2_680,
    });
    expect(r.repayment_income).toBe(86_380);
    expect(r.hecs_repayment).toBe(2_527.80);   // the ATO's own worked example
    // Taxable income is untouched: $60,470 is what the brackets saw.
    expect(r.total_income).toBe(60_470);
  });

  it('can push someone over the repayment threshold who is under it on taxable income', () => {
    const under = at('2026-2027', 68_000);
    expect(under.repayment_income).toBe(68_000);
    expect(under.hecs_repayment).toBe(0);

    const over = at('2026-2027', 68_000, { reportableFringeBenefits: 5_000 });
    expect(over.repayment_income).toBe(73_000);
    expect(over.hecs_repayment).toBe(520.80);  // 15c on $3,472
    // …and the income tax is identical either way.
    expect(over.income_tax).toBe(under.income_tax);
  });

  it('applies the whole-income top row at the very top of the scale', () => {
    // $250,000 repayment income in 2025-26: 10% of the whole amount.
    expect(at('2025-2026', 250_000).hecs_repayment).toBe(25_000);
  });

  it('does not count adjustments when there is no loan', () => {
    const noLoan = calculateTax(false, {
      fy: '2026-2027',
      total_income: 95_000,
      tax_withheld: 0,
      total_deductions: 0,
      repayment_income_adjustments: { ...emptyRepaymentIncomeAdjustments(), reportableSuperContributions: 25_000 },
    });
    expect(noLoan.hecs_repayment).toBe(0);
    // The base is still reported — it is a fact about the year, not about the loan.
    expect(noLoan.repayment_income).toBe(120_000);
  });

  it('still reports the repayment income for a year with no rates', () => {
    const r = at('2019-2020', 95_000, { reportableSuperContributions: 25_000 });
    expect(r.rates_available).toBe(false);
    expect(r.hecs_repayment).toBeNull();
    expect(r.total_income).toBe(95_000);
    expect(r.repayment_income).toBe(120_000);
  });

  it('nets deductions off taxable income BEFORE building the repayment income', () => {
    const r = calculateTax(true, {
      fy: '2026-2027',
      total_income: 100_000,
      tax_withheld: 0,
      total_deductions: 5_000,
      repayment_income_adjustments: { ...emptyRepaymentIncomeAdjustments(), reportableFringeBenefits: 10_000 },
    });
    expect(r.total_income).toBe(95_000);
    expect(r.repayment_income).toBe(105_000);
  });
});

describe('studentLoanIncomeDS — where the figures live', () => {
  beforeEach(() => { seed(); localStorage.clear(); });

  it('keeps the figures per financial year', () => {
    studentLoanIncomeDS.save('2025-2026', { ...emptyRepaymentIncomeAdjustments(), reportableSuperContributions: 12_000 });
    studentLoanIncomeDS.save('2026-2027', { ...emptyRepaymentIncomeAdjustments(), reportableSuperContributions: 18_000 });

    expect(studentLoanIncomeDS.adjustmentsFor('2025-2026').reportableSuperContributions).toBe(12_000);
    expect(studentLoanIncomeDS.adjustmentsFor('2026-2027').reportableSuperContributions).toBe(18_000);
    // A year never entered is empty, not the neighbouring year's figures.
    expect(studentLoanIncomeDS.adjustmentsFor('2024-2025')).toEqual(emptyRepaymentIncomeAdjustments());
    expect(studentLoanIncomeDS.hasAdjustments('2024-2025')).toBe(false);
    expect(studentLoanIncomeDS.hasAdjustments('2025-2026')).toBe(true);
  });

  it('remembers whether there is a loan at all, across years', () => {
    expect(studentLoanIncomeDS.hasLoan()).toBe(false);
    studentLoanIncomeDS.setHasLoan(true);
    studentLoanIncomeDS.save('2026-2027', { ...emptyRepaymentIncomeAdjustments(), totalNetInvestmentLoss: 3_000 });
    expect(studentLoanIncomeDS.hasLoan()).toBe(true);
    expect(studentLoanIncomeDS.adjustmentsFor('2026-2027').totalNetInvestmentLoss).toBe(3_000);
  });

  it('is scoped to the user — one person’s figures never leak into another’s', () => {
    studentLoanIncomeDS.setHasLoan(true);
    studentLoanIncomeDS.save('2026-2027', { ...emptyRepaymentIncomeAdjustments(), reportableFringeBenefits: 4_000 });

    seed({ userId: OTHER });
    expect(studentLoanIncomeDS.hasLoan()).toBe(false);
    expect(studentLoanIncomeDS.adjustmentsFor('2026-2027')).toEqual(emptyRepaymentIncomeAdjustments());
  });

  it('degrades a corrupt bucket to no figures, never to wrong ones', () => {
    localStorage.setItem(`ledger-help-income-${ME}`, '{not json');
    expect(studentLoanIncomeDS.hasLoan()).toBe(false);
    expect(studentLoanIncomeDS.adjustmentsFor('2026-2027')).toEqual(emptyRepaymentIncomeAdjustments());

    localStorage.setItem(`ledger-help-income-${ME}`, JSON.stringify({ byFY: { '2026-2027': { reportableFringeBenefits: 'heaps' } } }));
    expect(studentLoanIncomeDS.adjustmentsFor('2026-2027').reportableFringeBenefits).toBe(0);
  });
});

// ─── Phase 5.2 — refund or amount owing, end to end ──────────────────────────

/**
 * Exactly what pages/Tax.tsx does for the selected year: build the position from
 * live store data, run the tax calculation on it (including the franking
 * gross-up), then settle the two against each other. If this composition ever
 * drifts from the page, the page is what is wrong.
 */
function pageSettlement(fy: string, opts: {
  payslips?: PayslipCore[];
  studentLoan?: boolean;
  credits?: Partial<TaxCredits>;
  /** Omitted means "read whatever the store holds for this year", as the page does. */
  profile?: Partial<TaxProfile>;
  taxFreeThresholdClaims?: number;
  asOf?: string;
} = {}): TaxSettlement {
  const credits: TaxCredits = { ...emptyTaxCredits(), ...opts.credits };
  // The page saves a credit as it is typed, and the position reads it back when
  // it reconciles dividend statements against it — so the store has to be set
  // BEFORE the build, exactly as it is in the app.
  if (opts.credits) taxCreditsDS.save(fy, credits);
  const position = taxYearDS.build({ fy, payslips: opts.payslips ?? [] });
  // Phase 5.4 — statements supersede the single franking figure, and both the
  // gross-up and the credit read the same reconciled number.
  const effectiveCredits: TaxCredits = position.income.dividends
    ? { ...credits, frankingCredits: position.income.dividends.effectiveFrankingCredit }
    : credits;
  const adjustments = studentLoanIncomeDS.adjustmentsFor(fy);
  const tax = calculateTax(opts.studentLoan ?? false, {
    fy,
    total_income: position.assessableIncome + grossUpFor(effectiveCredits),
    tax_withheld: position.taxWithheld,
    total_deductions: position.deductibleExpenses,
    repayment_income_adjustments: adjustments,
  });
  const profile: TaxProfile = opts.profile
    ? { ...emptyTaxProfile(), ...opts.profile }
    : taxProfileDS.forFY(fy);
  const offsets = buildOffsetPosition({
    fy,
    taxableIncome: tax.total_income,
    incomeTax: tax.income_tax,
    adjustments,
    profile,
  });
  return buildTaxSettlement({
    position,
    tax: {
      ratesAvailable: tax.rates_available,
      taxableIncome: tax.total_income,
      incomeTax: tax.income_tax,
      medicareLevy: tax.medicare_levy,
      studentLoanRepayment: tax.hecs_repayment,
      confidence: tax.rates_confidence,
      notes: tax.rates_notes,
    },
    credits: effectiveCredits,
    offsets,
    taxFreeThresholdClaims: opts.taxFreeThresholdClaims,
    asOf: opts.asOf,
  });
}

const slip = (p: Partial<PayslipCore> & { gross_pay: number }): PayslipCore => ({
  id: 'ps', employer: 'Acme Pty Ltd', employment_type: 'full_time', pay_frequency: 'fortnightly',
  payment_date: '2024-09-01', net_pay: p.gross_pay * 0.7, tax_withheld: 0, super_amount: 0, ...p,
});

describe('the settlement follows the FY switcher', () => {
  it('two years of income settle differently, from the same store', () => {
    // Same salary both years; last year over-withheld, this year under-withheld.
    const payslips = [
      slip({ id: 'a', gross_pay: 95_000, tax_withheld: 24_000, payment_date: '2024-09-01' }),
      slip({ id: 'b', gross_pay: 95_000, tax_withheld: 15_000, payment_date: '2025-09-01' }),
    ];

    const prior = pageSettlement('2024-2025', { payslips });
    const current = pageSettlement('2025-2026', { payslips });

    // Both years run the 2024-25/2025-26 scale, so the liability matches …
    expect(prior.liability.total).toBe(21_188);
    expect(current.liability.total).toBe(21_188);
    // … and only the withholding differs.
    expect(prior.outcome).toBe('refund');
    expect(prior.refund).toBe(2_812);
    expect(current.outcome).toBe('owing');
    expect(current.owing).toBe(6_188);
  });

  it('a deduction only moves the year it was entered in', () => {
    const payslips = [
      slip({ id: 'a', gross_pay: 95_000, tax_withheld: 24_000, payment_date: '2024-09-01' }),
      slip({ id: 'b', gross_pay: 95_000, tax_withheld: 24_000, payment_date: '2025-09-01' }),
    ];
    deductionsDS.add({ name: 'Laptop', amount: 5_000, category: 'Tools, equipment & assets', date: '2024-11-01' });

    expect(pageSettlement('2024-2025', { payslips }).refund).toBe(4_412);
    expect(pageSettlement('2025-2026', { payslips }).refund).toBe(2_812);
  });

  it('switching to a year Ledger cannot assess withdraws the outcome, not the payments', () => {
    const payslips = [slip({ gross_pay: 95_000, tax_withheld: 24_000, payment_date: '2015-09-01' })];
    const s = pageSettlement('2015-2016', { payslips });

    expect(s.outcome).toBe('unknown');
    expect(s.liability.total).toBeNull();
    expect(s.credits.total).toBe(24_000);
    expect(s.warnings.map(w => w.kind)).toContain('no-rates');
  });

  it('the credits entered for one year do not follow the switcher', () => {
    const payslips = [
      slip({ id: 'a', gross_pay: 95_000, tax_withheld: 15_000, payment_date: '2024-09-01' }),
      slip({ id: 'b', gross_pay: 95_000, tax_withheld: 15_000, payment_date: '2025-09-01' }),
    ];
    taxCreditsDS.save('2024-2025', { ...emptyTaxCredits(), paygInstalments: 6_188 });

    const prior = pageSettlement('2024-2025', { payslips, credits: taxCreditsDS.forFY('2024-2025') });
    const current = pageSettlement('2025-2026', { payslips, credits: taxCreditsDS.forFY('2025-2026') });

    expect(prior.outcome).toBe('square');
    expect(current.owing).toBe(6_188);
  });
});

describe('the settlement reads live store data', () => {
  it('counts income entries and their withholding alongside payslips', () => {
    seed({
      incomeEntries: [
        income({ id: 'e1', amount: 20_000, tax_withheld: 3_000, date: '2024-10-01', source: 'Contract work' }),
      ],
    });
    const s = pageSettlement('2024-2025', {
      payslips: [slip({ gross_pay: 75_000, tax_withheld: 15_000 })],
    });

    expect(s.paygWithheld).toBe(18_000);
    expect(s.withholdingSources.map(w => w.label).sort()).toEqual(['Acme Pty Ltd', 'Contract work']);
    // 95,000 again: liability 21,188 against 18,000 paid.
    expect(s.owing).toBe(3_188);
  });

  it('a pending income entry is left out and said out loud', () => {
    seed({
      incomeEntries: [income({ id: 'e1', amount: 20_000, date: '2024-10-01', status: 'pending' })],
    });
    const s = pageSettlement('2024-2025', {
      payslips: [slip({ gross_pay: 75_000, tax_withheld: 18_000 })],
    });

    // 75,000 → 13,288 tax + 1,500 levy = 14,788, so 18,000 withheld is a refund …
    expect(s.refund).toBe(3_212);
    // … but approving the pending entry would wipe it out, and the user is told.
    expect(s.warnings.map(w => w.kind)).toContain('pending-income');
  });

  it('business income raises the bill and keeps its transaction for drill-down', () => {
    seed({
      transactions: [tx({ id: 'inv-1', amount: 20_000, transaction_type: 'income', entity: 'business', date: '2024-10-01' })],
    });
    const s = pageSettlement('2024-2025', {
      payslips: [slip({ gross_pay: 75_000, tax_withheld: 18_000 })],
    });

    expect(s.owing).toBe(3_188);
    expect(s.unwithheldIncome).toBe(20_000);
    expect(s.withholdingSources.find(w => w.kind === 'transaction')!.transactionId).toBe('inv-1');
  });

  it('a study loan is settled alongside the tax, from the same withholding', () => {
    const payslips = [slip({ gross_pay: 95_000, tax_withheld: 24_000 })];
    const without = pageSettlement('2024-2025', { payslips });
    const withLoan = pageSettlement('2024-2025', { payslips, studentLoan: true });

    expect(without.refund).toBe(2_812);
    expect(withLoan.owing).toBe(2_413);
    expect(withLoan.liability.components.map(c => c.key)).toContain('study-loan');
  });
});

describe('taxCreditsDS — where the credits live', () => {
  it('keeps each year separate', () => {
    taxCreditsDS.save('2024-2025', { ...emptyTaxCredits(), paygInstalments: 4_000 });
    taxCreditsDS.save('2025-2026', { ...emptyTaxCredits(), frankingCredits: 700 });

    expect(taxCreditsDS.forFY('2024-2025')).toEqual({ paygInstalments: 4_000, frankingCredits: 0, otherTaxPaid: 0 });
    expect(taxCreditsDS.forFY('2025-2026')).toEqual({ paygInstalments: 0, frankingCredits: 700, otherTaxPaid: 0 });
    expect(taxCreditsDS.forFY('2023-2024')).toEqual(emptyTaxCredits());
    expect(taxCreditsDS.has('2024-2025')).toBe(true);
    expect(taxCreditsDS.has('2023-2024')).toBe(false);
  });

  it('survives a reload', () => {
    taxCreditsDS.save('2024-2025', { ...emptyTaxCredits(), otherTaxPaid: 125.5 });
    const raw = localStorage.getItem(`ledger-tax-credits-${ME}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).byFY['2024-2025'].otherTaxPaid).toBe(125.5);
  });

  it('is scoped to the user', () => {
    taxCreditsDS.save('2024-2025', { ...emptyTaxCredits(), paygInstalments: 4_000 });
    seed({ userId: OTHER });
    expect(taxCreditsDS.forFY('2024-2025')).toEqual(emptyTaxCredits());
  });

  it('degrades a corrupt bucket to "nothing paid", which can only understate a refund', () => {
    localStorage.setItem(`ledger-tax-credits-${ME}`, '{not json');
    expect(taxCreditsDS.forFY('2024-2025')).toEqual(emptyTaxCredits());

    localStorage.setItem(
      `ledger-tax-credits-${ME}`,
      JSON.stringify({ byFY: { '2024-2025': { paygInstalments: 'lots', frankingCredits: -5 } } }),
    );
    expect(taxCreditsDS.forFY('2024-2025')).toEqual(emptyTaxCredits());
  });
});

// ─── Phase 5.3 through the page ──────────────────────────────────────────────

describe('taxProfileDS — where the personal answers live', () => {
  const spouseYear = (): TaxProfile => ({
    ...emptyTaxProfile(),
    hasSpouse: true,
    spouseSurchargeIncome: 85_000,
    hospitalCover: 'full-year',
  });

  it('keeps each year separate', () => {
    taxProfileDS.save('2024-2025', spouseYear());
    taxProfileDS.save('2025-2026', { ...emptyTaxProfile(), saptoEligible: true });

    expect(taxProfileDS.forFY('2024-2025').hasSpouse).toBe(true);
    expect(taxProfileDS.forFY('2025-2026').hasSpouse).toBe(false);
    expect(taxProfileDS.forFY('2025-2026').saptoEligible).toBe(true);
    expect(taxProfileDS.forFY('2023-2024')).toEqual(emptyTaxProfile());
    expect(taxProfileDS.has('2024-2025')).toBe(true);
    expect(taxProfileDS.has('2023-2024')).toBe(false);
  });

  it('survives a reload', () => {
    taxProfileDS.save('2024-2025', spouseYear());
    const raw = localStorage.getItem(`ledger-tax-profile-${ME}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).byFY['2024-2025'].spouseSurchargeIncome).toBe(85_000);
  });

  it('is scoped to the user', () => {
    taxProfileDS.save('2024-2025', spouseYear());
    seed({ userId: OTHER });
    expect(taxProfileDS.forFY('2024-2025')).toEqual(emptyTaxProfile());
  });

  it('degrades a corrupt bucket to "nothing answered"', () => {
    localStorage.setItem(`ledger-tax-profile-${ME}`, '{not json');
    expect(taxProfileDS.forFY('2024-2025')).toEqual(emptyTaxProfile());
    // And an unanswerable cover status stays UNANSWERED rather than becoming
    // "no cover", which would invent a surcharge out of a storage failure.
    localStorage.setItem(
      `ledger-tax-profile-${ME}`,
      JSON.stringify({ byFY: { '2024-2025': { hospitalCover: 'sort of', dependentChildren: -3 } } }),
    );
    expect(taxProfileDS.forFY('2024-2025').hospitalCover).toBe('unknown');
    expect(taxProfileDS.forFY('2024-2025').dependentChildren).toBe(0);
  });

  it('copies last year forward only when asked', () => {
    taxProfileDS.save('2024-2025', spouseYear());
    expect(taxProfileDS.forFY('2025-2026')).toEqual(emptyTaxProfile());

    const copied = taxProfileDS.copyFrom('2024-2025', '2025-2026');
    expect(copied.hasSpouse).toBe(true);
    expect(taxProfileDS.forFY('2025-2026').spouseSurchargeIncome).toBe(85_000);
    // And the two are now separate records, not one shared one.
    taxProfileDS.save('2025-2026', { ...copied, hospitalCover: 'none' });
    expect(taxProfileDS.forFY('2024-2025').hospitalCover).toBe('full-year');
  });
});

describe('the offsets follow the store, the same way the page reads it', () => {
  const payslips = [slip({ id: 'a', gross_pay: 38_000, tax_withheld: 3_000, payment_date: '2024-09-01' })];

  it('picks up a profile saved for the year, with no profile passed in', () => {
    // The page holds the profile in state and reloads it on every FY change;
    // this is the same round trip through localStorage.
    expect(pageSettlement('2024-2025', { payslips }).owing).toBe(253);

    taxProfileDS.save('2024-2025', { ...emptyTaxProfile(), saptoEligible: true });
    const withSapto = pageSettlement('2024-2025', { payslips });
    expect(withSapto.offsets.components.map(c => c.key)).toEqual(['sapto', 'lito']);
    expect(withSapto.refund).toBe(1_592);
  });

  it('leaves the neighbouring year alone', () => {
    taxProfileDS.save('2024-2025', { ...emptyTaxProfile(), saptoEligible: true });
    const next = [slip({ id: 'b', gross_pay: 38_000, tax_withheld: 3_000, payment_date: '2025-09-01' })];
    const s = pageSettlement('2025-2026', { payslips: next });
    expect(s.offsets.components.map(c => c.key)).toEqual(['lito']);
    expect(s.owing).toBe(253);
  });

  it('reads the study loan’s own income figures for the seniors offset too', () => {
    // One set of income-test amounts, three tests. Reportable super does not
    // touch taxable income, so the income tax and LITO do not move — but it
    // does lift REBATE income, and SAPTO shrinks with it. That divergence is
    // the whole reason the two bases are kept apart.
    taxProfileDS.save('2024-2025', { ...emptyTaxProfile(), saptoEligible: true });
    expect(pageSettlement('2024-2025', { payslips }).refund).toBe(1_592);

    studentLoanIncomeDS.save('2024-2025', {
      ...emptyRepaymentIncomeAdjustments(),
      reportableSuperContributions: 8_000,
    });
    // Rebate income $46,000: 2,230 − 11,081 × 12.5c = $844.875, rounded up.
    const tapered = pageSettlement('2024-2025', { payslips });
    expect(tapered.offsets.components.map(c => [c.key, c.amount])).toEqual([['sapto', 845], ['lito', 675]]);
    expect(tapered.netLiability).toBe(2_408);
    expect(tapered.refund).toBe(592);

    // Past the $52,759 cut-out it is gone entirely, and LITO is still $675.
    studentLoanIncomeDS.save('2024-2025', {
      ...emptyRepaymentIncomeAdjustments(),
      reportableSuperContributions: 20_000,
    });
    const gone = pageSettlement('2024-2025', { payslips });
    expect(gone.offsets.components.map(c => c.key)).toEqual(['lito']);
    expect(gone.owing).toBe(253);
  });

  it('turns a refund into a bill when hospital cover is answered "no"', () => {
    const high = [slip({ id: 'h', gross_pay: 120_000, tax_withheld: 30_000, payment_date: '2024-09-01' })];
    expect(pageSettlement('2024-2025', { payslips: high }).refund).toBe(812);

    taxProfileDS.save('2024-2025', { ...emptyTaxProfile(), hospitalCover: 'none' });
    const s = pageSettlement('2024-2025', { payslips: high });
    expect(s.liability.components.map(c => c.key)).toContain('medicare-levy-surcharge');
    expect(s.owing).toBe(688);
  });

  it('reconciles a private health statement against the year’s real income', () => {
    const high = [slip({ id: 'h', gross_pay: 120_000, tax_withheld: 30_000, payment_date: '2024-09-01' })];
    taxProfileDS.save('2024-2025', {
      ...emptyTaxProfile(),
      hospitalCover: 'full-year',
      premiumsFirstPeriod: 3_000,
      premiumsSecondPeriod: 1_000,
      rebateReceived: 600,
    });
    // Tier 2 on $120,000: 3,000 × 8.202% + 1,000 × 8.095% = $327.01, so $272.99
    // of the $600 the insurer allowed has to come back.
    const s = pageSettlement('2024-2025', { payslips: high });
    const excess = s.liability.components.find(c => c.key === 'excess-health-rebate')!;
    expect(excess.amount).toBeCloseTo(272.99, 2);
    expect(s.owing).toBeCloseTo(272.99 - 812 > 0 ? 272.99 - 812 : 0, 2);
    expect(s.refund).toBeCloseTo(812 - 272.99, 2);
  });
});
