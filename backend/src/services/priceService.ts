import { supabase } from '../utils/supabase';
import { getRate } from './currencyService';
import { isMarketOpen, isHoursGated } from './marketCalendar';

// yahoo-finance2 is ESM-only; use dynamic import to load it in CJS/tsx context.
// v3 requires instantiation — store the instance, not the class.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _yf: any = null;
async function yf() {
  if (!_yf) {
    const mod = await import('yahoo-finance2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const YF = (mod.default ?? mod) as any;
    _yf = new YF();
  }
  return _yf;
}

const MARKET_SUFFIX: Record<string, string> = {
  ASX: '.AX', LSE: '.L', TSX: '.TO', NSE: '.NS', HKEX: '.HK',
  XETRA: '.DE', 'Euronext Paris': '.PA', 'Euronext Amsterdam': '.AS',
  SIX: '.SW', JPX: '.T',
};

export function getYahooTicker(ticker: string, market: string): string {
  if (market === 'NYSE' || market === 'NASDAQ') return ticker.toUpperCase();
  if (market === 'Crypto') return ticker.toUpperCase();
  const suffix = MARKET_SUFFIX[market];
  if (suffix && !ticker.includes('.')) return `${ticker.toUpperCase()}${suffix}`;
  return ticker.toUpperCase();
}

const METAL_TICKERS: Record<string, string> = {
  Gold: 'GC=F', Silver: 'SI=F', Copper: 'HG=F', Platinum: 'PL=F',
};

// Yahoo metal futures (GC=F etc.) quote in USD per TROY OUNCE. Convert that to the
// price for ONE unit of the user's chosen weight unit. 1 troy ounce = 31.1034768 g.
const TROY_OZ_IN_GRAM = 1 / 31.1034768;
const OZ_PER_UNIT: Record<string, number> = {
  grams: TROY_OZ_IN_GRAM,          // troy oz contained in 1 gram
  ounces: 1,                       // already per troy oz
  kg: 1000 * TROY_OZ_IN_GRAM,      // troy oz contained in 1 kg
};

export function isMetal(ticker?: string | null): boolean {
  return !!ticker && ticker in METAL_TICKERS;
}

/**
 * Live spot price for a precious metal expressed PER chosen weight unit, in the
 * metal's native quote currency (USD for the Yahoo futures feed). Used both for
 * the Add-form autofill and the hourly refresh of generic (non-detailed) metals.
 */
export async function fetchMetalSpotPerUnit(
  metal: string,
  unit: string,
): Promise<{ price: number; currency: string; timestamp: string } | null> {
  try {
    const symbol = METAL_TICKERS[metal];
    if (!symbol) return null;
    const quote = await (await yf()).quote(symbol);
    const perOz = quote.regularMarketPrice ?? quote.ask ?? 0;
    if (!perOz) return null;
    const factor = OZ_PER_UNIT[unit] ?? OZ_PER_UNIT.grams;
    return {
      price: perOz * factor,
      currency: quote.currency ?? 'USD',
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Metal spot fetch failed for ${metal}:`, err);
    return null;
  }
}

export async function fetchCurrentPrice(
  ticker: string,
  market: string
): Promise<{ price: number; currency: string; timestamp: string } | null> {
  try {
    const symbol = METAL_TICKERS[ticker] ?? getYahooTicker(ticker, market);
    const quote = await (await yf()).quote(symbol);
    const price = quote.regularMarketPrice ?? quote.ask ?? 0;
    const currency = quote.currency ?? 'USD';
    const timestamp = new Date().toISOString();
    return { price, currency, timestamp };
  } catch (err) {
    console.error(`Price fetch failed for ${ticker}:`, err);
    return null;
  }
}

/**
 * Refresh stored prices for held investments, market-hours aware.
 *
 * For exchange-listed holdings (NYSE/NASDAQ/ASX/LSE/TSX) the price AND the
 * FX-rate snapshot are only refreshed while that market is open, then frozen
 * until it reopens — so a holding's converted value doesn't drift overnight or
 * on weekends/holidays just because forex kept moving. Crypto and non-exchange
 * types (managed funds, metals, etc.) are not gated.
 *
 * The FX rate (native currency → the owner's preferred currency) is stored on
 * the row at refresh time so reads return a stable, session-pinned value.
 *
 * @param assetTypes  Optional allow-list of `asset_type` values to update.
 */
export async function updateAllInvestmentPrices(assetTypes?: string[]): Promise<void> {
  let query = supabase
    .from('investments')
    .select('id, user_id, ticker, market, shares_owned, cost_basis, native_currency, asset_type, metal_unit, metal_detailed');

  if (assetTypes && assetTypes.length > 0) {
    query = query.in('asset_type', assetTypes);
  }

  const { data: investments } = await query;

  if (!investments || investments.length === 0) return;

  // Preferred currency per owner — used to snapshot the FX rate.
  const userIds = [...new Set(investments.map(i => i.user_id).filter(Boolean))];
  const prefByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from('users').select('id, currency_preference').in('id', userIds);
    for (const u of users ?? []) prefByUser.set(u.id, u.currency_preference ?? 'AUD');
  }

  for (const inv of investments) {
    if (!inv.ticker) continue;

    // Skip holdings whose market is currently closed → price + FX stay frozen.
    if (isHoursGated(inv.market) && isMarketOpen(inv.market) === false) continue;

    // Metals (generic AND in-depth) value at the live metal spot price: a holding's
    // worth is its metal content's current value, while the recorded buy price/cost
    // basis (the premium the user paid) is preserved separately. So we refresh both.

    // Refresh from spot, converted to the holding's weight unit.
    const result = inv.asset_type === 'precious_metal'
      ? await fetchMetalSpotPerUnit(inv.ticker, inv.metal_unit || 'grams')
      : await fetchCurrentPrice(inv.ticker, inv.market);
    if (!result) continue;

    const current_value = inv.shares_owned * result.price;
    const native = result.currency || inv.native_currency || 'AUD';
    const preferred = prefByUser.get(inv.user_id) ?? 'AUD';
    const conversion_rate = native !== preferred ? await getRate(native, preferred) : 1;

    await supabase.from('investments').update({
      current_price: result.price,
      current_value,
      native_currency: native,
      conversion_rate,
      display_currency: preferred,
      last_price_update: result.timestamp,
    }).eq('id', inv.id);

    await supabase.from('investment_price_history').insert({
      investment_id: inv.id,
      price: result.price,
      currency: result.currency,
      recorded_at: result.timestamp,
    });
  }
}

/**
 * Fetch per-share dividend events for a holding since a given date, using the
 * Yahoo chart "dividends" event feed. Amounts are PER SHARE in the security's
 * own (native) currency; the date is the dividend's ex-/payment date as Yahoo
 * reports it. Returns newest-last (chronological).
 */
export async function fetchDividends(
  ticker: string,
  market: string,
  sinceISO: string,
): Promise<{ date: string; amount: number }[]> {
  try {
    const symbol = METAL_TICKERS[ticker] ?? getYahooTicker(ticker, market);
    const period1 = new Date(sinceISO);
    const chart = await (await yf()).chart(symbol, {
      period1,
      interval: '1d',
      events: 'dividends',
    });
    // yahoo-finance2 exposes dividends either as chart.events.dividends (object
    // keyed by timestamp) or chart.dividends (array), depending on version.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = chart as any;
    const raw = c?.events?.dividends ?? c?.dividends ?? {};
    const list: { date: string; amount: number }[] = [];
    const pushItem = (d: unknown, amt: unknown) => {
      const amount = Number(amt);
      if (!d || !Number.isFinite(amount) || amount <= 0) return;
      const date = (d instanceof Date ? d : new Date(d as string)).toISOString().slice(0, 10);
      list.push({ date, amount });
    };
    if (Array.isArray(raw)) {
      for (const ev of raw) pushItem(ev?.date, ev?.amount);
    } else {
      for (const ev of Object.values(raw)) pushItem((ev as { date?: unknown })?.date, (ev as { amount?: unknown })?.amount);
    }
    return list
      .filter(e => e.date >= sinceISO.slice(0, 10))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (err) {
    console.error(`Dividend fetch failed for ${ticker}:`, err);
    return [];
  }
}

export async function searchTicker(query: string, _market?: string) {
  try {
    // validateResult:false — Yahoo periodically tweaks field casing (e.g.
    // typeDisp "equity" → "Equity"), which trips yahoo-finance2's strict schema
    // validation and makes .search() THROW, silently returning [] (no dropdown,
    // no ticker autofill). The raw payload is fine, so skip validation here.
    const results = await (await yf()).search(query, { quotesCount: 8, newsCount: 0 }, { validateResult: false });
    // yahoo-finance2 types may not resolve under commonjs moduleResolution;
    // cast to any[] so strict-mode doesn't flag implicit-any in callbacks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotes: any[] = (results as any).quotes ?? [];
    return quotes
      .filter((q: Record<string, unknown>) => !!q.symbol)
      .map((q: Record<string, unknown>) => {
        const quoteType = (q.quoteType as string) ?? 'EQUITY';
        const exchange  = (q.exchange  as string) ?? '';
        const symbol    = (q.symbol    as string) ?? '';

        const assetType =
          quoteType === 'ETF'            ? 'etf'          :
          quoteType === 'MUTUALFUND'     ? 'managed_fund' :
          quoteType === 'CRYPTOCURRENCY' ? 'crypto'        :
          'stock';

        const market =
          exchange === 'ASX' || symbol.endsWith('.AX')   ? 'ASX'    :
          ['NMS', 'NGM', 'NCM'].includes(exchange)        ? 'NASDAQ' :
          ['NYQ', 'PCX', 'PNK', 'NAS'].includes(exchange) ? 'NYSE'   :
          ['LSE', 'LSO', 'LON'].includes(exchange)         ? 'LSE'    :
          quoteType === 'CRYPTOCURRENCY'                   ? 'Crypto' :
          exchange || 'Other';

        const typeDisplay =
          quoteType === 'ETF'            ? 'ETF'          :
          quoteType === 'MUTUALFUND'     ? 'Managed Fund' :
          quoteType === 'CRYPTOCURRENCY' ? 'Crypto'        :
          'Stock';

        return {
          symbol,
          name:        (q.longname as string) ?? (q.shortname as string) ?? symbol,
          exchange,
          market,
          assetType,
          typeDisplay,
        };
      });
  } catch {
    return [];
  }
}
