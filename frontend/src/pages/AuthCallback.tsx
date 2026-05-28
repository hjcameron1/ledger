import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import type { User } from '../types';

// Handles the redirect after a user clicks the Supabase verification email link.
// Supabase appends the access_token in the URL hash, e.g.:
//   /auth/callback#access_token=xxx&token_type=bearer&type=signup
//
// We extract that token, send it to our backend /api/auth/exchange, and get our
// custom JWT in return — then log the user in and send them to onboarding.

export default function AuthCallback() {
  const [status, setStatus] = useState<'processing' | 'error'>('processing');
  const [errorMsg, setErrorMsg] = useState('');
  const { setAuth, setTheme } = useStore();
  const navigate = useNavigate();

  useEffect(() => {
    // Parse the URL hash that Supabase appends after verification
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hash.get('access_token');

    if (!accessToken) {
      setStatus('error');
      setErrorMsg('Invalid verification link. Please try registering again.');
      return;
    }

    const base = import.meta.env.VITE_API_URL ?? '';
    fetch(`${base}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supabase_token: accessToken }),
    })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? 'Verification failed');
        }
        return r.json();
      })
      .then((data: { token: string; user: User }) => {
        setAuth(data.user, data.token);
        if (data.user.theme) setTheme(data.user.theme);
        navigate(data.user.onboarding_complete ? '/' : '/onboarding', { replace: true });
      })
      .catch((err: Error) => {
        setStatus('error');
        setErrorMsg(err.message ?? 'Something went wrong. Please try again.');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-white dark:bg-[#0f0f0f] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-[#3b7dd8] font-semibold text-3xl tracking-wide mb-8">Ledger</h1>

        {status === 'processing' ? (
          <div className="card p-8">
            <div className="w-10 h-10 border-2 border-[#3b7dd8] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Verifying your email…</p>
          </div>
        ) : (
          <div className="card p-8">
            <div className="w-12 h-12 rounded-full bg-[#ef4444]/10 flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </div>
            <h2 className="text-lg font-semibold mb-2">Verification failed</h2>
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-6">{errorMsg}</p>
            <a
              href="/register"
              className="inline-block px-4 py-2 rounded-[8px] bg-[#3b7dd8] text-white text-sm font-medium hover:bg-[#2d6bc7] transition-colors"
            >
              Back to sign up
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
