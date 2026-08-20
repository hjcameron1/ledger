import { describe, it, expect } from 'vitest';
import {
  buildItemChanges, applyDailyMoves,
  type ItemChangeInputRow, type ItemTransferLeg, type ItemChange,
} from './netWorthSnapshot';

/**
 * The per-item breakdown behind "What's driving your net worth".
 *
 * The case that made this file exist: an item is written to history only while it
 * counts, so the moment a property is switched OUT of net worth it simply stops
 * appearing. Reading its last written row as "what it's worth now" then leaves it
 * frozen in the movers list at its parting value — a property the user excluded
 * went on reporting a −$850,000 move for good, even though net worth no longer had
 * anything to do with it. Switching something off must leave no trace.
 */

const t = (iso: string) => `2026-08-${iso}+00:00`;
const T1 = t('16T08:00:00.000');
const T2 = t('17T08:00:00.000');
const T3 = t('18T08:00:00.000');

const row = (
  recorded_at: string,
  item_id: string,
  value: number,
  o: Partial<ItemChangeInputRow> = {},
): ItemChangeInputRow => ({
  recorded_at,
  item_type: 'property',
  item_id,
  name: item_id,
  value,
  is_debt: false,
  ...o,
});

const bank = (recorded_at: string, value: number) =>
  row(recorded_at, 'acct', value, { item_type: 'bank', name: 'Smart Access' });

const find = (items: ReturnType<typeof buildItemChanges>, id: string) => items.find(i => i.item_id === id)!;

describe('an item still in net worth', () => {
  it('moves by the difference between its baseline and its latest value', () => {
    const items = buildItemChanges(
      [row(T1, 'house', 1_000_000), row(T2, 'house', 1_050_000), row(T3, 'house', 1_100_000)],
      new Date(T2).getTime(),
    );
    const house = find(items, 'house');
    expect(house.start_value).toBe(1_050_000);
    expect(house.current_value).toBe(1_100_000);
    expect(house.contribution).toBe(50_000);
    expect(house.removed).toBe(false);
  });

  it('reads a rising debt as a NEGATIVE contribution', () => {
    const items = buildItemChanges([
      row(T2, 'loan', 8_000, { item_type: 'loan', is_debt: true }),
      row(T3, 'loan', 8_500, { item_type: 'loan', is_debt: true }),
    ]);
    expect(find(items, 'loan').contribution).toBe(-500);
  });

  it('uses its earliest snapshot as the baseline when it was added mid-window', () => {
    // Otherwise a brand-new account reads as a sudden gain of its whole balance.
    const items = buildItemChanges([row(T3, 'house', 1_000_000)], new Date(T2).getTime());
    expect(find(items, 'house').start_value).toBe(1_000_000);
    expect(find(items, 'house').contribution).toBe(0);
  });
});

describe('an item switched out of net worth', () => {
  // The newest snapshot is T3; the property last appears at T2, so it is gone.
  const rows = [
    row(T1, 'house', 1_100_000),
    row(T2, 'house', 250_000),
    bank(T1, 5_000), bank(T2, 5_000), bank(T3, 5_000),
  ];

  it('is worth 0 now, not whatever it was worth on the way out', () => {
    const house = find(buildItemChanges(rows), 'house');
    expect(house.removed).toBe(true);
    expect(house.current_value).toBe(0);
  });

  it('is flagged so the breakdown can treat it as structural, not a loss', () => {
    // The user hasn't LOST $250,000 — they told the app to stop counting a house.
    const house = find(buildItemChanges(rows), 'house');
    expect(house.contribution).toBe(-1_100_000);   // shown only with the structural setting off
    expect(house.removed).toBe(true);
  });

  it('contributes nothing at all once the window opens after it left', () => {
    // A property excluded last week must not show up as today's biggest mover.
    const house = find(buildItemChanges(rows, new Date(T3).getTime()), 'house');
    expect(house.start_value).toBe(0);
    expect(house.current_value).toBe(0);
    expect(house.change).toBe(0);
    expect(house.contribution).toBe(0);
  });

  it('leaves every item that is still counted alone', () => {
    const acct = find(buildItemChanges(rows), 'acct');
    expect(acct.removed).toBe(false);
    expect(acct.current_value).toBe(5_000);
  });

  it('reports the drop when it left INSIDE the window', () => {
    // Baseline T1 (1,100,000) → gone by T3, so with the structural setting off the
    // breakdown can still explain where the money in the headline went.
    const house = find(buildItemChanges(rows, new Date(T1).getTime()), 'house');
    expect(house.start_value).toBe(1_100_000);
    expect(house.current_value).toBe(0);
    expect(house.contribution).toBe(-1_100_000);
  });

  it('counts a departed DEBT as a gain, not a loss', () => {
    const items = buildItemChanges([
      row(T1, 'loan', 850_000, { item_type: 'loan', is_debt: true }),
      bank(T1, 5_000), bank(T2, 5_000),
    ]);
    const loan = find(items, 'loan');
    expect(loan.removed).toBe(true);
    expect(loan.contribution).toBe(850_000);   // debt leaving lifts net worth
  });
});

describe('toggling a property off and back on', () => {
  it('leaves no mover behind once it is off again', () => {
    // on (T1) → off (absent at T2) → on again (T3) → off again (T4): the item is
    // absent from the newest snapshot, so it is worth 0 and flagged structural.
    const T4 = t('18T09:00:00.000');
    const rows = [
      row(T1, 'house', 250_000),
      bank(T1, 5_000), bank(T2, 5_000),
      row(T3, 'house', 250_000), bank(T3, 5_000),
      bank(T4, 5_000),
    ];
    const house = find(buildItemChanges(rows, new Date(T3).getTime()), 'house');
    expect(house.removed).toBe(true);
    expect(house.current_value).toBe(0);
    // And with the window opening after it went, it moves nothing whatsoever.
    const later = find(buildItemChanges(rows, new Date(T4).getTime()), 'house');
    expect(later.contribution).toBe(0);
  });
});

describe('internal transfers', () => {
  const legs: ItemTransferLeg[] = [{ key: 'bank:acct', createdMs: new Date(T3).getTime() - 1, inflowPref: 1_000 }];

  it('are stripped out of a live account, so moving money is not a gain', () => {
    const items = buildItemChanges([bank(T2, 5_000), bank(T3, 6_000)], new Date(T2).getTime(), legs);
    expect(find(items, 'acct').contribution).toBe(0);
  });

  it('are left out of a removed account, whose drop to 0 is structural', () => {
    const rows = [
      bank(T2, 5_000), bank(T3, 6_000),
      row(T3, 'house', 1_000), row(t('18T10:00:00.000'), 'house', 1_000),
    ];
    const acct = find(buildItemChanges(rows, new Date(T2).getTime(), legs), 'acct');
    expect(acct.removed).toBe(true);
    expect(acct.contribution).toBe(-5_000);   // the whole balance left, not −4,000
  });
});

describe('the movers list as a whole', () => {
  it('is sorted by the size of the effect on net worth', () => {
    const items = buildItemChanges([
      bank(T2, 5_000), bank(T3, 5_500),
      row(T2, 'house', 1_000_000), row(T3, 'house', 900_000),
      row(T2, 'loan', 8_000, { item_type: 'loan', is_debt: true }),
      row(T3, 'loan', 7_000, { item_type: 'loan', is_debt: true }),
    ], new Date(T2).getTime());
    expect(items.map(i => i.item_id)).toEqual(['house', 'loan', 'acct']);
  });

  it('is empty, not broken, with no history at all', () => {
    expect(buildItemChanges([])).toEqual([]);
  });
});

/**
 * The daily window, where a holding's day is split into the part that belongs to
 * the holding and the part that belongs to the exchange rate.
 *
 * The invariant this file exists to hold: THE ROWS SUM TO THE HEADLINE. The
 * headline change is live-minus-recorded over the same series these rows are
 * built from, so the split must be closed — price read the way the Investments
 * page reads it, and the currency row defined as the remainder of the recorded
 * movement, never re-derived from a live FX quote (a third ruler, measuring a
 * different window, which is how the popup once sat $185 from the headline with
 * every number individually "correct").
 */
describe('a foreign holding on a day the rate moved', () => {
  // 10,000 USD of stock at 1.50 AUD/USD = 15,000 AUD now. The price is up 2% since
  // the previous close; at the window start the series had it recorded at 14,700
  // AUD (yesterday's price at yesterday's rate).
  const RATE = 1.5, PRICE_PCT = 2, HIST_START = 14_700;
  const nativeNow = 10_000, valuePref = nativeNow * RATE;
  const prevPref = valuePref / (1 + PRICE_PCT / 100); // prev close at TODAY's rate

  const stock = (o: Partial<ItemChange> = {}): ItemChange => ({
    item_type: 'investment', item_id: 'spy', name: 'SPY', is_debt: false,
    start_value: HIST_START, current_value: 0, change: 0, contribution: 0, removed: false, ...o,
  });
  const live = [{ id: 'spy', valuePref, nativeCurrency: 'USD', dayChangePercent: PRICE_PCT }];

  it('sums to the recorded movement the headline is made of', () => {
    const out = applyDailyMoves([stock()], live, 'AUD');
    const total = out.reduce((sum, i) => sum + i.contribution, 0);
    // Whatever the split says, together the rows are live − recorded-at-start:
    // the exact quantity the headline reports. No approximation.
    expect(total).toBeCloseTo(valuePref - HIST_START, 2);
  });

  it('reports the holding exactly as the Investments page does — price only', () => {
    const price = applyDailyMoves([stock()], live, 'AUD').find(i => i.item_id === 'spy')!;
    expect(price.contribution).toBeCloseTo(valuePref - prevPref, 2);
    expect(price.current_value).toBeCloseTo(valuePref, 2);
  });

  it('names the remainder as the currency move', () => {
    const rate = applyDailyMoves([stock()], live, 'AUD').find(i => i.item_type === 'currency')!;
    expect(rate.name).toBe('USD → AUD exchange rate');
    expect(rate.contribution).toBeCloseTo((valuePref - HIST_START) - (valuePref - prevPref), 2);
    // The caption reads "…held in USD", so it must be the foreign sleeve's worth now.
    expect(rate.current_value).toBeCloseTo(valuePref, 2);
  });

  it('gives a holding in the home currency no currency row — and still closes', () => {
    const out = applyDailyMoves(
      [stock()],
      [{ id: 'spy', valuePref, nativeCurrency: 'AUD', dayChangePercent: PRICE_PCT }],
      'AUD',
    );
    expect(out.some(i => i.item_type === 'currency')).toBe(false);
    expect(out.reduce((sum, i) => sum + i.contribution, 0)).toBeCloseTo(valuePref - HIST_START, 2);
  });

  it('keeps the whole move on a holding with no market price', () => {
    // A dealer-priced metal has no day %, so price can't be split from rate. Its
    // row keeps its full recorded movement — nothing is lost, nothing invented.
    const out = applyDailyMoves(
      [stock({ item_id: 'bar', name: 'Gold bar' })],
      [{ id: 'bar', valuePref, nativeCurrency: 'USD', dayChangePercent: null }],
      'AUD',
    );
    expect(out.find(i => i.item_id === 'bar')!.contribution).toBeCloseTo(valuePref - HIST_START, 2);
    expect(out.some(i => i.item_type === 'currency')).toBe(false);
  });

  it('leaves a removed holding alone', () => {
    // Its recorded story ended; there is no live value to decompose against.
    const out = applyDailyMoves(
      [stock({ removed: true, current_value: 0, change: -HIST_START, contribution: -HIST_START })],
      live, 'AUD',
    );
    expect(out.find(i => i.item_id === 'spy')!.contribution).toBe(-HIST_START);
    expect(out.some(i => i.item_type === 'currency')).toBe(false);
  });
});
