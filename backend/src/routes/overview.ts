import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { recordNetWorthSnapshot, getItemChanges, getAdjustedNwSeries, computeNetWorth } from '../services/netWorthSnapshot';

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

  // Baseline = earliest NON-ZERO snapshot (0% reference point). Early "empty" 0-value
  // snapshots (recorded before any accounts existed) must never become the baseline —
  // dividing by 0 breaks the % series and makes "since tracking" measure against 0.
  const { data: firstRow } = await supabase
    .from('net_worth_history')
    .select('total_value')
    .eq('user_id', userId)
    .neq('total_value', 0)
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

  // Structural-adjustment-aware series (newly added/removed items don't spike the
  // change). Derived from per-item history; the frontend toggle picks which to show.
  // Pass the LIVE item set so currentBase reconciles against what net worth is right
  // now (not the throttled last snapshot) — this is what stops an unhidden/added
  // account from spiking the headline before the next snapshot lands.
  let adjusted = null;
  try {
    const live = await computeNetWorth(userId);
    adjusted = await getAdjustedNwSeries(userId, startMs, live.items);
  } catch (err) {
    console.error('Adjusted net-worth series failed:', err);
  }

  res.json({ timeframe, baseline, points, adjusted });
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

  // Auto-create next occurrence for recurring bills.
  // ONLY roll forward for a frequency we can actually advance. Subscription-linked
  // bills can carry 'irregular' (and legacy/imported rows can carry other unknown
  // values); for those the old code hit `freq[freq]?.()` as a no-op, leaving `next`
  // equal to the just-paid due_date and inserting an identical UNPAID copy at the
  // SAME date — so ticking the bill off instantly brought it back. An unknown or
  // irregular frequency has no defined "next" date, so we just mark it paid and
  // create nothing; the user re-adds it when the next (irregular) charge is known.
  const freq: Record<string, (d: Date) => void> = {
    weekly: (d) => d.setDate(d.getDate() + 7),
    fortnightly: (d) => d.setDate(d.getDate() + 14),
    monthly: (d) => d.setMonth(d.getMonth() + 1),
    quarterly: (d) => d.setMonth(d.getMonth() + 3),
    annually: (d) => d.setFullYear(d.getFullYear() + 1),
  };
  const advance = bill.frequency ? freq[bill.frequency] : undefined;
  if (bill.is_recurring && advance) {
    const next = new Date(bill.due_date);
    advance(next);

    // If the just-paid occurrence carried a one-off ("just this once") edit, its
    // canonical series values were snapshotted in recurring_template. The NEXT
    // occurrence reverts to those, and the template is cleared so the series is
    // back to normal. Older rows have no template → plain duplication (unchanged).
    const tmpl = bill.recurring_template ?? null;
    // Carry per-bill reminders forward, but reset each entry's last_sent so they
    // fire again for the new occurrence's due date.
    const nextReminders = Array.isArray(bill.reminders)
      ? bill.reminders.map((r: Record<string, unknown>) => ({ ...r, last_sent: null }))
      : bill.reminders;
    await supabase.from('bills').insert({
      ...bill, id: undefined, is_paid: false, paid_at: null,
      ...(tmpl ?? {}),
      reminders: nextReminders,
      recurring_template: null,
      due_date: next.toISOString().split('T')[0],
      created_at: undefined, updated_at: undefined,
    });
  }

  res.json({ success: true });
});

// Only real bills columns may be written. A queued offline update can carry a
// stale/derived field (e.g. from an older app build); spreading req.body raw
// would let that 500 forever on retry. Whitelisting keeps recurring intact
// (is_recurring/frequency/recurring_template are all included) while dropping junk.
const BILL_COLUMNS = new Set([
  'name', 'amount', 'due_date', 'is_recurring', 'frequency', 'colour',
  'is_paid', 'paid_at', 'subscription_id', 'calendar_synced',
  'kind', 'category', 'recurring_template', 'lead_days', 'original_name', 'auto_pay',
  'reminders',
]);

router.put('/bills/:id', async (req: AuthRequest, res: Response) => {
  const updates: Record<string, unknown> = {};
  for (const key of Object.keys(req.body)) {
    if (BILL_COLUMNS.has(key)) updates[key] = req.body[key];
  }
  updates.updated_at = new Date().toISOString();

  // maybeSingle (not single): a queued offline update can target a row that no
  // longer exists — e.g. a recurring occurrence that was paid and advanced to a
  // new row id. single() raises PGRST116 ("no rows") which we'd return as a 500,
  // making the sync queue retry it forever. Treat no-match as an idempotent no-op.
  const { data, error } = await supabase
    .from('bills')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[BILL PUT] Supabase error:', JSON.stringify(error), '| keys:', Object.keys(updates));
    res.status(500).json({ error: error.message, code: error.code });
    return;
  }
  // No matching row → nothing to update; ack so the offline queue can drain.
  res.json(data ?? { id: req.params.id, noop: true });
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

// ── Budget plan: settings (one row per user, upserted) ───────────────────────
router.get('/budget-settings', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('budget_settings').select('*').eq('user_id', req.user!.userId).maybeSingle();
  res.json(data ?? null);
});

router.put('/budget-settings', async (req: AuthRequest, res: Response) => {
  const { id, user_id, created_at, updated_at, ...patch } = req.body ?? {};
  const { data, error } = await supabase
    .from('budget_settings')
    .upsert({ ...patch, user_id: req.user!.userId }, { onConflict: 'user_id' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// ── Budget plan: line items ──────────────────────────────────────────────────
router.get('/budget-lines', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('budget_lines').select('*').eq('user_id', req.user!.userId);
  res.json(data ?? []);
});

router.post('/budget-lines', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('budget_lines').insert({ ...req.body, user_id: req.user!.userId }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/budget-lines/:id', async (req: AuthRequest, res: Response) => {
  // maybeSingle (not single): a queued update can target a row that isn't on the
  // server for this user — e.g. a stale budget line left in localStorage by a
  // previous account on a shared device. single() raises PGRST116 ("no rows"),
  // which we'd return as a 500, wedging the sync queue in an endless retry. Treat
  // a no-match as an idempotent no-op so the queue can drain.
  const { data, error } = await supabase
    .from('budget_lines').update(req.body).eq('id', req.params.id).eq('user_id', req.user!.userId).select().maybeSingle();
  if (error) {
    console.error('[BUDGET-LINE PUT] Supabase error:', JSON.stringify(error), '| keys:', Object.keys(req.body));
    res.status(500).json({ error: error.message, code: error.code });
    return;
  }
  // No matching row → nothing to update; ack so the offline queue can drain.
  res.json(data ?? { id: req.params.id, noop: true });
});

router.delete('/budget-lines/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('budget_lines').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Custom categories ────────────────────────────────────────────────────────
router.get('/custom-categories', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('custom_categories').select('*').eq('user_id', req.user!.userId);
  res.json(data ?? []);
});

router.post('/custom-categories', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('custom_categories')
    .upsert({ ...req.body, user_id: req.user!.userId }, { onConflict: 'user_id,name' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete('/custom-categories/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('custom_categories').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
