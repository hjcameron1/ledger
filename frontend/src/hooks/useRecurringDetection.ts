import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { detectRecurringPatterns, isPatternSessionSkipped } from '../utils/recurringDetection';

/**
 * Global recurring-payment detection.
 *
 * This used to live inside Accounts.tsx as a useEffect, which meant detection
 * only ran while the Accounts route was mounted. It now lives here and is
 * mounted once at the top level (see App.tsx) so it runs regardless of which
 * page/tab the user is on.
 *
 * The detection ALGORITHM is unchanged — it only moved location. Local React
 * state/refs were swapped for the equivalent Zustand store fields so the result
 * (pendingPatterns + badge count + notification) is globally visible. The
 * Accounts page now only displays the modal/badge; it no longer runs detection.
 *
 * Only runs when detectionTick is explicitly bumped — i.e. when a new account
 * is added, a statement is uploaded, or the user clicks "Find recurring payments".
 * Does NOT run on app load, Basiq syncs, or individual transaction adds.
 */
export function useRecurringDetection(): void {
  const transactions = useStore((s) => s.transactions);
  const subscriptions = useStore((s) => s.subscriptions);
  const detectionTick = useStore((s) => s.detectionTick);

  // True once an auto-detection 0-result retry has fired (prevents infinite retry).
  const detectionRetriedRef = useRef(false);

  useEffect(() => {
    if (detectionTick === 0) return; // 0 = initial mount, skip detection
    if (transactions.length < 2) return;
    const timer = setTimeout(() => {
      const store = useStore.getState();
      // Don't restart queue if one is already visible
      if (store.recurringModalActive) {
        return;
      }
      // Consume the "show modal immediately" flag exactly ONCE per run. Capturing
      // and resetting it here prevents it from leaking into a later background run
      // (which would wrongly auto-open the modal instead of using the badge).
      const immediate = store.recurringShowImmediate;
      store.setRecurringShowImmediate(false);
      // detectRecurringPatterns already drops anything already tracked as a
      // subscription (by normalised name / original_name). The only remaining
      // filter is the current-session skip list — no permanent memory.
      const all = detectRecurringPatterns(store.transactions, store.subscriptions);
      const undismissed = all.filter(p => !isPatternSessionSkipped(p));
      if (undismissed.length > 0) {
        if (immediate) {
          // "Find recurring payments" button — queue the patterns and ask the
          // Accounts page to open the modal immediately via the existing flag.
          store.setPendingPatterns(undismissed);
          store.setPendingRecurringCount(undismissed.length);
          store.setOpenRecurringModal(true);
        } else {
          // Background detection (statement upload) — replace pending queue.
          store.setPendingPatterns(undismissed);
          store.setPendingRecurringCount(undismissed.length);
          const count = undismissed.length;
          const msg = `${count} recurring payment${count !== 1 ? 's' : ''} found — tap to review`;
          const newNotif = {
            id: crypto.randomUUID(),
            message: msg,
            type: 'recurring',
            is_read: false,
            created_at: new Date().toISOString(),
          };
          const withoutOldRecurring = store.notifications.filter(n => !(n.type === 'recurring' && !n.is_read));
          store.setNotifications([newNotif, ...withoutOldRecurring]);
        }
        detectionRetriedRef.current = false; // got results — clear retry guard
      } else {
        // 0 patterns found — the store sometimes needs an extra tick to settle.
        // Retry detection once immediately before giving up.
        if (!immediate && !detectionRetriedRef.current) {
          detectionRetriedRef.current = true;
          store.triggerDetection();
        } else {
          detectionRetriedRef.current = false;
        }
      }
    }, 800);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptions.length, detectionTick]);
}
