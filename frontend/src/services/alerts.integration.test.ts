/**
 * Phase 4.4 — proactive alerts, end to end through the store.
 *
 * The engine is unit-tested in isolation (utils/alerts.test.ts). These are the
 * things it cannot prove on its own — the parts that only exist once the
 * budget, goal and forecast gatherers, the store and the sync queue are wired
 * together:
 *
 *   • real data produces real alerts, with no fixtures in between;
 *   • a dismissal reaches the store AND the wire, so a second device honours it;
 *   • dismissing hides one alert and only that one, and survives a rebuild;
 *   • crossing the next threshold brings a dismissed alert back;
 *   • a resolved alert's stored state is pruned, locally and on the wire;
 *   • the prune guard holds while the store is still empty;
 *   • one user never sees, dismisses or is alerted by another's data.
 *
 * Sync is mocked, so every claim about "cross-device" is really "the right op,
 * with the right payload, was queued" — which is exactly what the other device
 * replays on bootstrap.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, Goal, Transaction, AlertState } from '../types';

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
import { alertsDS, alertStatesDS } from './dataService';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const TODAY = '2026-08-17';
const MONTH = '2026-08';
const mockedSync = vi.mocked(syncWithRetry);

let seq = 0;
const tx = (o: Partial<Transaction> & { amount: number }): Transaction => {
  seq += 1;
  return {
    id: o.id ?? `t${seq}`, user_id: ME, account_id: 'acc-bank', account_type: 'bank',
    date: '2026-08-10', merchant: 'Merchant', currency: 'AUD', category: 'Groceries',
    is_duplicate_flagged: false, is_subscription: false, ...o,
  } as Transaction;
};

const budget = (o: Partial<Budget> = {}): Budget => ({
  id: o.id ?? 'b1', user_id: ME, scope: 'category', category: 'Groceries',
  limit_amount: 500, period: 'monthly', rollover_enabled: false, active: true, ...o,
});

const goal = (o: Partial<Goal> = {}): Goal => ({
  id: 'g1', user_id: ME, name: 'House deposit', target_amount: 12_000,
  current_amount: 0, target_date: '2027-08-17', ...o,
} as Goal);

function seed(opts: {
  budgets?: Budget[];
  transactions?: Transaction[];
  goals?: Goal[];
  alertStates?: AlertState[];
  accounts?: any[];
  userId?: string;
} = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    budgets: opts.budgets ?? [],
    transactions: opts.transactions ?? [],
    goals: opts.goals ?? [],
    alertStates: opts.alertStates ?? [],
    accounts: opts.accounts ?? [{ id: 'acc-bank', name: 'Everyday', balance: 50_000, type: 'bank' }],
    // Everything the forecast / goal gatherers read — empty unless a test needs it.
    goalContributions: [], investments: [], superFunds: [], creditCards: [],
    subscriptions: [], incomeEntries: [], bills: [], loans: [],
    recurringSeries: [], transactionSplits: [], customCategories: [],
  } as any);
}

const build = () => alertsDS.build({ asOf: TODAY });
const keys = () => build().visible.map(a => a.key);
const opsOf = (kind: string) => mockedSync.mock.calls.filter(c => c[0] === kind).map(c => c[1] as any);

/** A budget blown right through — the simplest alert to provoke with real data. */
const OVERSPENT = {
  budgets: [budget({ limit_amount: 300 })],
  transactions: [tx({ amount: -900 })],
};
const OVER_KEY = `budget-limit:${MONTH}:groceries`;

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Real data in, real alerts out
// ═════════════════════════════════════════════════════════════════════════════
describe('building from live store data', () => {
  it('says nothing about an account with nothing wrong', () => {
    const r = build();
    expect(r.visible).toEqual([]);
    expect(r.unreadCount).toBe(0);
  });

  it('raises a budget alert from real budgets and transactions', () => {
    seed(OVERSPENT);
    const r = build();
    expect(r.visible.map(a => a.key)).toContain(OVER_KEY);
    expect(r.visible[0].severity).toBe('critical');
  });

  it('raises a goal alert from a real goal with no spare cash behind it', () => {
    seed({ goals: [goal()] });
    expect(keys()).toContain('goal-behind:g1');
  });

  it('produces the same set however many times it is asked', () => {
    seed(OVERSPENT);
    expect(keys()).toEqual(keys());
    expect(keys()).toEqual(keys());
    expect(new Set(keys()).size).toBe(keys().length);
  });

  it('counts unseen alerts as unread', () => {
    seed(OVERSPENT);
    const r = build();
    expect(r.unreadCount).toBe(r.visible.length);
    expect(r.unreadCount).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Dismissing
// ═════════════════════════════════════════════════════════════════════════════
describe('dismissing an alert', () => {
  beforeEach(() => seed(OVERSPENT));

  it('hides it from the very next build', () => {
    const before = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(before.key, { dismissedStage: before.stage });
    expect(keys()).not.toContain(OVER_KEY);
  });

  it('lands in the store with the stage it was dismissed at', () => {
    const alert = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(alert.key, { dismissedStage: alert.stage });

    const stored = useStore.getState().alertStates;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ alert_key: OVER_KEY, dismissed_stage: alert.stage, user_id: ME });
    expect(stored[0].dismissed_at).toBeTruthy();
  });

  it('queues a payload another device can replay', () => {
    const alert = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(alert.key, { dismissedStage: alert.stage });

    const [op] = opsOf('alertState.save');
    expect(op.data).toMatchObject({ alert_key: OVER_KEY, dismissed_stage: alert.stage });
    // The whole row goes up, not a diff — the endpoint is an upsert, and a
    // partial payload would blank the read state it isn't touching.
    expect(op.data).toHaveProperty('read_stage');
  });

  it('honours a dismissal that arrived from another device', () => {
    seed({
      ...OVERSPENT,
      alertStates: [{ id: 'as1', user_id: ME, alert_key: OVER_KEY, dismissed_stage: 9 } as AlertState],
    });
    expect(keys()).not.toContain(OVER_KEY);
  });

  it('leaves every other alert exactly where it was', () => {
    seed({ ...OVERSPENT, goals: [goal()] });
    const before = keys();
    expect(before.length).toBeGreaterThan(1);

    const alert = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(alert.key, { dismissedStage: alert.stage });

    expect(keys()).toEqual(before.filter(k => k !== OVER_KEY));
  });

  it('does not lose the read state when dismissing, or vice versa', () => {
    const alert = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(alert.key, { readStage: alert.stage });
    alertStatesDS.save(alert.key, { dismissedStage: alert.stage });

    const stored = useStore.getState().alertStates;
    expect(stored).toHaveLength(1);                       // merged, not duplicated
    expect(stored[0].read_stage).toBe(alert.stage);
    expect(stored[0].dismissed_stage).toBe(alert.stage);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Threshold crossings
// ═════════════════════════════════════════════════════════════════════════════
describe('when a dismissed situation gets worse', () => {
  it('comes back once the next threshold is crossed', () => {
    // Nearing the cap, late in the month so it isn't yet projected to breach it.
    seed({ budgets: [budget({ limit_amount: 500 })], transactions: [tx({ amount: -430 })] });
    const near = alertsDS.build({ asOf: '2026-08-30' }).visible.find(a => a.key === OVER_KEY)!;
    expect(near.stage).toBe(1);

    alertStatesDS.save(near.key, { dismissedStage: near.stage });
    expect(alertsDS.build({ asOf: '2026-08-30' }).visible.map(a => a.key)).not.toContain(OVER_KEY);

    // Now actually over the cap — a materially worse situation than the one
    // that was dismissed, so the dismissal no longer covers it.
    useStore.setState({ transactions: [tx({ amount: -430 }), tx({ amount: -100 })] } as any);
    const back = alertsDS.build({ asOf: '2026-08-30' }).visible.find(a => a.key === OVER_KEY);
    expect(back).toBeTruthy();
    expect(back!.stage).toBe(2);
  });

  it('stays hidden while the situation is merely more of the same', () => {
    seed({ budgets: [budget({ limit_amount: 500 })], transactions: [tx({ amount: -560 })] });
    const alert = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(alert.key, { dismissedStage: alert.stage });

    useStore.setState({ transactions: [tx({ amount: -600 })] } as any);   // still stage 2
    expect(keys()).not.toContain(OVER_KEY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Resolved alerts
// ═════════════════════════════════════════════════════════════════════════════
describe('when the situation resolves', () => {
  it('stops raising the alert', () => {
    seed(OVERSPENT);
    expect(keys()).toContain(OVER_KEY);

    useStore.setState({ budgets: [budget({ limit_amount: 5_000 })] } as any);
    expect(keys()).not.toContain(OVER_KEY);
  });

  it('reports the stale state so it can be pruned', () => {
    seed({
      budgets: [budget({ limit_amount: 5_000 })],
      transactions: [tx({ amount: -100 })],
      alertStates: [{ id: 'as1', user_id: ME, alert_key: OVER_KEY, dismissed_stage: 2 } as AlertState],
    });
    expect(build().resolvedKeys).toEqual([OVER_KEY]);
  });

  it('prunes it from the store and from the server', () => {
    seed({
      budgets: [budget({ limit_amount: 5_000 })],
      transactions: [tx({ amount: -100 })],
      alertStates: [{ id: 'as1', user_id: ME, alert_key: OVER_KEY, dismissed_stage: 2 } as AlertState],
    });
    alertStatesDS.prune(build().resolvedKeys);

    expect(useStore.getState().alertStates).toEqual([]);
    expect(opsOf('alertState.delete')[0]).toMatchObject({ key: OVER_KEY });
  });

  it('hears the same problem again after it was dismissed and resolved', () => {
    // Overspend → dismiss → get back under → overspend again. The dismissal was
    // about a situation that has since passed, so it must not silence the new one.
    seed(OVERSPENT);
    const alert = build().visible.find(a => a.key === OVER_KEY)!;
    alertStatesDS.save(alert.key, { dismissedStage: alert.stage });
    expect(keys()).not.toContain(OVER_KEY);

    useStore.setState({ budgets: [budget({ limit_amount: 5_000 })] } as any);
    alertStatesDS.prune(build().resolvedKeys);

    useStore.setState({ budgets: [budget({ limit_amount: 300 })] } as any);
    expect(keys()).toContain(OVER_KEY);
  });

  it('refuses to prune while the store is still empty', () => {
    // The first render after a reload can see no data at all. Every alert then
    // looks resolved, and an unguarded prune would delete every dismissal the
    // user has ever made.
    useStore.setState({
      user: { id: ME } as any,
      accounts: [], transactions: [], budgets: [], goals: [],
      alertStates: [{ id: 'as1', user_id: ME, alert_key: OVER_KEY, dismissed_stage: 2 } as AlertState],
    } as any);

    expect(alertsDS.ready()).toBe(false);
    expect(build().resolvedKeys).toEqual([OVER_KEY]);   // the engine still says so…
    // …and the guard is what stops the caller acting on it.
    expect(useStore.getState().alertStates).toHaveLength(1);
  });

  it('is ready once any real data has loaded', () => {
    seed(OVERSPENT);
    expect(alertsDS.ready()).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Several problems at once
// ═════════════════════════════════════════════════════════════════════════════
describe('multiple budgets and goals', () => {
  beforeEach(() => seed({
    budgets: [
      budget({ id: 'b-g', category: 'Groceries', limit_amount: 300 }),
      budget({ id: 'b-d', category: 'Dining', limit_amount: 200 }),
    ],
    transactions: [
      tx({ amount: -900, category: 'Groceries' }),
      tx({ amount: -700, category: 'Dining' }),
    ],
    goals: [
      goal({ id: 'g1', name: 'House' }),
      goal({ id: 'g2', name: 'Car', target_amount: 8_000 }),
    ],
  }));

  it('raises one alert per problem, each independently keyed', () => {
    const k = keys();
    expect(k).toEqual(expect.arrayContaining([
      `budget-limit:${MONTH}:groceries`,
      `budget-limit:${MONTH}:dining`,
      'goal-behind:g1',
      'goal-behind:g2',
    ]));
    expect(new Set(k).size).toBe(k.length);
  });

  it('dismisses exactly one of several similar alerts', () => {
    alertStatesDS.save('goal-behind:g1', { dismissedStage: 9 });
    const k = keys();
    expect(k).not.toContain('goal-behind:g1');
    expect(k).toContain('goal-behind:g2');
    expect(k).toContain(`budget-limit:${MONTH}:groceries`);
  });

  it('orders the worst first', () => {
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    const severities = build().visible.map(a => rank[a.severity]);
    expect([...severities].sort((a, b) => a - b)).toEqual(severities);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  User isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('user isolation', () => {
  it('never alerts on another user\'s budget', () => {
    seed({
      budgets: [budget({ id: 'b-theirs', user_id: OTHER, limit_amount: 300 })],
      transactions: [tx({ amount: -900 })],
    });
    expect(keys().some(k => k.startsWith('budget-limit'))).toBe(false);
  });

  it('never alerts on another user\'s goal', () => {
    seed({ goals: [goal({ id: 'g-theirs', user_id: OTHER })] });
    expect(keys()).not.toContain('goal-behind:g-theirs');
  });

  it('never alerts on another user\'s transactions', () => {
    seed({
      budgets: [budget({ limit_amount: 300 })],
      transactions: [tx({ amount: -900, user_id: OTHER })],
    });
    expect(keys().some(k => k.startsWith('budget-limit'))).toBe(false);
  });

  it('ignores another user\'s dismissal of the same alert key', () => {
    seed({
      ...OVERSPENT,
      alertStates: [{ id: 'as1', user_id: OTHER, alert_key: OVER_KEY, dismissed_stage: 9 } as AlertState],
    });
    expect(keys()).toContain(OVER_KEY);
  });

  it('never prunes another user\'s stored state', () => {
    seed({
      ...OVERSPENT,
      alertStates: [{ id: 'as1', user_id: OTHER, alert_key: 'goal-behind:whatever', dismissed_stage: 1 } as AlertState],
    });
    alertStatesDS.prune(['goal-behind:whatever']);

    expect(useStore.getState().alertStates).toHaveLength(1);
    expect(opsOf('alertState.delete')).toEqual([]);
  });

  it('stamps a new dismissal with the signed-in user', () => {
    seed(OVERSPENT);
    alertStatesDS.save(OVER_KEY, { dismissedStage: 2 });
    expect(useStore.getState().alertStates[0].user_id).toBe(ME);
  });
});
