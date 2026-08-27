/**
 * INVESTMENT / NET-WORTH STRESS TEST — the deterministic market.
 *
 * A seeded pseudo-market: two years of daily prices and FX for a handful of
 * synthetic assets, plus a ground-truth ledger that mirrors every simulated
 * action with independent arithmetic. The test drives the REAL data services
 * (investmentsDS, superDS, salesDS, moveOwnerBalance, calculateNetWorth) with
 * these paths and compares what the app reports against what the truth ledger
 * says must be true.
 *
 * Everything here is reproducible: same seed → same path → same failure. No
 * Date.now(), no Math.random(), no network. NOTHING touches a real user.
 */

/** Deterministic PRNG (mulberry32). Same seed, same sequence, every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One market regime: `days` of geometric drift + uniform noise. */
export interface Regime { days: number; drift: number; vol: number }

/**
 * The two-year macro script every asset path follows (with its own seed and
 * volatility scale): a rally, a flat year-half, a −45%-class crash, and a
 * choppy recovery. 730 daily steps + the day-0 price = 731 points.
 */
export const TWO_YEARS: Regime[] = [
  { days: 180, drift: +0.0009, vol: 0.010 },   // rally
  { days: 180, drift: 0.0,     vol: 0.008 },   // sideways
  { days: 65,  drift: -0.0120, vol: 0.025 },   // crash (~-45% cumulative)
  { days: 305, drift: +0.0012, vol: 0.012 },   // recovery, still choppy
];

/** FX script: calm first, then genuinely volatile (±1.8% daily shocks). */
export const FX_TWO_YEARS: Regime[] = [
  { days: 360, drift: 0.0,     vol: 0.004 },
  { days: 370, drift: +0.0002, vol: 0.018 },
];

export const SIM_DAYS = 730;

/**
 * The five-year macro script (1825 daily steps): rally, sideways, a fast −36%
 * crash, recovery, a long grind higher, a slow −40% bear, a choppy base and a
 * long recovery. Two full drawdowns, so nothing that only survives one cycle
 * gets through.
 */
export const FIVE_YEARS: Regime[] = [
  { days: 250, drift: +0.0008, vol: 0.010 },   // rally
  { days: 200, drift: 0.0,     vol: 0.008 },   // sideways
  { days: 45,  drift: -0.0100, vol: 0.030 },   // fast crash (~-36%)
  { days: 260, drift: +0.0012, vol: 0.012 },   // recovery
  { days: 300, drift: +0.0007, vol: 0.009 },   // grind higher
  { days: 90,  drift: -0.0055, vol: 0.022 },   // slow bear (~-40%)
  { days: 200, drift: 0.0,     vol: 0.014 },   // choppy base
  { days: 480, drift: +0.0009, vol: 0.011 },   // long recovery
];

/** Five-year FX script: calm, crash-driven slide, calm, a sharp 60-day shock
 *  (carry-unwind style), then permanently choppier. */
export const FX_FIVE_YEARS: Regime[] = [
  { days: 500, drift: 0.0,     vol: 0.004 },
  { days: 200, drift: +0.0004, vol: 0.012 },
  { days: 400, drift: 0.0,     vol: 0.006 },
  { days: 60,  drift: -0.0030, vol: 0.020 },
  { days: 665, drift: +0.0001, vol: 0.008 },
];

export const SIM_DAYS_5Y = 1825;

/**
 * A full price path: index 0 is the opening price, index d is the price after
 * day d's move. Prices are rounded to 4 dp (what a quote feed would carry)
 * and floored so a crash can never take a price to zero or negative.
 */
export function pricePath(
  seed: number, initial: number, regimes: Regime[], floor = 0.0001,
): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [round4(initial)];
  let p = initial;
  for (const r of regimes) {
    for (let i = 0; i < r.days; i++) {
      const shock = (rng() * 2 - 1) * r.vol;
      p = Math.max(floor, p * (1 + r.drift + shock));
      out.push(round4(p));
    }
  }
  return out;
}

/** An FX path clamped to a plausible band (USD→AUD style). */
export function fxPath(
  seed: number, initial: number, lo = 1.10, hi = 1.95,
  regimes: Regime[] = FX_TWO_YEARS,
): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [round4(initial)];
  let p = initial;
  for (const r of regimes) {
    for (let i = 0; i < r.days; i++) {
      const shock = (rng() * 2 - 1) * r.vol;
      p = Math.min(hi, Math.max(lo, p * (1 + r.drift + shock)));
      out.push(round4(p));
    }
  }
  return out;
}

export const round2 = (x: number): number => parseFloat(x.toFixed(2));
export const round4 = (x: number): number => parseFloat(x.toFixed(4));

// ── Ground truth ─────────────────────────────────────────────────────────────

/** One holding as the truth ledger tracks it. */
export interface TruthHolding {
  id: string;                    // the app row id, filled in after creation
  key: string;                   // sim key ("vas", "vts", …)
  units: number;
  path: number[] | null;         // native price path; null = fixed price
  fixedPrice: number;            // used when path is null (cash, private)
  fx: number[] | null;           // native→AUD path; null = AUD asset
  costNative: number;            // running cost basis in the native currency
  dividendPerUnit: number;       // per QUARTER, native currency; 0 = none
}

/**
 * The independent model of what the user is worth. Mirrors every simulated
 * action with its own arithmetic — same rounding rules as the app applies at
 * each surface (value per holding rounds to cents in AUD), but derived
 * directly from units × price × fx, never from app state.
 */
export class TruthLedger {
  holdings = new Map<string, TruthHolding>();
  bank = new Map<string, number>();  // account id → balance (AUD accounts only)
  superBalance = 0;

  priceOf(h: TruthHolding, day: number): number {
    return h.path ? h.path[day] : h.fixedPrice;
  }

  fxOf(h: TruthHolding, day: number): number {
    return h.fx ? h.fx[day] : 1;
  }

  /** A holding's AUD value on `day` — units × price × fx, rounded to cents. */
  holdingValue(h: TruthHolding, day: number): number {
    return round2(h.units * this.priceOf(h, day) * this.fxOf(h, day));
  }

  investmentsTotal(day: number): number {
    let t = 0;
    for (const h of this.holdings.values()) t += this.holdingValue(h, day);
    return t;
  }

  bankTotal(): number {
    let t = 0;
    for (const b of this.bank.values()) t += b;
    return t;
  }

  netWorth(day: number): number {
    return this.investmentsTotal(day) + this.bankTotal() + this.superBalance;
  }

  deposit(accountId: string, amount: number): void {
    this.bank.set(accountId, (this.bank.get(accountId) ?? 0) + amount);
  }
}

/** One recorded invariant violation, kept for the end-of-run report. */
export interface Violation {
  day: number;
  kind: string;
  detail: string;
  diff: number;
}

/** Collects violations without stopping the march, so one bad day can't hide
 *  the four hundred behind it. */
export class ViolationLog {
  all: Violation[] = [];
  check(day: number, kind: string, actual: number, expected: number, tol: number, detail = ''): void {
    const diff = actual - expected;
    if (!Number.isFinite(actual) || Math.abs(diff) > tol) {
      this.all.push({
        day, kind, diff: round2(diff),
        detail: `${detail} actual=${actual} expected=${expected}`,
      });
    }
  }
  /** First few violations, formatted for an assertion message. */
  report(max = 12): string {
    return this.all.slice(0, max)
      .map(v => `day ${v.day} [${v.kind}] diff=${v.diff} ${v.detail}`)
      .join('\n');
  }
}
