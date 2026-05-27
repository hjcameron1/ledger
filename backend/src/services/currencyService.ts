import axios from 'axios';
import { supabase } from '../utils/supabase';

const FRANKFURTER_BASE = 'https://api.frankfurter.app';

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

  const today = new Date().toISOString().split('T')[0];

  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_currency', from)
    .eq('to_currency', to)
    .eq('date', today)
    .single();

  if (data?.rate) return data.rate;

  // Fallback: fetch live
  try {
    const resp = await axios.get(`${FRANKFURTER_BASE}/latest?from=${from}&to=${to}`);
    return resp.data.rates[to] ?? 1;
  } catch {
    return 1;
  }
}

export async function convertAmount(
  amount: number,
  from: string,
  to: string
): Promise<{ converted: number; rate: number }> {
  const rate = await getRate(from, to);
  return { converted: parseFloat((amount * rate).toFixed(2)), rate };
}
