import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/api';
import { useStore } from '../store';
import Button from '../components/common/Button';
import Input from '../components/common/Input';

type Mode = 'login' | 'register';

export default function Login({ defaultMode = 'login' }: { defaultMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verificationSent, setVerificationSent] = useState(false);
  const { setAuth, setTheme, user, token } = useStore();
  const navigate = useNavigate();

  // Redirect once auth is set
  useEffect(() => {
    if (user && token) {
      navigate(user.onboarding_complete ? '/' : '/onboarding', { replace: true });
    }
  }, [user, token, navigate]);

  // Reset error when switching modes
  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setVerificationSent(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const data = await authApi.login({ email, password });
        setAuth(data.user, data.token);
        if (data.user.theme) setTheme(data.user.theme);
      } else {
        const data = await authApi.register({ email, password, name });
        if ((data as { requiresVerification?: boolean }).requiresVerification) {
          // Backend sent a verification email — show the check-your-email screen
          setVerificationSent(true);
        } else {
          // Supabase auto-confirmed the user (email confirmation disabled in dashboard)
          setAuth(data.user, data.token);
          if (data.user.theme) setTheme(data.user.theme);
        }
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Email verification sent screen ─────────────────────────────────────────
  if (verificationSent) {
    return (
      <div className="min-h-screen bg-white dark:bg-zinc-900 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-10">
            <h1 className="text-brand font-semibold text-3xl tracking-wide mb-2">Ledger</h1>
          </div>
          <div className="card p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-brand/10 flex items-center justify-center mx-auto mb-6">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="m22 7-10 7L2 7"/>
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-3">Check your email</h2>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed mb-6">
              We sent a verification link to{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{email}</span>.
              <br className="mb-1" />
              Click it to activate your account and you'll be taken straight to setup.
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-6">
              Didn't receive it? Check your spam folder.
            </p>
            <button
              onClick={() => { setVerificationSent(false); setError(''); }}
              className="text-sm text-brand hover:underline"
            >
              ← Back to sign up
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main login / register form ──────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-900 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-brand font-semibold text-3xl tracking-wide mb-2">Ledger</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Your personal finance dashboard</p>
        </div>

        {/* Mode tabs — prominently visible */}
        <div className="flex rounded-[10px] bg-zinc-100 dark:bg-zinc-900 p-1 mb-6 gap-1">
          <button
            onClick={() => switchMode('login')}
            className={`flex-1 py-2 text-sm font-medium rounded-[8px] transition-all ${
              mode === 'login'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            Sign in
          </button>
          <button
            onClick={() => switchMode('register')}
            className={`flex-1 py-2 text-sm font-medium rounded-[8px] transition-all ${
              mode === 'register'
                ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            Create account
          </button>
        </div>

        <div className="card p-6">
          {/* OAuth — placeholders */}
          <div className="space-y-2 mb-6">
            <button className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-[8px] border border-zinc-200 dark:border-zinc-800 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>
            <button className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-[8px] border border-zinc-200 dark:border-zinc-800 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
              <svg width="18" height="18" viewBox="0 0 814 1000" fill="currentColor">
                <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.7 0 663 0 541.8c0-194.3 127.4-297.5 252.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/>
              </svg>
              Continue with Apple
            </button>
          </div>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-zinc-200 dark:border-zinc-800"/>
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white dark:bg-zinc-900 px-2 text-xs text-zinc-500 dark:text-zinc-400">or</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <Input
                label="Full name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Harry Cameron"
                required
                autoComplete="name"
              />
            )}
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'register' && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Password must be at least 8 characters.
              </p>
            )}

            {error && (
              <div className="bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-[8px] px-3 py-2 text-sm text-[#ef4444]">
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={loading}
              size="lg"
            >
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </div>

        {/* Demo shortcut */}
        <div className="mt-4">
          <button
            onClick={() => {
              const demoUser = {
                id: 'demo', email: 'demo@ledger.app', name: 'Harry',
                currency_preference: 'AUD', theme: 'light' as const,
                plan: 'premium' as const, onboarding_complete: true,
              };
              setAuth(demoUser, 'demo-token');
            }}
            className="w-full py-2.5 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-[8px] hover:border-brand/40 transition-all"
          >
            Skip for now — explore the app
          </button>
        </div>
      </div>
    </div>
  );
}
