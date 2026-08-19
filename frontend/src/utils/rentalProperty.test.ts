/**
 * Phase 5.5 — the rental-property tax engine.
 *
 * The cases that matter are the ones a spreadsheet gets wrong: a repayment
 * counted as a deduction, a refund that belongs to a different year, a
 * co-owner's half counted twice, a holiday house claimed in full, and the two
 * days either side of 1 July.
 */

import { describe, it, expect } from 'vitest';
import type { Loan, Property, Transaction } from '../types';
import {
  annualRepayments,
  buildRentalPosition,
  daysOwnedInFY,
  deductibleShareOf,
  defaultAvailableForRent,
  emptyRentalSettings,
  estimateAnnualInterest,
  isInterestCharge,
  rentalActivityDates,
  rentalDeductionKindOf,
  rentalFYBounds,
  type RentalPropertyInput,
  type RentalPropertySettings,
} from './rentalProperty';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const property = (o: Partial<Property> & { id: string }): Property => ({
  user_id: 'u1',
  name: 'Beach Rd',
  address_street: '34 Beach Rd',
  address_suburb: 'Bondi',
  property_type: 'investment',
  purchase_price: 800_000,
  purchase_date: '2018-03-01',
  current_value: 1_000_000,
  ownership_percent: 100,
  rent_match_terms: ['ray white'],
  ...o,
} as Property);

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  user_id: 'u1',
  account_id: 'acc1',
  account_type: 'bank',
  date: '2024-09-01',
  merchant: 'Ray White',
  category: 'Rent',
  currency: 'AUD',
  ...o,
} as Transaction);

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1',
  name: 'Beach Rd mortgage',
  loan_type: 'mortgage',
  original_amount: 600_000,
  current_balance: 500_000,
  interest_rate: 6,
  minimum_repayment: 3_000,
  repayment_frequency: 'monthly',
  ...o,
} as Loan);

const input = (o: Partial<RentalPropertyInput> & { property: Property }): RentalPropertyInput => ({
  transactions: [],
  loan: null,
  ...o,
});

const settings = (o: Partial<RentalPropertySettings> = {}): RentalPropertySettings => ({
  ...emptyRentalSettings(),
  ...o,
});

const FY = '2024-2025';
const build = (props: RentalPropertyInput[], opts: { fy?: string; asOf?: string; linked?: string[] } = {}) =>
  buildRentalPosition({
    fy: opts.fy ?? FY,
    properties: props,
    manuallyLinkedTransactionIds: opts.linked,
    asOf: opts.asOf ?? '2025-06-30',
  });

/** Twelve monthly rent payments across one FY. */
const yearOfRent = (amount = 2_000, from = '2024-07-05'): Transaction[] => {
  const [y, m] = from.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const month = m + i;
    const year = y + Math.floor((month - 1) / 12);
    const mm = String(((month - 1) % 12) + 1).padStart(2, '0');
    return tx({ id: `r${i}`, amount, date: `${year}-${mm}-05` });
  });
};

// ─── Financial-year boundaries ───────────────────────────────────────────────

describe('financial-year boundaries', () => {
  it('opens on 1 July and closes on 30 June', () => {
    expect(rentalFYBounds('2024-2025')).toEqual({ start: '2024-07-01', end: '2025-06-30' });
  });

  it('refuses a label that is not a year', () => {
    expect(() => rentalFYBounds('rubbish')).toThrow();
  });

  it('puts 30 June rent in one year and 1 July rent in the next', () => {
    const props = [input({
      property: property({ id: 'p1' }),
      transactions: [
        tx({ id: 'a', amount: 2_000, date: '2025-06-30' }),
        tx({ id: 'b', amount: 2_000, date: '2025-07-01' }),
      ],
    })];
    expect(build(props).grossIncome).toBe(2_000);
    expect(build(props, { fy: '2025-2026', asOf: '2026-06-30' }).grossIncome).toBe(2_000);
  });

  it('counts an expense in the year it was paid, not the year it was billed for', () => {
    const props = [input({
      property: property({
        id: 'p1',
        property_expenses: [{ id: 'e1', name: 'Waverley Council', kind: 'council', match_terms: ['waverley council'] }],
      }),
      transactions: [
        tx({ id: 'c1', amount: -400, date: '2024-06-30', merchant: 'Waverley Council', category: 'Bills' }),
        tx({ id: 'c2', amount: -400, date: '2024-07-01', merchant: 'Waverley Council', category: 'Bills' }),
      ],
    })];
    // Only the July payment is in FY 2024-25 — the June one belongs to the year before.
    const p = build(props).properties[0];
    expect(p.deductions.find(d => d.kind === 'council')?.claimed).toBe(400);
  });
});

// ─── Rent is what arrived, never what was agreed ─────────────────────────────

describe('rental income', () => {
  it('counts the rent received, not the rent agreed', () => {
    // The lease says $2,000 a month — $24,000 a year — but only nine payments
    // arrived. A yield would report the lease; a tax return reports the money.
    const props = [input({
      property: property({
        id: 'p1',
        expected_rent_amount: 2_000,
        expected_rent_frequency: 'monthly',
      }),
      transactions: yearOfRent().slice(0, 9),
    })];
    expect(build(props).grossIncome).toBe(18_000);
  });

  it('reports the vacant months a shortfall came from', () => {
    const props = [input({ property: property({ id: 'p1' }), transactions: yearOfRent().slice(0, 9) })];
    const p = build(props).properties[0];
    expect(p.monthsWithRent).toBe(9);
    expect(p.monthsOwned).toBe(12);
    expect(p.vacantMonths).toBe(3);
  });

  it('only counts credits from the named payer as rent', () => {
    const props = [input({
      property: property({ id: 'p1', rent_match_terms: ['ray white'] }),
      transactions: [
        tx({ id: 'r1', amount: 2_000, merchant: 'Ray White' }),
        tx({ id: 's1', amount: 5_000, merchant: 'Acme Payroll', category: 'Salary' }),
      ],
    })];
    expect(build(props).grossIncome).toBe(2_000);
  });

  it('adds rental income the bank never saw', () => {
    const props = [input({
      property: property({ id: 'p1' }),
      transactions: [tx({ id: 'r1', amount: 2_000 })],
      settings: settings({ byFY: { [FY]: { interestPaid: null, interestPrivatePercent: 0, availableForRent: null, otherIncome: 1_500, otherDeductions: [] } } }),
    })];
    expect(build(props).grossIncome).toBe(3_500);
  });

  it('never apportions rent for private use — every dollar received is assessable', () => {
    const props = [input({
      property: property({ id: 'p1', property_type: 'holiday' }),
      transactions: [tx({ id: 'r1', amount: 10_000 })],
      settings: settings({ apportionment: { mode: 'percent', percent: 50, daysRented: 0, daysPrivate: 0 } }),
    })];
    expect(build(props).grossIncome).toBe(10_000);
  });
});

// ─── Deductions ──────────────────────────────────────────────────────────────

describe('deductible expenses', () => {
  const withCosts = (extra: Transaction[] = []) => input({
    property: property({
      id: 'p1',
      property_expenses: [
        { id: 'e1', name: 'Strata Plus', kind: 'strata', match_terms: ['strata plus'] },
        { id: 'e2', name: 'Waverley Council', kind: 'council', match_terms: ['waverley council'] },
        { id: 'e3', name: 'Landlord policy', kind: 'insurance', match_terms: ['allianz'] },
      ],
    }),
    transactions: [
      ...yearOfRent(),
      tx({ id: 'x1', amount: -1_100, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
      tx({ id: 'x2', amount: -900, date: '2024-09-15', merchant: 'Waverley Council', category: 'Bills' }),
      tx({ id: 'x3', amount: -650, date: '2024-10-01', merchant: 'Allianz', category: 'Insurance' }),
      ...extra,
    ],
  });

  it('sorts each cost under its ATO heading', () => {
    const p = build([withCosts()]).properties[0];
    const kinds = Object.fromEntries(p.deductions.map(d => [d.kind, d.claimed]));
    expect(kinds.strata).toBe(1_100);
    expect(kinds.council).toBe(900);
    expect(kinds.insurance).toBe(650);
  });

  it('finds a management fee the property card has no heading for', () => {
    const p = build([withCosts([
      tx({ id: 'm1', amount: -1_320, date: '2024-11-01', merchant: 'Ray White Management Fee', category: 'Bills' }),
    ])]).properties[0];
    expect(p.deductions.find(d => d.kind === 'management')?.claimed).toBe(1_320);
  });

  it('nets a refund off the cost it came back against', () => {
    const p = build([withCosts([
      tx({ id: 'ref', amount: 300, date: '2025-01-10', merchant: 'Waverley Council', category: 'Bills' }),
    ])]).properties[0];
    const council = p.deductions.find(d => d.kind === 'council')!;
    expect(council.paid).toBe(900);
    expect(council.refunded).toBe(300);
    expect(council.claimed).toBe(600);
  });

  it('does not report a refund as rental income', () => {
    const withRefund = build([withCosts([
      tx({ id: 'ref', amount: 300, date: '2025-01-10', merchant: 'Waverley Council', category: 'Bills' }),
    ])]);
    expect(withRefund.grossIncome).toBe(24_000);
  });

  it('flags a refund bigger than the year it landed in as a possible earlier-year recoupment', () => {
    const p = build([withCosts([
      tx({ id: 'ref', amount: 1_500, date: '2025-01-10', merchant: 'Waverley Council', category: 'Bills' }),
    ])]).properties[0];
    expect(p.deductions.find(d => d.kind === 'council')!.claimed).toBe(0);
    expect(p.warnings.some(w => w.kind === 'refund-exceeds-cost')).toBe(true);
  });

  it('claims a cost the user never ticked as tax deductible', () => {
    // is_tax_deductible is nowhere on these transactions. A landlord should not
    // have to tick a box on every strata levy for it to reach the return.
    const p = build([withCosts()]).properties[0];
    expect(p.totalDeductions).toBe(2_650);
  });

  it('adds capital works and depreciation, which no bank feed contains', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      settings: settings({
        byFY: {
          [FY]: {
            interestPaid: null, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0,
            otherDeductions: [
              { id: 'd1', label: 'Capital works', kind: 'capital-works', amount: 5_400 },
              { id: 'd2', label: 'Oven, dishwasher', kind: 'depreciation', amount: 900 },
            ],
          },
        },
      }),
    })]).properties[0];
    expect(p.totalDeductions).toBe(6_300);
    expect(p.netRent).toBe(17_700);
  });
});

// ─── The mortgage ────────────────────────────────────────────────────────────

describe('interest and principal', () => {
  it('deducts nothing for a mortgage with no interest figure, and says so', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
    })]).properties[0];
    expect(p.interest.basis).toBe('none');
    expect(p.interest.deductible).toBe(0);
    expect(p.warnings.some(w => w.kind === 'no-interest' && w.severity === 'warn')).toBe(true);
  });

  it('offers an estimate but never counts it', () => {
    const p = build([input({
      property: property({ id: 'p1' }), transactions: yearOfRent(), loan: loan(),
    })]).properties[0];
    expect(p.interest.estimate).toBe(30_000);      // 500,000 × 6%
    expect(p.totalDeductions).toBe(0);
  });

  it('deducts the lender statement figure and nothing else', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
      settings: settings({ byFY: { [FY]: { interestPaid: 28_400, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
    })]).properties[0];
    expect(p.interest.basis).toBe('statement');
    expect(p.interest.deductible).toBe(28_400);
    expect(p.netRent).toBe(24_000 - 28_400);
  });

  it('says the interest came from a statement rather than calling it a payment', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
      settings: settings({ byFY: { [FY]: { interestPaid: 28_400, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
    })]).properties[0];
    const line = p.deductions.find(d => d.kind === 'interest')!;
    expect(line.count).toBe(0);
    expect(line.detail).toMatch(/statement/);
  });

  it('never deducts principal, and reports what it was', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan({ minimum_repayment: 3_000 }),   // $36,000 a year
      settings: settings({ byFY: { [FY]: { interestPaid: 28_400, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
    })]).properties[0];
    expect(p.interest.repayments).toBe(36_000);
    expect(p.interest.principalNotDeductible).toBe(7_600);
    expect(p.totalDeductions).toBe(28_400);   // the principal is nowhere in it
  });

  it('reads interest charges out of the transactions when there is no statement', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
      interestTransactions: [
        tx({ id: 'i1', amount: -2_400, date: '2024-08-31', merchant: 'Interest charged', account_type: 'loan' }),
        tx({ id: 'i2', amount: -2_380, date: '2024-09-30', merchant: 'Interest charged', account_type: 'loan' }),
        tx({ id: 'i3', amount: -3_000, date: '2024-09-30', merchant: 'Loan repayment', account_type: 'loan' }),
      ],
    })]).properties[0];
    expect(p.interest.basis).toBe('transactions');
    expect(p.interest.deductible).toBe(4_780);   // the repayment is not interest
  });

  it('lets the lender statement supersede the interest charges rather than adding to them', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
      interestTransactions: [tx({ id: 'i1', amount: -2_400, merchant: 'Interest charged', account_type: 'loan' })],
      settings: settings({ byFY: { [FY]: { interestPaid: 28_400, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
    })]).properties[0];
    expect(p.interest.deductible).toBe(28_400);
    expect(p.warnings.some(w => w.kind === 'interest-superseded')).toBe(true);
  });

  it('takes out the share of the loan that went on something private', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
      settings: settings({ byFY: { [FY]: { interestPaid: 30_000, interestPrivatePercent: 20, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
    })]).properties[0];
    expect(p.interest.deductible).toBe(24_000);
  });

  it('only counts interest charges dated inside the year', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: yearOfRent(),
      loan: loan(),
      interestTransactions: [
        tx({ id: 'i1', amount: -2_400, date: '2024-06-30', merchant: 'Interest charged', account_type: 'loan' }),
        tx({ id: 'i2', amount: -2_400, date: '2024-07-31', merchant: 'Interest charged', account_type: 'loan' }),
      ],
    })]).properties[0];
    expect(p.interest.deductible).toBe(2_400);
  });

  it('has no estimate for a loan with no rate', () => {
    expect(estimateAnnualInterest(loan({ interest_rate: 0 }))).toBeNull();
    expect(estimateAnnualInterest(null)).toBeNull();
  });

  it('nets an offset off the estimate', () => {
    expect(estimateAnnualInterest(loan({ offset_balance: 100_000 }))).toBe(24_000);
  });

  it('annualises the repayment at the loan’s own frequency', () => {
    expect(annualRepayments(loan({ minimum_repayment: 700, repayment_frequency: 'weekly' }))).toBe(36_400);
    expect(annualRepayments(null)).toBe(0);
  });

  it('tells a repayment from an interest charge', () => {
    expect(isInterestCharge(tx({ id: 'a', amount: -1, merchant: 'Interest charged' }))).toBe(true);
    expect(isInterestCharge(tx({ id: 'b', amount: -1, merchant: 'Loan repayment' }))).toBe(false);
    expect(isInterestCharge(tx({ id: 'c', amount: -1, merchant: 'Interest repayment' }))).toBe(false);
    expect(isInterestCharge(tx({ id: 'd', amount: -1, merchant: 'Strata Plus' }))).toBe(false);
  });
});

// ─── Partial ownership ───────────────────────────────────────────────────────

describe('partial ownership', () => {
  const half = (basis: 'my-share' | 'whole') => input({
    property: property({
      id: 'p1',
      ownership_percent: 50,
      property_expenses: [{ id: 'e1', name: 'Strata Plus', kind: 'strata', match_terms: ['strata plus'] }],
    }),
    transactions: [
      ...yearOfRent(),
      tx({ id: 'x1', amount: -4_000, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
    ],
    settings: settings({ recordedBasis: basis }),
  });

  it('scales nothing by default — the accounts are the user’s own', () => {
    const p = build([half('my-share')]).properties[0];
    expect(p.grossRent).toBe(24_000);
    expect(p.totalDeductions).toBe(4_000);
    expect(p.netRent).toBe(20_000);
  });

  it('warns, with the amount at stake, until the user picks', () => {
    const p = build([half('my-share')]).properties[0];
    const w = p.warnings.find(x => x.kind === 'ownership-unapportioned');
    expect(w?.severity).toBe('warn');
    expect(w?.amount).toBe(10_000);
  });

  it('halves income AND expenses when the whole property runs through the account', () => {
    const p = build([half('whole')]).properties[0];
    expect(p.grossRent).toBe(12_000);
    expect(p.totalDeductions).toBe(2_000);
    expect(p.netRent).toBe(10_000);
    expect(p.warnings.some(x => x.kind === 'ownership-unapportioned')).toBe(false);
  });

  it('applies the share to the interest too', () => {
    const p = build([input({
      property: property({ id: 'p1', ownership_percent: 50 }),
      transactions: yearOfRent(),
      loan: loan(),
      settings: settings({
        recordedBasis: 'whole',
        byFY: { [FY]: { interestPaid: 30_000, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } },
      }),
    })]).properties[0];
    expect(p.interest.deductible).toBe(15_000);
  });

  it('does not scale a figure the user typed themselves', () => {
    // Capital works came off a quantity surveyor's schedule for THIS owner.
    const p = build([input({
      property: property({ id: 'p1', ownership_percent: 50 }),
      transactions: yearOfRent(),
      settings: settings({
        recordedBasis: 'whole',
        byFY: {
          [FY]: {
            interestPaid: null, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0,
            otherDeductions: [{ id: 'd1', label: 'Capital works', kind: 'capital-works', amount: 4_000 }],
          },
        },
      }),
    })]).properties[0];
    expect(p.totalDeductions).toBe(4_000);
  });
});

// ─── Mixed personal / rental use ─────────────────────────────────────────────

describe('private use', () => {
  const holiday = (apportionment: RentalPropertySettings['apportionment']) => input({
    property: property({
      id: 'p1',
      property_type: 'holiday',
      rent_match_terms: ['stayz'],
      property_expenses: [{ id: 'e1', name: 'Council', kind: 'council', match_terms: ['council'] }],
    }),
    transactions: [
      tx({ id: 'r1', amount: 8_000, date: '2025-01-10', merchant: 'Stayz Payout' }),
      tx({ id: 'x1', amount: -2_000, date: '2024-09-01', merchant: 'Council', category: 'Bills' }),
    ],
    settings: settings({ apportionment }),
  });

  it('claims a fixed share of the costs', () => {
    const p = build([holiday({ mode: 'percent', percent: 40, daysRented: 0, daysPrivate: 0 })]).properties[0];
    expect(p.income).toBe(8_000);
    expect(p.totalDeductions).toBe(800);
  });

  it('works the share out from nights let over nights OWNED, as the ATO does', () => {
    // 146 nights let or available, out of the 365 the property was owned — 40%.
    const p = build([holiday({ mode: 'days', percent: 0, daysRented: 146, daysPrivate: 219 })]).properties[0];
    expect(p.deductibleShare).toBeCloseTo(146 / 365, 5);
    expect(p.totalDeductions).toBe(800);
  });

  it('divides by the days OWNED, not by the days accounted for', () => {
    // 100 nights let, 100 private and 165 nobody has accounted for. Dividing by
    // rented + private would claim half the costs of a property that sat idle.
    const p = build([holiday({ mode: 'days', percent: 0, daysRented: 100, daysPrivate: 100 })]).properties[0];
    expect(p.deductibleShare).toBeCloseTo(100 / 365, 5);
  });

  it('scales the denominator to a part-year of ownership', () => {
    // Settled 1 January: 181 nights owned, 90 of them let.
    const p = build([input({
      property: property({
        id: 'p1', property_type: 'holiday', purchase_date: '2025-01-01', rent_match_terms: ['stayz'],
        property_expenses: [{ id: 'e1', name: 'Council', kind: 'council', match_terms: ['council'] }],
      }),
      transactions: [
        tx({ id: 'r1', amount: 8_000, date: '2025-02-10', merchant: 'Stayz Payout' }),
        tx({ id: 'x1', amount: -1_810, date: '2025-02-01', merchant: 'Council', category: 'Bills' }),
      ],
      settings: settings({ apportionment: { mode: 'days', percent: 0, daysRented: 90, daysPrivate: 91 } }),
    })]).properties[0];
    expect(daysOwnedInFY('2025-01-01', FY, '2025-06-30')).toBe(181);
    expect(p.deductibleShare).toBeCloseTo(90 / 181, 5);
  });

  it('claims everything when neither kind of night was recorded', () => {
    // An unanswered question must not silently wipe out the whole claim.
    expect(deductibleShareOf({ mode: 'days', percent: 0, daysRented: 0, daysPrivate: 0 }, 365)).toBe(1);
  });

  it('never apportions the agent’s fee or advertising', () => {
    // They exist only because the property was let, so the ATO does not
    // apportion them however private the rest of the year was.
    const p = build([input({
      property: property({
        id: 'p1', property_type: 'holiday', rent_match_terms: ['stayz'],
        property_expenses: [{ id: 'e1', name: 'Council', kind: 'council', match_terms: ['council'] }],
      }),
      transactions: [
        tx({ id: 'r1', amount: 8_000, date: '2025-01-10', merchant: 'Stayz Payout' }),
        tx({ id: 'x1', amount: -2_000, date: '2024-09-01', merchant: 'Council', category: 'Bills' }),
        tx({ id: 'x2', amount: -800, date: '2024-09-02', merchant: 'Stayz management fee', category: 'Bills' }),
        tx({ id: 'x3', amount: -300, date: '2024-09-03', merchant: 'Advertising for tenants', category: 'Bills' }),
      ],
      settings: settings({ apportionment: { mode: 'percent', percent: 40, daysRented: 0, daysPrivate: 0 } }),
    })]).properties[0];
    expect(p.deductions.find(d => d.kind === 'council')!.claimed).toBe(800);
    expect(p.deductions.find(d => d.kind === 'management')!.claimed).toBe(800);
    expect(p.deductions.find(d => d.kind === 'advertising')!.claimed).toBe(300);
  });

  it('lets one cost differ from the property’s own share', () => {
    // The landlord policy is wholly rental; the power bill is shared.
    const p = build([input({
      property: property({
        id: 'p1',
        property_type: 'holiday',
        rent_match_terms: ['stayz'],
        property_expenses: [
          { id: 'e1', name: 'Council', kind: 'council', match_terms: ['council'] },
          { id: 'e2', name: 'Landlord policy', kind: 'insurance', match_terms: ['allianz'] },
        ],
      }),
      transactions: [
        tx({ id: 'r1', amount: 8_000, date: '2025-01-10', merchant: 'Stayz Payout' }),
        tx({ id: 'x1', amount: -2_000, date: '2024-09-01', merchant: 'Council', category: 'Bills' }),
        tx({ id: 'x2', amount: -600, date: '2024-10-01', merchant: 'Allianz', category: 'Insurance' }),
      ],
      settings: settings({
        apportionment: { mode: 'percent', percent: 40, daysRented: 0, daysPrivate: 0 },
        ruleDeductiblePercent: { e2: 100 },
      }),
    })]).properties[0];
    expect(p.deductions.find(d => d.kind === 'council')!.claimed).toBe(800);
    expect(p.deductions.find(d => d.kind === 'insurance')!.claimed).toBe(600);
  });

  it('says how much apportionment cost', () => {
    const p = build([holiday({ mode: 'percent', percent: 40, daysRented: 0, daysPrivate: 0 })]).properties[0];
    const w = p.warnings.find(x => x.kind === 'private-use');
    expect(w?.amount).toBe(1_200);
  });
});

// ─── Below-market rent ───────────────────────────────────────────────────────

describe('rent below the market rate', () => {
  const family = (below: boolean) => input({
    property: property({
      id: 'p1',
      rent_match_terms: ['daughter'],
      property_expenses: [{ id: 'e1', name: 'Council', kind: 'council', match_terms: ['council'] }],
    }),
    transactions: [
      tx({ id: 'r1', amount: 6_000, date: '2024-12-01', merchant: 'Daughter' }),
      tx({ id: 'x1', amount: -9_000, date: '2024-09-01', merchant: 'Council', category: 'Bills' }),
    ],
    settings: settings({
      byFY: { [FY]: { interestPaid: null, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, rentBelowMarket: below, otherDeductions: [] } },
    }),
  });

  it('caps the deductions at the rent, so the year makes neither profit nor loss', () => {
    const p = build([family(true)]).properties[0];
    expect(p.income).toBe(6_000);
    expect(p.totalDeductions).toBe(6_000);
    expect(p.netRent).toBe(0);
    expect(p.warnings.find(w => w.kind === 'below-market-rent')?.amount).toBe(3_000);
  });

  it('leaves a commercial letting alone', () => {
    const p = build([family(false)]).properties[0];
    expect(p.netRent).toBe(-3_000);
  });

  it('never caps upwards', () => {
    const props = [family(true)];
    props[0].transactions = [tx({ id: 'r1', amount: 20_000, date: '2024-12-01', merchant: 'Daughter' })];
    expect(build(props).properties[0].totalDeductions).toBe(0);
  });
});

// ─── Announced changes ───────────────────────────────────────────────────────

describe('the 2026-27 Budget', () => {
  it('says the announced negative-gearing changes are not modelled, from 2026-27 on', () => {
    const props = [input({ property: property({ id: 'p1' }), transactions: [tx({ id: 'r1', amount: 2_000, date: '2026-12-01' })] })];
    const later = buildRentalPosition({ fy: '2026-2027', properties: props, asOf: '2027-06-30' });
    expect(later.warnings.some(w => w.kind === 'announced-changes')).toBe(true);
  });

  it('says nothing about them for a year they cannot touch', () => {
    const props = [input({ property: property({ id: 'p1' }), transactions: [tx({ id: 'r1', amount: 2_000, date: '2024-12-01' })] })];
    expect(build(props).warnings.some(w => w.kind === 'announced-changes')).toBe(false);
  });
});

// ─── Vacancy and availability ────────────────────────────────────────────────

describe('vacancy', () => {
  const emptyYear = (type: Property['property_type'], available: boolean | null = null) => input({
    property: property({
      id: 'p1',
      property_type: type,
      property_expenses: [{ id: 'e1', name: 'Council', kind: 'council', match_terms: ['council'] }],
    }),
    transactions: [tx({ id: 'x1', amount: -2_000, date: '2024-09-01', merchant: 'Council', category: 'Bills' })],
    settings: settings({
      byFY: { [FY]: { interestPaid: null, interestPrivatePercent: 0, availableForRent: available, otherIncome: 0, otherDeductions: [] } },
    }),
  });

  it('still claims a whole vacant year on a property the user called an investment', () => {
    const p = build([emptyYear('investment')]).properties[0];
    expect(p.inSchedule).toBe(true);
    expect(p.totalDeductions).toBe(2_000);
    expect(p.warnings.some(w => w.kind === 'vacant-year')).toBe(true);
  });

  it('claims nothing on a vacant holiday house until the user says it was available', () => {
    const p = build([emptyYear('holiday')]).properties[0];
    expect(p.inSchedule).toBe(false);
    expect(p.excludedReason).toBe('not-available-for-rent');
    expect(p.warnings.find(w => w.kind === 'not-available-for-rent')?.amount).toBe(2_000);
  });

  it('claims it once they do', () => {
    const p = build([emptyYear('holiday', true)]).properties[0];
    expect(p.inSchedule).toBe(true);
    expect(p.totalDeductions).toBe(2_000);
  });

  it('lets the user rule an investment property out for the year', () => {
    const p = build([emptyYear('investment', false)]).properties[0];
    expect(p.inSchedule).toBe(false);
  });

  it('reads the default off the property type', () => {
    expect(defaultAvailableForRent('investment')).toBe(true);
    expect(defaultAvailableForRent('holiday')).toBe(false);
    expect(defaultAvailableForRent(null)).toBe(false);
  });

  it('counts a part-year of ownership as a part-year, not eleven months vacant', () => {
    const p = build([input({
      property: property({ id: 'p1', purchase_date: '2025-04-01' }),
      transactions: [
        tx({ id: 'r1', amount: 2_000, date: '2025-05-05' }),
        tx({ id: 'r2', amount: 2_000, date: '2025-06-05' }),
      ],
    })]).properties[0];
    expect(p.monthsOwned).toBe(3);
    expect(p.vacantMonths).toBe(1);
  });
});

// ─── Which properties are in the schedule at all ─────────────────────────────

describe('what belongs in a rental schedule', () => {
  it('leaves the family home out entirely', () => {
    const p = build([input({
      property: property({ id: 'p1', property_type: 'home', rent_match_terms: [] }),
      transactions: [tx({ id: 'x1', amount: -2_000, merchant: 'Council', category: 'Bills' })],
    })]).properties[0];
    expect(p.inSchedule).toBe(false);
    expect(p.excludedReason).toBe('owner-occupied');
  });

  it('leaves an SMSF property out — the fund lodges its own return', () => {
    const p = build([input({
      property: property({ id: 'p1', held_by: 'smsf' }),
      transactions: yearOfRent(),
    })]).properties[0];
    expect(p.inSchedule).toBe(false);
    expect(p.excludedReason).toBe('held-in-fund');
  });

  it('reports a property with nothing in it rather than dropping it', () => {
    const p = build([input({ property: property({ id: 'p1' }) })]).properties[0];
    expect(p.inSchedule).toBe(false);
    expect(p.excludedReason).toBe('no-activity');
  });
});

// ─── Several properties ──────────────────────────────────────────────────────

describe('multiple properties', () => {
  const two = () => [
    input({
      property: property({
        id: 'p1', name: 'Bondi', rent_match_terms: ['ray white'],
        property_expenses: [{ id: 'e1', name: 'Strata', kind: 'strata', match_terms: ['strata plus'] }],
      }),
      transactions: [
        tx({ id: 'r1', amount: 24_000, date: '2024-12-01', merchant: 'Ray White' }),
        tx({ id: 'x1', amount: -4_000, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
      ],
      loan: loan(),
      settings: settings({ byFY: { [FY]: { interestPaid: 30_000, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
    }),
    input({
      property: property({ id: 'p2', name: 'Coogee', rent_match_terms: ['lj hooker'] }),
      transactions: [tx({ id: 'r2', amount: 18_000, date: '2024-12-01', merchant: 'LJ Hooker' })],
    }),
  ];

  it('adds the schedules together', () => {
    const pos = build(two());
    expect(pos.grossIncome).toBe(42_000);
    expect(pos.totalDeductions).toBe(34_000);
    expect(pos.netRent).toBe(8_000);
  });

  it('reports a loss on one property against a profit on the other', () => {
    const pos = build(two());
    expect(pos.properties[0].netRent).toBe(-10_000);
    expect(pos.properties[1].netRent).toBe(18_000);
  });

  it('reports the net loss as a positive add-back figure when the total is negative', () => {
    const props = two();
    props[1].transactions = [];
    const pos = build(props);
    expect(pos.netRent).toBe(-10_000);
    expect(pos.netRentalLoss).toBe(10_000);
    expect(pos.warnings.some(w => w.kind === 'net-rental-loss')).toBe(true);
  });

  it('has no add-back when the properties made money', () => {
    expect(build(two()).netRentalLoss).toBe(0);
  });
});

// ─── Not counting the same money twice ───────────────────────────────────────

describe('double counting', () => {
  it('lists every payment it claimed, so the FY position can suppress them', () => {
    const pos = build([input({
      property: property({
        id: 'p1',
        property_expenses: [{ id: 'e1', name: 'Strata', kind: 'strata', match_terms: ['strata plus'] }],
      }),
      transactions: [
        tx({ id: 'r1', amount: 2_000 }),
        tx({ id: 'x1', amount: -1_100, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
      ],
    })]);
    expect(pos.claimedTransactionIds.sort()).toEqual(['r1', 'x1']);
  });

  it('releases a payment a manual deduction is explicitly linked to', () => {
    const props = [input({
      property: property({
        id: 'p1',
        property_expenses: [{ id: 'e1', name: 'Strata', kind: 'strata', match_terms: ['strata plus'] }],
      }),
      transactions: [
        tx({ id: 'r1', amount: 2_000 }),
        tx({ id: 'x1', amount: -1_100, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
      ],
    })];
    const pos = build(props, { linked: ['x1'] });
    expect(pos.totalDeductions).toBe(0);
    expect(pos.releasedTransactionIds).toEqual(['x1']);
    expect(pos.claimedTransactionIds).toEqual(['r1']);
  });

  it('never claims a mortgage repayment as a property expense', () => {
    // countsAsPropertyMoney refuses anything on a loan account, so the schedule
    // and the loan's own figures can never both count the same repayment.
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: [
        ...yearOfRent(),
        tx({ id: 'm1', amount: -3_000, date: '2024-08-01', merchant: 'Mortgage repayment', account_type: 'loan' }),
      ],
    })]).properties[0];
    expect(p.totalDeductions).toBe(0);
  });

  it('never claims an internal transfer', () => {
    const p = build([input({
      property: property({ id: 'p1' }),
      transactions: [...yearOfRent(), tx({ id: 't1', amount: -5_000, date: '2024-08-01', is_transfer: true })],
    })]).properties[0];
    expect(p.totalDeductions).toBe(0);
  });
});

// ─── Classification ──────────────────────────────────────────────────────────

describe('headings', () => {
  it('lets the rule’s own kind beat the wording', () => {
    expect(rentalDeductionKindOf(tx({ id: 'a', amount: -1, merchant: 'Water Board' }), 'insurance'))
      .toBe('insurance');
  });

  it('still reads the wording when the rule says only "other"', () => {
    expect(rentalDeductionKindOf(tx({ id: 'a', amount: -1, merchant: 'Agency Fee' }), 'other'))
      .toBe('management');
  });

  it('finds land tax, which the property card files under council rates', () => {
    expect(rentalDeductionKindOf(tx({ id: 'a', amount: -1, merchant: 'Revenue NSW land tax' }), null))
      .toBe('land-tax');
  });

  it('falls back to "other" rather than guessing', () => {
    expect(rentalDeductionKindOf(tx({ id: 'a', amount: -1, merchant: 'Bunnings' }), null)).toBe('other');
  });
});

// ─── Initial repairs ─────────────────────────────────────────────────────────

describe('initial repairs', () => {
  it('warns about a repair inside the first year of ownership', () => {
    const p = build([input({
      property: property({
        id: 'p1',
        purchase_date: '2024-08-01',
        property_expenses: [{ id: 'e1', name: 'Plumber', kind: 'maintenance', match_terms: ['plumber'] }],
      }),
      transactions: [
        tx({ id: 'r1', amount: 2_000, date: '2024-10-05' }),
        tx({ id: 'x1', amount: -3_400, date: '2024-09-01', merchant: 'Plumber Pro', category: 'Maintenance' }),
      ],
    })]).properties[0];
    const w = p.warnings.find(x => x.kind === 'initial-repairs');
    expect(w?.amount).toBe(3_400);
    // Still claimed: leaving a genuine repair out would overstate the tax.
    expect(p.deductions.find(d => d.kind === 'repairs')!.claimed).toBe(3_400);
  });

  it('says nothing about a repair years after settlement', () => {
    const p = build([input({
      property: property({
        id: 'p1',
        purchase_date: '2018-03-01',
        property_expenses: [{ id: 'e1', name: 'Plumber', kind: 'maintenance', match_terms: ['plumber'] }],
      }),
      transactions: [tx({ id: 'x1', amount: -3_400, date: '2024-09-01', merchant: 'Plumber Pro', category: 'Maintenance' })],
    })]).properties[0];
    expect(p.warnings.some(x => x.kind === 'initial-repairs')).toBe(false);
  });
});

// ─── Activity dates ──────────────────────────────────────────────────────────

describe('activity dates', () => {
  it('offers every date a lettable property saw money move', () => {
    const dates = rentalActivityDates([
      input({ property: property({ id: 'p1' }), transactions: [tx({ id: 'r1', amount: 2_000, date: '2024-09-01' })] }),
      input({ property: property({ id: 'p2', property_type: 'home' }), transactions: [tx({ id: 'r2', amount: 2_000, date: '2019-09-01' })] }),
    ]);
    expect(dates).toEqual(['2024-09-01']);
  });

  it('offers a year that exists only because the user entered a figure for it', () => {
    const dates = rentalActivityDates([
      input({
        property: property({ id: 'p1' }),
        settings: settings({ byFY: { '2022-2023': { interestPaid: 100, interestPrivatePercent: 0, availableForRent: null, otherIncome: 0, otherDeductions: [] } } }),
      }),
    ]);
    expect(dates).toEqual(['2023-06-30']);
  });
});
