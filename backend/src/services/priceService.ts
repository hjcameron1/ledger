import { supabase } from '../utils/supabase';
import { getRate } from './currencyService';
import { fetchChartQuote } from './yahooChart';
import { isMarketOpen, isHoursGated } from './marketCalendar';
import { majorUnitOf, normaliseQuote } from './quoteCurrency';

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

/**
 * Yahoo's exchange code → the market name Ledger's Add-holding dropdown uses.
 *
 * These are NOT the same strings, and the search route used to compare them
 * directly: pick "XETRA" in the dropdown and Yahoo answers `GER`, which matched
 * nothing, and the strict market filter then threw every result away. Seven of
 * the twelve markets Ledger offers — Toronto, Frankfurt, Paris, Amsterdam,
 * Zurich, Hong Kong and Mumbai — could not return a single search result. Every
 * code below was read off a live `search` response for a listing on that market.
 */
const EXCHANGE_MARKET: Record<string, string> = {
  ASX: 'ASX',
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', PCX: 'NYSE', PNK: 'NYSE', ASE: 'NYSE',
  LSE: 'LSE', LSO: 'LSE', LON: 'LSE', IOB: 'LSE',
  TOR: 'TSX', TSX: 'TSX',
  GER: 'XETRA', XETRA: 'XETRA', FRA: 'XETRA',
  PAR: 'Euronext Paris',
  AMS: 'Euronext Amsterdam',
  EBS: 'SIX', VTX: 'SIX',
  JPX: 'JPX', TKS: 'JPX',
  HKG: 'HKEX',
  NSI: 'NSE',
  CCC: 'Crypto', CCY: 'Crypto',
};

/**
 * The same answer from the ticker suffix, for the days Yahoo invents a code this
 * table has not seen. A `.AX` is on the ASX whatever the exchange field says.
 */
const SUFFIX_MARKET: Record<string, string> = {
  '.AX': 'ASX', '.L': 'LSE', '.TO': 'TSX', '.NS': 'NSE', '.HK': 'HKEX',
  '.DE': 'XETRA', '.PA': 'Euronext Paris', '.AS': 'Euronext Amsterdam',
  '.SW': 'SIX', '.T': 'JPX',
};

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
): Promise<{ price: number; currency: string; timestamp: string; dayChangePercent: number | null } | null> {
  try {
    const symbol = METAL_TICKERS[metal];
    if (!symbol) return null;
    const quote = await (await yf()).quote(symbol);
    const perOz = quote.regularMarketPrice ?? quote.ask ?? 0;
    if (!perOz) return null;
    const factor = OZ_PER_UNIT[unit] ?? OZ_PER_UNIT.grams;
    // Spot metals (GC=F/SI=F) carry an intraday % move just like equities — surface
    // it so gold/silver show "today's movement" instead of a blank.
    const dayChangePercent = quote.regularMarketChangePercent != null
      ? Number(quote.regularMarketChangePercent)
      : null;
    return {
      price: perOz * factor,
      currency: quote.currency ?? 'USD',
      timestamp: new Date().toISOString(),
      dayChangePercent,
    };
  } catch (err) {
    console.error(`Metal spot fetch failed for ${metal}:`, err);
    return null;
  }
}

/**
 * Per-unit valuation of an in-depth metal holding from its LINKED dealer product
 * (metal_products row), in the dealer's quote currency (AUD). We use the dealer's
 * own buyback (sell_price) — what the user could actually realise — divided by the
 * product's weight to get a price for ONE of the user's chosen weight units. Falls
 * back to spot_value when buyback hasn't been captured for that product yet.
 * Returns null if the product is gone or has no usable price, so the caller can
 * fall back to the generic metal spot.
 */
export async function fetchDealerPricePerUnit(
  productId: string,
  unit: string,
): Promise<{ price: number; currency: string; timestamp: string } | null> {
  try {
    const { data: p } = await supabase
      .from('metal_products')
      .select('sell_price, spot_value, weight_grams, currency, scraped_at')
      .eq('id', productId)
      .single();
    if (!p) return null;
    const grams = Number(p.weight_grams);
    const perProduct = Number(p.sell_price ?? p.spot_value);
    if (!grams || !Number.isFinite(perProduct) || perProduct <= 0) return null;
    const perGram = perProduct / grams;
    // shares_owned is stored in the holding's metal_unit; convert per-gram → per-unit.
    const gramsPerUnit = unit === 'kg' ? 1000 : unit === 'ounces' ? 31.1034768 : 1;
    return {
      price: perGram * gramsPerUnit,
      currency: p.currency ?? 'AUD',
      timestamp: p.scraped_at ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Dealer price lookup failed for product ${productId}:`, err);
    return null;
  }
}

export async function fetchCurrentPrice(
  ticker: string,
  market: string
): Promise<{ price: number; currency: string; timestamp: string; dayChangePercent: number | null } | null> {
  const symbol = METAL_TICKERS[ticker] ?? getYahooTicker(ticker, market);
  try {
    const quote = await (await yf()).quote(symbol);
    const raw = quote.regularMarketPrice ?? quote.ask ?? 0;
    // A response with no price is a failure wearing a 200 — fall through to the
    // chart endpoint rather than freezing the holding at its last value.
    if (!raw) throw new Error('quote returned no price');
    // London quotes in PENCE and says so with a currency string of `GBp`. Restate
    // it in pounds HERE, so nothing downstream — the FX rate, the stored
    // native_currency, the Sell dialog's prefill — is ever handed a number in a
    // unit it does not understand. See services/quoteCurrency.
    const { price, currency } = normaliseQuote(raw, quote.currency ?? 'USD');
    const timestamp = new Date().toISOString();
    // % move since the previous market close (today's change) straight from Yahoo.
    // A percentage is unit-free, so the pence fold cannot touch it.
    const dayChangePercent = quote.regularMarketChangePercent != null
      ? Number(quote.regularMarketChangePercent)
      : null;
    return { price, currency, timestamp, dayChangePercent };
  } catch (err) {
    // quote() rides Yahoo's crumb-gated endpoint, which refuses datacenter IPs —
    // in production it can fail on EVERY call while working fine locally, which is
    // how prices sat frozen at a five-day-old close and the whole page drifted from
    // reality. The chart endpoint needs no handshake; same answer, second door.
    const chart = await fetchChartQuote(symbol);
    if (chart) {
      // The second door reports the same `GBp` the first one does — fold it too,
      // or a London holding would be right or wrong depending on which endpoint
      // happened to answer.
      const { price, currency } = normaliseQuote(chart.price, chart.currency ?? 'USD');
      return {
        price,
        currency,
        timestamp: new Date().toISOString(),
        dayChangePercent: chart.dayChangePercent,
      };
    }
    console.error(`Price fetch failed for ${ticker} (quote + chart):`, err);
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
    .select('id, user_id, ticker, market, shares_owned, cost_basis, native_currency, asset_type, metal_unit, metal_detailed, metal_product_id');

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

  // One honest line per run. Five days of every quote failing looked exactly like
  // five days of markets not moving — a dead feed must not be able to impersonate
  // a quiet one.
  let updated = 0, frozen = 0, failed = 0;

  for (const inv of investments) {
    if (!inv.ticker) continue;

    // Holdings whose market is currently closed → the share PRICE stays frozen (no
    // live quotes while the exchange is shut). But forex trades ~24/5, so the FX
    // rate is kept live: we refresh the native→preferred conversion rate (and the
    // last-session day-change figure) without touching the frozen price/value.
    if (isHoursGated(inv.market) && isMarketOpen(inv.market) === false) {
      const update: Record<string, unknown> = {};

      const native = inv.native_currency || 'AUD';
      const preferred = prefByUser.get(inv.user_id) ?? 'AUD';
      if (native !== preferred) {
        const conversion_rate = await getRate(native, preferred);
        update.conversion_rate = conversion_rate;
        update.display_currency = preferred;
      }

      if (inv.asset_type !== 'precious_metal') {
        const q = await fetchCurrentPrice(inv.ticker, inv.market);
        if (q && q.dayChangePercent != null) update.day_change_percent = q.dayChangePercent;
      }

      if (Object.keys(update).length > 0) {
        await supabase.from('investments').update(update).eq('id', inv.id);
      }
      frozen++;
      continue;
    }

    // Metals (generic AND in-depth) value at the live metal spot price: a holding's
    // worth is its metal content's current value, while the recorded buy price/cost
    // basis (the premium the user paid) is preserved separately. So we refresh both.

    // In-depth holdings linked to a specific dealer product value from THAT
    // product's scraped buyback (native AUD) so Ledger matches the dealer's site;
    // generic metals fall back to live spot, everything else to the Yahoo quote.
    let result: { price: number; currency: string; timestamp: string; dayChangePercent?: number | null } | null;
    if (inv.asset_type === 'precious_metal') {
      result = inv.metal_product_id
        ? (await fetchDealerPricePerUnit(inv.metal_product_id, inv.metal_unit || 'grams'))
            ?? (await fetchMetalSpotPerUnit(inv.ticker, inv.metal_unit || 'grams'))
        : await fetchMetalSpotPerUnit(inv.ticker, inv.metal_unit || 'grams');
    } else {
      result = await fetchCurrentPrice(inv.ticker, inv.market);
    }
    if (!result) { failed++; continue; }

    const current_value = inv.shares_owned * result.price;
    const native = result.currency || inv.native_currency || 'AUD';
    const preferred = prefByUser.get(inv.user_id) ?? 'AUD';
    const conversion_rate = native !== preferred ? await getRate(native, preferred) : 1;

    // Day change % comes from live Yahoo quotes — stocks/ETFs/crypto AND metal spot
    // (GC=F/SI=F). Only dealer-product-priced in-depth holdings (scraped buyback)
    // lack one, so they write null.
    const dayChangePercent = result.dayChangePercent ?? null;

    await supabase.from('investments').update({
      current_price: result.price,
      current_value,
      native_currency: native,
      conversion_rate,
      display_currency: preferred,
      last_price_update: result.timestamp,
      day_change_percent: dayChangePercent,
    }).eq('id', inv.id);

    await supabase.from('investment_price_history').insert({
      investment_id: inv.id,
      price: result.price,
      currency: result.currency,
      recorded_at: result.timestamp,
    });
    updated++;
  }

  console.log(`[PRICES] refresh: ${updated} updated, ${frozen} market-closed, ${failed} FAILED of ${investments.length}`);
  if (failed > 0 && updated === 0 && failed >= frozen) {
    console.error('[PRICES] every open-market quote failed this run — feed is down, values are going stale');
  }
}

/**
 * Bring a single user's holdings up to date ON READ, so the value shown never
 * depends on whether the hourly cron actually ran. This matters because the price
 * refresh above is market-hours gated, and a US market's session (13:30–20:00 UTC)
 * falls in the middle of the night in AEST — when Render's free tier has spun the
 * web service down for lack of traffic, so the in-process cron never fires and US
 * prices freeze at the last value written when someone manually touched a holding.
 * (The keepalive self-ping can't fix this: a sleeping instance can't ping itself
 * awake.) The read path, by contrast, only runs when the server is already awake
 * (the user just hit it), so refreshing here guarantees freshness.
 *
 * For every holding whose stored price is older than `maxAgeMs`, we fetch a fresh
 * quote and persist it — regardless of whether that market is currently open.
 * Yahoo returns the live intraday price during the session and the last close
 * outside it; both are exactly what the user's broker shows, so an off-hours
 * refresh yields the correct last-close value rather than a stale one. Fail-soft
 * per holding: one bad ticker never blocks the rest or the response.
 */
export async function refreshStaleHoldings(
  userId: string,
  maxAgeMs = 15 * 60 * 1000,
): Promise<void> {
  const { data: holdings } = await supabase
    .from('investments')
    .select('id, user_id, ticker, market, shares_owned, native_currency, asset_type, metal_unit, metal_product_id, last_price_update')
    .eq('user_id', userId);
  if (!holdings || holdings.length === 0) return;

  const { data: user } = await supabase
    .from('users').select('currency_preference').eq('id', userId).single();
  const preferred = user?.currency_preference ?? 'AUD';

  const now = Date.now();
  const stale = holdings.filter(
    (h) =>
      h.ticker &&
      (!h.last_price_update || now - new Date(h.last_price_update).getTime() > maxAgeMs),
  );
  if (stale.length === 0) return;

  await Promise.all(
    stale.map(async (inv) => {
      try {
        let result: { price: number; currency: string; timestamp: string; dayChangePercent?: number | null } | null;
        if (inv.asset_type === 'precious_metal') {
          result = inv.metal_product_id
            ? (await fetchDealerPricePerUnit(inv.metal_product_id, inv.metal_unit || 'grams'))
                ?? (await fetchMetalSpotPerUnit(inv.ticker!, inv.metal_unit || 'grams'))
            : await fetchMetalSpotPerUnit(inv.ticker!, inv.metal_unit || 'grams');
        } else {
          result = await fetchCurrentPrice(inv.ticker!, inv.market);
        }
        if (!result) return;

        const current_value = inv.shares_owned * result.price;
        const native = result.currency || inv.native_currency || 'AUD';
        const conversion_rate = native !== preferred ? await getRate(native, preferred) : 1;
        const dayChangePercent = result.dayChangePercent ?? null;

        await supabase.from('investments').update({
          current_price: result.price,
          current_value,
          native_currency: native,
          conversion_rate,
          display_currency: preferred,
          last_price_update: result.timestamp,
          day_change_percent: dayChangePercent,
        }).eq('id', inv.id);

        await supabase.from('investment_price_history').insert({
          investment_id: inv.id,
          price: result.price,
          currency: result.currency,
          recorded_at: result.timestamp,
        });
      } catch (err) {
        console.error(`[refreshStaleHoldings] ${inv.ticker} failed:`, err);
      }
    }),
  );
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
): Promise<{ date: string; amount: number; currency: string | null }[]> {
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
    // A dividend is quoted in the same unit as the share it is paid on, so a
    // London payment arrives in PENCE. Fold it with the quote's own currency
    // rather than the holding's stored one, and hand that currency back so the
    // caller converts at a rate for a currency that exists.
    const quoted = String(c?.meta?.currency ?? '') || null;
    const { per } = majorUnitOf(quoted);
    const currency = quoted ? majorUnitOf(quoted).currency : null;
    const list: { date: string; amount: number; currency: string | null }[] = [];
    const pushItem = (d: unknown, amt: unknown) => {
      const amount = Number(amt);
      if (!d || !Number.isFinite(amount) || amount <= 0) return;
      const date = (d instanceof Date ? d : new Date(d as string)).toISOString().slice(0, 10);
      list.push({ date, amount: amount / per, currency });
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

// Run one Yahoo .search() and return its raw quotes array (never throws).
async function rawSearch(query: string): Promise<Record<string, unknown>[]> {
  try {
    // validateResult:false — Yahoo periodically tweaks field casing (e.g.
    // typeDisp "equity" → "Equity"), which trips yahoo-finance2's strict schema
    // validation and makes .search() THROW, silently returning [] (no dropdown,
    // no ticker autofill). The raw payload is fine, so skip validation here.
    const results = await (await yf()).search(query, { quotesCount: 15, newsCount: 0 }, { validateResult: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((results as any).quotes ?? []) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export async function searchTicker(query: string, marketFilter?: string) {
  try {
    const quotes = await rawSearch(query);
    // When a market is selected and it uses a ticker suffix (e.g. ASX → .AX),
    // Yahoo's plain-query results often omit that market entirely (searching
    // "CBA" surfaces US/EU listings, not CBA.AX). Run a second suffix-augmented
    // query so the chosen market's listings actually appear, then merge.
    const suffix = marketFilter ? MARKET_SUFFIX[marketFilter] : undefined;
    if (suffix) {
      const extra = await rawSearch(`${query}${suffix}`);
      const seen = new Set(quotes.map(q => q.symbol as string));
      for (const q of extra) {
        if (q.symbol && !seen.has(q.symbol as string)) quotes.push(q);
      }
    }
    // yahoo-finance2 types may not resolve under commonjs moduleResolution;
    // cast so strict-mode doesn't flag implicit-any in callbacks
    const mapped = quotes
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
          EXCHANGE_MARKET[exchange]                      ??
          (SUFFIX_MARKET[symbol.slice(symbol.lastIndexOf('.'))] ??
          (quoteType === 'CRYPTOCURRENCY' ? 'Crypto' : exchange || 'Other'));

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

    // When the caller picked a market (e.g. ASX), ONLY show tickers listed
    // there — searching "CBA" under ASX returns CBA.AX, never a same-named US
    // listing. Strict filter (no fallback): if there's no match on that market,
    // an empty dropdown is correct, not a list of foreign exchanges.
    if (marketFilter) {
      return mapped.filter(r => r.market === marketFilter);
    }
    return mapped;
  } catch {
    return [];
  }
}
