import TelegramBot from 'node-telegram-bot-api';
import { supabase } from '../utils/supabase';
import { telegramAIResponse, TelegramTool } from './claudeService';
import { convertAmount } from './currencyService';
import { recordNetWorthSnapshot } from './netWorthSnapshot';

// Format "now" in a given timezone as a human-readable string for the AI prompt,
// so the bot knows the real date/time (and greets correctly).
function nowInTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toString();
  }
}

// The user's configured briefing timezone (best-effort) so chat date/time is local.
async function getUserTimezone(userId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('telegram_briefing_settings')
      .select('timezone')
      .eq('user_id', userId)
      .single();
    return (data?.timezone as string) || 'Australia/Sydney';
  } catch {
    return 'Australia/Sydney';
  }
}

// ── Generic, schema-aware data tools ──────────────────────────────────────────
// Rather than one tool per action, the bot gets generic CRUD over a WHITELIST of
// user-facing tables. This lets it do anything a human can in the app (add/edit/
// remove accounts, cards, transactions, investments, super, income, bills, goals,
// budgets, subscriptions) while staying safe: only listed tables/columns are
// reachable, every row is hard-scoped to this user_id, and sensitive tables
// (users, tokens, auth) are simply not in the registry.

interface TableDef {
  label: string;
  columns: string[];          // columns the bot may read/write (never id/user_id/timestamps)
  required: string[];         // required on create
  note?: string;              // guidance shown to the model
}

const TABLE_REGISTRY: Record<string, TableDef> = {
  bank_accounts: {
    label: 'Bank accounts',
    columns: ['name', 'institution', 'account_type', 'balance', 'bsb', 'account_number', 'currency'],
    required: ['name', 'institution', 'account_type', 'balance'],
    note: 'account_type e.g. transaction|savings|offset. balance is a plain number.',
  },
  credit_cards: {
    label: 'Credit cards',
    columns: ['name', 'institution', 'balance_owing', 'credit_limit', 'minimum_payment', 'due_date', 'currency'],
    required: ['name', 'institution'],
    note: 'balance_owing is the amount owed (positive number). due_date is YYYY-MM-DD.',
  },
  transactions: {
    label: 'Transactions',
    columns: ['account_id', 'account_type', 'date', 'merchant', 'amount', 'currency', 'category', 'notes', 'is_subscription'],
    required: ['date', 'merchant', 'amount'],
    note: 'account_type is bank|credit_card. date is YYYY-MM-DD. account_id is the id of a bank account or card (query first to find it).',
  },
  subscriptions: {
    label: 'Subscriptions',
    columns: ['name', 'amount', 'currency', 'frequency', 'next_charge_date', 'account_id', 'category'],
    required: ['name', 'amount', 'frequency'],
    note: 'frequency e.g. weekly|fortnightly|monthly|quarterly|annually. next_charge_date is YYYY-MM-DD.',
  },
  investments: {
    label: 'Investments / holdings',
    columns: ['name', 'ticker', 'market', 'asset_type', 'shares_owned', 'cost_basis', 'current_value', 'native_currency'],
    required: ['name', 'market', 'asset_type'],
    note: 'market e.g. ASX|NYSE|NASDAQ|Crypto. ASX tickers end in .AX. asset_type e.g. stock|etf|crypto|managed_fund|other. cost_basis is TOTAL paid. Prices for tickered holdings refresh automatically on the next hourly cycle.',
  },
  super_funds: {
    label: 'Superannuation funds',
    columns: ['fund_name', 'member_number', 'balance', 'employer_contributions', 'personal_contributions', 'investment_option', 'insurance_details', 'fees', 'include_in_investments', 'include_in_net_worth'],
    required: ['fund_name', 'balance'],
  },
  income_entries: {
    label: 'Income entries',
    columns: ['source', 'amount', 'currency', 'category', 'frequency', 'is_recurring', 'date', 'status', 'tax_withheld', 'super_contribution'],
    required: ['source', 'amount', 'category', 'date'],
    note: 'date is YYYY-MM-DD. status is approved|pending (default approved). category e.g. salary|dividend|interest|other.',
  },
  bills: {
    label: 'Bills & reminders',
    columns: ['name', 'amount', 'due_date', 'is_recurring', 'frequency', 'colour', 'is_paid', 'paid_at'],
    required: ['name', 'amount', 'due_date'],
    note: 'due_date is YYYY-MM-DD. colour is grey|yellow|red. amount can be 0 for a pure reminder. To mark paid, set is_paid true.',
  },
  goals: {
    label: 'Savings goals',
    columns: ['name', 'target_amount', 'current_amount', 'target_date', 'include_in_briefing'],
    required: ['name', 'target_amount'],
    note: 'target_date is YYYY-MM-DD.',
  },
  budgets: {
    label: 'Budgets',
    columns: ['category', 'limit_amount', 'period', 'rollover_enabled'],
    required: ['category', 'limit_amount'],
    note: 'period is weekly|monthly|yearly.',
  },
  smsf_funds: {
    label: 'SMSF funds',
    columns: ['name', 'abn', 'trustee_type', 'is_audited', 'last_audited_on', 'audit_due_on'],
    required: ['name'],
    note: 'trustee_type is individual|corporate. Dates are YYYY-MM-DD.',
  },
  smsf_members: {
    label: 'SMSF members',
    columns: ['fund_id', 'full_name', 'balance', 'total_super_balance'],
    required: ['fund_id', 'full_name'],
    note: 'fund_id is the id of an smsf_funds row (query smsf_funds first).',
  },
  smsf_assets: {
    label: 'SMSF assets',
    columns: ['fund_id', 'asset_type', 'label', 'amount'],
    required: ['fund_id', 'asset_type', 'label'],
    note: 'fund_id is the id of an smsf_funds row. asset_type e.g. cash|shares|property. amount in AUD.',
  },
  smsf_contributions: {
    label: 'SMSF contributions',
    columns: ['member_id', 'contribution_type', 'amount', 'contributed_on', 'financial_year'],
    required: ['member_id', 'contribution_type', 'amount', 'contributed_on', 'financial_year'],
    note: 'member_id is the id of an smsf_members row. contribution_type is concessional|non_concessional. contributed_on is YYYY-MM-DD. financial_year like "2025-26".',
  },
};

// Keep only whitelisted columns; never let user_id or system columns be set by the model.
function sanitise(table: string, values: Record<string, unknown>): Record<string, unknown> {
  const def = TABLE_REGISTRY[table];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(values ?? {})) {
    if (def.columns.includes(k)) out[k] = values[k];
  }
  return out;
}

// A compact schema reference injected into the prompt so the model writes valid data.
function schemaDoc(): string {
  const lines = Object.entries(TABLE_REGISTRY).map(([t, d]) =>
    `- ${t} (${d.label}): columns [${d.columns.join(', ')}]; required on create [${d.required.join(', ')}]${d.note ? `. ${d.note}` : ''}`,
  );
  return lines.join('\n');
}

// Tools the interactive bot can actually execute against the user's data.
function buildTelegramTools(userId: string, _tz: string): TelegramTool[] {
  const tableEnum = Object.keys(TABLE_REGISTRY);

  return [
    {
      spec: {
        name: 'query_data',
        description: 'Read the user\'s records from a table (e.g. to answer questions, or to find a record\'s id before updating/deleting it). Returns up to `limit` rows.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', enum: tableEnum },
            match: { type: 'object', description: 'Optional exact-match column filters, e.g. {"name":"Netflix"}. Omit to return all rows.' },
            limit: { type: 'number', description: 'Max rows (default 50).' },
          },
          required: ['table'],
        },
      },
      run: async (input: { table: string; match?: Record<string, unknown>; limit?: number }) => {
        if (!TABLE_REGISTRY[input.table]) return `Error: unknown table "${input.table}".`;
        let q = supabase.from(input.table).select('*').eq('user_id', userId).limit(Math.min(100, input.limit ?? 50));
        for (const [k, v] of Object.entries(sanitise(input.table, input.match ?? {}))) q = q.eq(k, v as never);
        const { data, error } = await q;
        if (error) return `Error: ${error.message}`;
        return JSON.stringify(data ?? []);
      },
    },
    {
      spec: {
        name: 'create_record',
        description: 'Create a new record (add an account, card, transaction, investment, super fund, income entry, bill/reminder, goal, budget, or subscription). Confirm details with the user first if anything is ambiguous.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', enum: tableEnum },
            values: { type: 'object', description: 'Column→value map. See the schema reference in the system prompt for valid columns and required fields.' },
          },
          required: ['table', 'values'],
        },
      },
      run: async (input: { table: string; values: Record<string, unknown> }) => {
        const def = TABLE_REGISTRY[input.table];
        if (!def) return `Error: unknown table "${input.table}".`;
        const clean = sanitise(input.table, input.values);
        const missing = def.required.filter(r => clean[r] === undefined || clean[r] === null || clean[r] === '');
        if (missing.length) return `Error: missing required field(s): ${missing.join(', ')}.`;
        const { data, error } = await supabase.from(input.table).insert({ ...clean, user_id: userId }).select().single();
        if (error) { console.error(`[BOT TOOL create ${input.table}]`, error.message); return `Error: could not create record (${error.message}).`; }
        return `Created in ${def.label} (id ${data.id}).`;
      },
    },
    {
      spec: {
        name: 'update_record',
        description: 'Update an existing record by id (e.g. edit a balance, change a due date, mark a bill paid). Use query_data first to find the id.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', enum: tableEnum },
            id: { type: 'string', description: 'The id of the record to update.' },
            values: { type: 'object', description: 'Column→value map of fields to change.' },
          },
          required: ['table', 'id', 'values'],
        },
      },
      run: async (input: { table: string; id: string; values: Record<string, unknown> }) => {
        const def = TABLE_REGISTRY[input.table];
        if (!def) return `Error: unknown table "${input.table}".`;
        const clean = sanitise(input.table, input.values);
        if (!Object.keys(clean).length) return 'Error: no valid fields to update.';
        const { data, error } = await supabase
          .from(input.table).update(clean).eq('id', input.id).eq('user_id', userId).select();
        if (error) return `Error: ${error.message}`;
        if (!data?.length) return 'Error: no matching record found (wrong id, or it is not yours).';
        return `Updated ${def.label} (id ${input.id}).`;
      },
    },
    {
      spec: {
        name: 'delete_record',
        description: 'Permanently delete a record by id (e.g. remove an account, card, investment, bill). Always confirm with the user before deleting.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', enum: tableEnum },
            id: { type: 'string', description: 'The id of the record to delete.' },
          },
          required: ['table', 'id'],
        },
      },
      run: async (input: { table: string; id: string }) => {
        const def = TABLE_REGISTRY[input.table];
        if (!def) return `Error: unknown table "${input.table}".`;
        // Clean up child transactions when removing an account/card, mirroring the app.
        if (input.table === 'bank_accounts' || input.table === 'credit_cards') {
          await supabase.from('transactions').delete().eq('account_id', input.id).eq('user_id', userId);
        }
        const { data, error } = await supabase
          .from(input.table).delete().eq('id', input.id).eq('user_id', userId).select();
        if (error) return `Error: ${error.message}`;
        if (!data?.length) return 'Error: no matching record found (wrong id, or it is not yours).';
        return `Deleted from ${def.label} (id ${input.id}).`;
      },
    },
    {
      spec: {
        name: 'sell_investment',
        description:
          'Sell some or all units of a holding through the proper sale flow: records a realised-gain sale (with AU CGT 50% discount logic if held >12 months), then reduces the holding\'s units or removes it if fully sold. Use this for "sell N shares of X" rather than editing units directly. Find the holding id with query_data on investments first.',
        input_schema: {
          type: 'object',
          properties: {
            investment_id: { type: 'string', description: 'The id of the holding being sold (from query_data on investments).' },
            quantity: { type: 'number', description: 'Number of units/shares to sell.' },
            proceeds: { type: 'number', description: 'Total sale proceeds received (before fees), in the holding\'s currency.' },
            fees: { type: 'number', description: 'Brokerage/fees on the sale. Default 0.' },
            sale_date: { type: 'string', description: 'Sale date YYYY-MM-DD. Defaults to today.' },
            acquired_date: { type: 'string', description: 'Original purchase date YYYY-MM-DD, if known — needed for the CGT 50% discount eligibility (held > 12 months).' },
          },
          required: ['investment_id', 'quantity', 'proceeds'],
        },
      },
      run: async (input: { investment_id: string; quantity: number; proceeds: number; fees?: number; sale_date?: string; acquired_date?: string }) => {
        const qty = Number(input.quantity) || 0;
        if (qty <= 0) return 'Error: quantity must be greater than 0.';

        const { data: inv, error: invErr } = await supabase
          .from('investments')
          .select('id, name, ticker, asset_type, market, shares_owned, cost_basis, native_currency')
          .eq('id', input.investment_id).eq('user_id', userId).single();
        if (invErr || !inv) return 'Error: holding not found (wrong id, or it is not yours).';

        const heldUnits = Number(inv.shares_owned) || 0;
        if (qty > heldUnits + 1e-8) return `Error: you only hold ${heldUnits} unit(s) of ${inv.name}.`;

        const proceeds = Number(input.proceeds) || 0;
        const fees = Number(input.fees) || 0;
        // Cost basis apportioned to the units being sold.
        const fraction = heldUnits > 0 ? qty / heldUnits : 0;
        const costPortion = Number(((Number(inv.cost_basis) || 0) * fraction).toFixed(2));
        const saleDate = input.sale_date || new Date().toISOString().slice(0, 10);
        const acquiredDate = input.acquired_date || null;
        const gain = Number((proceeds - fees - costPortion).toFixed(2));
        let heldDays: number | null = null;
        if (acquiredDate) heldDays = Math.round((new Date(saleDate).getTime() - new Date(acquiredDate).getTime()) / 86_400_000);
        const discountEligible = heldDays != null && heldDays > 365 && gain > 0;

        const { error: saleErr } = await supabase.from('investment_sales').insert({
          user_id: userId,
          investment_id: inv.id,
          name: inv.name,
          ticker: inv.ticker ?? null,
          asset_type: inv.asset_type ?? null,
          market: inv.market ?? null,
          quantity: qty,
          proceeds,
          fees,
          cost_basis: costPortion,
          acquired_date: acquiredDate,
          sale_date: saleDate,
          gain,
          held_days: heldDays,
          discount_eligible: discountEligible,
          currency: inv.native_currency ?? 'AUD',
        });
        if (saleErr) return `Error: could not record the sale (${saleErr.message}).`;

        // Reduce the holding (proportional cost basis), or remove it if fully sold.
        const remaining = Number((heldUnits - qty).toFixed(8));
        if (remaining <= 1e-8) {
          await supabase.from('investments').delete().eq('id', inv.id).eq('user_id', userId);
        } else {
          await supabase.from('investments').update({
            shares_owned: remaining,
            cost_basis: Number(((Number(inv.cost_basis) || 0) - costPortion).toFixed(2)),
          }).eq('id', inv.id).eq('user_id', userId);
        }

        recordNetWorthSnapshot(userId).catch(() => { /* best-effort */ });
        const cgt = acquiredDate
          ? (discountEligible ? ' Held >12 months, so the 50% CGT discount applies.' : ` Held ${heldDays} days — no CGT discount.`)
          : ' (Tip: give the purchase date next time so I can work out the CGT discount.)';
        return `Sold ${qty} of ${inv.name} for ${proceeds} ${inv.native_currency ?? 'AUD'}. Realised ${gain >= 0 ? 'gain' : 'loss'} of ${Math.abs(gain)}.${cgt} ${remaining <= 1e-8 ? 'Holding fully closed.' : `${remaining} unit(s) remain.`}`;
      },
    },
  ];
}

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

      const tz = await getUserTimezone(userId);
      const userContext = {
        name: user?.name ?? 'there',
        currency: user?.currency_preference ?? 'AUD',
        now: nowInTz(tz),
        timezone: tz,
        schema: schemaDoc(),
        tools: buildTelegramTools(userId, tz),
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

      // Minutes-of-day comparison with a catch-up window. An exact minute match is
      // fragile: if the every-minute cron is briefly busy/asleep at the target
      // minute (common on Render's free tier), that single minute is missed and the
      // briefing never fires that day. Instead we fire on the FIRST tick that is
      // at/after the target time, within a 90-minute catch-up window, once per day.
      // The window cap stops a long outage from firing a "morning" briefing in the
      // afternoon — if missed past the window, it's skipped until tomorrow.
      const toMinutes = (hhmm: string): number => {
        const [h, m] = String(hhmm).split(':');
        return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
      };
      const CATCH_UP_MIN = 90;
      const nowMins  = toMinutes(currentTime);
      const sendMins = toMinutes(String(s.send_time ?? '08:00'));
      const timeReady   = nowMins >= sendMins && nowMins < sendMins + CATCH_UP_MIN;
      const dayMatch    = (s.days as string[]).includes(currentDay);
      const alreadySent = s.last_sent_date === todayDate;

      console.log(
        `[BRIEFING TICK] user=${s.user_id} | tz=${tz} | ` +
        `now=${currentTime} | set=${s.send_time} | ` +
        `day=${currentDay}(${dayMatch ? '✓' : '✗'}) | ` +
        `alreadySent=${alreadySent} | ` +
        `verdict=${!timeReady ? 'skip(time)' : !dayMatch ? 'skip(day)' : alreadySent ? 'skip(sent)' : '✅ FIRE'}`
      );

      if (!timeReady || !dayMatch || alreadySent) continue;

      // CLAIM the day BEFORE sending. Two overlapping runs (e.g. during a deploy)
      // could both pass the checks above in the same minute and each send a
      // briefing — the duplicate-message bug. By writing last_sent_date first and
      // only proceeding if THIS run was the one that set it, we guarantee a single
      // send. The conditional update (neq on today) makes the claim atomic.
      const { data: claimed } = await supabase
        .from('telegram_briefing_settings')
        .update({ last_sent_date: todayDate })
        .eq('user_id', s.user_id)
        .neq('last_sent_date', todayDate)
        .select('user_id');

      if (!claimed?.length) {
        console.log(`[BRIEFING] Skipped user ${s.user_id} — already claimed by another run.`);
        continue;
      }

      await sendMorningBriefing(s.user_id as string, s as unknown as BriefingSettings);

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
