import { describe, it, expect } from 'vitest';
import { parseChartQuote } from './yahooChart';

/**
 * The crumb-free fallback quote. What matters here is the two traps its shape
 * invites: `chartPreviousClose` is the close before the whole RANGE (a week's move
 * dressed as a day's), and holiday bars pad the closes array with nulls.
 */
describe('reading a chart response as a quote', () => {
  const body = (over = {}) => ({
    chart: {
      result: [{
        meta: { regularMarketPrice: 762.6, chartPreviousClose: 777.88, currency: 'USD', regularMarketTime: 1_787_256_000 },
        timestamp: [1, 2, 3],
        indicators: { quote: [{ close: [767.45, 769.06, 762.6] }] },
        ...over,
      }],
    },
  });

  it('takes the day change from the last two closes, never chartPreviousClose', () => {
    const q = parseChartQuote(body())!;
    // vs 769.06 (yesterday) = −0.84%; vs chartPreviousClose 777.88 it would read
    // −1.96% — five days of movement misreported as today's.
    expect(q.dayChangePercent).toBeCloseTo(-0.84, 2);
    expect(q.previousClose).toBe(769.06);
    expect(q.price).toBe(762.6);
    expect(q.currency).toBe('USD');
  });

  it('walks past null holiday bars', () => {
    const q = parseChartQuote(body({ indicators: { quote: [{ close: [769.06, null, 762.6] }] } }))!;
    expect(q.previousClose).toBe(769.06);
  });

  it('reports no day change from a single bar rather than inventing one', () => {
    const q = parseChartQuote(body({ indicators: { quote: [{ close: [762.6] }] } }))!;
    expect(q.dayChangePercent).toBeNull();
    expect(q.price).toBe(762.6);
  });

  it('reads garbage as no data, never as a price', () => {
    expect(parseChartQuote(null)).toBeNull();
    expect(parseChartQuote({})).toBeNull();
    expect(parseChartQuote({ chart: { result: [{ meta: { regularMarketPrice: 0 } }] } })).toBeNull();
    expect(parseChartQuote({ chart: { result: [{ meta: { regularMarketPrice: 'NaN' } }] } })).toBeNull();
  });
});
