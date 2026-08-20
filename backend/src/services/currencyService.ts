import axios from 'axios';
import { supabase } from '../utils/supabase';
import { fetchChartQuote } from './yahooChart';

const FRANKFURTER_BASE = 'https://api.frankfurter.app';

// yahoo-finance2 is ESM-only and v3 requires instantiation — lazy-load a singleton.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _yf: any = null;
async function yf() {
  if (!_yf) {
    const mod = await import('yahoo-finance2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const YF = (mod.default ?? mod) as any;
    _yf = new YF({ suppressNotices: ['yahooSurvey'] });
  }
  return _yf;
}

// Live FX rate from Yahoo (e.g. USDAUD=X). Yahoo quotes the interbank rate intraday,
// matching what brokers show — unlike Frankfurter, which serves the ECB's once-daily
// reference rate (a day stale and ~0.5% off the live rate). Returns null on failure.
async function fetchLiveYahooRate(from: string, to: string): Promise<number | null> {
  try {
    const q = await (await yf()).quote(`${from}${to}=X`);
    const r = q?.regularMarketPrice;
    if (r && r > 0) return Number(r);
  } catch {
    /* fall through to the chart endpoint */
  }
  // quote() needs Yahoo's cookie+crumb handshake, which datacenter IPs are refused —
  // the chart endpoint answers without one. Same live interbank rate, second door.
  const chart = await fetchChartQuote(`${from}${to}=X`);
  return chart && chart.price > 0 ? chart.price : null;
}

export async function fetchAndStoreDailyRates(baseCurrency = 'AUD'): Promise<void> {
  try {
    const { data } = await axios.get(`${FRANKFURTER_BASE}/latest?from=${baseCurrency}`);
    const rates: Record<string, number> = data.rates;
    const date = data.date;

    const rows = Object.entries(rates).map(([to_currency, rate]) => ({
      from_currency: baseCurrency,
      to_currency,
      rate,
      date,
    }));

    // Also store reverse rates
    const reverseRows = Object.entries(rates).map(([to_currency, rate]) => ({
      from_currency: to_currency,
      to_currency: baseCurrency,
      rate: 1 / rate,
      date,
    }));

    await supabase.from('exchange_rates').upsert([...rows, ...reverseRows], {
      onConflict: 'from_currency,to_currency,date',
    });
  } catch (err) {
    console.error('Currency fetch error:', err);
  }
}

// In-memory "last good rate" per pair, kept warm across calls within a process.
// The daily cron/snapshot process is long-lived, so once a real rate has been seen
// this survives transient total-lookup failures. Its whole purpose: when the DB
// read, Yahoo AND Frankfurter all momentarily fail in one pass, we fall back to the
// last known-good rate instead of the old `return 1` par value — which silently
// counted a USD holding as AUD 1:1 and dropped net worth ~14% for that snapshot.
const lastGoodRate = new Map<string, number>();

/** Most recent stored rate for a pair (any date, newest first). Null if none. */
async function latestStoredRate(from: string, to: string): Promise<number | null> {
  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_currency', from)
    .eq('to_currency', to)
    .order('date', { ascending: false })
    .limit(1);
  const r = data?.[0]?.rate;
  return r && Number(r) > 0 ? Number(r) : null;
}

export async function getRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;

  // Reference = the most recent rate we've ever stored for this pair (daily
  // Frankfurter sync). Used both to sanity-check the live quote and as the last
  // resort — so a single bad read can never mis-value a holding. This guards two
  // real failure modes that produced phantom net-worth swings: (a) Yahoo returning
  // a garbage quote (wrong instrument / inverted pair) spiking a foreign holding,
  // and (b) the old `return 1` fallback silently valuing a foreign holding at par
  // (e.g. 19.5k USD counted as 19.5k AUD), dropping net worth by thousands.
  const pairKey = `${from}:${to}`;
  const reference = await latestStoredRate(from, to);
  if (reference) lastGoodRate.set(pairKey, reference); // keep the cache warm

  // Live interbank rate from Yahoo — intraday and broker-aligned. Accept it only
  // when sane: positive, and (when we have a reference) within ±25% of it. Major
  // FX pairs never move that far in the ~1 day since the reference was stored, so
  // the band rejects only true garbage, never a legitimate market move.
  const live = await fetchLiveYahooRate(from, to);
  if (live && (!reference || (live >= reference * 0.75 && live <= reference * 1.25))) {
    lastGoodRate.set(pairKey, live);
    return live;
  }

  // Fallback 1: today's stored reference rate (from the daily Frankfurter sync).
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_currency', from)
    .eq('to_currency', to)
    .eq('date', today)
    .single();
  if (data?.rate) { lastGoodRate.set(pairKey, data.rate); return data.rate; }

  // Fallback 2: live Frankfurter (ECB reference).
  try {
    const resp = await axios.get(`${FRANKFURTER_BASE}/latest?from=${from}&to=${to}`);
    const rate = resp.data.rates[to];
    if (rate) { lastGoodRate.set(pairKey, rate); return rate; }
  } catch {
    /* fall through */
  }

  // Fallback 3: the most recent rate ever stored, else the last good rate seen this
  // process — far safer than fabricating 1, which corrupts every foreign holding
  // (a USD holding counted as AUD 1:1 → phantom −14% net-worth dips). We only return
  // 1 when we've GENUINELY never resolved this pair (never synced, empty cache).
  return reference ?? lastGoodRate.get(pairKey) ?? 1;
}

/**
 * FX rate between two currencies AS OF a specific date (YYYY-MM-DD). Used to lock a
 * holding's cost basis at the rate that applied on its purchase date, so converted
 * cost matches what the user actually paid rather than today's rate. Cached in
 * exchange_rates. Falls back to the latest rate if the historical lookup fails.
 */
export async function getRateOn(from: string, to: string, date: string): Promise<number> {
  if (from === to) return 1;
  if (!date || date >= new Date().toISOString().split('T')[0]) return getRate(from, to);

  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_currency', from)
    .eq('to_currency', to)
    .eq('date', date)
    .single();
  if (data?.rate) return data.rate;

  try {
    // Frankfurter returns the most recent trading day on/before `date` for weekends/holidays.
    const resp = await axios.get(`${FRANKFURTER_BASE}/${date}?from=${from}&to=${to}`);
    const rate = resp.data?.rates?.[to];
    if (rate) {
      await supabase.from('exchange_rates').upsert(
        [{ from_currency: from, to_currency: to, rate, date }],
        { onConflict: 'from_currency,to_currency,date' },
      );
      return rate;
    }
  } catch {
    /* fall through */
  }
  return getRate(from, to);
}

export async function convertAmount(
  amount: number,
  from: string,
  to: string
): Promise<{ converted: number; rate: number }> {
  const rate = await getRate(from, to);
  return { converted: parseFloat((amount * rate).toFixed(2)), rate };
}

/**
 * Enrich a list of rows for display in the user's preferred currency. Each row
 * keeps its raw values (in `currencyField`, native) untouched, and gains a
 * `display_<field>` for every entry in `amountFields` converted at the current
 * live rate, plus `display_currency` and `conversion_rate`. Live (not historical)
 * rate is correct here — these are current balances/amounts, not a locked cost basis.
 */
export async function enrichWithDisplayAmounts<T extends Record<string, unknown>>(
  rows: T[],
  amountFields: string[],
  preferredCurrency: string,
  currencyField = 'currency',
): Promise<(T & Record<string, unknown>)[]> {
  if (!rows.length) return rows;

  const currencies = new Set<string>();
  for (const row of rows) {
    currencies.add((row[currencyField] as string) || 'AUD');
  }

  const rates: Record<string, number> = {};
  await Promise.all(
    Array.from(currencies).map(async (ccy) => {
      rates[ccy] = ccy === preferredCurrency ? 1 : await getRate(ccy, preferredCurrency);
    }),
  );

  return rows.map((row) => {
    const ccy = (row[currencyField] as string) || 'AUD';
    const rate = rates[ccy] ?? 1;
    const enriched: Record<string, unknown> = {
      ...row,
      display_currency: preferredCurrency,
      conversion_rate: rate,
    };
    for (const field of amountFields) {
      const raw = row[field];
      enriched[`display_${field}`] = raw == null ? raw : parseFloat((Number(raw) * rate).toFixed(2));
    }
    return enriched as T & Record<string, unknown>;
  });
}
