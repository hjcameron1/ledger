import { supabase } from '../utils/supabase';

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

export async function updateAllInvestmentPrices(): Promise<void> {
  const { data: investments } = await supabase
    .from('investments')
    .select('id, ticker, market, shares_owned, cost_basis, native_currency');

  if (!investments) return;

  for (const inv of investments) {
    if (!inv.ticker) continue;
    const result = await fetchCurrentPrice(inv.ticker, inv.market);
    if (!result) continue;

    const current_value = inv.shares_owned * result.price;
    await supabase.from('investments').update({
      current_price: result.price,
      current_value,
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

export async function searchTicker(query: string, _market?: string) {
  try {
    const results = await (await yf()).search(query, { quotesCount: 8, newsCount: 0 });
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
