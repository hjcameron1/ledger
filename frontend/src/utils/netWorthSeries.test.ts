import { describe, it, expect } from 'vitest';
import { buildNetWorthSeries, type NetWorthSeriesInput } from './netWorthSeries';

/**
 * The chart, the percentage and the "this week" line are one series or they are a
 * bug. The screen that prompted this read:
 *
 *     Total net worth   $51,126.13
 *     −884.29% (−$850.3K) this week
 *
 * — a headline and a change that could not both be about the same net worth. Every
 * test here is really the same assertion from a different angle: whatever the line
 * does, the number says, and both end on the figure at the top of the page.
 */

const NOW = new Date('2026-08-18T08:00:00Z').getTime();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

// Default liveNetWorth is null ("not computed yet") — 0 is a REAL net worth
// that gets plotted and measured (F5), so "no net worth" is spelled null.
const build = (o: Partial<NetWorthSeriesInput> = {}) =>
  buildNetWorthSeries({
    adjusted: null,
    history: [],
    liveNetWorth: null,
    excludeStructural: true,
    nowMs: NOW,
    ...o,
  });

const last = <T>(a: T[]) => a[a.length - 1];

describe('with structural adjustment off', () => {
  const history = [
    { recorded_at: at(72), value: 58_876 },
    { recorded_at: at(36), value: 55_000 },
  ];

  it('plots the net worth that was actually recorded', () => {
    const s = build({ history, liveNetWorth: 51_126, excludeStructural: false });
    expect(s.adjusted).toBe(false);
    expect(s.points.map(p => p.y)).toEqual([58_876, 55_000, 51_126]);
  });

  it('measures the change between the two ends of that line', () => {
    const s = build({ history, liveNetWorth: 51_126, excludeStructural: false });
    expect(s.startValue).toBe(58_876);
    expect(s.amount).toBe(-7_750);
    expect(s.pct).toBeCloseTo(-13.16, 2);
  });
});

describe('with structural adjustment on', () => {
  // A house was added at 1.1m, restated to 250k, then switched out of net worth —
  // and its 850k "loss" was frozen into the carry, where it dragged the headline
  // down by $850.3K for good even though net worth had gone nowhere near it.
  const adjusted = {
    points: [
      { recorded_at: at(72), value: 96_155, base: 95_704 },
      { recorded_at: at(36), value: 96_000, base: 95_704 },
    ],
    currentBase: 104_988,
    currentValue: 51_126,
    carryValue: 54_103,
  };

  it('ends on the live net worth, not on the frozen ghosts of what has left', () => {
    const s = build({ adjusted, liveNetWorth: 51_126 });
    expect(s.adjusted).toBe(true);
    expect(last(s.points).y).toBe(51_126);
  });

  it('reads as real dollars the whole way, not net worth plus a carry', () => {
    // Before pinning, this line sat ~$45k above the headline for its whole length.
    const s = build({ adjusted, liveNetWorth: 51_126 });
    for (const p of s.points) expect(Math.abs(p.y - 51_126)).toBeLessThan(2_000);
  });

  it('reports the real week, not the departed house', () => {
    const s = build({ adjusted, liveNetWorth: 51_126 });
    expect(s.amount).toBeCloseTo(-210, 0);   // not −850,210
    expect(s.pct).toBeCloseTo(-0.41, 1);     // not −884.29%
  });

  it('falls back to the recorded history when there is no adjusted series to draw', () => {
    // Restated: the gate was `currentBase > 0`, which also switched adjusted mode off
    // for every user whose base is negative or exactly zero even though their series
    // was perfectly drawable. An EMPTY series is the real "nothing to draw" case.
    const s = build({
      adjusted: { ...adjusted, points: [], currentBase: 0 },
      history: [{ recorded_at: at(72), value: 58_876 }],
      liveNetWorth: 51_126,
    });
    expect(s.adjusted).toBe(false);
    expect(s.points.map(p => p.y)).toEqual([58_876, 51_126]);
  });
});

describe('underwater — a base below zero is still a base', () => {
  // Someone tracking a student loan and a credit card before any assets, climbing
  // out of it. `currentBase > 0` used to switch adjusted mode off for this person
  // entirely: the toggle did nothing, and the % line the API sent was inverted on
  // top of it. Both are the same mistake — treating a negative base as no base.
  const adjusted = {
    points: [
      { recorded_at: at(72), value: -40_000, base: -40_000 },
      { recorded_at: at(36), value: -18_000, base: -40_000 },
    ],
    currentBase: -40_000,
    currentValue: -6_000,
    carryValue: 0,
  };

  it('draws the adjusted line instead of silently ignoring the setting', () => {
    const s = build({ adjusted, liveNetWorth: -6_000 });
    expect(s.adjusted).toBe(true);
    expect(last(s.points).y).toBe(-6_000);
  });

  it('climbing out of debt reads as a gain, in dollars and in percent', () => {
    const s = build({ adjusted, liveNetWorth: -6_000 });
    expect(s.startValue).toBe(-40_000);
    expect(s.amount).toBe(34_000);
    expect(s.pct).toBeCloseTo(85, 2);          // +85%, never −85%
    const pcts = s.pctPoints.map(p => p.y);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
  });
});

describe('structural events', () => {
  it('adding an account mid-window leaves the change flat', () => {
    // base rises with value when capital arrives, so the two cancel.
    const s = build({
      adjusted: {
        points: [
          { recorded_at: at(72), value: 10_000, base: 10_000 },
          { recorded_at: at(36), value: 15_000, base: 15_000 },  // +5,000 added
        ],
        currentBase: 15_000,
        currentValue: 15_000,
        carryValue: 0,
      },
      liveNetWorth: 15_000,
    });
    expect(s.amount).toBe(0);
    expect(s.pct).toBe(0);
  });

  it('a genuine gain still moves it', () => {
    const s = build({
      adjusted: {
        points: [
          { recorded_at: at(72), value: 10_000, base: 10_000 },
          { recorded_at: at(36), value: 10_500, base: 10_000 },
        ],
        currentBase: 10_000,
        currentValue: 11_000,
        carryValue: 0,
      },
      liveNetWorth: 11_000,
    });
    expect(s.amount).toBe(1_000);
    expect(s.pct).toBeCloseTo(10, 2);
  });

  it('capital the backend has never snapshotted is capital, not a gain', () => {
    // A client-only account (Basiq sandbox) makes liveNetWorth exceed what the
    // series tracks. That gap must fold into the base, not read as a windfall.
    const s = build({
      adjusted: {
        points: [{ recorded_at: at(72), value: 10_000, base: 10_000 }],
        currentBase: 10_000,
        currentValue: 10_000,
        carryValue: 0,
      },
      liveNetWorth: 17_000,
    });
    expect(s.amount).toBe(0);
  });
});

describe('the % view and the $ view are the same line', () => {
  const input = {
    adjusted: {
      points: [
        { recorded_at: at(72), value: 100_000, base: 100_000 },
        { recorded_at: at(36), value: 104_000, base: 100_000 },
      ],
      currentBase: 100_000,
      currentValue: 105_000,
      carryValue: 0,
    },
    liveNetWorth: 105_000,
  };

  it('starts at 0% and ends on the headline percentage', () => {
    const s = build(input);
    expect(s.pctPoints[0].y).toBe(0);
    expect(last(s.pctPoints).y).toBeCloseTo(s.pct!, 2);
  });

  it('agrees point for point with the dollar line', () => {
    const s = build(input);
    s.points.forEach((p, i) => {
      expect(s.pctPoints[i].y).toBeCloseTo(((p.y - s.startValue) / s.startValue) * 100, 4);
      expect(s.pctPoints[i].x).toBe(p.x);
    });
  });

  it('never disagrees with the headline about up or down', () => {
    for (const live of [90_000, 100_000, 130_000]) {
      const s = build({ ...input, liveNetWorth: live });
      expect(Math.sign(last(s.pctPoints).y)).toBe(Math.sign(s.amount));
    }
  });
});

describe('edges', () => {
  it('survives having no history at all', () => {
    const s = build({ liveNetWorth: 51_126 });
    expect(s.points).toEqual([{ x: NOW, y: 51_126 }]);
    expect(s.startValue).toBe(51_126);
    expect(s.amount).toBe(0);
    expect(s.pct).toBe(0);
  });

  it('has nothing to report with no data and no net worth', () => {
    const s = build();
    expect(s.points).toEqual([]);
    expect(s.pct).toBeNull();
    expect(s.pctPoints).toEqual([]);
  });

  it('overwrites a snapshot from seconds ago rather than drawing two "now"s', () => {
    const s = build({
      history: [{ recorded_at: at(72), value: 50_000 }, { recorded_at: new Date(NOW - 5_000).toISOString(), value: 50_900 }],
      liveNetWorth: 51_126,
      excludeStructural: false,
    });
    expect(s.points).toHaveLength(2);
    expect(last(s.points).y).toBe(51_126);
  });
});

describe('an All Time series whose points get denser towards today', () => {
  /**
   * Compacted history is not evenly spaced. The backend keeps every reading for a
   * fortnight, one a day for the year behind that, and one a month (plus that
   * month's high and low) beyond it — so an all-time series is months apart at the
   * left-hand end and an hour apart at the right. Nothing here may assume otherwise:
   * points carry their own instant, the line is drawn against time, and the change
   * is measured between the two ends whatever the gap between them is.
   */
  const YEAR = 365 * 24;
  const history = [
    { recorded_at: at(20 * YEAR), value: 120_000 },   // twenty years ago, monthly grain
    { recorded_at: at(19 * YEAR), value: 190_000 },
    { recorded_at: at(10 * YEAR), value: 410_000 },
    { recorded_at: at(2 * YEAR), value: 700_000 },
    { recorded_at: at(48), value: 968_000 },          // …then daily
    { recorded_at: at(24), value: 974_000 },
    { recorded_at: at(2), value: 979_000 },           // …then hourly
    { recorded_at: at(1), value: 980_000 },
  ];

  it('plots each point at its own instant, however far apart they are', () => {
    const s = build({ history, liveNetWorth: 981_000, excludeStructural: false });
    expect(s.points.map(p => p.x)).toEqual([
      ...history.map(h => new Date(h.recorded_at).getTime()), NOW,
    ]);
    expect(s.points.map(p => p.y)).toEqual([...history.map(h => h.value), 981_000]);
  });

  it('measures the change across the whole span, not across the last few points', () => {
    const s = build({ history, liveNetWorth: 981_000, excludeStructural: false });
    expect(s.startValue).toBe(120_000);
    expect(s.amount).toBe(861_000);
    expect(s.pct).toBeCloseTo(717.5, 1);
  });

  it('rises monotonically in percent, with no step where the grain changes', () => {
    const s = build({ history, liveNetWorth: 981_000, excludeStructural: false });
    const ys = s.pctPoints.map(p => p.y);
    expect(ys[0]).toBe(0);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });

  it('is just as happy when the adjusted series is the one being drawn', () => {
    const adjusted = {
      points: history.map(h => ({ recorded_at: h.recorded_at, value: h.value, base: 120_000 })),
      currentBase: 120_000,
      currentValue: 980_000,
      carryValue: 0,
    };
    const s = build({ adjusted, history, liveNetWorth: 981_000, excludeStructural: true });
    expect(s.adjusted).toBe(true);
    expect(s.points).toHaveLength(history.length + 1);
    expect(last(s.points).y).toBe(981_000);
  });
});
