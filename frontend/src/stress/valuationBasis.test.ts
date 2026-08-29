/**
 * ONE VALUATION BASIS — THE CLIENT'S HALF.
 *
 * A holding is worth `units × current price × FX`, rounded ONCE at the end. The
 * mirror of this file is `backend/src/services/netWorthValuationBasis.test.ts`,
 * and the four holdings below — and the figures expected of them — are written
 * out identically in both. That is the point: the Investments page, the live Net
 * Worth headline, the Overview tiles and the server's recorded snapshot history
 * are four separate implementations of the same sentence, and a change to any
 * one of them that moves an answer must fail on its own side, loudly, instead of
 * quietly opening a gap between the headline and the history behind it.
 *
 * Three of the four cases are ones where rounding the native value FIRST — the
 * `current_value × rate` basis both tiers used to sit on — gives a different
 * answer by a cent. Two of them are ones where the client and the server used to
 * disagree with each other.
 *
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as never as { localStorage: unknown; __mem: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(), key: () => null, get length() { return mem.size; },
  };
});

vi.mock('../services/syncQueue', () => ({
  syncWithRetry: vi.fn(), registerSyncSuccess: vi.fn(), retryPendingSync: vi.fn(),
}));

import { investmentsDS, calculateNetWorth, investmentValueInPreferred } from '../services/dataService';
import { useStore } from '../store';
import type { Investment } from '../types';

const U = 'u-basis';
const round2 = (x: number) => parseFloat(x.toFixed(2));

/** How the value used to be reached: the native stamp, rounded, then converted. */
const stampBasis = (units: number, price: number, rate: number) => round2(round2(units * price) * rate);

interface Case {
  id: string; name: string; units: number; price: number; rate: number; native: string;
  /** units × price × rate, rounded once. */ canonical: number;
  /** What the old `current_value × rate` produced for the same holding. */ stamp: number;
}

/** MIRRORED IN backend/src/services/netWorthValuationBasis.test.ts. */
const CASES: Case[] = [
  { id: 'i-usd', name: 'US tech', units: 634.4256, price: 211.97, rate: 1.7693, native: 'USD', canonical: 237_934.04, stamp: 237_934.03 },
  { id: 'i-gbp', name: 'UK insurer', units: 2151.37, price: 414.29, rate: 1.1676, native: 'GBP', canonical: 1_040_671.46, stamp: 1_040_671.47 },
  { id: 'i-usd2', name: 'US index', units: 2906.6596, price: 201.36, rate: 1.9774, native: 'USD', canonical: 1_157_342.51, stamp: 1_157_342.52 },
  { id: 'i-aud', name: 'ASX index', units: 4200, price: 96.31, rate: 1, native: 'AUD', canonical: 404_502, stamp: 404_502 },
];

/** A holding as the store holds it — stamp and all, exactly as the server sends it. */
const row = (c: Case, o: Partial<Investment> = {}): Investment => ({
  id: c.id, user_id: U, name: c.name, ticker: c.name, market: 'NYSE', asset_type: 'stock',
  shares_owned: c.units, current_price: c.price,
  // The stamp the price cron last wrote: the native value, rounded to cents.
  current_value: round2(c.units * c.price),
  cost_basis: 1, cost_basis_currency: 'AUD',
  currency: 'AUD', native_currency: c.native, conversion_rate: c.rate,
  is_dividend_paying: false, ...o,
} as never);

function seed(investments: Investment[]): void {
  useStore.setState({
    user: { id: U, email: 'basis@example.test', name: 'Basis', currency_preference: 'AUD' } as never,
    token: 'stress-token', dataOwnerId: U,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [], creditCards: [], transactions: [], loans: [], properties: [],
    superFunds: [], smsfFunds: [], investmentSales: [], recordShares: [],
    investments, netWorth: null, idMap: {}, pendingSyncQueue: [],
  } as never);
}

beforeEach(() => { seed(CASES.map(c => row(c))); });

// ═════════════════════════════════════════════════════════════════════════════

describe('what a holding is worth, on the client', () => {
  it('is units × price × rate, rounded once at the end', () => {
    for (const c of CASES) expect(investmentValueInPreferred(row(c))).toBe(c.canonical);
  });

  it('is NOT the native value rounded first and converted afterwards', () => {
    const differing = CASES.filter(c => stampBasis(c.units, c.price, c.rate) !== c.canonical);
    expect(differing.length).toBeGreaterThanOrEqual(3);
    for (const c of CASES) expect(stampBasis(c.units, c.price, c.rate)).toBe(c.stamp);
  });

  it('reads through a `current_value` stamp that has gone stale', () => {
    const c = CASES[0];
    // Half the units were sold and no price refresh has run since, so the stamp
    // still says what the whole holding used to be worth.
    expect(investmentValueInPreferred(row(c, { shares_owned: c.units / 2 } as never)))
      .toBe(round2((c.units / 2) * c.price * c.rate));
  });
});

describe('the three client screens', () => {
  it('the Investments page values each holding canonically', () => {
    const { investments } = investmentsDS.getAll();
    for (const c of CASES) {
      expect(investments.find(i => i.id === c.id)!.display_value).toBe(c.canonical);
    }
  });

  it('the portfolio total is the sum of those figures', () => {
    expect(investmentsDS.getAll().portfolio_total)
      .toBeCloseTo(CASES.reduce((t, c) => t + c.canonical, 0), 2);
  });

  it('the Net Worth headline carries the SAME investments term, to the cent', () => {
    const nw = calculateNetWorth();
    expect(nw.investments).toBeCloseTo(investmentsDS.getAll().portfolio_total, 2);
    expect(nw.investments).toBeCloseTo(CASES.reduce((t, c) => t + c.canonical, 0), 2);
  });

  it('and it is not the figure the old stamp basis produced', () => {
    const stampTotal = CASES.reduce((t, c) => t + c.stamp, 0);
    expect(CASES.reduce((t, c) => t + c.canonical, 0)).not.toBeCloseTo(stampTotal, 2);
    expect(calculateNetWorth().investments).not.toBeCloseTo(stampTotal, 2);
  });

  it('a sale the price refresh has not caught up with is worth what is LEFT', () => {
    const c = CASES[0];
    seed([row(c, { shares_owned: c.units / 2 } as never)]);
    const expected = round2((c.units / 2) * c.price * c.rate);
    expect(investmentsDS.getAll().portfolio_total).toBeCloseTo(expected, 2);
    expect(calculateNetWorth().investments).toBeCloseTo(expected, 2);
    // The stale stamp would have carried the sold half in net worth forever.
    expect(calculateNetWorth().investments).not.toBeCloseTo(c.canonical, 2);
  });
});
