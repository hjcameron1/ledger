import TelegramBot from 'node-telegram-bot-api';
import { supabase } from '../utils/supabase';
import { telegramAIResponse } from './claudeService';

const activeBots = new Map<string, TelegramBot>();

export async function startUserBot(userId: string, botToken: string): Promise<void> {
  if (activeBots.has(userId)) {
    activeBots.get(userId)!.stopPolling();
  }

  const bot = new TelegramBot(botToken, { polling: true });
  activeBots.set(userId, bot);

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    if (!text) return;

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

export async function sendMorningBriefing(userId: string): Promise<void> {
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (!user?.telegram_bot_token) return;

  const bot = new TelegramBot(user.telegram_bot_token);

  const [
    { data: accounts },
    { data: investments },
    { data: creditCards },
    { data: bills },
    { data: goals },
  ] = await Promise.all([
    supabase.from('bank_accounts').select('balance, currency').eq('user_id', userId),
    supabase.from('investments').select('current_value, name, current_price, last_price_update').eq('user_id', userId),
    supabase.from('credit_cards').select('balance_owing').eq('user_id', userId),
    supabase.from('bills').select('*').eq('user_id', userId).eq('is_paid', false).order('due_date').limit(5),
    supabase.from('goals').select('*').eq('user_id', userId),
  ]);

  const bankTotal = (accounts ?? []).reduce((s, a) => s + a.balance, 0);
  const investTotal = (investments ?? []).reduce((s, i) => s + i.current_value, 0);
  const ccTotal = (creditCards ?? []).reduce((s, c) => s + c.balance_owing, 0);
  const netWorth = bankTotal + investTotal - ccTotal;

  const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const curr = user.currency_preference ?? 'AUD';
  const fmt = (n: number) => `$${n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  let msg = `Good morning ${user.name} 👋 Here's your Ledger briefing for ${today}:\n\n`;
  msg += `💰 Net Worth: ${fmt(netWorth)} ${curr}\n`;
  msg += `🏦 Bank Accounts: ${fmt(bankTotal)} ${curr}\n`;
  msg += `💳 Credit Cards: ${fmt(ccTotal)} owing\n`;
  msg += `📈 Investments: ${fmt(investTotal)} ${curr}\n\n`;

  if (bills?.length) {
    msg += `📋 Upcoming bills:\n`;
    for (const b of bills) {
      const due = new Date(b.due_date);
      const daysLeft = Math.ceil((due.getTime() - Date.now()) / 86400000);
      const urgency = daysLeft <= 1 ? ' ⚠️' : daysLeft <= 3 ? ' ⏰' : '';
      msg += `• ${b.name} — ${fmt(b.amount)} due in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}${urgency}\n`;
    }
    msg += '\n';
  }

  if (goals?.length) {
    msg += `🎯 Goals:\n`;
    for (const g of goals) {
      const pct = Math.round((g.current_amount / g.target_amount) * 100);
      msg += `• ${g.name}: ${fmt(g.current_amount)} of ${fmt(g.target_amount)} (${pct}%)\n`;
    }
  }

  try {
    const { data: chatData } = await supabase
      .from('telegram_conversations')
      .select('message')
      .eq('user_id', userId)
      .limit(1);

    if (chatData?.length) {
      // We have a chat history — get the chat ID from a previous message
      // In production you'd store the chat_id per user
    }
    await supabase.from('telegram_conversations').insert({
      user_id: userId, role: 'assistant', message: msg,
    });
  } catch { /* ignore */ }
}

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
