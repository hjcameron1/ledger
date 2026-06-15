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

  // Record each holding's contribution to this point so a *deleted* investment can
  // be subtracted out of every snapshot recorded from now on (see purgeInvestmentFromHistory).
  const breakdown: Record<string, { v: number; c: number }> = {};
  for (const i of enriched) {
    breakdown[String(i.id)] = {
      v: parseFloat((i.display_value ?? 0).toFixed(2)),
      c: parseFloat((i.display_cost ?? 0).toFixed(2)),
    };
  }

  await supabase.from('portfolio_pl_history').insert({
    user_id: userId,
    pl_percent: parseFloat(plPercent.toFixed(4)),
    pl_value: parseFloat(plValue.toFixed(2)),
    total_value: parseFloat(totalValue.toFixed(2)),
    total_cost: parseFloat(totalCost.toFixed(2)),
    breakdown,
  });

  return { plPercent, plValue, totalValue, totalCost };
}

/**
 * Subtract a *deleted* investment out of the user's P&L history. For every snapshot
 * row whose breakdown recorded this holding, we remove its value/cost contribution
 * and recompute that point's totals + P&L % — so the line looks as if the holding
 * was never there. A row that becomes empty (the holding was the only one in it) is
 * deleted outright. Rows recorded before the breakdown column existed have no entry
 * for this id and are left untouched (forward-only, like the rest of the history).
 *
 * Note: this is intentionally NOT called when a holding is removed as part of a
 * *sale* — a sale is real history and should stay on the line.
 */
export async function purgeInvestmentFromHistory(userId: string, investmentId: string): Promise<void> {
  const { data: rows } = await supabase
    .from('portfolio_pl_history')
    .select('id, total_value, total_cost, breakdown')
    .eq('user_id', userId);
  if (!rows) return;

  for (const row of rows) {
    const bd = (row.breakdown ?? {}) as Record<string, { v: number; c: number }>;
    const entry = bd[investmentId];
    if (!entry) continue;

    delete bd[investmentId];

    // No holdings left in this point — drop the whole row rather than show a
    // meaningless zero-cost/zero-value snapshot.
    if (Object.keys(bd).length === 0) {
      await supabase.from('portfolio_pl_history').delete().eq('id', row.id);
      continue;
    }

    const newValue = (Number(row.total_value) || 0) - entry.v;
    const newCost = (Number(row.total_cost) || 0) - entry.c;
    const plValue = newValue - newCost;
    const plPercent = newCost > 0 ? (plValue / newCost) * 100 : 0;

    await supabase.from('portfolio_pl_history').update({
      total_value: parseFloat(newValue.toFixed(2)),
      total_cost: parseFloat(newCost.toFixed(2)),
      pl_value: parseFloat(plValue.toFixed(2)),
      pl_percent: parseFloat(plPercent.toFixed(4)),
      breakdown: bd,
    }).eq('id', row.id);
  }
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
