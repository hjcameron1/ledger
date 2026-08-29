/**
 * The one net-worth series behind the Overview chart, its percentage view and its
 * headline change.
 *
 * These used to be three separate calculations over two different sources — the raw
 * snapshot history and the structurally-adjusted one — which is how the page came to
 * show a net worth of $51,126.13 with "−884.29% (−$850.3K) this week" printed under
 * it. Two figures that cannot both be describing the same net worth. Everything the
 * user reads is now derived from a single series of dollar points, so the line, the
 * percentage and the number are the same statement said three ways.
 *
 * Two modes, chosen by the "ignore added/removed accounts" setting:
 *
 *   OFF → the recorded net worth, spikes and all. Adding an account really did put
 *         money in front of you, and this view says so.
 *   ON  → each snapshot's ORGANIC position: a structural add moves `value` and
 *         `base` together, so it cancels and only real gains and losses move the
 *         line. The result is then PINNED to today's live net worth, because the
 *         organic total also carries the frozen value of items that have left — a
 *         constant offset that would otherwise leave the line hovering thousands of
 *         dollars away from the figure at the top of the page. Shifting every point
 *         by one constant changes no movement, only the axis it is read against.
 */

/** A point of the structurally-adjusted series (backend `AdjustedNwPoint`). */
export interface AdjustedSeriesPoint {
  recorded_at: string;
  value: number;
  base: number;
}

/** The adjusted series as the backend returns it. */
export interface AdjustedSeries {
  points: AdjustedSeriesPoint[];
  /** Capital base of the current live item set (incl. frozen removed items). */
  currentBase: number;
  /** Raw net worth of the current live item set, for reconciling client-only rows. */
  currentValue?: number;
  /** Frozen value of removed items. */
  carryValue?: number;
}

/** A point of the raw recorded history. */
export interface RawSeriesPoint {
  recorded_at: string;
  value: number;
}

export interface NetWorthSeriesInput {
  /** Already filtered to the selected timeframe: [0] is the window start. */
  adjusted: AdjustedSeries | null;
  /** Raw recorded history, likewise windowed. */
  history: RawSeriesPoint[];
  /** Live net worth — the figure at the top of the page. `null` means it hasn't
   *  been computed yet (still loading); 0 is a REAL reading — a user whose
   *  assets exactly cover their debts — and is plotted and measured like any
   *  other value (F5). */
  liveNetWorth: number | null;
  /** The user's "ignore added/removed accounts" setting. */
  excludeStructural: boolean;
  nowMs: number;
}

export interface NetWorthSeries {
  /** Whether structural adjustment is actually in effect. */
  adjusted: boolean;
  /** The series, in dollars. Its last point IS the live net worth. */
  points: { x: number; y: number }[];
  /** The same line as a percentage of its own window start. */
  pctPoints: { x: number; y: number }[];
  /** Where the line starts — the net worth this period is measured from. */
  startValue: number;
  /** liveNetWorth − startValue. */
  amount: number;
  /** amount as a % of startValue, or null when there is nothing to measure from. */
  pct: number | null;
}

export function buildNetWorthSeries(input: NetWorthSeriesInput): NetWorthSeries {
  const { adjusted, history, liveNetWorth, excludeStructural, nowMs } = input;

  // Loaded or not is the ONLY gate — never truthiness. A live net worth of
  // exactly $0 (assets covering debts to the cent) is a real reading that must
  // end the line and be measured against, not treated as missing data (F5).
  const hasLive = liveNetWorth != null && Number.isFinite(liveNetWorth);

  // Adjusted mode needs a series to draw; without one, fall back to the honest
  // recorded history rather than inventing a line.
  //
  // The gate used to be `currentBase > 0`, which silently switched the setting off
  // for anyone whose capital base is negative — someone tracking a student loan and
  // a card before any assets, exactly the person for whom "ignore accounts I added"
  // matters most. They flicked the toggle and nothing happened, with no explanation.
  // A negative base is a perfectly good base: the line is drawn in DOLLARS, and the
  // percentage below is measured against the SIZE of the starting position (see
  // pctOf), so nothing here needs the base to be positive — only present and finite.
  const useAdj =
    excludeStructural && !!adjusted &&
    adjusted.points.length > 0 && Number.isFinite(adjusted.currentBase);

  // Reconcile the backend base against the LIVE net worth. The adjusted series only
  // knows items the backend has snapshotted, but the live total can include accounts
  // that live only in the client store — e.g. Basiq-synced sandbox accounts never
  // written to the DB. That gap is ADDED CAPITAL, not a gain, so fold it into the
  // base: it then contributes 0 organic movement and adding or unhiding such an
  // account can't spike the change.
  const live = hasLive ? liveNetWorth : 0;
  const trackedValue = adjusted?.currentValue ?? live;
  const untrackedCapital = hasLive ? live - trackedValue : 0;
  const currentBase = (adjusted?.currentBase ?? 0) + untrackedCapital;
  // A removed item's last value is frozen into carryValue so its accumulated
  // gain/loss doesn't snap out of the total when it goes. Add it back to the live
  // value, exactly as currentBase already carries its frozen base.
  const carryValue = useAdj ? (adjusted?.carryValue ?? 0) : 0;
  const effectiveLive = live + carryValue;

  const refBase = adjusted?.points?.[0]?.base ?? 0;
  const organic = (value: number, base: number) => value - (base - refBase);
  const shift = useAdj && hasLive ? live - organic(effectiveLive, currentBase) : 0;

  const points = useAdj
    ? adjusted!.points.map(p => ({
        x: new Date(p.recorded_at).getTime(),
        y: organic(p.value, p.base) + shift,
      }))
    : history.map(p => ({ x: new Date(p.recorded_at).getTime(), y: p.value }));

  // End on the live figure. A snapshot within the last minute IS now, so overwrite it
  // rather than drawing two points on top of each other.
  if (hasLive) {
    const last = points[points.length - 1];
    if (!last || nowMs - last.x > 60 * 1000) points.push({ x: nowMs, y: live });
    else last.y = live;
  }

  const startValue = points[0]?.y ?? 0;
  const amount = hasLive ? live - startValue : 0;

  // Percentages are measured against the SIZE of the starting position, so the
  // sign always agrees with the dollar change: recovering from −$10k to −$5k is
  // +50%, not −50% (F6 — dividing by a negative start flipped every reading for
  // the whole stretch a geared user spent underwater).
  const pctOf = (delta: number) => (delta / Math.abs(startValue)) * 100;

  return {
    adjusted: useAdj,
    points,
    pctPoints: points.map(p => ({
      x: p.x,
      y: startValue !== 0 ? parseFloat(pctOf(p.y - startValue).toFixed(4)) : 0,
    })),
    startValue,
    amount,
    pct: startValue !== 0 && hasLive ? parseFloat(pctOf(amount).toFixed(2)) : null,
  };
}
