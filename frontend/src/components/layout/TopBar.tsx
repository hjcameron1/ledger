import { useStore } from '../../store';
import { overviewApi } from '../../services/api';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface TopBarProps {
  onCustomise?: () => void;
}

export default function TopBar({ onCustomise }: TopBarProps) {
  const {
    notifications, setNotifications,
    notificationsOpen, setNotificationsOpen,
    setQuickAddOpen,
    user,
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
    <header className="sticky top-0 z-30 bg-white/90 dark:bg-[#0f0f0f]/90 backdrop-blur-md border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
      <div className="max-w-[1280px] mx-auto px-4 h-14 flex items-center justify-between gap-4">
        {/* Left: Bell */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setNotificationsOpen(!notificationsOpen)}
            className="relative w-9 h-9 flex items-center justify-center rounded-full hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a] transition-colors"
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
          {onCustomise && (
            <button
              onClick={onCustomise}
              className="hidden sm:flex items-center gap-1.5 text-xs text-[#6b6b6b] dark:text-[#a0a0a0] hover:text-[#0f0f0f] dark:hover:text-[#f5f5f5] transition-colors px-2 py-1 rounded-[6px] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
              Customise
            </button>
          )}
        </div>

        {/* Centre: Logo */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <span className="text-[#3b7dd8] font-semibold text-xl tracking-wide select-none">
            Ledger
          </span>
        </div>

        {/* Right: Quick Add + Avatar */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQuickAddOpen(true)}
            className="flex items-center gap-1.5 text-sm font-medium text-[#3b7dd8]
              border border-[#3b7dd8]/30 hover:border-[#3b7dd8] hover:bg-[#3b7dd8]/5
              px-3 py-1.5 rounded-[8px] transition-all duration-150"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span className="hidden sm:inline">Quick Add</span>
          </button>

          {user && (
            <div className="w-8 h-8 rounded-full bg-[#3b7dd8] flex items-center justify-center text-white text-sm font-semibold">
              {user.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      </div>

      {/* Notifications panel */}
      {notificationsOpen && (
        <NotificationsPanel onClose={() => setNotificationsOpen(false)} />
      )}
    </header>
  );
}

function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { notifications, setNotifications, setOpenRecurringModal } = useStore();
  const navigate = useNavigate();

  const markAllRead = async () => {
    await overviewApi.markAllRead();
    setNotifications(notifications.map(n => ({ ...n, is_read: true })));
  };

  return (
    <>
    {/* Click-anywhere-else backdrop: closes the panel without blocking visibility */}
    <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
    <div
      className="absolute top-full left-4 w-80 bg-white dark:bg-[#1a1a1a] rounded-[12px]
        border border-[#e5e5e5] dark:border-[#2a2a2a] shadow-2xl z-50 overflow-hidden"
      style={{ animation: 'slideDown 150ms ease' }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
        <h3 className="font-semibold text-sm">Notifications</h3>
        <button onClick={markAllRead} className="text-xs text-[#3b7dd8] hover:underline">
          Mark all read
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto divide-y divide-[#e5e5e5] dark:divide-[#2a2a2a]">
        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
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
                className={`px-4 py-3 text-sm ${n.is_read ? 'opacity-60' : ''} ${clickable ? 'cursor-pointer hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors' : ''}`}
                onClick={handleClick}
              >
                <p className="text-[#0f0f0f] dark:text-[#f5f5f5]">{n.message}</p>
                {n.detail && (
                  <p className="text-xs text-[#92600a] dark:text-[#f5d98a] mt-0.5">{n.detail}</p>
                )}
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">
                  {new Date(n.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </p>
              </div>
            );
          })
        )}
      </div>
      <div className="px-4 py-2 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
        <button onClick={onClose} className="text-xs text-[#6b6b6b] hover:text-[#0f0f0f] dark:hover:text-[#f5f5f5]">Close</button>
      </div>
    </div>
    </>
  );
}
