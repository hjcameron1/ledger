import { describe, it, expect } from 'vitest';
import {
  ownershipShare, ownedValue, linkedLoan, netWorthValue, propertyNetWorthTotal,
  buildPropertyReport, availableLoansForProperty, availableFundsForProperty,
  validateProperty, formatAddress, streetLine, propertyLabel, addressParts,
  heldBy, countedInFund, fundLink, linkedFund, isAustralia,
  attributeTransactions, hasMatchRules, performanceWindow, annualMortgageCost,
  isOwnerOccupied, canEarnRent, hasRentRules, expectedAnnualRent, rentRules, isRentCredit, rentMatch,
  classifyPropertyExpense, suggestRentPayers, previewRules,
  uniqueRealTransactions, derivePayerTerm, rentRuleFromTransaction,
  suggestExpenseBillers, expenseRuleFromTransaction, convertLegacyRules,
  PROPERTY_TYPE_LABELS, HELD_BY_LABELS,
  type FundEntity,
} from './property';
import type {
  Property, PropertyType, Loan, Transaction, PropertyExpenseRule,
} from '../types';

/**
 * The property engine.
 *
 * The load-bearing claim of this phase is that nothing is counted twice, and
 * nothing is missed. A property contributes the share of its value that the user
 * owns; its mortgage is subtracted by the loans side of net worth, unless that
 * loan is itself switched out of net worth, in which case the property subtracts
 * it — exactly one of the two, for every combination of the switches. When the
 * SMSF holding a property already lists it, the property adds nothing of its own,
 * because the fund's balance is carrying the value. `netWorthEffect` re-derives
 * the whole picture, so the tests below can assert the total rather than trusting
 * each half: for a property that counts, it is that property's EQUITY.
 */

const property = (o: Partial<Property> = {}): Property => ({
  id: 'p1', user_id: 'me', name: 'Bondi apartment',
  address_unit: null, address_street: '34 Beach Rd', address_suburb: 'Bondi',
  address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
  property_type: 'home', held_by: 'personal',
  purchase_price: 800_000, purchase_date: '2020-03-01',
  current_value: 1_000_000, ownership_percent: 100, loan_id: null,
  include_in_net_worth: true, ...o,
});

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: 'me', name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 640_000, current_balance: 600_000, repayment_frequency: 'monthly',
  include_in_net_worth: true, ...o,
} as Loan);

const smsf = (o: Partial<FundEntity> = {}): FundEntity =>
  ({ kind: 'smsf', id: 'f1', name: 'Cameron Super Fund', includeInNetWorth: true, ...o });

/** An SMSF-held property, linked to `smsf()` and counted inside it by default. */
const inFund = (o: Partial<Property> = {}): Property =>
  property({ held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: true, ...o });

// ═════════════════════════════════════════════════════════════════════════════
//  Structured address
// ═════════════════════════════════════════════════════════════════════════════
describe('the address', () => {
  it('reads as one line, in the order an envelope wants it', () => {
    expect(formatAddress(property())).toBe('34 Beach Rd, Bondi NSW 2026, Australia');
  });

  it('puts a unit NUMBER in front with a slash', () => {
    expect(formatAddress(property({ address_unit: '12' }))).toBe('12/34 Beach Rd, Bondi NSW 2026, Australia');
    expect(streetLine({ unit: '12A', street: '34 Beach Rd' })).toBe('12A/34 Beach Rd');
  });

  it('but a lot or wordy unit gets a comma, not a nonsense slash', () => {
    expect(streetLine({ unit: 'Lot 7', street: 'Beach Rd' })).toBe('Lot 7, Beach Rd');
  });

  it('the short form is what you need to recognise it in a list', () => {
    expect(formatAddress(property({ address_unit: '12' }), { short: true })).toBe('12/34 Beach Rd, Bondi');
  });

  it('trims what the user typed and defaults the country', () => {
    const parts = addressParts({ address_street: '  34 Beach Rd  ', address_country: '  ' });
    expect(parts.street).toBe('34 Beach Rd');
    expect(parts.country).toBe('Australia');
  });

  it('a pre-refinement row still reads correctly from its old single line', () => {
    const legacy = { address: '12 Beach Rd, Bondi NSW' } as Partial<Property>;
    expect(formatAddress(legacy)).toBe('12 Beach Rd, Bondi NSW');
    expect(propertyLabel(legacy)).toBe('12 Beach Rd, Bondi NSW');
  });

  it('knows when to offer a state dropdown', () => {
    expect(isAustralia('Australia')).toBe(true);
    expect(isAustralia('')).toBe(true);          // the default
    expect(isAustralia('New Zealand')).toBe(false);
  });
});

describe('what a property is called', () => {
  it('the nickname when there is one', () => {
    expect(propertyLabel(property())).toBe('Bondi apartment');
  });

  it('the address when there is not — so nothing is ever unlabelled', () => {
    expect(propertyLabel(property({ name: null }))).toBe('34 Beach Rd, Bondi');
    expect(propertyLabel(property({ name: '   ' }))).toBe('34 Beach Rd, Bondi');
  });

  it('the row exposes both, so the UI can tell them apart', () => {
    const { rows } = buildPropertyReport([property({ name: null })], []);
    expect(rows[0].name).toBe('34 Beach Rd, Bondi');
    expect(rows[0].nickname).toBeNull();
  });
});

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

  it('partial ownership works however the property is held', () => {
    expect(ownedValue(property({ held_by: 'joint', ownership_percent: 50 }))).toBe(500_000);
    expect(ownedValue(inFund({ ownership_percent: 25, counted_in_fund_balance: false }))).toBe(250_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Held by
// ═════════════════════════════════════════════════════════════════════════════
describe('who holds it', () => {
  it('personal, joint and SMSF all carry through with a label', () => {
    for (const held of ['personal', 'joint', 'smsf'] as const) {
      expect(heldBy(property({ held_by: held }))).toBe(held);
    }
    const { rows } = buildPropertyReport([property({ held_by: 'joint' })], []);
    expect(rows[0].heldByLabel).toBe(HELD_BY_LABELS.joint);
  });

  it('a row saved before the field existed is held personally', () => {
    expect(heldBy({ held_by: undefined })).toBe('personal');
    expect(heldBy({ held_by: 'nonsense' as never })).toBe('personal');
  });

  it('an SMSF property names the fund it sits in', () => {
    const { rows } = buildPropertyReport([inFund()], [], [smsf()]);
    expect(rows[0].fund).toEqual({ kind: 'smsf', id: 'f1', name: 'Cameron Super Fund' });
  });

  it('links to a plain super fund too, not just an SMSF', () => {
    const p = property({ held_by: 'smsf', super_fund_id: 's1' });
    expect(fundLink(p)).toEqual({ kind: 'super', id: 's1' });
    expect(linkedFund(p, [{ kind: 'super', id: 's1', name: 'AustralianSuper' }])?.name).toBe('AustralianSuper');
  });

  it('a fund that can no longer be resolved still reads as fund-held', () => {
    // Better to say "held in a fund" unnamed than to present it as personal —
    // its value is still being counted over there.
    const { rows } = buildPropertyReport([inFund()], [], []);
    expect(rows[0].fund).toEqual({ kind: 'smsf', id: 'f1', name: 'Fund' });
    expect(rows[0].countedInFundBalance).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Net worth — the two places double-counting could happen
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

  it('a mortgage excluded from net worth is subtracted by the PROPERTY instead', () => {
    // The loans total skips this balance, so if the property added its full value
    // net worth would say a mortgaged house is owned outright — overstated by the
    // whole $600k. The property nets it instead, and lands on the same equity.
    const { rows } = buildPropertyReport(
      [property({ loan_id: 'l1' })],
      [loan({ include_in_net_worth: false })],
    );
    expect(rows[0].equity).toBe(400_000);            // what you'd keep on a sale
    expect(rows[0].netWorthValue).toBe(400_000);     // ...and what net worth counts
    expect(rows[0].netWorthEffect).toBe(400_000);    // subtracted once, here
    expect(rows[0].debtCountsTowardNetWorth).toBe(false);
    expect(rows[0].mortgageNettedHere).toBe(true);
  });

  it('the mortgage is never netted twice — the two switches cannot both subtract it', () => {
    // The same house and the same debt, with the loan counted and then not. The
    // net effect is $400k either way: exactly one term does the subtracting.
    const counted = buildPropertyReport([property({ loan_id: 'l1' })], [loan()]).rows[0];
    const notCounted = buildPropertyReport(
      [property({ loan_id: 'l1' })],
      [loan({ include_in_net_worth: false })],
    ).rows[0];

    expect(counted.netWorthEffect).toBe(notCounted.netWorthEffect);
    expect(counted.netWorthEffect).toBe(400_000);
    // …but they get there differently, and the row says which.
    expect(counted.netWorthValue).toBe(1_000_000);      // loans subtracts the debt
    expect(notCounted.netWorthValue).toBe(400_000);     // the property does
    expect(counted.mortgageNettedHere).toBe(false);
    expect(notCounted.mortgageNettedHere).toBe(true);
  });

  it('an uncounted mortgage bigger than the house makes the contribution negative', () => {
    // Underwater, and net worth must say so rather than clamping at zero: the debt
    // is real and the loans total is not going to report it.
    const { rows } = buildPropertyReport(
      [property({ current_value: 500_000, loan_id: 'l1' })],
      [loan({ current_balance: 600_000, include_in_net_worth: false })],
    );
    expect(rows[0].netWorthValue).toBe(-100_000);
    expect(rows[0].netWorthEffect).toBe(-100_000);
  });

  it('an EXCLUDED property leaves its mortgage to the loans total', () => {
    // Switching an asset off is not a claim that the money owed against it stopped
    // being owed, so the property contributes nothing and the debt stays where it
    // was. Netting it here as well would subtract the same $600k twice.
    const { rows } = buildPropertyReport(
      [property({ loan_id: 'l1', include_in_net_worth: false })],
      [loan()],
    );
    expect(rows[0].netWorthValue).toBe(0);
    expect(rows[0].mortgageNettedHere).toBe(false);
    expect(rows[0].netWorthEffect).toBe(-600_000);   // the loans total's doing
  });

  it('a property whose loan_id points at nothing is treated as unencumbered', () => {
    // A deleted loan leaves no balance to trust. Inventing one — or subtracting a
    // stale figure — would be worse than reporting the house on its own.
    const { rows } = buildPropertyReport([property({ loan_id: 'gone' })], []);
    expect(rows[0].netWorthValue).toBe(1_000_000);
    expect(rows[0].debt).toBe(0);
    expect(rows[0].mortgageNettedHere).toBe(false);
  });

  it('ownership scales the value but never the uncounted mortgage', () => {
    // Half the house, all of the loan — the loan row holds what the user actually
    // owes, whatever slice of the property that money bought.
    const { rows } = buildPropertyReport(
      [property({ ownership_percent: 50, loan_id: 'l1' })],
      [loan({ include_in_net_worth: false })],
    );
    expect(rows[0].ownedValue).toBe(500_000);
    expect(rows[0].netWorthValue).toBe(-100_000);  // 500,000 − 600,000
  });

  it("an in-fund property still nets an uncounted mortgage: a fund balance is a VALUE, not equity", () => {
    // The SMSF's balance carries what the house is worth, so there is no asset to
    // add here — but nothing anywhere has subtracted the loan, so this must.
    const { rows } = buildPropertyReport(
      [inFund({ loan_id: 'l1' })],
      [loan({ include_in_net_worth: false })],
      [smsf()],
    );
    expect(rows[0].countedInFundBalance).toBe(true);
    expect(rows[0].netWorthValue).toBe(-600_000);
    expect(rows[0].mortgageNettedHere).toBe(true);
  });

  it('propertyNetWorthTotal nets uncounted mortgages too, and only those', () => {
    const properties = [
      property({ id: 'p1', current_value: 1_000_000, loan_id: 'counted' }),
      property({ id: 'p2', current_value: 1_000_000, loan_id: 'skipped' }),
    ];
    const loans = [
      loan({ id: 'counted', current_balance: 600_000 }),
      loan({ id: 'skipped', current_balance: 600_000, include_in_net_worth: false }),
    ];
    // p1 adds its full value (the loans total takes its debt); p2 adds its equity.
    expect(propertyNetWorthTotal(properties, loans)).toBe(1_400_000);
    // Called without loans — as it is anywhere the loan list isn't to hand — it
    // falls back to the old, mortgage-free reading rather than guessing.
    expect(propertyNetWorthTotal(properties)).toBe(2_000_000);
  });
});

describe('an SMSF property whose fund already counts it', () => {
  it('adds NOTHING of its own — the fund balance is carrying the value', () => {
    expect(countedInFund(inFund())).toBe(true);
    expect(netWorthValue(inFund())).toBe(0);
    expect(propertyNetWorthTotal([inFund()])).toBe(0);
  });

  it('still shows its full value and equity — it is not hidden, just counted elsewhere', () => {
    const { rows } = buildPropertyReport([inFund({ loan_id: 'l1' })], [loan()], [smsf()]);
    expect(rows[0].value).toBe(1_000_000);
    expect(rows[0].ownedValue).toBe(1_000_000);
    expect(rows[0].equity).toBe(400_000);
    expect(rows[0].lvr).toBe(60);
    expect(rows[0].netWorthValue).toBe(0);       // …but nothing is added here
  });

  it('is counted here instead when the fund balance excludes it', () => {
    const p = inFund({ counted_in_fund_balance: false });
    expect(countedInFund(p)).toBe(false);
    expect(netWorthValue(p)).toBe(1_000_000);
  });

  it('needs a fund to be counted inside one — SMSF-held but unlinked counts here', () => {
    const p = property({ held_by: 'smsf', smsf_fund_id: null });
    expect(countedInFund(p)).toBe(false);
    expect(netWorthValue(p)).toBe(1_000_000);
  });

  it('ignores the flag entirely on a personal property', () => {
    // The flag only means anything alongside a fund; a stale true on a personal
    // row must not silently delete the house from net worth.
    const p = property({ held_by: 'personal', counted_in_fund_balance: true });
    expect(countedInFund(p)).toBe(false);
    expect(netWorthValue(p)).toBe(1_000_000);
  });

  it('with a mortgage, net worth moves by the DEBT only — the asset came from the fund', () => {
    const { rows } = buildPropertyReport([inFund({ loan_id: 'l1' })], [loan()], [smsf()]);
    expect(rows[0].netWorthEffect).toBe(-600_000);
  });

  it('excluding the property is honoured on top of the fund rule', () => {
    expect(netWorthValue(inFund({ include_in_net_worth: false }))).toBe(0);
  });

  it('never depends on the FUND’s own net-worth toggle', () => {
    // The browser has no SMSF data; if the rule consulted the fund's toggle the
    // frontend and backend engines could disagree. Same answer either way.
    const on = buildPropertyReport([inFund()], [], [smsf({ includeInNetWorth: true })]);
    const off = buildPropertyReport([inFund()], [], [smsf({ includeInNetWorth: false })]);
    expect(on.rows[0].netWorthValue).toBe(0);
    expect(off.rows[0].netWorthValue).toBe(0);
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
      [property({ held_by: 'joint', ownership_percent: 50, purchase_price: 800_000, current_value: 1_000_000 })],
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
    expect(totals.netWorthValue).toBe(1_700_000);
    expect(totals.countedInFunds).toBe(0);
    expect(totals.debt).toBe(850_000);           // each loan once
    expect(totals.equity).toBe(850_000);
    expect(totals.netWorthEffect).toBe(850_000);
  });

  it('separates what the funds are counting from what net worth adds here', () => {
    const { totals } = buildPropertyReport(
      [
        property({ id: 'p1', current_value: 1_000_000 }),
        inFund({ id: 'p2', current_value: 700_000 }),
        inFund({ id: 'p3', current_value: 300_000, counted_in_fund_balance: false }),
      ],
      [],
      [smsf()],
    );
    expect(totals.ownedValue).toBe(2_000_000);     // everything the user owns
    expect(totals.countedInFunds).toBe(700_000);   // …of which the SMSF counts this
    expect(totals.netWorthValue).toBe(1_300_000);  // …so net worth adds the rest
    expect(totals.equity).toBe(2_000_000);         // equity is unaffected by where it's counted
  });

  it('an empty portfolio totals zero rather than NaN', () => {
    const { rows, totals } = buildPropertyReport([], []);
    expect(rows).toEqual([]);
    expect(totals).toEqual({
      value: 0, ownedValue: 0, countedInFunds: 0, netWorthValue: 0,
      excludedFromNetWorth: 0, debt: 0, equity: 0, netWorthEffect: 0, count: 0,
      // Gearing against nothing has no answer, so it is null rather than 0% —
      // an unencumbered portfolio and an empty one must not read the same.
      lvr: null, mortgaged: 0,
      // Performance totals are zero for the same reason, and the yields are
      // NULL rather than 0% — nothing was let, so there is no yield to quote.
      annualRent: 0, annualExpenses: 0, annualMortgage: 0,
      annualCashFlow: 0, monthlyCashFlow: 0,
      grossYield: null, netYield: null, rented: 0,
    });
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

describe('which funds a property may be held in', () => {
  const funds: FundEntity[] = [
    { kind: 'super', id: 's1', name: 'AustralianSuper' },
    { kind: 'smsf', id: 'f2', name: 'Zebra Super Fund' },
    { kind: 'smsf', id: 'f1', name: 'Cameron Super Fund' },
  ];

  it('offers SMSFs first, then super funds, each alphabetically', () => {
    expect(availableFundsForProperty(funds).map(f => f.id)).toEqual(['f1', 'f2', 's1']);
  });

  it('a fund is NOT exclusive — one SMSF can hold several properties', () => {
    // Unlike a mortgage, nothing is filtered out: the fund's balance covers them all.
    expect(availableFundsForProperty(funds)).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Validation
// ═════════════════════════════════════════════════════════════════════════════
describe('validating a draft', () => {
  const ctx = (o: { loans?: Loan[]; properties?: Property[]; propertyId?: string | null; funds?: FundEntity[] } = {}) => ({
    loans: o.loans ?? [loan()],
    properties: o.properties ?? [],
    propertyId: o.propertyId ?? null,
    funds: o.funds ?? [smsf()],
  });
  const draft = {
    name: 'Bondi apartment',
    address_street: '34 Beach Rd', address_suburb: 'Bondi',
    address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
    current_value: 1_000_000,
  };

  it('accepts a sound draft', () => {
    expect(validateProperty(draft, ctx())).toEqual([]);
  });

  it('needs the whole address — a property is a place', () => {
    expect(validateProperty({ current_value: 1 }, ctx())).toEqual([
      'Street address is required.',
      'Suburb / locality is required.',
      'State is required.',
      'Postcode is required.',
      'Country is required.',
    ]);
  });

  it('names the one part that is missing', () => {
    expect(validateProperty({ ...draft, address_postcode: '  ' }, ctx())).toEqual(['Postcode is required.']);
  });

  it('does NOT need a nickname — the address names it', () => {
    expect(validateProperty({ ...draft, name: null }, ctx())).toEqual([]);
  });

  it('treats unit/lot as optional', () => {
    expect(validateProperty({ ...draft, address_unit: null }, ctx())).toEqual([]);
  });

  it('needs a sane value', () => {
    expect(validateProperty({ ...draft, current_value: -5 }, ctx())).toEqual(['Current value must be zero or more.']);
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

  it('names the other property by its address when it has no nickname', () => {
    const taken = [property({ id: 'other', name: null, loan_id: 'l1' })];
    expect(validateProperty({ ...draft, loan_id: 'l1' }, ctx({ properties: taken })))
      .toEqual(['That loan is already linked to "34 Beach Rd, Bondi".']);
  });

  it('lets a property keep the loan it already holds', () => {
    const mine = [property({ id: 'p1', loan_id: 'l1' })];
    expect(validateProperty({ ...draft, loan_id: 'l1' }, ctx({ properties: mine, propertyId: 'p1' }))).toEqual([]);
  });

  it('accepts an SMSF-held property pointing at a real fund', () => {
    expect(validateProperty({ ...draft, held_by: 'smsf', smsf_fund_id: 'f1' }, ctx())).toEqual([]);
  });

  it('refuses SMSF-held with no fund — the counted-once rule needs something to point at', () => {
    expect(validateProperty({ ...draft, held_by: 'smsf' }, ctx()))
      .toEqual(['Choose the SMSF or super fund that holds this property.']);
  });

  it('refuses a fund on a personal or joint property', () => {
    expect(validateProperty({ ...draft, held_by: 'personal', smsf_fund_id: 'f1' }, ctx()))
      .toEqual(["A personal property can't be held in a fund."]);
    expect(validateProperty({ ...draft, held_by: 'joint', smsf_fund_id: 'f1' }, ctx()))
      .toEqual(["A joint property can't be held in a fund."]);
  });

  it('refuses two funds at once — which one would be counting the value?', () => {
    expect(validateProperty({ ...draft, held_by: 'smsf', smsf_fund_id: 'f1', super_fund_id: 's1' }, ctx()))
      .toEqual(['A property can be held in only one fund.']);
  });

  it('refuses a fund that is gone', () => {
    expect(validateProperty({ ...draft, held_by: 'smsf', smsf_fund_id: 'deleted' }, ctx()))
      .toEqual(['That fund no longer exists.']);
  });

  it('skips the fund-exists check when the list has not loaded, rather than blocking the save', () => {
    expect(validateProperty({ ...draft, held_by: 'smsf', smsf_fund_id: 'f1' }, ctx({ funds: [] }))).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 4.3 — performance: rent, expenses, yield and cash flow
// ═════════════════════════════════════════════════════════════════════════════
//
// The claim under test is that a property earns from the transactions the user
// already has and stores nothing of its own. So every figure below is proved by
// moving a TRANSACTION (or a value, or a loan) and watching the yield follow —
// never by setting a stored rent figure, because there isn't one.

const AS_OF = '2026-08-18';

const txn = (o: Partial<Transaction> = {}): Transaction => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  user_id: 'me', account_id: 'acct-everyday', account_type: 'bank',
  date: '2026-08-01', merchant: 'RAY WHITE RENTAL', amount: 2_500,
  currency: 'AUD', category: 'Rent',
  is_duplicate_flagged: false, is_subscription: false,
  ...o,
});

/** Twelve monthly rent payments, the 1st of each month, ending 2026-08-01. */
const rentYear = (amount = 2_500, o: Partial<Transaction> = {}): Transaction[] => {
  const out: Transaction[] = [];
  for (let i = 0; i < 12; i++) {
    const month = 9 + i;                       // Sep 2025 … Aug 2026
    const year = month <= 12 ? 2025 : 2026;
    const mm = String(month <= 12 ? month : month - 12).padStart(2, '0');
    out.push(txn({ id: `rent-${i}`, date: `${year}-${mm}-01`, amount, ...o }));
  }
  return out;
};

/** An investment property that knows which transactions are its own. */
const rental = (o: Partial<Property> = {}): Property => property({
  property_type: 'investment',
  purchase_price: 800_000, purchase_date: '2020-03-01', current_value: 1_000_000,
  match_terms: ['ray white'],
  ...o,
});

const report = (properties: Property[], loans: Loan[], transactions: Transaction[]) =>
  buildPropertyReport(properties, loans, [], { transactions, asOf: AS_OF });

const perf = (properties: Property[], loans: Loan[], transactions: Transaction[]) =>
  report(properties, loans, transactions).rows[0].performance;

describe('claiming transactions', () => {
  it('claims what the match text names, and leaves everything else alone', () => {
    const claimed = attributeTransactions(
      [rental()],
      [txn({ id: 'rent' }), txn({ id: 'groceries', merchant: 'WOOLWORTHS', amount: -180, category: 'Groceries' })],
    );
    expect(claimed.get('p1')!.map(t => t.id)).toEqual(['rent']);
  });

  it('matches the raw description and the notes, not just the display merchant', () => {
    const claimed = attributeTransactions([rental({ match_terms: ['waverley council'] })], [
      txn({ id: 'rates', merchant: 'BPAY', raw_description: 'WAVERLEY COUNCIL RATES', amount: -820, category: 'Bills' }),
      txn({ id: 'note', merchant: 'DIRECT DEBIT', notes: 'Waverley Council instalment', amount: -820, category: 'Bills' }),
    ]);
    expect(claimed.get('p1')!.map(t => t.id)).toEqual(['rates', 'note']);
  });

  it('takes everything on a dedicated account, whatever it says', () => {
    const p = rental({ match_terms: [], match_account_ids: ['acct-ip'] });
    const claimed = attributeTransactions([p], [
      txn({ id: 'in', account_id: 'acct-ip', merchant: 'SOME AGENT PTY LTD' }),
      txn({ id: 'out', account_id: 'acct-everyday', merchant: 'SOME AGENT PTY LTD' }),
    ]);
    expect(claimed.get('p1')!.map(t => t.id)).toEqual(['in']);
  });

  it('gives a contested transaction to the MORE SPECIFIC match, so no rent is counted twice', () => {
    const broad = rental({ id: 'p-broad', match_terms: ['white'] });
    const exact = rental({ id: 'p-exact', match_terms: ['ray white rental'] });
    const claimed = attributeTransactions([broad, exact], [txn({ id: 'rent' })]);

    expect(claimed.get('p-exact')!.map(t => t.id)).toEqual(['rent']);
    expect(claimed.get('p-broad')).toEqual([]);
  });

  it('and an account beats any amount of matching text', () => {
    const byText = rental({ id: 'p-text', match_terms: ['ray white rental payment'] });
    const byAccount = rental({ id: 'p-acct', match_terms: [], match_account_ids: ['acct-everyday'] });
    const claimed = attributeTransactions([byText, byAccount], [txn({ id: 'rent' })]);

    expect(claimed.get('p-acct')!.map(t => t.id)).toEqual(['rent']);
    expect(claimed.get('p-text')).toEqual([]);
  });

  it('claims nothing at all with no rules — a guessed rent payment is invented income', () => {
    const bare = rental({ match_terms: [], match_account_ids: [] });
    expect(attributeTransactions([bare], [txn()]).get('p1')).toEqual([]);
    expect(hasMatchRules(bare)).toBe(false);
    expect(perf([bare], [], [txn()]).matched).toBe(false);
  });

  it('refuses a term of one or two letters, which would sweep up the whole statement', () => {
    const sound = {
      address_street: '34 Beach Rd', address_suburb: 'Bondi', address_state: 'NSW',
      address_postcode: '2026', address_country: 'Australia', current_value: 1_000_000,
    };
    expect(validateProperty({ ...sound, match_terms: ['a'] }, { loans: [], properties: [] }))
      .toEqual(['Match text must be at least 3 characters — "a" is too broad.']);
    expect(validateProperty({ ...sound, match_terms: ['ray white'] }, { loans: [], properties: [] })).toEqual([]);
  });
});

describe('rental income', () => {
  it('is the rent that actually arrived, per year and per month', () => {
    const p = perf([rental()], [], rentYear());
    expect(p.rentReceived).toBe(30_000);
    expect(p.annualRent).toBe(30_000);
    expect(p.monthlyRent).toBe(2_500);
    expect(p.rentPayments).toBe(12);
    expect(p.isIncomeProducing).toBe(true);
  });

  it('reads the cycle off the payment dates', () => {
    expect(perf([rental()], [], rentYear()).rentFrequency).toBe('monthly');

    const weekly: Transaction[] = [];
    for (let i = 0; i < 20; i++) {
      const day = new Date(Date.parse('2026-08-01') - i * 7 * 86_400_000).toISOString().slice(0, 10);
      weekly.push(txn({ id: `w${i}`, date: day, amount: 700 }));
    }
    expect(perf([rental()], [], weekly).rentFrequency).toBe('weekly');
  });

  it('says nothing about a cycle from a single payment', () => {
    const p = perf([rental()], [], [txn({ date: '2026-08-01' })]);
    expect(p.rentFrequency).toBeNull();
    expect(p.currentAnnualRent).toBeNull();
    expect(p.rentReceived).toBe(2_500);
  });

  it('follows a rent RISE straight away, while the trailing year catches up slowly', () => {
    const raised = [...rentYear(2_500).slice(0, 6), ...rentYear(2_750).slice(6)];
    const p = perf([rental()], [], raised);

    expect(p.rentReceived).toBe(31_500);          // the year that actually happened
    expect(p.latestRent).toEqual({ date: '2026-08-01', amount: 2_750 });
    expect(p.currentAnnualRent).toBe(33_000);     // what the new rent is worth over a year
  });

  it('counts a day, not a transaction, when the agent pays in two lots', () => {
    const split = [txn({ id: 'a', date: '2026-08-01', amount: 1_500 }), txn({ id: 'b', date: '2026-08-01', amount: 1_000 })];
    const p = perf([rental()], [], [...rentYear().slice(0, 11), ...split]);
    expect(p.rentReceived).toBe(30_000);
    // One rent DAY, so the cycle still reads monthly — but two payments really
    // did arrive, and the list the user reviews has to show both.
    expect(p.rentDays).toBe(12);
    expect(p.rentPayments).toBe(13);
    expect(p.rentFrequency).toBe('monthly');
  });

  it('is never scaled by ownership — the money that arrived is already the user\'s share', () => {
    const half = perf([rental({ ownership_percent: 50 })], [], rentYear());
    expect(half.rentReceived).toBe(30_000);
  });
});

describe('property expenses', () => {
  const expenses = [
    txn({ id: 'e1', date: '2025-10-15', merchant: 'RAY WHITE MANAGEMENT FEE', amount: -1_200, category: 'Bills' }),
    txn({ id: 'e2', date: '2026-02-15', merchant: 'RAY WHITE REPAIRS', amount: -3_000, category: 'Bills' }),
    txn({ id: 'e3', date: '2026-03-15', merchant: 'RAY WHITE INSURANCE', amount: -1_800, category: 'Insurance' }),
  ];

  it('totals what left the account, grouped by the categories already on it', () => {
    const p = perf([rental()], [], [...rentYear(), ...expenses]);
    expect(p.expensesPaid).toBe(6_000);
    expect(p.annualExpenses).toBe(6_000);
    expect(p.monthlyExpenses).toBe(500);
    expect(p.expenseCount).toBe(3);
    expect(p.expensesByCategory).toEqual([
      { category: 'Bills', amount: 4_200, count: 2 },
      { category: 'Insurance', amount: 1_800, count: 1 },
    ]);
  });

  it('ignores a transfer into the property account — the same dollar arriving is not rent', () => {
    const p = perf([rental({ match_account_ids: ['acct-ip'], match_terms: [] })], [], [
      txn({ id: 'topup', account_id: 'acct-ip', merchant: 'TRANSFER FROM SAVINGS', amount: 5_000, category: 'Transfer' }),
      txn({ id: 'flagged', account_id: 'acct-ip', merchant: 'INTERNAL', amount: 4_000, is_transfer: true }),
      txn({ id: 'rent', account_id: 'acct-ip', date: '2026-08-01', amount: 2_500 }),
    ]);
    expect(p.rentReceived).toBe(2_500);
  });

  it('ignores a mortgage repayment recorded against the loan — the schedule already counts it', () => {
    const mortgage = loan({ minimum_repayment: 3_000, repayment_frequency: 'monthly' });
    const p = perf([rental({ loan_id: 'l1' })], [mortgage], [
      ...rentYear(),
      txn({ id: 'repay', account_type: 'loan', merchant: 'RAY WHITE MORTGAGE', amount: -3_000, category: 'Bills' }),
    ]);
    expect(p.expensesPaid).toBe(0);
    expect(p.annualMortgage).toBe(36_000);
    expect(p.annualCashFlow).toBe(-6_000);
  });

  it('uses the converted amount when the transaction was in another currency', () => {
    const p = perf([rental()], [], [
      ...rentYear(),
      txn({ id: 'fx', merchant: 'RAY WHITE STRATA', amount: -1_000, display_amount: -1_500, category: 'Bills' }),
    ]);
    expect(p.expensesPaid).toBe(1_500);
  });
});

describe('vacancy', () => {
  it('shows up as months with no rent, and drags the year down on its own', () => {
    const withGap = rentYear().filter(t => !['2026-01-01', '2026-02-01', '2026-03-01'].includes(t.date));
    const p = perf([rental()], [], withGap);

    expect(p.rentPayments).toBe(9);
    expect(p.vacantMonths).toBe(3);
    expect(p.occupancyPercent).toBe(75);
    expect(p.annualRent).toBe(22_500);
    expect(p.grossYield).toBe(2.25);              // 3% fully let, less a quarter of the year
  });

  it('a property let all year is not vacant for a day', () => {
    const p = perf([rental()], [], rentYear());
    expect(p.vacantMonths).toBe(0);
    expect(p.occupancyPercent).toBe(100);
  });

  it('an empty property is not "100% vacant" — it has no occupancy figure at all', () => {
    const p = perf([rental()], [], []);
    expect(p.occupancyPercent).toBeNull();
    expect(p.vacantMonths).toBe(12);
    expect(p.isIncomeProducing).toBe(false);
  });
});

describe('yield', () => {
  it('is gross on the rent and net after expenses, both before the mortgage', () => {
    const expenses = [txn({ id: 'e', date: '2026-02-15', merchant: 'RAY WHITE FEES', amount: -6_000, category: 'Bills' })];
    const p = perf([rental({ loan_id: 'l1' })], [loan({ minimum_repayment: 3_000 })], [...rentYear(), ...expenses]);

    expect(p.grossYield).toBe(3);                 // 30,000 / 1,000,000
    expect(p.netYield).toBe(2.4);                 // (30,000 − 6,000) / 1,000,000
  });

  it('is measured against the share the user OWNS, so a half share yields on half a house', () => {
    const p = perf([rental({ ownership_percent: 50 })], [], rentYear());
    expect(p.grossYield).toBe(6);                 // 30,000 / 500,000
  });

  it('falls when the property is revalued upward, without a transaction changing', () => {
    const txns = rentYear();
    expect(perf([rental({ current_value: 1_000_000 })], [], txns).grossYield).toBe(3);
    expect(perf([rental({ current_value: 1_500_000 })], [], txns).grossYield).toBe(2);
    expect(perf([rental({ current_value: 2_000_000 })], [], txns).grossYield).toBe(1.5);
  });

  it('is null, never 0%, for a home nobody rents', () => {
    const home = property({ match_terms: ['waverley council'] });
    const p = perf([home], [], [txn({ id: 'rates', merchant: 'WAVERLEY COUNCIL', amount: -820, category: 'Bills' })]);

    expect(p.isIncomeProducing).toBe(false);
    expect(p.grossYield).toBeNull();
    expect(p.netYield).toBeNull();
    expect(p.annualExpenses).toBe(820);
  });

  it('and null on a property with no value on file, rather than dividing by zero', () => {
    expect(perf([rental({ current_value: 0 })], [], rentYear()).grossYield).toBeNull();
  });

  it('can go negative when a property costs more to run than it earns', () => {
    const heavy = [txn({ id: 'e', date: '2026-02-15', merchant: 'RAY WHITE REBUILD', amount: -40_000, category: 'Bills' })];
    expect(perf([rental()], [], [...rentYear(), ...heavy]).netYield).toBe(-1);
  });
});

describe('cash flow', () => {
  it('is rent, less expenses, less the mortgage schedule — annually and monthly', () => {
    const expenses = [txn({ id: 'e', date: '2026-02-15', merchant: 'RAY WHITE FEES', amount: -6_000, category: 'Bills' })];
    const p = perf([rental({ loan_id: 'l1' })], [loan({ minimum_repayment: 3_000, repayment_frequency: 'monthly' })],
      [...rentYear(), ...expenses]);

    expect(p.annualMortgage).toBe(36_000);
    expect(p.annualCashFlow).toBe(-12_000);       // 30,000 − 6,000 − 36,000
    expect(p.monthlyCashFlow).toBe(-1_000);
  });

  it('counts extra repayments — they leave the account too', () => {
    const p = perf([rental({ loan_id: 'l1' })], [loan({ minimum_repayment: 3_000, extra_repayment: 500 })], rentYear());
    expect(p.annualMortgage).toBe(42_000);
    expect(p.annualCashFlow).toBe(-12_000);
  });

  it('reads the mortgage at ITS OWN frequency, not a guessed monthly one', () => {
    const fortnightly = loan({ minimum_repayment: 1_500, repayment_frequency: 'fortnightly' });
    expect(annualMortgageCost(fortnightly)).toBe(39_000);
    expect(annualMortgageCost(loan({ minimum_repayment: 750, repayment_frequency: 'weekly' }))).toBe(39_000);
    expect(annualMortgageCost(null)).toBe(0);
  });

  it('deducts nothing when no mortgage is linked', () => {
    const p = perf([rental()], [], rentYear());
    expect(p.annualMortgage).toBe(0);
    expect(p.annualCashFlow).toBe(30_000);
    expect(p.monthlyCashFlow).toBe(2_500);
  });

  it('is the cost of holding an owner-occupied home, with no rent to offset it', () => {
    const home = property({ loan_id: 'l1', match_terms: ['waverley council'] });
    const p = perf([home], [loan({ minimum_repayment: 4_000 })],
      [txn({ id: 'rates', merchant: 'WAVERLEY COUNCIL', amount: -1_200, category: 'Bills' })]);

    expect(p.annualCashFlow).toBe(-49_200);
    expect(p.monthlyCashFlow).toBe(-4_100);
  });
});

describe('the window', () => {
  it('is the trailing twelve months', () => {
    expect(performanceWindow({ purchase_date: '2020-03-01' }, AS_OF))
      .toEqual({ start: '2025-08-18', end: AS_OF, months: 12, partial: false });
  });

  it('never reaches back before the property was bought, and says so', () => {
    expect(performanceWindow({ purchase_date: '2026-04-18' }, AS_OF))
      .toEqual({ start: '2026-04-18', end: AS_OF, months: 4, partial: true });
  });

  it('scales a part-year up to an annual figure', () => {
    const recent = rental({ purchase_date: '2026-05-01' });
    const p = perf([recent], [], rentYear());

    expect(p.window.months).toBe(3);
    expect(p.window.partial).toBe(true);
    // Three months, three rent payments — Jun, Jul, Aug. Settlement day itself is
    // outside the window, or three months would be credited with four rents and
    // the annual figure would come out a third too high.
    expect(p.rentReceived).toBe(7_500);
    expect(p.annualRent).toBe(30_000);            // …at that rate
    expect(p.grossYield).toBe(3);
  });

  it('leaves out what happened before the window — last year is last year', () => {
    const old = txn({ id: 'old', date: '2024-06-01', amount: 9_999 });
    expect(perf([rental()], [], [...rentYear(), old]).rentReceived).toBe(30_000);
  });

  it('and anything dated after today', () => {
    const future = txn({ id: 'future', date: '2027-01-01', amount: 9_999 });
    expect(perf([rental()], [], [...rentYear(), future]).rentReceived).toBe(30_000);
  });
});

describe('the portfolio totals', () => {
  const investment = rental({ id: 'p-inv', match_terms: ['ray white'], current_value: 1_000_000, loan_id: 'l1' });
  const home = property({ id: 'p-home', current_value: 2_000_000, match_terms: ['waverley council'] });
  const rates = txn({ id: 'rates', merchant: 'WAVERLEY COUNCIL', amount: -1_200, category: 'Bills' });

  it('add up the rent, the costs and the cash flow across the RENTAL portfolio', () => {
    // (Restated for the audit's M6: the totals strip is rental performance, so
    // the owner-occupied home's council rates stay on the home's own card and
    // out of the portfolio's expenses and cash flow.)
    const { rows, totals } = report([investment, home], [loan({ minimum_repayment: 3_000 })], [...rentYear(), rates]);

    expect(totals.annualRent).toBe(30_000);
    expect(totals.annualExpenses).toBe(0);        // the home's rates are the home's
    expect(totals.annualMortgage).toBe(36_000);
    expect(totals.annualCashFlow).toBe(-6_000);
    expect(totals.monthlyCashFlow).toBe(-500);
    expect(totals.rented).toBe(1);
    // The home's own card still tells the truth about what the home costs.
    expect(rows.find(r => r.id === 'p-home')!.performance.annualExpenses).toBe(1_200);
  });

  it('yield only counts the properties that EARN, so a home does not halve it', () => {
    const { totals } = report([investment, home], [], [...rentYear(), rates]);
    expect(totals.grossYield).toBe(3);            // 30,000 / 1,000,000 — not / 3,000,000
    // The home's rates no longer leak into the net yield either (M6):
    // 30,000 − 0 of RENTAL expenses over the earning 1,000,000.
    expect(totals.netYield).toBe(3);
  });

  it('leave equity and net worth exactly where they were — rent is not an asset', () => {
    const withMoney = report([investment, home], [loan({ minimum_repayment: 3_000 })], [...rentYear(), rates]);
    const without = report([investment, home], [loan({ minimum_repayment: 3_000 })], []);

    expect(withMoney.totals.netWorthValue).toBe(without.totals.netWorthValue);
    expect(withMoney.totals.equity).toBe(without.totals.equity);
    expect(withMoney.totals.netWorthEffect).toBe(without.totals.netWorthEffect);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 4.5 — the portfolio read as one thing
// ═════════════════════════════════════════════════════════════════════════════
//
// The overview adds no figures of its own: every total below is the sum of the
// per-property rows the cards already show, which is what lets the comparison
// table foot to the summary strip above it. So these tests assert the two
// against each other rather than against a hand-typed number wherever they can —
// a total that agrees with its own rows cannot drift from them.
describe('the portfolio overview', () => {
  const cents = (n: number) => Number(n.toFixed(2));

  /** A mixed portfolio: a home, a geared rental, a half-owned rental, an SMSF flat. */
  const mixed = () => [
    property({ id: 'p-home', current_value: 1_200_000, loan_id: 'l-home' }),
    rental({ id: 'p-let', current_value: 800_000, loan_id: 'l-let', match_terms: ['ray white'] }),
    rental({ id: 'p-half', current_value: 600_000, ownership_percent: 50, match_terms: ['harcourts'] }),
    inFund({ id: 'p-smsf', property_type: 'investment', current_value: 500_000, match_terms: ['jellis'] }),
  ];
  const mixedLoans = () => [
    loan({ id: 'l-home', name: 'Home mortgage', current_balance: 700_000, minimum_repayment: 4_000 }),
    loan({ id: 'l-let', name: 'Investment mortgage', current_balance: 500_000, minimum_repayment: 3_000 }),
  ];
  const mixedReport = (transactions: Transaction[] = []) =>
    buildPropertyReport(mixed(), mixedLoans(), [smsf()], { transactions, asOf: AS_OF });

  it('totals the value the user actually owns, not the market value', () => {
    const { totals } = mixedReport();
    expect(totals.value).toBe(3_100_000);        // every house in full
    expect(totals.ownedValue).toBe(2_800_000);   // …less the half of the joint one
  });

  it('gears the whole portfolio, unencumbered houses included', () => {
    const { totals } = mixedReport();
    expect(totals.debt).toBe(1_200_000);
    expect(totals.mortgaged).toBe(2);
    // 1,200,000 / 2,800,000 — the sum of the parts. Averaging the two mortgaged
    // rows (58.33% and 62.5%) would say 60.4% and ignore the 1.1m standing
    // behind the same debt.
    expect(totals.lvr).toBe(42.86);
    expect(totals.equity).toBe(1_600_000);
  });

  it('has no LVR to quote when nothing is owned', () => {
    const { totals } = buildPropertyReport([property({ current_value: 0 })], []);
    expect(totals.lvr).toBeNull();
  });

  it('reads 0% for a portfolio owned outright — which is not the same as no answer', () => {
    const { totals } = buildPropertyReport([property()], []);
    expect(totals.lvr).toBe(0);
    expect(totals.mortgaged).toBe(0);
  });

  it('every total is the sum of the rows the cards show', () => {
    const { rows, totals } = mixedReport([...rentYear(), txn({ id: 'rates', merchant: 'WAVERLEY COUNCIL', amount: -1_200 })]);
    const sum = (pick: (r: typeof rows[number]) => number) => Number(rows.reduce((s, r) => s + pick(r), 0).toFixed(2));
    // The rental strip foots to the rows it is made of — the ones that are not
    // the owner-occupied home (M6). Value/debt/equity still foot to every row.
    const rentals = rows.filter(r => r.type !== 'home');
    const rentalSum = (pick: (r: typeof rows[number]) => number) => Number(rentals.reduce((s, r) => s + pick(r), 0).toFixed(2));

    expect(sum(r => r.ownedValue)).toBe(totals.ownedValue);
    expect(sum(r => r.debt)).toBe(totals.debt);
    expect(sum(r => r.equity)).toBe(totals.equity);
    expect(rentalSum(r => r.performance.annualRent)).toBe(totals.annualRent);
    expect(rentalSum(r => r.performance.annualExpenses)).toBe(totals.annualExpenses);
    expect(rentalSum(r => r.performance.annualMortgage)).toBe(totals.annualMortgage);
    expect(rentalSum(r => r.performance.annualCashFlow)).toBe(totals.annualCashFlow);
  });

  it('cash flow is rent less expenses and mortgage, across the rentals — the home\'s mortgage stays home', () => {
    // (Restated for M6: the home's 4,000/mo repayment used to fold in here and
    // report the portfolio 48,000/yr poorer than its rentals are.)
    const { totals } = mixedReport([...rentYear()]);
    expect(totals.annualRent).toBe(30_000);
    expect(totals.annualMortgage).toBe(36_000);      // the LET property's 3,000 × 12 only
    expect(totals.annualCashFlow).toBe(cents(totals.annualRent - totals.annualExpenses - totals.annualMortgage));
    expect(totals.monthlyCashFlow).toBe(cents(totals.annualCashFlow / 12));
  });

  it('a home and a rental are mixed without the home dragging the yield down', () => {
    // The rent is claimed by the LET property, so the yield is measured against
    // its 800,000 — the home and the SMSF flat earn nothing and are not in the
    // denominator either.
    const { totals } = mixedReport([...rentYear()]);
    expect(totals.rented).toBe(1);
    expect(totals.grossYield).toBe(3.75);            // 30,000 / 800,000
  });

  it('an SMSF property is in the portfolio but not added to net worth twice', () => {
    const { rows, totals } = mixedReport();
    const fundRow = rows.find(r => r.id === 'p-smsf')!;

    expect(fundRow.countedInFundBalance).toBe(true);
    expect(fundRow.ownedValue).toBe(500_000);        // still the user's property…
    expect(fundRow.netWorthValue).toBe(0);           // …but the fund carries the value
    expect(totals.countedInFunds).toBe(500_000);
    expect(totals.ownedValue).toBe(2_800_000);       // the portfolio counts it
    expect(totals.netWorthValue).toBe(2_300_000);    // net worth does not
    expect(totals.excludedFromNetWorth).toBe(0);     // nothing was switched OFF
  });

  it('keeps a value the user switched off apart from a value a fund is carrying', () => {
    const { totals } = buildPropertyReport(
      [
        property({ id: 'p1', current_value: 1_000_000 }),
        property({ id: 'p2', current_value: 400_000, include_in_net_worth: false }),
        inFund({ id: 'p3', current_value: 600_000 }),
      ],
      [],
      [smsf()],
    );
    expect(totals.ownedValue).toBe(2_000_000);
    expect(totals.excludedFromNetWorth).toBe(400_000);   // counted nowhere, by choice
    expect(totals.countedInFunds).toBe(600_000);         // counted once, in the fund
    expect(totals.netWorthValue).toBe(1_000_000);
    // The three account for the whole portfolio: nothing is lost between them.
    expect(totals.netWorthValue + totals.excludedFromNetWorth + totals.countedInFunds).toBe(totals.ownedValue);
  });

  it('an excluded property is still part of the portfolio it belongs to', () => {
    const { totals } = buildPropertyReport(
      [property({ id: 'p1', current_value: 1_000_000, include_in_net_worth: false, loan_id: 'l1' })],
      [loan({ current_balance: 400_000 })],
    );
    expect(totals.equity).toBe(600_000);
    expect(totals.lvr).toBe(40);
    expect(totals.netWorthValue).toBe(0);
  });

  it('a half-owned rental is compared on the same footing as a whole one', () => {
    const { rows } = mixedReport();
    const half = rows.find(r => r.id === 'p-half')!;
    expect(half.ownershipPercent).toBe(50);
    expect(half.ownedValue).toBe(300_000);
    expect(half.equity).toBe(300_000);
    expect(half.lvr).toBeNull();                     // no mortgage of its own
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rent: which credits are the rent, and which are not
// ═════════════════════════════════════════════════════════════════════════════
//
// The refinement's claim is that rent is recognised by WHO pays it — the payer
// the user pointed at — and that the expected amount only corroborates a credit
// nothing else vouches for. So these tests move the amount, move the date and
// change the payer, and watch what gets counted.

/** A let property whose rent rules the user has actually filled in. */
const letRental = (o: Partial<Property> = {}): Property => rental({
  match_terms: [],
  rent_match_terms: ['ray white'],
  rent_account_id: 'acct-everyday',
  expected_rent_amount: 2_500,
  expected_rent_frequency: 'monthly',
  ...o,
});

describe('matching the rent', () => {
  it('counts every payment from the payer the user pointed at', () => {
    const p = perf([letRental()], [], rentYear());
    expect(p.rentMode).toBe('rules');
    expect(p.rentPayments).toBe(12);
    expect(p.rentReceived).toBe(30_000);
    expect(p.annualRent).toBe(30_000);
  });

  it('goes on matching payments that arrive later, with no new setup', () => {
    const setUp = letRental();
    const nextMonth = txn({ id: 'new', date: '2026-08-15', amount: 2_500 });
    expect(perf([setUp], [], [...rentYear(), nextMonth]).rentPayments).toBe(13);
  });

  it('finds the payer in the raw description or the notes, not just the merchant', () => {
    const p = perf([letRental()], [], [
      txn({ id: 'a', merchant: 'DIRECT CREDIT', raw_description: 'RAY WHITE BONDI RENT', date: '2026-07-01' }),
      txn({ id: 'b', merchant: 'DIRECT CREDIT', notes: 'Ray White — July rent', date: '2026-08-01' }),
    ]);
    expect(p.rentPayments).toBe(2);
  });

  it('takes a credit in the rent account on the amount alone, when it fits', () => {
    const noPayer = letRental({ rent_match_terms: [] });
    const p = perf([noPayer], [], [txn({ id: 'x', merchant: 'UNKNOWN AGENT', account_id: 'acct-everyday', amount: 2_500 })]);
    expect(p.rentReceived).toBe(2_500);
  });

  it('but claims NOTHING from a shared account with no payer and no expected amount', () => {
    // Nothing vouches for the credit — and a pay cheque reported as rental
    // income is worse than a property that says it has no rent yet.
    const vague = letRental({ rent_match_terms: [], expected_rent_amount: null, expected_rent_frequency: null });
    expect(hasRentRules(vague)).toBe(true);
    expect(perf([vague], [], [txn({ id: 'pay', merchant: 'ACME PAYROLL', amount: 6_000 })]).rentReceived).toBe(0);
  });

  it('never reads a DEBIT as rent, whoever it came from', () => {
    const p = perf([letRental({ match_terms: ['ray white'] })], [], [
      txn({ id: 'fee', merchant: 'RAY WHITE MANAGEMENT FEE', amount: -250, category: 'Bills' }),
    ]);
    expect(p.rentReceived).toBe(0);
    expect(p.expensesPaid).toBe(250);
  });

  it('keeps two properties\' agents apart', () => {
    const bondi = letRental({ id: 'p-bondi', rent_match_terms: ['ray white'] });
    const manly = letRental({ id: 'p-manly', rent_match_terms: ['belle property'] });
    const claimed = attributeTransactions([bondi, manly], [
      txn({ id: 'r1', merchant: 'RAY WHITE RENTAL' }),
      txn({ id: 'r2', merchant: 'BELLE PROPERTY MANLY' }),
    ]);
    expect(claimed.get('p-bondi')!.map(t => t.id)).toEqual(['r1']);
    expect(claimed.get('p-manly')!.map(t => t.id)).toEqual(['r2']);
  });

  it('even when both are paid into the same account for the same rent', () => {
    // Belle Property's payment fits Ray White's expected rent exactly, so
    // without a named payer outranking a lucky amount, whichever property was
    // listed first would have taken both lots of rent.
    const bondi = letRental({ id: 'p-bondi', rent_match_terms: ['ray white'] });
    const manly = letRental({ id: 'p-manly', rent_match_terms: ['belle property'] });
    const claimed = attributeTransactions([bondi, manly], [
      txn({ id: 'r2', merchant: 'BELLE PROPERTY MANLY', account_id: 'acct-everyday', amount: 2_500 }),
    ]);
    expect(claimed.get('p-bondi')).toEqual([]);
    expect(claimed.get('p-manly')!.map(t => t.id)).toEqual(['r2']);
  });

  it('does not claim the rest of the everyday account the rent lands in', () => {
    // The receiving account is usually the account everything else runs through,
    // so only the rent itself may be claimed from it.
    const claimed = attributeTransactions([letRental()], [
      txn({ id: 'rent' }),
      txn({ id: 'shop', merchant: 'WOOLWORTHS', amount: -180, category: 'Groceries' }),
      txn({ id: 'coffee', merchant: 'CAFE', amount: -6, category: 'Eating Out' }),
    ]);
    expect(claimed.get('p1')!.map(t => t.id)).toEqual(['rent']);
  });

  it('falls back to counting every credit when no rent rules were ever set', () => {
    // What a dedicated investment account has always meant, and what properties
    // configured before rent rules existed keep doing.
    const legacy = rental({ match_account_ids: ['acct-ip'], match_terms: [] });
    const p = perf([legacy], [], [txn({ id: 'r', account_id: 'acct-ip', merchant: 'WHOEVER', amount: 2_500 })]);
    expect(p.rentMode).toBe('anyCredit');
    expect(p.rentReceived).toBe(2_500);
  });
});

describe('what a property costs to run', () => {
  const strata = { id: 'r-strata', name: 'Strata', kind: 'strata' as const, match_terms: ['strata plus'], expected_amount: 1_100, frequency: 'quarterly' as const };
  const levy = (id: string, date: string, amount = -1_100) =>
    txn({ id, date, merchant: 'STRATA PLUS', amount, category: 'Bills' });

  it('is what the user set up, not the bills that happen to have landed', () => {
    // One levy banked so far. The strata is still $4,400 a year — the other
    // three notices are coming whether or not Ledger has seen them yet.
    const p = perf([letRental({ property_expenses: [strata] })], [], [...rentYear(), levy('q1', '2026-06-15')]);
    expect(p.annualExpenses).toBe(4_400);
    expect(p.bankedAnnualExpenses).toBe(1_100);
    expect(p.annualExpensesBasis).toBe('agreed');
  });

  it('and does not double-count the bills that HAVE landed', () => {
    const all = ['2025-09-15', '2025-12-15', '2026-03-15', '2026-06-15'].map((d, i) => levy(`q${i}`, d));
    const p = perf([letRental({ property_expenses: [strata] })], [], [...rentYear(), ...all]);
    expect(p.bankedAnnualExpenses).toBe(4_400);
    expect(p.annualExpenses).toBe(4_400);                    // not 8,800
  });

  it('adds what was actually paid for anything the setup does not cover', () => {
    // A plumber nobody budgets for, caught by a rule with no expected amount.
    const oneOff = { id: 'r-fix', name: 'Repairs', kind: 'maintenance' as const, match_terms: ['plumber'] };
    const p = perf([letRental({ property_expenses: [strata, oneOff] })], [],
      [...rentYear(), levy('q1', '2026-06-15'), txn({ id: 'fix', date: '2026-05-02', merchant: 'ACE PLUMBER', amount: -800, category: 'Bills' })]);
    expect(p.annualExpenses).toBe(5_200);                    // 4,400 agreed + 800 paid
  });

  it('and falls back entirely to what was paid when nothing has a figure on it', () => {
    const noFigure = { id: 'r-strata', name: 'Strata', kind: 'strata' as const, match_terms: ['strata plus'] };
    const p = perf([letRental({ property_expenses: [noFigure] })], [], [...rentYear(), levy('q1', '2026-06-15')]);
    expect(p.annualExpensesBasis).toBe('banked');
    expect(p.annualExpenses).toBe(1_100);
  });

  it('so the cash flow is what the property really does to the bank balance', () => {
    // 30,000 agreed rent − 4,400 of strata, whatever has been billed so far.
    const p = perf([letRental({ property_expenses: [strata] })], [], [...rentYear(), levy('q1', '2026-06-15')]);
    expect(p.annualCashFlow).toBe(25_600);
  });

  it('and a named biller stops the account claiming a cost that is not theirs', () => {
    const fromAccount = { ...strata, account_id: 'acct-everyday' };
    const p = perf([letRental({ property_expenses: [fromAccount] })], [],
      [txn({ id: 'other', date: '2026-05-02', merchant: 'QANTAS', amount: -1_100, category: 'Travel' })]);
    // Right account, right amount, wrong biller — and the user named the biller.
    expect(p.expenseCount).toBe(0);
  });
});

describe('a salary is never rent', () => {
  // The bug this fixes, exactly as it appeared: one real rent payment picked in
  // the form, then ten "payments counted" — nine of them the user's pay, which
  // happened to land in the same account at roughly the same size.
  const wages = (amounts: number[]) => amounts.map((amount, i) => txn({
    id: `pay-${i}`, merchant: 'Salary Oliver Hume Real WAGES', category: 'Salary',
    account_id: 'acct-everyday', amount, date: `2026-0${i + 1}-14`,
  }));

  const broadbeach = letRental({
    rent_match_terms: ['rent property broadbeach'],
    expected_rent_amount: 1_200,
    expected_rent_frequency: 'weekly',
  });
  const theRent = txn({ id: 'rent', merchant: 'Rent - Property Broadbeach', amount: 1_200, date: '2026-08-18' });

  it('does not count pay that merely lands in the same account', () => {
    const p = perf([broadbeach], [], [theRent, ...wages([1_600, 1_600, 802, 976, 1_500])]);
    expect(p.rentPayments).toBe(1);
    expect(p.payments.map(l => l.id)).toEqual(['rent']);
  });

  it('finds the payer through the punctuation the statement writes it with', () => {
    // "rent property broadbeach" is not a SUBSTRING of "Rent - Property
    // Broadbeach". Matching word by word is what makes the rule catch the very
    // payment it was built from — and what stopped it falling through to the
    // account, which is what swept the pay in.
    expect(rentMatch(theRent, rentRules(broadbeach))).toEqual({ reason: 'payer', term: 'rent property broadbeach' });
  });

  it('and goes on catching the rent when the agent tacks a reference on', () => {
    const later = txn({ id: 'next', merchant: 'RENT PROPERTY BROADBEACH 4471 NSW', amount: 1_140, date: '2026-08-25' });
    expect(rentMatch(later, rentRules(broadbeach))?.reason).toBe('payer');
  });

  it('never matches a term inside a longer word', () => {
    const p = letRental({ rent_match_terms: ['rent'] });
    expect(rentMatch(txn({ merchant: 'CURRENT ACCOUNT INTEREST', amount: 40 }), rentRules(p))).toBeNull();
  });

  it('and where no payer is named, leaves money already filed as something else alone', () => {
    const noPayer = letRental({ rent_match_terms: [], expected_rent_amount: 1_600, expected_rent_frequency: 'fortnightly' });
    // Same account, right size — the only thing that says it isn't rent is that
    // the user already said what it is.
    expect(perf([noPayer], [], wages([1_600, 1_600])).rentPayments).toBe(0);
    expect(perf([noPayer], [], wages([1_600]).map(t => ({ ...t, category: '' }))).rentPayments).toBe(1);
  });
});

describe('the rent a year', () => {
  const weekly = letRental({ expected_rent_amount: 1_200, expected_rent_frequency: 'weekly' });

  it('is what was agreed, worked out from the amount and the cycle', () => {
    const p = perf([weekly], [], [txn({ id: 'r', merchant: 'RAY WHITE', amount: 1_200, date: '2026-08-18' })]);
    expect(p.annualRent).toBe(62_400);                      // 1,200 × 52
    expect(p.annualRentBasis).toBe('agreed');
    expect(p.monthlyRent).toBe(5_200);
  });

  it('so one month of payments does not read as a nearly empty year', () => {
    // The whole point: a property set up last week has banked one payment, and
    // the lease still says what the year is worth.
    const p = perf([weekly], [], [txn({ id: 'r', merchant: 'RAY WHITE', amount: 1_200, date: '2026-08-18' })]);
    expect(p.bankedAnnualRent).toBe(1_200);
    expect(p.annualRent).toBe(62_400);
  });

  it('and the yield and cash flow are on that figure, not on the sample', () => {
    const p = perf([{ ...weekly, current_value: 1_040_000 }], [],
      [txn({ id: 'r', merchant: 'RAY WHITE', amount: 1_200, date: '2026-08-18' })]);
    expect(p.grossYield).toBe(6);                            // 62,400 ÷ 1,040,000
  });

  it('falls back to what actually banked when no rent has been agreed', () => {
    const noFigure = letRental({ expected_rent_amount: null, expected_rent_frequency: null });
    const p = perf([noFigure], [], rentYear());
    expect(p.annualRentBasis).toBe('banked');
    expect(p.annualRent).toBe(30_000);
  });

  it('and still reports what is actually arriving against it', () => {
    // Agreed 2,500 a month; the agent passes on 2,250 after their fee.
    const p = perf([letRental()], [], rentYear(2_250));
    expect(p.annualRent).toBe(30_000);
    expect(p.bankedAnnualRent).toBe(27_000);
    expect(p.rentVsExpectedPercent).toBe(90);
  });
});

describe('rent that varies', () => {
  it('counts a payment short of the expected amount — the agent took their fee', () => {
    const netOfFees = rentYear(2_250);                       // 10% management fee
    const p = perf([letRental()], [], netOfFees);
    expect(p.rentReceived).toBe(27_000);
    expect(p.rentPayments).toBe(12);
  });

  it('counts a rent RISE without the expected amount being updated', () => {
    const raised = [...rentYear(2_500).slice(0, 6), ...rentYear(2_900).slice(6)];
    const p = perf([letRental()], [], raised);
    expect(p.rentPayments).toBe(12);
    expect(p.currentAnnualRent).toBe(34_800);
  });

  it('and counts one even when only the account vouches for it, within reason', () => {
    const noPayer = letRental({ rent_match_terms: [] });
    const credits = (amounts: number[]) => amounts.map((amount, i) =>
      txn({ id: `v${amount}`, merchant: 'UNKNOWN', account_id: 'acct-everyday', amount, date: `2026-0${i + 3}-01` }));

    // Within a tenth of the agreed rent, and nothing else in the account is.
    // The band is deliberately narrow: with no payer named, the amount is the
    // ONLY thing saying this is rent, and half to one-and-a-half times the rent
    // is a range that swallows a pay cheque whole.
    expect(perf([noPayer], [], credits([2_500])).rentPayments).toBe(1);
    expect(perf([noPayer], [], credits([2_300, 2_700])).rentPayments).toBe(2);
    // Outside it, nothing vouches for it, so it is not taken as rent.
    expect(perf([noPayer], [], credits([1_300, 3_700, 900, 4_500])).rentPayments).toBe(0);
  });

  it('does not care what day rent lands on', () => {
    const jittered = rentYear().map((t, i) => ({ ...t, date: t.date.replace(/-01$/, `-0${(i % 5) + 1}`) }));
    const p = perf([letRental()], [], jittered);
    expect(p.rentPayments).toBe(12);
    expect(p.rentFrequency).toBe('monthly');
    expect(p.vacantMonths).toBe(0);
  });

  it('a missed month is a gap in the rent, not a broken rule', () => {
    const missed = rentYear().filter(t => t.date !== '2026-03-01');
    const p = perf([letRental()], [], missed);
    expect(p.rentPayments).toBe(11);
    expect(p.rentReceived).toBe(27_500);
    expect(p.vacantMonths).toBe(1);
  });
});

describe('credits that are NOT the rent', () => {
  it('leaves a salary in the same account alone', () => {
    const p = perf([letRental()], [], [
      ...rentYear(),
      txn({ id: 'pay', date: '2026-07-15', merchant: 'ACME PAYROLL', amount: 6_000, category: 'Income' }),
    ]);
    expect(p.rentReceived).toBe(30_000);
    expect(p.rentPayments).toBe(12);
  });

  it('refuses a lump sum from the agent — a bond or a settlement is not rent', () => {
    const withRules = letRental({ match_terms: ['ray white'] });
    const p = perf([withRules], [], [
      ...rentYear(),
      txn({ id: 'bond', date: '2026-06-20', merchant: 'RAY WHITE BOND RELEASE', amount: 12_000 }),
    ]);
    expect(p.rentReceived).toBe(30_000);
    // Claimed by the expense rules, so it is reported as money that came back —
    // never as income, which would have added 40% to the yield.
    expect(p.refunds).toBe(12_000);
    expect(p.expensesPaid).toBe(-12_000);
    expect(p.grossYield).toBe(3);
  });

  it('ignores loose change — an interest credit is not a rent payment', () => {
    const noPayer = letRental({ rent_match_terms: [] });
    expect(perf([noPayer], [], [txn({ id: 'int', merchant: 'INTEREST PAID', amount: 40 })]).rentReceived).toBe(0);
  });

  it('ignores a transfer from the user\'s own savings, however it is dressed up', () => {
    const p = perf([letRental({ rent_match_terms: ['ray white', 'transfer'] })], [], [
      txn({ id: 't1', merchant: 'TRANSFER FROM SAVINGS', amount: 2_500, category: 'Transfer' }),
      txn({ id: 't2', merchant: 'TRANSFER IN', amount: 2_500, is_transfer: true }),
    ]);
    expect(p.rentReceived).toBe(0);
  });

  it('is decided by the rules alone — isRentCredit is the whole test', () => {
    const rules = rentRules(letRental());
    expect(isRentCredit(txn({ amount: 2_500 }), rules)).toBe(true);
    expect(isRentCredit(txn({ amount: -2_500 }), rules)).toBe(false);
    expect(isRentCredit(txn({ merchant: 'ACME PAYROLL', amount: 6_000 }), rules)).toBe(false);
    expect(isRentCredit(txn({ merchant: 'RAY WHITE', amount: 11_000 }), rules)).toBe(false);
    expect(isRentCredit(txn({ merchant: 'RAY WHITE', amount: 9_000 }), rules)).toBe(true);
  });
});

describe('an owner-occupied home', () => {
  const home = (o: Partial<Property> = {}): Property => property({
    property_type: 'home', match_terms: ['waverley council'], ...o,
  });

  it('has no rent, and no way to set one up', () => {
    expect(isOwnerOccupied(home())).toBe(true);
    expect(canEarnRent(home())).toBe(false);
    expect(hasRentRules(home({ rent_match_terms: ['ray white'] }))).toBe(false);
    expect(expectedAnnualRent(home({ expected_rent_amount: 2_500, expected_rent_frequency: 'monthly' }))).toBeNull();
  });

  it('never reports a credit as rental income, whatever the rules say', () => {
    // A home with rent rules left over from when it was let, and a big credit
    // that would once have been reported as income.
    const wasLet = home({ rent_match_terms: ['ray white'], match_terms: ['ray white'] });
    const p = perf([wasLet], [], [...rentYear()]);

    expect(p.rentMode).toBe('off');
    expect(p.rentReceived).toBe(0);
    expect(p.isIncomeProducing).toBe(false);
    expect(p.grossYield).toBeNull();
    expect(p.netYield).toBeNull();
    expect(p.expectedAnnualRent).toBeNull();
  });

  it('still counts everything the house costs', () => {
    const p = perf([home()], [loan({ minimum_repayment: 4_000 })], [
      txn({ id: 'rates', date: '2025-10-10', merchant: 'WAVERLEY COUNCIL', amount: -1_200, category: 'Bills' }),
      txn({ id: 'strata', date: '2026-01-10', merchant: 'WAVERLEY COUNCIL STRATA LEVY', amount: -900, category: 'Bills' }),
    ]);
    expect(p.expensesPaid).toBe(2_100);
    expect(p.expenseCount).toBe(2);
  });

  it('and treats a refund as money back, not as earnings', () => {
    const p = perf([home()], [], [
      txn({ id: 'rates', date: '2025-10-10', merchant: 'WAVERLEY COUNCIL', amount: -1_200, category: 'Bills' }),
      txn({ id: 'back', date: '2026-02-10', merchant: 'WAVERLEY COUNCIL REBATE', amount: 300, category: 'Bills' }),
    ]);
    expect(p.refunds).toBe(300);
    expect(p.refundCount).toBe(1);
    expect(p.expensesPaid).toBe(900);
    expect(p.isIncomeProducing).toBe(false);
  });

  it('is not counted as a rented property by the portfolio', () => {
    const { totals } = report([home(), letRental({ id: 'p-inv' })], [], rentYear());
    expect(totals.rented).toBe(1);
    expect(totals.annualRent).toBe(30_000);
  });
});

describe('what a property costs, by cost type', () => {
  it('reads a transaction as the cost a landlord would call it', () => {
    const kinds = (merchant: string, o: Partial<Transaction> = {}) =>
      classifyPropertyExpense(txn({ merchant, amount: -100, ...o }));

    expect(kinds('STRATA PLUS PTY LTD')).toBe('strata');
    expect(kinds('BODY CORPORATE LEVY')).toBe('strata');
    expect(kinds('WAVERLEY COUNCIL RATES')).toBe('council');
    expect(kinds('SYDNEY WATER')).toBe('water');
    expect(kinds('AAMI LANDLORD INSURANCE')).toBe('insurance');
    expect(kinds('SMITH PLUMBING REPAIRS')).toBe('maintenance');
    expect(kinds('AGL ELECTRICITY')).toBe('utilities');
    expect(kinds('RAY WHITE MANAGEMENT FEE')).toBe('other');
  });

  it('asks the description before the category, so an electrician is not a utility', () => {
    expect(classifyPropertyExpense(txn({ merchant: 'DAVE THE ELECTRICIAN', amount: -400, category: 'Utilities' })))
      .toBe('maintenance');
    // Nothing in the text to go on — then the category it is already filed under.
    expect(classifyPropertyExpense(txn({ merchant: 'BPAY 4409', amount: -400, category: 'Insurance' })))
      .toBe('insurance');
  });

  it('totals the property by cost type, biggest first and "other" last', () => {
    const p = perf([rental({ match_terms: ['ray white', 'strata plus', 'waverley council', 'aami'] })], [], [
      ...rentYear(),
      txn({ id: 'x1', date: '2025-10-01', merchant: 'STRATA PLUS', amount: -1_200, category: 'Bills' }),
      txn({ id: 'x2', date: '2026-01-01', merchant: 'STRATA PLUS', amount: -1_200, category: 'Bills' }),
      txn({ id: 'x3', date: '2026-02-01', merchant: 'WAVERLEY COUNCIL RATES', amount: -900, category: 'Bills' }),
      txn({ id: 'x4', date: '2026-03-01', merchant: 'AAMI INSURANCE', amount: -700, category: 'Insurance' }),
      txn({ id: 'x5', date: '2026-04-01', merchant: 'RAY WHITE MANAGEMENT FEE', amount: -3_000, category: 'Bills' }),
    ]);

    expect(p.expensesByKind).toEqual([
      { kind: 'strata', label: 'Strata / body corporate', amount: 2_400, count: 2 },
      { kind: 'council', label: 'Council rates', amount: 900, count: 1 },
      { kind: 'insurance', label: 'Insurance', amount: 700, count: 1 },
      { kind: 'other', label: 'Other costs', amount: 3_000, count: 1 },
    ]);
    // The same money, still filed under the app's own categories for everything
    // else — this is a second reading, not a re-categorisation.
    expect(p.expensesPaid).toBe(7_000);
    expect(p.expensesByCategory.map(l => l.category)).toEqual(['Bills', 'Insurance']);
  });

  it('is available to a home exactly as it is to a rental', () => {
    const p = perf([property({ match_terms: ['strata plus'] })], [], [
      txn({ id: 's', date: '2026-05-01', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
    ]);
    expect(p.expensesByKind).toEqual([
      { kind: 'strata', label: 'Strata / body corporate', amount: 1_100, count: 1 },
    ]);
  });
});

describe('the rent you expect against the rent you got', () => {
  it('says nothing at all until an expected rent is set', () => {
    expect(perf([rental()], [], rentYear()).rentVsExpectedPercent).toBeNull();
  });

  it('reports a fully paid year as in line with what was agreed', () => {
    const p = perf([letRental()], [], rentYear());
    expect(p.expectedAnnualRent).toBe(30_000);
    expect(p.rentVsExpectedPercent).toBe(100);
  });

  it('and a vacancy as falling short of it, without anything being flagged', () => {
    const p = perf([letRental()], [], rentYear().slice(0, 9));
    expect(p.rentVsExpectedPercent).toBe(75);
  });

  it('reads the cycle the user chose, not one it guessed', () => {
    const weekly = letRental({ expected_rent_amount: 600, expected_rent_frequency: 'weekly' });
    expect(expectedAnnualRent(weekly)).toBe(31_200);
    expect(rentRules(weekly).annual).toBe(31_200);
  });
});

describe('picking the rent out of what already arrived', () => {
  const payroll = Array.from({ length: 26 }, (_, i) => txn({
    id: `pay-${i}`,
    date: new Date(Date.parse('2026-08-14') - i * 14 * 86_400_000).toISOString().slice(0, 10),
    merchant: 'ACME PAYROLL', amount: 4_000, category: 'Income',
  }));

  it('offers the payers who keep paying, the likeliest rent first', () => {
    const [first] = suggestRentPayers([...payroll, ...rentYear()], { asOf: AS_OF });
    // The TERM is the payer normalised — what will still match next month — while
    // the LABEL is how the statement wrote it, so the user recognises the row.
    expect(first.term).toBe('ray white rental');
    expect(first.label).toBe('RAY WHITE RENTAL');
    expect(first.payments).toBe(12);
    expect(first.latestAmount).toBe(2_500);
    expect(first.latestDate).toBe('2026-08-01');
    expect(first.frequency).toBe('monthly');
    expect(first.accountId).toBe('acct-everyday');
  });

  it('leaves out money going the other way, transfers and loose change', () => {
    const terms = suggestRentPayers([
      txn({ id: 'a', merchant: 'STRATA PLUS', amount: -1_200 }),
      txn({ id: 'b', merchant: 'TRANSFER FROM SAVINGS', amount: 5_000, category: 'Transfer' }),
      txn({ id: 'c', merchant: 'INTEREST', amount: 12 }),
      txn({ id: 'd', merchant: 'RAY WHITE RENTAL', amount: 2_500 }),
    ], { asOf: AS_OF }).map(s => s.term);
    expect(terms).toEqual(['ray white rental']);
  });

  it('can be narrowed to the account the user says rent lands in', () => {
    const suggestions = suggestRentPayers([
      txn({ id: 'a', merchant: 'RAY WHITE RENTAL', account_id: 'acct-ip', amount: 2_500 }),
      txn({ id: 'b', merchant: 'ACME PAYROLL', account_id: 'acct-everyday', amount: 4_000 }),
    ], { asOf: AS_OF, accountId: 'acct-ip' });
    expect(suggestions.map(s => s.term)).toEqual(['ray white rental']);
  });

  it('and looks no further back than the year the figures cover', () => {
    const old = txn({ id: 'old', date: '2024-01-01', merchant: 'OLD AGENT', amount: 2_000 });
    expect(suggestRentPayers([old], { asOf: AS_OF })).toEqual([]);
  });
});

describe('previewing the rules before they are saved', () => {
  const draft = {
    property_type: 'investment' as PropertyType,
    match_terms: ['strata plus'],
    match_account_ids: [],
    rent_match_terms: ['ray white'],
    rent_account_id: 'acct-everyday',
    expected_rent_amount: 2_500,
    expected_rent_frequency: 'monthly' as const,
    purchase_date: '2020-03-01',
  };
  const txns = [
    ...rentYear(),
    txn({ id: 'strata', date: '2026-05-01', merchant: 'STRATA PLUS', amount: -1_200, category: 'Bills' }),
    txn({ id: 'pay', date: '2026-05-15', merchant: 'ACME PAYROLL', amount: 6_000, category: 'Income' }),
  ];

  it('shows exactly what the saved property would show', () => {
    const preview = previewRules(draft, txns, AS_OF);
    const saved = perf([rental({ ...draft })], [], txns);

    expect(preview.rent.count).toBe(12);
    expect(preview.rent.total).toBe(saved.rentReceived);
    expect(preview.rent.latest).toEqual({ date: '2026-08-01', amount: 2_500 });
    expect(preview.expenses.total).toBe(saved.expensesPaid);
    expect(preview.expenses.byKind).toEqual(saved.expensesByKind);
    expect(preview.otherCredits.count).toBe(0);          // the salary was not claimed
  });

  it('counts the credits an expense rule is sweeping up, so a wide rule is visible', () => {
    const wide = previewRules({ ...draft, match_terms: ['acme'] }, txns, AS_OF);
    expect(wide.otherCredits).toEqual({ count: 1, total: 6_000 });
  });

  it('and finds nothing at all for a draft with no rules yet', () => {
    const bare = previewRules({ ...draft, match_terms: [], rent_match_terms: [], rent_account_id: null }, txns, AS_OF);
    expect(bare.rent.count).toBe(0);
    expect(bare.expenses.count).toBe(0);
  });
});

describe('validating the rent rules', () => {
  const sound = {
    address_street: '34 Beach Rd', address_suburb: 'Bondi', address_state: 'NSW',
    address_postcode: '2026', address_country: 'Australia', current_value: 1_000_000,
    property_type: 'investment' as PropertyType,
  };
  const check = (draft: Record<string, unknown>) =>
    validateProperty({ ...sound, ...draft } as any, { loans: [], properties: [] });

  it('refuses a payer too short to mean anyone', () => {
    expect(check({ rent_match_terms: ['rw'] }))
      .toEqual(['The rent payer must be at least 3 characters — "rw" is too broad.']);
  });

  it('refuses an expected rent with no cycle to read it on', () => {
    expect(check({ expected_rent_amount: 2_500, expected_rent_frequency: null }))
      .toEqual(['Choose how often that rent arrives.']);
    expect(check({ expected_rent_amount: 2_500, expected_rent_frequency: 'monthly' })).toEqual([]);
  });

  it('refuses a negative rent', () => {
    expect(check({ expected_rent_amount: -100, expected_rent_frequency: 'monthly' }))
      .toEqual(['Expected rent must be zero or more.']);
  });

  it('says nothing about rent rules left on a home — they are cleared, not argued with', () => {
    expect(check({ property_type: 'home', rent_match_terms: ['rw'], expected_rent_amount: 2_500, expected_rent_frequency: null }))
      .toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One payment, one match
// ═════════════════════════════════════════════════════════════════════════════
//
// The bug these exist for: a rent payment that reached the store twice — once
// entered by hand, once imported from the bank — was two matches, two months of
// rent, and a yield a third higher than the property earns.

describe('a payment that reached Ledger more than once', () => {
  const bankCopy = txn({
    id: 'bank', date: '2026-08-01', amount: 2_500,
    source: 'basiq', source_ref: 'basiq-991', basiq_tx_id: 'basiq-991',
  });
  const handCopy = txn({ id: 'mine', date: '2026-08-01', amount: 2_500, source: 'manual' });

  it('is counted once, and it is the bank\'s copy that survives', () => {
    const kept = uniqueRealTransactions([handCopy, bankCopy]);
    expect(kept.map(t => t.id)).toEqual(['bank']);
  });

  it('so the rent is one payment, not two', () => {
    const p = perf([letRental()], [], [...rentYear().slice(0, 11), handCopy, bankCopy]);
    expect(p.rentPayments).toBe(12);
    expect(p.rentReceived).toBe(30_000);
  });

  it('drops a manual entry the reconciler has already paired with its bank twin', () => {
    const paired = txn({ id: 'paired', date: '2026-08-01', amount: 2_500, source: 'manual', reconcile_state: 'conflict' });
    const resolved = txn({ id: 'settled', date: '2026-07-01', amount: 2_500, source: 'manual', reconcile_state: 'resolved' });
    const kept = uniqueRealTransactions([bankCopy, paired, resolved]);
    expect(kept.map(t => t.id)).toEqual(['bank']);
  });

  it('keeps a manual entry the bank has never shown — that money really did move', () => {
    const kept = txn({ id: 'kept', date: '2026-06-01', amount: 2_500, source: 'manual', reconcile_state: 'kept' });
    const pending = txn({ id: 'pending', date: '2026-05-01', amount: 2_500, source: 'manual', reconcile_state: 'pending' });
    expect(uniqueRealTransactions([kept, pending]).map(t => t.id)).toEqual(['kept', 'pending']);
  });

  it('but two tenants paying the same rent on the same day are two payments', () => {
    // The bank gave them separate ids, which is the only evidence that can tell
    // a genuine pair apart from a re-import — so it is the evidence we use.
    const a = txn({ id: 'a', date: '2026-08-01', amount: 2_500, source: 'basiq', source_ref: 'b-1' });
    const b = txn({ id: 'b', date: '2026-08-01', amount: 2_500, source: 'basiq', source_ref: 'b-2' });
    expect(uniqueRealTransactions([a, b]).map(t => t.id)).toEqual(['a', 'b']);

    const p = perf([letRental()], [], [a, b]);
    expect(p.rentPayments).toBe(2);
    expect(p.rentDays).toBe(1);
    expect(p.rentReceived).toBe(5_000);
  });

  it('leaves the order the caller gave it alone', () => {
    const older = txn({ id: 'older', date: '2026-06-01', amount: 2_500, source_ref: 'b-0' });
    expect(uniqueRealTransactions([bankCopy, older, handCopy]).map(t => t.id)).toEqual(['bank', 'older']);
  });

  it('and the payer picker offers one row, not one per copy', () => {
    const payers = suggestRentPayers([...rentYear().slice(0, 11), handCopy, bankCopy], { asOf: AS_OF });
    expect(payers).toHaveLength(1);
    expect(payers[0].payments).toBe(12);
  });
});

describe('the payer read off one real payment', () => {
  // What the bank actually writes: the same agent, a different reference every
  // month. A rule made from the raw text catches one month and misses the rest.
  const august = txn({ id: 'aug', date: '2026-08-01', merchant: 'RAY WHITE 4471 NSW AUS', amount: 2_500 });
  const july = txn({ id: 'jul', date: '2026-07-01', merchant: 'RAY WHITE 4623 NSW AUS', amount: 2_500 });
  const june = txn({ id: 'jun', date: '2026-06-01', merchant: 'RAY WHITE 4102 NSW AUS', amount: 2_500 });

  it('drops the reference number the bank appends', () => {
    expect(derivePayerTerm(august)).toBe('ray white');
    expect(derivePayerTerm(july)).toBe('ray white');
  });

  it('reads the payer, the account, the amount and the cycle off the payment', () => {
    const rule = rentRuleFromTransaction(august, [august, july, june], AS_OF)!;
    expect(rule.term).toBe('ray white');
    expect(rule.label).toBe('RAY WHITE 4471 NSW AUS');
    expect(rule.accountId).toBe('acct-everyday');
    expect(rule.amount).toBe(2_500);
    expect(rule.frequency).toBe('monthly');
    expect(rule.matches).toBe(3);
  });

  it('and the rule it makes catches the months with different references', () => {
    const rule = rentRuleFromTransaction(august, [august, july, june], AS_OF)!;
    const p = perf([letRental({ rent_match_terms: [rule.term] })], [], [august, july, june]);
    expect(p.rentPayments).toBe(3);
    expect(p.rentReceived).toBe(7_500);
  });

  it('so the picker groups a year of rent into ONE payer to choose', () => {
    const payers = suggestRentPayers([august, july, june], { asOf: AS_OF });
    expect(payers).toHaveLength(1);
    expect(payers[0].term).toBe('ray white');
    expect(payers[0].payments).toBe(3);
    expect(payers[0].label).toBe('RAY WHITE 4471 NSW AUS');
  });

  it('and the search narrows that list to what the user is looking for', () => {
    const all = [...rentYear(), txn({ id: 'pay', merchant: 'ACME PAYROLL', amount: 6_000, category: 'Income' })];
    expect(suggestRentPayers(all, { asOf: AS_OF, query: 'acme' }).map(s => s.term)).toEqual(['acme payroll']);
    expect(suggestRentPayers(all, { asOf: AS_OF, query: 'nobody' })).toEqual([]);
  });

  it('refuses a payer too short to trust rather than making a rule that catches everything', () => {
    expect(rentRuleFromTransaction(txn({ merchant: 'AB' }), [], AS_OF)).toBeNull();
  });
});

describe('reviewing what was matched', () => {
  it('lists every payment counted, newest first, with what claimed it', () => {
    const p = perf([letRental()], [], rentYear());
    expect(p.payments).toHaveLength(12);
    expect(p.payments[0].date).toBe('2026-08-01');
    expect(p.payments[0].kind).toBe('rent');
    expect(p.payments[0].via).toBe('ray white');
    expect(p.payments[0].amount).toBe(2_500);
  });

  it('takes a wrong match off when the user removes it', () => {
    const all = rentYear();
    const p = perf([letRental({ excluded_transaction_ids: ['rent-11'] })], [], all);
    expect(p.rentPayments).toBe(11);
    expect(p.rentReceived).toBe(27_500);
    expect(p.payments.some(line => line.id === 'rent-11')).toBe(false);
  });

  it('and the removal survives a rule that would still match it', () => {
    // The point of removing by id: the rule stays right about the other eleven.
    const claimed = attributeTransactions([letRental({ excluded_transaction_ids: ['rent-0'] })], rentYear());
    expect(claimed.get('p1')!.map(t => t.id)).not.toContain('rent-0');
    expect(claimed.get('p1')).toHaveLength(11);
  });

  it('a removed payment goes to no other property either — it just isn\'t this one\'s', () => {
    const claimed = attributeTransactions(
      [letRental({ excluded_transaction_ids: ['rent-0'] }), letRental({ id: 'p2' })],
      rentYear(),
    );
    expect(claimed.get('p1')).toHaveLength(11);
    // …unless another property genuinely claims it, which is the honest outcome.
    expect(claimed.get('p2')!.map(t => t.id)).toEqual(['rent-0']);
  });

  it('lists expenses and refunds separately from rent', () => {
    const p = perf([letRental({ property_expenses: [strataRule()] })], [], [
      ...rentYear(),
      txn({ id: 'levy', date: '2026-05-01', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
      txn({ id: 'back', date: '2026-05-20', merchant: 'STRATA PLUS REFUND', amount: 200, category: 'Bills' }),
    ]);
    expect(p.payments.find(l => l.id === 'levy')!.kind).toBe('expense');
    expect(p.payments.find(l => l.id === 'levy')!.via).toBe('Strata');
    expect(p.payments.find(l => l.id === 'back')!.kind).toBe('refund');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Expenses, one setup per cost
// ═════════════════════════════════════════════════════════════════════════════

const strataRule = (o: Partial<PropertyExpenseRule> = {}): PropertyExpenseRule => ({
  id: 'r-strata', name: 'Strata', kind: 'strata',
  expected_amount: 1_100, frequency: 'quarterly',
  account_id: null, whole_account: false, match_terms: ['strata plus'],
  ...o,
});

describe('an expense with its own setup', () => {
  const levies = [
    txn({ id: 'q1', date: '2025-09-15', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
    txn({ id: 'q2', date: '2025-12-15', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
    txn({ id: 'q3', date: '2026-03-15', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
    txn({ id: 'q4', date: '2026-06-15', merchant: 'STRATA PLUS', amount: -1_400, category: 'Bills' }),
  ];

  it('claims what its biller is paid, and files it under the type the user chose', () => {
    const p = perf([rental({ match_terms: [], property_expenses: [strataRule({ kind: 'strata' })] })], [], levies);
    expect(p.expenseCount).toBe(4);
    expect(p.expensesPaid).toBe(4_700);
    expect(p.expensesByKind[0]).toMatchObject({ kind: 'strata', amount: 4_700, count: 4 });
  });

  it('the type the user chose beats a guess from the wording', () => {
    // Filed as maintenance by the user, even though "plumbing" reads as a repair.
    const plumber = txn({ id: 'pl', date: '2026-05-01', merchant: 'BONDI PLUMBING', amount: -450, category: 'Bills' });
    const rule = strataRule({ id: 'r-x', name: 'Body corporate', kind: 'strata', match_terms: ['bondi plumbing'] });
    const p = perf([rental({ match_terms: [], property_expenses: [rule] })], [], [plumber]);
    expect(p.expensesByKind[0].kind).toBe('strata');
  });

  it('reports each cost against what it was expected to be', () => {
    const p = perf([rental({ match_terms: [], property_expenses: [strataRule()] })], [], levies);
    const [line] = p.expensesByRule;
    expect(line).toMatchObject({ id: 'r-strata', name: 'Strata', count: 4, amount: 4_700 });
    expect(line.expectedAnnual).toBe(4_400);
    expect(line.vsExpectedPercent).toBe(106.82);
    expect(line.latest).toEqual({ date: '2026-06-15', amount: 1_400 });
  });

  it('and reports a cost that has matched NOTHING, which is the useful one', () => {
    const p = perf([rental({ match_terms: [], property_expenses: [strataRule(), strataRule({ id: 'r-rates', name: 'Rates', kind: 'council', match_terms: ['waverley council'] })] })], [], levies);
    const rates = p.expensesByRule.find(r => r.id === 'r-rates')!;
    expect(rates.count).toBe(0);
    expect(rates.amount).toBe(0);
  });

  it('several costs are kept apart, each with its own biller', () => {
    const rules = [
      strataRule(),
      strataRule({ id: 'r-water', name: 'Water', kind: 'water', match_terms: ['sydney water'], expected_amount: 240, frequency: 'quarterly' }),
    ];
    const p = perf([rental({ match_terms: [], property_expenses: rules })], [], [
      ...levies,
      txn({ id: 'w1', date: '2026-04-01', merchant: 'SYDNEY WATER', amount: -240, category: 'Bills' }),
    ]);
    expect(p.expensesByRule.map(r => [r.name, r.count])).toEqual([['Strata', 4], ['Water', 1]]);
  });

  it('the most specific biller wins when two rules could both take it', () => {
    const rules = [
      strataRule({ id: 'r-broad', name: 'Anything strata', match_terms: ['strata'] }),
      strataRule({ id: 'r-exact', name: 'Strata Plus', match_terms: ['strata plus'] }),
    ];
    const p = perf([rental({ match_terms: [], property_expenses: rules })], [], levies);
    expect(p.expensesByRule.find(r => r.id === 'r-exact')!.count).toBe(4);
    expect(p.expensesByRule.find(r => r.id === 'r-broad')!.count).toBe(0);
  });
});

describe('an expense paid from an account', () => {
  const shop = txn({ id: 'shop', date: '2026-05-02', merchant: 'WOOLWORTHS', account_id: 'acct-ip', amount: -180, category: 'Groceries' });
  const levy = txn({ id: 'levy', date: '2026-05-01', merchant: 'SP12345 BC LEVY', account_id: 'acct-ip', amount: -1_100, category: 'Bills' });

  it('claims nothing on a shared account without an amount to check against', () => {
    const rule = strataRule({ match_terms: [], account_id: 'acct-ip', expected_amount: null, frequency: null });
    const p = perf([rental({ match_terms: [], property_expenses: [rule] })], [], [levy, shop]);
    expect(p.expenseCount).toBe(0);
  });

  it('claims the payment that fits what the bill should be, and leaves the shopping', () => {
    const rule = strataRule({ match_terms: [], account_id: 'acct-ip' });
    const p = perf([rental({ match_terms: [], property_expenses: [rule] })], [], [levy, shop]);
    expect(p.expenseCount).toBe(1);
    expect(p.expensesPaid).toBe(1_100);
  });

  it('claims everything on it once the user says the account is this property\'s alone', () => {
    const rule = strataRule({ match_terms: [], account_id: 'acct-ip', whole_account: true });
    const p = perf([rental({ match_terms: [], property_expenses: [rule] })], [], [levy, shop]);
    expect(p.expenseCount).toBe(2);
    expect(p.expensesPaid).toBe(1_280);
  });

  it('and that is exactly what the old dedicated-account setting becomes', () => {
    const legacy = rental({ match_terms: [], match_account_ids: ['acct-ip'] });
    const converted = convertLegacyRules(legacy, () => 'Investment account');
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ name: 'Investment account', account_id: 'acct-ip', whole_account: true });

    const before = perf([legacy], [], [levy, shop]);
    const after = perf([rental({ match_terms: [], match_account_ids: [], property_expenses: converted })], [], [levy, shop]);
    expect(after.expensesPaid).toBe(before.expensesPaid);
  });
});

describe('costs set up before this refinement', () => {
  it('go on being matched exactly as they were', () => {
    const p = perf([rental({ match_terms: ['strata plus'] })], [], [
      txn({ id: 'levy', date: '2026-05-01', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
    ]);
    expect(p.expensesPaid).toBe(1_100);
  });

  it('and convert into one named cost each, typed from what they say', () => {
    const converted = convertLegacyRules({ match_terms: ['Strata Plus', 'Waverley Council'], match_account_ids: [] });
    expect(converted.map(r => [r.name, r.kind, r.match_terms])).toEqual([
      ['Strata Plus', 'strata', ['strata plus']],
      ['Waverley Council', 'council', ['waverley council']],
    ]);
  });

  it('catching the same money afterwards as before', () => {
    const txns = [
      txn({ id: 'levy', date: '2026-05-01', merchant: 'STRATA PLUS', amount: -1_100, category: 'Bills' }),
      txn({ id: 'rates', date: '2026-04-01', merchant: 'WAVERLEY COUNCIL', amount: -820, category: 'Bills' }),
    ];
    const before = perf([rental({ match_terms: ['strata plus', 'waverley council'] })], [], txns);
    const after = perf([rental({
      match_terms: [], property_expenses: convertLegacyRules({ match_terms: ['Strata Plus', 'Waverley Council'], match_account_ids: [] }),
    })], [], txns);
    expect(after.expensesPaid).toBe(before.expensesPaid);
    expect(after.expenseCount).toBe(before.expenseCount);
  });
});

describe('picking a cost out of what has already been paid', () => {
  const bills = [
    txn({ id: 'c1', date: '2025-10-10', merchant: 'WAVERLEY COUNCIL RATES', amount: -820, category: 'Bills' }),
    txn({ id: 'c2', date: '2026-09-10', merchant: 'WAVERLEY COUNCIL RATES', amount: -860, category: 'Bills' }),
    txn({ id: 'shop', date: '2026-05-02', merchant: 'WOOLWORTHS', amount: -180, category: 'Groceries' }),
    txn({ id: 'in', date: '2026-05-02', merchant: 'ACME PAYROLL', amount: 6_000, category: 'Income' }),
  ];

  it('offers what a property costs before what it doesn\'t', () => {
    const [first] = suggestExpenseBillers(bills, { asOf: '2026-09-30' });
    expect(first.term).toBe('waverley council rates');
    expect(first.kind).toBe('council');
    expect(first.payments).toBe(2);
    expect(first.typicalAmount).toBe(840);
    expect(first.frequency).toBe('annually');
  });

  it('never offers money coming in — an expense is money going out', () => {
    expect(suggestExpenseBillers(bills, { asOf: '2026-09-30' }).map(b => b.term)).not.toContain('acme payroll');
  });

  it('and the search is what makes a real statement usable', () => {
    expect(suggestExpenseBillers(bills, { asOf: '2026-09-30', query: 'wool' }).map(b => b.term)).toEqual(['woolworths']);
  });

  it('fills the whole rule from the payment the user pointed at', () => {
    const rule = expenseRuleFromTransaction(bills[1], bills, '2026-09-30')!;
    expect(rule).toMatchObject({
      name: 'WAVERLEY COUNCIL RATES', kind: 'council',
      expected_amount: 840, frequency: 'annually',
      account_id: 'acct-everyday', whole_account: false,
      match_terms: ['waverley council rates'],
    });
    expect(rule.id).toMatch(/^pex_/);
  });
});

describe('validating an expense', () => {
  const check = (rules: PropertyExpenseRule[]) => validateProperty(
    { ...property(), current_value: 1_000_000, property_expenses: rules },
    { loans: [], properties: [] },
  );

  it('asks for a name, because a cost you can\'t tell apart you can\'t correct', () => {
    expect(check([strataRule({ name: '  ' })])).toContain('Give every expense a name — "Strata", "Council rates", "Water".');
  });

  it('refuses a biller too short to mean one property', () => {
    expect(check([strataRule({ match_terms: ['sp'] })]))
      .toContain('Who you pay must be at least 3 characters — "sp" is too broad.');
  });

  it('refuses an amount with no cycle — it could not become a yearly figure', () => {
    expect(check([strataRule({ frequency: null })])).toContain('Choose how often "Strata" falls due.');
  });

  it('refuses a negative expected cost', () => {
    expect(check([strataRule({ expected_amount: -5 })])).toContain('An expected cost must be zero or more.');
  });

  it('refuses "used only for this property" with no account chosen', () => {
    expect(check([strataRule({ account_id: null, whole_account: true })]))
      .toContain('Choose the account before saying it is used only for this property.');
  });

  it('and is happy with a cost that is only a name and a biller', () => {
    expect(check([strataRule({ expected_amount: null, frequency: null })])).toEqual([]);
  });
});
