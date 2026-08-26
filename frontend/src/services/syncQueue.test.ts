/**
 * "Will not be allowed" vs "will work later" (pre-market audit).
 *
 * A refused write (403/400/422) comes back identical on every retry, so it
 * must never be parked in the retry queue behind "Some data couldn't sync —
 * will retry". It is reported immediately, in its own words, and a queued item
 * that starts being refused leaves the queue on the next replay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as never as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(), key: () => null, get length() { return mem.size; },
  };
});

const updateAccount = vi.fn();
const createTransaction = vi.fn();
vi.mock('./api', () => ({
  accountsApi: new Proxy({}, { get: (_t, prop) =>
    prop === 'updateAccount' ? updateAccount
    : prop === 'createTransaction' ? createTransaction
    : vi.fn().mockResolvedValue({}) }),
  investmentsApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
  incomeApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
  overviewApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
  insuranceApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
}));

import { syncWithRetry, retryPendingSync } from './syncQueue';
import { useStore } from '../store';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

function resetStore() {
  useStore.setState({
    pendingSyncQueue: [], notifications: [], syncToast: null, idMap: {},
  } as never);
}

beforeEach(() => { vi.useFakeTimers(); updateAccount.mockReset(); createTransaction.mockReset(); resetStore(); });
afterEach(() => { vi.useRealTimers(); });

const flush = async () => { await vi.runAllTimersAsync(); };

describe('a server refusal stops retrying immediately', () => {
  it('403: never queued, reported in its own words, one attempt only', async () => {
    updateAccount.mockRejectedValue(httpError(403));
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();

    expect(updateAccount).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingSyncQueue).toEqual([]);
    const notif = useStore.getState().notifications.find(n => n.type === 'sync');
    expect(notif?.message).toContain("wasn't allowed");
    expect(useStore.getState().syncToast).toContain("wasn't allowed");
  });

  it('422 on the retry attempt also short-circuits into a refusal', async () => {
    updateAccount
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(httpError(422));
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();

    expect(updateAccount).toHaveBeenCalledTimes(2);
    expect(useStore.getState().pendingSyncQueue).toEqual([]);
    expect(useStore.getState().notifications.find(n => n.type === 'sync')?.message).toContain("wasn't allowed");
  });

  it('a network failure still queues and still says "will retry"', async () => {
    updateAccount.mockRejectedValue(new Error('network down'));
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();

    expect(updateAccount).toHaveBeenCalledTimes(2);
    expect(useStore.getState().pendingSyncQueue).toHaveLength(1);
    expect(useStore.getState().syncToast).toContain('will retry');
    // And it is NOT reported as refused.
    expect(useStore.getState().notifications.find(n => n.type === 'sync')).toBeUndefined();
  });

  it('a 500 stays retryable — the server being broken is not a refusal', async () => {
    updateAccount.mockRejectedValue(httpError(500));
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();
    expect(useStore.getState().pendingSyncQueue).toHaveLength(1);
  });

  it('a queued item that starts being refused leaves the queue on replay', async () => {
    useStore.setState({
      pendingSyncQueue: [{ qid: 'q1', kind: 'account.update', payload: { id: 'a1', data: {} }, attempts: 2, lastError: 'was network' }],
    } as never);
    updateAccount.mockRejectedValue(httpError(403));

    await retryPendingSync();

    expect(useStore.getState().pendingSyncQueue).toEqual([]);
    expect(useStore.getState().notifications.find(n => n.type === 'sync')?.message).toContain("wasn't allowed");
  });
});

/**
 * Enqueue-first (launch-readiness fix): a write is parked in the PERSISTED queue
 * before its request is even sent, so a reload/navigation while the request is
 * in flight can never lose a transaction the UI already showed as saved — the
 * next app load replays it.
 */
describe('enqueue-first: a write can never be lost mid-flight', () => {
  it('is in the persisted queue the moment it is issued, before any response', () => {
    let resolveReq!: (v: unknown) => void;
    updateAccount.mockReturnValue(new Promise((res) => { resolveReq = res; }));

    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });

    // Synchronously — the request has not resolved, a reload NOW would keep it.
    const q = useStore.getState().pendingSyncQueue;
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe('account.update');
    expect(q[0].attempts).toBe(0);
    resolveReq({});
  });

  it('leaves the queue once the server confirms the write', async () => {
    updateAccount.mockResolvedValue({});
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();
    expect(useStore.getState().pendingSyncQueue).toEqual([]);
  });

  it('stays queued at attempts 2 after both in-session attempts fail', async () => {
    updateAccount.mockRejectedValue(new Error('network down'));
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();
    const q = useStore.getState().pendingSyncQueue;
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(2);
  });

  it('replay skips an item whose own request is still in flight (no double-send)', async () => {
    updateAccount.mockReturnValue(new Promise(() => {})); // never settles
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    expect(useStore.getState().pendingSyncQueue).toHaveLength(1);

    await retryPendingSync();

    expect(updateAccount).toHaveBeenCalledTimes(1); // only the original request
    expect(useStore.getState().pendingSyncQueue).toHaveLength(1); // still parked
  });

  it('an item stranded mid-flight by a reload jumps to attempts 2 on a failed replay', async () => {
    // Simulates the post-reload state: queued at attempts 0, nothing in flight.
    useStore.setState({
      pendingSyncQueue: [{ qid: 'q-reload', kind: 'account.update', payload: { id: 'a1', data: {} }, attempts: 0, lastError: '' }],
    } as never);
    updateAccount.mockRejectedValue(new Error('network down'));

    await retryPendingSync();

    const q = useStore.getState().pendingSyncQueue;
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(2); // visible in the "waiting to sync" banner now
  });

  it('demo sessions never queue or send writes — local-only by design', async () => {
    useStore.setState({ token: 'demo-token' } as never);
    syncWithRetry('account.update', { id: 'a1', data: { name: 'x' } });
    await flush();
    expect(updateAccount).not.toHaveBeenCalled();
    expect(useStore.getState().pendingSyncQueue).toEqual([]);
    useStore.setState({ token: null } as never);
  });

  it('a stranded transaction.create replays with its client_id idempotency key', async () => {
    useStore.setState({
      pendingSyncQueue: [{
        qid: 'q-tx', kind: 'transaction.create',
        payload: { recordId: 'local-uuid-1', data: { merchant: 'Cafe', amount: 5 } },
        attempts: 0, lastError: '',
      }],
    } as never);
    createTransaction.mockResolvedValue({ id: 'server-1' });

    await retryPendingSync();

    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: 'Cafe', amount: 5, client_id: 'local-uuid-1' }),
    );
    expect(useStore.getState().pendingSyncQueue).toEqual([]);
  });
});
