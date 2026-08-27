/**
 * The server's net worth, over the whole thing, against the SAME cases the
 * client engine is held to.
 *
 * There are two implementations of this arithmetic — `netWorthFrom` in the
 * browser and `computeNetWorth` here — and the failure that matters is not
 * either one being wrong on its own. It is the two being right about different
 * things: the headline a user reads comes from the first, the trend line and the
 * "what's driving your net worth" breakdown come from the second, and when they
 * sit on different bases, subtracting them produces a movement no item can
 * account for.
 *
 * So the numbers below are written out, and the mirror of each is written out in
 * `frontend/src/stress/netWorthStabilitySim.test.ts` and
 * `frontend/src/utils/property.test.ts`. A change to either engine that moves an
 * answer fails on its own side, loudly, instead of quietly opening a gap.
 *
 * Covers the three things the net-worth audit found the two tiers disagreeing
 * about (see the memory note): an SMSF-held property, a mortgage behind two
 * houses, and foreign cash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;
const db = new Map<string, Row[]>();
const tableOf = (name: string): Row[] => {
  if (!db.has(name)) db.set(name, []);
  return db.get(name)!;
};

class FakeQuery {
  private eqs: [string, unknown][] = [];
  constructor(private table: string) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  order() { return this; }
  limit() { return this; }
  private rows(): Row[] {
    return tableOf(this.table).filter(r => this.eqs.every(([c, v]) => r[c] === v));
  }
  single() {
    const rows = this.rows();
    return Promise.resolve(rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } });
  }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => void) { resolve({ data: this.rows(), error: null }); }
}

vi.mock('../utils/supabase', () => ({
  supabase: { from: (table: string) => new FakeQuery(table) },
  getSupabase: () => { throw new Error('not used here'); },
  upsertTolerant: () => { throw new Error('not used here'); },
}));

/** One fixed rate, so a difference in the ANSWER is never a difference in the
 *  quote. The rate rules themselves are tested in investmentValue.test.ts. */
const RATE: Record<string, number> = { USD: 1.52, AUD: 1 };
vi.mock('./currencyService', () => ({
  convertAmount: (amount: number, from: string) =>
    Promise.resolve({ converted: parseFloat((amount * (from === 'USD' ? 1.52 : 1)).toFixed(2)), rate: from === 'USD' ? 1.52 : 1 }),
  convertBalance: (amount: number, from: string) =>
    Promise.resolve({ converted: parseFloat((amount * (from === 'USD' ? 1.52 : 1)).toFixed(2)), rate: from === 'USD' ? 1.52 : 1 }),
  getRate: (from: string) => Promise.resolve(from === 'USD' ? 1.52 : 1),
}));

import { computeNetWorth } from './netWorthSnapshot';

const USER = 'u-agree';

interface World {
  accounts?: Row[];
  investments?: Row[];
  creditCards?: Row[];
  superFunds?: Row[];
  smsfFunds?: Row[];
  smsfAssets?: Row[];
  loans?: Row[];
  properties?: Row[];
}

function seed(w: World): void {
  db.clear();
  tableOf('users').push({ id: USER, currency_preference: 'AUD' });
  const put = (table: string, rows: Row[] = []) => {
    for (const r of rows) tableOf(table).push({ user_id: USER, ...r });
  };
  put('bank_accounts', w.accounts);
  put('investments', w.investments);
  put('credit_cards', w.creditCards);
  put('super_funds', w.superFunds);
  put('smsf_funds', w.smsfFunds);
  put('smsf_assets', w.smsfAssets);
  put('loans', w.loans);
  put('properties', w.properties);
}

const house = (o: Row = {}): Row => ({
  id: 'p-home', name: 'Home', current_value: 1_000_000, ownership_percent: 100,
  held_by: 'personal', include_in_net_worth: true, loan_id: null, ...o,
});
const mortgage = (o: Row = {}): Row => ({
  id: 'm1', name: 'Mortgage', current_balance: 800_000, include_in_net_worth: true, ...o,
});

beforeEach(() => { db.clear(); });

// ═════════════════════════════════════════════════════════════════════════════
//  The whole sum reconciles to its own parts
// ═════════════════════════════════════════════════════════════════════════════

describe('the breakdown the server reports', () => {
  it('adds up to the net worth it reports', async () => {
    seed({
      accounts: [{ id: 'a1', name: 'Everyday', balance: 18_400, currency: 'AUD' }],
      creditCards: [{ id: 'c1', name: 'Amex', balance_owing: 4_210.55, currency: 'AUD' }],
      superFunds: [{ id: 's1', fund_name: 'Super', balance: 386_500, include_in_net_worth: true }],
      loans: [mortgage()],
      properties: [house({ loan_id: 'm1' })],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.bankBalance + nw.investments + nw.super + nw.property
      - nw.creditCardDebt - nw.loans).toBeCloseTo(nw.netWorth, 2);
    expect(nw.netWorth).toBeCloseTo(18_400 + 386_500 + 1_000_000 - 4_210.55 - 800_000, 2);
  });

  it('and the items it lists add up to it too', async () => {
    seed({
      accounts: [{ id: 'a1', name: 'Everyday', balance: 5_000, currency: 'AUD' }],
      superFunds: [{ id: 's1', fund_name: 'Super', balance: 100_000, include_in_net_worth: true }],
      smsfFunds: [{ id: 'f1', name: 'Family SMSF', include_in_net_worth: true }],
      smsfAssets: [{ fund_id: 'f1', amount: 900_000 }],
      loans: [mortgage({ current_balance: 200_000 })],
      properties: [house({ loan_id: 'm1' })],
    });
    const nw = await computeNetWorth(USER);
    const fromItems = nw.items.reduce((t, i) => t + (i.is_debt ? -i.value : i.value), 0);
    expect(fromItems).toBeCloseTo(nw.netWorth, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  An SMSF-held property — counted exactly once, on this tier and the other
// ═════════════════════════════════════════════════════════════════════════════

describe('a property held in an SMSF', () => {
  const warehouse = (o: Row = {}): Row => house({
    id: 'p-smsf', name: 'Warehouse', current_value: 1_200_000, held_by: 'smsf',
    smsf_fund_id: 'f1', counted_in_fund_balance: true, ...o,
  });

  it('is counted by the fund and not again by the property', async () => {
    seed({
      smsfFunds: [{ id: 'f1', name: 'Family SMSF', include_in_net_worth: true }],
      smsfAssets: [{ fund_id: 'f1', amount: 1_200_000 }],
      properties: [warehouse()],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.super).toBe(1_200_000);
    expect(nw.property).toBe(0);
    expect(nw.netWorth).toBe(1_200_000);   // not 2,400,000
  });

  it('counts itself when the fund it names is not there', async () => {
    // The client's half of this was finding N3: it deferred to a fund it had no
    // slice for, so a $1.2m warehouse moved net worth by nothing at all. Both
    // engines now defer only to a fund they can actually resolve.
    seed({ properties: [warehouse({ smsf_fund_id: 'gone' })] });
    const nw = await computeNetWorth(USER);
    expect(nw.super).toBe(0);
    expect(nw.property).toBe(1_200_000);
    expect(nw.netWorth).toBe(1_200_000);   // counted once, by the property
  });

  it('leaves the whole arrangement out when the fund is switched off', async () => {
    // Deliberate, and the same on both tiers: switching a fund off is a decision
    // about the arrangement, not an instruction to re-home the house.
    seed({
      smsfFunds: [{ id: 'f1', name: 'Family SMSF', include_in_net_worth: false }],
      smsfAssets: [{ fund_id: 'f1', amount: 1_200_000 }],
      properties: [warehouse()],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.super).toBe(0);
    expect(nw.property).toBe(0);
  });

  it('counts an SMSF whose opt-out column has not landed yet', async () => {
    // FINDING L3. This filter was truthy, where every other opt-out in the file
    // reads a missing flag as INCLUDED — so on a deployment where the column is
    // still absent, every SMSF silently dropped out of net worth.
    seed({
      smsfFunds: [{ id: 'f1', name: 'Family SMSF' }],   // no include_in_net_worth
      smsfAssets: [{ fund_id: 'f1', amount: 750_000 }],
    });
    expect((await computeNetWorth(USER)).super).toBe(750_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One mortgage, two houses
// ═════════════════════════════════════════════════════════════════════════════

describe('a mortgage the loans term skips, behind two houses', () => {
  it('is subtracted once between them, not once each', async () => {
    // FINDING N4. The rule was asked per property and kept no record of what had
    // been netted, so the portfolio read one whole mortgage short.
    seed({
      loans: [mortgage({ include_in_net_worth: false })],
      properties: [
        house({ id: 'p1', loan_id: 'm1' }),
        house({ id: 'p2', loan_id: 'm1' }),
      ],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.loans).toBe(0);                      // the loans term skipped it
    expect(nw.property).toBe(2_000_000 - 800_000); // …so the property nets it, once
    expect(nw.netWorth).toBe(1_200_000);
  });

  it('and a house switched off does not use up the netting its neighbour needs', async () => {
    seed({
      loans: [mortgage({ include_in_net_worth: false })],
      properties: [
        house({ id: 'p-off', loan_id: 'm1', include_in_net_worth: false }),
        house({ id: 'p-on', loan_id: 'm1' }),
      ],
    });
    expect((await computeNetWorth(USER)).property).toBe(1_000_000 - 800_000);
  });

  it('and with the loan counted, the loans term does it and the property does not', async () => {
    seed({
      loans: [mortgage()],
      properties: [
        house({ id: 'p1', loan_id: 'm1' }),
        house({ id: 'p2', loan_id: 'm1' }),
      ],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.loans).toBe(800_000);
    expect(nw.property).toBe(2_000_000);
    expect(nw.netWorth).toBe(1_200_000);   // the same answer either way round
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Foreign cash
// ═════════════════════════════════════════════════════════════════════════════

describe('foreign cash and cards', () => {
  it('are converted, and on the basis the row was stamped at', async () => {
    // FINDING N5: this used a LIVE intraday quote while the screen showed the
    // rate stamped at the last fetch, so the recorded snapshot and the figure
    // the user was looking at sat on two bases. Both are the day's rate now.
    seed({
      accounts: [{ id: 'a1', name: 'US brokerage', balance: 25_000, currency: 'USD' }],
      creditCards: [{ id: 'c1', name: 'US card', balance_owing: 1_000, currency: 'USD' }],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.bankBalance).toBeCloseTo(25_000 * RATE.USD, 2);
    expect(nw.creditCardDebt).toBeCloseTo(1_000 * RATE.USD, 2);
    expect(nw.netWorth).toBeCloseTo(24_000 * RATE.USD, 2);
  });

  it('and a hidden account is out of the total, not converted into it', async () => {
    seed({
      accounts: [
        { id: 'a1', name: 'Everyday', balance: 1_000, currency: 'AUD' },
        { id: 'a2', name: 'Closed', balance: 90_000, currency: 'USD', hidden: true },
      ],
    });
    const nw = await computeNetWorth(USER);
    expect(nw.bankBalance).toBe(1_000);
    expect(nw.excludedItems).toContainEqual({ item_type: 'bank', item_id: 'a2' });
  });
});
