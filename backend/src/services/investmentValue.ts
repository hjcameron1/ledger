import { getRate } from './currencyService';

/**
 * The ONE rule for the rate an investment is translated at.
 *
 * A holding's worth in the owner's own currency is its native value × rate, and which
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

export interface InvestmentValueRow extends InvestmentRateRow {
  shares_owned?: number | string | null;
  current_price?: number | string | null;
  /** The stamp the price cron last wrote. A FALLBACK, never the first answer. */
  current_value?: number | string | null;
}

/**
 * A holding's worth in its OWN currency: units × the price on the row.
 *
 * Not `current_value`. That column is a STAMP — the last thing the price service
 * wrote — and it is wrong in two ways that both reach money:
 *
 *   • It is rounded to native cents before any FX is applied. Multiplying an
 *     already-rounded native figure by a rate is a different sum from rounding
 *     units × price × rate once at the end, so the recorded history sat on a
 *     different base from the Investments page and the client's own headline —
 *     by up to half a cent per foreign holding, times that holding's rate.
 *   • It goes stale. Units and price are written by every edit, sale and price
 *     refresh; the stamp is only rewritten by the paths that remember to. A
 *     holding whose unit count moved without a price refresh was carried in the
 *     recorded series at what it used to be worth.
 *
 * The stamp is still read when a row genuinely has no units and price on it —
 * an old row, or a query that did not select them — because a stale figure beats
 * no figure. Every caller in this codebase selects both.
 */
export function investmentValueNative(inv: InvestmentValueRow): number {
  const units = Number(inv.shares_owned);
  const price = Number(inv.current_price);
  const havePair =
    inv.shares_owned != null && inv.current_price != null &&
    Number.isFinite(units) && Number.isFinite(price);
  return havePair ? units * price : (Number(inv.current_value) || 0);
}

/**
 * THE valuation: units × price × rate, rounded ONCE, at the end.
 *
 * The same arithmetic as `enrichInvestment` on the Investments route and
 * `investmentValueInPreferred` in the browser — one basis for the live headline,
 * the Overview breakdown, the portfolio page and the recorded history, so no two
 * of them can disagree about what a holding is worth.
 */
export async function investmentValueInPreferred(
  inv: InvestmentValueRow,
  preferredCurrency: string,
): Promise<number> {
  const rate = await investmentRate(inv, preferredCurrency);
  return parseFloat((investmentValueNative(inv) * rate).toFixed(2));
}
