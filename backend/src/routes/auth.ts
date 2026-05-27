import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../utils/supabase';
import { z } from 'zod';

const router = Router();

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
  }).select().single();

  if (error || !user) {
    res.status(500).json({ error: 'Failed to create account' });
    return;
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email, plan: user.plan },
    process.env.JWT_SECRET ?? 'dev-secret',
    { expiresIn: '7d' }
  );

  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
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

  const token = jwt.sign(
    { userId: user.id, email: user.email, plan: user.plan },
    process.env.JWT_SECRET ?? 'dev-secret',
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, theme: user.theme,
      currency_preference: user.currency_preference,
      onboarding_complete: user.onboarding_complete,
    },
  });
});

router.post('/verify-email', async (req: Request, res: Response) => {
  const { email, code } = req.body;
  const { data } = await supabase
    .from('email_verification_codes')
    .select('*')
    .eq('email', email)
    .eq('code', code)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!data) {
    res.status(400).json({ error: 'Invalid or expired code' });
    return;
  }

  await supabase.from('email_verification_codes').delete().eq('id', data.id);
  await supabase.from('users').update({ email_verified: true }).eq('email', email);

  res.json({ success: true });
});

export default router;
