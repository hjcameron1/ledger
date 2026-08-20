import { getRate } from './currencyService';

/**
 * The ONE rule for the rate an investment is translated at.
 *
 * A holding's worth in the owner's own currency is `current_value × rate`, and which
 * rate that is has to be the same answer everywhere or the app contradicts itself.
 * The rate PINNED on the row at the last price refresh is that answer: it is frozen
 * alongside the price it belongs to, so a holding read at two different moments while
 * the market is shut gives the same number twice.
 *
 * This used to be written out twice — once for the Investments page, once inside the
 * net-worth snapshot, and the snapshot's copy converted at a LIVE rate instead. Every
 * snapshot was therefore recorded on a different base from the figure on the screen,
 * so subtracting one from the other produced a "change" that was partly just the two
 * methods disagreeing — a phantom that no item in the breakdown could account for.
 *
 * Two cases still need the live rate, and both are about the pin being absent rather
 * than a preference for freshness:
 *   • cash — no ticker, so the price/FX cron skips the row and its pin goes stale;
 *   • a pin that was never really set (missing, the 1 placeholder, or stamped for a
 *     currency the user no longer prefers).
 */
export interface InvestmentRateRow {
  asset_type?: string | null;
  native_currency?: string | null;
  conversion_rate?: number | string | null;
  display_currency?: string | null;
}

export async function investmentRate(inv: InvestmentRateRow, preferredCurrency: string): Promise<number> {
  const native = inv.native_currency;
  if (!native || native === preferredCurrency) return 1;

  const pinned = Number(inv.conversion_rate);
  const pinUsable =
    inv.asset_type !== 'cash' &&
    inv.conversion_rate != null &&
    Number.isFinite(pinned) &&
    pinned > 0 &&
    pinned !== 1 &&
    inv.display_currency === preferredCurrency;

  return pinUsable ? pinned : getRate(native, preferredCurrency);
}

/** What a holding is worth in `preferredCurrency`, at the rate above. */
export async function investmentValueInPreferred(
  inv: InvestmentRateRow & { current_value?: number | string | null },
  preferredCurrency: string,
): Promise<number> {
  const rate = await investmentRate(inv, preferredCurrency);
  return parseFloat(((Number(inv.current_value) || 0) * rate).toFixed(2));
}
