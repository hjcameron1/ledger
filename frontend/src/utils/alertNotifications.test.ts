import { describe, it, expect } from 'vitest';
import {
  ALERT_NOTIFICATION_TYPE, alertNotificationId, isAlertNotification,
  parseAlertNotification, buildAlertNotifications, mergeAlertNotifications,
  syncAlertNotifications, sameNotifications,
  type AlertNotificationSource,
} from './alertNotifications';
import type { Notification } from '../types';

/**
 * The bell is a window onto the Phase 4.4 alerts, not a copy of them. These
 * prove the four properties that makes true: one entry per alert, a worse
 * stage counts as news, read state comes from the alert, and an alert that
 * stops being raised takes its entry with it.
 */

const NOW = '2026-08-17T09:00:00.000Z';
const EARLIER = '2026-08-15T09:00:00.000Z';

const alert = (o: Partial<AlertNotificationSource> = {}): AlertNotificationSource => ({
  key: 'budget-limit:2026-08:groceries',
  stage: 1,
  unread: true,
  title: 'Groceries is near its limit',
  link: { to: '/?focus=budget:groceries', label: 'View budget' },
  ...o,
});

const describe_ = () => 'A short sentence about the money.';

const other = (o: Partial<Notification> = {}): Notification => ({
  id: 'n-sync', type: 'sync', message: 'Some data is waiting to sync',
  is_read: false, created_at: EARLIER, ...o,
});

describe('the id carries the alert’s own identity', () => {
  it('is built from the alert key and stage', () => {
    expect(alertNotificationId('cash-low', 2)).toBe('alert:2:cash-low');
  });

  it('round-trips a key that contains colons of its own', () => {
    const key = 'budget-limit:2026-08:groceries';
    const id = alertNotificationId(key, 3);
    expect(parseAlertNotification({ id, type: ALERT_NOTIFICATION_TYPE })).toEqual({ key, stage: 3 });
  });

  it('does not claim notifications it did not create', () => {
    expect(isAlertNotification(other())).toBe(false);
    expect(parseAlertNotification(other())).toBeNull();
    expect(parseAlertNotification({ id: 'alert:', type: ALERT_NOTIFICATION_TYPE })).toBeNull();
    expect(parseAlertNotification({ id: 'alert:x:key', type: ALERT_NOTIFICATION_TYPE })).toBeNull();
  });
});

describe('building the bell entries from alerts', () => {
  it('one entry per alert, carrying its message, sentence and deep link', () => {
    const [n] = buildAlertNotifications([alert()], describe_, NOW);
    expect(n).toEqual({
      id: 'alert:1:budget-limit:2026-08:groceries',
      type: 'alert',
      message: 'Groceries is near its limit',
      detail: 'A short sentence about the money.',
      link: '/?focus=budget:groceries',
      is_read: false,
      created_at: NOW,
    });
  });

  it('unread comes from the ALERT, never from the bell', () => {
    expect(buildAlertNotifications([alert({ unread: false })], describe_, NOW)[0].is_read).toBe(true);
    expect(buildAlertNotifications([alert({ unread: true })], describe_, NOW)[0].is_read).toBe(false);
  });

  it('rebuilding does not duplicate — same alert, same stage, same id', () => {
    const first = buildAlertNotifications([alert()], describe_, EARLIER);
    const second = buildAlertNotifications([alert()], describe_, NOW, first);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
  });

  it('an unchanged entry keeps its original time, so the bell does not reshuffle', () => {
    const first = buildAlertNotifications([alert()], describe_, EARLIER);
    const second = buildAlertNotifications([alert()], describe_, NOW, first);
    expect(second[0].created_at).toBe(EARLIER);
  });

  it('a WORSE stage is a new entry, dated now', () => {
    const first = buildAlertNotifications([alert({ stage: 1, unread: false })], describe_, EARLIER);
    const worse = buildAlertNotifications([alert({ stage: 2 })], describe_, NOW, first);
    expect(worse[0].id).not.toBe(first[0].id);
    expect(worse[0].created_at).toBe(NOW);
    expect(worse[0].is_read).toBe(false);      // news again
  });
});

describe('merging into the rest of the bell', () => {
  it('leaves sync and recurring notifications alone', () => {
    const merged = mergeAlertNotifications(
      [other(), other({ id: 'n-rec', type: 'recurring', created_at: NOW })],
      buildAlertNotifications([alert()], describe_, NOW),
    );
    expect(merged.filter(n => !isAlertNotification(n)).map(n => n.id)).toEqual(['n-rec', 'n-sync']);
    expect(merged.filter(isAlertNotification)).toHaveLength(1);
  });

  it('an alert that is no longer raised loses its entry', () => {
    const withAlert = mergeAlertNotifications([other()], buildAlertNotifications([alert()], describe_, NOW));
    expect(withAlert.filter(isAlertNotification)).toHaveLength(1);

    const resolved = mergeAlertNotifications(withAlert, buildAlertNotifications([], describe_, NOW));
    expect(resolved.filter(isAlertNotification)).toEqual([]);
    expect(resolved.map(n => n.id)).toEqual(['n-sync']);   // everything else survives
  });

  it('replaces the old stage rather than stacking a second entry for one alert', () => {
    const first = syncAlertNotifications([], [alert({ stage: 1 })], describe_, EARLIER);
    const second = syncAlertNotifications(first, [alert({ stage: 2 })], describe_, NOW);
    expect(second.filter(isAlertNotification)).toHaveLength(1);
    expect(parseAlertNotification(second[0])!.stage).toBe(2);
  });

  it('newest first, so a worsening alert surfaces at the top', () => {
    const merged = syncAlertNotifications([other()], [alert()], describe_, NOW);
    expect(merged.map(n => n.id)).toEqual(['alert:1:budget-limit:2026-08:groceries', 'n-sync']);
  });

  it('several alerts each get their own entry', () => {
    const merged = syncAlertNotifications([], [
      alert(),
      alert({ key: 'cash-low', stage: 2, title: 'Cash running low', link: { to: '/forecast', label: 'View forecast' } }),
    ], describe_, NOW);
    expect(merged).toHaveLength(2);
    expect(merged.map(n => n.link)).toContain('/forecast');
  });
});

describe('sameNotifications — the guard against pointless re-renders', () => {
  it('true when a rebuild changed nothing', () => {
    const a = syncAlertNotifications([other()], [alert()], describe_, NOW);
    const b = syncAlertNotifications(a, [alert()], describe_, NOW);
    expect(sameNotifications(a, b)).toBe(true);
  });

  it('false when the alert became read', () => {
    const a = syncAlertNotifications([], [alert({ unread: true })], describe_, NOW);
    const b = syncAlertNotifications(a, [alert({ unread: false })], describe_, NOW);
    expect(sameNotifications(a, b)).toBe(false);
  });

  it('false when an alert appears or resolves', () => {
    const a = syncAlertNotifications([], [alert()], describe_, NOW);
    expect(sameNotifications(a, syncAlertNotifications(a, [], describe_, NOW))).toBe(false);
  });
});
