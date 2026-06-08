import { supabase } from '../utils/supabase';
import { enrichInvestment } from '../routes/investments';

/**
 * Compute a user's whole-portfolio P&L in their preferred currency and persist a
 * snapshot row. Returns the computed figures, or null if the user has no
 * holdings (nothing worth recording).
 *
 * Forward-only history: we never backfill. The first snapshot taken after a user
 * adds holdings becomes the start of their P&L % chart.
 */
export async function recordPortfolioSnapshot(userId: string) {
  const { data: investments } = await supabase
    .from('investments')
    .select('*')
    .eq('user_id', userId);

  if (!investments || investments.length === 0) return null;

  const { data: user } = await supabase
    .from('users').select('currency_preference').eq('id', userId).single();
  const preferredCurrency = user?.currency_preference ?? 'AUD';

  const enriched = await Promise.all(
    investments.map((inv) => enrichInvestment(inv, preferredCurrency)),
  );

  const totalValue = enriched.reduce((s, i) => s + (i.display_value ?? 0), 0);
  const totalCost = enriched.reduce((s, i) => s + (i.display_cost ?? 0), 0);
  const plValue = totalValue - totalCost;
  const plPercent = totalCost > 0 ? (plValue / totalCost) * 100 : 0;

  await supabase.from('portfolio_pl_history').insert({
    user_id: userId,
    pl_percent: parseFloat(plPercent.toFixed(4)),
    pl_value: parseFloat(plValue.toFixed(2)),
    total_value: parseFloat(totalValue.toFixed(2)),
    total_cost: parseFloat(totalCost.toFixed(2)),
  });

  return { plPercent, plValue, totalValue, totalCost };
}

/**
 * Snapshot every user that has at least one holding. Called from the hourly
 * price cron after prices have refreshed.
 */
export async function snapshotAllUsers(): Promise<number> {
  const { data: rows } = await supabase
    .from('investments')
    .select('user_id');

  const userIds = Array.from(new Set((rows ?? []).map((r) => r.user_id as string)));
  let recorded = 0;
  for (const uid of userIds) {
    try {
      const result = await recordPortfolioSnapshot(uid);
      if (result) recorded++;
    } catch (err) {
      console.error('[CRON] Portfolio snapshot failed for user:', err);
    }
  }
  return recorded;
}
