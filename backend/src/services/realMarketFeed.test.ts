/**
 * REAL MARKET FEED — the shapes the live APIs actually return.
 *
 * Every fixture below was read off the production endpoints on 30 August 2026
 * (`query1.finance.yahoo.com/v8/finance/chart`, `query2…/v1/finance/search` and
 * `api.frankfurter.app`), not invented to suit the code. That is the whole point
 * of the file: the synthetic suites in this repo assume a price feed quotes each
 * security in a plain ISO currency, names each exchange the way Ledger's own
 * dropdown does, and reports every FX pair to the same relative precision. The
 * real feed does none of those three things, and each gap reached money.
 *
 * WHAT IT PINS, all of it observed rather than reasoned about:
 *
 *   1. London quotes in PENCE and says `GBp`. BP.L came back at 514.5 — £5.145 a
 *      share. Yahoo then resolves `GBpAUD=X` to `GBPAUD=X` and answers with the
 *      POUND rate, and Frankfurter has no `GBp` at all, so the sanity band that
 *      would have caught it had nothing to compare against. A UK holding was
 *      carried at a HUNDRED TIMES its worth, everywhere at once.
 *   2. Not every London line does it. `VUSA.L` really does come back as plain
 *      `GBP` at 108.59, so "the LSE is in pence" is not a rule the market
 *      supports — only the currency string on the individual quote is.
 *   3. Yahoo's exchange codes are `GER`, `PAR`, `AMS`, `EBS`, `HKG`, `TOR`,
 *      `NSI` — not `XETRA`, `Euronext Paris`, `SIX`, `HKEX`, `TSX`, `NSE`.
 *   4. Every FX pair is served to four decimal places in BOTH directions, which
 *      is a floor and not a guarantee: AUD/JPY at 114.634 carries six
 *      significant figures and JPY/AUD at 0.0087 carries two.
 *   5. Yahoo's historical closes and dividends are RETROACTIVELY SPLIT-ADJUSTED.
 *      Apple's 3 June 2019 close is served as 43.325; 173.30 is what printed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/supabase', () => ({
  supabase: { from: () => { throw new Error('this suite must not touch the database'); } },
}));

import { majorUnitOf, isMinorUnit, normaliseQuote } from './quoteCurrency';
import { getYahooTicker } from './priceService';
import { parseChartQuote } from './yahooChart';
import { investmentValueInPreferred, investmentValueNative } from './investmentValue';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ─── Captured, 30 August 2026 ────────────────────────────────────────────────

/** `meta.currency` and `meta.regularMarketPrice`, verbatim, per listing. */
const QUOTES = {
  'BHP.AX':  { currency: 'AUD', price: 67.30,   exchange: 'ASX' },
  'AAPL':    { currency: 'USD', price: 319.70,  exchange: 'NasdaqGS' },
  'BP.L':    { currency: 'GBp', price: 514.50,  exchange: 'LSE' },
  'SHEL.L':  { currency: 'GBp', price: 3344.50, exchange: 'LSE' },
  'RIO.L':   { currency: 'GBp', price: 7674.00, exchange: 'LSE' },
  'VUSA.L':  { currency: 'GBP', price: 108.59,  exchange: 'LSE' },
  'SAP.DE':  { currency: 'EUR', price: 191.32,  exchange: 'XETRA' },
  '7203.T':  { currency: 'JPY', price: 3116.00, exchange: 'Tokyo' },
  'ASML.AS': { currency: 'EUR', price: 1494.40, exchange: 'Amsterdam' },
  'MC.PA':   { currency: 'EUR', price: 458.15,  exchange: 'Paris' },
} as const;

/** `regularMarketPrice` for each FX pair, both directions, as served. */
const FX_QUOTES: Record<string, number> = {
  'GBPAUD=X': 1.8899, 'AUDGBP=X': 0.5291,
  'USDAUD=X': 1.3958, 'AUDUSD=X': 0.7164,
  'EURAUD=X': 1.6171, 'AUDEUR=X': 0.6183,
  'JPYAUD=X': 0.0087, 'AUDJPY=X': 114.634,
  'HKDAUD=X': 0.1780, 'AUDHKD=X': 5.6122,
};

/** Yahoo resolves an unknown-cased pair to the upper-cased one. Observed. */
const fxQuote = (from: string, to: string): number | undefined =>
  FX_QUOTES[`${from.toUpperCase()}${to.toUpperCase()}=X`];

/** `quotes[].exchange` from a live `search` for each listing. */
const SEARCH_EXCHANGE: Record<string, string> = {
  'CBA.AX': 'ASX', 'AAPL': 'NMS', 'BP.L': 'LSE', 'SAP.DE': 'GER',
  '7203.T': 'JPX', 'MC.PA': 'PAR', 'ASML.AS': 'AMS', 'NESN.SW': 'EBS',
  '0700.HK': 'HKG', 'RY.TO': 'TOR', 'RELIANCE.NS': 'NSI',
};

// ─── 1. The quote currency is not always a currency ─────────────────────────

describe('a price feed that quotes in pence', () => {
  it('is what the London listings really return', () => {
    expect(QUOTES['BP.L'].currency).toBe('GBp');
    expect(QUOTES['SHEL.L'].currency).toBe('GBp');
    expect(QUOTES['RIO.L'].currency).toBe('GBp');
  });

  it('is not a property of the exchange — one LSE line quotes in pounds', () => {
    // So nothing may key the fold off `.L` or off the market name. Only the
    // currency string on the individual quote can decide it.
    expect(QUOTES['VUSA.L'].exchange).toBe(QUOTES['BP.L'].exchange);
    expect(QUOTES['VUSA.L'].currency).toBe('GBP');
    expect(isMinorUnit(QUOTES['VUSA.L'].currency)).toBe(false);
    expect(isMinorUnit(QUOTES['BP.L'].currency)).toBe(true);
  });

  it('tells GBp from GBP by case, because that is the only difference', () => {
    expect(majorUnitOf('GBp')).toEqual({ currency: 'GBP', per: 100 });
    expect(majorUnitOf('GBP')).toEqual({ currency: 'GBP', per: 1 });
    // A case-insensitive table here would value every British holding at 1%.
    expect(majorUnitOf('gbp').per).toBe(1);
  });

  it('restates a pence quote in pounds without rounding it', () => {
    const { price, currency } = normaliseQuote(QUOTES['BP.L'].price, QUOTES['BP.L'].currency);
    expect(currency).toBe('GBP');
    expect(price).toBeCloseTo(5.145, 6);
    // Two decimal places of a real quote survive the fold.
    expect(normaliseQuote(3344.5, 'GBp').price).toBeCloseTo(33.445, 6);
  });

  it('leaves every ISO quote exactly as it found it', () => {
    for (const [sym, q] of Object.entries(QUOTES)) {
      if (q.currency === 'GBp') continue;
      const out = normaliseQuote(q.price, q.currency);
      expect(out.price, sym).toBe(q.price);
      expect(out.currency, sym).toBe(q.currency);
    }
  });

  it('parses a real London chart body and reports the pence it was sent', () => {
    // The fold happens in fetchCurrentPrice, not in the parser: the parser's job
    // is to report the feed faithfully, unit included.
    const q = parseChartQuote({
      chart: { result: [{
        meta: { regularMarketPrice: 514.5, currency: 'GBp', regularMarketTime: 1_787_000_000 },
        indicators: { quote: [{ close: [549.5, 514.5] }] },
      }] },
    })!;
    expect(q.currency).toBe('GBp');
    expect(q.price).toBe(514.5);
    // A percentage is unit-free — pence and pounds give the same day change.
    expect(q.dayChangePercent).toBeCloseTo(-6.37, 2);
  });
});

describe('what a pence quote was worth before the fold', () => {
  // 2,000 BP shares. £5.145 × 2,000 = £10,290, and at 1.8899 AUD to the pound
  // that is A$19,447.
  const SHARES = 2_000;
  const GBP_AUD = FX_QUOTES['GBPAUD=X'];
  const TRUE_AUD = r2(SHARES * (514.5 / 100) * GBP_AUD);

  it('has a true worth of about nineteen thousand dollars', () => {
    expect(TRUE_AUD).toBeCloseTo(19_447.07, 2);
  });

  it('was carried at a hundred times that, because GBpAUD=X is GBPAUD=X', () => {
    // Yahoo resolves the pair regardless of case, so the old path asked for a
    // pence rate and was handed the pound rate — with no error to notice.
    expect(fxQuote('GBp', 'AUD')).toBe(GBP_AUD);
    const asItWas = r2(SHARES * 514.5 * GBP_AUD);
    expect(asItWas).toBeCloseTo(1_944_707.10, 2);
    expect(asItWas / TRUE_AUD).toBeCloseTo(100, 4);
  });

  it('is right now, from the row the refresh writes', async () => {
    // Exactly what updateAllInvestmentPrices stores after the fold: the price in
    // pounds, the currency ISO, and a pin taken for a pair that exists.
    const { price, currency } = normaliseQuote(QUOTES['BP.L'].price, QUOTES['BP.L'].currency);
    const row = {
      asset_type: 'stock', shares_owned: SHARES, current_price: price,
      native_currency: currency, conversion_rate: GBP_AUD, display_currency: 'AUD',
    };
    expect(investmentValueNative(row)).toBeCloseTo(10_290, 6);
    expect(await investmentValueInPreferred(row, 'AUD')).toBe(TRUE_AUD);
  });

  it('is right for a row written BEFORE the fold existed, with no migration', async () => {
    // A holding refreshed last week still carries a pence price and `GBp`. The
    // rate layer knows the same table, so it converts at the pound rate over a
    // hundred and the stored row reads correctly as it stands.
    const legacyRate = fxQuote('GBp', 'AUD')! / majorUnitOf('GBp').per;
    const legacy = {
      asset_type: 'stock', shares_owned: SHARES, current_price: 514.5,
      native_currency: 'GBp', conversion_rate: legacyRate, display_currency: 'AUD',
    };
    expect(await investmentValueInPreferred(legacy, 'AUD')).toBe(TRUE_AUD);
  });

  it('pays a dividend in pence too', () => {
    // BP's 13 August 2026 dividend, as the feed serves it: 6.3986144 — pence.
    const perShare = normaliseQuote(6.3986144, 'GBp').price;
    expect(perShare).toBeCloseTo(0.06398614, 8);
    const grossAud = r2(perShare * SHARES * GBP_AUD);
    expect(grossAud).toBeCloseTo(241.85, 2);
    // Unfolded it would have been booked as $24,185 of income for the year —
    // a hundred times over, to within the cent each side is rounded to.
    expect(r2(6.3986144 * SHARES * GBP_AUD)).toBeCloseTo(24_185.48, 2);
  });
});

// ─── 2. FX precision is a property of the direction ─────────────────────────

describe('the direction an FX pair is quoted in', () => {
  it('gives the yen two significant figures one way and six the other', () => {
    expect(FX_QUOTES['JPYAUD=X']).toBe(0.0087);
    expect(FX_QUOTES['AUDJPY=X']).toBe(114.634);
    const fromInverse = 1 / FX_QUOTES['AUDJPY=X'];
    expect(fromInverse).toBeCloseTo(0.00872342, 8);
  });

  it('costs a Japanese holding a quarter of a percent', () => {
    // ¥100,000,000 — a large but ordinary Tokyo position.
    const yen = 100_000_000;
    const naive = r2(yen * FX_QUOTES['JPYAUD=X']);
    const honest = r2(yen / FX_QUOTES['AUDJPY=X']);
    expect(honest - naive).toBeGreaterThan(2_000);
    expect((honest - naive) / honest).toBeGreaterThan(0.0025);
  });

  it('makes the holding jump in steps as the real rate drifts', () => {
    // The sub-unity quote can only take values 0.0001 apart, so a Tokyo holding
    // restates by 1.1% at a time on days the market did nothing.
    const step = (audJpy: number) => Math.round((1 / audJpy) * 10_000) / 10_000;
    expect(step(114.9)).toBe(0.0087);
    expect(step(113.5)).toBe(0.0088);
    expect(0.0088 / 0.0087 - 1).toBeGreaterThan(0.011);
  });

  it('is not a problem for pairs the market quotes near parity', () => {
    // USD, GBP and EUR all quote above 1 against the AUD in the direction that
    // matters, so nothing changes for them beyond the sixth decimal.
    for (const [pair, inverse] of [['USDAUD=X', 'AUDUSD=X'], ['GBPAUD=X', 'AUDGBP=X'], ['EURAUD=X', 'AUDEUR=X']] as const) {
      expect(FX_QUOTES[pair]).toBeGreaterThan(1);
      expect(Math.abs(FX_QUOTES[pair] - 1 / FX_QUOTES[inverse]) / FX_QUOTES[pair]).toBeLessThan(0.0005);
    }
  });

  it('is worth taking the inverse for the Hong Kong dollar as well', () => {
    expect(FX_QUOTES['HKDAUD=X']).toBeLessThan(1);
    const gap = Math.abs(1 / FX_QUOTES['AUDHKD=X'] - FX_QUOTES['HKDAUD=X']);
    expect(gap).toBeGreaterThan(0);
  });

  it('only pays for the second request where the digits are actually missing', () => {
    // The rate layer flips a quote below 0.5 and takes anything above it as
    // served. Applied to the real quotes: only the yen and the Hong Kong dollar
    // cost an extra round trip, and what is accepted directly is granular to
    // better than 0.02% — inside the spread, under the cent a holding rounds to.
    const FLOOR = 0.5;
    const flipped = Object.entries(FX_QUOTES)
      .filter(([, v]) => v < FLOOR).map(([k]) => k).sort();
    expect(flipped).toEqual(['HKDAUD=X', 'JPYAUD=X']);
    for (const [pair, v] of Object.entries(FX_QUOTES)) {
      if (v < FLOOR) continue;
      expect(0.0001 / v, pair).toBeLessThan(0.0002);
    }
  });
});

// ─── 3. Ledger's market names vs the feed's exchange codes ──────────────────

describe('naming an exchange', () => {
  /** The Add-holding dropdown, verbatim from pages/Investments.tsx. */
  const LEDGER_MARKETS = [
    'ASX', 'NYSE', 'NASDAQ', 'LSE', 'TSX', 'XETRA', 'Euronext Paris',
    'Euronext Amsterdam', 'SIX', 'JPX', 'HKEX', 'NSE',
  ];

  it('builds a symbol the feed answers to, for every market Ledger offers', () => {
    // Each of these was confirmed to return a price from the live chart endpoint.
    const cases: [string, string, string][] = [
      ['CBA', 'ASX', 'CBA.AX'], ['AAPL', 'NASDAQ', 'AAPL'], ['JPM', 'NYSE', 'JPM'],
      ['BP', 'LSE', 'BP.L'], ['RY', 'TSX', 'RY.TO'], ['SAP', 'XETRA', 'SAP.DE'],
      ['MC', 'Euronext Paris', 'MC.PA'], ['ASML', 'Euronext Amsterdam', 'ASML.AS'],
      ['NESN', 'SIX', 'NESN.SW'], ['7203', 'JPX', '7203.T'],
      ['0700', 'HKEX', '0700.HK'], ['RELIANCE', 'NSE', 'RELIANCE.NS'],
    ];
    expect(cases.map(c => c[1]).sort()).toEqual([...LEDGER_MARKETS].sort());
    for (const [ticker, market, symbol] of cases) {
      expect(getYahooTicker(ticker, market), market).toBe(symbol);
    }
  });

  it('does not double a suffix the user already typed', () => {
    expect(getYahooTicker('CBA.AX', 'ASX')).toBe('CBA.AX');
    expect(getYahooTicker('7203.T', 'JPX')).toBe('7203.T');
  });

  it('reads back every code the search endpoint really returns', async () => {
    // The bug: `exchange || 'Other'` compared Yahoo's code against Ledger's
    // market name, and the strict market filter then discarded everything. Seven
    // of the twelve markets could not return a single search result.
    const { searchTicker } = await import('./priceService');
    const RAW = Object.entries(SEARCH_EXCHANGE).map(([symbol, exchange]) => ({
      symbol, exchange, quoteType: 'EQUITY', longname: symbol,
    }));
    const yahoo = await import('yahoo-finance2');
    const YF = ((yahoo as unknown as { default?: unknown }).default ?? yahoo) as new () => unknown;
    vi.spyOn(YF.prototype as object, 'search' as never)
      .mockResolvedValue({ quotes: RAW } as never);

    const expected: Record<string, string> = {
      'CBA.AX': 'ASX', 'AAPL': 'NASDAQ', 'BP.L': 'LSE', 'SAP.DE': 'XETRA',
      '7203.T': 'JPX', 'MC.PA': 'Euronext Paris', 'ASML.AS': 'Euronext Amsterdam',
      'NESN.SW': 'SIX', '0700.HK': 'HKEX', 'RY.TO': 'TSX', 'RELIANCE.NS': 'NSE',
    };
    const all = await searchTicker('anything');
    for (const r of all) expect(r.market, r.symbol).toBe(expected[r.symbol]);

    // And the market filter now finds its own listing instead of an empty list.
    for (const [symbol, market] of Object.entries(expected)) {
      const hits = await searchTicker('anything', market);
      expect(hits.map(h => h.symbol), market).toContain(symbol);
    }
    vi.restoreAllMocks();
  });
});

// ─── 4. Historical series are restated by corporate actions ─────────────────

describe('a price history that a split rewrites', () => {
  // Real Apple closes, as Yahoo serves them today. The 4:1 split was 31 Aug 2020.
  const AAPL_ADJUSTED: Record<string, number> = {
    '2019-06-03': 43.325001, '2020-08-28': 124.807503, '2020-09-01': 134.179993,
  };
  // Real Toyota closes across its 5:1 split of 29 Sep 2021.
  const TOYOTA_ADJUSTED: Record<string, number> = {
    '2021-09-28': 2077.0, '2021-09-30': 2000.0,
  };

  it('serves a pre-split close divided by the ratio, not the price that printed', () => {
    // Apple closed at $173.30 on 3 June 2019 and at $499.23 on 28 August 2020.
    expect(AAPL_ADJUSTED['2019-06-03'] * 4).toBeCloseTo(173.30, 2);
    expect(AAPL_ADJUSTED['2020-08-28'] * 4).toBeCloseTo(499.23, 2);
    // After the split the two agree, because there is nothing left to adjust.
    expect(AAPL_ADJUSTED['2020-09-01']).toBeCloseTo(134.18, 2);
  });

  it('keeps the day change honest across the split, because both bars move', () => {
    // The pair the day change is defined on is adjusted together, so split day
    // reads as the +3.4% it was and not as a 75% collapse.
    const q = parseChartQuote({
      chart: { result: [{
        meta: { regularMarketPrice: 129.04, currency: 'USD', regularMarketTime: 1_598_918_400 },
        indicators: { quote: [{ close: [AAPL_ADJUSTED['2020-08-28'], 129.04] }] },
      }] },
    })!;
    expect(q.dayChangePercent!).toBeGreaterThan(0);
    expect(q.dayChangePercent!).toBeCloseTo(3.39, 1);
  });

  it('drops a holding by three quarters when its units are not restated', () => {
    // Ledger prices a holding as units × price and takes its unit count from the
    // user. Nothing ingests a corporate action, so on 31 August 2020 the price
    // rebased and the unit count did not: 400 shares went from $199,692 to
    // $51,616 with no sale and no market move. Ledger's answer is the edit
    // dialog — units × 4, cost untouched — which dataService reads as a split.
    const before = 400 * (AAPL_ADJUSTED['2020-08-28'] * 4);
    const afterNoAction = 400 * 129.04;
    expect(afterNoAction / before).toBeCloseTo(0.2586, 3);
    const afterRestated = 400 * 4 * 129.04;
    expect(afterRestated / before).toBeCloseTo(1.0344, 3);
  });

  it('restates dividends the same way, which is the quieter half of it', () => {
    // Apple's February 2016 dividend was 52 cents a share. The feed serves 0.13.
    expect(0.13 * 4).toBeCloseTo(0.52, 2);
    // Toyota's March 2016 dividend was ¥110; the feed serves 22.
    expect(22 * 5).toBe(110);
    // It is self-cancelling ONLY while the unit count is post-split as well:
    // adjusted-per-share × restated-units is the same money as declared × old.
    expect(0.13 * (400 * 4)).toBeCloseTo(0.52 * 400, 6);
    // Which is exactly why an un-restated unit count is wrong twice over.
    expect(0.13 * 400).toBeCloseTo(0.52 * 400 / 4, 6);
  });

  it('leaves Toyota within a whisker of its ratio either side of the split', () => {
    expect((TOYOTA_ADJUSTED['2021-09-28'] * 5) / TOYOTA_ADJUSTED['2021-09-28']).toBe(5);
    // ¥10,385 on the 28th, ¥2,000 on the 30th — a real 5:1, not a 79% loss.
    expect(TOYOTA_ADJUSTED['2021-09-28'] * 5).toBeCloseTo(10_385, 0);
  });
});

// ─── 5. Sessions, as the exchanges actually keep them ───────────────────────

describe('when each market is open', () => {
  it('gates every market Ledger offers, and nothing else', async () => {
    const { isHoursGated } = await import('./marketCalendar');
    for (const m of ['ASX', 'NYSE', 'NASDAQ', 'LSE', 'TSX', 'XETRA', 'Euronext Paris',
                     'Euronext Amsterdam', 'SIX', 'JPX', 'HKEX', 'NSE']) {
      expect(isHoursGated(m), m).toBe(true);
    }
    // Crypto trades through the weekend, and the unpriced types have no session
    // to be inside — none of them may ever be frozen.
    for (const m of ['Crypto', 'Managed Fund', 'Physical Precious Metals',
                     'Private Investment', 'Other']) {
      expect(isHoursGated(m), m).toBe(false);
    }
  });

  it('keeps Tokyo open to 15:30, where the TSE moved it in November 2024', async () => {
    const { isMarketOpen } = await import('./marketCalendar');
    // Thursday 6 August 2026, in Japan Standard Time (UTC+9, no DST).
    const jst = (h: number, m: number) => new Date(Date.UTC(2026, 7, 6, h - 9, m));
    expect(isMarketOpen('JPX', jst(9, 30))).toBe(true);
    // 15:00–15:30 is real trading, and the closing auction that strikes the
    // day's official price sits inside it.
    expect(isMarketOpen('JPX', jst(15, 10))).toBe(true);
    expect(isMarketOpen('JPX', jst(15, 29))).toBe(true);
    expect(isMarketOpen('JPX', jst(15, 31))).toBe(false);
    expect(isMarketOpen('JPX', jst(8, 59))).toBe(false);
  });

  it('knows the ASX and the LSE keep different hours in their own time zones', async () => {
    const { isMarketOpen } = await import('./marketCalendar');
    // 11:00 Sydney on a Wednesday is a session; 11:00 London on the same clock
    // is the middle of the Australian night.
    const syd = new Date('2026-08-05T01:00:00Z');  // 11:00 AEST
    expect(isMarketOpen('ASX', syd)).toBe(true);
    expect(isMarketOpen('LSE', syd)).toBe(false);
    const lon = new Date('2026-08-05T10:00:00Z');  // 11:00 BST
    expect(isMarketOpen('LSE', lon)).toBe(true);
    expect(isMarketOpen('ASX', lon)).toBe(false);
  });

  it('shuts every market at the weekend', async () => {
    const { isMarketOpen } = await import('./marketCalendar');
    const sunday = new Date('2026-08-09T04:00:00Z');
    for (const m of ['ASX', 'NASDAQ', 'LSE', 'XETRA', 'JPX', 'HKEX']) {
      expect(isMarketOpen(m, sunday), m).toBe(false);
    }
  });
});
