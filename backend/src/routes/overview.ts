import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { convertAmount } from '../services/currencyService';

const router = Router();
router.use(authenticate);

router.get('/net-worth', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;

  const [
    { data: user },
    { data: accounts },
    { data: investments },
    { data: creditCards },
    { data: superFunds },
  ] = await Promise.all([
    supabase.from('users').select('currency_preference').eq('id', userId).single(),
    supabase.from('bank_accounts').select('balance, currency').eq('user_id', userId),
    supabase.from('investments').select('current_value, native_currency').eq('user_id', userId),
    supabase.from('credit_cards').select('balance_owing, currency').eq('user_id', userId),
    supabase.from('super_funds').select('balance, include_in_net_worth').eq('user_id', userId),
  ]);

  const pref = user?.currency_preference ?? 'AUD';

  let totalBankBalance = 0;
  for (const acc of accounts ?? []) {
    const { converted } = await convertAmount(acc.balance, acc.currency ?? 'AUD', pref);
    totalBankBalance += converted;
  }

  let totalInvestments = 0;
  for (const inv of investments ?? []) {
    const { converted } = await convertAmount(inv.current_value, inv.native_currency ?? 'AUD', pref);
    totalInvestments += converted;
  }

  let totalCreditCard = 0;
  for (const cc of creditCards ?? []) {
    const { converted } = await convertAmount(cc.balance_owing, cc.currency ?? 'AUD', pref);
    totalCreditCard += converted;
  }

  let totalSuper = 0;
  for (const sf of superFunds ?? []) {
    if (sf.include_in_net_worth) totalSuper += sf.balance;
  }

  const netWorth = totalBankBalance + totalInvestments + totalSuper - totalCreditCard;

  // Store snapshot
  await supabase.from('net_worth_history').insert({
    user_id: userId,
    total_value: netWorth,
    recorded_date: new Date().toISOString().split('T')[0],
  });

  res.json({
    net_worth: parseFloat(netWorth.toFixed(2)),
    bank_balance: parseFloat(totalBankBalance.toFixed(2)),
    investments: parseFloat(totalInvestments.toFixed(2)),
    credit_card_debt: parseFloat(totalCreditCard.toFixed(2)),
    super: parseFloat(totalSuper.toFixed(2)),
    currency: pref,
  });
});

router.get('/net-worth/history', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('net_worth_history')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('recorded_date', { ascending: true })
    .limit(365);

  res.json(data ?? []);
});

// Bills
router.get('/bills', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('user_id', req.user!.userId)
    .eq('is_paid', false)
    .order('due_date', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post('/bills', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('bills')
    .insert({ ...req.body, user_id: req.user!.userId, is_paid: false })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.patch('/bills/:id/pay', async (req: AuthRequest, res: Response) => {
  const { data: bill } = await supabase
    .from('bills').select('*').eq('id', req.params.id).eq('user_id', req.user!.userId).single();
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }

  await supabase
    .from('bills')
    .update({ is_paid: true, paid_at: new Date().toISOString().split('T')[0] })
    .eq('id', req.params.id);

  // Auto-create next occurrence for recurring bills
  if (bill.is_recurring && bill.frequency) {
    const next = new Date(bill.due_date);
    const freq: Record<string, () => void> = {
      weekly: () => next.setDate(next.getDate() + 7),
      fortnightly: () => next.setDate(next.getDate() + 14),
      monthly: () => next.setMonth(next.getMonth() + 1),
      quarterly: () => next.setMonth(next.getMonth() + 3),
      annually: () => next.setFullYear(next.getFullYear() + 1),
    };
    freq[bill.frequency]?.();

    await supabase.from('bills').insert({
      ...bill, id: undefined, is_paid: false, paid_at: null,
      due_date: next.toISOString().split('T')[0],
      created_at: undefined, updated_at: undefined,
    });
  }

  res.json({ success: true });
});

router.put('/bills/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('bills')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/bills/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('bills').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

// Goals
router.get('/goals', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('goals').select('*').eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post('/goals', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('goals')
    .insert({ ...req.body, user_id: req.user!.userId })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/goals/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('goals')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('user_id', req.user!.userId)
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/goals/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('goals').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

// Notifications
router.get('/notifications', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(data ?? []);
});

router.patch('/notifications/:id/read', async (req: AuthRequest, res: Response) => {
  await supabase.from('notifications').update({ is_read: true })
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

router.patch('/notifications/read-all', async (req: AuthRequest, res: Response) => {
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

// Budget
router.get('/budget', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase.from('budgets').select('*').eq('user_id', req.user!.userId);
  res.json(data ?? []);
});

router.post('/budget', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('budgets').insert({ ...req.body, user_id: req.user!.userId }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/budget/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('budgets').update(req.body).eq('id', req.params.id).eq('user_id', req.user!.userId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
