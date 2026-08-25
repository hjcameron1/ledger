import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useStore } from './store';
import { bootstrapData } from './services/dataService';
import { setDisplayTimeZone } from './utils/format';
import { retryPendingSyncNow } from './services/syncQueue';
import { useRecurringDetection } from './hooks/useRecurringDetection';
import { useAlertNotifications } from './hooks/useAlertNotifications';
import { applyTheme, subscribeSystemTheme } from './utils/theme';
import HouseholdApprovals from './components/common/HouseholdApprovals';
import Overview from './pages/Overview';
import Forecast from './pages/Forecast';
import Ask from './pages/Ask';
import Accounts from './pages/Accounts';
import Investments from './pages/Investments';
import Income from './pages/Income';
import Loans from './pages/Loans';
import Tax from './pages/Tax';
import Documents from './pages/Documents';
import Insurance from './pages/Insurance';
import More from './pages/More';
import Settings from './pages/Settings';
import Login from './pages/Login';
import Onboarding from './pages/Onboarding';
import AuthCallback from './pages/AuthCallback';

// Redirects unauthenticated users to /login.
// Zustand's persist middleware reads localStorage synchronously before the
// first render, so user/token are immediately available — no flash occurs.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useStore();
  if (!user || !token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

// Always-mounted (when logged in) host for the global recurring-payment detector.
// Renders nothing — it just keeps detection running regardless of the active route.
function RecurringDetector() {
  useRecurringDetection();
  return null;
}

// Always-mounted (when logged in) bridge putting Phase 4.4 financial alerts in
// the notification bell. Renders nothing; the alerts themselves are still read
// and dismissed in "Needs your attention" on the Overview.
function AlertNotifier() {
  useAlertNotifications();
  return null;
}

// Small, non-blocking toast shown when a Supabase write couldn't sync. Auto-dismisses.
function SyncToast() {
  const syncToast = useStore((s) => s.syncToast);
  const setSyncToast = useStore((s) => s.setSyncToast);

  useEffect(() => {
    if (!syncToast) return;
    const t = setTimeout(() => setSyncToast(null), 5000);
    return () => clearTimeout(t);
  }, [syncToast, setSyncToast]);

  if (!syncToast) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2.5 rounded-[10px] bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium shadow-xl pointer-events-none">
      {syncToast}
    </div>
  );
}

// Subtle persistent banner shown while writes are waiting to sync. The retry button
// immediately replays every queued item, ignoring their per-load retry schedule.
function SyncBanner() {
  const pendingCount = useStore((s) => s.pendingSyncQueue.length);
  const [retrying, setRetrying] = useState(false);

  if (pendingCount === 0) return null;

  const retryNow = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryPendingSyncNow();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="fixed top-0 inset-x-0 z-[250] bg-[#fef3c7] dark:bg-[#3a2f12] border-b border-[#f0d488] dark:border-[#5a4a1e] text-[#92600a] dark:text-[#f5d98a]">
      <div className="max-w-[1280px] mx-auto px-4 py-1.5 flex items-center justify-center gap-3 text-xs font-medium">
        <span>Some data is waiting to sync — tap to retry now</span>
        <button
          onClick={retryNow}
          disabled={retrying}
          className="px-2.5 py-1 rounded-[6px] bg-[#92600a] text-white hover:bg-[#7a4f08] disabled:opacity-60 transition-colors"
        >
          {retrying ? 'Retrying…' : 'Retry now'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { theme, user, token } = useStore();

  // Apply the user's timezone preference to all date/time rendering app-wide.
  // Falls back to the browser zone when unset. Display-only — never affects
  // net-worth or investment values.
  useEffect(() => {
    setDisplayTimeZone(user?.timezone);
  }, [user?.timezone]);

  // Apply the theme whenever the preference changes. When it's 'system', also
  // re-resolve live as the device flips between light/dark appearance.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return subscribeSystemTheme(() => applyTheme('system'));
  }, [theme]);

  // Load fresh data from the backend whenever the user logs in
  useEffect(() => {
    if (user && token) {
      bootstrapData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Keep shared data current while the app stays open. Another household member
  // can edit a shared row at any moment, and their write lands on ONE row on the
  // server (never a copy) — this device just doesn't know until it refetches. So
  // refetch when the tab regains focus and on a slow heartbeat while it stays
  // open, throttled so tabbing in and out never storms the backend. The merge is
  // server-authoritative and offline-safe: bootstrapData() already reconciles
  // around the pending sync queue.
  useEffect(() => {
    if (!user || !token) return;
    let last = Date.now();
    const REFRESH_MIN_GAP_MS = 60_000;
    const refetch = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - last < REFRESH_MIN_GAP_MS) return;
      last = Date.now();
      bootstrapData();
    };
    const timer = window.setInterval(refetch, 5 * 60_000);
    window.addEventListener('focus', refetch);
    document.addEventListener('visibilitychange', refetch);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refetch);
      document.removeEventListener('visibilitychange', refetch);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, token]);

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {user && token && <RecurringDetector />}
      {user && token && <AlertNotifier />}
      {/* A household member changed/removed something of yours — the ask. */}
      {user && token && <HouseholdApprovals />}
      <SyncToast />
      {user && token && <SyncBanner />}
      <Routes>
        {/* Public — no auth required */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Login defaultMode="register" />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/onboarding" element={<Onboarding />} />

        {/* Protected — redirect to /login when not authenticated */}
        <Route path="/" element={<ProtectedRoute><Overview /></ProtectedRoute>} />
        <Route path="/forecast" element={<ProtectedRoute><Forecast /></ProtectedRoute>} />
        {/* Ask Ledger — questions, and what-if questions, over the same engines.
            The scenario builder that used to live at /scenarios folded in here:
            a hypothetical is a question, not a screen. */}
        <Route path="/ask" element={<ProtectedRoute><Ask /></ProtectedRoute>} />
        <Route path="/scenarios" element={<Navigate to="/ask" replace />} />
        <Route path="/accounts" element={<ProtectedRoute><Accounts /></ProtectedRoute>} />
        <Route path="/investments" element={<ProtectedRoute><Investments /></ProtectedRoute>} />
        <Route path="/loans" element={<ProtectedRoute><Loans /></ProtectedRoute>} />
        {/* Property now lives as a tab of Investments; keep the old path working
            for bookmarks and for links raised by the sync-failure notification. */}
        <Route path="/property" element={<Navigate to="/investments?tab=Property" replace />} />
        <Route path="/income" element={<ProtectedRoute><Income /></ProtectedRoute>} />
        <Route path="/tax" element={<ProtectedRoute><Tax /></ProtectedRoute>} />
        {/* Phase 8.1 — the document vault. */}
        <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
        <Route path="/insurance" element={<ProtectedRoute><Insurance /></ProtectedRoute>} />
        {/* Everything the peaceful view keeps off the four-tab bar. Reachable in
            both views — the technical strip simply doesn't need it. */}
        <Route path="/more" element={<ProtectedRoute><More /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
