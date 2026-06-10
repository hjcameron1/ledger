import axios from 'axios';
import { supabase } from '../utils/supabase';

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
    return r && r > 0 ? Number(r) : null;
  } catch {
    return null;
  }
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

export async function getRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;

  // Live interbank rate from Yahoo first — intraday and broker-aligned. This is the
  // rate used to value current holdings, so it must track the market, not lag a day.
  const live = await fetchLiveYahooRate(from, to);
  if (live) return live;

  // Fallback 1: today's stored reference rate (from the daily Frankfurter sync).
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_currency', from)
    .eq('to_currency', to)
    .eq('date', today)
    .single();
  if (data?.rate) return data.rate;

  // Fallback 2: live Frankfurter (ECB reference).
  try {
    const resp = await axios.get(`${FRANKFURTER_BASE}/latest?from=${from}&to=${to}`);
    return resp.data.rates[to] ?? 1;
  } catch {
    return 1;
  }
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
