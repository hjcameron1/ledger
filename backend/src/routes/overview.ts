import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { recordNetWorthSnapshot, getItemChanges } from '../services/netWorthSnapshot';

const router = Router();
router.use(authenticate);

router.get('/net-worth', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const nw = await recordNetWorthSnapshot(userId);

  res.json({
    net_worth: nw.netWorth,
    bank_balance: nw.bankBalance,
    investments: nw.investments,
    credit_card_debt: nw.creditCardDebt,
    super: nw.super,
    currency: nw.currency,
  });
});

// Net-worth % change history for the Overview trend chart. The percentage is
// measured against the user's FIRST-EVER snapshot (0% baseline), so every
// timeframe shows the same cumulative series — the toggle just zooms the window.
//   ?timeframe = daily | weekly | monthly | yearly | all   (default: all)
//   daily  → intraday (hourly) rows from the last 24h
//   others → one point per day (latest of each day) within the window
router.get('/net-worth/pct-history', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const timeframe = String(req.query.timeframe ?? 'all');

  // On-demand snapshot (throttled to once/hour) so a point appears on load.
  try {
    const { data: latest } = await supabase
      .from('net_worth_history')
      .select('recorded_at')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    const lastAt = latest?.[0]?.recorded_at ? new Date(latest[0].recorded_at).getTime() : 0;
    if (Date.now() - lastAt > 55 * 60 * 1000) {
      await recordNetWorthSnapshot(userId);
    }
  } catch (err) {
    console.error('Net-worth snapshot (on-demand) failed:', err);
  }

  // Baseline = earliest snapshot ever (0% reference point).
  const { data: firstRow } = await supabase
    .from('net_worth_history')
    .select('total_value')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: true })
    .limit(1);
  const baseline = Number(firstRow?.[0]?.total_value ?? 0);

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windowStart: Record<string, number> = {
    daily: now - DAY,
    weekly: now - 7 * DAY,
    monthly: now - 30 * DAY,
    yearly: now - 365 * DAY,
  };
  const startMs = windowStart[timeframe];

  let query = supabase
    .from('net_worth_history')
    .select('recorded_at, total_value')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: true });
  if (startMs) query = query.gte('recorded_at', new Date(startMs).toISOString());

  const { data, error } = await query.limit(2000);
  if (error) { res.status(500).json({ error: error.message }); return; }

  let rows = data ?? [];

  if (timeframe !== 'daily') {
    const byDay = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const day = new Date(r.recorded_at).toISOString().split('T')[0];
      byDay.set(day, r); // ascending → last write wins = latest of the day
    }
    rows = Array.from(byDay.values());
  }

  const points = rows.map(r => ({
    recorded_at: r.recorded_at,
    pct: baseline !== 0 ? parseFloat((((Number(r.total_value) - baseline) / baseline) * 100).toFixed(4)) : 0,
    value: Number(r.total_value),
  }));

  res.json({ timeframe, baseline, points });
});

// Per-item net-worth change over a timeframe, for the breakdown popup. Sorted
// by biggest contribution to the net-worth change in the window.
//   ?timeframe = daily | weekly | monthly | sixmonth | yearly | all  (default: daily)
router.get('/net-worth/item-changes', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const timeframe = String(req.query.timeframe ?? 'daily');

  // On-demand snapshot (throttled to once/hour) so "current" is fresh on load.
  try {
    const { data: latest } = await supabase
      .from('net_worth_item_history')
      .select('recorded_at')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    const lastAt = latest?.[0]?.recorded_at ? new Date(latest[0].recorded_at).getTime() : 0;
    if (Date.now() - lastAt > 55 * 60 * 1000) {
      await recordNetWorthSnapshot(userId);
    }
  } catch (err) {
    console.error('Net-worth item snapshot (on-demand) failed:', err);
  }

  const { items, currency } = await getItemChanges(userId, timeframe);
  res.json({ timeframe, currency, items });
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
