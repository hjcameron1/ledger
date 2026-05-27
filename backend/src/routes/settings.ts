import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';

const router = Router();
router.use(authenticate);

router.get('/profile', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, currency_preference, theme, plan, onboarding_complete, telegram_bot_token')
    .eq('id', req.user!.userId)
    .single();

  if (error) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(data);
});

router.put('/profile', async (req: AuthRequest, res: Response) => {
  const allowed = ['name', 'currency_preference', 'theme', 'onboarding_complete'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { data, error } = await supabase
    .from('users')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', req.user!.userId)
    .select('id, email, name, currency_preference, theme, plan, onboarding_complete')
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.put('/telegram', async (req: AuthRequest, res: Response) => {
  const { telegram_bot_token } = req.body;
  await supabase.from('users')
    .update({ telegram_bot_token })
    .eq('id', req.user!.userId);
  res.json({ success: true });
});

router.delete('/account', async (req: AuthRequest, res: Response) => {
  const { confirmation } = req.body;
  if (confirmation !== 'DELETE') {
    res.status(400).json({ error: 'Must type DELETE to confirm' });
    return;
  }

  const userId = req.user!.userId;
  await Promise.all([
    supabase.from('transactions').delete().eq('user_id', userId),
    supabase.from('bank_accounts').delete().eq('user_id', userId),
    supabase.from('credit_cards').delete().eq('user_id', userId),
    supabase.from('investments').delete().eq('user_id', userId),
    supabase.from('income_entries').delete().eq('user_id', userId),
    supabase.from('bills').delete().eq('user_id', userId),
    supabase.from('goals').delete().eq('user_id', userId),
    supabase.from('notifications').delete().eq('user_id', userId),
  ]);
  await supabase.from('users').delete().eq('id', userId);

  res.json({ success: true });
});

router.get('/export', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const [accounts, transactions, investments, income, bills, goals] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('user_id', userId),
    supabase.from('transactions').select('*').eq('user_id', userId),
    supabase.from('investments').select('*').eq('user_id', userId),
    supabase.from('income_entries').select('*').eq('user_id', userId),
    supabase.from('bills').select('*').eq('user_id', userId),
    supabase.from('goals').select('*').eq('user_id', userId),
  ]);

  res.json({
    exported_at: new Date().toISOString(),
    accounts: accounts.data,
    transactions: transactions.data,
    investments: investments.data,
    income: income.data,
    bills: bills.data,
    goals: goals.data,
  });
});

export default router;
