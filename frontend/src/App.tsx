import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from './store';
import { bootstrapData } from './services/dataService';
import Overview from './pages/Overview';
import Accounts from './pages/Accounts';
import Investments from './pages/Investments';
import Income from './pages/Income';
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

export default function App() {
  const { theme, user, token } = useStore();

  // Apply theme class whenever it changes
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
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
        <Route path="/income" element={<ProtectedRoute><Income /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
