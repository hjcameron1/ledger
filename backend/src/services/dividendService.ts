import { supabase } from '../utils/supabase';
import { getRate } from './currencyService';
import { fetchDividends } from './priceService';

// Start of the current Australian financial year (1 July) as an ISO date string.
// Dividends are only synced within the current FY.
function financialYearStartISO(ref = new Date()): string {
  const startYear = ref.getMonth() + 1 >= 7 ? ref.getFullYear() : ref.getFullYear() - 1;
  return new Date(Date.UTC(startYear, 6, 1)).toISOString().slice(0, 10);
}

// Stable per-dividend key stored on the income entry's reference_number so the
// twice-daily sync never inserts the same dividend twice.
function dividendRef(investmentId: string, date: string): string {
  return `dividend:${investmentId}:${date}`;
}

export interface DividendSyncResult {
  created: number;
  checked: number;
}

/**
 * Check every dividend-paying holding for dividends paid within the current
 * financial year and create a PENDING income entry for each newly-seen one, so
 * the user confirms it before it counts toward income/tax. Per-share amounts
 * (native currency) are multiplied by the shares held and converted to the
 * owner's preferred currency at the live rate at sync time.
 *
 * @param userId  Optional — limit the sync to a single user (used by the
 *                on-demand route). Omit to sync all users (the cron).
 */
export async function syncDividends(userId?: string): Promise<DividendSyncResult> {
  const fyStart = financialYearStartISO();
  const todayISO = new Date().toISOString().slice(0, 10);

  let query = supabase
    .from('investments')
    .select('id, user_id, ticker, market, shares_owned, native_currency, name, is_dividend_paying')
    .eq('is_dividend_paying', true);
  if (userId) query = query.eq('user_id', userId);

  const { data: holdings } = await query;
  if (!holdings || holdings.length === 0) return { created: 0, checked: 0 };

  // Preferred currency per owner.
  const userIds = [...new Set(holdings.map(h => h.user_id).filter(Boolean))];
  const prefByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from('users').select('id, currency_preference').in('id', userIds);
    for (const u of users ?? []) prefByUser.set(u.id, u.currency_preference ?? 'AUD');
  }

  let created = 0;
  for (const inv of holdings) {
    if (!inv.ticker || !inv.shares_owned || inv.shares_owned <= 0) continue;

    const events = await fetchDividends(inv.ticker, inv.market, fyStart);
    if (events.length === 0) continue;

    const preferred = prefByUser.get(inv.user_id) ?? 'AUD';
    const native = inv.native_currency || 'AUD';

    for (const ev of events) {
      if (ev.date < fyStart || ev.date > todayISO) continue;

      const reference_number = dividendRef(inv.id, ev.date);

      // Skip if we've already created an entry for this exact dividend.
      const { data: existing } = await supabase
        .from('income_entries')
        .select('id')
        .eq('user_id', inv.user_id)
        .eq('reference_number', reference_number)
        .maybeSingle();
      if (existing) continue;

      // The dividend's OWN currency, from the quote it came off, not the
      // holding's stored one. They agree for every ordinary listing; they part
      // company for London, where the payment arrives in pence and the holding
      // records pounds. Falling back to the holding's currency keeps the old
      // behaviour when the feed did not say.
      const divCcy = ev.currency ?? native;
      const rate = divCcy !== preferred ? await getRate(divCcy, preferred) : 1;
      const gross_native = ev.amount * inv.shares_owned;
      const amount = parseFloat((gross_native * rate).toFixed(2));
      if (amount <= 0) continue;

      const { error } = await supabase.from('income_entries').insert({
        user_id: inv.user_id,
        source: `${inv.name || inv.ticker} dividend`,
        amount,
        currency: preferred,
        category: 'Dividends',
        is_recurring: false,
        reference_number,
        date: ev.date,
        status: 'pending',
      });
      if (!error) created++;
    }
  }

  return { created, checked: holdings.length };
}
