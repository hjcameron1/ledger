import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from './store';
import Overview from './pages/Overview';
import Accounts from './pages/Accounts';
import Investments from './pages/Investments';
import Income from './pages/Income';
import Settings from './pages/Settings';

export default function App() {
  const { theme, setAuth } = useStore();

  // Ensure a demo user is always set so the app works without login
  useEffect(() => {
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
  }, []);

  // Apply theme
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
