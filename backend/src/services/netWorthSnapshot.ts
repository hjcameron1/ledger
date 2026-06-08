import { supabase } from '../utils/supabase';
import { convertAmount } from './currencyService';

export interface NetWorthBreakdown {
  netWorth: number;
  bankBalance: number;
  investments: number;
  creditCardDebt: number;
  super: number;
  currency: string;
}

/**
 * Compute a user's net worth in their preferred currency.
 *
 *   net worth = bank accounts + investments + super − credit-card debt
 *
 * "super" includes both regular super_funds AND SMSF asset totals, each gated by
 * its own include_in_net_worth flag. Income is intentionally NOT a separate
 * component: pay lands in a bank account, so it's already reflected in the bank
 * balance — counting income on top would double-count it.
 */
export async function computeNetWorth(userId: string): Promise<NetWorthBreakdown> {
  const [
    { data: user },
    { data: accounts },
    { data: investments },
    { data: creditCards },
    { data: superFunds },
    { data: smsfFunds },
    { data: smsfAssets },
  ] = await Promise.all([
    supabase.from('users').select('currency_preference').eq('id', userId).single(),
    supabase.from('bank_accounts').select('balance, currency').eq('user_id', userId),
    supabase.from('investments').select('current_value, native_currency').eq('user_id', userId),
    supabase.from('credit_cards').select('balance_owing, currency').eq('user_id', userId),
    supabase.from('super_funds').select('balance, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_funds').select('id, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_assets').select('fund_id, amount').eq('user_id', userId),
  ]);

  const pref = user?.currency_preference ?? 'AUD';

  let bankBalance = 0;
  for (const acc of accounts ?? []) {
    const { converted } = await convertAmount(acc.balance, acc.currency ?? 'AUD', pref);
    bankBalance += converted;
  }

  let investmentsTotal = 0;
  for (const inv of investments ?? []) {
    const { converted } = await convertAmount(inv.current_value, inv.native_currency ?? 'AUD', pref);
    investmentsTotal += converted;
  }

  let creditCardDebt = 0;
  for (const cc of creditCards ?? []) {
    const { converted } = await convertAmount(cc.balance_owing, cc.currency ?? 'AUD', pref);
    creditCardDebt += converted;
  }

  let superTotal = 0;
  for (const sf of superFunds ?? []) {
    if (sf.include_in_net_worth) superTotal += Number(sf.balance) || 0;
  }

  // SMSF: sum each included fund's asset totals (assets are stored in AUD).
  const includedFundIds = new Set(
    (smsfFunds ?? []).filter(f => f.include_in_net_worth).map(f => f.id as string),
  );
  for (const a of smsfAssets ?? []) {
    if (includedFundIds.has(a.fund_id as string)) superTotal += Number(a.amount) || 0;
  }

  const netWorth = bankBalance + investmentsTotal + superTotal - creditCardDebt;

  return {
    netWorth: parseFloat(netWorth.toFixed(2)),
    bankBalance: parseFloat(bankBalance.toFixed(2)),
    investments: parseFloat(investmentsTotal.toFixed(2)),
    creditCardDebt: parseFloat(creditCardDebt.toFixed(2)),
    super: parseFloat(superTotal.toFixed(2)),
    currency: pref,
  };
}

/** Compute and persist a net-worth snapshot row. */
export async function recordNetWorthSnapshot(userId: string): Promise<NetWorthBreakdown> {
  const nw = await computeNetWorth(userId);
  await supabase.from('net_worth_history').insert({
    user_id: userId,
    total_value: nw.netWorth,
    recorded_date: new Date().toISOString().split('T')[0],
  });
  return nw;
}

/** Snapshot every user that has any financial data. Called from the hourly cron. */
export async function snapshotAllNetWorth(): Promise<number> {
  const { data: users } = await supabase.from('users').select('id');
  let recorded = 0;
  for (const u of users ?? []) {
    try {
      await recordNetWorthSnapshot(u.id as string);
      recorded++;
    } catch (err) {
      console.error('[CRON] Net-worth snapshot failed for user:', err);
    }
  }
  return recorded;
}
