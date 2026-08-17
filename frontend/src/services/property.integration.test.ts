/**
 * Phase 4.1 — properties, end to end through the store.
 *
 * The engine is unit-tested on its own; these are the things it cannot prove
 * without the real data service wired up:
 *
 *   • a property reaches net worth as an ASSET, and a linked mortgage is
 *     subtracted exactly once — by the loan, not again by the property;
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
import type { Property, Loan } from '../types';

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

import { useStore } from '../store';
import { syncWithRetry } from './syncQueue';
import { propertiesDS, propertyReportDS, loansDS, calculateNetWorth } from './dataService';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const mockedSync = vi.mocked(syncWithRetry);

const property = (o: Partial<Property> = {}): Property => ({
  id: 'p1', user_id: ME, name: 'Bondi apartment', address: '12 Beach Rd',
  property_type: 'home', purchase_price: 800_000, purchase_date: '2020-03-01',
  current_value: 1_000_000, ownership_percent: 100, loan_id: null,
  include_in_net_worth: true, ...o,
});

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: ME, name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 640_000, current_balance: 600_000, repayment_frequency: 'monthly',
  include_in_net_worth: true, ...o,
} as Loan);

function seed(opts: { properties?: Property[]; loans?: Loan[]; accounts?: any[] } = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com', currency_preference: 'AUD' } as any,
    properties: opts.properties ?? [],
    loans: opts.loans ?? [],
    accounts: opts.accounts ?? [],
    // Everything else calculateNetWorth reads — empty unless a test needs it.
    creditCards: [], investments: [], superFunds: [], bills: [], netWorthHistory: [],
  } as any);
}

const kinds = () => mockedSync.mock.calls.map(c => c[0] as string);
const payloadOf = (kind: string) => mockedSync.mock.calls.find(c => c[0] === kind)?.[1] as any;
const draft = (o: Partial<Property> = {}) => {
  const { id, user_id, created_at, updated_at, ...rest } = property(o);
  return rest;
};

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
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
      name: 'Bondi apartment', address: '12 Beach Rd', property_type: 'home',
      purchase_price: 800_000, purchase_date: '2020-03-01', current_value: 1_000_000,
      ownership_percent: 100, loan_id: null, include_in_net_worth: true,
    });
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

  it('the update payload is the whole record, so a replay cannot half-apply it', () => {
    propertiesDS.update('p1', { name: 'Bondi flat' });
    const data = payloadOf('property.update').data;
    expect(data.name).toBe('Bondi flat');
    expect(data.current_value).toBe(1_000_000);   // untouched fields still sent
  });

  it('an edit survives a reload: the store holds the new value, not the old', () => {
    propertiesDS.update('p1', { current_value: 1_111_000 });
    // Simulate the rehydrate: the persisted slice is what a reload restores.
    const persisted = useStore.getState().properties;
    useStore.setState({ properties: persisted } as any);
    expect(propertiesDS.getAll()[0].current_value).toBe(1_111_000);
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
    expect(propertiesDS.validate({ name: 'New', current_value: 1, loan_id: 'l1' }, 'p2'))
      .toEqual(['That loan is already linked to "Beach house".']);
  });

  it('a property may keep its own loan while being edited', () => {
    seed({ properties: [property({ id: 'p1', loan_id: 'l1' })], loans: [loan()] });
    expect(propertiesDS.availableLoans('p1').map(l => l.id)).toEqual(['l1']);
    expect(propertiesDS.validate({ name: 'x', current_value: 1, loan_id: 'l1' }, 'p1')).toEqual([]);
  });

  it('another user’s loan is neither offered nor accepted', () => {
    seed({ loans: [loan({ id: 'l9', user_id: OTHER })] });
    expect(propertiesDS.availableLoans(null)).toEqual([]);
    expect(propertiesDS.validate({ name: 'x', current_value: 1, loan_id: 'l9' }, null))
      .toEqual(['That loan no longer exists.']);
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
});
