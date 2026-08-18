/**
 * Phase 4.1 — properties, end to end through the store.
 *
 * The engine is unit-tested on its own; these are the things it cannot prove
 * without the real data service wired up:
 *
 *   • a property reaches net worth as an ASSET, and a linked mortgage is
 *     subtracted exactly once — by the loan, not again by the property;
 *   • an SMSF-held property whose fund already lists it adds NOTHING here, so the
 *     same house never lands in net worth via both the fund and the property;
 *   • add / edit / delete each queue the right write, so a second device sees
 *     the same portfolio (cross-device persistence);
 *   • deleting a property leaves the debt alone, and deleting a loan releases
 *     the property instead of leaving it netting a mortgage that is gone;
 *   • one user never sees, or is valued against, another's property.
 *
 * Sync is mocked, so "cross-device" here means "the right op, with the right
 * payload, was queued" — which is exactly what the other device replays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Property, Loan, SuperFund, Transaction, PropertyExpenseRule } from '../types';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

// The SMSF list is fetched, not stored. Stubbed so propertyFundsDS.load() can be
// exercised without a network, and so a FAILED fetch can be tested too. Declared
// via vi.hoisted because the mock factory below is lifted above this file's body.
const { smsfGetAll } = vi.hoisted(() => ({ smsfGetAll: vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, smsfApi: { ...actual.smsfApi, getAll: smsfGetAll } };
});

import { useStore } from '../store';
import { syncWithRetry } from './syncQueue';
import { propertiesDS, propertyReportDS, propertyFundsDS, loansDS, transactionsDS, calculateNetWorth } from './dataService';
import { suggestRentPayers } from '../utils/property';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const mockedSync = vi.mocked(syncWithRetry);

const property = (o: Partial<Property> = {}): Property => ({
  id: 'p1', user_id: ME, name: 'Bondi apartment',
  address_unit: null, address_street: '34 Beach Rd', address_suburb: 'Bondi',
  address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
  property_type: 'home', held_by: 'personal',
  purchase_price: 800_000, purchase_date: '2020-03-01',
  current_value: 1_000_000, ownership_percent: 100, loan_id: null,
  include_in_net_worth: true, ...o,
});

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: ME, name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 640_000, current_balance: 600_000, repayment_frequency: 'monthly',
  include_in_net_worth: true, ...o,
} as Loan);

const superFund = (o: Partial<SuperFund> = {}): SuperFund => ({
  id: 's1', user_id: ME, fund_name: 'AustralianSuper', balance: 200_000,
  employer_contributions: 0, personal_contributions: 0,
  include_in_investments: true, include_in_net_worth: true, ...o,
} as SuperFund);

function seed(opts: { properties?: Property[]; loans?: Loan[]; accounts?: any[]; superFunds?: SuperFund[]; transactions?: Transaction[] } = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com', currency_preference: 'AUD' } as any,
    properties: opts.properties ?? [],
    loans: opts.loans ?? [],
    accounts: opts.accounts ?? [],
    superFunds: opts.superFunds ?? [],
    // Rent and expenses are ordinary transactions, so the store's transaction
    // list is part of a property's world now (Phase 4.3).
    transactions: opts.transactions ?? [],
    // Everything else calculateNetWorth reads — empty unless a test needs it.
    creditCards: [], investments: [], bills: [], netWorthHistory: [],
  } as any);
}

const kinds = () => mockedSync.mock.calls.map(c => c[0] as string);
const payloadOf = (kind: string) => mockedSync.mock.calls.find(c => c[0] === kind)?.[1] as any;
const draft = (o: Partial<Property> = {}) => {
  const { id, user_id, created_at, updated_at, ...rest } = property(o);
  return rest;
};
/** A draft as the modal builds it, for the validator. */
const validDraft = (o: Record<string, unknown> = {}) => ({
  name: 'New place',
  address_street: '1 Test St', address_suburb: 'Testville',
  address_state: 'NSW', address_postcode: '2000', address_country: 'Australia',
  current_value: 1, ...o,
});

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  smsfGetAll.mockReset();
  smsfGetAll.mockResolvedValue({ funds: [{ id: 'f1', name: 'Cameron Super Fund', include_in_net_worth: true }] });
  propertyFundsDS.reset();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Net worth — one property, one mortgage, counted once
// ═════════════════════════════════════════════════════════════════════════════
describe('property in net worth', () => {
  it('adds the owned value as an asset', () => {
    seed({ properties: [property()] });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(1_000_000);
    expect(nw.net_worth).toBe(1_000_000);
  });

  it('subtracts a linked mortgage ONCE — via the loan, not twice', () => {
    seed({ properties: [property({ loan_id: 'l1' })], loans: [loan()] });
    const nw = calculateNetWorth();

    expect(nw.property).toBe(1_000_000);            // the asset, whole
    expect(nw.net_worth).toBe(400_000);             // 1,000,000 − 600,000, once
    // And the page agrees with the total: the property's effect on net worth is
    // exactly the equity it displays.
    expect(propertyReportDS.build().totals.netWorthEffect).toBe(400_000);
  });

  it('the same mortgage without a property still counts once (nothing changes for loans)', () => {
    seed({ loans: [loan()] });
    expect(calculateNetWorth().net_worth).toBe(-600_000);
  });

  it('partial ownership only brings its share into net worth', () => {
    seed({ properties: [property({ ownership_percent: 50 })] });
    expect(calculateNetWorth().property).toBe(500_000);
  });

  it('a property opted out of net worth is absent from the total but still listed', () => {
    seed({ properties: [property({ include_in_net_worth: false })] });
    expect(calculateNetWorth().property).toBe(0);
    expect(propertyReportDS.build().rows).toHaveLength(1);
  });

  it('multiple properties and their mortgages all land once each', () => {
    seed({
      properties: [
        property({ id: 'p1', current_value: 1_000_000, loan_id: 'l1' }),
        property({ id: 'p2', current_value: 600_000, ownership_percent: 50, loan_id: 'l2' }),
        property({ id: 'p3', current_value: 400_000 }),
      ],
      loans: [loan(), loan({ id: 'l2', name: 'Investment loan', current_balance: 250_000 })],
    });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(1_700_000);
    expect(nw.net_worth).toBe(850_000);   // 1,700,000 − 600,000 − 250,000
  });

  it('sits alongside cash without disturbing it', () => {
    seed({ properties: [property()], accounts: [{ id: 'a1', balance: 5_000 }] });
    const nw = calculateNetWorth();
    expect(nw.bank_balance).toBe(5_000);
    expect(nw.net_worth).toBe(1_005_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SMSF-held property — the second double-count guard
// ═════════════════════════════════════════════════════════════════════════════
describe('an SMSF property already inside its fund balance', () => {
  const held = (o: Partial<Property> = {}) =>
    property({ held_by: 'smsf', super_fund_id: 's1', counted_in_fund_balance: true, ...o });

  it('is counted by the FUND and not again by the property', () => {
    // The super fund's 1.2m balance already includes the 1m house.
    seed({ properties: [held()], superFunds: [superFund({ balance: 1_200_000 })] });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(0);              // nothing added here…
    expect(nw.super).toBe(1_200_000);         // …because this already has it
    expect(nw.net_worth).toBe(1_200_000);     // not 2,200,000
  });

  it('is counted HERE when the fund balance excludes it', () => {
    seed({
      properties: [held({ counted_in_fund_balance: false })],
      superFunds: [superFund({ balance: 200_000 })],
    });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(1_000_000);
    expect(nw.net_worth).toBe(1_200_000);     // 200,000 fund + 1m house, once each
  });

  it('its mortgage is still subtracted — the fund holds the asset, not the debt', () => {
    seed({
      properties: [held({ loan_id: 'l1' })],
      loans: [loan()],
      superFunds: [superFund({ balance: 1_200_000 })],
    });
    expect(calculateNetWorth().net_worth).toBe(600_000);   // 1,200,000 − 600,000
    expect(propertyReportDS.build().rows[0].netWorthEffect).toBe(-600_000);
  });

  it('still displays its value and equity in the list', () => {
    seed({ properties: [held({ loan_id: 'l1' })], loans: [loan()] });
    const row = propertyReportDS.build().rows[0];
    expect(row.value).toBe(1_000_000);
    expect(row.equity).toBe(400_000);
    expect(row.netWorthValue).toBe(0);
    expect(row.countedInFundBalance).toBe(true);
  });

  it('partial ownership inside a fund still only brings its own share', () => {
    seed({ properties: [held({ counted_in_fund_balance: false, ownership_percent: 40 })] });
    expect(calculateNetWorth().property).toBe(400_000);
  });

  it('switching a property out of the SMSF starts counting it here', () => {
    seed({ properties: [held()], superFunds: [superFund({ balance: 1_200_000 })] });
    expect(calculateNetWorth().property).toBe(0);

    propertiesDS.update('p1', { held_by: 'personal', super_fund_id: null, smsf_fund_id: null });
    expect(calculateNetWorth().property).toBe(1_000_000);
    const data = payloadOf('property.update').data;
    expect(data.held_by).toBe('personal');
    expect(data.super_fund_id).toBeNull();
  });

  it('several properties in the one fund are all left to the fund', () => {
    // A fund isn't exclusive the way a mortgage is; the balance covers them all.
    seed({
      properties: [held({ id: 'p1' }), held({ id: 'p2', current_value: 700_000 })],
      superFunds: [superFund({ balance: 1_900_000 })],
    });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(0);
    expect(nw.net_worth).toBe(1_900_000);
    expect(propertyReportDS.build().totals.countedInFunds).toBe(1_700_000);
  });

  it('mixes fund-held and personal property in one portfolio', () => {
    seed({
      properties: [held({ id: 'p1' }), property({ id: 'p2', current_value: 800_000 })],
      superFunds: [superFund({ balance: 1_200_000 })],
    });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(800_000);
    expect(nw.net_worth).toBe(2_000_000);   // 1.2m fund (incl. p1) + 800k p2
  });
});

describe('the funds a property can be held in', () => {
  it('offers the user’s SMSFs and super funds together, SMSFs first', async () => {
    seed({ superFunds: [superFund()] });
    const funds = await propertyFundsDS.load();
    expect(funds.map(f => `${f.kind}:${f.id}`)).toEqual(['smsf:f1', 'super:s1']);
  });

  it('a failed SMSF fetch still leaves super funds selectable', async () => {
    smsfGetAll.mockRejectedValue(new Error('offline'));
    seed({ superFunds: [superFund()] });
    const funds = await propertyFundsDS.load();
    expect(funds.map(f => f.id)).toEqual(['s1']);
  });

  it('names the fund a property points at', async () => {
    seed({ properties: [property({ held_by: 'smsf', smsf_fund_id: 'f1' })] });
    await propertyFundsDS.load();
    expect(propertyReportDS.build().rows[0].fund).toEqual({ kind: 'smsf', id: 'f1', name: 'Cameron Super Fund' });
  });

  it('refuses a fund link the fund list has never heard of', async () => {
    seed({ superFunds: [superFund()] });
    await propertyFundsDS.load();
    expect(propertiesDS.validate(validDraft({ held_by: 'smsf', smsf_fund_id: 'ghost' }), null))
      .toEqual(['That fund no longer exists.']);
    expect(propertiesDS.validate(validDraft({ held_by: 'smsf', smsf_fund_id: 'f1' }), null)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Add / edit / delete, and what a second device replays
// ═════════════════════════════════════════════════════════════════════════════
describe('adding a property', () => {
  it('lands in the store and queues a create carrying every field', () => {
    const rec = propertiesDS.add(draft({ loan_id: null }));
    expect(propertiesDS.getAll().map(p => p.id)).toEqual([rec.id]);

    expect(kinds()).toContain('property.create');
    const payload = payloadOf('property.create');
    expect(payload.recordId).toBe(rec.id);
    expect(payload.data).toMatchObject({
      name: 'Bondi apartment',
      address_street: '34 Beach Rd', address_suburb: 'Bondi',
      address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
      property_type: 'home', held_by: 'personal',
      purchase_price: 800_000, purchase_date: '2020-03-01', current_value: 1_000_000,
      ownership_percent: 100, loan_id: null, include_in_net_worth: true,
    });
  });

  it('sends the structured address as parts, so it can be grouped and sorted later', () => {
    propertiesDS.add(draft({ address_unit: '12' }));
    const data = payloadOf('property.create').data;
    expect(data.address_unit).toBe('12');
    expect(data.address_street).toBe('34 Beach Rd');
    // The address is NOT flattened into one string on the way out.
    expect(data.address).toBeNull();
  });

  it('an SMSF-held property carries its fund and the counted-once flag', () => {
    propertiesDS.add(draft({ held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: true }));
    const data = payloadOf('property.create').data;
    expect(data).toMatchObject({ held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: true, super_fund_id: null });
  });

  it('never sends id/user_id/timestamps — the server owns those', () => {
    propertiesDS.add(draft());
    const data = payloadOf('property.create').data;
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('user_id');
    expect(data).not.toHaveProperty('created_at');
  });

  it('stamps the signed-in user, so the row belongs to somebody', () => {
    expect(propertiesDS.add(draft()).user_id).toBe(ME);
  });

  it('a nickname-less property is saved, and labelled by its address', () => {
    propertiesDS.add(draft({ name: null }));
    expect(payloadOf('property.create').data.name).toBeNull();
    expect(propertyReportDS.build().rows[0].name).toBe('34 Beach Rd, Bondi');
  });

  it('a linked mortgage rides along in the payload', () => {
    seed({ loans: [loan()] });
    propertiesDS.add(draft({ loan_id: 'l1' }));
    expect(payloadOf('property.create').data.loan_id).toBe('l1');
  });

  it('adding a property does not create, change or duplicate any loan', () => {
    seed({ loans: [loan()] });
    propertiesDS.add(draft({ loan_id: 'l1' }));
    expect(useStore.getState().loans).toHaveLength(1);
    expect(kinds().filter(k => k.startsWith('loan.'))).toEqual([]);
  });

  it('adding a property does not touch any super fund either', () => {
    seed({ superFunds: [superFund()] });
    propertiesDS.add(draft({ held_by: 'smsf', super_fund_id: 's1' }));
    expect(useStore.getState().superFunds[0].balance).toBe(200_000);
    expect(kinds().filter(k => k.startsWith('super.'))).toEqual([]);
  });
});

describe('editing a property', () => {
  beforeEach(() => seed({ properties: [property()], loans: [loan()] }));

  it('a revaluation moves net worth and queues the update', () => {
    propertiesDS.update('p1', { current_value: 1_200_000 });
    expect(calculateNetWorth().property).toBe(1_200_000);
    expect(payloadOf('property.update')).toMatchObject({ id: 'p1' });
    expect(payloadOf('property.update').data.current_value).toBe(1_200_000);
  });

  it('changing the ownership share re-slices the value', () => {
    propertiesDS.update('p1', { ownership_percent: 25 });
    expect(calculateNetWorth().property).toBe(250_000);
    expect(payloadOf('property.update').data.ownership_percent).toBe(25);
  });

  it('correcting the address updates the parts, and the derived name with it', () => {
    propertiesDS.update('p1', { name: null, address_street: '36 Beach Rd', address_postcode: '2027' });
    const data = payloadOf('property.update').data;
    expect(data.address_street).toBe('36 Beach Rd');
    expect(data.address_postcode).toBe('2027');
    expect(propertyReportDS.build().rows[0].name).toBe('36 Beach Rd, Bondi');
  });

  it('linking a mortgage after the fact nets it off the equity, once', () => {
    propertiesDS.update('p1', { loan_id: 'l1' });
    const report = propertyReportDS.build();
    expect(report.rows[0].loan?.id).toBe('l1');
    expect(report.rows[0].equity).toBe(400_000);
    expect(calculateNetWorth().net_worth).toBe(400_000);
    expect(payloadOf('property.update').data.loan_id).toBe('l1');
  });

  it('unlinking a mortgage leaves the debt in place — the loan is still owed', () => {
    seed({ properties: [property({ loan_id: 'l1' })], loans: [loan()] });
    propertiesDS.update('p1', { loan_id: null });
    expect(propertyReportDS.build().rows[0].loan).toBeNull();
    expect(useStore.getState().loans).toHaveLength(1);
    expect(calculateNetWorth().net_worth).toBe(400_000);   // asset + debt, unchanged
  });

  it('moving a property INTO an SMSF stops it being counted twice', () => {
    seed({ properties: [property()], superFunds: [superFund({ balance: 1_200_000 })] });
    expect(calculateNetWorth().net_worth).toBe(2_200_000);   // both counted — the bug

    propertiesDS.update('p1', { held_by: 'smsf', super_fund_id: 's1', counted_in_fund_balance: true });
    expect(calculateNetWorth().net_worth).toBe(1_200_000);   // …now the fund alone
  });

  it('flipping the net-worth toggle drops it from the total and syncs the choice', () => {
    // The switch on each property card, same as super funds and loans carry.
    expect(calculateNetWorth().property).toBe(1_000_000);

    propertiesDS.update('p1', { include_in_net_worth: false });
    expect(calculateNetWorth().property).toBe(0);
    expect(payloadOf('property.update').data.include_in_net_worth).toBe(false);
    // Still listed and still valued — excluded, not deleted.
    const row = propertyReportDS.build().rows[0];
    expect(row.countsTowardNetWorth).toBe(false);
    expect(row.ownedValue).toBe(1_000_000);
    expect(row.netWorthValue).toBe(0);
  });

  it('toggling it back on restores the value, and survives a reload either way', () => {
    propertiesDS.update('p1', { include_in_net_worth: false });
    propertiesDS.update('p1', { include_in_net_worth: true });
    expect(calculateNetWorth().property).toBe(1_000_000);

    const persisted = useStore.getState().properties;
    useStore.setState({ properties: persisted } as any);
    expect(propertiesDS.getAll()[0].include_in_net_worth).toBe(true);
  });

  it('excluding a property still leaves its mortgage subtracted — that debt is real', () => {
    seed({ properties: [property({ loan_id: 'l1' })], loans: [loan()] });
    propertiesDS.update('p1', { include_in_net_worth: false });
    expect(calculateNetWorth().net_worth).toBe(-600_000);
    expect(propertyReportDS.build().rows[0].netWorthEffect).toBe(-600_000);
  });

  it('the update payload is the whole record, so a replay cannot half-apply it', () => {
    propertiesDS.update('p1', { name: 'Bondi flat' });
    const data = payloadOf('property.update').data;
    expect(data.name).toBe('Bondi flat');
    expect(data.current_value).toBe(1_000_000);   // untouched fields still sent
    expect(data.address_suburb).toBe('Bondi');
  });

  it('a property saved before the structured address can still be toggled — no blank parts sent', () => {
    // The real 400: writes carry the whole record, so a legacy row shipped five
    // null address parts and the server refused the lot — a net-worth toggle
    // included. Blank required parts are now left out; the stored value stands.
    seed({ properties: [property({
      address: '7606 fairway Blvd Hope Island', address_street: null, address_suburb: null,
      address_state: null, address_postcode: null, address_country: null,
    } as Partial<Property>)] });

    propertiesDS.update('p1', { include_in_net_worth: false });
    const data = payloadOf('property.update').data;

    expect(data.include_in_net_worth).toBe(false);      // the change still goes
    expect('address_street' in data).toBe(false);       // …and nothing blank rides along
    expect('address_suburb' in data).toBe(false);
    expect('address_state' in data).toBe(false);
    expect('address_postcode' in data).toBe(false);
    expect('address_country' in data).toBe(false);
    expect(data.address).toBe('7606 fairway Blvd Hope Island');   // legacy line preserved
  });

  it('a whitespace-only address part is treated as blank, and a real one is trimmed', () => {
    seed({ properties: [property({ address_state: '   ', address_suburb: ' Bondi ' } as Partial<Property>)] });
    propertiesDS.update('p1', { current_value: 1_100_000 });
    const data = payloadOf('property.update').data;
    expect('address_state' in data).toBe(false);
    expect(data.address_suburb).toBe('Bondi');
  });

  it('an edit survives a reload: the store holds the new value, not the old', () => {
    propertiesDS.update('p1', { current_value: 1_111_000, address_suburb: 'North Bondi' });
    // Simulate the rehydrate: the persisted slice is what a reload restores.
    const persisted = useStore.getState().properties;
    useStore.setState({ properties: persisted } as any);
    expect(propertiesDS.getAll()[0].current_value).toBe(1_111_000);
    expect(propertiesDS.getAll()[0].address_suburb).toBe('North Bondi');
  });

  it('an SMSF link survives a reload too', () => {
    propertiesDS.update('p1', { held_by: 'smsf', smsf_fund_id: 'f1' });
    const persisted = useStore.getState().properties;
    useStore.setState({ properties: persisted } as any);
    expect(propertiesDS.getAll()[0].smsf_fund_id).toBe('f1');
    expect(calculateNetWorth().property).toBe(0);
  });
});

describe('deleting', () => {
  it('removes the property and queues the delete', () => {
    seed({ properties: [property()] });
    propertiesDS.remove('p1');
    expect(propertiesDS.getAll()).toEqual([]);
    expect(payloadOf('property.delete')).toEqual({ id: 'p1' });
  });

  it('deleting a property KEEPS its mortgage — you still owe the money', () => {
    seed({ properties: [property({ loan_id: 'l1' })], loans: [loan()] });
    propertiesDS.remove('p1');
    expect(useStore.getState().loans).toHaveLength(1);
    expect(kinds()).not.toContain('loan.delete');
    expect(calculateNetWorth().net_worth).toBe(-600_000);   // the debt remains
  });

  it('deleting the MORTGAGE releases the property instead of netting a ghost', () => {
    seed({ properties: [property({ loan_id: 'l1' })], loans: [loan()] });
    loansDS.remove('l1');

    const report = propertyReportDS.build();
    expect(report.rows).toHaveLength(1);            // the house is still owned
    expect(report.rows[0].loan).toBeNull();
    expect(report.rows[0].equity).toBe(1_000_000);
    expect(calculateNetWorth().net_worth).toBe(1_000_000);
  });

  it('deleting an SMSF property leaves the fund balance alone', () => {
    // The fund's balance is its own record; the property was only ever a pointer.
    seed({
      properties: [property({ held_by: 'smsf', super_fund_id: 's1' })],
      superFunds: [superFund({ balance: 1_200_000 })],
    });
    propertiesDS.remove('p1');
    expect(useStore.getState().superFunds[0].balance).toBe(1_200_000);
    expect(calculateNetWorth().net_worth).toBe(1_200_000);
  });

  it('deleting one property leaves the others alone', () => {
    seed({ properties: [property({ id: 'p1' }), property({ id: 'p2', name: 'Beach house', current_value: 400_000 })] });
    propertiesDS.remove('p1');
    expect(propertiesDS.getAll().map(p => p.id)).toEqual(['p2']);
    expect(calculateNetWorth().property).toBe(400_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Linking rules, enforced against live data
// ═════════════════════════════════════════════════════════════════════════════
describe('choosing a mortgage to link', () => {
  it('a loan backing another property is off the list and refused', () => {
    seed({
      properties: [property({ id: 'p1', name: 'Beach house', loan_id: 'l1' })],
      loans: [loan(), loan({ id: 'l2', name: 'Car loan', loan_type: 'car' })],
    });
    expect(propertiesDS.availableLoans('p2').map(l => l.id)).toEqual(['l2']);
    expect(propertiesDS.validate(validDraft({ loan_id: 'l1' }), 'p2'))
      .toEqual(['That loan is already linked to "Beach house".']);
  });

  it('a property may keep its own loan while being edited', () => {
    seed({ properties: [property({ id: 'p1', loan_id: 'l1' })], loans: [loan()] });
    expect(propertiesDS.availableLoans('p1').map(l => l.id)).toEqual(['l1']);
    expect(propertiesDS.validate(validDraft({ loan_id: 'l1' }), 'p1')).toEqual([]);
  });

  it('another user’s loan is neither offered nor accepted', () => {
    seed({ loans: [loan({ id: 'l9', user_id: OTHER })] });
    expect(propertiesDS.availableLoans(null)).toEqual([]);
    expect(propertiesDS.validate(validDraft({ loan_id: 'l9' }), null))
      .toEqual(['That loan no longer exists.']);
  });

  it('an SMSF property may link a mortgage as well as a fund', () => {
    seed({ loans: [loan()], superFunds: [superFund()] });
    expect(propertiesDS.validate(validDraft({ held_by: 'smsf', super_fund_id: 's1', loan_id: 'l1' }), null)).toEqual([]);
  });

  it('a half-entered address is refused before anything is queued', () => {
    expect(propertiesDS.validate(validDraft({ address_suburb: '' }), null))
      .toEqual(['Suburb / locality is required.']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  User isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('one user never sees another’s property', () => {
  beforeEach(() => {
    seed({
      properties: [
        property({ id: 'mine', name: 'Mine', current_value: 1_000_000 }),
        property({ id: 'theirs', user_id: OTHER, name: 'Theirs', current_value: 9_000_000 }),
      ],
      loans: [loan()],
    });
  });

  it('the list and the report show only your own', () => {
    expect(propertiesDS.getAll().map(p => p.id)).toEqual(['mine']);
    expect(propertyReportDS.build().rows.map(r => r.id)).toEqual(['mine']);
  });

  it('their property is not in your net worth', () => {
    expect(calculateNetWorth().property).toBe(1_000_000);
  });

  it('their property does not block a loan for you', () => {
    useStore.setState({
      properties: [...useStore.getState().properties.map(p =>
        p.id === 'theirs' ? { ...p, loan_id: 'l1' } : p)],
    } as any);
    // 'l1' is only taken as far as the OTHER user is concerned; scoping the
    // property list to this user is what keeps their data out of your picker.
    expect(propertiesDS.availableLoans('mine').map(l => l.id)).toEqual(['l1']);
  });

  it('their super fund is not offered as a place to hold your property', () => {
    useStore.setState({ superFunds: [superFund({ id: 's9', user_id: OTHER, fund_name: 'Theirs' })] } as any);
    expect(propertiesDS.availableFunds()).toEqual([]);
    // Super funds are in the store and already user-scoped, so pointing at
    // theirs is indistinguishable from pointing at one that never existed.
    expect(propertiesDS.validate(validDraft({ held_by: 'smsf', super_fund_id: 's9' }), null))
      .toEqual(['That fund no longer exists.']);
  });

  it('a signed-out picker offers nothing rather than everything', () => {
    // No fund list loaded and no funds in the store → the SMSF option can't be used.
    propertyFundsDS.reset();
    useStore.setState({ superFunds: [] } as any);
    expect(propertiesDS.availableFunds()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 4.3 — performance, end to end
// ═════════════════════════════════════════════════════════════════════════════
//
// The engine proves the arithmetic. These prove the wiring: that rent really is
// the user's own transactions rather than a figure stored on the property, that
// money moving anywhere in Ledger reaches the yield, and that none of it touches
// net worth or crosses users.

const AS_OF = '2026-08-18';

const txn = (o: Partial<Transaction> = {}): Transaction => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  user_id: ME, account_id: 'acct-everyday', account_type: 'bank',
  date: '2026-08-01', merchant: 'RAY WHITE RENTAL', amount: 2_500,
  currency: 'AUD', category: 'Rent',
  is_duplicate_flagged: false, is_subscription: false,
  ...o,
});

/** Twelve monthly rents, the 1st of each month, ending 2026-08-01. */
const rentYear = (amount = 2_500, o: Partial<Transaction> = {}): Transaction[] => {
  const out: Transaction[] = [];
  for (let i = 0; i < 12; i++) {
    const month = 9 + i;
    const year = month <= 12 ? 2025 : 2026;
    const mm = String(month <= 12 ? month : month - 12).padStart(2, '0');
    out.push(txn({ id: `rent-${i}`, date: `${year}-${mm}-01`, amount, ...o }));
  }
  return out;
};

const investment = (o: Partial<Property> = {}) => property({
  property_type: 'investment', match_terms: ['ray white'], ...o,
});

const row = () => propertyReportDS.build(AS_OF).rows[0];

describe('rent and expenses come from the transactions already in Ledger', () => {
  it('a property earns from the user\'s own transactions, with nothing stored on it', () => {
    seed({ properties: [investment()], transactions: rentYear() });
    const p = row().performance;

    expect(p.annualRent).toBe(30_000);
    expect(p.grossYield).toBe(3);
    // Nothing about the rent was written to the property — the stored row has no
    // idea what it earns, which is why correcting a transaction corrects the yield.
    expect(Object.keys(useStore.getState().properties[0])).not.toContain('rental_income');
  });

  it('a transaction landing from a sync moves the yield immediately', () => {
    seed({ properties: [investment()], transactions: rentYear() });
    expect(row().performance.expensesPaid).toBe(0);

    // A Basiq sync / statement import replaces the list wholesale.
    useStore.setState({
      transactions: [
        ...rentYear(),
        txn({ id: 'rates', date: '2026-07-20', merchant: 'RAY WHITE OUTGOINGS', amount: -6_000, category: 'Bills' }),
      ],
    } as any);

    const p = row().performance;
    expect(p.expensesPaid).toBe(6_000);
    expect(p.netYield).toBe(2.4);
    expect(p.expensesByCategory).toEqual([{ category: 'Bills', amount: 6_000, count: 1 }]);
  });

  it('and so does one the user types in by hand', () => {
    seed({ properties: [investment()], transactions: rentYear() });
    transactionsDS.add({
      account_id: 'acct-everyday', account_type: 'bank', date: '2026-06-10',
      merchant: 'RAY WHITE SMOKE ALARMS', amount: -300, currency: 'AUD', category: 'Bills',
      is_duplicate_flagged: false, is_subscription: false,
    } as any);

    expect(row().performance.expensesPaid).toBe(300);
  });

  it('claiming a transaction does not take it away from anything else', () => {
    seed({ properties: [investment()], transactions: rentYear() });
    // It is still an ordinary transaction: budgets, spend-by-category and the
    // account list go on seeing exactly what they saw before.
    expect(transactionsDS.getAll()).toHaveLength(12);
    expect(useStore.getState().transactions.every(t => !('property_id' in t))).toBe(true);
  });

  it('a property with no match rules claims nothing, and says so rather than reporting zero', () => {
    seed({ properties: [investment({ match_terms: [], match_account_ids: [] })], transactions: rentYear() });
    const p = row().performance;

    expect(p.matched).toBe(false);
    expect(p.annualRent).toBe(0);
    expect(p.grossYield).toBeNull();
  });

  it('two properties never both count the same rent', () => {
    seed({
      properties: [
        investment({ id: 'p-broad', name: 'Broad', match_terms: ['white'] }),
        investment({ id: 'p-exact', name: 'Exact', match_terms: ['ray white rental'] }),
      ],
      transactions: rentYear(),
    });
    const { rows, totals } = propertyReportDS.build(AS_OF);

    expect(rows.find(r => r.id === 'p-exact')!.performance.annualRent).toBe(30_000);
    expect(rows.find(r => r.id === 'p-broad')!.performance.annualRent).toBe(0);
    expect(totals.annualRent).toBe(30_000);
  });
});

describe('the mortgage in cash flow', () => {
  it('is the linked loan\'s schedule, and follows an edit made on the Loans page', () => {
    seed({
      properties: [investment({ loan_id: 'l1' })],
      loans: [loan({ minimum_repayment: 3_000, repayment_frequency: 'monthly' })],
      transactions: rentYear(),
    });
    expect(row().performance.annualCashFlow).toBe(-6_000);   // 30,000 − 36,000

    loansDS.update('l1', { minimum_repayment: 2_000 });
    expect(row().performance.annualMortgage).toBe(24_000);
    expect(row().performance.monthlyCashFlow).toBe(500);
  });

  it('drops out when the loan is deleted, along with the link', () => {
    seed({
      properties: [investment({ loan_id: 'l1' })],
      loans: [loan({ minimum_repayment: 3_000 })],
      transactions: rentYear(),
    });
    loansDS.remove('l1');

    const r = row();
    expect(r.loan).toBeNull();
    expect(r.performance.annualMortgage).toBe(0);
    expect(r.performance.annualCashFlow).toBe(30_000);
  });

  it('never counts a repayment twice — the schedule OR the transaction, not both', () => {
    seed({
      properties: [investment({ loan_id: 'l1' })],
      loans: [loan({ minimum_repayment: 3_000 })],
      transactions: [
        ...rentYear(),
        txn({ id: 'repay', account_type: 'loan', merchant: 'RAY WHITE MORTGAGE', amount: -3_000, category: 'Bills' }),
      ],
    });
    const p = row().performance;

    expect(p.expensesPaid).toBe(0);
    expect(p.annualMortgage).toBe(36_000);
    expect(p.annualCashFlow).toBe(-6_000);
  });
});

describe('performance and the rest of the app', () => {
  it('rent and expenses change nothing about net worth', () => {
    const props = [investment({ loan_id: 'l1' })];
    seed({ properties: props, loans: [loan({ minimum_repayment: 3_000 })] });
    const before = calculateNetWorth();

    seed({
      properties: props,
      loans: [loan({ minimum_repayment: 3_000 })],
      transactions: [...rentYear(), txn({ id: 'e', amount: -6_000, merchant: 'RAY WHITE FEES', category: 'Bills' })],
    });
    const after = calculateNetWorth();

    expect(after.net_worth).toBe(before.net_worth);
    expect(after.property).toBe(before.property);
    // The rent is already in the bank balance the accounts report; adding it to
    // the property as well would count the same dollar twice.
    expect(propertyReportDS.build(AS_OF).totals.netWorthEffect).toBe(400_000);
  });

  it('revaluing the property moves the yield without a transaction changing', () => {
    seed({ properties: [investment()], transactions: rentYear() });
    expect(row().performance.grossYield).toBe(3);

    propertiesDS.update('p1', { current_value: 1_500_000 });
    expect(row().performance.grossYield).toBe(2);
  });

  it('a half share yields on half a house, and the rent is not halved with it', () => {
    seed({ properties: [investment({ ownership_percent: 50 })], transactions: rentYear() });
    const p = row().performance;

    expect(p.annualRent).toBe(30_000);   // what actually reached the account
    expect(p.grossYield).toBe(6);        // against the 500,000 the user owns
  });

  it('never counts another user\'s money as this property\'s rent', () => {
    seed({
      properties: [investment()],
      transactions: [...rentYear(), txn({ id: 'theirs', user_id: OTHER, amount: 99_000, date: '2026-08-02' })],
    });
    expect(row().performance.annualRent).toBe(30_000);
  });
});

describe('match rules persist', () => {
  it('are sent with the property, so the other device claims the same transactions', () => {
    propertiesDS.add(draft({ match_terms: ['Ray White', 'Waverley Council'], match_account_ids: ['acct-ip'] }));

    expect(kinds()).toContain('property.create');
    expect(payloadOf('property.create').data.match_terms).toEqual(['Ray White', 'Waverley Council']);
    expect(payloadOf('property.create').data.match_account_ids).toEqual(['acct-ip']);
  });

  it('a property saved before this phase sends empty rules rather than nothing', () => {
    seed({ properties: [property()] });
    propertiesDS.update('p1', { current_value: 1_200_000 });

    expect(payloadOf('property.update').data.match_terms).toEqual([]);
    expect(payloadOf('property.update').data.match_account_ids).toEqual([]);
  });

  it('clearing the last term actually clears it, instead of leaving the old rule behind', () => {
    seed({ properties: [investment()], transactions: rentYear() });
    propertiesDS.update('p1', { match_terms: [] });

    expect(payloadOf('property.update').data.match_terms).toEqual([]);
    expect(row().performance.annualRent).toBe(0);
    expect(row().performance.matched).toBe(false);
  });

  it('survive a reload — the yield is the same on the next device', () => {
    const added = propertiesDS.add(draft({
      property_type: 'investment', match_terms: ['ray white'], current_value: 1_000_000,
    }));

    // What the other device gets back from the server, replayed into a fresh store.
    seed({
      properties: [{ ...(payloadOf('property.create').data as any), id: added.id, user_id: ME }],
      transactions: rentYear(),
    });

    expect(row().performance.annualRent).toBe(30_000);
    expect(row().performance.grossYield).toBe(3);
  });

  it('a term too short to mean anything is refused before it can claim the statement', () => {
    expect(propertiesDS.validate(validDraft({ match_terms: ['a'] }), null))
      .toEqual(['Match text must be at least 3 characters — "a" is too broad.']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rent rules, end to end
// ═════════════════════════════════════════════════════════════════════════════
//
// The engine proves which credits are rent. These prove that the answer is the
// user's own — that it is written, replayed and cleared through the real data
// service, so a rule set on one device recognises the same rent on the next.

/** An investment property with its rent rules filled in, as the modal saves them. */
const letProperty = (o: Partial<Property> = {}) => investment({
  match_terms: [],
  rent_match_terms: ['Ray White'],
  rent_account_id: 'acct-everyday',
  expected_rent_amount: 2_500,
  expected_rent_frequency: 'monthly',
  ...o,
});

describe('rent rules persist', () => {
  it('are sent with the property, so the other device recognises the same rent', () => {
    propertiesDS.add(draft(letProperty()));

    const sent = payloadOf('property.create').data;
    expect(sent.rent_match_terms).toEqual(['Ray White']);
    expect(sent.rent_account_id).toBe('acct-everyday');
    expect(sent.expected_rent_amount).toBe(2_500);
    expect(sent.expected_rent_frequency).toBe('monthly');
  });

  it('a property saved before this refinement sends empty rent rules, not nothing', () => {
    seed({ properties: [property()] });
    propertiesDS.update('p1', { current_value: 1_200_000 });

    const sent = payloadOf('property.update').data;
    expect(sent.rent_match_terms).toEqual([]);
    expect(sent.rent_account_id).toBeNull();
    expect(sent.expected_rent_amount).toBeNull();
    expect(sent.expected_rent_frequency).toBeNull();
  });

  it('survive a reload — the same rent is matched on the next device', () => {
    const added = propertiesDS.add(draft(letProperty({ current_value: 1_000_000 })));

    seed({
      properties: [{ ...(payloadOf('property.create').data as any), id: added.id, user_id: ME }],
      transactions: rentYear(),
    });

    const p = row().performance;
    expect(p.rentMode).toBe('rules');
    expect(p.annualRent).toBe(30_000);
    expect(p.grossYield).toBe(3);
    expect(p.rentVsExpectedPercent).toBe(100);
  });

  it('turning a rental back into a home CLEARS them, so the rent can\'t keep matching', () => {
    seed({ properties: [letProperty()], transactions: rentYear() });
    expect(row().performance.annualRent).toBe(30_000);

    // What the modal saves for an owner-occupied property: the rent half of the
    // form is hidden, and the rules behind it are wiped rather than left stored.
    propertiesDS.update('p1', {
      property_type: 'home',
      rent_match_terms: [], rent_account_id: null,
      expected_rent_amount: null, expected_rent_frequency: null,
    });

    const sent = payloadOf('property.update').data;
    expect(sent.rent_match_terms).toEqual([]);
    expect(sent.expected_rent_amount).toBeNull();

    const p = row().performance;
    expect(p.rentMode).toBe('off');
    expect(p.annualRent).toBe(0);
    expect(p.grossYield).toBeNull();
  });

  it('a rent payer too short to mean anyone is refused before it can claim the statement', () => {
    expect(propertiesDS.validate(validDraft({ property_type: 'investment', rent_match_terms: ['rw'] }), null))
      .toEqual(['The rent payer must be at least 3 characters — "rw" is too broad.']);
  });

  it('an expected rent with no cycle is refused, since it can\'t be read as a year', () => {
    expect(propertiesDS.validate(validDraft({ property_type: 'investment', expected_rent_amount: 800 }), null))
      .toEqual(['Choose how often that rent arrives.']);
  });
});

describe('an owner-occupied home, through the store', () => {
  it('reports its costs and no income, whatever lands in the account', () => {
    seed({
      properties: [property({ match_terms: ['ray white', 'waverley council'] })],
      transactions: [
        ...rentYear(),
        txn({ id: 'rates', date: '2026-02-01', merchant: 'WAVERLEY COUNCIL RATES', amount: -1_200, category: 'Bills' }),
      ],
    });

    const p = row().performance;
    expect(p.rentMode).toBe('off');
    expect(p.isIncomeProducing).toBe(false);
    expect(p.grossYield).toBeNull();
    // The rent credits were claimed by the expense rule, so they read as money
    // coming back against the rates — never as income for a house lived in.
    expect(p.refunds).toBe(30_000);
    expect(p.expensesPaid).toBe(-28_800);
  });

  it('and the portfolio does not count it among the rented ones', () => {
    seed({
      properties: [property({ id: 'p-home', match_terms: ['ray white'] }), letProperty({ id: 'p-inv' })],
      transactions: rentYear(),
    });

    const { totals } = propertyReportDS.build(AS_OF);
    expect(totals.rented).toBe(1);
    expect(totals.annualRent).toBe(30_000);
  });
});

describe('the rent suggestions come from the real transaction list', () => {
  it('offers the payer the user can point at, taken from what already arrived', () => {
    seed({ properties: [letProperty()], transactions: rentYear() });

    const suggestions = suggestRentPayers(useStore.getState().transactions, { asOf: AS_OF });
    expect(suggestions[0].term).toBe('ray white rental');
    expect(suggestions[0].label).toBe('RAY WHITE RENTAL');
    expect(suggestions[0].payments).toBe(12);
    expect(suggestions[0].accountId).toBe('acct-everyday');
  });

  it('and rent still never touches net worth', () => {
    seed({
      properties: [letProperty()],
      accounts: [{ id: 'acct-everyday', user_id: ME, name: 'Everyday', balance: 5_000, currency: 'AUD', include_in_net_worth: true } as any],
      transactions: rentYear(),
    });
    const withRent = calculateNetWorth();

    seed({
      properties: [letProperty()],
      accounts: [{ id: 'acct-everyday', user_id: ME, name: 'Everyday', balance: 5_000, currency: 'AUD', include_in_net_worth: true } as any],
      transactions: [],
    });
    expect(calculateNetWorth().net_worth).toBe(withRent.net_worth);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Expenses set up one cost at a time
// ═════════════════════════════════════════════════════════════════════════════

const strataRule = (o: Partial<PropertyExpenseRule> = {}): PropertyExpenseRule => ({
  id: 'r-strata', name: 'Strata', kind: 'strata',
  expected_amount: 1_100, frequency: 'quarterly',
  account_id: null, whole_account: false, match_terms: ['strata plus'],
  ...o,
});

const levy = (id: string, date: string, amount = -1_100) =>
  txn({ id, date, merchant: 'STRATA PLUS', amount, category: 'Bills' });

describe('expense rules persist', () => {
  it('are sent whole with the property, so the other device recognises the same bills', () => {
    propertiesDS.add(draft(investment({ property_expenses: [strataRule()], match_terms: [] })));

    const sent = payloadOf('property.create').data;
    expect(sent.property_expenses).toEqual([strataRule()]);
    // The legacy fields still travel — as empty arrays, which is what clears them.
    expect(sent.match_terms).toEqual([]);
    expect(sent.match_account_ids).toEqual([]);
  });

  it('keep every field the form can set, including the ones the old schema dropped', () => {
    // The complaint this covers: choices made in the form were gone on reopening.
    // The columns were missing server-side, so the write was accepted with them
    // silently stripped and the next refresh handed back a row without them.
    // Everything the editor can set is asserted here, whole, in both directions.
    const full = {
      id: 'pex_1', name: 'Strata', kind: 'strata' as const,
      expected_amount: 1_100, frequency: 'quarterly' as const,
      account_id: 'acct-offset', whole_account: true, match_terms: ['strata plus'],
    };
    seed({ properties: [investment({ match_terms: [] })] });
    propertiesDS.update('p1', { property_expenses: [full], excluded_transaction_ids: ['t-9'] });

    expect(payloadOf('property.update').data.property_expenses).toEqual([full]);
    // And read back the way the modal reads it when it reopens.
    const reopened = useStore.getState().properties[0];
    expect(reopened.property_expenses).toEqual([full]);
    expect(reopened.excluded_transaction_ids).toEqual(['t-9']);
  });

  it('a property saved before them sends an empty list, not nothing', () => {
    seed({ properties: [property()] });
    propertiesDS.update('p1', { current_value: 1_200_000 });

    const sent = payloadOf('property.update').data;
    expect(sent.property_expenses).toEqual([]);
    expect(sent.excluded_transaction_ids).toEqual([]);
  });

  it('survive a reload — the same bills are matched on the next device', () => {
    const added = propertiesDS.add(draft(investment({
      property_expenses: [strataRule()], match_terms: [], current_value: 1_000_000,
    })));

    seed({
      properties: [{ ...(payloadOf('property.create').data as any), id: added.id, user_id: ME }],
      transactions: [levy('q1', '2025-09-15'), levy('q2', '2025-12-15'), levy('q3', '2026-03-15')],
    });

    const p = row().performance;
    expect(p.expensesPaid).toBe(3_300);
    expect(p.expensesByRule[0]).toMatchObject({ name: 'Strata', count: 3, expectedAnnual: 4_400 });
  });

  it('deleting the last cost really clears it rather than leaving the old one matching', () => {
    seed({ properties: [investment({ property_expenses: [strataRule()], match_terms: [] })] });
    propertiesDS.update('p1', { property_expenses: [] });

    expect(payloadOf('property.update').data.property_expenses).toEqual([]);
    seed({
      properties: [{ ...useStore.getState().properties[0] }],
      transactions: [levy('q1', '2026-03-15')],
    });
    expect(row().performance.expensesPaid).toBe(0);
  });

  it('and a cost with no name is refused before it can be saved', () => {
    expect(propertiesDS.validate(
      validDraft({ property_expenses: [strataRule({ name: '' })] }), null,
    )).toContain('Give every expense a name — "Strata", "Council rates", "Water".');
  });
});

describe('a payment the user takes back off a property', () => {
  it('is remembered by id, so the correction survives the next device', () => {
    seed({ properties: [letProperty()], transactions: rentYear() });
    propertiesDS.update('p1', { excluded_transaction_ids: ['rent-11'] });

    expect(payloadOf('property.update').data.excluded_transaction_ids).toEqual(['rent-11']);
    expect(row().performance.rentPayments).toBe(11);
    // The rent a year is what was AGREED, so taking one payment off doesn't
    // change it — what changes is the rent that actually banked.
    expect(row().performance.bankedAnnualRent).toBe(27_500);
  });

  it('leaves the transaction itself exactly where it was', () => {
    seed({ properties: [letProperty()], transactions: rentYear() });
    propertiesDS.update('p1', { excluded_transaction_ids: ['rent-11'] });

    // Still in Ledger, still the user's money, still counted everywhere else —
    // it simply isn't this property's.
    expect(useStore.getState().transactions.find(t => t.id === 'rent-11')).toBeTruthy();
    expect(mockedSync.mock.calls.some(c => String(c[0]).startsWith('transaction.'))).toBe(false);
  });

  it('and putting it back counts it again', () => {
    seed({ properties: [letProperty({ excluded_transaction_ids: ['rent-11'] })], transactions: rentYear() });
    expect(row().performance.rentPayments).toBe(11);

    propertiesDS.update('p1', { excluded_transaction_ids: [] });
    expect(row().performance.rentPayments).toBe(12);
  });
});

describe('the same rent, reaching Ledger twice', () => {
  it('is counted once — the bank\'s copy, not the one entered by hand', () => {
    seed({
      properties: [letProperty()],
      transactions: [
        ...rentYear().slice(0, 11),
        txn({ id: 'mine', date: '2026-08-01', amount: 2_500, source: 'manual' }),
        txn({ id: 'bank', date: '2026-08-01', amount: 2_500, source: 'basiq', source_ref: 'b-991' }),
      ],
    });

    const p = row().performance;
    expect(p.rentPayments).toBe(12);
    expect(p.annualRent).toBe(30_000);
    expect(p.payments.some(line => line.id === 'mine')).toBe(false);
  });

  it('and a manual entry already reconciled against its bank twin is not a payment at all', () => {
    seed({
      properties: [letProperty()],
      transactions: [
        ...rentYear(),
        txn({ id: 'twin', date: '2026-08-01', amount: 2_500, source: 'manual', reconcile_state: 'conflict' }),
      ],
    });
    expect(row().performance.annualRent).toBe(30_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 4.5 — the portfolio overview, through the store
// ═════════════════════════════════════════════════════════════════════════════
//
// The engine proves the arithmetic. What it cannot prove without the store is
// that the overview is reading LIVE data: a repayment recorded on the Loans page
// has to move the portfolio LVR here, another user's house must never be in the
// totals, and the portfolio's own view of net worth has to agree with the figure
// calculateNetWorth arrives at independently.
describe('the portfolio overview', () => {
  const mixed = () => [
    property({ id: 'p-home', current_value: 1_200_000, loan_id: 'l-home' }),
    investment({ id: 'p-let', current_value: 800_000, loan_id: 'l-let' }),
    investment({ id: 'p-half', current_value: 600_000, ownership_percent: 50, match_terms: ['harcourts'] }),
    property({
      id: 'p-smsf', property_type: 'investment', current_value: 500_000,
      held_by: 'smsf', super_fund_id: 's1', counted_in_fund_balance: true, match_terms: ['jellis'],
    }),
  ];
  const mixedLoans = () => [
    loan({ id: 'l-home', name: 'Home mortgage', current_balance: 700_000, minimum_repayment: 4_000 }),
    loan({ id: 'l-let', name: 'Investment mortgage', current_balance: 500_000, minimum_repayment: 3_000 }),
  ];
  const seedMixed = (transactions: Transaction[] = []) => seed({
    properties: mixed(), loans: mixedLoans(), superFunds: [superFund({ balance: 1_500_000 })], transactions,
  });

  it('summarises a mixed portfolio: a home, two rentals and an SMSF flat', () => {
    seedMixed(rentYear());
    const { rows, totals } = propertyReportDS.build(AS_OF);

    expect(rows).toHaveLength(4);
    expect(totals.count).toBe(4);
    expect(totals.ownedValue).toBe(2_800_000);
    expect(totals.debt).toBe(1_200_000);
    expect(totals.equity).toBe(1_600_000);
    expect(totals.lvr).toBe(42.86);
    expect(totals.mortgaged).toBe(2);
    expect(totals.annualRent).toBe(30_000);
    expect(totals.annualMortgage).toBe(84_000);
    expect(totals.rented).toBe(1);
  });

  it('the LVR follows a repayment made on the Loans page', () => {
    seedMixed();
    expect(propertyReportDS.build(AS_OF).totals.lvr).toBe(42.86);

    loansDS.update('l-home', { current_balance: 300_000 });
    const { totals } = propertyReportDS.build(AS_OF);
    expect(totals.debt).toBe(800_000);
    expect(totals.lvr).toBe(28.57);            // 800,000 / 2,800,000
    expect(totals.equity).toBe(2_000_000);
  });

  it('and a revaluation moves it the other way', () => {
    seedMixed();
    propertiesDS.update('p-home', { current_value: 1_500_000 });
    const { totals } = propertyReportDS.build(AS_OF);
    expect(totals.ownedValue).toBe(3_100_000);
    expect(totals.lvr).toBe(38.71);
  });

  it('the portfolio and net worth agree about the SMSF flat without either counting it twice', () => {
    seedMixed();
    const { totals } = propertyReportDS.build(AS_OF);
    const nw = calculateNetWorth();

    expect(totals.countedInFunds).toBe(500_000);      // the fund is carrying it
    expect(totals.netWorthValue).toBe(2_300_000);     // so the property line leaves it out
    expect(nw.property).toBe(2_300_000);              // …and that is exactly what net worth used
    expect(nw.super).toBe(1_500_000);                 // the flat is in here, once
  });

  it('a property switched out of net worth is still in the portfolio it belongs to', () => {
    seedMixed();
    propertiesDS.update('p-half', { include_in_net_worth: false });
    const { totals } = propertyReportDS.build(AS_OF);

    expect(totals.ownedValue).toBe(2_800_000);        // still owned
    expect(totals.equity).toBe(1_600_000);            // still equity
    expect(totals.excludedFromNetWorth).toBe(300_000);
    expect(totals.netWorthValue).toBe(2_000_000);
    expect(calculateNetWorth().property).toBe(2_000_000);
  });

  it('another user\'s property is in nobody else\'s portfolio', () => {
    seed({
      properties: [property({ id: 'mine', current_value: 1_000_000 }), property({ id: 'theirs', user_id: OTHER, current_value: 9_000_000 })],
    });
    const { rows, totals } = propertyReportDS.build(AS_OF);
    expect(rows.map(r => r.id)).toEqual(['mine']);
    expect(totals.ownedValue).toBe(1_000_000);
  });

  it('an empty portfolio has no gearing to quote', () => {
    seed();
    const { totals } = propertyReportDS.build(AS_OF);
    expect(totals.count).toBe(0);
    expect(totals.lvr).toBeNull();
    expect(totals.mortgaged).toBe(0);
  });
});
