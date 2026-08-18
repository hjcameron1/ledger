import { describe, it, expect } from 'vitest';
import {
  ownershipShare, ownedValue, linkedLoan, netWorthValue, propertyNetWorthTotal,
  buildPropertyReport, availableLoansForProperty, availableFundsForProperty,
  validateProperty, formatAddress, streetLine, propertyLabel, addressParts,
  heldBy, countedInFund, fundLink, linkedFund, isAustralia,
  attributeTransactions, hasMatchRules, performanceWindow, annualMortgageCost,
  PROPERTY_TYPE_LABELS, HELD_BY_LABELS,
  type FundEntity,
} from './property';
import type { Property, Loan, Transaction } from '../types';

/**
 * The property engine.
 *
 * The load-bearing claim of this phase is that nothing is counted twice. A
 * property contributes the share of its value that the user owns; its mortgage is
 * subtracted by the loans side of net worth; and when the SMSF holding it already
 * lists the property, the property contributes nothing at all because the fund's
 * balance is carrying the value. `netWorthEffect` re-derives the whole picture, so
 * the tests below can assert the total rather than trusting each half.
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
      debt: 0, equity: 0, netWorthEffect: 0, count: 0,
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
    expect(p.rentPayments).toBe(12);
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

  it('add up the rent, the costs and the cash flow across every property', () => {
    const { totals } = report([investment, home], [loan({ minimum_repayment: 3_000 })], [...rentYear(), rates]);

    expect(totals.annualRent).toBe(30_000);
    expect(totals.annualExpenses).toBe(1_200);
    expect(totals.annualMortgage).toBe(36_000);
    expect(totals.annualCashFlow).toBe(-7_200);
    expect(totals.monthlyCashFlow).toBe(-600);
    expect(totals.rented).toBe(1);
  });

  it('yield only counts the properties that EARN, so a home does not halve it', () => {
    const { totals } = report([investment, home], [], [...rentYear(), rates]);
    expect(totals.grossYield).toBe(3);            // 30,000 / 1,000,000 — not / 3,000,000
    expect(totals.netYield).toBe(2.88);           // (30,000 − 1,200) / 1,000,000
  });

  it('leave equity and net worth exactly where they were — rent is not an asset', () => {
    const withMoney = report([investment, home], [loan({ minimum_repayment: 3_000 })], [...rentYear(), rates]);
    const without = report([investment, home], [loan({ minimum_repayment: 3_000 })], []);

    expect(withMoney.totals.netWorthValue).toBe(without.totals.netWorthValue);
    expect(withMoney.totals.equity).toBe(without.totals.equity);
    expect(withMoney.totals.netWorthEffect).toBe(without.totals.netWorthEffect);
  });
});
