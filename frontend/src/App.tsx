import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from './store';
import Overview from './pages/Overview';
import Accounts from './pages/Accounts';
import Investments from './pages/Investments';
import Income from './pages/Income';
import Settings from './pages/Settings';
import Login from './pages/Login';

export default function App() {
  const { theme, setAuth } = useStore();

  // Only fall back to the demo user when there is genuinely no session.
  // Checking getState() instead of the hook value avoids a race with
  // Zustand's persist rehydration that would overwrite a real JWT.
  useEffect(() => {
    const { user, token } = useStore.getState();
    if (!user && !token) {
      setAuth(
        {
          id: 'demo',
          email: 'demo@ledger.app',
          name: 'Harry',
          currency_preference: 'AUD',
          theme: 'light',
          plan: 'premium',
          onboarding_complete: true,
        },
        'demo-token'
      );
    }
  }, []); // eslint-disable-line

  // Apply theme on change
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Overview />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/investments" element={<Investments />} />
        <Route path="/income" element={<Income />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
