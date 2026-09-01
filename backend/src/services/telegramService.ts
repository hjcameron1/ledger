import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';
import { jwtSecret } from '../utils/env';
import { supabase } from '../utils/supabase';
import { telegramAIResponse, TelegramTool } from './claudeService';
import { convertAmount, convertBalance } from './currencyService';
import { investmentValueInPreferred, investmentValueNative } from './investmentValue';
import { recordNetWorthSnapshot, getItemChanges, propertyNetWorthTotal, computeNetWorth } from './netWorthSnapshot';
import { handleTelegramCallback } from './householdChangeRequests';

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
    note: 'date is YYYY-MM-DD. status is approved|pending (default approved). category e.g. salary|dividend|interest|other. IMPORTANT: When the user logs income that is salary or wage AND includes tax_withheld or super_contribution, ASK whether this is also a payslip. If yes, ALSO create a payslips record (table: payslips) with employer=source, payment_date=date, gross_pay=amount, net_pay=amount-tax_withheld, tax_withheld, super_amount=super_contribution, pay_frequency=frequency||fortnightly.',
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
  payslips: {
    label: 'Payslips',
    columns: ['employer', 'abn', 'employee_name', 'employment_type', 'pay_period_start', 'pay_period_end', 'payment_date', 'pay_frequency', 'gross_pay', 'net_pay', 'tax_withheld', 'super_amount', 'super_rate', 'ytd_gross', 'ytd_tax', 'ytd_super', 'leave_balance', 'sick_leave_balance', 'hourly_rate', 'allowances', 'deductions', 'cycle_label'],
    required: ['employer', 'gross_pay', 'net_pay', 'tax_withheld'],
    note: 'Dates are YYYY-MM-DD. employment_type is full_time|part_time|casual. pay_frequency is weekly|fortnightly|monthly. allowances and deductions are JSON arrays.',
  },
  stock_watchlist: {
    label: 'Stock Watchlist',
    columns: ['ticker', 'name', 'market', 'alert_enabled', 'target_price', 'alert_direction'],
    required: ['ticker', 'name'],
    note: 'Stocks the user wants to monitor without owning. market defaults to ASX. alert_enabled (bool) + target_price + alert_direction (above|below) for price alerts. Prices refresh hourly automatically.',
  },
  notifications: {
    label: 'Reminders & alerts',
    columns: ['type', 'message', 'link', 'detail', 'is_read'],
    required: ['message'],
    note: 'A pure reminder or note with NO money/amount and NO fixed payment due date. When the user says "remind me to…", "note that…", or wants a nudge, create one here with type:"reminder" and message set to the reminder text — do NOT use bills for these. Only use bills when there is an amount to pay or a real due date.',
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
        let rows = data ?? [];

        // Foreign-currency holdings store current_value/cost_basis in their NATIVE
        // currency (e.g. a USD ETF), while the `currency` column may say 'AUD'. If we
        // hand the raw rows to the model it reports the native number as the user's
        // currency — e.g. "$18,750" for a holding actually worth ~$26,600 AUD. Enrich
        // investment rows with values converted to the user's preferred currency, plus
        // an explicit instruction to use them, so the bot quotes the right figure.
        if (input.table === 'investments' && rows.length) {
          const { data: u } = await supabase
            .from('users').select('currency_preference').eq('id', userId).single();
          const pref = u?.currency_preference ?? 'AUD';
          rows = await Promise.all(rows.map(async (r: Record<string, unknown>) => {
            const native = (r.native_currency as string) || (r.currency as string) || pref;
            const { converted: valuePref } = await convertAmount(Number(r.current_value) || 0, native, pref);
            const costCcy = (r.cost_basis_currency as string) || native;
            const { converted: costPref } = await convertAmount(Number(r.cost_basis) || 0, costCcy, pref);
            const gainPct = costPref ? ((valuePref - costPref) / Math.abs(costPref)) * 100 : null;
            return {
              ...r,
              value_in_preferred: parseFloat(valuePref.toFixed(2)),
              cost_basis_in_preferred: parseFloat(costPref.toFixed(2)),
              gain_percent: gainPct === null ? null : parseFloat(gainPct.toFixed(2)),
              preferred_currency: pref,
              _currency_note:
                `current_value (${r.current_value}) is in ${native}, NOT ${pref}. ` +
                `When telling the user what this holding is worth, use value_in_preferred ` +
                `(${valuePref.toFixed(2)} ${pref}). Gain vs cost is gain_percent.`,
            };
          }));
        }
        return JSON.stringify(rows);
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
    {
      spec: {
        name: 'predict_next_pay',
        description:
          'Work out when the user is next paid. Reads their payslip history, infers the pay cycle from the actual gaps between pay dates (or the stated frequency), and projects forward from today. Use this for any "when do I get paid", "next payday", or "how long until I get paid" question.',
        input_schema: {
          type: 'object',
          properties: {
            employer: { type: 'string', description: 'Optional: restrict to one employer (substring match). Omit to use the most recent job.' },
          },
        },
      },
      run: async (input: { employer?: string }) => {
        const { data: slips, error } = await supabase
          .from('payslips')
          .select('employer, payment_date, pay_frequency, net_pay, gross_pay')
          .eq('user_id', userId)
          .not('payment_date', 'is', null)
          .order('payment_date', { ascending: false });
        if (error) return `Error: ${error.message}`;
        if (!slips?.length) return 'No payslips on file yet, so I can\'t work out a pay cycle. Add or upload a payslip first.';

        // Today in the user's timezone (YYYY-MM-DD).
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: _tz || 'Australia/Sydney' }).format(new Date());

        // Focus on one employer: the requested one, else the most recent payslip's employer.
        const wanted = input.employer?.trim().toLowerCase();
        const targetEmployer = wanted
          ? (slips.find(s => (s.employer ?? '').toLowerCase().includes(wanted))?.employer ?? null)
          : slips[0].employer;
        const mine = slips
          .filter(s => (targetEmployer ? s.employer === targetEmployer : true) && s.payment_date)
          .sort((a, b) => (a.payment_date! < b.payment_date! ? 1 : -1)); // newest first

        const last = mine[0];
        const lastDate = last.payment_date as string;
        const dayMs = 86_400_000;
        const addDays = (iso: string, n: number) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * dayMs).toISOString().slice(0, 10);
        const addMonths = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
        const diffDays = (a: string, b: string) => Math.round((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / dayMs);

        // Infer the cycle from the median gap between consecutive pay dates (most
        // reliable — reflects what actually happens). Fall back to the stated
        // pay_frequency when there's only one payslip.
        let cycleKind: 'weekly' | 'fortnightly' | 'monthly' | `${number}-day`;
        let stepDays = 0; // 0 ⇒ use calendar months
        const dates = mine.map(s => s.payment_date as string);
        if (dates.length >= 2) {
          const gaps: number[] = [];
          for (let i = 0; i < dates.length - 1; i++) gaps.push(diffDays(dates[i], dates[i + 1]));
          gaps.sort((a, b) => a - b);
          const med = gaps[Math.floor(gaps.length / 2)];
          if (med >= 27 && med <= 31) { cycleKind = 'monthly'; stepDays = 0; }
          else if (med >= 12 && med <= 16) { cycleKind = 'fortnightly'; stepDays = 14; }
          else if (med >= 6 && med <= 8) { cycleKind = 'weekly'; stepDays = 7; }
          else { cycleKind = `${med}-day`; stepDays = med; }
        } else {
          const f = (last.pay_frequency as string) ?? 'fortnightly';
          if (f === 'weekly') { cycleKind = 'weekly'; stepDays = 7; }
          else if (f === 'monthly') { cycleKind = 'monthly'; stepDays = 0; }
          else { cycleKind = 'fortnightly'; stepDays = 14; }
        }

        // Project forward from the last pay until we land strictly after today.
        let next = stepDays > 0 ? addDays(lastDate, stepDays) : addMonths(lastDate, 1);
        let guard = 0;
        while (next <= today && guard++ < 400) next = stepDays > 0 ? addDays(next, stepDays) : addMonths(next, 1);

        const daysAway = diffDays(next, today);
        const net = Number(last.net_pay) || 0;
        const human = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`;
        // Format the weekday + date in code (anchored to UTC midnight so the
        // calendar date never shifts) — the model must NOT recompute this, as it
        // tends to pick the wrong weekday/day-number.
        const nextDateLabel = new Intl.DateTimeFormat('en-AU', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
        }).format(new Date(next + 'T00:00:00Z'));
        return JSON.stringify({
          employer: targetEmployer,
          pay_cycle: cycleKind,
          last_pay_date: lastDate,
          next_pay_date: next,
          next_pay_date_label: nextDateLabel,
          days_away: daysAway,
          typical_net_pay: net || null,
          _instruction:
            `Tell the user their next pay from ${targetEmployer ?? 'their job'} is ${nextDateLabel} (${human}), ` +
            `paid ${cycleKind}. Use this exact date and weekday verbatim — do NOT recalculate the day of week or day number yourself. ` +
            `${net ? `Their typical net pay is about ${net}.` : ''} ` +
            `Cycle was inferred from ${dates.length} payslip(s).`,
        });
      },
    },
  ];
}

// The user's REAL financial totals, so the chat bot is grounded in true numbers
// instead of fabricating them.
//
// Delegates to computeNetWorth — the same function the snapshot, the Overview
// trend and the breakdown popup all run through. It used to re-derive every
// total by hand here, which is how the bot came to quote a net worth that left
// SMSFs out, converted holdings at a live rate the app had never used, and moved
// against the app's figure whenever the two asked for a rate seconds apart.
// There is one net worth; this states it.
async function computeFinancialSummary(
  userId: string,
  curr: string,
): Promise<Record<string, unknown>> {
  try {
    const nw = await computeNetWorth(userId);
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      currency: nw.currency || curr,
      net_worth: round(nw.netWorth),
      bank_accounts_total: round(nw.bankBalance),
      bank_accounts: nw.items
        .filter(i => i.item_type === 'bank')
        .map(i => ({ name: i.name, balance: round(i.value) })),
      credit_cards_owing: round(nw.creditCardDebt),
      investments_total: round(nw.investments),
      superannuation_total: round(nw.super),
      property_total: round(nw.property),
      loans_total: round(nw.loans),
    };
  } catch (err) {
    console.error(`[BOT SUMMARY] Failed for user ${userId}:`, (err as Error).message);
    return {};
  }
}

const activeBots = new Map<string, TelegramBot>();

// ── Direct HTTP send (no polling required) ────────────────────────────────────
// parseMode defaults to Markdown (used by briefings). Pass null for plain text —
// conversational replies use plain so a stray * or _ in Claude's output can't make
// Telegram reject the whole message with a 400 "can't parse entities".
//
// The briefing cannot use plain text (its headings are the structure), so it gets
// the two protections below instead. Both exist because of the same report: a
// briefing that arrived every day for a week and then never again.
//
//   * Telegram refuses a message longer than 4096 characters OUTRIGHT. A briefing
//     grows with the portfolio behind it — more holdings, more bills, more goals —
//     so it crosses that line one ordinary day and never comes back under it.
//   * Legacy Markdown is all-or-nothing: one investment called "BHP_AU" or a bill
//     with a stray asterisk makes Telegram reject the WHOLE message. Renaming
//     something in the app is enough to silence the briefing forever.
//
// So: long messages are split, and a message refused over its formatting is sent
// again as plain text. Losing the bold is nothing; losing the briefing is the bug.
const TG_MAX_CHARS = 4096;

export interface SendResult { ok: boolean; error?: string }

/** Split on line breaks, so a long briefing arrives whole and in order. */
function splitForTelegram(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current) { parts.push(current); current = ''; }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) { parts.push(current); current = line; }
    else current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}

async function tgSendOne(
  botToken: string,
  chatId: string | number,
  text: string,
  parseMode: 'Markdown' | null,
): Promise<SendResult> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (data.ok) return { ok: true };

    if (parseMode && /parse/i.test(data.description ?? '')) {
      const plain = await tgSendOne(botToken, chatId, text.replace(/[*_`]/g, ''), null);
      if (plain.ok) {
        console.warn(`[TG] Markdown rejected (${data.description}) — sent as plain text.`);
        return { ok: true };
      }
      return plain;
    }
    return { ok: false, error: data.description ?? 'Telegram refused the message' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function tgSend(
  botToken: string,
  chatId: string | number,
  text: string,
  parseMode: 'Markdown' | null = 'Markdown',
): Promise<SendResult> {
  const chunks = text.length > TG_MAX_CHARS ? splitForTelegram(text) : [text];
  for (const chunk of chunks) {
    const res = await tgSendOne(botToken, chatId, chunk, parseMode);
    if (!res.ok) { console.error('[TG] sendMessage failed:', res.error); return res; }
  }
  return { ok: true };
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
  include_auto_pay: boolean;  // include ⚡ auto-payment bills in the briefing
  show_goals: boolean;
  show_reminders: boolean;
  reminders_max: number;
  // Per-item customisation (see settings route). Exclusion lists auto-include new
  // items; watched_investment_ids is an opt-in list of holdings to always show.
  excluded_bank_ids?: string[];
  excluded_card_ids?: string[];
  excluded_goal_ids?: string[];
  watched_investment_ids?: string[];
  show_watchlist?: boolean;
  excluded_watchlist_ids?: string[];
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
  include_auto_pay: true,
  show_goals: true,
  show_reminders: false,
  reminders_max: 5,
  excluded_bank_ids: [],
  excluded_card_ids: [],
  excluded_goal_ids: [],
  watched_investment_ids: [],
  show_watchlist: true,
  excluded_watchlist_ids: [],
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

  bot.on('message', (msg: TelegramBot.Message) => {
    void handleTelegramMessage(userId, botToken, msg);
  });

  // Apply/Keep buttons on household change alerts (local-dev path; production
  // presses arrive through the webhook route instead).
  bot.on('callback_query', (query: TelegramBot.CallbackQuery) => {
    handleTelegramCallback(userId, botToken, query).catch(err =>
      console.error(`[BOT] callback handling failed for user ${userId}:`, err));
  });

  console.log(`[BOT] Bot registered and polling for user ${userId}`);
}

/**
 * Handle one inbound Telegram message: build context, ask Claude, persist the
 * exchange, and reply. Shared by both delivery paths — local-dev long-polling
 * (startUserBot) and production webhooks (POST /api/telegram/webhook/:userId) —
 * so behaviour is identical regardless of how the update arrived. Sends via the
 * stateless HTTP helper (tgSend) so it needs no live TelegramBot instance.
 */
export async function handleTelegramMessage(
  userId: string,
  botToken: string,
  msg: { chat?: { id: number }; text?: string },
): Promise<void> {
  const chatId = msg.chat?.id;
  const text = msg.text ?? '';
  if (chatId == null) return;
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
    const curr = user?.currency_preference ?? 'AUD';
    const summary = await computeFinancialSummary(userId, curr);
    const userContext = {
      name: user?.name ?? 'there',
      currency: curr,
      now: nowInTz(tz),
      timezone: tz,
      schema: schemaDoc(),
      summary,
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

    // Plain text (no parse_mode) so special characters in Claude's reply never
    // trigger a Telegram parse error that would drop the whole message.
    await tgSend(botToken, chatId, reply, null);
    console.log(`[BOT] Message delivered to chatId=${chatId}`);
  } catch (err) {
    console.error(`[BOT] Error handling message for user ${userId}:`, err);
    try { await tgSend(botToken, chatId, 'Something went wrong on my end. Please try again.', null); } catch { /* ignore */ }
  }
}

// ── Webhook delivery (production) ──────────────────────────────────────────────
// Long-polling (getUpdates) is fragile: two instances polling the same token race
// and one gets "409 Conflict: terminated by other getUpdates request", and a poll
// loop can silently die after a network blip and stop delivering. A webhook has a
// single push-based delivery path, so neither failure mode exists. We register one
// webhook per user's bot at boot; Telegram then POSTs updates to
// /api/telegram/webhook/:userId, validated by a per-user secret header.

/**
 * Public base URL of this backend, used to build the Telegram webhook URL.
 * Prefers an explicit PUBLIC_BACKEND_URL, then Render's injected RENDER_EXTERNAL_URL,
 * then the known production host so webhooks work on deploy without extra config.
 */
export function publicBaseUrl(): string | null {
  const url =
    process.env.PUBLIC_BACKEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://ledger-80d8.onrender.com' : null);
  return url ? url.replace(/\/$/, '') : null;
}

/** Deterministic per-user webhook secret — no DB storage needed. */
export function webhookSecret(userId: string): string {
  return crypto
    .createHmac('sha256', jwtSecret())
    .update(`tg-webhook:${userId}`)
    .digest('hex')
    .slice(0, 48);
}

/** Point a user's bot at our webhook URL (replacing any polling/stale webhook). */
export async function registerWebhook(userId: string, botToken: string): Promise<boolean> {
  const base = publicBaseUrl();
  if (!base) {
    console.warn(`[BOT] No public base URL — cannot register webhook for user ${userId}. Set PUBLIC_BACKEND_URL.`);
    return false;
  }
  // A live poller in another instance holds getUpdates; setWebhook cleanly takes
  // over delivery and ends that conflict, so we don't need to stop polling first.
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${base}/api/telegram/webhook/${userId}`,
        secret_token: webhookSecret(userId),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (data.ok) {
      console.log(`[BOT] Webhook registered for user ${userId} → ${base}/api/telegram/webhook/${userId}`);
    } else {
      console.error(`[BOT] setWebhook failed for user ${userId}: ${data.description}`);
    }
    return data.ok;
  } catch (err) {
    console.error(`[BOT] setWebhook error for user ${userId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Register webhooks for every user with a bot token (production boot path). */
export async function registerAllWebhooks(): Promise<void> {
  console.log('[BOOT] registerAllWebhooks() — querying users with Telegram tokens...');
  const { data: users, error } = await supabase
    .from('users')
    .select('id, telegram_bot_token')
    .not('telegram_bot_token', 'is', null);
  if (error) { console.error('[BOOT] Failed to fetch users for webhook setup:', error); return; }
  console.log(`[BOOT] Found ${users?.length ?? 0} user(s) with Telegram tokens`);
  for (const user of users ?? []) {
    if (user.telegram_bot_token) await registerWebhook(user.id, user.telegram_bot_token);
  }
  console.log('[BOOT] registerAllWebhooks() complete');
}

// ── Build and send personalised morning briefing ──────────────────────────────
export async function sendMorningBriefing(
  userId: string,
  settings: BriefingSettings = DEFAULT_SETTINGS,
): Promise<SendResult> {
  console.log(`[BRIEFING] sendMorningBriefing start — userId=${userId}`);

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, name, email, currency_preference, telegram_bot_token, telegram_chat_id')
    .eq('id', userId)
    .single();

  console.log(`[BRIEFING] user fetch: found=${!!user} | name=${user?.name} | currency=${user?.currency_preference} | has_token=${!!user?.telegram_bot_token} | has_chat_id=${!!user?.telegram_chat_id} | err=${userErr?.message ?? 'none'}`);

  if (!user?.telegram_bot_token || !user?.telegram_chat_id) {
    console.warn(`[BRIEFING] Aborting — missing bot_token or chat_id for userId=${userId}`);
    return { ok: false, error: 'Telegram is not connected on this account' };
  }

  const tz = settings.timezone ?? 'Australia/Sydney';
  const curr = user.currency_preference ?? 'AUD';
  console.log(`[BRIEFING] Using currency=${curr}, timezone=${tz}`);

  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: tz,
  });
  const fmt = (n: number) =>
    `$${n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  // Time-aware greeting based on the user's local hour (a "morning" briefing can
  // be scheduled for any time of day, so don't hardcode "Good morning").
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', hour12: false })
      .formatToParts(new Date())
      .find(p => p.type === 'hour')?.value ?? '8',
    10,
  );
  const greeting =
    localHour < 12 ? 'Good morning' :
    localHour < 17 ? 'Good afternoon' :
    'Good evening';

  let msg = `${greeting} ${user.name} 👋 Here's your Ledger briefing for ${today}:\n\n`;

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
      { data: smsfFunds,   error: smsfErr },
      { data: smsfAssets },
      { data: loans,       error: loansErr },
      { data: properties,  error: propsErr },
    ] = await Promise.all([
      supabase.from('bank_accounts').select('id, balance, currency').eq('user_id', userId),
      supabase.from('investments')
        // asset_type/conversion_rate/display_currency are the rate rule's inputs,
        // not display fields — see investmentRate.
        .select('id, name, ticker, shares_owned, current_price, current_value, cost_basis, native_currency, asset_type, conversion_rate, display_currency')
        .eq('user_id', userId),
      supabase.from('credit_cards').select('id, balance_owing, currency').eq('user_id', userId),
      supabase.from('super_funds').select('id, balance, include_in_net_worth').eq('user_id', userId),
      // SMSFs are super too. Left out, the briefing quoted a net worth the app
      // never showed — and a property held in a fund it could not resolve was
      // counted here as well as inside the fund.
      supabase.from('smsf_funds').select('id, include_in_net_worth').eq('user_id', userId),
      supabase.from('smsf_assets').select('fund_id, amount').eq('user_id', userId),
      supabase.from('loans').select('id, current_balance, include_in_net_worth').eq('user_id', userId),
      // select('*') rather than a column list, for the same reason computeNetWorth
      // does it: the property-refinement columns are absent on older databases and
      // naming one 400s the whole query, which would zero the briefing's property
      // line instead of degrading to "no properties".
      supabase.from('properties').select('*').eq('user_id', userId),
    ]);

    // Log row counts and any query errors (no row contents — financial data).
    console.log(`[BRIEFING DATA] bank_accounts: ${accounts?.length ?? 0} row(s) | err=${accountsErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] investments: ${investments?.length ?? 0} row(s) | err=${investsErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] credit_cards: ${creditCards?.length ?? 0} row(s) | err=${ccErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] super_funds: ${superFunds?.length ?? 0} row(s) | err=${superErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] smsf_funds: ${smsfFunds?.length ?? 0} row(s) | err=${smsfErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] loans: ${loans?.length ?? 0} row(s) | err=${loansErr?.message ?? 'none'}`);
    console.log(`[BRIEFING DATA] properties: ${properties?.length ?? 0} row(s) | err=${propsErr?.message ?? 'none'}`);

    // Per-item exclusions: a section shows every item except those the user has
    // toggled off. Stored as string id arrays; coerce to Set<string> for lookup.
    const excludedBanks = new Set((settings.excluded_bank_ids ?? []).map(String));
    const excludedCards = new Set((settings.excluded_card_ids ?? []).map(String));

    // ── Bank total (with per-account currency conversion) ──
    let bankTotal = 0;
    for (const acc of accounts ?? []) {
      if (excludedBanks.has(String(acc.id))) continue;
      const balance = Number(acc.balance) || 0;
      const from = acc.currency ?? 'AUD';
      // The DAY's rate, the one enrichWithDisplayAmounts stamped on the row the
      // app is showing — so the briefing and the screen quote the same dollars.
      const { converted } = await convertBalance(balance, from, curr);
      console.log(`[BRIEFING CALC] bank: balance=${balance} ${from} → ${converted} ${curr}`);
      bankTotal += converted;
    }

    // ── Investment total — mirrors overview.ts exactly (one canonical valuation) ──
    let investTotal = 0;
    const tickerById = new Map<string, string | undefined>();
    // For the opt-in "Watching" list: name + converted current value per holding,
    // so a watched holding can still be shown even with no 24h baseline.
    const holdingById = new Map<string, { name: string; ticker?: string; value: number }>();
    for (const inv of investments ?? []) {
      const from = inv.native_currency ?? 'AUD';
      // units × price × the rate PINNED on the row — the one valuation the
      // snapshot, the Overview and the Investments page all use (see
      // investmentValue). A live quote here made the briefing's portfolio drift
      // from the app's by whatever the market had done since the last price
      // refresh; the `current_value` stamp made it drift by whatever had happened
      // to the holding since that stamp was last written.
      const rawValue = investmentValueNative(inv);
      const converted = await investmentValueInPreferred(inv, curr);
      console.log(`[BRIEFING CALC] invest: ${inv.ticker ?? inv.name} value=${rawValue} ${from} → ${converted} ${curr}`);
      investTotal += converted;
      tickerById.set(String(inv.id), inv.ticker ?? undefined);
      holdingById.set(String(inv.id), { name: inv.name, ticker: inv.ticker ?? undefined, value: converted });
    }

    // Top movers are based on the LAST 24 HOURS, not all-time P&L. We diff each
    // investment against its snapshot ~24h ago (same data the Overview breakdown uses).
    const investsWithPnl: Array<{ id: string; name: string; ticker?: string; pnlPct: number; pnlAbs: number }> = [];
    try {
      const { items: dayChanges } = await getItemChanges(userId, 'daily');
      for (const it of dayChanges) {
        if (it.item_type !== 'investment') continue;
        // Only count holdings the user STILL owns. net_worth_item_history retains
        // rows for renamed/recreated/deleted investments, which show up as stale
        // duplicate or flat (0.00%) series and crowd out the real movers. tickerById
        // is built from the live investments table, so membership = "still owned".
        if (!tickerById.has(String(it.item_id))) continue;
        if (!it.start_value || it.start_value === 0) continue; // can't compute % without a baseline
        if (Math.abs(it.current_value - it.start_value) < 0.005) continue; // flat / no market move → not a mover
        investsWithPnl.push({
          id: String(it.item_id),
          name: it.name,
          ticker: tickerById.get(String(it.item_id)),
          pnlPct: ((it.current_value - it.start_value) / Math.abs(it.start_value)) * 100,
          pnlAbs: it.current_value - it.start_value,
        });
      }
    } catch (err) {
      console.error('[BRIEFING] 24h movers failed:', (err as Error).message);
    }
    investsWithPnl.sort((a, b) => b.pnlPct - a.pnlPct);

    // ── Credit-card total (with per-card currency conversion) ──
    let ccTotal = 0;
    for (const cc of creditCards ?? []) {
      if (excludedCards.has(String(cc.id))) continue;
      const owing = Number(cc.balance_owing) || 0;
      const from = cc.currency ?? 'AUD';
      const { converted } = await convertBalance(owing, from, curr);
      console.log(`[BRIEFING CALC] cc: owing=${owing} ${from} → ${converted} ${curr}`);
      ccTotal += converted;
    }

    // ── Super totals ──
    // superCounted: only funds opted into net worth (feeds the Net Worth line).
    // superTotalAll: every fund, shown on the Superannuation line regardless of
    // the toggle — the toggle only governs whether super feeds the net-worth sum.
    let superCounted = 0;
    let superTotalAll = 0;
    for (const sf of superFunds ?? []) {
      const bal = Number(sf.balance) || 0;
      superTotalAll += bal;
      if (sf.include_in_net_worth !== false) superCounted += bal;
    }
    // …and the SMSFs, the same way computeNetWorth does it: a fund's balance is
    // its asset rows summed, in AUD, gated by the fund's own opt-out.
    const smsfIncluded = new Set(
      (smsfFunds ?? []).filter(f => f.include_in_net_worth !== false).map(f => String(f.id)),
    );
    for (const a of smsfAssets ?? []) {
      const bal = Number(a.amount) || 0;
      superTotalAll += bal;
      if (smsfIncluded.has(String(a.fund_id))) superCounted += bal;
    }
    // Every fund the user has, counted or not — what tells a fund-held property
    // that something else is already carrying its value. See propertyNetWorthValue.
    const knownFundIds = new Set<string>([
      ...(smsfFunds ?? []).map(f => String(f.id)),
      ...(superFunds ?? []).map(f => String(f.id)),
    ]);

    // Loans: subtract counted loan balances from net worth (legacy null = included).
    let loanDebt = 0;
    for (const ln of loans ?? []) {
      if (ln.include_in_net_worth !== false) loanDebt += Number(ln.current_balance) || 0;
    }

    // Property: the owned share of each house, using the SAME rule the app's net
    // worth uses. It was missing here entirely, so the briefing subtracted every
    // mortgage while never counting the property it bought — a net worth short by
    // the whole value of the portfolio.
    const propertyTotal = propertyNetWorthTotal(properties, loans, knownFundIds);

    const netWorth = bankTotal + investTotal - ccTotal + superCounted + propertyTotal - loanDebt;

    console.log(`[BRIEFING TOTALS] bankTotal=${bankTotal} | investTotal=${investTotal} | ccTotal=${ccTotal} | superCounted=${superCounted} | superTotalAll=${superTotalAll} | propertyTotal=${propertyTotal} | loanDebt=${loanDebt} | netWorth=${netWorth} | currency=${curr}`);

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
      msg += `🏛 *Superannuation:* ${fmt(superTotalAll)} ${curr}\n`;
    }
    msg += '\n';

    // Shared movers/watch line formatting (used by both Top Movers and Watching).
    const sign = (n: number) => (n >= 0 ? '+' : '');
    // Signed dollar delta, e.g. "+$120" / "-$45" (fmt is unsigned, so prefix here).
    const fmtDelta = (n: number) => `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n))}`;
    const moverLine = (arrow: string, inv: { name: string; ticker?: string; pnlPct: number; pnlAbs: number }) =>
      `${arrow} ${inv.name}${inv.ticker ? ` (${inv.ticker})` : ''}: ${fmtDelta(inv.pnlAbs)} (${sign(inv.pnlPct)}${inv.pnlPct.toFixed(1)}%)\n`;

    // ── Top movers ──
    if (settings.show_investments && settings.top_movers !== 'none' && investsWithPnl.length > 0) {
      msg += `🔥 *Top Movers (24h):*\n`;

      if (settings.top_movers === 'best_worst') {
        const best = investsWithPnl[0];
        const worst = investsWithPnl[investsWithPnl.length - 1];
        msg += moverLine('▲', best);
        if (investsWithPnl.length > 1) {
          msg += moverLine('▼', worst);
        }
      } else {
        const count = settings.top_movers === 'top5' ? 5 : 3;
        for (const inv of investsWithPnl.slice(0, count)) {
          msg += moverLine(inv.pnlPct >= 0 ? '▲' : '▼', inv);
        }
      }
      msg += '\n';
    }

    // ── Watching (opt-in specific holdings) ──
    // Holdings the user explicitly chose to always see, independent of top_movers
    // (so they can have movers + watched, or watched-only with top_movers 'none').
    const watchedIds = (settings.watched_investment_ids ?? []).map(String);
    if (settings.show_investments && watchedIds.length > 0) {
      const pnlById = new Map(investsWithPnl.map(m => [m.id, m]));
      const lines: string[] = [];
      for (const id of watchedIds) {
        const m = pnlById.get(id);
        if (m) {
          // Has a 24h baseline → show the move just like a mover line.
          lines.push(moverLine(m.pnlPct >= 0 ? '▲' : '▼', m));
        } else {
          // No baseline yet → fall back to the current value.
          const h = holdingById.get(id);
          if (h) lines.push(`• ${h.name}${h.ticker ? ` (${h.ticker})` : ''}: ${fmt(h.value)} ${curr}\n`);
        }
      }
      if (lines.length > 0) {
        msg += `👀 *Watching:*\n${lines.join('')}\n`;
      }
    }
  }

  // ── Stock Watchlist ──
  if (settings.show_watchlist !== false) {
    const { data: watchlist } = await supabase
      .from('stock_watchlist')
      .select('*')
      .eq('user_id', userId)
      .order('created_at');

    // Per-stock opt-out: a watchlist item is shown unless its id is listed in
    // excluded_watchlist_ids (exclusion list → new stocks auto-appear).
    const excludedWatch = new Set((settings.excluded_watchlist_ids ?? []).map(String));
    const shownWatch = (watchlist ?? []).filter(w => !excludedWatch.has(String(w.id)));

    if (shownWatch.length) {
      const wLines: string[] = [];
      for (const w of shownWatch) {
        const native = w.native_currency ?? 'AUD';
        let price = 'N/A';
        if (w.current_price != null) {
          price = `$${Number(w.current_price).toFixed(2)} ${native}`;
          // For foreign-listed stocks, append the value in the user's currency.
          if (native !== curr) {
            const { converted } = await convertAmount(Number(w.current_price), native, curr);
            price += ` (${fmt(converted)} ${curr})`;
          }
        }
        let alertTag = '';
        if (w.alert_enabled && w.target_price != null) {
          const dir = w.alert_direction === 'above' ? '↑' : '↓';
          alertTag = w.alerted ? ' ✅' : ` (${dir}$${Number(w.target_price).toFixed(2)})`;
        }
        wLines.push(`• ${w.name} (${w.ticker}): ${price}${alertTag}\n`);
      }
      msg += `🔍 *Watchlist:*\n${wLines.join('')}\n`;
    }
  }

  // ── Bills & reminders ──
  // Both live in the `bills` table (kind 'bill' | 'reminder'). We mirror the
  // dashboard exactly: an item only appears once it's inside its lead window
  // (its own lead_days override, else the user's base setting), paid items are
  // hidden, and auto-pay items roll over so they never show as missed and never
  // reappear until their NEXT due date enters the lead window. Overdue items
  // (negative days) always show and sort to the top.
  if (settings.show_bills || settings.show_reminders) {
    const { data: bills, error: billsErr } = await supabase
      .from('bills')
      .select('name, amount, due_date, is_paid, auto_pay, kind, lead_days, frequency, is_recurring')
      .eq('user_id', userId)
      .order('due_date')
      .limit(200);

    console.log(`[BRIEFING DATA] bills: ${bills?.length ?? 0} row(s) | err=${billsErr?.message ?? 'none'}`);

    // Base lead time (days before due an item starts showing) — mirrors the
    // dashboard's per-user ui_preferences.billsLeadDays (default 7).
    let baseLead = 7;
    try {
      const { data: prof } = await supabase
        .from('users').select('ui_preferences').eq('id', userId).single();
      const v = (prof?.ui_preferences as { billsLeadDays?: number } | null)?.billsLeadDays;
      if (typeof v === 'number') baseLead = v;
    } catch { /* keep default */ }

    // Day-number for a YYYY-MM-DD wall date and for "today" in the user's zone, so
    // "overdue / due in N days" is measured against the user's local calendar.
    const todayNum = (() => {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const y = +(p.find(x => x.type === 'year')?.value ?? '1970');
      const m = +(p.find(x => x.type === 'month')?.value ?? '1');
      const d = +(p.find(x => x.type === 'day')?.value ?? '1');
      return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
    })();
    const dayNumOf = (due: string) => {
      const [y, m, d] = due.split('-').map(Number);
      return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
    };

    // Auto items "restart" on their due date: a past due date rolls forward by the
    // item's frequency until it's today or later, so an auto item is NEVER shown as
    // missed and only reappears once its NEXT occurrence enters the lead window.
    // Manual items don't roll — a passed due date means it was genuinely missed.
    const rolledDayNum = (due: string, freq?: string): number => {
      const [y, m, d] = due.split('-').map(Number);
      const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
      let guard = 0;
      while (Math.floor(dt.getTime() / 86_400_000) < todayNum && guard++ < 600) {
        switch (freq) {
          case 'weekly': dt.setUTCDate(dt.getUTCDate() + 7); break;
          case 'fortnightly': dt.setUTCDate(dt.getUTCDate() + 14); break;
          case 'quarterly': dt.setUTCMonth(dt.getUTCMonth() + 3); break;
          case 'annually': dt.setUTCFullYear(dt.getUTCFullYear() + 1); break;
          default: dt.setUTCMonth(dt.getUTCMonth() + 1); break; // monthly / unknown
        }
      }
      return Math.floor(dt.getTime() / 86_400_000);
    };

    type BillRow = { name: string; amount: number; due_date: string; is_paid?: boolean; auto_pay?: boolean; kind?: string; lead_days?: number | null; frequency?: string };
    const visible = (bills ?? [] as BillRow[])
      .filter((b: BillRow) => !b.is_paid)                                   // ticked-off items never show
      .filter((b: BillRow) => settings.include_auto_pay !== false || !b.auto_pay) // optionally drop ⚡ auto items (default include)
      .map((b: BillRow) => {
        const num = b.auto_pay ? rolledDayNum(b.due_date, b.frequency) : dayNumOf(b.due_date);
        return { ...b, daysLeft: num - todayNum };
      })
      .filter(b => b.daysLeft < 0 || b.daysLeft <= (b.lead_days ?? baseLead)) // only what the dashboard shows
      .sort((a, b) => a.daysLeft - b.daysLeft);                             // most overdue (negative) first

    const renderRow = (b: { name: string; amount: number; daysLeft: number; auto_pay?: boolean }) => {
      const amt = b.amount > 0 ? ` — ${fmt(b.amount)}` : '';
      const auto = b.auto_pay ? ' ⚡' : '';
      if (b.daysLeft < 0) {
        return `• 🚨 ${b.name}${amt} — ${b.daysLeft} day${b.daysLeft === -1 ? '' : 's'} ⚠️${auto}\n`;
      }
      const when = b.daysLeft === 0 ? 'due today' : b.daysLeft === 1 ? 'due tomorrow' : `due in ${b.daysLeft} days`;
      const urgency = b.daysLeft <= 1 ? ' ⚠️' : b.daysLeft <= 3 ? ' ⏰' : '';
      return `• ${b.name}${amt} ${when}${urgency}${auto}\n`;
    };

    if (settings.show_bills) {
      const billRows = visible
        .filter(b => (b.kind ?? 'bill') !== 'reminder')
        .slice(0, Math.max(1, Math.min(10, settings.bills_count)));
      if (billRows.length > 0) {
        msg += `📋 *Bills:*\n`;
        for (const b of billRows) msg += renderRow(b);
        msg += '\n';
      }
    }

    if (settings.show_reminders) {
      const reminderRows = visible
        .filter(b => b.kind === 'reminder')
        .slice(0, Math.max(1, Math.min(10, settings.reminders_max)));
      if (reminderRows.length > 0) {
        msg += `🔔 *Reminders:*\n`;
        for (const b of reminderRows) msg += renderRow(b);
        msg += '\n';
      }
    }
  }

  // ── Loan repayments due soon ──
  // Always included (not behind a setting): surface any loan repayment due within
  // the next 3 days (or already overdue) so it isn't missed.
  {
    const { data: loans, error: loansErr } = await supabase
      .from('loans')
      .select('name, minimum_repayment, next_due_date')
      .eq('user_id', userId)
      .not('next_due_date', 'is', null);

    console.log(`[BRIEFING DATA] loans: ${loans?.length ?? 0} row(s) | err=${loansErr?.message ?? 'none'}`);

    const dueSoon = (loans ?? [])
      .map((l: { name: string; minimum_repayment: number | null; next_due_date: string }) => {
        const [y, m, d] = l.next_due_date.split('-').map(Number);
        const due = new Date(y, m - 1, d);
        const todayLocal = new Date(new Date().toLocaleDateString('en-US', { timeZone: tz }));
        const days = Math.round((due.getTime() - todayLocal.getTime()) / 86_400_000);
        return { name: l.name, amount: l.minimum_repayment ?? 0, due_date: l.next_due_date, days };
      })
      .filter(l => l.days <= 3)
      .sort((a, b) => a.days - b.days);

    if (dueSoon.length > 0) {
      msg += `💳 *Upcoming repayments:*\n`;
      for (const l of dueSoon) {
        const amt = l.amount > 0 ? ` ${fmt(l.amount)}` : '';
        const dueStr = new Date(l.due_date).toLocaleDateString('en-AU', {
          day: 'numeric', month: 'short', timeZone: tz,
        });
        const when =
          l.days < 0 ? `${Math.abs(l.days)} day${l.days === -1 ? '' : 's'} overdue ⚠️` :
          l.days === 0 ? 'due today ⚠️' :
          l.days === 1 ? 'due tomorrow ⏰' :
          `due in ${l.days} days`;
        msg += `• ${l.name}${amt} — ${when} (${dueStr})\n`;
      }
      msg += '\n';
    }
  }

  // ── Goals ──
  if (settings.show_goals) {
    const { data: goals, error: goalsErr } = await supabase
      .from('goals')
      .select('id, name, current_amount, target_amount, include_in_briefing')
      .eq('user_id', userId);

    // Include goals unless explicitly opted out: either via the per-item exclusion
    // list (the new UI control) or the legacy include_in_briefing flag.
    const excludedGoals = new Set((settings.excluded_goal_ids ?? []).map(String));
    const briefGoals = (goals ?? []).filter(
      (g: { id?: string; include_in_briefing?: boolean | null }) =>
        g.include_in_briefing !== false && !excludedGoals.has(String(g.id)),
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

  console.log(`[BRIEFING] Sending message to chatId=${user.telegram_chat_id} (${msg.length} chars)`);
  // The result was thrown away here, and the line below said "sent ✅" whatever
  // happened. A briefing Telegram had refused looked identical in the logs to
  // one that arrived — and since the day had already been claimed, it was never
  // retried either. The caller now decides what to do about a failure.
  const sent = await tgSend(user.telegram_bot_token, user.telegram_chat_id, msg);
  if (!sent.ok) {
    console.error(`[BRIEFING] ❌ Not sent to user ${userId}: ${sent.error}`);
    return sent;
  }
  console.log(`[BRIEFING] Message sent ✅`);

  // Persist briefing to conversation history (best-effort)
  try {
    await supabase.from('telegram_conversations').insert({
      user_id: userId, role: 'assistant', message: msg,
    });
  } catch { /* ignore */ }
  return { ok: true };
}

// Auto-provision a default briefing-settings row for any user who has connected a
// Telegram bot (token + chat_id) but never opened the briefing settings page to
// save one. Without this, additional users silently get NO morning briefings,
// because the scheduler only ever looks at rows in telegram_briefing_settings and
// the GET endpoint returns defaults WITHOUT persisting them. We only insert for
// users with NO existing row, so anyone who deliberately disabled briefings
// (enabled=false) is never re-enabled.
// Provision a briefing-settings row for one user with a known timezone (e.g. the
// browser timezone captured when they connect their bot). Only creates a row when
// none exists — it never overwrites a timezone the user has deliberately chosen.
// Validates the IANA zone before use, falling back to the default if it's bogus.
export async function ensureBriefingRowForUser(userId: string, timezone?: string): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from('telegram_briefing_settings')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing) return; // respect their existing settings

    let tz = DEFAULT_SETTINGS.timezone;
    if (timezone) {
      try {
        // Throws RangeError if not a valid IANA timezone.
        new Intl.DateTimeFormat('en-AU', { timeZone: timezone });
        tz = timezone;
      } catch {
        console.warn(`[BRIEFING] Ignoring invalid timezone "${timezone}" for user ${userId}`);
      }
    }

    const { error } = await supabase
      .from('telegram_briefing_settings')
      .insert({ user_id: userId, ...DEFAULT_SETTINGS, timezone: tz });
    if (error) console.error('[BRIEFING] ensureBriefingRowForUser insert failed:', error.message);
    else console.log(`[BRIEFING] Provisioned briefing row for ${userId} with timezone ${tz}`);
  } catch (err) {
    console.error('[BRIEFING] ensureBriefingRowForUser failed:', (err as Error).message);
  }
}

async function ensureBriefingRowsForConnectedUsers(): Promise<void> {
  try {
    const { data: connected } = await supabase
      .from('users')
      .select('id')
      .not('telegram_bot_token', 'is', null)
      .not('telegram_chat_id', 'is', null);
    if (!connected?.length) return;

    const { data: existing } = await supabase
      .from('telegram_briefing_settings')
      .select('user_id');
    const haveRow = new Set((existing ?? []).map(r => r.user_id as string));

    const missing = connected
      .map(u => u.id as string)
      .filter(id => !haveRow.has(id));
    if (!missing.length) return;

    const rows = missing.map(user_id => ({ user_id, ...DEFAULT_SETTINGS }));
    const { error } = await supabase
      .from('telegram_briefing_settings')
      .upsert(rows, { onConflict: 'user_id' });
    if (error) console.error('[BRIEFING] Failed to auto-provision settings rows:', error.message);
    else console.log(`[BRIEFING] Auto-provisioned default briefing settings for ${missing.length} connected user(s).`);
  } catch (err) {
    console.error('[BRIEFING] ensureBriefingRowsForConnectedUsers failed:', (err as Error).message);
  }
}

// ── Scheduler: called every minute by cron ────────────────────────────────────

/**
 * Whether the missing delivery-status columns have already been complained
 * about. Only log noise is suppressed — never the attempt itself.
 *
 * This used to be a latch: the first failure set "the columns don't exist" for
 * the life of the process, so running the migration changed nothing until the
 * next deploy, and nobody would have known why. A flag that silently disables a
 * feature until a restart is the same shape as the bug this whole change is
 * about, so the write is simply always attempted — it happens on a send or a
 * missed day, not every tick, and a failed UPDATE costs nothing.
 */
let warnedAboutStatusColumns = false;

/**
 * Write down what happened to today's briefing.
 *
 * Kept as its own update, separate from the last_sent_date claim, for the same
 * reason: the claim has to land whether or not this column exists.
 */
/**
 * How many times today's briefing has been handed back for retry, per user.
 *
 * Releasing a claimed day is what stops one bad send from costing the day, but
 * it must be bounded. The failure we cannot distinguish is "Telegram accepted
 * it and we never saw the reply" — releasing on that produces a duplicate, and
 * an unbounded retry inside a 90-minute window would produce ninety of them.
 * Three attempts is enough to ride out a blip and few enough that the worst
 * case is three messages, not a morning of them. In memory on purpose: a
 * restart resetting the count is the harmless direction to be wrong in.
 */
const releasesToday = new Map<string, { date: string; count: number }>();
const MAX_RELEASES_PER_DAY = 3;

function mayRelease(userId: string, todayDate: string): boolean {
  const seen = releasesToday.get(userId);
  const count = seen && seen.date === todayDate ? seen.count : 0;
  if (count >= MAX_RELEASES_PER_DAY) return false;
  releasesToday.set(userId, { date: todayDate, count: count + 1 });
  return true;
}

async function recordBriefingStatus(userId: string, status: string): Promise<void> {
  const { error } = await supabase
    .from('telegram_briefing_settings')
    .update({ last_send_status: status, last_attempt_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error && !warnedAboutStatusColumns) {
    warnedAboutStatusColumns = true;
    console.error('[BRIEFING] delivery-status columns missing '
      + '(run database/2026-briefing-delivery-status.sql):', error.message);
  } else if (!error) {
    warnedAboutStatusColumns = false;
  }
}

export async function sendScheduledBriefings(): Promise<void> {
  const now = new Date();

  // Make sure every Telegram-connected user has a settings row before we query,
  // so newly-added users receive briefings without having to save settings first.
  await ensureBriefingRowsForConnectedUsers();

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

      if (!timeReady || !dayMatch || alreadySent) {
        // The quietest way a briefing "stops": its window passed with nothing
        // running, so no tick ever evaluated it at the right minute and the day
        // was skipped without a word. Say so, once (the date in the text is
        // what keeps it to once), so a run of missed days is visible in the app
        // instead of being mistaken for a broken feature.
        const missedWindow = dayMatch && !alreadySent && nowMins >= sendMins + CATCH_UP_MIN;
        if (missedWindow && !String(s.last_send_status ?? '').includes(todayDate)) {
          await recordBriefingStatus(
            s.user_id as string,
            `missed ${todayDate}: nothing was running between ${s.send_time} and the ${CATCH_UP_MIN}-minute cut-off`,
          );
        }
        continue;
      }

      // CLAIM the day BEFORE sending. Two overlapping runs (e.g. during a deploy)
      // could both pass the checks above in the same minute and each send a
      // briefing — the duplicate-message bug. By writing last_sent_date first and
      // only proceeding if THIS run was the one that set it, we guarantee a single
      // send. The conditional update (neq on today) makes the claim atomic.
      // NOTE: a bare .neq('last_sent_date', todayDate) matches ZERO rows when the
      // column is NULL — Postgres evaluates `NULL <> 'date'` to NULL (not true),
      // so the row is excluded. That silently dropped EVERY user's first-ever
      // briefing (last_sent_date starts NULL). The .or() below explicitly matches
      // the NULL case as well, so the very first send is claimed correctly while
      // still preventing duplicate sends on subsequent days.
      const previousSentDate = (s.last_sent_date as string | null) ?? null;
      const { data: claimed } = await supabase
        .from('telegram_briefing_settings')
        .update({ last_sent_date: todayDate })
        .eq('user_id', s.user_id)
        .or(`last_sent_date.is.null,last_sent_date.neq.${todayDate}`)
        .select('user_id');

      if (!claimed?.length) {
        console.log(`[BRIEFING] Skipped user ${s.user_id} — already claimed by another run.`);
        continue;
      }

      // Claiming the day stops two overlapping runs from both sending. It must
      // NOT turn a send that failed into a day marked done: that is how a
      // briefing stops arriving while the row insists it went out every morning.
      // A failure hands the day back, so the next tick retries inside the
      // catch-up window, and the reason is recorded either way.
      //
      // The trade: if Telegram accepted the message but the reply never reached
      // us, releasing can produce a duplicate. A duplicate is a nuisance; a
      // briefing that silently stops for a week is the bug being fixed.
      let outcome: SendResult;
      try {
        outcome = await sendMorningBriefing(s.user_id as string, s as unknown as BriefingSettings);
      } catch (err) {
        outcome = { ok: false, error: (err as Error).message };
      }

      if (outcome.ok) {
        await recordBriefingStatus(s.user_id as string, `sent ${todayDate}`);
        console.log(`[BRIEFING] ✅ Sent morning briefing to user ${s.user_id}`);
      } else if (mayRelease(s.user_id as string, todayDate)) {
        await supabase
          .from('telegram_briefing_settings')
          .update({ last_sent_date: previousSentDate })
          .eq('user_id', s.user_id)
          .eq('last_sent_date', todayDate);
        await recordBriefingStatus(
          s.user_id as string, `failed ${todayDate}: ${outcome.error ?? 'unknown error'} — retrying`);
        console.error(`[BRIEFING] ❌ user ${s.user_id} — day released for retry: ${outcome.error}`);
      } else {
        // Out of attempts: the day stays claimed so a repeating failure can't
        // turn into a stream of messages, and the reason stands in the row for
        // tomorrow morning to be read against.
        await recordBriefingStatus(
          s.user_id as string,
          `failed ${todayDate} after ${MAX_RELEASES_PER_DAY} attempts: ${outcome.error ?? 'unknown error'}`);
        console.error(`[BRIEFING] ❌ user ${s.user_id} — giving up for today: ${outcome.error}`);
      }
    } catch (err) {
      console.error(`[BRIEFING] Failed for user ${s.user_id}:`, err);
    }
  }
}

// ── Per-bill custom Telegram reminders ────────────────────────────────────────
// Bills/reminders can each carry an array of `reminders`: { id, offset_days, time,
// last_sent }. Each fires as its own standalone Telegram message at
// (due_date − offset_days) @ time in the user's timezone. For recurring bills the
// array carries forward (with last_sent reset) so reminders repeat automatically.
interface BillReminderEntry {
  id?: string;
  offset_days: number;
  time: string;            // "HH:MM" 24h, user-local
  last_sent: string | null; // due_date this entry last fired for (de-dup guard)
}

// YYYY-MM-DD ± whole days, using UTC date math so it's timezone-drift free.
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function hhmmToMinutes(hhmm: string): number {
  const [h, mn] = String(hhmm).split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(mn, 10) || 0);
}

// Whole-day difference (due − today) using UTC date math.
function dayDiff(fromDate: string, toDate: string): number {
  const a = new Date(`${fromDate}T00:00:00Z`).getTime();
  const b = new Date(`${toDate}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

// User-local calendar date (YYYY-MM-DD) and minutes-of-day for a given instant/zone.
function localDateAndMinutes(now: Date, tz: string): { todayDate: string; nowMins: number } {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const rawHh = get('hour');
  const hh = rawHh === '24' ? '00' : rawHh;
  return {
    todayDate: `${get('year')}-${get('month')}-${get('day')}`,
    nowMins: (parseInt(hh, 10) || 0) * 60 + (parseInt(get('minute'), 10) || 0),
  };
}

export async function sendScheduledBillReminders(): Promise<void> {
  const now = new Date();

  const { data: users } = await supabase
    .from('users')
    .select('id, telegram_bot_token, telegram_chat_id, currency_preference')
    .not('telegram_bot_token', 'is', null)
    .not('telegram_chat_id', 'is', null);
  if (!users?.length) return;

  // Timezone per user (from briefing settings; default Sydney if none saved).
  const { data: tzRows } = await supabase
    .from('telegram_briefing_settings')
    .select('user_id, timezone');
  const tzByUser = new Map<string, string>();
  for (const r of tzRows ?? []) {
    if (r.timezone) tzByUser.set(r.user_id as string, r.timezone as string);
  }

  for (const u of users) {
    try {
      const tz = tzByUser.get(u.id as string) ?? 'Australia/Sydney';
      const { todayDate, nowMins } = localDateAndMinutes(now, tz);
      const curr = (u.currency_preference as string) || 'AUD';

      const { data: bills } = await supabase
        .from('bills')
        .select('id, name, amount, due_date, kind, is_paid, reminders')
        .eq('user_id', u.id)
        .neq('reminders', '[]');
      if (!bills?.length) continue;

      for (const bill of bills) {
        if (bill.is_paid || !bill.due_date) continue;
        const reminders = (Array.isArray(bill.reminders) ? bill.reminders : []) as BillReminderEntry[];
        if (!reminders.length) continue;

        let changed = false;
        for (const r of reminders) {
          if (!r || typeof r.offset_days !== 'number' || typeof r.time !== 'string') continue;
          if (r.last_sent === bill.due_date) continue;          // already fired this occurrence
          const schedDate = shiftDateStr(bill.due_date as string, -r.offset_days);
          if (schedDate !== todayDate) continue;                // only fire on its scheduled local day
          if (nowMins < hhmmToMinutes(r.time)) continue;        // not yet time (fire at/after, once/day)

          const text = buildReminderText(
            bill as { name: string; amount: number; due_date: string; kind?: string },
            todayDate, curr,
          );
          const { ok } = await tgSend(u.telegram_bot_token as string, u.telegram_chat_id as string, text);
          if (ok) {
            r.last_sent = bill.due_date as string;
            changed = true;
            console.log(`[BILL REMINDER] ✅ sent "${bill.name}" to user ${u.id} (offset ${r.offset_days}d @ ${r.time})`);
          }
        }
        if (changed) {
          await supabase.from('bills').update({ reminders }).eq('id', bill.id);
        }
      }
    } catch (err) {
      console.error(`[BILL REMINDER] failed for user ${u.id}:`, err);
    }
  }
}

function buildReminderText(
  bill: { name: string; amount: number; due_date: string; kind?: string },
  todayDate: string,
  currency: string,
): string {
  const diff = dayDiff(todayDate, bill.due_date);
  const when =
    diff === 0 ? 'today'
    : diff === 1 ? 'tomorrow'
    : diff > 1 ? `in ${diff} days`
    : diff === -1 ? 'yesterday (overdue)'
    : `${Math.abs(diff)} days ago (overdue)`;
  const isReminder = (bill.kind ?? 'bill') === 'reminder';
  const amount = !isReminder && Number(bill.amount) > 0
    ? `\n💵 ${Number(bill.amount).toFixed(2)} ${currency}`
    : '';
  return `🔔 *Reminder:* ${bill.name}${amount}\n📅 Due ${when} (${bill.due_date})`;
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
