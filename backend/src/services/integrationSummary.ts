import { supabase } from '../utils/supabase';
import { computeNetWorth } from './netWorthSnapshot';
import { totalSpend } from '../utils/transactionSpend';

// ── Ledger Integration: Financial Summary contract ────────────────────────────
//
// This is the canonical, long-term shape that EVERY ecosystem consumer binds to
// (PAssistant Finance page now; mobile / desktop / widgets later). Treat it as a
// public API contract:
//
//   • Additive changes only within `schema_version: "1.0"` (new optional fields
//     are safe). A breaking change → bump to "2.0" at a new path.
//   • Money is in the user's preferred currency (`currency`); values are plain
//     numbers already FX-converted by computeNetWorth.
//   • `as_of` reflects Ledger's latest net-worth snapshot so the timestamp is honest.

export interface NamedBalance { id: string; name: string; institution?: string | null; balance: number; currency: string }

export interface FinancialSummary {
  schema_version: '1.0';
  as_of: string;            // ISO timestamp of the underlying data
  currency: string;
  net_worth: number;
  cash: number;
  bank_accounts: NamedBalance[];
  credit_cards: Array<{ id: string; name: string; balance_owing: number; currency: string }>;
  investments: { total: number; holdings: Array<{ id: string; name: string; value: number }> };
  loans: Array<{ id: string; name: string; balance: number }>;
  properties: Array<{ id: string; name: string; value: number }>; // reserved — Ledger has no property model yet
  monthly_income: number;
  monthly_expenses: number;
  savings_rate: number | null;  // (income - expenses) / income, clamped 0..1; null if income is 0
  available: true;
}

const INCOME_MULTIPLIER: Record<string, number> = {
  weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, annually: 1,
};

const r2 = (n: number) => parseFloat(n.toFixed(2));

/** Build the full financial summary for one Ledger user. Read-only. */
export async function buildFinancialSummary(userId: string): Promise<FinancialSummary> {
  const nw = await computeNetWorth(userId);

  // Bucket the unified net-worth items into the contract's top-level groups. The
  // item values are already FX-converted to the user's preferred currency.
  const bankItems = nw.items.filter((i) => i.item_type === 'bank');
  const cardItems = nw.items.filter((i) => i.item_type === 'credit_card');
  const invItems = nw.items.filter((i) => i.item_type === 'investment');
  const loanItems = nw.items.filter((i) => i.item_type === 'loan');

  const bank_accounts: NamedBalance[] = bankItems.map((i) => ({
    id: i.item_id, name: i.name, balance: i.value, currency: nw.currency,
  }));
  const credit_cards = cardItems.map((i) => ({
    id: i.item_id, name: i.name, balance_owing: i.value, currency: nw.currency,
  }));
  const holdings = invItems.map((i) => ({ id: i.item_id, name: i.name, value: i.value }));
  const loans = loanItems.map((i) => ({ id: i.item_id, name: i.name, balance: i.value }));

  const [monthly_income, monthly_expenses, as_of] = await Promise.all([
    computeMonthlyIncome(userId),
    computeMonthlyExpenses(userId),
    latestSnapshotAt(userId),
  ]);

  const savings_rate =
    monthly_income > 0
      ? parseFloat(Math.min(1, Math.max(0, (monthly_income - monthly_expenses) / monthly_income)).toFixed(4))
      : null;

  return {
    schema_version: '1.0',
    as_of,
    currency: nw.currency,
    net_worth: nw.netWorth,
    cash: nw.bankBalance,
    bank_accounts,
    credit_cards,
    investments: { total: nw.investments, holdings },
    loans,
    properties: [],
    monthly_income: r2(monthly_income),
    monthly_expenses: r2(monthly_expenses),
    savings_rate,
    available: true,
  };
}

/** Monthly income = sum of recurring income entries normalised to a monthly figure. */
async function computeMonthlyIncome(userId: string): Promise<number> {
  const { data } = await supabase
    .from('income_entries')
    .select('amount, frequency, is_recurring, status')
    .eq('user_id', userId)
    .eq('is_recurring', true);
  let annual = 0;
  for (const e of data ?? []) {
    if (e.status === 'pending') continue;
    annual += (Number(e.amount) || 0) * (INCOME_MULTIPLIER[e.frequency as string] ?? 0);
  }
  return annual / 12;
}

/** Monthly expenses = canonical spend over the trailing 30 days.
 *
 * Uses the SAME spend definition as the frontend (transactionCore): genuine
 * outflows only, excluding internal transfers and credit-card repayments. The
 * old implementation summed Math.abs(amount) over every row, double-counting
 * transfers and repayments as expenses. */
async function computeMonthlyExpenses(userId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data } = await supabase
    .from('transactions')
    .select('amount, category, is_transfer, transfer_pair_id, account_type, merchant')
    .eq('user_id', userId)
    .gte('date', since);
  return totalSpend(data ?? []);
}

/** Timestamp of the latest net-worth snapshot, falling back to now. */
async function latestSnapshotAt(userId: string): Promise<string> {
  const { data } = await supabase
    .from('net_worth_history')
    .select('recorded_at')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1);
  return data?.[0]?.recorded_at ?? new Date().toISOString();
}
