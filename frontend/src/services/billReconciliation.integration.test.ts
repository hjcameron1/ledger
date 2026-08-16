import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Bill, Subscription } from '../types';

// Polyfill localStorage (store persist + the "Different bills" decision store both
// use it) BEFORE the store module loads.
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
import { subscriptionsDS, billsDS, billReconciliationDS } from './dataService';
import type { BillSubscriptionExclusion } from '../types';

const ME = 'user-ME';
const mockedSync = vi.mocked(syncWithRetry);

function sub(o: Partial<Subscription> & { id: string; name: string }): Subscription {
  return {
    user_id: ME, original_name: null, amount: 18.99, currency: 'AUD', frequency: 'monthly',
    next_charge_date: '2026-09-01', category: 'Entertainment', is_auto_detected: true,
    account_id: 'acc-1', ...o,
  } as Subscription;
}
function bill(o: Partial<Bill> & { id: string; name: string }): Bill {
  return {
    user_id: ME, amount: 18.99, due_date: '2026-09-01', is_recurring: true, frequency: 'monthly',
    colour: 'grey', is_paid: false, kind: 'bill', calendar_synced: false,
    account_id: 'acc-1', account_type: 'bank', ...o,
  } as Bill;
}

function seed(subscriptions: Subscription[], bills: Bill[], opts: { userId?: string; exclusions?: BillSubscriptionExclusion[] } = {}) {
  const userId = opts.userId ?? ME;
  useStore.setState({
    user: { id: userId, email: `${userId}@example.com` } as any,
    subscriptions, bills,
    accounts: [{ id: 'acc-1', name: 'Everyday' } as any],
    creditCards: [],
    billSubExclusions: opts.exclusions ?? [],
  });
}

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed([], []);
});

const excl = (decision_key: string): BillSubscriptionExclusion =>
  ({ id: `e-${decision_key}`, user_id: ME, decision_key });

describe('subscription rename propagates to the linked Bills & Reminders entry', () => {
  it('renames a bill linked by subscription_id', () => {
    seed(
      [sub({ id: 's1', name: 'NETFLIX.COM' })],
      [bill({ id: 'b1', name: 'NETFLIX.COM', amount: 18.99, subscription_id: 's1' })],
    );
    subscriptionsDS.rename('s1', 'Netflix');
    const b = useStore.getState().bills.find(x => x.id === 'b1')!;
    expect(b.name).toBe('Netflix');
    expect(b.original_name).toBe('NETFLIX.COM'); // import name preserved
  });

  it('renames a legacy name-linked bill (no subscription_id) via the anchor', () => {
    seed(
      [sub({ id: 's1', name: 'Spotify' })],
      [bill({ id: 'b1', name: 'Spotify', amount: 11.99 })], // linked only by name
    );
    subscriptionsDS.rename('s1', 'Spotify Family');
    expect(useStore.getState().bills.find(x => x.id === 'b1')!.name).toBe('Spotify Family');
  });

  it('does not loop or clobber an unrelated bill', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix' })],
      [bill({ id: 'b1', name: 'Gym', amount: 60 })],
    );
    subscriptionsDS.rename('s1', 'Netflix Premium');
    expect(useStore.getState().bills.find(x => x.id === 'b1')!.name).toBe('Gym');
  });
});

describe('billReconciliationDS.link — "Same bill"', () => {
  it('links the bill to the subscription and unifies the name', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix' })],
      [bill({ id: 'b1', name: 'NETFLIX.COM', amount: 18.99 })],
    );
    billReconciliationDS.link('b1', 's1');
    const b = useStore.getState().bills.find(x => x.id === 'b1')!;
    expect(b.subscription_id).toBe('s1');
    expect(b.name).toBe('Netflix'); // subscription (merchant) name wins the tie
    // Subscription keeps/gets the same canonical name.
    expect(useStore.getState().subscriptions.find(x => x.id === 's1')!.name).toBe('Netflix');
  });

  it('a linked pair no longer appears as a reconciliation candidate', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
    );
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(true);
    billReconciliationDS.link('b1', 's1');
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(false);
  });
});

describe('billReconciliationDS.markDifferent — persisted decision', () => {
  it('suppresses the pair from future suggestions', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
    );
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(true);
    billReconciliationDS.markDifferent('b1', 's1');
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(false);
  });

  it('the decision survives a new occurrence id and a rename (anchor-keyed)', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix', original_name: 'NETFLIX.COM', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', original_name: 'NETFLIX.COM', amount: 18.99 })],
    );
    billReconciliationDS.markDifferent('b1', 's1'); // persisted decision (kept — no reseed)

    // A fresh recurring occurrence (new id) + a display rename appears, SAME anchors.
    // Append it to the store WITHOUT clearing the persisted decision.
    const st = useStore.getState();
    useStore.setState({
      bills: [...st.bills.filter(b => b.id !== 'b1'),
        bill({ id: 'b-new', name: 'My Netflix', original_name: 'NETFLIX.COM', amount: 18.99 })],
    });
    // Anchor-based key still matches → the renamed new occurrence stays suppressed.
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b-new')).toBe(false);
  });
});

describe('cross-device persistence', () => {
  it('markDifferent writes the store row AND enqueues the backend upsert', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
    );
    billReconciliationDS.markDifferent('b1', 's1');
    expect(useStore.getState().billSubExclusions.map(e => e.decision_key)).toContain('netflix::netflix');
    expect(mockedSync).toHaveBeenCalledWith('billSubExclusion.create', { data: { decision_key: 'netflix::netflix' } });
  });

  it('a decision synced from another device (store row, no local cache) is honoured', () => {
    // Device B: the exclusion arrives via bootstrap into the store; localStorage
    // cache is empty here (it was written on device A only).
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
      { exclusions: [excl('netflix::netflix')] },
    );
    expect(localStorage.getItem(`ledger-bill-sub-different-${ME}`)).toBeNull();
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(false);
  });

  it('markDifferent is idempotent — no duplicate row / second enqueue for the same key', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
    );
    billReconciliationDS.markDifferent('b1', 's1');
    billReconciliationDS.markDifferent('b1', 's1');
    expect(useStore.getState().billSubExclusions.filter(e => e.decision_key === 'netflix::netflix')).toHaveLength(1);
    expect(mockedSync.mock.calls.filter(c => c[0] === 'billSubExclusion.create')).toHaveLength(1);
  });
});

describe('logout / login', () => {
  it('after a fresh login (empty local cache) a server-synced decision still suppresses', () => {
    // Simulate logout: store cleared, no localStorage cache. Then login bootstrap
    // rehydrates billSubExclusions from the server.
    localStorage.clear();
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
      { exclusions: [excl('netflix::netflix')] },
    );
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(false);
  });
});

describe('deletion — removeDifferent reverses the decision', () => {
  it('clears store + cache, enqueues the backend delete, and re-surfaces the candidate', () => {
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
    );
    billReconciliationDS.markDifferent('b1', 's1');
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(false);

    billReconciliationDS.removeDifferent('b1', 's1');
    expect(useStore.getState().billSubExclusions.some(e => e.decision_key === 'netflix::netflix')).toBe(false);
    expect(mockedSync).toHaveBeenCalledWith('billSubExclusion.delete', { key: 'netflix::netflix' });
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(true);
  });
});

describe('user isolation', () => {
  it("user B does not inherit user A's decision (per-user cache key + purged store)", () => {
    // User A marks the pair different (writes A's localStorage cache + A's store row).
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
      { userId: 'user-A' },
    );
    billReconciliationDS.markDifferent('b1', 's1');
    expect(localStorage.getItem('ledger-bill-sub-different-user-A')).not.toBeNull();

    // User B logs in on the same device: bootstrap's cross-user guard purges the
    // store (no A rows), and B's cache key is different (empty). The pair is offered.
    seed(
      [sub({ id: 's1', name: 'Netflix', amount: 18.99 })],
      [bill({ id: 'b1', name: 'Netflix', amount: 18.99 })],
      { userId: 'user-B', exclusions: [] },
    );
    expect(localStorage.getItem('ledger-bill-sub-different-user-B')).toBeNull();
    expect(billReconciliationDS.candidates().some(c => c.bill.id === 'b1')).toBe(true);
  });
});
