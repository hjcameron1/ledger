/**
 * Market-hours + holiday calendar.
 *
 * Determines whether a given exchange is currently open so prices (and the FX
 * rate snapshot) only refresh during that market's trading session and freeze
 * when it closes. Holidays are computed from *rules* (not a static list), so the
 * calendar rolls forward automatically every year with no manual upkeep.
 *
 * Half-days (e.g. the US day after Thanksgiving, Christmas Eve) are treated as
 * normal full sessions — close enough for a refresh schedule; the holiday days
 * themselves are fully observed.
 */

type MarketKey = 'US' | 'ASX' | 'LSE' | 'TSX';

interface MarketConfig {
  tz: string;
  open: number;   // minutes from local midnight
  close: number;  // minutes from local midnight
  holidays: (year: number) => Set<string>; // 'YYYY-MM-DD' local dates
}

// Map the app's `market` field onto a calendar key. Anything not listed here is
// not hours-gated (crypto 24/7, managed funds, metals, private, other).
const MARKET_ALIASES: Record<string, MarketKey> = {
  NYSE: 'US', NASDAQ: 'US',
  ASX: 'ASX',
  LSE: 'LSE',
  TSX: 'TSX',
};

const hm = (h: number, m: number) => h * 60 + m;

// ── Date helpers (pure calendar math in UTC, no tz involved) ──────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Day-of-month of the Nth given weekday (0=Sun) in month m (1-12). */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) break;
    if (dt.getUTCDay() === weekday && ++count === n) return d;
  }
  return -1;
}

/** Day-of-month of the last given weekday in month m. */
function lastWeekday(y: number, m: number, weekday: number): number {
  let last = -1;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) break;
    if (dt.getUTCDay() === weekday) last = d;
  }
  return last;
}

/** Easter Sunday (Gregorian / Anonymous algorithm) → {m, d}. */
function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mth + 114) / 31);
  const day = ((h + l - 7 * mth + 114) % 31) + 1;
  return { m: month, d: day };
}

/** Shift a date by n days, returning {y,m,d}. */
function shift(y: number, m: number, d: number, n: number) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** US "nearest weekday" observance: Sat→Fri before, Sun→Mon after. */
function observedNearest(y: number, m: number, d: number): string {
  const wd = dow(y, m, d);
  if (wd === 6) { const s = shift(y, m, d, -1); return ymd(s.y, s.m, s.d); }
  if (wd === 0) { const s = shift(y, m, d, 1); return ymd(s.y, s.m, s.d); }
  return ymd(y, m, d);
}

/** UK/AU/CA "next Monday" substitution: weekend → following Monday. */
function observedNextMonday(y: number, m: number, d: number): string {
  const wd = dow(y, m, d);
  if (wd === 6) { const s = shift(y, m, d, 2); return ymd(s.y, s.m, s.d); }
  if (wd === 0) { const s = shift(y, m, d, 1); return ymd(s.y, s.m, s.d); }
  return ymd(y, m, d);
}

// ── Per-market holiday sets (cached by market+year) ───────────────────────────

const holidayCache = new Map<string, Set<string>>();

function usHolidays(y: number): Set<string> {
  const s = new Set<string>();
  const e = easter(y);
  const goodFri = shift(y, e.m, e.d, -2);
  s.add(observedNearest(y, 1, 1));                              // New Year's
  s.add(ymd(y, 1, nthWeekday(y, 1, 1, 3)));                     // MLK (3rd Mon Jan)
  s.add(ymd(y, 2, nthWeekday(y, 2, 1, 3)));                     // Washington (3rd Mon Feb)
  s.add(ymd(goodFri.y, goodFri.m, goodFri.d));                  // Good Friday
  s.add(ymd(y, 5, lastWeekday(y, 5, 1)));                       // Memorial (last Mon May)
  if (y >= 2022) s.add(observedNearest(y, 6, 19));              // Juneteenth
  s.add(observedNearest(y, 7, 4));                              // Independence
  s.add(ymd(y, 9, nthWeekday(y, 9, 1, 1)));                     // Labor (1st Mon Sep)
  s.add(ymd(y, 11, nthWeekday(y, 11, 4, 4)));                   // Thanksgiving (4th Thu Nov)
  s.add(observedNearest(y, 12, 25));                            // Christmas
  return s;
}

function asxHolidays(y: number): Set<string> {
  const s = new Set<string>();
  const e = easter(y);
  const goodFri = shift(y, e.m, e.d, -2);
  const easterMon = shift(y, e.m, e.d, 1);
  s.add(observedNextMonday(y, 1, 1));                           // New Year's
  s.add(observedNextMonday(y, 1, 26));                          // Australia Day
  s.add(ymd(goodFri.y, goodFri.m, goodFri.d));                 // Good Friday
  s.add(ymd(easterMon.y, easterMon.m, easterMon.d));           // Easter Monday
  s.add(ymd(y, 4, 25));                                         // Anzac Day
  s.add(ymd(y, 6, nthWeekday(y, 6, 1, 2)));                     // King's Birthday (2nd Mon Jun)
  s.add(observedNextMonday(y, 12, 25));                         // Christmas
  s.add(observedNextMonday(y, 12, 26));                         // Boxing Day
  return s;
}

function lseHolidays(y: number): Set<string> {
  const s = new Set<string>();
  const e = easter(y);
  const goodFri = shift(y, e.m, e.d, -2);
  const easterMon = shift(y, e.m, e.d, 1);
  s.add(observedNextMonday(y, 1, 1));                           // New Year's
  s.add(ymd(goodFri.y, goodFri.m, goodFri.d));                 // Good Friday
  s.add(ymd(easterMon.y, easterMon.m, easterMon.d));           // Easter Monday
  s.add(ymd(y, 5, nthWeekday(y, 5, 1, 1)));                     // Early May bank holiday
  s.add(ymd(y, 5, lastWeekday(y, 5, 1)));                       // Spring bank holiday
  s.add(ymd(y, 8, lastWeekday(y, 8, 1)));                       // Summer bank holiday
  s.add(observedNextMonday(y, 12, 25));                         // Christmas
  s.add(observedNextMonday(y, 12, 26));                         // Boxing Day
  return s;
}

function tsxHolidays(y: number): Set<string> {
  const s = new Set<string>();
  const e = easter(y);
  const goodFri = shift(y, e.m, e.d, -2);
  s.add(observedNextMonday(y, 1, 1));                           // New Year's
  s.add(ymd(y, 2, nthWeekday(y, 2, 1, 3)));                     // Family Day (3rd Mon Feb)
  s.add(ymd(goodFri.y, goodFri.m, goodFri.d));                 // Good Friday
  // Victoria Day: Monday before May 25
  let vic = 25; while (dow(y, 5, vic) !== 1) vic--;
  s.add(ymd(y, 5, vic));
  s.add(observedNextMonday(y, 7, 1));                           // Canada Day
  s.add(ymd(y, 8, nthWeekday(y, 8, 1, 1)));                     // Civic Holiday (1st Mon Aug)
  s.add(ymd(y, 9, nthWeekday(y, 9, 1, 1)));                     // Labour Day (1st Mon Sep)
  s.add(ymd(y, 10, nthWeekday(y, 10, 1, 2)));                   // Thanksgiving (2nd Mon Oct)
  s.add(observedNextMonday(y, 12, 25));                         // Christmas
  s.add(observedNextMonday(y, 12, 26));                         // Boxing Day
  return s;
}

const MARKETS: Record<MarketKey, MarketConfig> = {
  US:  { tz: 'America/New_York', open: hm(9, 30), close: hm(16, 0),  holidays: usHolidays },
  ASX: { tz: 'Australia/Sydney', open: hm(10, 0), close: hm(16, 0),  holidays: asxHolidays },
  LSE: { tz: 'Europe/London',    open: hm(8, 0),  close: hm(16, 30), holidays: lseHolidays },
  TSX: { tz: 'America/Toronto',  open: hm(9, 30), close: hm(16, 0),  holidays: tsxHolidays },
};

function holidaysFor(key: MarketKey, year: number): Set<string> {
  const cacheKey = `${key}-${year}`;
  let set = holidayCache.get(cacheKey);
  if (!set) { set = MARKETS[key].holidays(year); holidayCache.set(cacheKey, set); }
  return set;
}

// ── Timezone helpers ──────────────────────────────────────────────────────────

interface LocalParts { year: number; month: number; day: number; weekday: number; minutes: number; dateStr: string; }

function localParts(tz: string, at: Date): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const get = (t: string) => fmt.formatToParts(at).find(p => p.type === t)?.value ?? '';
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const year = +get('year'), month = +get('month'), day = +get('day');
  const hour = get('hour') === '24' ? 0 : +get('hour');
  return {
    year, month, day, weekday: wd[get('weekday')],
    minutes: hour * 60 + +get('minute'),
    dateStr: ymd(year, month, day),
  };
}

/** UTC instant for a given wall-clock time in tz (handles DST via offset probe). */
function zonedToUtc(tz: string, y: number, m: number, d: number, minutes: number): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Measure tz offset at the guessed instant and correct for it.
  const probe = new Date(guess);
  const lp = localParts(tz, probe);
  const localAsUtc = Date.UTC(lp.year, lp.month - 1, lp.day, Math.floor(lp.minutes / 60), lp.minutes % 60);
  const offset = localAsUtc - guess;
  return new Date(guess - offset);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @returns true/false if the market is hours-gated, or null if the market has
 *   no trading session to gate on (crypto, managed funds, metals, etc.).
 */
export function isMarketOpen(market: string, at: Date = new Date()): boolean | null {
  const key = MARKET_ALIASES[market];
  if (!key) return null;
  const cfg = MARKETS[key];
  const lp = localParts(cfg.tz, at);
  if (lp.weekday === 0 || lp.weekday === 6) return false;
  if (holidaysFor(key, lp.year).has(lp.dateStr)) return false;
  return lp.minutes >= cfg.open && lp.minutes < cfg.close;
}

/** Next UTC instant the market opens (scans up to ~14 days ahead). */
export function nextMarketOpen(market: string, from: Date = new Date()): Date | null {
  const key = MARKET_ALIASES[market];
  if (!key) return null;
  const cfg = MARKETS[key];
  for (let i = 0; i <= 14; i++) {
    const probe = new Date(from.getTime() + i * 86_400_000);
    const lp = localParts(cfg.tz, probe);
    const isHoliday = holidaysFor(key, lp.year).has(lp.dateStr);
    const isWeekend = lp.weekday === 0 || lp.weekday === 6;
    if (isHoliday || isWeekend) continue;
    const openInstant = zonedToUtc(cfg.tz, lp.year, lp.month, lp.day, cfg.open);
    if (openInstant.getTime() > from.getTime()) return openInstant;
  }
  return null;
}

/** True if this market is one we gate on trading hours. */
export function isHoursGated(market: string): boolean {
  return !!MARKET_ALIASES[market];
}
