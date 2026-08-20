/**
 * Yahoo's v8 chart endpoint, as a fallback quote source.
 *
 * The primary quote path (yahoo-finance2's quote()) rides Yahoo's v7 quote API,
 * which demands a cookie + crumb handshake — and Yahoo refuses that handshake to
 * datacenter IPs. On 2026-08-16 a deploy restarted the production process, the
 * fresh process never got a session, and every quote since failed silently: prices
 * froze at the Aug 15 close for five days while the app kept presenting them as
 * live. The chart endpoint answers the same question — last price, previous close,
 * currency — with no handshake at all, so it works from the places quote() won't.
 *
 * Day change is read from the LAST TWO DAILY CLOSES, not `chartPreviousClose`:
 * that field is the close before the requested RANGE (five days ago), and using it
 * would report a week's move as a day's. During a live session the final bar is
 * the live price and the bar before it is yesterday's close, which is exactly the
 * pair the day change is defined on; after hours the same two bars still are.
 */

interface ChartQuote {
  price: number;
  previousClose: number | null;
  dayChangePercent: number | null;
  currency: string | null;
  /** Exchange timestamp of the last bar, ISO. */
  timestamp: string;
}

/** Pure parser, testable without the network. Returns null when the shape isn't a
 *  usable quote — a garbage response must read as "no data", never as a price. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseChartQuote(body: any): ChartQuote | null {
  const result = body?.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  // Walk the daily closes backwards past any null bars (holidays pad with null).
  const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.map(Number).filter(c => Number.isFinite(c) && c > 0);
  const previousClose = valid.length >= 2 ? valid[valid.length - 2] : null;

  const dayChangePercent = previousClose
    ? parseFloat((((price - previousClose) / previousClose) * 100).toFixed(6))
    : null;

  const t = Number(meta?.regularMarketTime);
  return {
    price,
    previousClose,
    dayChangePercent,
    currency: typeof meta?.currency === 'string' ? meta.currency : null,
    timestamp: Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : new Date().toISOString(),
  };
}

/** Live quote via the chart endpoint. Null on any failure — callers treat this
 *  exactly like a failed quote() and fall through to their own fallbacks. */
export async function fetchChartQuote(symbol: string): Promise<ChartQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseChartQuote(await res.json());
  } catch {
    return null;
  }
}
