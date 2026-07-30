import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { deleteBasiqUser } from '../services/basiqService';

const router = Router();
router.use(authenticate);

router.get('/profile', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, currency_preference, timezone, theme, plan, onboarding_complete, telegram_bot_token, ui_preferences')
    .eq('id', req.user!.userId)
    .single();

  if (error) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(data);
});

router.put('/profile', async (req: AuthRequest, res: Response) => {
  const allowed = ['name', 'currency_preference', 'timezone', 'theme', 'onboarding_complete', 'ui_preferences'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Validate the timezone is a real IANA zone before persisting, so a bad value
  // can never break date/time rendering or the briefing scheduler.
  if (updates.timezone !== undefined) {
    const tz = updates.timezone as string;
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    } catch {
      res.status(400).json({ error: `Invalid timezone: ${tz}` });
      return;
    }
  }

  const { data, error } = await supabase
    .from('users')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', req.user!.userId)
    .select('id, email, name, currency_preference, timezone, theme, plan, onboarding_complete, ui_preferences')
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Keep the Telegram briefing timezone in lock-step with the profile timezone so
  // morning briefings fire at the same local time the user sees in the app. Only
  // touches the timezone column; never re-enables a disabled briefing. Best-effort.
  if (updates.timezone !== undefined) {
    const { error: tzErr } = await supabase
      .from('telegram_briefing_settings')
      .update({ timezone: updates.timezone })
      .eq('user_id', req.user!.userId);
    if (tzErr) console.error('[SETTINGS] Failed to sync briefing timezone:', tzErr.message);
  }

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

  // Everything the user owns is reachable from users(id) via ON DELETE CASCADE
  // (enforced by database/2026-account-deletion-cascade.sql), so deleting the
  // users row wipes all per-user tables atomically — no hand-maintained list to
  // keep in sync as tables are added. We only handle the one table that isn't
  // keyed on user_id (email_verification_codes is keyed on the email address).
  const { data: user, error: lookupErr } = await supabase
    .from('users')
    .select('email, basiq_user_id')
    .eq('id', userId)
    .single();

  if (lookupErr || !user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Delete the user's data held at the third party (Basiq open-banking) before we
  // drop the local mapping. Best-effort: a Basiq failure shouldn't block the user
  // from deleting their local account, but we log it so it can be followed up.
  if (user.basiq_user_id) {
    try {
      await deleteBasiqUser(user.basiq_user_id);
    } catch (err) {
      console.error('Failed to delete Basiq user during account deletion', userId, err);
    }
  }

  const { error: deleteErr } = await supabase.from('users').delete().eq('id', userId);
  if (deleteErr) {
    console.error('Account deletion failed for user', userId, deleteErr);
    res.status(500).json({ error: 'Failed to delete account. No data was removed — please try again.' });
    return;
  }

  // users row is gone (and everything cascading from it). Clean up the one table
  // not keyed on user_id; best-effort, the user is already deleted at this point.
  await supabase.from('email_verification_codes').delete().eq('email', user.email);

  res.json({ success: true });
});

// ── Telegram Morning Briefing Settings ───────────────────────────────────────

const DEFAULT_BRIEFING = {
  enabled: true,
  send_time: '08:00',
  timezone: 'Australia/Sydney',
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  show_net_worth: true,
  show_bank_balances: true,
  show_credit_cards: true,
  show_investments: true,
  top_movers: 'top3',
  show_super: true,
  show_bills: true,
  bills_count: 5,
  include_auto_pay: true,
  show_goals: true,
  show_reminders: false,
  reminders_max: 5,
  // Per-item customisation. Exclusion lists (auto-include new items): a section
  // shows everything except ids listed here. watched_investment_ids is an opt-IN
  // list of holdings to always surface under "Watching".
  excluded_bank_ids: [],
  excluded_card_ids: [],
  excluded_goal_ids: [],
  watched_investment_ids: [],
  show_watchlist: true,
};

router.get('/briefing', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('telegram_briefing_settings')
    .select('*')
    .eq('user_id', req.user!.userId)
    .single();

  // PGRST116 = "no rows found" — expected for first-time users, not an error
  if (error && error.code !== 'PGRST116') {
    console.error('[BRIEFING GET] Unexpected error:', JSON.stringify(error));
  }
  res.json(data ?? DEFAULT_BRIEFING);
});

router.put('/briefing', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  console.log('[BRIEFING PUT] userId:', userId, '| body keys:', Object.keys(req.body));

  // Fetch existing row so we can detect a send_time change and reset last_sent_date
  const { data: existing } = await supabase
    .from('telegram_briefing_settings')
    .select('send_time, last_sent_date, timezone')
    .eq('user_id', userId)
    .single();

  const allowed = [
    'enabled', 'send_time', 'timezone', 'days',
    'show_net_worth', 'show_bank_balances', 'show_credit_cards',
    'show_investments', 'top_movers', 'show_super',
    'show_bills', 'bills_count', 'include_auto_pay', 'show_goals', 'show_reminders', 'reminders_max',
    'show_watchlist',
    'excluded_bank_ids', 'excluded_card_ids', 'excluded_goal_ids', 'watched_investment_ids',
    'excluded_watchlist_ids',
  ];
  const settings: Record<string, unknown> = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  for (const key of allowed) {
    if (req.body[key] !== undefined) settings[key] = req.body[key];
  }

  // If the send_time changed and the new time is still in the future today
  // (in the user's timezone), clear last_sent_date so the briefing can fire
  // again today at the newly configured time.
  const newSendTime = req.body.send_time as string | undefined;
  if (newSendTime && existing?.send_time && newSendTime !== existing.send_time && existing.last_sent_date) {
    const tz =
      (req.body.timezone as string | undefined) ??
      (existing.timezone as string | null | undefined) ??
      'Australia/Sydney';

    const timeParts = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const rawHh = timeParts.find(p => p.type === 'hour')?.value ?? '00';
    const currentTime = `${rawHh === '24' ? '00' : rawHh}:${timeParts.find(p => p.type === 'minute')?.value ?? '00'}`;

    // HH:MM strings sort lexicographically, so '>' means "later today"
    if (newSendTime > currentTime) {
      settings.last_sent_date = null;
      console.log(
        `[BRIEFING PUT] send_time changed ${existing.send_time}→${newSendTime} ` +
        `(current ${currentTime} in ${tz}) — clearing last_sent_date`,
      );
    }
  }

  console.log('[BRIEFING PUT] Upserting:', JSON.stringify(settings));

  const { data, error } = await supabase
    .from('telegram_briefing_settings')
    .upsert(settings, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    console.error('[BRIEFING PUT] Supabase error:', JSON.stringify(error));
    // Return the full detail so the frontend can surface it to the user
    res.status(500).json({
      error: error.message,
      code: error.code,
      details: (error as unknown as Record<string, unknown>).details ?? null,
    });
    return;
  }
  console.log('[BRIEFING PUT] Success, id:', data?.id);
  res.json(data);
});

// ── Export ─────────────────────────────────────────────────────────────────────

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
