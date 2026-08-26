import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../utils/env';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';
import { z } from 'zod';

const router = Router();

// Supabase auth client with anon key — used only for triggering verification emails.
// This is separate from the service-role client used for database operations.
function getSupabaseAuthClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const { email, password, name } = parsed.data;

  // Check if already registered
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const password_hash = await bcrypt.hash(password, 12);
  const { data: user, error } = await supabase.from('users').insert({
    email,
    name,
    password_hash,
    currency_preference: 'AUD',
    theme: 'light',
    plan: 'free',
    onboarding_complete: false,
    email_verified: false,
  }).select().single();

  if (error || !user) {
    console.error('[REGISTER] Failed to create user:', error);
    res.status(500).json({ error: 'Failed to create account' });
    return;
  }

  // Send verification email via Supabase Auth.
  // We use the anon key so Supabase sends from its own email service. The email
  // carries a 6-digit code ({{ .Token }} in the "Confirm signup" template); the
  // user types it into the app, which we verify below in /verify-email. We keep
  // emailRedirectTo set so the magic link in the same email still works as a
  // fallback for anyone who clicks it instead of entering the code.
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
  const supabaseAuthClient = getSupabaseAuthClient();

  const { data: signUpData, error: signUpError } = await supabaseAuthClient.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${frontendUrl}/auth/callback` },
  });

  if (signUpError) {
    console.warn('[REGISTER] Supabase signUp error (non-fatal):', signUpError.message);
  }

  // If Supabase auto-confirmed the user (email confirmations disabled in dashboard),
  // the session is returned immediately — skip the verification gate.
  const autoConfirmed = !!signUpData?.user?.email_confirmed_at;
  if (autoConfirmed) {
    await supabase.from('users').update({ email_verified: true }).eq('id', user.id);

    const token = jwt.sign(
      { userId: user.id, email: user.email, plan: user.plan },
      jwtSecret(),
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id, email: user.email, name: user.name,
        plan: user.plan, theme: user.theme ?? 'light',
        currency_preference: user.currency_preference ?? 'AUD',
        onboarding_complete: user.onboarding_complete ?? false,
        telegram_bot_token: user.telegram_bot_token ?? null,
      },
    });
    return;
  }

  // Verification email sent — tell the frontend to show the "check your email" screen.
  res.status(201).json({ requiresVerification: true, email });
});

router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const { email, password } = parsed.data;

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // A correct password does NOT bypass email verification: an account registered
  // but never verified must finish that step before its first session. Send a
  // fresh code (best effort — Supabase rate-limits resends) so the verify screen
  // the frontend shows next can be completed straight away.
  if (user.email_verified === false) {
    getSupabaseAuthClient().auth.resend({ type: 'signup', email })
      .then(({ error: resendErr }) => {
        if (resendErr) console.warn('[LOGIN] verification resend failed:', resendErr.message);
      });
    res.status(403).json({
      requiresVerification: true,
      email,
      error: 'Please verify your email first — we’ve sent you a new code.',
    });
    return;
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email, plan: user.plan },
    jwtSecret(),
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, theme: user.theme,
      currency_preference: user.currency_preference,
      onboarding_complete: user.onboarding_complete,
      telegram_bot_token: user.telegram_bot_token ?? null,
    },
  });
});

// ── Exchange Supabase verification token for our JWT ──────────────────────────
// Called from /auth/callback after the user clicks the verification link in their email.
router.post('/exchange', async (req: Request, res: Response) => {
  const { supabase_token } = req.body;
  if (!supabase_token || typeof supabase_token !== 'string') {
    res.status(400).json({ error: 'Missing supabase_token' });
    return;
  }

  // Verify the Supabase access_token by calling Supabase's /user endpoint.
  let supabaseEmail: string | undefined;
  try {
    const verifyRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${supabase_token}`,
        'apikey': process.env.SUPABASE_ANON_KEY!,
      },
    });

    if (!verifyRes.ok) {
      res.status(401).json({ error: 'Invalid or expired verification link. Please register again.' });
      return;
    }

    const supabaseUser = await verifyRes.json() as { email?: string; email_confirmed_at?: string };

    if (!supabaseUser.email) {
      res.status(400).json({ error: 'Could not read email from token.' });
      return;
    }

    supabaseEmail = supabaseUser.email;
  } catch (err) {
    console.error('[EXCHANGE] Supabase verify error:', err);
    res.status(500).json({ error: 'Failed to verify token with Supabase.' });
    return;
  }

  // Find the user in our own table
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', supabaseEmail)
    .single();

  if (!user) {
    res.status(404).json({ error: 'Account not found. Please register first.' });
    return;
  }

  // Mark email as verified and issue our JWT
  await supabase.from('users').update({ email_verified: true }).eq('id', user.id);

  const token = jwt.sign(
    { userId: user.id, email: user.email, plan: user.plan },
    jwtSecret(),
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, theme: user.theme ?? 'light',
      currency_preference: user.currency_preference ?? 'AUD',
      onboarding_complete: user.onboarding_complete ?? false,
      telegram_bot_token: user.telegram_bot_token ?? null,
    },
  });
});

// ── Verify the 6-digit email code ─────────────────────────────────────────────
// The code is Supabase Auth's signup OTP (the {{ .Token }} value emailed by the
// "Confirm signup" template). We verify it via Supabase, then mark our own user
// verified and log them straight in with our JWT — no second sign-in step.
router.post('/verify-email', async (req: Request, res: Response) => {
  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) {
    res.status(400).json({ error: 'Email and code are required' });
    return;
  }

  const supabaseAuthClient = getSupabaseAuthClient();
  const { data: otpData, error: otpError } = await supabaseAuthClient.auth.verifyOtp({
    email,
    token: String(code).trim(),
    type: 'signup',
  });

  if (otpError || !otpData?.user) {
    res.status(400).json({
      error: 'Invalid or expired code. Check the code or request a new one.',
    });
    return;
  }

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
    res.status(404).json({ error: 'Account not found. Please register again.' });
    return;
  }

  await supabase.from('users').update({ email_verified: true }).eq('id', user.id);

  const token = jwt.sign(
    { userId: user.id, email: user.email, plan: user.plan },
    jwtSecret(),
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, theme: user.theme ?? 'light',
      currency_preference: user.currency_preference ?? 'AUD',
      onboarding_complete: user.onboarding_complete ?? false,
      telegram_bot_token: user.telegram_bot_token ?? null,
    },
  });
});

// ── Resend the 6-digit verification code ──────────────────────────────────────
router.post('/resend-verification', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const supabaseAuthClient = getSupabaseAuthClient();
  const { error } = await supabaseAuthClient.auth.resend({ type: 'signup', email });

  if (error) {
    console.warn('[RESEND] Supabase resend error:', error.message);
    res.status(400).json({ error: 'Could not resend the code. Please try again shortly.' });
    return;
  }

  res.json({ success: true });
});

export default router;
