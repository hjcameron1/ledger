import TelegramBot from 'node-telegram-bot-api';
import { supabase } from '../utils/supabase';
import { telegramAIResponse } from './claudeService';

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
  if (activeBots.has(userId)) {
    activeBots.get(userId)!.stopPolling();
  }

  const bot = new TelegramBot(botToken, { polling: true });
  activeBots.set(userId, bot);

  bot.on('message', async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    if (!text) return;

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

    const reply = await telegramAIResponse(text, conversationHistory, userContext);

    await supabase.from('telegram_conversations').insert([
      { user_id: userId, role: 'user', message: text },
      { user_id: userId, role: 'assistant', message: reply },
    ]);

    await bot.sendMessage(chatId, reply);
  });
}

// ── Build and send personalised morning briefing ──────────────────────────────
export async function sendMorningBriefing(
  userId: string,
  settings: BriefingSettings = DEFAULT_SETTINGS,
): Promise<void> {
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (!user?.telegram_bot_token || !user?.telegram_chat_id) return;

  const tz = settings.timezone ?? 'Australia/Sydney';
  const curr = user.currency_preference ?? 'AUD';
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
      { data: accounts },
      { data: investments },
      { data: creditCards },
      { data: superFunds },
    ] = await Promise.all([
      supabase.from('bank_accounts').select('balance').eq('user_id', userId),
      supabase.from('investments').select('current_value, name, ticker, cost_basis').eq('user_id', userId),
      supabase.from('credit_cards').select('balance_owing').eq('user_id', userId),
      supabase.from('super_funds').select('balance, include_in_net_worth').eq('user_id', userId),
    ]);

    const bankTotal = (accounts ?? []).reduce((s: number, a: { balance: number }) => s + a.balance, 0);
    const investTotal = (investments ?? []).reduce((s: number, i: { current_value: number }) => s + i.current_value, 0);
    const ccTotal = (creditCards ?? []).reduce((s: number, c: { balance_owing: number }) => s + c.balance_owing, 0);
    const superTotal = (superFunds ?? [])
      .filter((f: { include_in_net_worth: boolean }) => f.include_in_net_worth)
      .reduce((s: number, f: { balance: number }) => s + f.balance, 0);
    const netWorth = bankTotal + investTotal - ccTotal + superTotal;

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
    if (settings.show_investments && settings.top_movers !== 'none' && (investments ?? []).length > 0) {
      const withPnl = (investments as Array<{ name: string; ticker?: string; current_value: number; cost_basis: number }>)
        .filter(i => i.cost_basis > 0)
        .map(i => ({
          name: i.name,
          ticker: i.ticker,
          pnlPct: ((i.current_value - i.cost_basis) / i.cost_basis) * 100,
        }))
        .sort((a, b) => b.pnlPct - a.pnlPct);

      if (withPnl.length > 0) {
        msg += `🔥 *Top Movers:*\n`;

        if (settings.top_movers === 'best_worst') {
          const best = withPnl[0];
          const worst = withPnl[withPnl.length - 1];
          const sign = (n: number) => (n >= 0 ? '+' : '');
          msg += `▲ ${best.name}${best.ticker ? ` (${best.ticker})` : ''}: ${sign(best.pnlPct)}${best.pnlPct.toFixed(1)}%\n`;
          if (withPnl.length > 1) {
            msg += `▼ ${worst.name}${worst.ticker ? ` (${worst.ticker})` : ''}: ${sign(worst.pnlPct)}${worst.pnlPct.toFixed(1)}%\n`;
          }
        } else {
          const count = settings.top_movers === 'top5' ? 5 : 3;
          for (const inv of withPnl.slice(0, count)) {
            const arrow = inv.pnlPct >= 0 ? '▲' : '▼';
            const sign = inv.pnlPct >= 0 ? '+' : '';
            msg += `${arrow} ${inv.name}${inv.ticker ? ` (${inv.ticker})` : ''}: ${sign}${inv.pnlPct.toFixed(1)}%\n`;
          }
        }
        msg += '\n';
      }
    }
  }

  // ── Upcoming bills ──
  if (settings.show_bills) {
    const { data: bills } = await supabase
      .from('bills')
      .select('name, amount, due_date')
      .eq('user_id', userId)
      .eq('is_paid', false)
      .order('due_date')
      .limit(Math.max(1, Math.min(10, settings.bills_count)));

    if ((bills ?? []).length > 0) {
      msg += `📋 *Upcoming Bills:*\n`;
      for (const b of bills as Array<{ name: string; amount: number; due_date: string }>) {
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
    const { data: goals } = await supabase
      .from('goals')
      .select('name, current_amount, target_amount')
      .eq('user_id', userId);

    if ((goals ?? []).length > 0) {
      msg += `🎯 *Goals:*\n`;
      for (const g of goals as Array<{ name: string; current_amount: number; target_amount: number }>) {
        const pct = Math.round((g.current_amount / g.target_amount) * 100);
        msg += `• ${g.name}: ${fmt(g.current_amount)} of ${fmt(g.target_amount)} (${pct}%)\n`;
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

  await tgSend(user.telegram_bot_token, user.telegram_chat_id, msg);

  // Persist briefing to conversation history (best-effort)
  try {
    await supabase.from('telegram_conversations').insert({
      user_id: userId, role: 'assistant', message: msg,
    });
  } catch { /* ignore */ }
}

// ── Scheduler: called every minute by cron ────────────────────────────────────
export async function sendScheduledBriefings(): Promise<void> {
  const { data: allSettings } = await supabase
    .from('telegram_briefing_settings')
    .select('*')
    .eq('enabled', true);

  if (!allSettings?.length) return;

  for (const s of allSettings) {
    try {
      const tz = (s.timezone as string | null) ?? 'Australia/Sydney';
      // Get current local time in the user's timezone
      const userNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const hh = String(userNow.getHours()).padStart(2, '0');
      const mm = String(userNow.getMinutes()).padStart(2, '0');
      const currentTime = `${hh}:${mm}`;
      const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const currentDay = dayNames[userNow.getDay()];
      const todayDate = `${userNow.getFullYear()}-${String(userNow.getMonth() + 1).padStart(2, '0')}-${String(userNow.getDate()).padStart(2, '0')}`;

      if (s.send_time !== currentTime) continue;
      if (!(s.days as string[]).includes(currentDay)) continue;
      if (s.last_sent_date === todayDate) continue;

      await sendMorningBriefing(s.user_id as string, s as unknown as BriefingSettings);

      await supabase
        .from('telegram_briefing_settings')
        .update({ last_sent_date: todayDate })
        .eq('user_id', s.user_id);

      console.log(`[BRIEFING] Sent to user ${s.user_id}`);
    } catch (err) {
      console.error(`[BRIEFING] Failed for user ${s.user_id}:`, err);
    }
  }
}

// ── Start bots for all users on server boot ───────────────────────────────────
export async function startAllUserBots(): Promise<void> {
  const { data: users } = await supabase
    .from('users')
    .select('id, telegram_bot_token')
    .not('telegram_bot_token', 'is', null);

  for (const user of users ?? []) {
    if (user.telegram_bot_token) {
      try {
        await startUserBot(user.id, user.telegram_bot_token);
      } catch { /* invalid token, skip */ }
    }
  }
}
