/**
 * The charts' half of the same law: A VIEW CHANGES HOW A CHART IS DRAWN, NEVER
 * WHAT IT PLOTS.
 *
 * These tests hold the two views apart (they must actually look different) while
 * pinning the things that must NOT move between them — the plotted window, and
 * the fact that every tick label still comes from the caller's own formatter.
 * Canvas can't be read back in jsdom, so the options object is the only place
 * this is checkable at all.
 */

import { describe, it, expect } from 'vitest';
import {
  lineStyle, gridStyle, tickStyle, tooltipStyle, trendScales, doughnutStyle,
  MONO_FONT,
} from './chartTheme';

describe('the line', () => {
  it('technical draws the segments between actual readings — no invented curve', () => {
    const s = lineStyle('technical', 30) as Record<string, unknown>;
    expect(s.tension).toBe(0);
    expect(s.cubicInterpolationMode).toBeUndefined();
    expect(s.fill).toBe(false);
  });

  it('peaceful keeps the soft filled curve the app already had', () => {
    const s = lineStyle('peaceful', 30) as Record<string, unknown>;
    expect(s.cubicInterpolationMode).toBe('monotone');
    expect(s.fill).toBe(true);
    expect(s.borderWidth).toBe(2.5);
  });

  it('technical shows the readings themselves, up to a sane density', () => {
    expect((lineStyle('technical', 30) as { pointRadius: number }).pointRadius).toBeGreaterThan(0);
    expect((lineStyle('technical', 400) as { pointRadius: number }).pointRadius).toBe(0);
  });

  it('peaceful only marks points while the series is too sparse to read as a line', () => {
    expect((lineStyle('peaceful', 3) as { pointRadius: number }).pointRadius).toBe(3);
    expect((lineStyle('peaceful', 30) as { pointRadius: number }).pointRadius).toBe(0);
  });
});

describe('the frame', () => {
  it('technical gridlines are dashed graph-paper, not solid rules', () => {
    expect(gridStyle('technical').borderDash).toEqual([3, 3]);
  });

  it('a hidden grid stays hidden in both views', () => {
    expect(gridStyle('technical', false).display).toBe(false);
    expect(gridStyle('peaceful', false).display).toBe(false);
  });

  it('technical ticks are monospaced, so digits line up column-wise', () => {
    expect(tickStyle('technical').font).toBe(MONO_FONT);
    expect(tickStyle('peaceful').font).not.toBe(MONO_FONT);
  });

  it('technical tooltips are square and mono; peaceful ones are rounded', () => {
    expect((tooltipStyle('technical') as { cornerRadius: number }).cornerRadius).toBeLessThan(4);
    expect((tooltipStyle('peaceful') as { cornerRadius: number }).cornerRadius).toBeGreaterThan(6);
  });
});

describe('a trend chart', () => {
  const opts = {
    min: 1_000, max: 9_000,
    formatX: (ms: number) => `x:${ms}`,
    formatY: (v: number) => `y:${v}`,
  };

  it('peaceful hides the axes entirely — the headline above carries the number', () => {
    const s = trendScales('peaceful', opts) as any;
    expect(s.x.display).toBe(false);
    expect(s.y.display).toBe(false);
  });

  it('technical shows both, and reads off the right-hand edge', () => {
    const s = trendScales('technical', opts) as any;
    expect(s.x.display).toBe(true);
    expect(s.y.display).toBe(true);
    expect(s.y.position).toBe('right');
  });

  it('plots the SAME window either way — the view never changes what you are looking at', () => {
    for (const mode of ['technical', 'peaceful'] as const) {
      const s = trendScales(mode, opts) as any;
      expect(s.x.type).toBe('linear');
      expect(s.x.min).toBe(1_000);
      expect(s.x.max).toBe(9_000);
    }
  });

  it("labels its ticks with the caller's formatters, never its own idea of the value", () => {
    const s = trendScales('technical', opts) as any;
    expect(s.x.ticks.callback(1_234)).toBe('x:1234');
    expect(s.y.ticks.callback('56')).toBe('y:56');
  });
});

describe('a doughnut', () => {
  it('is a thin measured ring in technical and a fat rounded one in peaceful', () => {
    expect(doughnutStyle('technical').cutout).toBe('76%');
    expect(doughnutStyle('peaceful').cutout).toBe('62%');
    expect(doughnutStyle('peaceful').elements.arc.borderRadius).toBeGreaterThan(0);
    expect(doughnutStyle('technical').elements.arc.borderRadius).toBe(0);
  });
});
