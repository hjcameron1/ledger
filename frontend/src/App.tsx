import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useStore } from './store';
import { bootstrapData } from './services/dataService';
import { setDisplayTimeZone } from './utils/format';
import { retryPendingSyncNow } from './services/syncQueue';
import { useRecurringDetection } from './hooks/useRecurringDetection';
import { applyTheme, subscribeSystemTheme } from './utils/theme';
import Overview from './pages/Overview';
import Accounts from './pages/Accounts';
import Investments from './pages/Investments';
import Income from './pages/Income';
import Loans from './pages/Loans';
import Tax from './pages/Tax';
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

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {user && token && <RecurringDetector />}
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
        <Route path="/accounts" element={<ProtectedRoute><Accounts /></ProtectedRoute>} />
        <Route path="/investments" element={<ProtectedRoute><Investments /></ProtectedRoute>} />
        <Route path="/loans" element={<ProtectedRoute><Loans /></ProtectedRoute>} />
        <Route path="/income" element={<ProtectedRoute><Income /></ProtectedRoute>} />
        <Route path="/tax" element={<ProtectedRoute><Tax /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
