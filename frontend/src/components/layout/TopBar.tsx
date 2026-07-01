import { useStore } from '../../store';
import { overviewApi } from '../../services/api';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

// Standalone notifications bell, FIXED in the top-right corner of the viewport at
// all times (there is no header action bar any more). Clicking it toggles the
// dropdown panel, which anchors directly beneath the bell.
export default function NotificationBell() {
  const {
    notifications, setNotifications,
    notificationsOpen, setNotificationsOpen,
  } = useStore();

  const unread = notifications.filter(n => !n.is_read).length;

  useEffect(() => {
    overviewApi.getNotifications()
      .then((server) => {
        const serverArr = (server as typeof notifications) ?? [];
        const serverIds = new Set(serverArr.map(n => n.id));
        // Preserve client-only notifications (sync failures, recurring prompts) that
        // live solely in the local store — the server doesn't know about them and
        // they must persist until the user dismisses them.
        const clientOnly = useStore.getState().notifications
          .filter(n => (n.type === 'sync' || n.type === 'recurring') && !serverIds.has(n.id));
        setNotifications([...clientOnly, ...serverArr]);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNotifications]);

  return (
    <div className="fixed top-3 right-3 sm:right-4 z-40">
      <button
        onClick={() => setNotificationsOpen(!notificationsOpen)}
        className="relative w-9 h-9 flex items-center justify-center rounded-full bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shadow-sm"
        aria-label="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-[#ef4444] text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {notificationsOpen && (
        <NotificationsPanel onClose={() => setNotificationsOpen(false)} />
      )}
    </div>
  );
}

function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { notifications, setNotifications, setOpenRecurringModal } = useStore();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close when clicking/tapping anywhere outside the panel. Uses a document-level
  // listener (not a backdrop div) so it isn't trapped inside the sticky bar's
  // stacking context. Deferred one tick so the opening click doesn't immediately close it.
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const bell = document.querySelector('[aria-label="Notifications"]');
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          !(bell && bell.contains(e.target as Node))) {
        onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener('mousedown', handle), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handle); };
  }, [onClose]);

  const markAllRead = async () => {
    await overviewApi.markAllRead();
    setNotifications(notifications.map(n => ({ ...n, is_read: true })));
  };

  return (
    <div
      ref={panelRef}
      className="absolute top-full right-0 mt-2 w-80 bg-white dark:bg-zinc-900 rounded-[12px]
        border border-zinc-200 dark:border-zinc-800 shadow-2xl z-50 overflow-hidden"
      style={{ animation: 'slideDown 150ms ease' }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <h3 className="font-semibold text-sm">Notifications</h3>
        <button onClick={markAllRead} className="text-xs text-brand hover:underline">
          Mark all read
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto divide-y divide-zinc-200 dark:divide-zinc-800">
        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            All caught up!
          </div>
        ) : (
          notifications.slice(0, 20).map(n => {
            const clickable = n.type === 'recurring' || !!n.link;
            const handleClick = clickable ? () => {
              setNotifications(notifications.map(x => x.id === n.id ? { ...x, is_read: true } : x));
              if (n.type === 'recurring') {
                setOpenRecurringModal(true);
                navigate('/accounts?tab=subscriptions');
              } else if (n.link) {
                navigate(n.link);
              }
              onClose();
            } : undefined;
            return (
              <div
                key={n.id}
                className={`px-4 py-3 text-sm ${n.is_read ? 'opacity-60' : ''} ${clickable ? 'cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors' : ''}`}
                onClick={handleClick}
              >
                <p className="text-zinc-900 dark:text-zinc-100">{n.message}</p>
                {n.detail && (
                  <p className="text-xs text-[#92600a] dark:text-[#f5d98a] mt-0.5">{n.detail}</p>
                )}
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {new Date(n.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </p>
              </div>
            );
          })
        )}
      </div>
      <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-800">
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Close</button>
      </div>
    </div>
  );
}
