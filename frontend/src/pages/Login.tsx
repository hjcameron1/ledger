import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '../services/api';
import { useStore } from '../store';
import Button from '../components/common/Button';
import Input from '../components/common/Input';

type Mode = 'login' | 'register';

export default function Login() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { setAuth, setTheme, user, token } = useStore();
  const navigate = useNavigate();

  // Redirect as soon as auth state is set (handles React 18 batching delays)
  useEffect(() => {
    if (user && token) {
      navigate(user.onboarding_complete ? '/' : '/onboarding', { replace: true });
    }
  }, [user, token, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let data;
      if (mode === 'login') {
        data = await authApi.login({ email, password });
      } else {
        data = await authApi.register({ email, password, name });
      }

      setAuth(data.user, data.token);
      if (data.user.theme) setTheme(data.user.theme);
      // navigation handled by useEffect above
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-[#0f0f0f] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <h1 className="text-[#3b7dd8] font-semibold text-3xl tracking-wide mb-2">Ledger</h1>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
            {mode === 'login' ? 'Sign in to your account' : 'Create your free account'}
          </p>
        </div>

        <div className="card p-6">
          {/* OAuth */}
          <div className="space-y-2 mb-6">
            <button className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] text-sm font-medium hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>
            <button className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] text-sm font-medium hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors">
              <svg width="18" height="18" viewBox="0 0 814 1000" fill="currentColor">
                <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.7 0 663 0 541.8c0-194.3 127.4-297.5 252.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/>
              </svg>
              Continue with Apple
            </button>
          </div>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#e5e5e5] dark:border-[#2a2a2a]"/>
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white dark:bg-[#1a1a1a] px-2 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">or</span>
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

        <div className="mt-4">
          <button
            onClick={() => {
              const demoUser = {
                id: 'demo', email: 'demo@ledger.app', name: 'Harry',
                currency_preference: 'AUD', theme: 'light' as const,
                plan: 'premium' as const, onboarding_complete: true,
              };
              setAuth(demoUser, 'demo-token');
              // navigation handled by useEffect above
            }}
            className="w-full py-2.5 text-sm text-[#6b6b6b] dark:text-[#a0a0a0] hover:text-[#0f0f0f] dark:hover:text-[#f5f5f5] border border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[8px] hover:border-[#3b7dd8]/40 transition-all"
          >
            Skip for now — explore the app
          </button>
        </div>

        <p className="text-center mt-4 text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
          {mode === 'login' ? (
            <>Don't have an account?{' '}
              <button onClick={() => setMode('register')} className="text-[#3b7dd8] hover:underline font-medium">
                Sign up free
              </button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button onClick={() => setMode('login')} className="text-[#3b7dd8] hover:underline font-medium">
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
