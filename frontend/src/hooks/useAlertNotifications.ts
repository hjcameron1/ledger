import { useEffect } from 'react';
import { useStore } from '../store';
import { alertsDS } from '../services/dataService';
import { useAlerts } from './useAlerts';
import { describeAlert } from '../components/overview/AlertSection';
import { syncAlertNotifications, sameNotifications } from '../utils/alertNotifications';

/**
 * Puts Phase 4.4 alerts in the notification bell.
 *
 * Mounted once, app-wide, so a budget going over or the forecast dipping is
 * noticed from any page — not only when the Overview happens to be open. It
 * adds no alert logic of its own: the list comes from the same `useAlerts`
 * the "Needs your attention" card renders, and the bell entries are rewritten
 * from it on every rebuild. New alert or a worse stage → a new unread entry;
 * resolved or dismissed → its entry goes with it.
 *
 * Guarded on `ready()` for the same reason the prune is: on the first render
 * after a reload the store is empty, every alert looks resolved, and an
 * unguarded pass would wipe the bell before the data lands.
 */
export function useAlertNotifications(): void {
  const report = useAlerts();
  const currency = useStore(s => s.user?.currency_preference ?? 'AUD');

  useEffect(() => {
    if (!alertsDS.ready()) return;
    const store = useStore.getState();
    const merged = syncAlertNotifications(
      store.notifications,
      report.visible,
      a => describeAlert(a.facts, currency),
      new Date().toISOString(),
    );
    if (!sameNotifications(store.notifications, merged)) store.setNotifications(merged);
  }, [report, currency]);
}
