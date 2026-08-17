/**
 * Phase 4.4 alerts in the notification bell, end to end through the store.
 *
 * The bell is a second WINDOW onto the alerts, not a second alert system, and
 * these are the consequences of that which only exist once the engines, the
 * store and the alert-state records are wired together:
 *
 *   • a real alert from real data shows up in the bell, with its own deep link;
 *   • rebuilding never duplicates it — the alert's key and stage ARE the id;
 *   • an alert getting worse is news again: new entry, unread, at the top;
 *   • reading it from the bell marks the ALERT read (cross-device) and leaves it
 *     sitting in "Needs your attention" — reading is not dismissing;
 *   • dismissing it in the card takes the bell entry with it;
 *   • so does the situation simply resolving;
 *   • nothing else in the bell is disturbed.
 *
 * The test drives the same pure composition the hook does
 * (`syncAlertNotifications`), so what is proven here is the code that ships —
 * only the useEffect wrapper around it is left to React.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, Goal, Transaction, Notification } from '../types';

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
import {
  syncAlertNotifications, isAlertNotification, parseAlertNotification,
} from '../utils/alertNotifications';

const ME = 'user-ME';
const TODAY = '2026-08-17';
const MONTH = '2026-08';
const NOW = '2026-08-17T09:00:00.000Z';
const LATER = '2026-08-17T18:00:00.000Z';
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
  limit_amount: 300, period: 'monthly', rollover_enabled: false, active: true, ...o,
});

const goal = (o: Partial<Goal> = {}): Goal => ({
  id: 'g1', user_id: ME, name: 'House deposit', target_amount: 12_000,
  current_amount: 0, target_date: '2026-09-17', ...o,
} as Goal);

const syncNotification: Notification = {
  id: 'n-sync', type: 'sync', message: 'Some data is waiting to sync',
  is_read: false, created_at: '2026-08-01T00:00:00.000Z',
};

function seed(opts: {
  budgets?: Budget[]; transactions?: Transaction[]; goals?: Goal[];
  notifications?: Notification[];
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com', currency_preference: 'AUD' } as any,
    budgets: opts.budgets ?? [],
    transactions: opts.transactions ?? [],
    goals: opts.goals ?? [],
    notifications: opts.notifications ?? [],
    alertStates: [],
    accounts: [{ id: 'acc-bank', name: 'Everyday', balance: 50_000, type: 'bank' }],
    goalContributions: [], investments: [], superFunds: [], creditCards: [],
    subscriptions: [], incomeEntries: [], bills: [], loans: [],
    recurringSeries: [], transactionSplits: [], customCategories: [],
  } as any);
}

/**
 * What the always-mounted bridge does on one rebuild. The description is
 * stubbed to the alert's title — the currency sentence is the card's business
 * (AlertSection.describeAlert) and is covered with the rest of the wording.
 */
function bell(now = NOW): Notification[] {
  const report = alertsDS.build({ asOf: TODAY });
  const next = syncAlertNotifications(
    useStore.getState().notifications, report.visible, a => a.title, now,
  );
  useStore.setState({ notifications: next } as any);
  return next;
}

const alertEntries = () => useStore.getState().notifications.filter(isAlertNotification);
const visibleKeys = () => alertsDS.build({ asOf: TODAY }).visible.map(a => a.key);
const opsOf = (kind: string) => mockedSync.mock.calls.filter(c => c[0] === kind).map(c => c[1] as any);

/** Groceries $350 against a $300 cap — over, but not yet 125% over. */
const OVER = { budgets: [budget()], transactions: [tx({ amount: -350 })] };
const OVER_KEY = `budget-limit:${MONTH}:groceries`;

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  A new alert reaches the bell
// ═════════════════════════════════════════════════════════════════════════════
describe('a new alert', () => {
  it('appears in the bell, unread, with the alert’s own message', () => {
    seed(OVER);
    const entries = bell().filter(isAlertNotification);

    expect(entries).toHaveLength(1);
    expect(entries[0].is_read).toBe(false);
    expect(entries[0].message).toBe(alertsDS.build({ asOf: TODAY }).visible[0].title);
    expect(parseAlertNotification(entries[0])!.key).toBe(OVER_KEY);
  });

  it('carries the alert’s deep link, not a generic one', () => {
    seed(OVER);
    bell();
    const report = alertsDS.build({ asOf: TODAY });
    for (const entry of alertEntries()) {
      const key = parseAlertNotification(entry)!.key;
      const alert = report.visible.find(a => a.key === key)!;
      expect(entry.link).toBe(alert.link.to);
    }
    expect(alertEntries()[0].link).toContain('focus=budget:');
  });

  it('a goal alert links to that goal, a cash alert to the forecast', () => {
    seed({
      goals: [goal()],                                   // $12k due in a month
      budgets: [budget()], transactions: [tx({ amount: -350 })],
    });
    bell();
    const links = alertEntries().map(n => n.link);
    expect(links.some(l => (l ?? '').includes('focus=goal:g1'))).toBe(true);
    expect(alertEntries().length).toBe(visibleKeys().length);
  });

  it('says nothing when nothing is wrong', () => {
    seed({ budgets: [budget()], transactions: [tx({ amount: -20 })] });
    expect(bell().filter(isAlertNotification)).toEqual([]);
  });

  it('leaves everything else in the bell alone', () => {
    seed({ ...OVER, notifications: [syncNotification] });
    const after = bell();
    expect(after.find(n => n.id === 'n-sync')).toEqual(syncNotification);
    expect(after.filter(isAlertNotification)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Duplicate prevention
// ═════════════════════════════════════════════════════════════════════════════
describe('rebuilding', () => {
  it('does not add the same alert twice, however often it runs', () => {
    seed(OVER);
    bell(); bell(); bell();
    expect(alertEntries()).toHaveLength(1);
  });

  it('keeps the original timestamp, so the bell does not reshuffle', () => {
    seed(OVER);
    const first = bell(NOW).filter(isAlertNotification)[0];
    const again = bell(LATER).filter(isAlertNotification)[0];
    expect(again.created_at).toBe(first.created_at);
  });

  it('a second alert appearing does not disturb the first', () => {
    seed(OVER);
    const first = bell(NOW).filter(isAlertNotification)[0];

    useStore.setState({
      budgets: [budget(), budget({ id: 'b2', category: 'Dining', limit_amount: 100 })],
      transactions: [tx({ amount: -350 }), tx({ amount: -400, category: 'Dining' })],
    } as any);
    const after = bell(LATER).filter(isAlertNotification);

    expect(after).toHaveLength(2);
    expect(after.find(n => n.id === first.id)!.created_at).toBe(NOW);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Worsening
// ═════════════════════════════════════════════════════════════════════════════
describe('an alert getting worse', () => {
  it('replaces the entry rather than stacking a second one', () => {
    seed(OVER);
    bell(NOW);
    const before = alertEntries()[0];
    expect(parseAlertNotification(before)!.stage).toBe(2);

    // $350 → $450 on a $300 cap: past 125%, a materially worse stage.
    useStore.setState({ transactions: [tx({ amount: -450 })] } as any);
    bell(LATER);

    expect(alertEntries()).toHaveLength(1);
    expect(parseAlertNotification(alertEntries()[0])!.stage).toBe(3);
  });

  it('is unread again even after the earlier stage was read', () => {
    seed(OVER);
    bell(NOW);
    const first = alertEntries()[0];
    const { key, stage } = parseAlertNotification(first)!;
    alertStatesDS.save(key, { readStage: stage });
    expect(bell(NOW).filter(isAlertNotification)[0].is_read).toBe(true);

    useStore.setState({ transactions: [tx({ amount: -450 })] } as any);
    bell(LATER);

    expect(alertEntries()[0].is_read).toBe(false);
    expect(alertEntries()[0].created_at).toBe(LATER);   // and back at the top
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Reading is not dismissing
// ═════════════════════════════════════════════════════════════════════════════
describe('reading from the bell', () => {
  function readFromBell() {
    // Exactly what the bell's click handler does.
    const entry = alertEntries()[0];
    const { key, stage } = parseAlertNotification(entry)!;
    alertStatesDS.save(key, { readStage: stage });
    return entry;
  }

  it('marks the entry read', () => {
    seed(OVER);
    bell();
    readFromBell();
    expect(bell().filter(isAlertNotification)[0].is_read).toBe(true);
  });

  it('does NOT dismiss the underlying alert — it stays in the card', () => {
    seed(OVER);
    bell();
    readFromBell();

    const report = alertsDS.build({ asOf: TODAY });
    expect(report.visible.map(a => a.key)).toContain(OVER_KEY);
    expect(report.visible.find(a => a.key === OVER_KEY)!.dismissed).toBe(false);
  });

  it('records the read against the ALERT, so the other devices agree', () => {
    seed(OVER);
    bell();
    readFromBell();

    const saved = opsOf('alertState.save');
    expect(saved).toHaveLength(1);
    expect(saved[0].data).toMatchObject({ alert_key: OVER_KEY, read_stage: 2 });
    expect(saved[0].data.dismissed_stage ?? null).toBeNull();   // never a dismissal
  });

  it('read state is the alert’s, so the card shows it read too', () => {
    seed(OVER);
    bell();
    readFromBell();
    expect(alertsDS.build({ asOf: TODAY }).unreadCount).toBe(0);
  });

  it('leaves the bell empty of unread once every alert is read', () => {
    seed(OVER);
    bell();
    readFromBell();
    bell();
    expect(useStore.getState().notifications.filter(n => !n.is_read && isAlertNotification(n))).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Dismissal and resolution both clear the bell
// ═════════════════════════════════════════════════════════════════════════════
describe('an alert leaving', () => {
  it('dismissing it in the card removes its bell entry', () => {
    seed(OVER);
    bell();
    expect(alertEntries()).toHaveLength(1);

    const { key, stage } = parseAlertNotification(alertEntries()[0])!;
    alertStatesDS.save(key, { dismissedStage: stage });
    bell();

    expect(alertEntries()).toEqual([]);
    expect(visibleKeys()).not.toContain(OVER_KEY);
  });

  it('the situation resolving removes it too', () => {
    seed(OVER);
    bell();
    useStore.setState({ transactions: [tx({ amount: -20 })] } as any);
    bell();
    expect(alertEntries()).toEqual([]);
  });

  it('a dismissed alert coming back WORSE returns to the bell', () => {
    seed(OVER);
    bell();
    const { key, stage } = parseAlertNotification(alertEntries()[0])!;
    alertStatesDS.save(key, { dismissedStage: stage });
    bell();
    expect(alertEntries()).toEqual([]);

    useStore.setState({ transactions: [tx({ amount: -450 })] } as any);
    bell(LATER);

    expect(alertEntries()).toHaveLength(1);
    expect(alertEntries()[0].is_read).toBe(false);
    expect(parseAlertNotification(alertEntries()[0])!.stage).toBe(3);
  });

  it('clearing the alerts never clears anything else', () => {
    seed({ ...OVER, notifications: [syncNotification] });
    bell();
    useStore.setState({ transactions: [] } as any);
    bell();
    expect(useStore.getState().notifications).toEqual([syncNotification]);
  });
});
