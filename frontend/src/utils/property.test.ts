import { describe, it, expect } from 'vitest';
import {
  ownershipShare, ownedValue, linkedLoan, netWorthValue, propertyNetWorthTotal,
  buildPropertyReport, availableLoansForProperty, availableFundsForProperty,
  validateProperty, formatAddress, streetLine, propertyLabel, addressParts,
  heldBy, countedInFund, fundLink, linkedFund, isAustralia,
  PROPERTY_TYPE_LABELS, HELD_BY_LABELS,
  type FundEntity,
} from './property';
import type { Property, Loan } from '../types';

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
