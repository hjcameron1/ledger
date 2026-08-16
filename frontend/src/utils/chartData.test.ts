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
  buildNetWorthChartData, buildForecastChartData,
  NW_UP_COLOR, NW_DOWN_COLOR, FORECAST_OK_COLOR, FORECAST_NEGATIVE_COLOR,
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
