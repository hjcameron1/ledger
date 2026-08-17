/**
 * Render-layer tests: prove each line graph is FED the correct information — the
 * plotted series matches the engine output, the colour reflects up/down (net worth)
 * or liquidity risk (forecast), and the point markers distinguish actual vs
 * projected / sparse vs dense. These lock the mapping the page components hand to
 * Chart.js. (Canvas pixels aren't rasterised in jsdom, so we assert the data config
 * — which is what determines what the user sees.)
 */
import { describe, it, expect } from 'vitest';
import {
  buildNetWorthChartData, buildForecastChartData, buildForecastChartOptions,
  NW_UP_COLOR, NW_DOWN_COLOR, FORECAST_OK_COLOR, FORECAST_NEGATIVE_COLOR,
  FORECAST_POINT_HIT_RADIUS,
  type NetWorthPoint, type ForecastSeriesPoint,
} from './chartData';

const nwPts = (ys: number[]): NetWorthPoint[] => ys.map((y, i) => ({ x: i * 86_400_000, y }));

describe('net-worth chart data', () => {
  it('plots exactly the given series', () => {
    const pts = nwPts([100, 120, 140]);
    const ds = buildNetWorthChartData(pts, true).datasets[0];
    expect(ds.data).toBe(pts);                         // same points, no reshaping
    expect(ds.data.map(p => p.y)).toEqual([100, 120, 140]);
  });

  it('is green when up, red when down — colour can never contradict the headline', () => {
    expect(buildNetWorthChartData(nwPts([100, 130]), true).datasets[0].borderColor).toBe(NW_UP_COLOR);
    expect(buildNetWorthChartData(nwPts([130, 100]), false).datasets[0].borderColor).toBe(NW_DOWN_COLOR);
  });

  it('shows point markers while the series is sparse (≤6) and hides them once dense', () => {
    expect(buildNetWorthChartData(nwPts([1, 2]), true).datasets[0].pointRadius).toBe(3);
    expect(buildNetWorthChartData(nwPts(Array.from({ length: 6 }, (_, i) => i)), true).datasets[0].pointRadius).toBe(3);
    expect(buildNetWorthChartData(nwPts(Array.from({ length: 7 }, (_, i) => i)), true).datasets[0].pointRadius).toBe(0);
  });

  it('uses non-overshooting monotone interpolation (no backward curl at a spike)', () => {
    expect(buildNetWorthChartData(nwPts([1, 9, 2]), true).datasets[0].cubicInterpolationMode).toBe('monotone');
  });

  it('the gradient fill is a live-canvas callback with a safe no-context fallback', () => {
    const ds = buildNetWorthChartData(nwPts([1, 2]), true).datasets[0];
    expect(typeof ds.backgroundColor).toBe('function');
    expect((ds.backgroundColor as any)({ chart: { ctx: {} } })).toBe('rgba(34,197,94,0.12)'); // up → green fallback
    expect((buildNetWorthChartData(nwPts([2, 1]), false).datasets[0].backgroundColor as any)({ chart: { ctx: {} } }))
      .toBe('rgba(239,68,68,0.12)');                   // down → red fallback
  });
});

describe('forecast chart data', () => {
  const series: ForecastSeriesPoint[] = [
    { date: '2026-08-13', balance: 1000 },
    { date: '2026-08-20', balance: 800 },
    { date: '2026-08-27', balance: 600 },
  ];

  it('maps the series to labels (dates) and data (balances) in order', () => {
    const d = buildForecastChartData(series, false);
    expect(d.labels).toEqual(['2026-08-13', '2026-08-20', '2026-08-27']);
    expect(d.datasets[0].data).toEqual([1000, 800, 600]);
  });

  it('marks ONLY the left-edge "today" point solid (index 0); the rest are dotless', () => {
    const pr = buildForecastChartData(series, false).datasets[0].pointRadius;
    expect(pr).toEqual([4, 0, 0]);
  });

  it('the whole projected line is dashed', () => {
    expect(buildForecastChartData(series, false).datasets[0].borderDash).toEqual([5, 4]);
  });

  it('is blue normally and turns red when the balance dips below zero (liquidity risk)', () => {
    expect(buildForecastChartData(series, false).datasets[0].borderColor).toBe(FORECAST_OK_COLOR);
    const dipped = [...series, { date: '2026-09-03', balance: -200 }];
    expect(buildForecastChartData(dipped, true).datasets[0].borderColor).toBe(FORECAST_NEGATIVE_COLOR);
  });

  it('an empty forecast produces empty labels/data (renders as no line, not a crash)', () => {
    const d = buildForecastChartData([], false);
    expect(d.labels).toEqual([]);
    expect(d.datasets[0].data).toEqual([]);
    expect(d.datasets[0].pointRadius).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Forecast chart INTERACTION — how easy the line is to inspect
// ═════════════════════════════════════════════════════════════════════════════
describe('forecast chart interaction', () => {
  const options = () => buildForecastChartOptions({
    formatDate: iso => `date:${iso}`,
    formatMoney: v => `$${v.toFixed(2)}`,
    formatAxisMoney: v => `$${Math.round(v / 1000)}K`,
  });

  it('does not require the pointer to touch the line', () => {
    // `intersect: false` is the whole fix: with it true, the hit test only
    // succeeds when the cursor is literally over the geometry, which on a
    // 2px dashed line is a pixel-perfect target.
    const o = options();
    expect(o.interaction.intersect).toBe(false);
    expect(o.hover.intersect).toBe(false);
    expect(o.plugins.tooltip.intersect).toBe(false);
  });

  it('picks the nearest DATE, measuring horizontally only', () => {
    const o = options();
    expect(o.interaction.mode).toBe('index');
    expect(o.interaction.axis).toBe('x');
    // Hover and tooltip must agree, or the highlighted point and the tooltip
    // can describe different days.
    expect(o.hover.mode).toBe('index');
    expect(o.plugins.tooltip.mode).toBe('index');
  });

  it('gives every point a generous, INVISIBLE hit target', () => {
    const d = buildForecastChartData(
      Array.from({ length: 90 }, (_, i) => ({ date: `2026-08-${i + 1}`, balance: 100 })), false,
    );
    // Large enough to scrub across and to hit with a fingertip…
    expect(d.datasets[0].pointHitRadius).toBe(FORECAST_POINT_HIT_RADIUS);
    expect(FORECAST_POINT_HIT_RADIUS).toBeGreaterThanOrEqual(20);
    // …while the chart still shows one dot (today) rather than 90 beads.
    const visible = (d.datasets[0].pointRadius as number[]).filter(r => r > 0);
    expect(visible).toHaveLength(1);
  });

  it('shows the date and the dollar balance in the tooltip', () => {
    const cb = options().plugins.tooltip.callbacks;
    expect(cb.title([{ label: '2026-09-01' }])).toBe('date:2026-09-01');
    expect(cb.label({ raw: 1234.5 })).toBe('Balance: $1234.50');
  });

  it('survives an empty tooltip payload rather than throwing mid-hover', () => {
    expect(() => options().plugins.tooltip.callbacks.title([])).not.toThrow();
  });

  it('keeps the axis formatting the page had', () => {
    const y = options().scales.y.ticks;
    expect(y.callback(12_000)).toBe('$12K');
  });
});
