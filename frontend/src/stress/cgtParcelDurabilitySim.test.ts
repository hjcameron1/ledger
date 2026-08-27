/**
 * PARCEL-BOOK DURABILITY STRESS TEST — the acquisition record leaves the browser.
 *
 * The capital-gains parcel book used to live in localStorage. It survived a
 * reload and nothing else: a second browser, a new phone or a cleared cache had
 * no book at all, so every sale silently fell back to the holding's AVERAGE cost
 * and one averaged date — which is the difference between a discounted gain and
 * an undiscounted one. Phase 5.7 puts parcels, splits and what each disposal
 * consumed in `cgt_parcels` / `cgt_splits` / `cgt_disposal_allocations`.
 *
 * This file drives the REAL services (investmentsDS, salesDS, cgtDS) against a
 * FAKE SERVER that mirrors the backend's contract — upsert by the client's own
 * id, replace a disposal's allocation as one set, delete by id — and then does
 * the things that used to lose the book:
 *
 *   • a fresh device with nothing in localStorage
 *   • a second device editing a parcel the first one recorded
 *   • a deletion on one device reaching the other
 *   • a split, a partial sale, and a reload between them
 *   • a local book adopted onto the server after the migration is run
 *   • the same adoption happening twice, and two devices adopting the same book
 *   • recording an older purchase AFTER a sale — which must not re-cost the sale
 *
 * Convention (as everywhere in this folder): assertions state correct behaviour
 * and are never weakened. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as never as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(), key: () => null, get length() { return mem.size; },
  };
});

/** The fake server's tables, plus the success handlers dataService registers. */
const bus = vi.hoisted(() => ({
  parcels: new Map<string, Record<string, unknown>>(),
  splits: new Map<string, Record<string, unknown>>(),
  allocations: new Map<string, Record<string, unknown>[]>(),
  opening: null as unknown,
  available: true,
  handlers: new Map<string, (srv: unknown, payload: Record<string, unknown>) => void>(),
  writes: [] as string[],
  idMap: new Map<string, string>(),
}));

// The sync layer, replaced by a server that answers immediately. Every write the
// app makes lands in `bus`, and the success handler dataService registered runs
// on the response — which is how the local→server id swap (and the parcel relink
// that follows it) is exercised rather than assumed.
vi.mock('../services/syncQueue', () => ({
  syncWithRetry: (kind: string, payload: Record<string, unknown>) => {
    bus.writes.push(kind);
    const response = applyToServer(kind, payload);
    if (response !== undefined) bus.handlers.get(kind)?.(response, payload);
  },
  registerSyncSuccess: (kind: string, fn: (srv: unknown, payload: Record<string, unknown>) => void) => {
    bus.handlers.set(kind, fn);
  },
  retryPendingSync: vi.fn(),
  retryPendingSyncNow: vi.fn(),
}));

import { investmentsDS, salesDS, cgtDS } from '../services/dataService';
import { useStore } from '../store';
import type { Investment, InvestmentSale } from '../types';

const USER = 'a1f0c2d4-1111-4bbb-8ccc-000000000001';

function newId(): string {
  return crypto.randomUUID();
}

/**
 * The backend's contract, in miniature: an upsert keyed by the id the CLIENT
 * minted, a delete by that id, and a disposal's allocation replaced whole. It is
 * written from the route handlers in backend/src/routes/investments.ts, not from
 * the client code under test.
 */
function applyToServer(kind: string, payload: Record<string, unknown>): unknown {
  const p = payload as {
    id?: string; recordId?: string; data?: Record<string, unknown>; sold?: boolean;
  };

  // The two writes that mint a new id server-side — the whole reason a parcel
  // has to follow its holding, and an allocation its disposal.
  if (kind === 'investment.create') {
    const local = useStore.getState().investments.find(i => i.id === p.recordId);
    if (!local) return undefined;
    const id = newId();
    bus.idMap.set(local.id, id);
    return { investment: { ...local, id } as Investment };
  }
  if (kind === 'sale.create') {
    const local = useStore.getState().investmentSales.find(r => r.id === p.recordId);
    if (!local) return undefined;
    const id = newId();
    bus.idMap.set(local.id, id);
    return { sale: { ...local, id } as InvestmentSale };
  }

  // The parcel book. Absent tables are the pre-migration state: the client must
  // not be sending anything at all, so reaching here is itself a failure.
  if (kind.startsWith('cgt')) {
    if (!bus.available) throw new Error(`wrote ${kind} while the cgt tables were absent`);
    switch (kind) {
      case 'cgtParcel.save':
        bus.parcels.set(String(p.data!.id), { ...p.data });
        return { parcel: { ...p.data } };
      case 'cgtParcel.delete':
        bus.parcels.delete(String(p.id));
        return { success: true };
      case 'cgtSplit.save':
        bus.splits.set(String(p.data!.id), { ...p.data });
        return { split: { ...p.data } };
      case 'cgtSplit.delete':
        bus.splits.delete(String(p.id));
        return { success: true };
      case 'cgtHolding.forget':
        for (const [id, row] of bus.parcels) if (row.investment_id === p.id) bus.parcels.delete(id);
        for (const [id, row] of bus.splits) if (row.investment_id === p.id) bus.splits.delete(id);
        return { success: true };
      case 'cgtAllocations.save': {
        const rows = ((p.data as { allocations?: Record<string, unknown>[] }).allocations ?? [])
          .map(a => ({ ...a, sale_id: String(p.id) }));
        if (rows.length === 0) bus.allocations.delete(String(p.id));
        else bus.allocations.set(String(p.id), rows);
        return { allocations: rows };
      }
      case 'cgtOpening.save':
        bus.opening = (p.data as { fy?: string })?.fy ? p.data : null;
        return { settings: p.data };
    }
  }
  return { ok: true };
}

/** What GET /investments/cgt would answer with right now. */
function serverPayload() {
  return {
    available: bus.available,
    parcels: [...bus.parcels.values()],
    splits: [...bus.splits.values()],
    allocations: [...bus.allocations.values()].flat(),
    opening: bus.opening as never,
  };
}

/** What bootstrapData does with that answer. */
function bootstrapCgt(): void {
  cgtDS.adopt(serverPayload());
}

/**
 * A device that has never seen this portfolio: the store still holds the
 * holdings and sales (they come from their own synced tables), and localStorage
 * — the entire parcel book as it used to be — is empty.
 */
function freshDevice(): void {
  localStorage.clear();
}

function seedUser(): void {
  useStore.setState({
    user: {
      id: USER, email: 'parcels@example.test', name: 'Perry Cell',
      currency_preference: 'AUD', theme: 'system', plan: 'premium',
      onboarding_complete: true,
    } as never,
    token: 'stress-token',
    dataOwnerId: USER,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [], creditCards: [], transactions: [], subscriptions: [],
    investments: [], investmentSales: [], superFunds: [], incomeEntries: [],
    bills: [], goals: [], goalContributions: [], loans: [], loanEvents: [],
    properties: [], insurancePolicies: [], insurancePremiumHistory: [],
    budgets: [], recordShares: [], shareCodes: [], recurringSeries: [],
    transactionSplits: [], creditCardStatements: [], pendingPayments: [],
    ccPaymentPrompts: [], alertStates: [], budgetSettings: null,
    budgetLines: [], customCategories: [], merchants: [], merchantAliases: [],
    transactionRules: [], billSubExclusions: [], hiddenCategories: [],
    selectedCategories: null, categoryAliases: {}, notifications: [],
    netWorth: null, netWorthHistory: [], idMap: {}, pendingSyncQueue: [],
    basiqUserId: null, portfolioTotal: 0,
  } as never);
  localStorage.clear();
}

/** Buy a holding, and answer with the id it ends up under (the server's). */
function buy(input: {
  name: string; ticker: string; units: number; cost: number; date: string; price?: number;
}): string {
  const rec = investmentsDS.add({
    name: input.name,
    ticker: input.ticker,
    market: 'ASX',
    asset_type: 'stock',
    shares_owned: input.units,
    cost_basis: input.cost,
    current_price: input.price ?? input.cost / input.units,
    native_currency: 'AUD',
    cost_basis_currency: 'AUD',
    conversion_rate: 1,
    acquired_date: input.date,
  });
  return bus.idMap.get(rec.id) ?? rec.id;
}

/** The Investments page's own sell path, in miniature: record it, then reduce it. */
function sell(input: {
  id: string; units: number; proceeds: number; fees?: number; date: string;
}): InvestmentSale {
  const inv = useStore.getState().investments.find(i => i.id === input.id)!;
  const fraction = input.units / inv.shares_owned;
  const sale = salesDS.record({
    investment_id: inv.id,
    name: inv.name,
    ticker: inv.ticker ?? null,
    asset_type: inv.asset_type,
    quantity: input.units,
    proceeds: input.proceeds,
    fees: input.fees ?? 0,
    // What the caller works out from the holding as a whole — the fallback the
    // parcels are supposed to override.
    cost_basis: parseFloat((inv.cost_basis * fraction).toFixed(2)),
    acquired_date: inv.acquired_date ?? null,
    sale_date: input.date,
    currency: 'AUD',
  });
  const remaining = cgtDS.remainingFor(inv.id);
  investmentsDS.update(inv.id, {
    shares_owned: parseFloat((inv.shares_owned - input.units).toFixed(8)),
    ...(remaining.parcels.length > 0
      ? { cost_basis: remaining.costBase, cost_basis_currency: 'AUD' }
      : { cost_basis: parseFloat((inv.cost_basis * (1 - fraction)).toFixed(2)) }),
  }, { parcelIntent: 'sale' });
  return { ...sale, id: bus.idMap.get(sale.id) ?? sale.id };
}

/** One recorded disposal as the CGT engine assesses it today. */
function eventFor(saleId: string, fy: string) {
  return cgtDS.build(fy).events.find(e => e.disposalId === saleId);
}

beforeEach(() => {
  bus.parcels.clear();
  bus.splits.clear();
  bus.allocations.clear();
  bus.opening = null;
  bus.available = true;
  bus.writes.length = 0;
  bus.idMap.clear();
  seedUser();
});

describe('the parcel book is written to the server, not just the browser', () => {
  it('records a purchase as a parcel carrying the holding, the units, the locked cost and the date', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });

    const rows = [...bus.parcels.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      investment_id: id,
      quantity: 100,
      cost_base: 4_000,
      acquired_date: '2020-03-01',
      origin: 'holding',
    });
  });

  it('follows the holding when its id changes local→server, instead of orphaning the parcel', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });

    // The id the browser minted is gone; nothing may still be pointing at it.
    const stale = [...bus.idMap.keys()];
    expect(stale).not.toHaveLength(0);
    for (const row of bus.parcels.values()) expect(stale).not.toContain(row.investment_id);
    expect(cgtDS.parcelsFor(id)).toHaveLength(1);
  });

  it('records a second purchase as a SECOND parcel, with its own date and its own cost', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' });

    const rows = [...bus.parcels.values()].sort((a, b) => Number(a.quantity) - Number(b.quantity));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ quantity: 50, cost_base: 3_000, acquired_date: '2024-06-01' });
    expect(rows[1]).toMatchObject({ quantity: 100, cost_base: 4_000, acquired_date: '2020-03-01' });
  });

  it('records a split as an event — units re-expressed, cost and dates untouched', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 200 }, { parcelIntent: 'split' });

    const split = [...bus.splits.values()][0];
    expect(split).toMatchObject({ investment_id: id, ratio: 2 });
    // The parcel itself did not move: same cost, same day, same recorded units.
    expect([...bus.parcels.values()][0]).toMatchObject({
      quantity: 100, cost_base: 4_000, acquired_date: '2020-03-01',
    });
    // …but the holding is 200 units of the same $4,000 now.
    const remaining = cgtDS.remainingFor(id);
    expect(remaining.quantity).toBe(200);
    expect(remaining.costBase).toBe(4_000);
  });

  it('writes down which parcels a sale consumed, and how much of each', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' });
    const sale = sell({ id, units: 120, proceeds: 12_000, date: '2025-01-15' });

    const rows = bus.allocations.get(sale.id) ?? [];
    expect(rows).toHaveLength(2);
    // Oldest first: the whole 2020 parcel, then 20 units of the 2024 one.
    expect(rows[0]).toMatchObject({ quantity: 100, cost_base: 4_000, acquired_date: '2020-03-01', source: 'parcel' });
    expect(rows[1]).toMatchObject({ quantity: 20, cost_base: 1_200, acquired_date: '2024-06-01', source: 'parcel' });
  });

  it('takes the allocation with the disposal when the disposal is deleted', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    const sale = sell({ id, units: 40, proceeds: 5_000, date: '2025-01-15' });
    expect(bus.allocations.get(sale.id)).toHaveLength(1);

    salesDS.remove(sale.id);
    expect(bus.allocations.get(sale.id)).toBeUndefined();
  });
});

describe('a fresh device rebuilds the book instead of averaging the holding', () => {
  it('restores parcels, splits and settled disposals from the server alone', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' });
    const sale = sell({ id, units: 120, proceeds: 12_000, date: '2025-01-15' });
    const before = eventFor(sale.id, '2024-2025')!;

    freshDevice();
    expect(cgtDS.parcels()).toHaveLength(0); // nothing local at all
    bootstrapCgt();

    expect(cgtDS.parcels()).toHaveLength(2);
    const after = eventFor(sale.id, '2024-2025')!;
    expect(after.costBase).toBe(before.costBase);
    expect(after.gain).toBe(before.gain);
    expect(after.allocations.map(a => [a.quantity, a.costBase, a.acquiredDate]))
      .toEqual(before.allocations.map(a => [a.quantity, a.costBase, a.acquiredDate]));
  });

  it('costs a NEW partial sale from the parcels, not from the average, on the fresh device', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' });

    freshDevice();
    bootstrapCgt();

    const preview = cgtDS.preview({
      investmentId: id, label: 'Ledger Ltd', ticker: 'LDG', assetType: 'stock',
      quantity: 100, proceeds: 10_000, fees: 0, saleDate: '2025-01-15',
      acquiredDate: '2024-06-01', costBase: 4_666.67,
    });
    // The whole 2020 parcel: $4,000, bought five years ago — discountable. The
    // average would have said $4,666.67 acquired 2024, and taxed all of it.
    expect(preview.costBase).toBe(4_000);
    expect(preview.allocations).toHaveLength(1);
    expect(preview.allocations[0]).toMatchObject({ acquiredDate: '2020-03-01', discountEligible: true });
  });

  it('keeps a split that happened on the other device, so the units are not doubled', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 400 }, { parcelIntent: 'split' });

    freshDevice();
    bootstrapCgt();

    const remaining = cgtDS.remainingFor(id);
    expect(remaining.quantity).toBe(400);
    expect(remaining.costBase).toBe(4_000);
    expect(cgtDS.splitsFor(id)).toHaveLength(1);
  });

  it('restores the carried-forward loss, which used to be forgotten with the book', () => {
    cgtDS.setOpening({ fy: '2023-2024', ordinary: 7_000, collectable: 0 });
    expect(bus.opening).toMatchObject({ fy: '2023-2024', ordinary: 7_000 });

    freshDevice();
    expect(cgtDS.opening()).toBeNull();
    bootstrapCgt();
    expect(cgtDS.opening()).toMatchObject({ fy: '2023-2024', ordinary: 7_000 });
  });

  it('changes NOTHING when the server has no book yet — an empty answer is not a delete', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    // The migration has not been run: the routes answer "not available".
    bus.available = false;
    cgtDS.adopt(serverPayload());

    expect(cgtDS.parcelsFor(id)).toHaveLength(1);
    // …and nothing is sent while the tables are absent — a write that could
    // never land must not be queued to fail five times and alarm the user.
    // (applyToServer throws on any cgt write once `available` is false.)
    expect(() => investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' })).not.toThrow();
  });
});

describe('two devices, one book', () => {
  it('carries a parcel correction made on the second device back to the first', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    const parcelId = cgtDS.parcelsFor(id)[0].id;

    // Device B: same server, empty local book, corrects the acquisition date.
    freshDevice();
    bootstrapCgt();
    cgtDS.updateParcel(parcelId, { acquiredDate: '2019-11-04' });
    expect([...bus.parcels.values()][0]).toMatchObject({ acquired_date: '2019-11-04' });

    // Device A, next load.
    freshDevice();
    bootstrapCgt();
    expect(cgtDS.parcelsFor(id)[0].acquiredDate).toBe('2019-11-04');
  });

  it('carries a DELETION across, instead of resurrecting the parcel from the other device', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    const parcelId = cgtDS.parcelsFor(id)[0].id;

    // The first device has this parcel and knows the server has it too.
    bootstrapCgt();
    expect(cgtDS.parcelsFor(id)).toHaveLength(1);

    // Device B deletes it. (Same book, so simulate the server-side effect.)
    bus.parcels.delete(parcelId);

    bootstrapCgt();
    expect(cgtDS.parcelsFor(id)).toHaveLength(0);
    // And it is not pushed back up on the way out.
    expect(bus.parcels.size).toBe(0);
  });

  it('adopts a local book the server has never seen, exactly once', () => {
    // A device that recorded its parcels BEFORE the tables existed. The load's
    // own bootstrap is what tells it so, which is why it comes first.
    bus.available = false;
    cgtDS.adopt(serverPayload());
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    expect(bus.parcels.size).toBe(0);

    // The migration is run. The first bootstrap after it adopts the whole book.
    bus.available = true;
    bootstrapCgt();
    expect(bus.parcels.size).toBe(1);
    expect([...bus.parcels.values()][0]).toMatchObject({ investment_id: id, quantity: 100, cost_base: 4_000 });

    // Every load after that is a no-op, not a second copy.
    bootstrapCgt();
    bootstrapCgt();
    expect(bus.parcels.size).toBe(1);
    expect(cgtDS.parcelsFor(id)).toHaveLength(1);
  });

  it('does not duplicate a purchase two devices each wrote down before the tables existed', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    bootstrapCgt();
    expect(bus.parcels.size).toBe(1);

    // The second device holds the same acquisition under an id of its own, from
    // back when neither device could see the other.
    freshDevice();
    cgtDS.addParcel({
      investmentId: id, label: 'Ledger Ltd', ticker: 'LDG', assetType: 'stock',
      quantity: 100, costBase: 4_000, acquiredDate: '2020-03-01', origin: 'holding',
    });
    const mine = cgtDS.parcelsFor(id)[0].id;
    bus.parcels.delete(mine); // it was recorded while the tables were absent

    bootstrapCgt();
    // One purchase, one parcel — the server's — not two of the same 100 units.
    expect(bus.parcels.size).toBe(1);
    expect(cgtDS.parcelsFor(id)).toHaveLength(1);
    expect(cgtDS.remainingFor(id).quantity).toBe(100);
  });

  it('keeps a parcel this device recorded while the other device was recording its own', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    bootstrapCgt();

    // A genuinely different acquisition, recorded here and not yet pushed.
    freshDevice();
    bootstrapCgt();
    cgtDS.addParcel({
      investmentId: id, label: 'Ledger Ltd', ticker: 'LDG', assetType: 'stock',
      quantity: 25, costBase: 1_500, acquiredDate: '2023-02-02', origin: 'holding',
    });
    const extra = cgtDS.parcelsFor(id).find(p => p.quantity === 25)!;
    expect(bus.parcels.has(extra.id)).toBe(true);

    bootstrapCgt();
    expect(cgtDS.parcelsFor(id)).toHaveLength(2);
  });
});

describe('history stops moving once a disposal is recorded', () => {
  it('does not re-cost a recorded sale when an older purchase is written down afterwards', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    const sale = sell({ id, units: 40, proceeds: 5_000, date: '2025-01-15' });

    const before = eventFor(sale.id, '2024-2025')!;
    expect(before.costBase).toBe(1_600);

    // The user remembers a parcel bought years earlier and records it now. FIFO
    // replayed over today's book would hand this sale the 2018 units instead —
    // changing a figure that may already be on a lodged return.
    // 60 units and $2,400 are left after the sale; this adds 10 units for $500.
    investmentsDS.update(id, { shares_owned: 70, cost_basis: 2_900 },
      { parcelIntent: 'purchase', acquiredDate: '2018-01-01' });

    const after = eventFor(sale.id, '2024-2025')!;
    expect(after.costBase).toBe(1_600);
    expect(after.gain).toBe(before.gain);
    expect(after.allocations[0].acquiredDate).toBe('2020-03-01');
  });

  it('gives the NEXT sale the older parcel, because FIFO is still the default', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    sell({ id, units: 40, proceeds: 5_000, date: '2025-01-15' });
    // 60 units and $2,400 are left after the sale; this adds 10 units for $500.
    investmentsDS.update(id, { shares_owned: 70, cost_basis: 2_900 },
      { parcelIntent: 'purchase', acquiredDate: '2018-01-01' });

    const second = sell({ id, units: 10, proceeds: 1_500, date: '2025-02-20' });
    const event = eventFor(second.id, '2024-2025')!;
    expect(event.allocations[0].acquiredDate).toBe('2018-01-01');
    expect(event.costBase).toBe(500); // 10 of the 10 units bought for $500
  });

  it('keeps the settled cost base after a reload, on a device that never saw the sale happen', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' });
    const sale = sell({ id, units: 120, proceeds: 12_000, date: '2025-01-15' });
    const before = eventFor(sale.id, '2024-2025')!;

    freshDevice();
    bootstrapCgt();

    const after = eventFor(sale.id, '2024-2025')!;
    expect(after.costBase).toBe(before.costBase);
    expect(after.discountableGain).toBe(before.discountableGain);
    expect(after.otherGain).toBe(before.otherGain);
  });

  it('still leaves the right units and cost behind after the sale, everywhere', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    investmentsDS.update(id, { shares_owned: 150, cost_basis: 7_000 },
      { parcelIntent: 'purchase', acquiredDate: '2024-06-01' });
    sell({ id, units: 120, proceeds: 12_000, date: '2025-01-15' });

    const here = cgtDS.remainingFor(id);
    expect(here.quantity).toBe(30);
    expect(here.costBase).toBe(1_800);

    freshDevice();
    bootstrapCgt();
    const there = cgtDS.remainingFor(id);
    expect(there.quantity).toBe(30);
    expect(there.costBase).toBe(1_800);
  });

  it('scales a settled disposal through a LATER split, so the parcels still balance', () => {
    const id = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    sell({ id, units: 40, proceeds: 5_000, date: '2025-01-15' });
    // 60 units left, $2,400 of cost. A 2:1 split makes that 120 units, same cost.
    investmentsDS.update(id, { shares_owned: 120 }, { parcelIntent: 'split' });

    const remaining = cgtDS.remainingFor(id);
    expect(remaining.quantity).toBe(120);
    expect(remaining.costBase).toBe(2_400);

    freshDevice();
    bootstrapCgt();
    const after = cgtDS.remainingFor(id);
    expect(after.quantity).toBe(120);
    expect(after.costBase).toBe(2_400);
  });

  it('forgets a genuinely deleted holding everywhere, and keeps a sold one', () => {
    const kept = buy({ name: 'Ledger Ltd', ticker: 'LDG', units: 100, cost: 4_000, date: '2020-03-01' });
    const gone = buy({ name: 'Mistake Ltd', ticker: 'MIS', units: 10, cost: 500, date: '2021-01-01' });
    expect(bus.parcels.size).toBe(2);

    // Sold out entirely: the disposal still has to be costed from its parcels.
    sell({ id: kept, units: 100, proceeds: 9_000, date: '2025-03-01' });
    investmentsDS.remove(kept, true);
    expect(bus.parcels.size).toBe(2);

    // Never really owned: it goes, and so does its parcel.
    investmentsDS.remove(gone, false);
    expect([...bus.parcels.values()].some(p => p.investment_id === gone)).toBe(false);
    expect([...bus.parcels.values()].some(p => p.investment_id === kept)).toBe(true);
  });
});
