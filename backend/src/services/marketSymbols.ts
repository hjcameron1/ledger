/**
 * SYMBOLS AND EXCHANGES — the two-way map between Ledger's own market names and
 * the strings the price feed speaks.
 *
 * It lives on its own because more than one service needs it and none of them
 * should have to import a whole price refresher to spell a ticker: the quote
 * path builds a symbol from a market, the search path reads a market back out
 * of an exchange code, and the corporate-actions path needs both.
 */

export const MARKET_SUFFIX: Record<string, string> = {
  ASX: '.AX', LSE: '.L', TSX: '.TO', NSE: '.NS', HKEX: '.HK',
  XETRA: '.DE', 'Euronext Paris': '.PA', 'Euronext Amsterdam': '.AS',
  'Borsa Italiana': '.MI', SIX: '.SW', JPX: '.T',
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
export const EXCHANGE_MARKET: Record<string, string> = {
  ASX: 'ASX',
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', PCX: 'NYSE', PNK: 'NYSE', ASE: 'NYSE',
  LSE: 'LSE', LSO: 'LSE', LON: 'LSE', IOB: 'LSE',
  TOR: 'TSX', TSX: 'TSX',
  GER: 'XETRA', XETRA: 'XETRA', FRA: 'XETRA',
  PAR: 'Euronext Paris',
  AMS: 'Euronext Amsterdam',
  MIL: 'Borsa Italiana', TLO: 'Borsa Italiana',
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
export const SUFFIX_MARKET: Record<string, string> = {
  '.AX': 'ASX', '.L': 'LSE', '.TO': 'TSX', '.NS': 'NSE', '.HK': 'HKEX',
  '.DE': 'XETRA', '.PA': 'Euronext Paris', '.AS': 'Euronext Amsterdam',
  '.MI': 'Borsa Italiana', '.SW': 'SIX', '.T': 'JPX',
};
