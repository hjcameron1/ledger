import { supabase } from '../utils/supabase';
import { convertAmount } from './currencyService';

export interface NetWorthItem {
  item_type: 'bank' | 'investment' | 'super' | 'smsf' | 'credit_card';
  item_id: string;
  name: string;
  value: number;   // in preferred currency
  is_debt: boolean;
}

export interface NetWorthBreakdown {
  netWorth: number;
  bankBalance: number;
  investments: number;
  creditCardDebt: number;
  super: number;
  currency: string;
  items: NetWorthItem[];
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
    supabase.from('bank_accounts').select('id, name, institution, balance, currency').eq('user_id', userId),
    supabase.from('investments').select('id, name, current_value, native_currency').eq('user_id', userId),
    supabase.from('credit_cards').select('id, name, institution, balance_owing, currency').eq('user_id', userId),
    supabase.from('super_funds').select('id, fund_name, balance, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_funds').select('id, name, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_assets').select('fund_id, amount').eq('user_id', userId),
  ]);

  const pref = user?.currency_preference ?? 'AUD';
  const items: NetWorthItem[] = [];

  let bankBalance = 0;
  for (const acc of accounts ?? []) {
    const { converted } = await convertAmount(acc.balance, acc.currency ?? 'AUD', pref);
    bankBalance += converted;
    items.push({ item_type: 'bank', item_id: String(acc.id), name: acc.name || acc.institution || 'Bank account', value: parseFloat(converted.toFixed(2)), is_debt: false });
  }

  let investmentsTotal = 0;
  for (const inv of investments ?? []) {
    const { converted } = await convertAmount(inv.current_value, inv.native_currency ?? 'AUD', pref);
    investmentsTotal += converted;
    items.push({ item_type: 'investment', item_id: String(inv.id), name: inv.name || 'Investment', value: parseFloat(converted.toFixed(2)), is_debt: false });
  }

  let creditCardDebt = 0;
  for (const cc of creditCards ?? []) {
    const { converted } = await convertAmount(cc.balance_owing, cc.currency ?? 'AUD', pref);
    creditCardDebt += converted;
    items.push({ item_type: 'credit_card', item_id: String(cc.id), name: cc.name || cc.institution || 'Credit card', value: parseFloat(converted.toFixed(2)), is_debt: true });
  }

  let superTotal = 0;
  for (const sf of superFunds ?? []) {
    if (sf.include_in_net_worth) {
      const v = Number(sf.balance) || 0;
      superTotal += v;
      items.push({ item_type: 'super', item_id: String(sf.id), name: sf.fund_name || 'Super fund', value: parseFloat(v.toFixed(2)), is_debt: false });
    }
  }

  // SMSF: sum each included fund's asset totals (assets are stored in AUD).
  const includedFunds = (smsfFunds ?? []).filter(f => f.include_in_net_worth);
  const includedFundIds = new Set(includedFunds.map(f => f.id as string));
  const smsfTotalByFund = new Map<string, number>();
  for (const a of smsfAssets ?? []) {
    const fid = a.fund_id as string;
    if (includedFundIds.has(fid)) {
      const v = Number(a.amount) || 0;
      superTotal += v;
      smsfTotalByFund.set(fid, (smsfTotalByFund.get(fid) ?? 0) + v);
    }
  }
  for (const f of includedFunds) {
    const v = smsfTotalByFund.get(f.id as string);
    if (v !== undefined) items.push({ item_type: 'smsf', item_id: String(f.id), name: (f as { name?: string }).name || 'SMSF', value: parseFloat(v.toFixed(2)), is_debt: false });
  }

  const netWorth = bankBalance + investmentsTotal + superTotal - creditCardDebt;

  return {
    netWorth: parseFloat(netWorth.toFixed(2)),
    bankBalance: parseFloat(bankBalance.toFixed(2)),
    investments: parseFloat(investmentsTotal.toFixed(2)),
    creditCardDebt: parseFloat(creditCardDebt.toFixed(2)),
    super: parseFloat(superTotal.toFixed(2)),
    currency: pref,
    items,
  };
}

/** Compute and persist a net-worth snapshot row (total + per-item breakdown). */
export async function recordNetWorthSnapshot(userId: string): Promise<NetWorthBreakdown> {
  const nw = await computeNetWorth(userId);
  const recordedAt = new Date().toISOString();
  await supabase.from('net_worth_history').insert({
    user_id: userId,
    total_value: nw.netWorth,
    recorded_date: recordedAt.split('T')[0],
  });
  if (nw.items.length) {
    await supabase.from('net_worth_item_history').insert(
      nw.items.map(it => ({
        user_id: userId,
        recorded_at: recordedAt,
        item_type: it.item_type,
        item_id: it.item_id,
        name: it.name,
        value: it.value,
        is_debt: it.is_debt,
      })),
    );
  }
  return nw;
}

export interface ItemChange {
  item_type: string;
  item_id: string;
  name: string;
  is_debt: boolean;
  start_value: number;   // value at window start (baseline)
  current_value: number; // latest value
  change: number;        // current - start (raw value movement)
  contribution: number;  // signed effect on net worth (debt increase is negative)
}

/**
 * Per-item change over a timeframe, sorted by biggest net-worth contribution.
 *   timeframe = daily | weekly | monthly | sixmonth | yearly | all
 * Baseline per item = its snapshot at/just-before the window start; if the item
 * has no snapshot before the window (added later), its earliest snapshot is used
 * so newly-added items don't masquerade as sudden gains.
 */
export async function getItemChanges(userId: string, timeframe: string): Promise<{ items: ItemChange[]; currency: string }> {
  const { data: user } = await supabase.from('users').select('currency_preference').eq('id', userId).single();
  const currency = user?.currency_preference ?? 'AUD';

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windowStart: Record<string, number> = {
    daily: now - DAY,
    weekly: now - 7 * DAY,
    monthly: now - 30 * DAY,
    sixmonth: now - 182 * DAY,
    yearly: now - 365 * DAY,
  };
  const startMs = windowStart[timeframe];

  const { data: rows } = await supabase
    .from('net_worth_item_history')
    .select('recorded_at, item_type, item_id, name, value, is_debt')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: true })
    .limit(20000);

  // Group rows per item, in ascending time order.
  const byItem = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const key = `${r.item_type}:${r.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key)!.push(r);
  }

  const items: ItemChange[] = [];
  for (const series of byItem.values()) {
    if (!series || series.length === 0) continue;
    const latest = series[series.length - 1];
    // Baseline = last snapshot at/before startMs, else earliest snapshot.
    let baseline = series[0];
    if (startMs) {
      for (const r of series) {
        if (new Date(r.recorded_at).getTime() <= startMs) baseline = r;
        else break;
      }
    }
    const startValue = Number(baseline.value);
    const currentValue = Number(latest.value);
    const change = currentValue - startValue;
    const contribution = latest.is_debt ? -change : change;
    items.push({
      item_type: latest.item_type,
      item_id: latest.item_id,
      name: latest.name,
      is_debt: latest.is_debt,
      start_value: parseFloat(startValue.toFixed(2)),
      current_value: parseFloat(currentValue.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      contribution: parseFloat(contribution.toFixed(2)),
    });
  }

  items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { items, currency };
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
