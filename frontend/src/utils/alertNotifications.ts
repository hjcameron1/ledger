/**
 * Phase 4.4 alerts → the notification bell (pure rules).
 *
 * The bell is a SECOND WINDOW onto the alerts, never a second copy of them.
 * "Needs your attention" on the Overview is still where a financial alert is
 * read, actioned and dismissed; this is what makes one show up in the top-right
 * bell so it is noticed from any page.
 *
 * Everything here follows from that being a window:
 *
 *  • The bell's entries are DERIVED from the alert list on every rebuild, so
 *    they cannot drift from it, accumulate, or outlive the situation. An alert
 *    that resolves or is dismissed takes its bell entry with it.
 *  • Read state is the ALERT's read stage — the same field the Overview card
 *    uses — so reading in one place is read in both, and on every device.
 *    Reading is not dismissing: the alert stays in the card either way.
 *  • The id is derived from the alert's own key AND stage, which is what
 *    prevents duplicates (same alert, same severity → same id → one entry) and
 *    what makes worsening count as news (new stage → new id → unread again,
 *    dated now, back at the top).
 *
 * Pure: no store, no clock, no currency. The caller passes the sentence and the
 * timestamp in.
 */

import type { Notification } from '../types';

/** The `type` every bell entry that came from an alert carries. */
export const ALERT_NOTIFICATION_TYPE = 'alert';

/** The parts of an `Alert` (utils/alerts.ts) the bell needs. */
export interface AlertNotificationSource {
  key: string;
  stage: number;
  unread: boolean;
  title: string;
  link: { to: string; label: string };
}

/**
 * The bell id for an alert at a stage.
 *
 * Stage comes FIRST because an alert key contains colons of its own
 * (`budget-limit:2026-08:groceries`) — putting the stage in front keeps the id
 * parseable back into its two halves from the left.
 */
export function alertNotificationId(key: string, stage: number): string {
  return `${ALERT_NOTIFICATION_TYPE}:${stage}:${key}`;
}

/** True for a bell entry this module owns. */
export function isAlertNotification(n: Pick<Notification, 'id' | 'type'>): boolean {
  return n.type === ALERT_NOTIFICATION_TYPE && n.id.startsWith(`${ALERT_NOTIFICATION_TYPE}:`);
}

/**
 * The alert key and stage behind a bell entry — what the click handler needs to
 * record "read" against the alert itself. Null for anything else in the bell.
 */
export function parseAlertNotification(
  n: Pick<Notification, 'id' | 'type'>,
): { key: string; stage: number } | null {
  if (!isAlertNotification(n)) return null;
  const rest = n.id.slice(ALERT_NOTIFICATION_TYPE.length + 1);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const stage = Number(rest.slice(0, sep));
  const key = rest.slice(sep + 1);
  if (!Number.isFinite(stage) || !key) return null;
  return { key, stage };
}

/**
 * One bell entry per alert, carrying the alert's own read state.
 *
 * `describe` supplies the second line (the engine decides which figures may be
 * quoted; the caller formats them in the user's currency). `now` stamps
 * genuinely new entries — an entry that already exists at the same stage keeps
 * its original time, so the bell doesn't reshuffle itself on every rebuild.
 */
export function buildAlertNotifications<T extends AlertNotificationSource>(
  alerts: T[],
  describe: (alert: T) => string,
  now: string,
  existing: Notification[] = [],
): Notification[] {
  const seen = new Map(existing.filter(isAlertNotification).map(n => [n.id, n]));
  return alerts.map(a => {
    const id = alertNotificationId(a.key, a.stage);
    return {
      id,
      type: ALERT_NOTIFICATION_TYPE,
      message: a.title,
      detail: describe(a),
      link: a.link.to,
      // The alert's read stage is the only read state there is.
      is_read: !a.unread,
      created_at: seen.get(id)?.created_at ?? now,
    };
  });
}

/**
 * Put the derived alert entries back into the bell alongside everything else.
 *
 * The alert-owned entries are REPLACED wholesale rather than merged one by one:
 * anything previously in the bell for an alert that is no longer raised is gone,
 * which is how a resolved or dismissed alert stops nagging. Non-alert entries
 * (sync failures, recurring prompts, anything from the server) are untouched.
 * Newest first, so a worsening alert surfaces at the top.
 */
export function mergeAlertNotifications(
  existing: Notification[],
  alertEntries: Notification[],
): Notification[] {
  const others = existing.filter(n => !isAlertNotification(n));
  return [...others, ...alertEntries].sort((a, b) => {
    const t = (b.created_at ?? '').localeCompare(a.created_at ?? '');
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
}

/**
 * The bell's whole contents after an alert rebuild: derive the alert entries,
 * put them back among everything else. This is the ONE composition the app
 * uses — the hook calls it, and so do the tests, so there is no second version
 * of "what the bell should now say" to drift.
 */
export function syncAlertNotifications<T extends AlertNotificationSource>(
  existing: Notification[],
  alerts: T[],
  describe: (alert: T) => string,
  now: string,
): Notification[] {
  return mergeAlertNotifications(existing, buildAlertNotifications(alerts, describe, now, existing));
}

/**
 * Whether a rebuild actually changed anything the bell shows.
 *
 * The bridge runs on every alert rebuild; without this it would write an
 * identical list back into the store and re-render the whole app for nothing.
 */
export function sameNotifications(a: Notification[], b: Notification[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => {
    const m = b[i];
    return n.id === m.id && n.is_read === m.is_read && n.message === m.message
      && (n.detail ?? '') === (m.detail ?? '') && (n.link ?? '') === (m.link ?? '')
      && n.created_at === m.created_at;
  });
}
