import TelegramBot from 'node-telegram-bot-api';
import { supabase } from '../utils/supabase';
import { telegramAIResponse } from './claudeService';
import { convertAmount } from './currencyService';

const activeBots = new Map<string, TelegramBot>();

// ── Direct HTTP send (no polling required) ────────────────────────────────────
async function tgSend(botToken: string, chatId: string | number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    const data = await res.json() as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

// ── Briefing settings type ────────────────────────────────────────────────────
export interface BriefingSettings {
  enabled: boolean;
  send_time: string;         // HH:MM
  timezone: string;          // e.g. 'Australia/Sydney'
  days: string[];            // ['mon','tue','wed','thu','fri','sat','sun']
  show_net_worth: boolean;
  show_bank_balances: boolean;
  show_credit_cards: boolean;
  show_investments: boolean;
  top_movers: string;        // 'top3' | 'top5' | 'best_worst' | 'none'
  show_super: boolean;
  show_bills: boolean;
  bills_count: number;
  show_goals: boolean;
  show_reminders: boolean;
  reminders_max: number;
  last_sent_date?: string;
}

const DEFAULT_SETTINGS: BriefingSettings = {
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
  show_goals: true,
  show_reminders: false,
  reminders_max: 3,
};

// ── Interactive bot (polling) ─────────────────────────────────────────────────
export async function startUserBot(userId: string, botToken: string): Promise<void> {
  console.log(`[BOT] Starting bot for user ${userId} (token: ...${botToken.slice(-6)})`);

  if (activeBots.has(userId)) {
    console.log(`[BOT] Stopping existing bot instance for user ${userId}`);
    try { activeBots.get(userId)!.stopPolling(); } catch { /* ignore */ }
  }

  const bot = new TelegramBot(botToken, { polling: true });
  activeBots.set(userId, bot);

  // Categorise polling errors so transient network blips don't masquerade as fatal
  // problems, and genuinely actionable cases are handled distinctly.
  //   • EFATAL/network (AggregateError, ECONNRESET, ETIMEDOUT, EAI_AGAIN): the
  //     request to api.telegram.org failed to connect. node-telegram-bot-api keeps
  //     polling and recovers on its own, so log a soft warning, not an error.
  //   • 401 Unauthorized: the bot token is invalid/revoked — polling will fail
  //     forever, so stop this bot to end the log spam.
  //   • 409 Conflict: another process is polling the same token (e.g. a second
  //     instance). Surface clearly so it can be investigated.
  bot.on('polling_error', (err: Error & { code?: string; response?: { statusCode?: number } }) => {
    const msg = err.message ?? String(err);
    const code = err.code ?? '';
    const status = err.response?.statusCode;
    const isTransientNetwork =
      code === 'EFATAL' ||
      /AggregateError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network/i.test(msg);

    if (status === 401 || /401|unauthorized/i.test(msg)) {
      console.error(`[BOT] Invalid token for user ${userId} (401) — stopping bot to avoid retry spam.`);
      try { bot.stopPolling(); } catch { /* ignore */ }
      activeBots.delete(userId);
    } else if (status === 409 || /409|conflict/i.test(msg)) {
      console.error(`[BOT] Polling conflict for user ${userId} (409) — another instance is polling the same token.`);
    } else if (isTransientNetwork) {
      console.warn(`[BOT] Transient polling network error for user ${userId} (will auto-retry): ${code || msg}`);
    } else {
      console.error(`[BOT] Polling error for user ${userId}:`, msg);
    }
  });

  bot.on('message', async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    console.log(`[BOT] ← msg from chatId=${chatId}, userId=${userId}: "${text.slice(0, 80)}"`);
    if (!text) return;

    try {
      // Persist chat_id so morning briefings can reach the user
      await supabase
        .from('users')
        .update({ telegram_chat_id: String(chatId) })
        .eq('id', userId);

      const { data: user } = await supabase
        .from('users')
        .select('name, currency_preference')
        .eq('id', userId)
        .single();

      const { data: history } = await supabase
        .from('telegram_conversations')
        .select('role, message')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

      const conversationHistory = (history ?? [])
        .reverse()
        .map(h => ({ role: h.role as 'user' | 'assistant', content: h.message }));

      const userContext = {
        name: user?.name ?? 'there',
        currency: user?.currency_preference ?? 'AUD',
      };

      console.log(`[BOT] Calling Claude for user ${userId}...`);
      let reply: string;
      try {
        reply = await telegramAIResponse(text, conversationHistory, userContext);
      } catch (claudeErr) {
        console.error(`[BOT] Claude error for user ${userId}:`, claudeErr);
        reply = "Sorry, I'm having trouble connecting right now. Please try again in a moment.";
      }
      console.log(`[BOT] → reply for chatId=${chatId}: "${reply.slice(0, 80)}"`);

      await supabase.from('telegram_conversations').insert([
        { user_id: userId, role: 'user', message: text },
        { user_id: userId, role: 'assistant', message: reply },
      ]);

      await bot.sendMessage(chatId, reply);
      console.log(`[BOT] Message delivered to chatId=${chatId}`);
    } catch (err) {
      console.error(`[BOT] Error handling message for user ${userId}:`, err);
      // Last-resort: try to send an error reply so the user knows something went wrong
      try { await bot.sendMessage(chatId, "Something went wrong on my end. Please try again."); } catch { /* ignore */ }
    }
  });

  console.log(`[BOT] Bot registered and polling for user ${userId}`);
}

// ── Build and send personalised morning briefing ──────────────────────────────
export async function sendMorningBriefing(
  userId: string,
  settings: BriefingSettings = DEFAULT_SETTINGS,
): Promise<void> {
  console.log(`[BRIEFING] sendMorningBriefing start — userId=${userId}`);

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, name, email, currency_preference, telegram_bot_token, telegram_chat_id')
    .eq('id', userId)
    .single();

  console.log(`[BRIEFING] user fetch: found=${!!user} | name=${user?.name} | currency=${user?.currency_preference} | has_token=${!!user?.telegram_bot_token} | has_chat_id=${!!user?.telegram_chat_id} | err=${userErr?.message ?? 'none'}`);

  if (!user?.telegram_bot_token || !user?.telegram_chat_id) {
    console.warn(`[BRIEFING] Aborting — missing bot_token or chat_id for userId=${userId}`);
    return;
  }

  const tz = settings.timezone ?? 'Australia/Sydney';
  const curr = user.currency_preference ?? 'AUD';
  console.log(`[BRIEFING] Using currency=${curr}, timezone=${tz}`);

  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: tz,
  });
  const fmt = (n: number) =>
    `$${n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  let msg = `Good morning ${user.name} 👋 Here's your Ledger briefing for ${today}:\n\n`;

  // ── Financial totals block ──
  const needFinancials =
    settings.show_net_worth ||
    settings.show_bank_balances ||
    settings.show_credit_cards ||
    settings.show_investments ||
    settings.show_super;

  if (needFinancials) {
    const [
      { data: accounts,    error: accountsErr },
      { data: investments, error: investsErr },
      { data: creditCards, error: ccErr },
      { data: superFunds,  error: superErr },
    ] = await Promise.all([
      supabase.from('bank_accounts').select('balance, currency').eq('user_id', userId),
      supabase.from('investments')
        .select('name, ticker, current_value, cost_basis, native_currency')
        .eq('user_id', userId),
      supabase.from('credit_cards').select('balance_owing, currency').eq('user_id', userId),
      supabase.from('super_funds').select('balance, include_in_net_worth').eq('user_id', userId),
    ]);

    // Log row counts and any query errors (no row contents — financial data).
    console.log(`[BRIEFING DATA] bank_accounts: ${accounts?.length ?? 0} row(s) | err=${accountsErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] investments: ${investments?.length ?? 0} row(s) | err=${investsErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] credit_cards: ${creditCards?.length ?? 0} row(s) | err=${ccErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] super_funds: ${superFunds?.length ?? 0} row(s) | err=${superErr?.message ?? 'none'}`);

    // ── Bank total (with per-account currency conversion) ──
    let bankTotal = 0;
    for (const acc of accounts ?? []) {
      const balance = Number(acc.balance) || 0;
      const from = acc.currency ?? 'AUD';
      const { converted } = await convertAmount(balance, from, curr);
      console.log(`[BRIEFING CALC] bank: balance=${balance} ${from} → ${converted} ${curr}`);
      bankTotal += converted;
    }

    // ── Investment total — mirrors overview.ts exactly (uses stored current_value) ──
    let investTotal = 0;
    const investsWithPnl: Array<{ name: string; ticker?: string; pnlPct: number }> = [];
    for (const inv of investments ?? []) {
      // Use current_value exactly as overview.ts does — it is updated by the price service
      const rawValue = Number(inv.current_value) || 0;
      const from = inv.native_currency ?? 'AUD';
      const { converted } = await convertAmount(rawValue, from, curr);
      console.log(`[BRIEFING CALC] invest: ${inv.ticker ?? inv.name} current_value=${rawValue} ${from} → ${converted} ${curr}`);
      investTotal += converted;
      const costBasis = Number(inv.cost_basis) || 0;
      if (costBasis > 0 && rawValue > 0) {
        investsWithPnl.push({
          name: inv.name,
          ticker: inv.ticker ?? undefined,
          pnlPct: ((rawValue - costBasis) / costBasis) * 100,
        });
      }
    }
    investsWithPnl.sort((a, b) => b.pnlPct - a.pnlPct);

    // ── Credit-card total (with per-card currency conversion) ──
    let ccTotal = 0;
    for (const cc of creditCards ?? []) {
      const owing = Number(cc.balance_owing) || 0;
      const from = cc.currency ?? 'AUD';
      const { converted } = await convertAmount(owing, from, curr);
      console.log(`[BRIEFING CALC] cc: owing=${owing} ${from} → ${converted} ${curr}`);
      ccTotal += converted;
    }

    // ── Super total — mirrors overview.ts exactly (truthy include_in_net_worth only) ──
    let superTotal = 0;
    for (const sf of superFunds ?? []) {
      if (sf.include_in_net_worth) superTotal += Number(sf.balance) || 0;
    }

    const netWorth = bankTotal + investTotal - ccTotal + superTotal;

    console.log(`[BRIEFING TOTALS] bankTotal=${bankTotal} | investTotal=${investTotal} | ccTotal=${ccTotal} | superTotal=${superTotal} | netWorth=${netWorth} | currency=${curr}`);

    if (settings.show_net_worth) {
      msg += `💰 *Net Worth:* ${fmt(netWorth)} ${curr}\n`;
    }
    if (settings.show_bank_balances) {
      msg += `🏦 *Bank Accounts:* ${fmt(bankTotal)} ${curr}\n`;
    }
    if (settings.show_credit_cards) {
      msg += `💳 *Credit Cards:* ${fmt(ccTotal)} owing\n`;
    }
    if (settings.show_investments) {
      msg += `📈 *Investments:* ${fmt(investTotal)} ${curr}\n`;
    }
    if (settings.show_super) {
      msg += `🏛 *Superannuation:* ${fmt(superTotal)} ${curr}\n`;
    }
    msg += '\n';

    // ── Top movers ──
    if (settings.show_investments && settings.top_movers !== 'none' && investsWithPnl.length > 0) {
      msg += `🔥 *Top Movers:*\n`;
      const sign = (n: number) => (n >= 0 ? '+' : '');

      if (settings.top_movers === 'best_worst') {
        const best = investsWithPnl[0];
        const worst = investsWithPnl[investsWithPnl.length - 1];
        msg += `▲ ${best.name}${best.ticker ? ` (${best.ticker})` : ''}: ${sign(best.pnlPct)}${best.pnlPct.toFixed(1)}%\n`;
        if (investsWithPnl.length > 1) {
          msg += `▼ ${worst.name}${worst.ticker ? ` (${worst.ticker})` : ''}: ${sign(worst.pnlPct)}${worst.pnlPct.toFixed(1)}%\n`;
        }
      } else {
        const count = settings.top_movers === 'top5' ? 5 : 3;
        for (const inv of investsWithPnl.slice(0, count)) {
          const arrow = inv.pnlPct >= 0 ? '▲' : '▼';
          msg += `${arrow} ${inv.name}${inv.ticker ? ` (${inv.ticker})` : ''}: ${sign(inv.pnlPct)}${inv.pnlPct.toFixed(1)}%\n`;
        }
      }
      msg += '\n';
    }
  }

  // ── Upcoming bills ──
  if (settings.show_bills) {
    const { data: bills, error: billsErr } = await supabase
      .from('bills')
      .select('name, amount, due_date, is_paid')
      .eq('user_id', userId)
      .order('due_date')
      .limit(Math.max(1, Math.min(10, settings.bills_count)));

    console.log(`[BRIEFING DATA] bills: ${bills?.length ?? 0} row(s) | err=${billsErr?.message ?? 'none'}`);

    // Filter out paid bills client-side (handles tables with or without is_paid column)
    const unpaidBills = (bills ?? []).filter((b: { is_paid?: boolean }) => !b.is_paid);
    console.log(`[BRIEFING DATA] unpaid bills: ${unpaidBills.length}`);

    if (unpaidBills.length > 0) {
      msg += `📋 *Upcoming Bills:*\n`;
      for (const b of unpaidBills as Array<{ name: string; amount: number; due_date: string }>) {
        const due = new Date(b.due_date);
        const daysLeft = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
        const urgency = daysLeft <= 1 ? ' ⚠️' : daysLeft <= 3 ? ' ⏰' : '';
        msg += `• ${b.name} — ${fmt(b.amount)} due in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}${urgency}\n`;
      }
      msg += '\n';
    }
  }

  // ── Goals ──
  if (settings.show_goals) {
    const { data: goals, error: goalsErr } = await supabase
      .from('goals')
      .select('name, current_amount, target_amount, include_in_briefing')
      .eq('user_id', userId);

    // Include goals unless explicitly opted out (null/undefined → included).
    const briefGoals = (goals ?? []).filter(
      (g: { include_in_briefing?: boolean | null }) => g.include_in_briefing !== false,
    );

    console.log(`[BRIEFING DATA] goals: ${briefGoals.length} of ${goals?.length ?? 0} row(s) | err=${goalsErr?.message ?? 'none'}`);

    if (briefGoals.length > 0) {
      msg += `🎯 *Goals:*\n`;
      for (const g of briefGoals as Array<{ name: string; current_amount: number; target_amount: number }>) {
        const pct = Math.round((g.current_amount / g.target_amount) * 100);
        msg += `• ${g.name}: ${fmt(g.current_amount)} of ${fmt(g.target_amount)} (${pct}%)\n`;
      }
      msg += '\n';
    }
  }

  // ── SMSF audit due reminder ──
  // Always included (not behind a setting): a late SMSF audit risks ATO
  // penalties, so surface it whenever the due date is within 60 days.
  {
    const { data: smsfFunds } = await supabase
      .from('smsf_funds')
      .select('name, audit_due_on')
      .eq('user_id', userId)
      .not('audit_due_on', 'is', null);

    const dueSoon = (smsfFunds ?? [])
      .map((f: { name: string; audit_due_on: string }) => ({
        name: f.name,
        days: Math.ceil((new Date(f.audit_due_on).getTime() - Date.now()) / 86_400_000),
      }))
      .filter(f => f.days <= 60)
      .sort((a, b) => a.days - b.days);

    if (dueSoon.length > 0) {
      msg += `🏦 *SMSF Audit:*\n`;
      for (const f of dueSoon) {
        const when =
          f.days < 0  ? `overdue by ${Math.abs(f.days)} day${Math.abs(f.days) !== 1 ? 's' : ''} ⚠️` :
          f.days === 0 ? `due today ⚠️` :
          `due in ${f.days} day${f.days !== 1 ? 's' : ''}${f.days <= 14 ? ' ⏰' : ''}`;
        msg += `• ${f.name} — audit ${when}\n`;
      }
      msg += '\n';
    }
  }

  // ── Custom reminders (unread notifications) ──
  if (settings.show_reminders) {
    const { data: reminders } = await supabase
      .from('notifications')
      .select('message')
      .eq('user_id', userId)
      .eq('is_read', false)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, settings.reminders_max));

    if ((reminders ?? []).length > 0) {
      msg += `🔔 *Reminders:*\n`;
      for (const r of reminders as Array<{ message: string }>) {
        msg += `• ${r.message}\n`;
      }
    }
  }

  console.log(`[BRIEFING] Sending message to chatId=${user.telegram_chat_id} (${msg.length} chars)`);
  await tgSend(user.telegram_bot_token, user.telegram_chat_id, msg);
  console.log(`[BRIEFING] Message sent ✅`);

  // Persist briefing to conversation history (best-effort)
  try {
    await supabase.from('telegram_conversations').insert({
      user_id: userId, role: 'assistant', message: msg,
    });
  } catch { /* ignore */ }
}

// ── Scheduler: called every minute by cron ────────────────────────────────────
export async function sendScheduledBriefings(): Promise<void> {
  const now = new Date();

  const { data: allSettings } = await supabase
    .from('telegram_briefing_settings')
    .select('*')
    .eq('enabled', true);

  if (!allSettings?.length) {
    console.log(`[BRIEFING TICK] ${now.toISOString()} — no enabled briefing settings found`);
    return;
  }

  console.log(`[BRIEFING TICK] ${now.toISOString()} — checking ${allSettings.length} user(s)`);

  for (const s of allSettings) {
    try {
      const tz = (s.timezone as string | null) ?? 'Australia/Sydney';

      // ── Reliable timezone-aware time extraction via Intl.DateTimeFormat ──
      // Avoids the 'new Date(toLocaleString())' hack which can misbehave on
      // some Node/V8 versions and produces wrong getDay() / getHours() values.

      const timeParts = new Intl.DateTimeFormat('en-AU', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);

      // Some engines return '24' for midnight with hour12:false — normalise to '00'
      const rawHh = timeParts.find(p => p.type === 'hour')?.value ?? '00';
      const hh = rawHh === '24' ? '00' : rawHh;
      const mm = timeParts.find(p => p.type === 'minute')?.value ?? '00';
      const currentTime = `${hh}:${mm}`;

      // ── Day of week ──
      const weekdayLong = new Intl.DateTimeFormat('en-AU', {
        timeZone: tz,
        weekday: 'long',
      }).format(now).toLowerCase(); // e.g. 'wednesday'
      const DAY_PREFIX: Record<string, string> = {
        monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu',
        friday: 'fri', saturday: 'sat', sunday: 'sun',
      };
      const currentDay = DAY_PREFIX[weekdayLong] ?? weekdayLong.slice(0, 3);

      // ── Calendar date in user's timezone (YYYY-MM-DD) ──
      const dateParts = new Intl.DateTimeFormat('en-AU', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const yr  = dateParts.find(p => p.type === 'year')?.value  ?? '';
      const mo  = dateParts.find(p => p.type === 'month')?.value ?? '';
      const dy  = dateParts.find(p => p.type === 'day')?.value   ?? '';
      const todayDate = `${yr}-${mo}-${dy}`;

      const timeMatch   = s.send_time === currentTime;
      const dayMatch    = (s.days as string[]).includes(currentDay);
      const alreadySent = s.last_sent_date === todayDate;

      console.log(
        `[BRIEFING TICK] user=${s.user_id} | tz=${tz} | ` +
        `now=${currentTime} | set=${s.send_time} | ` +
        `day=${currentDay}(${dayMatch ? '✓' : '✗'}) | ` +
        `alreadySent=${alreadySent} | ` +
        `verdict=${!timeMatch ? 'skip(time)' : !dayMatch ? 'skip(day)' : alreadySent ? 'skip(sent)' : '✅ FIRE'}`
      );

      if (!timeMatch || !dayMatch || alreadySent) continue;

      await sendMorningBriefing(s.user_id as string, s as unknown as BriefingSettings);

      await supabase
        .from('telegram_briefing_settings')
        .update({ last_sent_date: todayDate })
        .eq('user_id', s.user_id);

      console.log(`[BRIEFING] ✅ Sent morning briefing to user ${s.user_id}`);
    } catch (err) {
      console.error(`[BRIEFING] Failed for user ${s.user_id}:`, err);
    }
  }
}

// ── Start bots for all users on server boot ───────────────────────────────────
export async function startAllUserBots(): Promise<void> {
  console.log('[BOOT] startAllUserBots() called — querying users with Telegram tokens...');

  const { data: users, error } = await supabase
    .from('users')
    .select('id, telegram_bot_token')
    .not('telegram_bot_token', 'is', null);

  if (error) {
    console.error('[BOOT] Failed to fetch users for bot startup:', error);
    return;
  }

  const count = users?.length ?? 0;
  console.log(`[BOOT] Found ${count} user(s) with Telegram tokens`);

  for (const user of users ?? []) {
    if (user.telegram_bot_token) {
      try {
        await startUserBot(user.id, user.telegram_bot_token);
      } catch (err) {
        console.error(`[BOOT] Failed to start bot for user ${user.id}:`, err);
      }
    }
  }

  console.log('[BOOT] startAllUserBots() complete');
}
