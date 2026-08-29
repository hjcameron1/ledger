import { describe, it, expect, vi, beforeEach } from 'vitest';

// The live rate is a network call; what's under test is WHICH rate gets chosen.
const getRate = vi.fn(async () => 1.42);
vi.mock('./currencyService', () => ({ getRate: (...a: string[]) => getRate(...a) }));

const { investmentRate, investmentValueInPreferred } = await import('./investmentValue');

/**
 * Which rate a holding is translated at.
 *
 * The bug this pins: the net-worth snapshot converted at a LIVE rate while the
 * Investments page and the client's own net-worth sum used the rate PINNED on the
 * row. Every snapshot was therefore recorded on a different base from the figure on
 * the screen, and subtracting the two produced a "change today" that was really just
 * the two methods disagreeing — a phantom nothing in the breakdown could explain.
 */
describe('the rate a holding is valued at', () => {
  beforeEach(() => getRate.mockClear());

  const usd = (o = {}) => ({
    native_currency: 'USD', conversion_rate: 1.5, display_currency: 'AUD', asset_type: 'stock', ...o,
  });

  it('uses the rate pinned at the last price refresh', async () => {
    expect(await investmentRate(usd(), 'AUD')).toBe(1.5);
    expect(getRate).not.toHaveBeenCalled();
  });

  it('is the same base the Investments page shows', async () => {
    // Baseline restated by the valuation unification: the value is derived from
    // the row's units and price and rounded ONCE, not read off the rounded
    // `current_value` stamp. 40 × 250 × 1.5 — see netWorthValuationBasis.test.ts
    // and its frontend mirror for the cases where the two differ.
    expect(await investmentValueInPreferred({ ...usd(), shares_owned: 40, current_price: 250 }, 'AUD')).toBe(15_000);
  });

  it('falls back to the stored value only when the row has no units and price', async () => {
    // An old row, or a query that did not select them: a stale figure beats no
    // figure. Every caller in this codebase selects both.
    expect(await investmentValueInPreferred({ ...usd(), current_value: 10_000 }, 'AUD')).toBe(15_000);
  });

  it('goes live for cash, whose row the price cron never touches', async () => {
    expect(await investmentRate(usd({ asset_type: 'cash' }), 'AUD')).toBe(1.42);
  });

  it('goes live when the pin was never really set', async () => {
    // Missing, the 1 placeholder, or stamped for a currency the user no longer prefers.
    expect(await investmentRate(usd({ conversion_rate: null }), 'AUD')).toBe(1.42);
    expect(await investmentRate(usd({ conversion_rate: 1 }), 'AUD')).toBe(1.42);
    expect(await investmentRate(usd({ display_currency: 'USD' }), 'AUD')).toBe(1.42);
  });

  it('does not convert what is already in the right currency', async () => {
    expect(await investmentRate({ native_currency: 'AUD' }, 'AUD')).toBe(1);
    expect(getRate).not.toHaveBeenCalled();
  });
});
