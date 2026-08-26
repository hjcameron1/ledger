import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/api';
import { DEMO_LOGIN_ENABLED, DEMO_TOKEN, DEMO_USER } from '../config/demo';
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
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resendMsg, setResendMsg] = useState('');
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
    setCode('');
    setResendMsg('');
  };

  // Verify the 6-digit code the user received by email. On success the backend
  // returns a token + user, logging them straight in (the useEffect redirects).
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResendMsg('');
    setVerifying(true);
    try {
      const data = await authApi.verifyEmail({ email, code: code.trim() });
      setAuth(data.user, data.token);
      if (data.user.theme) setTheme(data.user.theme);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Invalid or expired code. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setResendMsg('');
    try {
      await authApi.resendVerification({ email });
      setResendMsg('A new code is on its way — check your inbox.');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Could not resend the code. Please try again shortly.');
    }
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
      const body = (err as { response?: { data?: { error?: string; requiresVerification?: boolean } } })?.response?.data;
      // Correct password, unverified email: the backend refused the session and
      // emailed a fresh code — drop into the same verify screen registration uses.
      if (body?.requiresVerification) {
        setVerificationSent(true);
        setResendMsg('We emailed you a new verification code — enter it below.');
        return;
      }
      setError(body?.error ?? 'Something went wrong. Please try again.');
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
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="m22 7-10 7L2 7"/>
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-3">Enter your code</h2>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed mb-6">
              We emailed a verification code to{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{email}</span>.
              <br className="mb-1" />
              Enter it below to activate your account.
            </p>

            <form onSubmit={handleVerify} className="space-y-4">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Verification code"
                maxLength={10}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="Enter code"
                autoFocus
                className="w-full text-center tracking-[0.3em] text-2xl font-semibold py-3 rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 focus:border-brand focus:outline-none"
              />

              {error && (
                <div role="alert" className="bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-[8px] px-3 py-2 text-sm text-[#ef4444]">
                  {error}
                </div>
              )}
              {resendMsg && (
                <div role="status" className="bg-brand/10 border border-brand/20 rounded-[8px] px-3 py-2 text-sm text-brand">
                  {resendMsg}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                fullWidth
                loading={verifying}
                size="lg"
                disabled={code.length < 6}
              >
                Verify &amp; continue
              </Button>
            </form>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-6">
              Didn't get it? Check spam, or{' '}
              <button onClick={handleResend} className="text-brand hover:underline">
                resend the code
              </button>.
            </p>
            <button
              onClick={() => { setVerificationSent(false); setError(''); setResendMsg(''); setCode(''); }}
              className="text-sm text-brand hover:underline mt-4"
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
            aria-pressed={mode === 'login'}
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
            aria-pressed={mode === 'register'}
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
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <Input
                label="Full name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your full name"
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
              <div role="alert" className="bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-[8px] px-3 py-2 text-sm text-[#ef4444]">
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

        {/* Demo / test shortcut — a local-only session with no server account.
            Gated by DEMO_LOGIN_ENABLED (config/demo.ts): flip it off before
            launch and this whole block disappears. */}
        {DEMO_LOGIN_ENABLED && (
          <div className="mt-4">
            <button
              onClick={() => setAuth(DEMO_USER, DEMO_TOKEN)}
              className="w-full py-2.5 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-[8px] hover:border-brand/40 transition-all"
            >
              Skip for now — explore in demo mode
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
