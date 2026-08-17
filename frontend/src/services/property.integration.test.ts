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
import type { Property, Loan, SuperFund } from '../types';

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
import { propertiesDS, propertyReportDS, propertyFundsDS, loansDS, calculateNetWorth } from './dataService';

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

function seed(opts: { properties?: Property[]; loans?: Loan[]; accounts?: any[]; superFunds?: SuperFund[] } = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com', currency_preference: 'AUD' } as any,
    properties: opts.properties ?? [],
    loans: opts.loans ?? [],
    accounts: opts.accounts ?? [],
    superFunds: opts.superFunds ?? [],
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
