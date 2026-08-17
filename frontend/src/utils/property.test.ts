import { describe, it, expect } from 'vitest';
import {
  ownershipShare, ownedValue, linkedLoan, netWorthValue, propertyNetWorthTotal,
  buildPropertyReport, availableLoansForProperty, validateProperty,
  PROPERTY_TYPE_LABELS,
} from './property';
import type { Property, Loan } from '../types';

/**
 * The property engine.
 *
 * The load-bearing claim of this phase is that a mortgage is counted ONCE. A
 * property contributes the share of its value that the user owns; the loan is
 * subtracted by the loans side of net worth. `netWorthEffect` re-derives the
 * pair, so the tests below can assert the whole rather than trusting each half.
 */

const property = (o: Partial<Property> = {}): Property => ({
  id: 'p1', user_id: 'me', name: 'Bondi apartment', address: '12 Beach Rd',
  property_type: 'home', purchase_price: 800_000, purchase_date: '2020-03-01',
  current_value: 1_000_000, ownership_percent: 100, loan_id: null,
  include_in_net_worth: true, ...o,
});

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: 'me', name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 640_000, current_balance: 600_000, repayment_frequency: 'monthly',
  include_in_net_worth: true, ...o,
} as Loan);

// ═════════════════════════════════════════════════════════════════════════════
//  Ownership
// ═════════════════════════════════════════════════════════════════════════════
describe('the share you own', () => {
  it('100% is the whole thing', () => {
    expect(ownershipShare(property())).toBe(1);
    expect(ownedValue(property())).toBe(1_000_000);
  });

  it('a half-owned house contributes half its value', () => {
    expect(ownedValue(property({ ownership_percent: 50 }))).toBe(500_000);
  });

  it('an odd share is not rounded away', () => {
    expect(ownedValue(property({ ownership_percent: 33.3, current_value: 900_000 }))).toBe(299_700);
  });

  it('a missing share means sole ownership, not zero', () => {
    expect(ownershipShare({ ownership_percent: undefined as unknown as number })).toBe(1);
    expect(ownershipShare({ ownership_percent: NaN })).toBe(1);
  });

  it('a typo cannot multiply your net worth — out of range is clamped', () => {
    expect(ownedValue(property({ ownership_percent: 1000 }))).toBe(1_000_000);
    expect(ownedValue(property({ ownership_percent: -20 }))).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Net worth — the one place double-counting could happen
// ═════════════════════════════════════════════════════════════════════════════
describe('what a property adds to net worth', () => {
  it('is the owned value, and NEVER nets off the mortgage', () => {
    const p = property({ loan_id: 'l1' });
    // The loan exists and is linked, yet the property's own contribution is
    // untouched by it: the loans total subtracts that balance.
    expect(netWorthValue(p)).toBe(1_000_000);
    expect(propertyNetWorthTotal([p])).toBe(1_000_000);
  });

  it('opting a property out contributes nothing', () => {
    expect(netWorthValue(property({ include_in_net_worth: false }))).toBe(0);
  });

  it('several properties add up, each at its own share', () => {
    const total = propertyNetWorthTotal([
      property({ id: 'p1', current_value: 1_000_000, ownership_percent: 100 }),
      property({ id: 'p2', current_value: 600_000, ownership_percent: 50 }),
      property({ id: 'p3', current_value: 400_000, include_in_net_worth: false }),
    ]);
    expect(total).toBe(1_300_000);
  });

  it('the effect on net worth equals equity when the mortgage counts too', () => {
    const { rows } = buildPropertyReport([property({ loan_id: 'l1' })], [loan()]);
    expect(rows[0].equity).toBe(400_000);          // 1,000,000 − 600,000
    expect(rows[0].netWorthEffect).toBe(400_000);  // asset here − debt over there
  });

  it('a mortgage excluded from net worth still shows in equity but does not move net worth', () => {
    const { rows } = buildPropertyReport(
      [property({ loan_id: 'l1' })],
      [loan({ include_in_net_worth: false })],
    );
    expect(rows[0].equity).toBe(400_000);            // what you'd keep on a sale
    expect(rows[0].netWorthEffect).toBe(1_000_000);  // the loan isn't subtracted anywhere
    expect(rows[0].debtCountsTowardNetWorth).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The report
// ═════════════════════════════════════════════════════════════════════════════
describe('building the report', () => {
  it('an unencumbered property has no debt and no LVR', () => {
    const { rows } = buildPropertyReport([property()], [loan()]);
    expect(rows[0].loan).toBeNull();
    expect(rows[0].debt).toBe(0);
    expect(rows[0].lvr).toBeNull();
    expect(rows[0].equity).toBe(1_000_000);
  });

  it('a linked property carries its loan, balance and LVR', () => {
    const { rows } = buildPropertyReport([property({ loan_id: 'l1' })], [loan()]);
    expect(rows[0].loan).toEqual({ id: 'l1', name: 'Home mortgage', balance: 600_000 });
    expect(rows[0].lvr).toBe(60);
  });

  it('a link to a loan that no longer exists reads as unencumbered, not as a crash', () => {
    const { rows } = buildPropertyReport([property({ loan_id: 'gone' })], []);
    expect(rows[0].loan).toBeNull();
    expect(rows[0].equity).toBe(1_000_000);
  });

  it('ownership scales the value but never the loan', () => {
    // Half the house, whole mortgage: the balance is what this user actually owes.
    const { rows } = buildPropertyReport([property({ ownership_percent: 50, loan_id: 'l1' })], [loan()]);
    expect(rows[0].ownedValue).toBe(500_000);
    expect(rows[0].debt).toBe(600_000);
    expect(rows[0].equity).toBe(-100_000);
  });

  it('gain is measured share-for-share, so a joint buy is not a fake loss', () => {
    const { rows } = buildPropertyReport(
      [property({ ownership_percent: 50, purchase_price: 800_000, current_value: 1_000_000 })],
      [],
    );
    expect(rows[0].gain).toBe(100_000);       // 500,000 owned now vs 400,000 paid
    expect(rows[0].gainPercent).toBe(25);
  });

  it('no purchase price on file means no invented gain', () => {
    const { rows } = buildPropertyReport([property({ purchase_price: 0 })], []);
    expect(rows[0].gain).toBeNull();
    expect(rows[0].gainPercent).toBeNull();
  });

  it('carries the type through with a readable label', () => {
    const { rows } = buildPropertyReport([property({ property_type: 'investment' })], []);
    expect(rows[0].typeLabel).toBe(PROPERTY_TYPE_LABELS.investment);
  });

  it('totals a portfolio without counting any mortgage twice', () => {
    const { totals } = buildPropertyReport(
      [
        property({ id: 'p1', current_value: 1_000_000, loan_id: 'l1' }),
        property({ id: 'p2', current_value: 600_000, ownership_percent: 50, loan_id: 'l2' }),
        property({ id: 'p3', current_value: 400_000 }),
      ],
      [loan(), loan({ id: 'l2', name: 'Investment mortgage', current_balance: 250_000 })],
    );
    expect(totals.count).toBe(3);
    expect(totals.value).toBe(2_000_000);
    expect(totals.ownedValue).toBe(1_700_000);   // 1,000,000 + 300,000 + 400,000
    expect(totals.debt).toBe(850_000);           // each loan once
    expect(totals.equity).toBe(850_000);
    expect(totals.netWorthEffect).toBe(850_000);
  });

  it('an empty portfolio totals zero rather than NaN', () => {
    const { rows, totals } = buildPropertyReport([], []);
    expect(rows).toEqual([]);
    expect(totals).toEqual({ value: 0, ownedValue: 0, debt: 0, equity: 0, netWorthEffect: 0, count: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Linking a mortgage
// ═════════════════════════════════════════════════════════════════════════════
describe('which loans a property may link to', () => {
  const loans = [
    loan({ id: 'l1', name: 'Home mortgage', loan_type: 'mortgage' }),
    loan({ id: 'l2', name: 'Investment mortgage', loan_type: 'mortgage' }),
    loan({ id: 'l3', name: 'Car loan', loan_type: 'car' }),
  ];

  it('offers every loan when nothing is linked yet, mortgages first', () => {
    expect(availableLoansForProperty(loans, [], null).map(l => l.id)).toEqual(['l1', 'l2', 'l3']);
  });

  it('hides a loan already backing another property', () => {
    const taken = [property({ id: 'other', loan_id: 'l1' })];
    expect(availableLoansForProperty(loans, taken, 'p1').map(l => l.id)).toEqual(['l2', 'l3']);
  });

  it('still offers the property its OWN current loan, so editing does not unlink it', () => {
    const mine = [property({ id: 'p1', loan_id: 'l1' })];
    expect(availableLoansForProperty(loans, mine, 'p1').map(l => l.id)).toEqual(['l1', 'l2', 'l3']);
  });

  it('finds the linked loan, or null when there is none', () => {
    expect(linkedLoan(property({ loan_id: 'l2' }), loans)?.name).toBe('Investment mortgage');
    expect(linkedLoan(property({ loan_id: null }), loans)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Validation
// ═════════════════════════════════════════════════════════════════════════════
describe('validating a draft', () => {
  const ctx = (o: { loans?: Loan[]; properties?: Property[]; propertyId?: string | null } = {}) => ({
    loans: o.loans ?? [loan()],
    properties: o.properties ?? [],
    propertyId: o.propertyId ?? null,
  });
  const draft = { name: 'Bondi apartment', current_value: 1_000_000 };

  it('accepts a sound draft', () => {
    expect(validateProperty(draft, ctx())).toEqual([]);
  });

  it('needs a name and a sane value', () => {
    expect(validateProperty({ name: '  ', current_value: 1 }, ctx())).toHaveLength(1);
    expect(validateProperty({ name: 'x', current_value: -5 }, ctx())).toHaveLength(1);
  });

  it('refuses an ownership share outside 0–100', () => {
    expect(validateProperty({ ...draft, ownership_percent: 120 }, ctx())).toHaveLength(1);
    expect(validateProperty({ ...draft, ownership_percent: 50 }, ctx())).toEqual([]);
  });

  it('refuses a loan that does not exist', () => {
    expect(validateProperty({ ...draft, loan_id: 'ghost' }, ctx())).toEqual(['That loan no longer exists.']);
  });

  it('refuses a loan already linked elsewhere — the double-count guard', () => {
    const taken = [property({ id: 'other', name: 'Beach house', loan_id: 'l1' })];
    expect(validateProperty({ ...draft, loan_id: 'l1' }, ctx({ properties: taken })))
      .toEqual(['That loan is already linked to "Beach house".']);
  });

  it('lets a property keep the loan it already holds', () => {
    const mine = [property({ id: 'p1', loan_id: 'l1' })];
    expect(validateProperty({ ...draft, loan_id: 'l1' }, ctx({ properties: mine, propertyId: 'p1' }))).toEqual([]);
  });
});
