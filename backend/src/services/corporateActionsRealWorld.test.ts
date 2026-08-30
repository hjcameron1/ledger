/**
 * CORPORATE ACTIONS UNDER REAL EVENTS — a stress test, not a unit test.
 *
 * Every event in this file was read off Yahoo's v8 chart API on 30 August 2026,
 * for 62 companies on the ASX, NASDAQ, the NYSE, the LSE, XETRA, Euronext Paris
 * and Amsterdam, SIX, Borsa Italiana and the Tokyo Stock Exchange, quoted in
 * AUD, USD, GBp, EUR, CHF and JPY. 143 events in total: ordinary splits, reverse
 * splits, bonus issues, spin-offs, demergers, capital returns, rights issues and
 * one instalment-receipt conversion — all served in ONE field, with ONE shape.
 *
 * That is the finding this file exists to hold on to. A Yahoo split event is:
 *
 *     { date, numerator, denominator, splitRatio }
 *
 * and nothing else. General Electric's genuine 1-for-8 consolidation of
 * 2 August 2021 and its GE Vernova spin-off factor of 2 April 2024 arrive in the
 * same field, with the same keys, differing only in the two numbers. There is no
 * type, no flag and no description. So Ledger cannot ask the feed what kind of
 * event it is; it can only look at the shape of the ratio and guess — which is
 * what `isShareSplit` does, and this file measures how often that guess is
 * right against events whose real-world outcome is known.
 *
 * WHERE THE TRUTH IN `TRUTH` COMES FROM. Two independent readings, both drawn
 * from the captured payloads rather than asserted:
 *
 *   • THE DIVIDEND SERIES. Yahoo back-adjusts dividends through splits exactly
 *     as it back-adjusts prices. Undo that adjustment and you get the amount the
 *     company actually declared — and a share consolidation raises declared
 *     dividend-per-share by 1/ratio, while a spin-off does not. GE's declared
 *     dividend is a flat $0.08 straight through both spin-off factors; AT&T's
 *     falls from $0.688 to $0.278 across the Warner Bros. Discovery separation;
 *     3M's from $1.51 to $0.70 across Solventum. Those three are price factors,
 *     confirmed by the feed's own numbers. GSK's declared dividend steps from
 *     14.00p to 16.25p across its 4:5 — a rise of a sixth where a consolidation
 *     predicts a quarter and Haleon's earnings had just left — and ASML's from
 *     €0.46 to €0.53 across its 77:100. Those two are real consolidations.
 *
 *   • THE PRICE SERIES, UNADJUSTED. Multiplying each close by the cumulative
 *     ratio of the splits that came after it recovers what the share actually
 *     traded at. Vodafone closed at 134.50p on 21 February 2014 and at 252.30p
 *     on the 24th; Apple at $499.23 on 28 August 2020 and at $129.04 on the 31st.
 *
 * WHAT IS ASSERTED HERE. Two different things, kept apart on purpose:
 *
 *   1. THE INVARIANTS, which must hold for every event Ledger acts on, and are
 *      asserted as requirements: units move and cost never does, the holding's
 *      worth does not change across the write, a split is applied exactly once
 *      however many times it is seen, and the parcel dates that decide the CGT
 *      discount are untouched.
 *
 *   2. THE CLASSIFICATION, which is asserted as CURRENT BEHAVIOUR — including
 *      where that behaviour is wrong. Each of those carries a `DEFECT` comment
 *      naming what should happen instead. They are written this way deliberately:
 *      the day somebody fixes the rule, these tests fail, and the failure is the
 *      reminder to come back and restate the expectation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── A database, small enough to reason about ───────────────────────────────

interface InvRow {
  id: string; user_id: string; name: string; ticker: string; market: string;
  asset_type: string; shares_owned: number; cost_basis: number;
  current_price: number; split_checked_through: string | null;
  native_currency: string | null;
  pending_corporate_actions: PendingAction[] | null;
}
interface PendingAction {
  id: string; date: string; numerator: number; denominator: number;
  ratio: number; seen_at?: string;
  resolved?: 'applied' | 'ignored' | null; resolved_at?: string | null;
}
interface SplitRow {
  id: string; user_id: string; investment_id: string; label: string;
  ticker: string | null; ratio: number; recorded_at: string | null;
}

const db = {
  investments: [] as InvRow[],
  cgt_splits: [] as SplitRow[],
  splitColumn: true,
  bookTable: true,
  reviewColumn: true,
  writes: 0,
};

const UNKNOWN_COLUMN = { code: '42703', message: 'column investments.split_checked_through does not exist' };
const UNKNOWN_REVIEW_COLUMN = { code: '42703', message: 'column investments.pending_corporate_actions does not exist' };
const MISSING_TABLE = { code: '42P01', message: 'relation "cgt_splits" does not exist' };

function passesOr(row: Record<string, unknown>, expr: string): boolean {
  return expr.split(',').some(term => {
    const [col, op, val] = term.split('.');
    const v = row[col];
    if (op === 'is' && val === 'null') return v == null;
    if (op === 'lt') return v != null && String(v) < String(val);
    return false;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function builder(table: string): any {
  const filters: ((r: Record<string, unknown>) => boolean)[] = [];
  let mode: 'select' | 'update' | 'upsert' = 'select';
  let touchesReview = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any = null;

  const rows = (): Record<string, unknown>[] =>
    (db[table as 'investments' | 'cgt_splits'] as unknown as Record<string, unknown>[])
      .filter(r => filters.every(f => f(r)));

  const run = () => {
    if (table === 'investments' && !db.splitColumn) return { data: null, error: UNKNOWN_COLUMN };
    // The review column is a SEPARATE migration: it can be missing while the
    // watermark column is present, and then split detection must carry on.
    if (table === 'investments' && !db.reviewColumn && touchesReview) {
      return { data: null, error: UNKNOWN_REVIEW_COLUMN };
    }
    if (table === 'cgt_splits' && !db.bookTable) return { data: null, error: MISSING_TABLE };
    if (mode === 'update') {
      const hit = rows();
      db.writes += hit.length;
      for (const r of hit) Object.assign(r, payload);
      return { data: hit.map(r => ({ id: r.id })), error: null };
    }
    if (mode === 'upsert') {
      db.writes += 1;
      const list = db.cgt_splits;
      const i = list.findIndex(x => x.id === payload.id);
      if (i >= 0) list[i] = { ...list[i], ...payload };
      else list.push(payload as SplitRow);
      return { data: [payload], error: null };
    }
    return { data: rows().map(r => ({ ...r })), error: null };
  };

  const api = {
    select(cols?: string) {
      if (typeof cols === 'string' && cols.includes('pending_corporate_actions')) touchesReview = true;
      return api;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(p: any) {
      mode = 'update'; payload = p;
      if (p && Object.prototype.hasOwnProperty.call(p, 'pending_corporate_actions')) touchesReview = true;
      return api;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(p: any) { mode = 'upsert'; payload = p; return api; },
    eq(col: string, val: unknown) { filters.push(r => String(r[col]) === String(val)); return api; },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals.map(String));
      filters.push(r => set.has(String(r[col])));
      return api;
    },
    or(expr: string) { filters.push(r => passesOr(r, expr)); return api; },
    // PostgREST's single-row read: the one row, or null, never an array.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    maybeSingle() {
      const r = run() as { data: unknown; error: unknown };
      if (r.error) return Promise.resolve(r);
      const rows = (r.data ?? []) as unknown[];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
  };
  return api;
}

vi.mock('../utils/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }));

const {
  isShareSplit, classifyCorporateAction, rationaliseRatio, exchangeDay,
  splitRatio, parseSplitEvents, splitRecordId, splitRecordedAt,
  isSplitEligible, syncSplits,
} = await import('./corporateActions');
const { getYahooTicker } = await import('./marketSymbols');

// ─── 143 real events, exactly as the wire served them ───────────────────────

/**
 * `at` is Yahoo's own epoch for the event. It is NOT midnight: US events are
 * stamped at the 09:30 New York open (13:30 or 14:30 UTC), London's at 08:00
 * local, Tokyo's at 00:00 UTC, and the ASX's at either 00:00 UTC or 23:00 UTC
 * the day BEFORE the event — which is the 10:00 Sydney open. That last one
 * matters and is tested below.
 */
interface Event {
  sym: string; mkt: string; ccy: string;
  at: number; n: number; d: number; as: string;
}

const CENSUS: Event[] = [
  { sym: "4519.T", mkt: "JPX", ccy: "JPY", at: 1593388800, n: 3, d: 1, as: "3:1" },
  { sym: "6098.T", mkt: "JPX", ccy: "JPY", at: 1498608000, n: 3, d: 1, as: "3:1" },
  { sym: "6501.T", mkt: "JPX", ccy: "JPY", at: 1537920000, n: 1, d: 5, as: "1:5" },
  { sym: "6501.T", mkt: "JPX", ccy: "JPY", at: 1719446400, n: 5, d: 1, as: "5:1" },
  { sym: "6758.T", mkt: "JPX", ccy: "JPY", at: 1727395200, n: 5, d: 1, as: "5:1" },
  { sym: "6861.T", mkt: "JPX", ccy: "JPY", at: 1142380800, n: 11, d: 10, as: "11:10" },
  { sym: "6861.T", mkt: "JPX", ccy: "JPY", at: 1237161600, n: 11, d: 10, as: "11:10" },
  { sym: "6861.T", mkt: "JPX", ccy: "JPY", at: 1331769600, n: 1.1, d: 1, as: "1.1:1" },
  { sym: "6861.T", mkt: "JPX", ccy: "JPY", at: 1484697600, n: 2, d: 1, as: "2:1" },
  { sym: "6861.T", mkt: "JPX", ccy: "JPY", at: 1574121600, n: 2, d: 1, as: "2:1" },
  { sym: "7203.T", mkt: "JPX", ccy: "JPY", at: 1632873600, n: 5, d: 1, as: "5:1" },
  { sym: "7974.T", mkt: "JPX", ccy: "JPY", at: 1664409600, n: 10, d: 1, as: "10:1" },
  { sym: "8035.T", mkt: "JPX", ccy: "JPY", at: 1680134400, n: 3, d: 1, as: "3:1" },
  { sym: "8306.T", mkt: "JPX", ccy: "JPY", at: 1191196800, n: 1000, d: 1, as: "1000:1" },
  { sym: "9432.T", mkt: "JPX", ccy: "JPY", at: 1231027200, n: 100, d: 1, as: "100:1" },
  { sym: "9432.T", mkt: "JPX", ccy: "JPY", at: 1435276800, n: 2, d: 1, as: "2:1" },
  { sym: "9432.T", mkt: "JPX", ccy: "JPY", at: 1577404800, n: 2, d: 1, as: "2:1" },
  { sym: "9432.T", mkt: "JPX", ccy: "JPY", at: 1687996800, n: 25, d: 1, as: "25:1" },
  { sym: "9433.T", mkt: "JPX", ccy: "JPY", at: 1348617600, n: 100, d: 1, as: "100:1" },
  { sym: "9433.T", mkt: "JPX", ccy: "JPY", at: 1364342400, n: 2, d: 1, as: "2:1" },
  { sym: "9433.T", mkt: "JPX", ccy: "JPY", at: 1427414400, n: 3, d: 1, as: "3:1" },
  { sym: "9433.T", mkt: "JPX", ccy: "JPY", at: 1743120000, n: 2, d: 1, as: "2:1" },
  { sym: "9984.T", mkt: "JPX", ccy: "JPY", at: 1135728000, n: 3, d: 1, as: "3:1" },
  { sym: "9984.T", mkt: "JPX", ccy: "JPY", at: 1561420800, n: 2, d: 1, as: "2:1" },
  { sym: "9984.T", mkt: "JPX", ccy: "JPY", at: 1766966400, n: 4, d: 1, as: "4:1" },
  { sym: "AAPL", mkt: "NASDAQ", ccy: "USD", at: 550848600, n: 2, d: 1, as: "2:1" },
  { sym: "AAPL", mkt: "NASDAQ", ccy: "USD", at: 961594200, n: 2, d: 1, as: "2:1" },
  { sym: "AAPL", mkt: "NASDAQ", ccy: "USD", at: 1109601000, n: 2, d: 1, as: "2:1" },
  { sym: "AAPL", mkt: "NASDAQ", ccy: "USD", at: 1402320600, n: 7, d: 1, as: "7:1" },
  { sym: "AAPL", mkt: "NASDAQ", ccy: "USD", at: 1598880600, n: 4, d: 1, as: "4:1" },
  { sym: "ADS.DE", mkt: "XETRA", ccy: "EUR", at: 1149577200, n: 4, d: 1, as: "4:1" },
  { sym: "ALL.AX", mkt: "ASX", ccy: "AUD", at: 959126400, n: 4, d: 1, as: "4:1" },
  { sym: "AMC", mkt: "NYSE", ccy: "USD", at: 1692883800, n: 1, d: 10, as: "1:10" },
  { sym: "AMZN", mkt: "NASDAQ", ccy: "USD", at: 896794200, n: 2, d: 1, as: "2:1" },
  { sym: "AMZN", mkt: "NASDAQ", ccy: "USD", at: 915546600, n: 3, d: 1, as: "3:1" },
  { sym: "AMZN", mkt: "NASDAQ", ccy: "USD", at: 936279000, n: 2, d: 1, as: "2:1" },
  { sym: "AMZN", mkt: "NASDAQ", ccy: "USD", at: 1654522200, n: 20, d: 1, as: "20:1" },
  { sym: "ASML.AS", mkt: "Euronext Amsterdam", ccy: "EUR", at: 955954800, n: 3, d: 1, as: "3:1" },
  { sym: "ASML.AS", mkt: "Euronext Amsterdam", ccy: "EUR", at: 1191222000, n: 8, d: 9, as: "8:9" },
  { sym: "ASML.AS", mkt: "Euronext Amsterdam", ccy: "EUR", at: 1353916800, n: 77, d: 100, as: "77:100" },
  { sym: "BHP.AX", mkt: "ASX", ccy: "AUD", at: 609120000, n: 110, d: 100, as: "110:100" },
  { sym: "BHP.AX", mkt: "ASX", ccy: "AUD", at: 800150400, n: 110, d: 100, as: "110:100" },
  { sym: "BHP.AX", mkt: "ASX", ccy: "AUD", at: 993772800, n: 2.0651, d: 1, as: "2.0651:1" },
  { sym: "BHP.AX", mkt: "ASX", ccy: "AUD", at: 1025568000, n: 1.0697, d: 1, as: "1.0697:1" },
  { sym: "BP.L", mkt: "LSE", ccy: "GBp", at: 939020400, n: 2, d: 1, as: "2:1" },
  { sym: "BRK-B", mkt: "NYSE", ccy: "USD", at: 1264084200, n: 50, d: 1, as: "50:1" },
  { sym: "CBA.AX", mkt: "ASX", ccy: "AUD", at: 749088000, n: 1, d: 1, as: "1:1" },
  { sym: "CBA.AX", mkt: "ASX", ccy: "AUD", at: 833155200, n: 0.9936, d: 1, as: "0.9936:1" },
  { sym: "CBA.AX", mkt: "ASX", ccy: "AUD", at: 919119600, n: 1, d: 1, as: "1:1" },
  { sym: "CBA.AX", mkt: "ASX", ccy: "AUD", at: 939168000, n: 1, d: 1, as: "1:1" },
  { sym: "CMG", mkt: "NYSE", ccy: "USD", at: 1719408600, n: 50, d: 1, as: "50:1" },
  { sym: "DXCM", mkt: "NASDAQ", ccy: "USD", at: 1655127000, n: 4, d: 1, as: "4:1" },
  { sym: "ENI.MI", mkt: "Borsa Italiana", ccy: "EUR", at: 992847600, n: 1, d: 2, as: "1:2" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 439223400, n: 3, d: 2, as: "3:2" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 518189400, n: 3, d: 2, as: "3:2" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 569082600, n: 2, d: 1, as: "2:1" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 773501400, n: 2, d: 1, as: "2:1" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 892042200, n: 10000, d: 6641, as: "10000:6641" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 962285400, n: 10000, d: 9607, as: "10000:9607" },
  { sym: "F", mkt: "NYSE", ccy: "USD", at: 965309400, n: 1748175, d: 1000000, as: "1748175:1000000" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 423408600, n: 2, d: 1, as: "2:1" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 549034200, n: 2, d: 1, as: "2:1" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 769095000, n: 2, d: 1, as: "2:1" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 863443800, n: 2, d: 1, as: "2:1" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 957792600, n: 3, d: 1, as: "3:1" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 1551191400, n: 104, d: 100, as: "104:100" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 1627911000, n: 1, d: 8, as: "1:8" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 1672842600, n: 1281, d: 1000, as: "1281:1000" },
  { sym: "GE", mkt: "NYSE", ccy: "USD", at: 1712064600, n: 1253, d: 1000, as: "1253:1000" },
  { sym: "GOOGL", mkt: "NASDAQ", ccy: "USD", at: 1396531800, n: 1998, d: 1000, as: "1998:1000" },
  { sym: "GOOGL", mkt: "NASDAQ", ccy: "USD", at: 1658151000, n: 20, d: 1, as: "20:1" },
  { sym: "GSK.L", mkt: "LSE", ccy: "GBp", at: 627897600, n: 2, d: 1, as: "2:1" },
  { sym: "GSK.L", mkt: "LSE", ccy: "GBp", at: 688636800, n: 2, d: 1, as: "2:1" },
  { sym: "GSK.L", mkt: "LSE", ccy: "GBp", at: 1658214000, n: 4, d: 5, as: "4:5" },
  { sym: "HSBA.L", mkt: "LSE", ccy: "GBp", at: 608540400, n: 11, d: 10, as: "11:10" },
  { sym: "HSBA.L", mkt: "LSE", ccy: "GBp", at: 639903600, n: 11, d: 10, as: "11:10" },
  { sym: "HSBA.L", mkt: "LSE", ccy: "GBp", at: 670575600, n: 1, d: 4, as: "1:4" },
  { sym: "HSBA.L", mkt: "LSE", ccy: "GBp", at: 931158000, n: 3, d: 1, as: "3:1" },
  { sym: "JNJ", mkt: "NYSE", ccy: "USD", at: 359127000, n: 3, d: 1, as: "3:1" },
  { sym: "JNJ", mkt: "NYSE", ccy: "USD", at: 610896600, n: 2, d: 1, as: "2:1" },
  { sym: "JNJ", mkt: "NYSE", ccy: "USD", at: 708183000, n: 2, d: 1, as: "2:1" },
  { sym: "JNJ", mkt: "NYSE", ccy: "USD", at: 834586200, n: 2, d: 1, as: "2:1" },
  { sym: "JNJ", mkt: "NYSE", ccy: "USD", at: 992439000, n: 2, d: 1, as: "2:1" },
  { sym: "KO", mkt: "NYSE", ccy: "USD", at: 520608600, n: 3, d: 1, as: "3:1" },
  { sym: "KO", mkt: "NYSE", ccy: "USD", at: 642691800, n: 2, d: 1, as: "2:1" },
  { sym: "KO", mkt: "NYSE", ccy: "USD", at: 705677400, n: 2, d: 1, as: "2:1" },
  { sym: "KO", mkt: "NYSE", ccy: "USD", at: 831994200, n: 2, d: 1, as: "2:1" },
  { sym: "KO", mkt: "NYSE", ccy: "USD", at: 1344864600, n: 2, d: 1, as: "2:1" },
  { sym: "LLOY.L", mkt: "LSE", ccy: "GBp", at: 1242025200, n: 41, d: 40, as: "41:40" },
  { sym: "LUMN", mkt: "NYSE", ccy: "USD", at: 586531800, n: 3, d: 2, as: "3:2" },
  { sym: "LUMN", mkt: "NYSE", ccy: "USD", at: 607012200, n: 3, d: 2, as: "3:2" },
  { sym: "LUMN", mkt: "NYSE", ccy: "USD", at: 726157800, n: 3, d: 2, as: "3:2" },
  { sym: "LUMN", mkt: "NYSE", ccy: "USD", at: 891441000, n: 3, d: 2, as: "3:2" },
  { sym: "LUMN", mkt: "NYSE", ccy: "USD", at: 922977000, n: 3, d: 2, as: "3:2" },
  { sym: "MC.PA", mkt: "Euronext Paris", ccy: "EUR", at: 962607600, n: 5, d: 1, as: "5:1" },
  { sym: "MMM", mkt: "NYSE", ccy: "USD", at: 550848600, n: 2, d: 1, as: "2:1" },
  { sym: "MMM", mkt: "NYSE", ccy: "USD", at: 766071000, n: 2, d: 1, as: "2:1" },
  { sym: "MMM", mkt: "NYSE", ccy: "USD", at: 1064928600, n: 2, d: 1, as: "2:1" },
  { sym: "MMM", mkt: "NYSE", ccy: "USD", at: 1711978200, n: 1196, d: 1000, as: "1196:1000" },
  { sym: "NESN.SW", mkt: "SIX", ccy: "CHF", at: 992242800, n: 10, d: 1, as: "10:1" },
  { sym: "NESN.SW", mkt: "SIX", ccy: "CHF", at: 1214809200, n: 10, d: 1, as: "10:1" },
  { sym: "NVDA", mkt: "NASDAQ", ccy: "USD", at: 962112600, n: 2, d: 1, as: "2:1" },
  { sym: "NVDA", mkt: "NASDAQ", ccy: "USD", at: 1000301400, n: 2, d: 1, as: "2:1" },
  { sym: "NVDA", mkt: "NASDAQ", ccy: "USD", at: 1144416600, n: 2, d: 1, as: "2:1" },
  { sym: "NVDA", mkt: "NASDAQ", ccy: "USD", at: 1189517400, n: 3, d: 2, as: "3:2" },
  { sym: "NVDA", mkt: "NASDAQ", ccy: "USD", at: 1626787800, n: 4, d: 1, as: "4:1" },
  { sym: "NVDA", mkt: "NASDAQ", ccy: "USD", at: 1718026200, n: 10, d: 1, as: "10:1" },
  { sym: "ORG.AX", mkt: "ASX", ccy: "AUD", at: 951087600, n: 1.6667, d: 1, as: "1.6667:1" },
  { sym: "ORG.AX", mkt: "ASX", ccy: "AUD", at: 1109199600, n: 1.0299, d: 1, as: "1.0299:1" },
  { sym: "SAP.DE", mkt: "XETRA", ccy: "EUR", at: 962002800, n: 3, d: 1, as: "3:1" },
  { sym: "SHEL.L", mkt: "LSE", ccy: "GBp", at: 1121410800, n: 2, d: 1, as: "2:1" },
  { sym: "SIRI", mkt: "NASDAQ", ccy: "USD", at: 1725975000, n: 1, d: 10, as: "1:10" },
  { sym: "T", mkt: "NYSE", ccy: "USD", at: 549034200, n: 3, d: 1, as: "3:1" },
  { sym: "T", mkt: "NYSE", ccy: "USD", at: 738423000, n: 2, d: 1, as: "2:1" },
  { sym: "T", mkt: "NYSE", ccy: "USD", at: 890404200, n: 2, d: 1, as: "2:1" },
  { sym: "T", mkt: "NYSE", ccy: "USD", at: 1649683800, n: 1324, d: 1000, as: "1324:1000" },
  { sym: "TLS.AX", mkt: "ASX", ccy: "AUD", at: 909442800, n: 0.7874, d: 1, as: "0.7874:1" },
  { sym: "TLS.AX", mkt: "ASX", ccy: "AUD", at: 936835200, n: 1, d: 1, as: "1:1" },
  { sym: "TSLA", mkt: "NASDAQ", ccy: "USD", at: 1598880600, n: 5, d: 1, as: "5:1" },
  { sym: "TSLA", mkt: "NASDAQ", ccy: "USD", at: 1661434200, n: 3, d: 1, as: "3:1" },
  { sym: "VOD.L", mkt: "LSE", ccy: "GBp", at: 774774000, n: 2, d: 1, as: "2:1" },
  { sym: "VOD.L", mkt: "LSE", ccy: "GBp", at: 938761200, n: 4, d: 1, as: "4:1" },
  { sym: "VOD.L", mkt: "LSE", ccy: "GBp", at: 1154329200, n: 7, d: 8, as: "7:8" },
  { sym: "VOD.L", mkt: "LSE", ccy: "GBp", at: 1393228800, n: 6, d: 11, as: "6:11" },
  { sym: "WES.AX", mkt: "ASX", ccy: "AUD", at: 599785200, n: 2, d: 1, as: "2:1" },
  { sym: "WES.AX", mkt: "ASX", ccy: "AUD", at: 622684800, n: 1.0122, d: 1, as: "1.0122:1" },
  { sym: "WES.AX", mkt: "ASX", ccy: "AUD", at: 901843200, n: 1.0435, d: 1, as: "1.0435:1" },
  { sym: "WES.AX", mkt: "ASX", ccy: "AUD", at: 1384124400, n: 0.9876, d: 1, as: "0.9876:1" },
  { sym: "WES.AX", mkt: "ASX", ccy: "AUD", at: 1416956400, n: 9.827, d: 10, as: "9.827:10" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 345911400, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 395328600, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 426778200, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 497539800, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 553181400, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 647530200, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 730737000, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 924615000, n: 2, d: 1, as: "2:1" },
  { sym: "WMT", mkt: "NASDAQ", ccy: "USD", at: 1708957800, n: 3, d: 1, as: "3:1" },
  { sym: "WOW.AX", mkt: "ASX", ccy: "AUD", at: 950742000, n: 1, d: 1, as: "1:1" },
  { sym: "XOM", mkt: "NYSE", ccy: "USD", at: 361200600, n: 2, d: 1, as: "2:1" },
  { sym: "XOM", mkt: "NYSE", ccy: "USD", at: 558711000, n: 2, d: 1, as: "2:1" },
  { sym: "XOM", mkt: "NYSE", ccy: "USD", at: 861024600, n: 2, d: 1, as: "2:1" },
  { sym: "XOM", mkt: "NYSE", ccy: "USD", at: 995549400, n: 2, d: 1, as: "2:1" },];

const utcDay = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);
const addDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const key = (e: Event) => `${e.sym} ${utcDay(e.at)}`;

/**
 * What each event ACTUALLY did to a share count, where that can be established.
 *
 *   'units'      the number of shares in an account changed by the ratio
 *   'price'      only the price changed; the share count did not move
 *   'noop'       ratio 1 — a marker for something the feed had no other field for
 *   'unverified' neither reading in the captured payloads settles it
 *
 * Every event NOT listed here is an n-for-1 or a 1-for-n announced in whole
 * shares — Apple's 4:1, Toyota's 5:1, NTT's 25:1, Mitsubishi UFJ's 1000:1,
 * Sirius XM's 1-for-10 — and is 'units' by default.
 */
type Truth = 'units' | 'price' | 'noop' | 'unverified';

const TRUTH: Record<string, { truth: Truth; why: string }> = {
  // ── Bonus / scrip issues. One free share for every ten held: the count really
  //    does rise 10%, and Yahoo back-adjusts the dividend series to match.
  '6861.T 2006-03-15': { truth: 'units', why: 'Keyence 1-for-10 bonus issue' },
  '6861.T 2009-03-16': { truth: 'units', why: 'Keyence 1-for-10 bonus issue' },
  '6861.T 2012-03-15': { truth: 'units', why: 'Keyence 1-for-10 bonus issue, served as a float' },
  'BHP.AX 1989-04-21': { truth: 'units', why: 'BHP 1-for-10 bonus issue' },
  'BHP.AX 1995-05-11': { truth: 'units', why: 'BHP 1-for-10 bonus issue' },
  'HSBA.L 1989-04-14': { truth: 'units', why: 'HSBC scrip issue' },
  'HSBA.L 1990-04-12': { truth: 'units', why: 'HSBC scrip issue' },
  'HSBA.L 1991-04-02': { truth: 'unverified', why: 'HSBC group restructure' },

  // ── Capital return plus consolidation. Cash out, fewer shares back — the
  //    count moves, and declared dividend-per-share steps up by about 1/ratio.
  'VOD.L 2006-07-31': { truth: 'units', why: 'return of capital, 7-for-8 consolidation' },
  'VOD.L 2014-02-24': { truth: 'units', why: 'Verizon return of value, 6-for-11 consolidation' },
  'ASML.AS 2007-10-01': { truth: 'units', why: 'synthetic buyback: repayment plus 8-for-9 consolidation' },
  'ASML.AS 2012-11-26': { truth: 'units', why: 'synthetic buyback: DPS EUR 0.46 to 0.53 across it' },
  'WES.AX 2013-11-10': { truth: 'units', why: 'Wesfarmers capital return with consolidation' },
  'WES.AX 2014-11-25': { truth: 'units', why: 'Wesfarmers capital return with consolidation' },
  'GSK.L 2022-07-19': { truth: 'units', why: 'Haleon demerger with 4-for-5 consolidation; DPS 14.00p to 16.25p' },

  // ── Spin-offs and demergers. Value leaves; the share count does not move.
  'GE 2019-02-26': { truth: 'price', why: 'Wabtec separation' },
  'GE 2023-01-04': { truth: 'price', why: 'GE HealthCare; declared dividend flat at USD 0.08' },
  'GE 2024-04-02': { truth: 'price', why: 'GE Vernova; declared dividend flat at USD 0.08' },
  'T 2022-04-11': { truth: 'price', why: 'Warner Bros. Discovery; DPS USD 0.688 to 0.278' },
  'MMM 2024-04-01': { truth: 'price', why: 'Solventum; DPS USD 1.51 to 0.70' },
  'F 1998-04-08': { truth: 'price', why: 'Associates First Capital spin-off' },
  'F 2000-06-29': { truth: 'price', why: 'Visteon spin-off' },
  'F 2000-08-03': { truth: 'price', why: 'Value Enhancement Plan recapitalisation' },
  'GOOGL 2014-04-03': { truth: 'price', why: 'Class C stock dividend — a different security, not more of this one' },
  'ORG.AX 2000-02-20': { truth: 'price', why: 'Origin demerged from Boral' },
  'ORG.AX 2005-02-23': { truth: 'price', why: 'Origin capital restructure' },
  'BHP.AX 2001-06-29': { truth: 'price', why: 'BHP Billiton dual-listed merger factor' },
  'BHP.AX 2002-07-02': { truth: 'price', why: 'BHP Billiton merger adjustment' },
  'TLS.AX 1998-10-26': { truth: 'price', why: 'Telstra instalment receipt conversion' },
  'LLOY.L 2009-05-11': { truth: 'price', why: 'rights issue adjustment factor' },

  // ── Ratio 1. The feed had nowhere else to put a marker.
  'CBA.AX 1993-09-27': { truth: 'noop', why: 'ratio 1' },
  'CBA.AX 1999-02-15': { truth: 'noop', why: 'ratio 1' },
  'CBA.AX 1999-10-06': { truth: 'noop', why: 'ratio 1' },
  'TLS.AX 1999-09-09': { truth: 'noop', why: 'ratio 1' },
  'WOW.AX 2000-02-16': { truth: 'noop', why: 'ratio 1' },

  // ── Neither the price nor the dividend series settles these.
  'CBA.AX 1996-05-27': { truth: 'unverified', why: 'CBA instalment tranche' },
  'WES.AX 1989-09-25': { truth: 'unverified', why: 'small factor, no dividend evidence' },
  'WES.AX 1998-07-31': { truth: 'unverified', why: 'small factor, no dividend evidence' },
  'SHEL.L 2005-07-15': { truth: 'unverified', why: 'Royal Dutch / Shell Transport unification' },
  'ENI.MI 2001-06-18': { truth: 'unverified', why: 'no dividend history before the event' },
};

const truthOf = (e: Event): Truth => TRUTH[key(e)]?.truth ?? 'units';

/** What Ledger decides to do about an event: apply it, ask about it, or nothing. */
const kindOf = (e: Event) => classifyCorporateAction(e.n, e.d);
/** Whether Ledger moves a unit count on its own. */
const acts = (e: Event) => kindOf(e) === 'split';
/** Whether Ledger holds the event against the holding and asks. */
const asks = (e: Event) => kindOf(e) === 'review';

// ─── The feed, under our control ────────────────────────────────────────────

const eventsFor = (sym: string) => CENSUS.filter(e => e.sym === sym);

/**
 * The zone each exchange stamps its events in, read off `exchangeTimezoneName`
 * in a live chart response for a listing on that market. The feed carries this
 * on every body, which is why the parser takes the date from the payload rather
 * than from a table of its own that could fall out of step.
 */
const MARKET_TZ: Record<string, string> = {
  ASX: 'Australia/Sydney', NYSE: 'America/New_York', NASDAQ: 'America/New_York',
  LSE: 'Europe/London', XETRA: 'Europe/Berlin', 'Euronext Paris': 'Europe/Paris',
  'Euronext Amsterdam': 'Europe/Amsterdam', SIX: 'Europe/Zurich',
  'Borsa Italiana': 'Europe/Rome', JPX: 'Asia/Tokyo',
};

/**
 * A chart body the way the wire serves one: the events, and the meta block that
 * says which instrument and which clock they belong to.
 */
const chartBody = (
  events: { at: number; n: number; d: number }[],
  meta?: { symbol?: string; currency?: string; timeZone?: string | null },
) => ({
  chart: { result: [{
    meta: {
      symbol: meta?.symbol ?? 'X',
      currency: meta?.currency ?? 'USD',
      ...(meta?.timeZone === null ? {} : { exchangeTimezoneName: meta?.timeZone ?? 'America/New_York' }),
    },
    events: {
      splits: Object.fromEntries(events.map(e => [
        String(e.at),
        { date: e.at, numerator: e.n, denominator: e.d, splitRatio: `${e.n}:${e.d}` },
      ])),
    },
  }] },
});

/** The body for a symbol, with that symbol's own currency and exchange clock. */
const bodyFor = (sym: string, events: Event[]) => {
  const any = events[0] ?? CENSUS.find(e => e.sym === sym);
  return chartBody(events, {
    symbol: sym,
    currency: any?.ccy ?? 'USD',
    timeZone: any ? MARKET_TZ[any.mkt] ?? null : null,
  });
};

/**
 * The feed, answering for whatever symbol it is asked about — with that
 * company's REAL events, and honouring `period1`/`period2` the way Yahoo does.
 * So a holding's ticker and market are resolved to a symbol by the code under
 * test, and what comes back is what the wire returned for that symbol.
 */
let deadSymbols = new Set<string>();
let brokenSymbols = new Set<string>();
let throwFor = new Set<string>();
let overrides: Record<string, Event[]> = {};
let feedMeta: Record<string, { symbol?: string; currency?: string; timeZone?: string | null }> = {};
let feedCalls = 0;
let lastWindow: { sym: string; p1: number; p2: number } | null = null;

beforeEach(() => {
  db.investments = []; db.cgt_splits = []; db.writes = 0;
  db.splitColumn = true; db.bookTable = true; db.reviewColumn = true;
  deadSymbols = new Set(); brokenSymbols = new Set(); throwFor = new Set();
  overrides = {}; feedMeta = {};
  feedCalls = 0; lastWindow = null;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    feedCalls += 1;
    const m = /chart\/([^?]+)\?period1=(\d+)&period2=(\d+)/.exec(String(url));
    if (!m) throw new Error(`unrecognised url ${String(url)}`);
    const sym = decodeURIComponent(m[1]);
    const p1 = Number(m[2]), p2 = Number(m[3]);
    lastWindow = { sym, p1, p2 };
    if (throwFor.has(sym)) throw new Error('socket hang up');
    // Yahoo answers 404 for a symbol it has no record of, and 5xx when it is
    // simply having a bad afternoon. They are not the same thing.
    if (deadSymbols.has(sym)) return { ok: false, status: 404, json: async () => ({}) } as never;
    if (brokenSymbols.has(sym)) return { ok: false, status: 503, json: async () => ({}) } as never;
    const all = overrides[sym] ?? eventsFor(sym);
    const within = all.filter(e => e.at >= p1 && e.at <= p2);
    return { ok: true, json: async () => (feedMeta[sym] ? chartBody(within, feedMeta[sym]) : bodyFor(sym, within)) } as never;
  }));
});
afterEach(() => vi.unstubAllGlobals());

let seq = 0;
const idFor = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const put = (over: Partial<InvRow>): InvRow => {
  const row: InvRow = {
    id: idFor(++seq), user_id: 'u1', name: 'Holding',
    ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock',
    shares_owned: 1000, cost_basis: 50_000, current_price: 100,
    split_checked_through: null, native_currency: null,
    pending_corporate_actions: null, ...over,
  };
  db.investments.push(row);
  return row;
};

const candidates = () => db.investments.map(r => ({ ...r }));
const run = (now: string) => syncSplits(candidates(), getYahooTicker, `${now}T06:00:00.000Z`);
const rowOf = (id: string) => db.investments.find(r => r.id === id)!;

// ═══════════════════════════════════════════════════════════════════════════
// 1. WHAT THE FEED ACTUALLY GIVES YOU
// ═══════════════════════════════════════════════════════════════════════════

describe('the shape of a real corporate action', () => {
  it('covers five regions, six currencies and twelve exchanges', () => {
    const syms = new Set(CENSUS.map(e => e.sym));
    expect(syms.size).toBeGreaterThanOrEqual(20);
    expect(CENSUS.length).toBe(143);
    expect(new Set(CENSUS.map(e => e.ccy))).toEqual(
      new Set(['AUD', 'USD', 'GBp', 'EUR', 'CHF', 'JPY']),
    );
    for (const m of ['ASX', 'NASDAQ', 'NYSE', 'LSE', 'XETRA', 'Euronext Paris',
                     'Euronext Amsterdam', 'SIX', 'JPX']) {
      expect(CENSUS.some(e => e.mkt === m), m).toBe(true);
    }
  });

  it('serves a genuine consolidation and a spin-off in the SAME shape', () => {
    // GE's 1-for-8 of 2 August 2021 really did take eight shares and give one.
    // GE's 1253:1000 of 2 April 2024 took nothing: Vernova left, the price fell,
    // the share count did not move. On the wire they are the same object.
    const real = eventsFor('GE').find(e => utcDay(e.at) === '2021-08-02')!;
    const spin = eventsFor('GE').find(e => utcDay(e.at) === '2024-04-02')!;
    const shape = (e: Event) => Object.keys(
      Object.values(chartBody([e]).chart.result[0].events.splits)[0] as object,
    ).sort();
    expect(shape(real)).toEqual(shape(spin));
    expect(shape(real)).toEqual(['date', 'denominator', 'numerator', 'splitRatio']);
    // Nothing in the payload names the difference. Only the two numbers differ.
    expect(truthOf(real)).toBe('units');
    expect(truthOf(spin)).toBe('price');
  });

  it('reads the event date off `date`, not the map key — they disagree', () => {
    // NTT's 100:1 is filed under key 1230597000 (30 December 2008) and carries
    // date 1231027200 (4 January 2009). The key is not the effective date.
    const body = {
      chart: { result: [{ events: { splits: {
        '1230597000': { date: 1231027200, numerator: 100, denominator: 1, splitRatio: '100:1' },
      } } }] },
    };
    expect(parseSplitEvents(body)[0].date).toBe('2009-01-04');
  });

  it('parses every one of the 143 without losing any, oldest first', () => {
    // Per symbol, because the events are keyed by epoch and two companies can
    // split on the same morning — GE and AT&T both did on 26 May 1987.
    let total = 0;
    for (const sym of new Set(CENSUS.map(e => e.sym))) {
      const events = eventsFor(sym);
      const parsed = parseSplitEvents(chartBody(events));
      expect(parsed.length, sym).toBe(events.length);
      expect(parsed.map(x => x.date), sym).toEqual([...parsed.map(x => x.date)].sort());
      total += parsed.length;
    }
    expect(total).toBe(143);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE CLASSIFICATION, MEASURED AGAINST WHAT REALLY HAPPENED
// ═══════════════════════════════════════════════════════════════════════════

describe('telling a share count from a price factor', () => {
  it('splits 117, asks about 21, and passes over 5', () => {
    // Three answers, and they account for every event in the sample.
    expect(CENSUS.filter(acts).length).toBe(117);
    expect(CENSUS.filter(asks).length).toBe(21);
    expect(CENSUS.filter(e => kindOf(e) === 'ignore').length).toBe(5);
    expect(117 + 21 + 5).toBe(CENSUS.length);
  });

  /**
   * THE WHOLE POINT, IN ONE TEST.
   *
   * Every event whose real-world outcome is known, checked against what Ledger
   * does with it. Two things must never happen and neither does:
   *
   *   • a price factor applied to a unit count — the silent one, which inflates
   *     a holding by a plausible percentage nothing on the screen contradicts;
   *   • a real share-count change dropped without a word — the other silent one,
   *     which leaves the holding at the wrong value for ever.
   *
   * A real change Ledger will not classify is allowed, but only if it is ASKED
   * about. That is the whole difference between this and the version of the file
   * that recorded these as defects.
   */
  it('applies no price factor, and never silently drops a real share-count change', () => {
    const applied = CENSUS.filter(e => truthOf(e) === 'price' && acts(e));
    expect(applied.map(key)).toEqual([]);

    const dropped = CENSUS.filter(e => truthOf(e) === 'units' && kindOf(e) === 'ignore');
    expect(dropped.map(key)).toEqual([]);

    // The ratio-1 markers move nothing and are not worth a question either.
    for (const e of CENSUS.filter(x => truthOf(x) === 'noop')) {
      expect(kindOf(e), key(e)).toBe('ignore');
    }

    // Three real share-count changes are too unusual to act on unasked. Each is
    // raised instead of dropped, which is what makes the holding correctable.
    expect(CENSUS.filter(e => truthOf(e) === 'units' && asks(e)).map(key).sort()).toEqual([
      'ASML.AS 2012-11-26',    // 77-for-100 synthetic buyback
      'WES.AX 2013-11-10',     // 0.9876:1 capital return
      'WES.AX 2014-11-25',     // 9.827-for-10 capital return
    ]);
  });

  it('gets every whole-share announcement right, in all five regions', () => {
    // n-for-1 and 1-for-n, which is what the overwhelming majority of real
    // splits are announced as. 96 events across 40 companies, and not one wrong.
    const plain = CENSUS.filter(e => (e.n === 1 || e.d === 1) && Number.isInteger(e.n) && Number.isInteger(e.d) && e.n !== e.d);
    expect(plain.length).toBeGreaterThan(90);
    for (const e of plain) {
      expect(acts(e), `${key(e)} ${e.as}`).toBe(true);
      expect(truthOf(e), key(e)).not.toBe('price');
    }
    // All but three, which nothing in the captured payloads settles either way.
    expect(plain.filter(e => truthOf(e) !== 'units').map(key).sort()).toEqual([
      'ENI.MI 2001-06-18', 'HSBA.L 1991-04-02', 'SHEL.L 2005-07-15',
    ]);
  });

  it('is not fooled by size: 1000:1, 100:1, 50:1, 25:1, 20:1 are all splits', () => {
    // Japan's share-unit reform produced ratios that look like typing errors.
    const big = [
      ['8306.T', '2007-10-01', 1000], ['9432.T', '2009-01-04', 100],
      ['9433.T', '2012-09-26', 100], ['BRK-B', '2010-01-21', 50],
      ['CMG', '2024-06-26', 50], ['9432.T', '2023-06-29', 25],
      ['AMZN', '2022-06-06', 20], ['GOOGL', '2022-07-18', 20],
    ] as const;
    for (const [sym, date, ratio] of big) {
      const e = CENSUS.find(x => key(x) === `${sym} ${date}`)!;
      expect(e, `${sym} ${date}`).toBeTruthy();
      expect(acts(e), `${sym} ${date}`).toBe(true);
      expect(splitRatio(e.n, e.d)).toBe(ratio);
    }
  });

  it('handles every reverse split in the sample', () => {
    const reverses = CENSUS.filter(e => e.n < e.d);
    expect(reverses.map(key).sort()).toEqual([
      '6501.T 2018-09-26',   // Hitachi 1-for-5
      'AMC 2023-08-24',      // AMC 1-for-10
      'ASML.AS 2007-10-01',  // 8-for-9 consolidation
      'ASML.AS 2012-11-26',  // 77-for-100 consolidation
      'CBA.AX 1996-05-27',   // 0.9936:1
      'ENI.MI 2001-06-18',   // 1-for-2
      'GE 2021-08-02',       // 1-for-8
      'GSK.L 2022-07-19',    // 4-for-5 consolidation
      'HSBA.L 1991-04-02',   // 1-for-4
      'SIRI 2024-09-10',     // 1-for-10
      'TLS.AX 1998-10-26',   // 0.7874:1 instalment conversion
      'VOD.L 2006-07-31',    // 7-for-8 consolidation
      'VOD.L 2014-02-24',    // 6-for-11 consolidation
      'WES.AX 2013-11-10',   // 0.9876:1 capital return
      'WES.AX 2014-11-25',   // 9.827-for-10 capital return
    ]);
    // Ten of the fifteen are applied outright, Vodafone's 6-for-11 among them.
    // The five that are not are all asked about rather than dropped: a
    // consolidation announced in a ratio no announcement would use, three served
    // as four-figure decimals, and Telstra's instalment conversion.
    const unapplied = reverses.filter(e => !acts(e));
    expect(unapplied.map(key).sort()).toEqual([
      'ASML.AS 2012-11-26', 'CBA.AX 1996-05-27', 'TLS.AX 1998-10-26',
      'WES.AX 2013-11-10', 'WES.AX 2014-11-25',
    ]);
    for (const e of unapplied) expect(kindOf(e), key(e)).toBe('review');
  });

  it('leaves every confirmed spin-off and demerger alone', () => {
    const spinoffs = CENSUS.filter(e => truthOf(e) === 'price');
    expect(spinoffs.length).toBe(15);
    for (const e of spinoffs) {
      expect(acts(e), `${key(e)} — ${TRUTH[key(e)].why}`).toBe(false);
    }
  });

  it('leaves the ratio-1 markers alone', () => {
    for (const e of CENSUS.filter(x => truthOf(x) === 'noop')) {
      expect(acts(e), key(e)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE SEVEN DEFECTS THIS FILE FOUND — each one now asserted as fixed.
//
//    These were written as `DEFECT` tests: the behaviour as it was, with the
//    right answer named in the comment, so that fixing the rule would fail them
//    and the failure would be the reminder to come back. This is coming back.
// ═══════════════════════════════════════════════════════════════════════════

describe('CA-1..CA-4: reading an announcement the feed wrote awkwardly', () => {
  /**
   * CA-1 (was HIGH). `MAX_SPLIT_TERM = 10` threw away announced consolidations
   * whose ratio needs a term above ten. Vodafone's 6-for-11 of 24 February 2014
   * was the worst case in the sample: eleven shares became six, the feed's price
   * went from 134.50p to 252.30p the same morning, and Ledger kept the eleven
   * and took the new price — so the holding was worth 1.83x what its owner had,
   * silently, permanently, and straight into net worth.
   *
   * The bound is now eleven, which is where the two sets stop touching: the
   * largest term in an announced ratio across these 143 events is Vodafone's own
   * 11, and the smallest term in a price factor that reduces to whole numbers at
   * all is 26. That margin is measured in CA-4 below rather than assumed.
   */
  it('CA-1: applies Vodafone 6-for-11, and 1,100 shares become 600', async () => {
    const e = CENSUS.find(x => key(x) === 'VOD.L 2014-02-24')!;
    expect(truthOf(e)).toBe('units');
    expect(acts(e)).toBe(true);

    const inv = put({
      name: 'Vodafone', ticker: 'VOD', market: 'LSE', native_currency: 'GBp',
      shares_owned: 1_100, cost_basis: 4_000, current_price: 1.345,
      split_checked_through: '2014-02-20',
    });
    const r = await run('2014-02-25');
    expect(r.applied).toBe(1);

    const after = rowOf(inv.id);
    // Exactly 600, not 600.000005: the count is scaled by 6 and 11, not by the
    // eight-decimal rounding of 6 ÷ 11.
    expect(after.shares_owned).toBe(600);
    expect(after.cost_basis).toBe(4_000);
    // The price moved the other way in the same write, so the holding's worth
    // did not change for an instant. (The price itself is stored to eight
    // decimals, so the worth matches to a part in a billion, not to the cent-th.)
    expect(Math.abs(after.shares_owned * after.current_price / (1_100 * 1.345) - 1))
      .toBeLessThan(1e-8);
  });

  /**
   * CA-1, the other half. ASML's 77-for-100 of 26 November 2012 was a real
   * consolidation, and it is NOT distinguishable by ratio from Lloyds' 41:40
   * rights-issue factor of 2009, which must never be applied. No bound admits
   * one and excludes the other — see CA-4 — so neither is guessed at. The units
   * are left exactly alone and the holder is asked.
   */
  it('CA-1: asks about ASML 77-for-100 instead of dropping it', async () => {
    const e = CENSUS.find(x => key(x) === 'ASML.AS 2012-11-26')!;
    expect(truthOf(e)).toBe('units');
    expect(asks(e)).toBe(true);

    const inv = put({
      name: 'ASML', ticker: 'ASML', market: 'Euronext Amsterdam', native_currency: 'EUR',
      shares_owned: 1_000, cost_basis: 30_000, current_price: 41.5,
      split_checked_through: '2012-11-20',
    });
    const r = await run('2012-11-27');
    expect(r.applied).toBe(0);
    expect(r.review).toBe(1);

    const after = rowOf(inv.id);
    expect(after.shares_owned).toBe(1_000);           // untouched, both ways
    expect(after.current_price).toBe(41.5);
    expect(after.cost_basis).toBe(30_000);

    const [pending] = after.pending_corporate_actions!;
    expect(pending.date).toBe('2012-11-26');
    expect(pending.numerator).toBe(77);
    expect(pending.denominator).toBe(100);
    expect(pending.ratio).toBe(0.77);
    expect(pending.resolved).toBe(null);
    // The id is the one the split WOULD have been recorded under, so the same
    // event seen again matches this entry rather than raising a second question.
    expect(pending.id).toBe(splitRecordId(inv.id, '2012-11-26', 0.77));
  });

  /**
   * CA-2 (was MEDIUM). A one-for-ten bonus issue is 11:10, and 11 was one past
   * the bound. The count really rises a tenth and the price really falls a
   * tenth, so ignoring it booked a 9.1% loss that never happened — six times in
   * this sample, across three companies on three exchanges.
   */
  it('CA-2: applies every 11:10 bonus issue', () => {
    const bonus = CENSUS.filter(e => splitRatio(e.n, e.d) === 1.1);
    expect(bonus.map(key).sort()).toEqual([
      '6861.T 2006-03-15', '6861.T 2009-03-16', '6861.T 2012-03-15',
      'BHP.AX 1989-04-21', 'BHP.AX 1995-05-11',
      'HSBA.L 1989-04-14', 'HSBA.L 1990-04-12',
    ]);
    for (const e of bonus) {
      expect(truthOf(e), key(e)).not.toBe('price');
      expect(acts(e), key(e)).toBe(true);
    }
  });

  it('CA-2: and the units really move — 1,000 BHP become 1,100', async () => {
    const inv = put({
      name: 'BHP', ticker: 'BHP', market: 'ASX', native_currency: 'AUD',
      shares_owned: 1_000, cost_basis: 12_000, current_price: 18.7,
      split_checked_through: '1995-05-01',
    });
    const r = await run('1995-05-15');
    expect(r.applied).toBe(1);
    const after = rowOf(inv.id);
    expect(after.shares_owned).toBe(1_100);
    expect(after.cost_basis).toBe(12_000);
    expect(after.shares_owned * after.current_price).toBeCloseTo(1_000 * 18.7, 6);
  });

  /**
   * CA-3 (was MEDIUM). The integer guard rejected a ratio the feed happened to
   * serialise as a float — and Yahoo serialises the SAME event both ways.
   * Keyence's bonus issue is "11:10" in 2006 and 2009 and "1.1:1" in 2012.
   *
   * A decimal is now scaled up until both sides are whole, and nothing is
   * rounded to get there. That is what makes it safe: 1.1 is exactly 11:10, and
   * Origin's demerger factor of 1.6667 is exactly 16667:10000 rather than the
   * 5:3 it sits within two thousandths of.
   */
  it('CA-3: reads a float ratio as the exact fraction it is', () => {
    expect(rationaliseRatio(1.1, 1)).toEqual({ n: 11, d: 10 });
    expect(rationaliseRatio(11, 10)).toEqual({ n: 11, d: 10 });
    expect(rationaliseRatio(110, 100)).toEqual({ n: 11, d: 10 });
    // The same corporate action, served three ways, read three times the same.
    expect(classifyCorporateAction(1.1, 1)).toBe('split');
    expect(classifyCorporateAction(11, 10)).toBe('split');
    expect(classifyCorporateAction(110, 100)).toBe('split');

    // And the near-misses are NOT rounded into announcements.
    expect(rationaliseRatio(1.6667, 1)).toEqual({ n: 16667, d: 10000 });
    expect(classifyCorporateAction(1.6667, 1)).toBe('review');
    expect(rationaliseRatio(2.0651, 1)).toEqual({ n: 20651, d: 10000 });
    expect(classifyCorporateAction(2.0651, 1)).toBe('review');
  });

  it('CA-3: no float in the sample is dropped, and the real one is applied', () => {
    const floats = CENSUS.filter(e => !Number.isInteger(e.n) || !Number.isInteger(e.d));
    expect(floats.map(key).sort()).toEqual([
      '6861.T 2012-03-15', 'BHP.AX 2001-06-29', 'BHP.AX 2002-07-02',
      'CBA.AX 1996-05-27', 'ORG.AX 2000-02-20', 'ORG.AX 2005-02-23',
      'TLS.AX 1998-10-26', 'WES.AX 1989-09-25', 'WES.AX 1998-07-31',
      'WES.AX 2013-11-10', 'WES.AX 2014-11-25',
    ]);
    // Keyence's bonus issue is the one float that is unmistakably an
    // announcement, and it is now applied. Every other one is asked about.
    expect(floats.filter(acts).map(key)).toEqual(['6861.T 2012-03-15']);
    for (const e of floats.filter(x => !acts(x))) expect(kindOf(e), key(e)).toBe('review');
    expect(floats.filter(e => kindOf(e) === 'ignore').map(key)).toEqual([]);
  });

  /**
   * CA-4 was the reason CA-1..3 could not be fixed by widening the bound, and it
   * is still true: no bound separates the two kinds cleanly. What changed is
   * that the bound no longer has to. It is set where the sets stop touching —
   * everything below it is applied, everything above it is a question — so the
   * events the bound cannot decide are no longer decided by it.
   */
  it('CA-4: the bound sits in the gap, and the gap is real', () => {
    const reduced = (e: Event) => rationaliseRatio(e.n, e.d)!;
    const term = (e: Event) => { const r = reduced(e); return Math.max(r.n, r.d); };
    // Ratios with a 1 on one side are announcements whatever their size —
    // Mitsubishi UFJ's 1000:1 is not a decimal, it is a thousand shares for one.
    const twoSided = (e: Event) => { const r = reduced(e); return r.n !== 1 && r.d !== 1; };

    const announced = CENSUS.filter(e => truthOf(e) === 'units' && acts(e) && twoSided(e));
    const factors = CENSUS.filter(e => truthOf(e) === 'price' && twoSided(e));

    // Every genuine two-sided announcement fits in eleven: 11:10, 6:11, 7:8,
    // 8:9, 4:5, 3:2. The smallest price factor needs twenty-six — GE's Wabtec
    // 104:100, which reduces to 26:25.
    expect(Math.max(...announced.map(term))).toBe(11);
    expect(Math.min(...factors.map(term))).toBe(26);
    expect(Math.max(...announced.map(term))).toBeLessThan(Math.min(...factors.map(term)));

    // The two events that sit ABOVE the bound and were nonetheless real —
    // ASML's 77:100 and Wesfarmers' two capital returns — are the reason the
    // third answer exists. They are not below the bound and they are not lost.
    const aboveAndReal = CENSUS.filter(e => truthOf(e) === 'units' && !acts(e));
    expect(aboveAndReal.length).toBe(3);
    for (const e of aboveAndReal) expect(kindOf(e), key(e)).toBe('review');
  });
});

describe('CA-5..CA-7: dates, markets and tickers', () => {
  /**
   * CA-5 (was LOW). Yahoo stamps an event at the moment its market OPENED, and
   * for the ASX that is 23:00 UTC the previous day. Reading the epoch as a UTC
   * calendar date dated eight of the ASX events in this sample a day early —
   * Wesfarmers' 2:1 among them, which IS applied. That date is not cosmetic: it
   * becomes the split's `recorded_at`, and the CGT engine scales the parcels
   * written down before that instant.
   *
   * The zone comes from the payload's own `exchangeTimezoneName`, so no table in
   * Ledger can fall out of step with the feed.
   */
  it('CA-5: an ASX event stamped at the Sydney open lands on the Sydney day', () => {
    const early = CENSUS.filter(e => new Date(e.at * 1000).toISOString().slice(11, 16) >= '21:00');
    expect(early.length).toBe(8);
    expect(early.every(e => e.mkt === 'ASX')).toBe(true);

    const wes = CENSUS.find(x => x.sym === 'WES.AX' && x.n === 2)!;
    expect(new Date(wes.at * 1000).toISOString()).toBe('1989-01-02T23:00:00.000Z');
    // 23:00 UTC on 2 January is 10:00 on 3 January in Sydney.
    expect(parseSplitEvents(bodyFor('WES.AX', [wes]))[0].date).toBe('1989-01-03');
    expect(exchangeDay(wes.at, 'Australia/Sydney')).toBe('1989-01-03');
    expect(acts(wes)).toBe(true);
  });

  it('CA-5: every other market in the sample keeps the date it already had', () => {
    for (const e of CENSUS) {
      const parsed = parseSplitEvents(bodyFor(e.sym, [e]))[0];
      const shifts = new Date(e.at * 1000).toISOString().slice(11, 16) >= '21:00';
      expect(parsed.date, key(e)).toBe(shifts ? addDay(utcDay(e.at)) : utcDay(e.at));
    }
  });

  it('CA-5: and falls back to UTC when the feed omits the zone', () => {
    const wes = CENSUS.find(x => x.sym === 'WES.AX' && x.n === 2)!;
    const body = chartBody([wes], { timeZone: null });
    expect(parseSplitEvents(body)[0].date).toBe('1989-01-02');
    expect(exchangeDay(wes.at, 'Not/AZone')).toBe('1989-01-02');
  });

  /**
   * CA-6 (was LOW). Borsa Italiana was not in `MARKET_SUFFIX`, so a Milan
   * holding was not split-eligible at all — and `getYahooTicker` stripped the
   * exchange, turning ENI.MI into ENI, which on Yahoo is a different company.
   */
  it('CA-6: an Italian listing is eligible, and its symbol resolves', () => {
    expect(isSplitEligible('Borsa Italiana', 'stock')).toBe(true);
    expect(getYahooTicker('ENI', 'Borsa Italiana')).toBe('ENI.MI');
    expect(CENSUS.some(e => e.mkt === 'Borsa Italiana')).toBe(true);
  });

  it('CA-6: every market in the sample is eligible and resolves', () => {
    const seen = new Map(CENSUS.map(e => [e.mkt, e.sym]));
    for (const [mkt, sym] of seen) {
      expect(isSplitEligible(mkt, 'stock'), mkt).toBe(true);
      const bare = sym.replace(/\.[A-Z]+$/, '');
      expect(getYahooTicker(bare, mkt), mkt).toBe(sym.toUpperCase());
    }
  });

  /**
   * CA-7 (was LOW–MEDIUM). Two halves, and only one of them was a cost.
   *
   * The retry is kept: a symbol comes back — a suspension ends, a ticker is
   * corrected — and the watermark must stay where it is or the splits inside the
   * gap are skipped for ever. What was wrong was the silence, and that a 404 was
   * indistinguishable from a bad afternoon. Now it says so, once.
   */
  it('CA-7: a symbol the feed has never heard of is still retried, and is said out loud', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inv = put({ ticker: 'RDSB', market: 'LSE', split_checked_through: '2026-08-01' });
    deadSymbols.add('RDSB.L');
    for (const d of ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
      const r = await run(d);
      expect(r.checked).toBe(1);
      expect(r.applied).toBe(0);
    }
    expect(feedCalls).toBe(4);
    expect(rowOf(inv.id).split_checked_through).toBe('2026-08-01');
    // Said once, not once a day for ever.
    const said = warn.mock.calls.filter(c => String(c[0]).includes('RDSB.L'));
    expect(said.length).toBe(1);
    expect(String(said[0][0])).toContain('no symbol');
    warn.mockRestore();
  });

  it('CA-7: a feed having a bad afternoon is not mistaken for a dead symbol', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    put({ ticker: 'BHP', market: 'ASX', split_checked_through: '2026-08-01' });
    brokenSymbols.add('BHP.AX');
    await run('2026-08-02');
    expect(warn.mock.calls.filter(c => String(c[0]).includes('no symbol')).length).toBe(0);
    warn.mockRestore();
  });

  /**
   * The dangerous half of CA-7. A ticker outlives the company that used it: a
   * delisting frees the letters and the next listing to want them gets them.
   * Nothing checked that the instrument behind a symbol was still the one the
   * holding was bought in, so whatever the feed answered for the string was
   * applied — and a reused symbol's 10:1 would have multiplied a unit count in
   * a company that never split.
   *
   * The feed states the currency it is quoting in. It is not an instrument id,
   * and it will not catch a reuse inside the same market — that is stated here
   * rather than glossed over — but it does catch the reuses that move a
   * holding's value.
   */
  it('CA-7: a ticker now quoting in another currency is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inv = put({
      ticker: 'GHOST', market: 'NASDAQ', native_currency: 'GBP',
      shares_owned: 100, split_checked_through: '2024-06-01',
    });
    overrides['GHOST'] = [CENSUS.find(e => key(e) === 'NVDA 2024-06-10')!];
    feedMeta['GHOST'] = { symbol: 'GHOST', currency: 'USD', timeZone: 'America/New_York' };
    await run('2024-06-20');
    expect(rowOf(inv.id).shares_owned).toBe(100);
    expect(warn.mock.calls.some(c => String(c[0]).includes('reused'))).toBe(true);
    warn.mockRestore();
  });

  it('CA-7: and a holding with no recorded currency is not refused over it', async () => {
    const inv = put({
      ticker: 'NVDA', market: 'NASDAQ', native_currency: null,
      shares_owned: 100, split_checked_through: '2024-06-01',
    });
    await run('2024-06-20');
    expect(rowOf(inv.id).shares_owned).toBe(1_000);
  });
});

describe('a question is asked once, and answering it ends it', () => {
  const asmlEvent = () => CENSUS.find(e => key(e) === 'ASML.AS 2012-11-26')!;
  const asmlHolding = () => put({
    name: 'ASML', ticker: 'ASML', market: 'Euronext Amsterdam', native_currency: 'EUR',
    shares_owned: 1_000, cost_basis: 30_000, current_price: 41.5,
    split_checked_through: '2012-11-20',
  });

  it('raises it once, however many times the event is seen', async () => {
    const inv = asmlHolding();
    // The first pass raises it; the heal window brings the same event back on
    // each of the next few days, and the derived id matches what is already
    // there. Six passes, one question.
    for (const d of ['2012-11-27', '2012-11-28', '2012-11-29', '2012-11-30', '2012-12-01', '2012-12-02']) {
      await run(d);
    }
    expect(rowOf(inv.id).pending_corporate_actions).toHaveLength(1);
    expect(rowOf(inv.id).shares_owned).toBe(1_000);
  });

  it('does not ask again once it has been answered', async () => {
    const inv = asmlHolding();
    await run('2012-11-27');
    const [q] = rowOf(inv.id).pending_corporate_actions!;

    // The holder says the count did change: units move and the entry is marked.
    // (Both are the client's writes — this is the state they leave behind.)
    const row = rowOf(inv.id);
    row.shares_owned = 770;
    row.pending_corporate_actions = [{ ...q, resolved: 'applied', resolved_at: '2012-11-28T00:00:00.000Z' }];
    row.split_checked_through = '2012-11-27';

    await run('2012-11-28');
    expect(rowOf(inv.id).pending_corporate_actions).toHaveLength(1);
    expect(rowOf(inv.id).pending_corporate_actions![0].resolved).toBe('applied');
    expect(rowOf(inv.id).shares_owned).toBe(770);
  });

  it('does not ask about something the holder already recorded themselves', async () => {
    const inv = asmlHolding();
    // They saw the price move, worked out what happened, and corrected the count
    // — which the parcel book records as a split. That is an answer already.
    db.cgt_splits.push({
      id: splitRecordId(inv.id, '2012-11-26', 0.77),
      user_id: 'u1', investment_id: inv.id, label: 'ASML', ticker: 'ASML',
      ratio: 0.77, recorded_at: splitRecordedAt('2012-11-26'),
    });
    const r = await run('2012-11-27');
    expect(r.review).toBe(0);
    expect(rowOf(inv.id).pending_corporate_actions).toBe(null);
  });

  it('never touches units, cost, price or the parcel book', async () => {
    const inv = asmlHolding();
    await run('2012-11-27');
    const after = rowOf(inv.id);
    expect(after.shares_owned).toBe(1_000);
    expect(after.cost_basis).toBe(30_000);
    expect(after.current_price).toBe(41.5);
    expect(db.cgt_splits).toHaveLength(0);
    expect(after.split_checked_through).toBe('2012-11-27');
  });

  it('carries on applying splits when the review column is not migrated', async () => {
    db.reviewColumn = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // GE's real 1-for-8 and its Vernova price factor, on one holding.
    const inv = put({
      name: 'GE', ticker: 'GE', market: 'NYSE', native_currency: 'USD',
      shares_owned: 800, cost_basis: 9_000, current_price: 13,
      split_checked_through: '2021-07-30',
    });
    const r = await run('2024-04-05');
    expect(r.applied).toBe(1);
    expect(r.review).toBe(0);                       // could not be raised
    expect(rowOf(inv.id).shares_owned).toBe(100);   // but the split still landed
    expect(warn.mock.calls.some(c => String(c[0]).includes('pending_corporate_actions'))).toBe(true);
    warn.mockRestore();
  });

  /**
   * The census, end to end. One holding per company, watermarked the day before
   * its first event, so the whole captured history replays. Every event Ledger
   * will not classify becomes exactly one question, and not one unit moves for
   * any of them.
   */
  it('asks 21 questions across the whole sample and moves nothing for any of them', async () => {
    const syms = [...new Set(CENSUS.filter(asks).map(e => e.sym))];
    let raised = 0;
    for (const sym of syms) {
      db.investments = []; db.cgt_splits = [];
      const events = eventsFor(sym);
      const first = utcDay(Math.min(...events.map(e => e.at)));
      const inv = put({
        name: sym, ticker: sym.replace(/\.[A-Z]+$/, ''), market: events[0].mkt,
        native_currency: events[0].ccy === 'GBp' ? 'GBP' : events[0].ccy,
        shares_owned: 1_000, cost_basis: 50_000, current_price: 100,
        split_checked_through: new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000)
          .toISOString().slice(0, 10),
      });
      const r = await run('2026-08-30');
      const questions = rowOf(inv.id).pending_corporate_actions ?? [];
      expect(questions.length, sym).toBe(events.filter(asks).length);
      expect(r.review, sym).toBe(questions.length);
      raised += questions.length;

      // The unit count reflects the APPLIED events only — every question left it
      // exactly where it was.
      const expected = events.filter(acts).reduce((u, e) => {
        const t = rationaliseRatio(e.n, e.d)!;
        return parseFloat(((u * t.n) / t.d).toFixed(8));
      }, 1_000);
      expect(rowOf(inv.id).shares_owned, sym).toBeCloseTo(expected, 6);
      expect(rowOf(inv.id).cost_basis, sym).toBe(50_000);
    }
    expect(raised).toBe(21);
    expect(raised).toBe(CENSUS.filter(asks).length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE INVARIANTS — these are requirements, not observations
// ═══════════════════════════════════════════════════════════════════════════

describe('units move, and nothing else does', () => {
  it('Apple 4:1 — 400 shares become 1,600 and the cost stays $69,320', async () => {
    const inv = put({
      ticker: 'AAPL', market: 'NASDAQ', shares_owned: 400,
      cost_basis: 69_320, current_price: 499.23, split_checked_through: '2020-08-01',
    });
    const worthBefore = 400 * 499.23;

    const r = await run('2020-09-01');
    expect(r.applied).toBe(1);

    const after = rowOf(inv.id);
    expect(after.shares_owned).toBe(1600);
    expect(after.cost_basis).toBe(69_320);
    expect(after.current_price).toBeCloseTo(124.8075, 6);
    expect(after.shares_owned * after.current_price).toBeCloseTo(worthBefore, 6);
  });

  it('holds for every applied event in the sample, in every currency', async () => {
    // One holding per company, watermarked the day before its FIRST event, so
    // the whole captured history is replayed against it.
    const cases = [...new Set(CENSUS.filter(acts).map(e => e.sym))].map(sym => {
      const events = eventsFor(sym);
      const first = utcDay(Math.min(...events.map(e => e.at)));
      return { sym, first, events };
    });
    expect(cases.length).toBeGreaterThanOrEqual(40);

    for (const c of cases) {
      db.investments = []; db.cgt_splits = [];
      const mkt = c.events[0].mkt;
      const inv = put({
        name: c.sym, ticker: c.sym.replace(/\.[A-Z]+$/, ''), market: mkt,
        shares_owned: 1000, cost_basis: 123_456.78, current_price: 250,
        split_checked_through: new Date(Date.parse(`${c.first}T00:00:00Z`) - 86_400_000)
          .toISOString().slice(0, 10),
      });
      const worth = 1000 * 250;

      await run('2026-08-30');

      const after = rowOf(inv.id);
      // Scaled by the terms, in order, exactly as the engine does — 1,000 ASML
      // through a 3:1 and then an 8-for-9 is 3,000 × 8 ÷ 9, not 3,000 × 0.88888889.
      const expected = c.events.filter(acts).reduce((u, e) => {
        const r = rationaliseRatio(e.n, e.d)!;
        return parseFloat(((u * r.n) / r.d).toFixed(8));
      }, 1000);
      expect(after.shares_owned, `${c.sym} units`).toBeCloseTo(expected, 6);
      expect(after.cost_basis, `${c.sym} cost`).toBe(123_456.78);
      expect(Math.abs(after.shares_owned * after.current_price / worth - 1), `${c.sym} worth`)
        .toBeLessThan(1e-7);
      expect(after.shares_owned, `${c.sym} positive`).toBeGreaterThan(0);
    }
  });

  it('Walmart, nine splits over forty-four years, is 1,536× the shares', async () => {
    const inv = put({
      ticker: 'WMT', market: 'NASDAQ', shares_owned: 100,
      cost_basis: 1_650, current_price: 173.70, split_checked_through: '1980-12-16',
    });
    const r = await run('2026-08-30');
    expect(r.applied).toBe(9);
    // 2^8 × 3
    expect(rowOf(inv.id).shares_owned).toBe(100 * 768);
    expect(rowOf(inv.id).cost_basis).toBe(1_650);
    expect(rowOf(inv.id).current_price).toBeCloseTo(173.70 / 768, 8);
  });

  it('NVIDIA 4:1 then 10:1 compounds to forty times, not fourteen', async () => {
    const inv = put({
      ticker: 'NVDA', market: 'NASDAQ', shares_owned: 100,
      cost_basis: 18_000, current_price: 4_875.60, split_checked_through: '2021-07-01',
    });
    await run('2026-08-30');
    expect(rowOf(inv.id).shares_owned).toBe(4000);
    expect(db.cgt_splits.map(s => s.ratio).sort((a, b) => a - b)).toEqual([4, 10]);
  });

  it('a reverse split keeps the fraction rather than inventing cash in lieu', async () => {
    const inv = put({
      ticker: 'SIRI', market: 'NASDAQ', shares_owned: 1_234,
      cost_basis: 4_000, current_price: 2.67, split_checked_through: '2024-09-01',
    });
    await run('2024-09-30');
    expect(rowOf(inv.id).shares_owned).toBe(123.4);
    expect(rowOf(inv.id).cost_basis).toBe(4_000);
    expect(rowOf(inv.id).shares_owned * rowOf(inv.id).current_price).toBeCloseTo(1_234 * 2.67, 6);
  });

  it('a London holding splits in whatever unit its price is carried in', async () => {
    // GSK quotes in pence; the stored price has already been folded to pounds by
    // `normaliseQuote`. The split divides whatever is there by the ratio, so the
    // unit the price is in never enters into it.
    const pence = put({ name: 'GSK pence', ticker: 'GSK', market: 'LSE', shares_owned: 500, current_price: 1737.25, split_checked_through: '2022-07-01' });
    const pounds = put({ name: 'GSK pounds', ticker: 'GSK', market: 'LSE', shares_owned: 500, current_price: 17.3725, split_checked_through: '2022-07-01' });
    await run('2022-07-31');
    expect(rowOf(pence.id).shares_owned).toBe(400);
    expect(rowOf(pounds.id).shares_owned).toBe(400);
    expect(rowOf(pence.id).current_price / rowOf(pounds.id).current_price).toBeCloseTo(100, 6);
  });
});

describe('a split is applied exactly once, whatever happens', () => {
  it('six re-runs of GE\'s whole history leave 125 shares, not 125/8', async () => {
    const inv = put({
      ticker: 'GE', market: 'NYSE', shares_owned: 1_000,
      cost_basis: 40_000, current_price: 13.13, split_checked_through: '2018-01-01',
    });
    for (const d of ['2021-09-01', '2021-09-02', '2023-02-01', '2024-05-01', '2026-08-29', '2026-08-30']) {
      await run(d);
    }
    expect(rowOf(inv.id).shares_owned).toBe(125);
    expect(db.cgt_splits.length).toBe(1);
    expect(db.cgt_splits[0].ratio).toBe(0.125);
    // The three spin-off factors were seen six times each and moved nothing.
    expect(rowOf(inv.id).cost_basis).toBe(40_000);
  });

  it('two processes racing on the same split apply it once', async () => {
    const inv = put({
      ticker: 'TSLA', market: 'NASDAQ', shares_owned: 200,
      current_price: 891.29, split_checked_through: '2022-08-01',
    });
    const [a, b] = await Promise.all([run('2022-08-26'), run('2022-08-26')]);
    expect(rowOf(inv.id).shares_owned).toBe(600);
    expect(a.applied + b.applied).toBe(1);
    expect(db.cgt_splits.length).toBe(1);
  });

  it('a split the user recorded first is never applied again', async () => {
    // They saw the price drop, worked out what happened, and typed 6,000 in.
    const inv = put({
      ticker: 'AMZN', market: 'NASDAQ', shares_owned: 6_000,
      current_price: 122.35, split_checked_through: '2022-06-01',
    });
    db.cgt_splits.push({
      id: 'user-typed-it', user_id: 'u1', investment_id: inv.id, label: 'Amazon',
      ticker: 'AMZN', ratio: 20, recorded_at: '2022-06-08T09:14:00.000Z',
    });
    const r = await run('2022-06-20');
    expect(rowOf(inv.id).shares_owned).toBe(6_000);
    expect(r.applied).toBe(0);
    expect(rowOf(inv.id).split_checked_through).toBe('2022-06-20');
  });

  it('an edit landing mid-flight defers the split rather than overwriting it', async () => {
    const inv = put({
      ticker: 'CMG', market: 'NYSE', shares_owned: 10,
      current_price: 3_193.74, split_checked_through: '2024-06-01',
    });
    const stale = candidates();                 // read at 10 units
    rowOf(inv.id).shares_owned = 12;            // the user edits to 12
    const r = await syncSplits(stale, getYahooTicker, '2024-06-30T06:00:00.000Z');
    expect(r.applied).toBe(0);
    expect(rowOf(inv.id).shares_owned).toBe(12);
    // Crucially the watermark did NOT run on to today, so it is tried again.
    expect(rowOf(inv.id).split_checked_through).toBe('2024-06-01');

    const again = await run('2024-06-30');
    expect(again.applied).toBe(1);
    expect(rowOf(inv.id).shares_owned).toBe(600);
  });

  it('the book row is written under an id derived from the split, not minted', async () => {
    const inv = put({
      ticker: '7203', market: 'JPX', shares_owned: 300,
      current_price: 10_385, split_checked_through: '2021-09-01',
    });
    await run('2021-10-15');
    expect(rowOf(inv.id).shares_owned).toBe(1_500);
    expect(db.cgt_splits[0].id).toBe(splitRecordId(inv.id, '2021-09-29', 5));
    expect(db.cgt_splits[0].recorded_at).toBe(splitRecordedAt('2021-09-29'));
    expect(db.cgt_splits[0].recorded_at).toBe('2021-09-29T00:00:00.000Z');
  });

  it('a book row lost after the units moved is repaired without touching them', async () => {
    const inv = put({
      ticker: '6758', market: 'JPX', shares_owned: 100,
      current_price: 14_240, split_checked_through: '2024-09-01',
    });
    await run('2024-09-28');
    expect(rowOf(inv.id).shares_owned).toBe(500);
    db.cgt_splits = [];                       // the write never landed
    await run('2024-09-30');                  // inside the seven-day heal window
    expect(rowOf(inv.id).shares_owned).toBe(500);
    expect(db.cgt_splits.length).toBe(1);
  });

  it('nothing is applied retrospectively to a holding seen for the first time', async () => {
    const inv = put({
      ticker: 'NVDA', market: 'NASDAQ', shares_owned: 4_000,   // already post-split
      current_price: 121.79, split_checked_through: null,
    });
    const r = await run('2026-08-30');
    expect(r.firstSeen).toBe(1);
    expect(r.applied).toBe(0);
    expect(feedCalls).toBe(0);                // and it costs no request
    expect(rowOf(inv.id).shares_owned).toBe(4_000);
    expect(rowOf(inv.id).split_checked_through).toBe('2026-08-30');
  });
});

describe('cost, bounds and the whole book at once', () => {
  it('never writes cost_basis, on any path', async () => {
    for (const sym of ['AAPL', 'GE', 'SIRI', 'WMT', 'VOD.L', '9432.T']) {
      db.investments = []; db.cgt_splits = [];
      const events = eventsFor(sym);
      const inv = put({
        ticker: sym.replace(/\.[A-Z]+$/, ''), market: events[0].mkt,
        shares_owned: 800, cost_basis: 99_999.99, current_price: 40,
        split_checked_through: utcDay(Math.min(...events.map(e => e.at))).slice(0, 4) + '-01-01',
      });
      await run('2026-08-30');
      expect(rowOf(inv.id).cost_basis, sym).toBe(99_999.99);
    }
  });

  it('costs one request per holding per day and none on a second run', async () => {
    for (const sym of ['AAPL', 'NVDA', 'TSLA', 'WMT', 'GE']) {
      put({ ticker: sym, market: 'NASDAQ', split_checked_through: '2026-08-29' });
    }
    await run('2026-08-30');
    expect(feedCalls).toBe(5);
    await run('2026-08-30');
    expect(feedCalls).toBe(5);
    await run('2026-08-31');
    expect(feedCalls).toBe(10);
  });

  it('one bad ticker never stops the rest of the book', async () => {
    const good = put({ ticker: 'AAPL', market: 'NASDAQ', shares_owned: 100, current_price: 499.23, split_checked_through: '2020-08-01' });
    const bad = put({ ticker: 'DEAD', market: 'NASDAQ', shares_owned: 50, split_checked_through: '2020-08-01' });
    throwFor.add('DEAD');
    await run('2020-09-01');
    expect(rowOf(bad.id).shares_owned).toBe(50);
    expect(rowOf(good.id).shares_owned).toBe(400);
  });

  it('does nothing at all when the migration has not been run', async () => {
    put({ ticker: 'AAPL', market: 'NASDAQ', shares_owned: 400, split_checked_through: null });
    db.splitColumn = false;
    db.writes = 0;
    const r = await run('2020-09-01');
    expect(r).toEqual({ checked: 0, applied: 0, ignored: 0, review: 0, firstSeen: 0 });
    expect(db.writes).toBe(0);
    expect(feedCalls).toBe(0);
  });

  it('a whole portfolio of sixty-two holdings survives one pass unharmed', async () => {
    const syms = [...new Set(CENSUS.map(e => e.sym))];
    const made = syms.map(sym => {
      const events = eventsFor(sym);
      return put({
        name: sym, ticker: sym.replace(/\.[A-Z]+$/, ''), market: events[0].mkt,
        shares_owned: 1_000, cost_basis: 10_000, current_price: 100,
        split_checked_through: '2026-08-29',
      });
    });
    const r = await run('2026-08-30');
    expect(r.checked).toBe(made.length);          // Milan included, since CA-6
    expect(r.applied).toBe(0);
    for (const m of made) {
      expect(rowOf(m.id).shares_owned, m.name).toBe(1_000);
      expect(rowOf(m.id).cost_basis, m.name).toBe(10_000);
      expect(rowOf(m.id).current_price, m.name).toBe(100);
    }
  });
});
