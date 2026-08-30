import axios from 'axios';
import { supabase } from '../utils/supabase';
import { fetchChartQuote } from './yahooChart';
import { majorUnitOf } from './quoteCurrency';

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

// One Yahoo FX quote for an ordered pair (e.g. USDAUD=X). Returns null on failure.
async function fetchOneYahooRate(from: string, to: string): Promise<number | null> {
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

/**
 * Live FX rate from Yahoo — quoted in the direction that carries the most digits.
 *
 * Yahoo serves every FX pair to FOUR DECIMAL PLACES whichever way round you ask,
 * and that is a precision floor, not a precision guarantee: AUDJPY=X comes back
 * as 114.634 while JPYAUD=X comes back as 0.0087. Both are "the same rate", but
 * one has six significant figures and the other has two. Converting a Japanese
 * holding at 0.0087 instead of 1/114.634 = 0.00872376 understates it by 0.27% —
 * about A$2,400 on a ¥100m position — and, worse, it MOVES IN STEPS: as AUD/JPY
 * drifts from 114.9 to 113.7 the rounded reciprocal jumps 0.0087 → 0.0088, a
 * 1.15% leap in a holding's recorded worth on a day the market barely moved.
 *
 * So a small quote is not taken at face value when the market quotes the pair
 * the other way round: we ask for the inverse as well and invert it. The
 * threshold is the point where the fourth decimal place stops mattering — a
 * quote of 0.5 or more is granular to 0.0001/0.5 = 0.02%, which is inside the
 * spread and below the cent a holding is rounded to. Above it there is no
 * second call, so the common AUD pairs (USD 0.7164, EUR 0.6183, GBP 0.5291)
 * still cost one request each and only the yen and the Hong Kong dollar pay for
 * a round trip they actually need.
 */
const FX_PRECISION_FLOOR = 0.5;

async function fetchLiveYahooRate(from: string, to: string): Promise<number | null> {
  const direct = await fetchOneYahooRate(from, to);
  if (direct != null && direct >= FX_PRECISION_FLOOR) return direct;

  const inverse = await fetchOneYahooRate(to, from);
  // Only trust the flip when the other side really is the larger number; two
  // sub-unity quotes for one pair would mean something else is wrong.
  if (inverse != null && inverse > 1) return 1 / inverse;
  return direct;
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

/**
 * The rate between two ISO currencies. Every public entry point normalises minor
 * units before reaching this, so `from`/`to` here are always real currencies.
 */
async function isoRate(from: string, to: string): Promise<number> {
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
 * The rate between two quote currencies, minor units included.
 *
 * A price feed can hand back `GBp` — pence, not pounds — and rows written before
 * that was understood still carry it alongside a pence price. Both ends are
 * folded into their ISO currency and the divisor is carried into the answer, so
 * pence × getRate('GBp','AUD') is the holding's true worth in dollars without a
 * single stored row having to change. See services/quoteCurrency.
 */
export async function getRate(from: string, to: string): Promise<number> {
  const f = majorUnitOf(from);
  const t = majorUnitOf(to);
  const base = await isoRate(f.currency, t.currency);
  return (base * t.per) / f.per;
}

/**
 * The rate CASH is converted at: one number per pair per day, shared by
 * everything that states a converted balance.
 *
 * `getRate` is a LIVE intraday quote, and two calls minutes apart return two
 * different numbers. That is right for a holding's price and wrong for a bank
 * balance, because the balance is quoted in two places on two different clocks:
 * the API stamps `display_balance` when a screen fetches the account, and the
 * snapshot converts the same balance again when the nightly pass runs. The
 * screen and the recorded history then sat on two bases, and subtracting them
 * produced a "change" that was partly just the two methods disagreeing — the
 * exact bug `investmentValue` fixed for holdings by pinning their rate.
 *
 * So: today's stored rate if there is one, otherwise resolve it live ONCE and
 * store it under today's date, so the next caller — this process or any other —
 * reads back the same number rather than asking again. Falls through to
 * `getRate` only when the write itself fails, which is the old behaviour.
 *
 * What this does NOT promise: the day's row is written by whoever asks first,
 * and `fetchAndStoreDailyRates` overwrites it when the daily sync lands. So a
 * pair's basis can still change once, mid-day, at a moment every reader shares.
 * That is a step both tiers take together, not the continuous drift between them
 * this replaces. Pinning it beyond that means storing the rate on the row, which
 * is a column bank_accounts does not have.
 */
export async function balanceRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;
  // A minor unit is not a currency a balance can be stored in; fold it and its
  // divisor through the same daily basis rather than storing a `GBp` row.
  const f = majorUnitOf(from), t = majorUnitOf(to);
  if (f.per !== 1 || t.per !== 1) {
    const base = await balanceRate(f.currency, t.currency);
    return (base * t.per) / f.per;
  }
  const today = new Date().toISOString().split('T')[0];

  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_currency', from)
    .eq('to_currency', to)
    .eq('date', today)
    .maybeSingle();
  if (data?.rate && Number(data.rate) > 0) return Number(data.rate);

  const rate = await getRate(from, to);
  if (rate > 0) {
    // Fix the day's basis for everybody else. onConflict makes a race between two
    // processes converge on whichever landed first rather than on either's quote.
    const { error } = await supabase.from('exchange_rates').upsert(
      [{ from_currency: from, to_currency: to, rate, date: today }],
      { onConflict: 'from_currency,to_currency,date' },
    );
    if (!error) {
      const { data: settled } = await supabase
        .from('exchange_rates')
        .select('rate')
        .eq('from_currency', from)
        .eq('to_currency', to)
        .eq('date', today)
        .maybeSingle();
      if (settled?.rate && Number(settled.rate) > 0) return Number(settled.rate);
    }
  }
  return rate;
}

/** `convertAmount` on the daily cash basis — see `balanceRate`. */
export async function convertBalance(
  amount: number,
  from: string,
  to: string,
): Promise<{ converted: number; rate: number }> {
  const rate = await balanceRate(from, to);
  return { converted: parseFloat((amount * rate).toFixed(2)), rate };
}

/**
 * FX rate between two currencies AS OF a specific date (YYYY-MM-DD). Used to lock a
 * holding's cost basis at the rate that applied on its purchase date, so converted
 * cost matches what the user actually paid rather than today's rate. Cached in
 * exchange_rates. Falls back to the latest rate if the historical lookup fails.
 */
export async function getRateOn(from: string, to: string, date: string): Promise<number> {
  if (from === to) return 1;
  // Same fold as getRate: a historical pence cost converts at the historical
  // POUND rate over a hundred, and no `GBp` row is ever written to the cache.
  const f = majorUnitOf(from), t = majorUnitOf(to);
  if (f.per !== 1 || t.per !== 1) {
    const base = await getRateOn(f.currency, t.currency, date);
    return (base * t.per) / f.per;
  }
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
 * `display_<field>` for every entry in `amountFields`, plus `display_currency`
 * and the `conversion_rate` they were converted at — which the client then reads
 * as the row's one and only basis.
 *
 * The rate is TODAY'S, not an intraday quote (`balanceRate`), so the figure a
 * screen shows and the figure the net-worth snapshot records are the same number
 * for the whole day. Current balances, not a locked cost basis: the rate moves,
 * once a day, together everywhere.
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
      rates[ccy] = ccy === preferredCurrency ? 1 : await balanceRate(ccy, preferredCurrency);
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
