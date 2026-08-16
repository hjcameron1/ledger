/**
 * Pure builders for the Chart.js `data` objects behind the two line graphs —
 * Overview's net-worth trend and Forecast's projected cash balance.
 *
 * Extracted from the page components so the part that decides WHAT the graph shows
 * — the plotted series, the up/down colour, and the point markers that distinguish
 * "actual" from "projected" — is unit-testable without rendering a `<canvas>`
 * (jsdom can't rasterise Chart.js, and the values can't be read back out of a
 * canvas). The gradient `backgroundColor` stays a callback because it needs the live
 * canvas context; everything a correctness test cares about is plain data.
 *
 * PURE — no store, no React, no canvas — so the mapping is deterministic and tested.
 */

/** Chart.js passes this to a scriptable option; only used by the gradient fill. */
type ScriptableCtx = {
  chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } };
};

// ── Net-worth trend (Overview) ────────────────────────────────────────────────

/** A net-worth series point in Chart.js time-scale form. */
export interface NetWorthPoint { x: number; y: number; }

export const NW_UP_COLOR = '#22c55e';
export const NW_DOWN_COLOR = '#ef4444';

/**
 * The net-worth line's Chart.js `data`. Colour follows the headline period change
 * (`up`) so the line and the number can never contradict each other; point markers
 * appear only while the series is sparse (≤6) so a one/two-point history still reads
 * as data instead of a blank chart.
 */
export function buildNetWorthChartData(points: NetWorthPoint[], up: boolean) {
  const color = up ? NW_UP_COLOR : NW_DOWN_COLOR;
  return {
    datasets: [{
      data: points,
      borderColor: color,
      backgroundColor: (ctx: ScriptableCtx) => {
        const area = ctx.chart.chartArea;
        if (!area) return up ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, up ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      },
      borderWidth: 2.5,
      pointRadius: points.length <= 6 ? 3 : 0,
      pointHoverRadius: 4,
      cubicInterpolationMode: 'monotone' as const,
      fill: true,
    }],
  };
}

// ── Projected cash balance (Forecast) ─────────────────────────────────────────

/** A forecast series point: a date label and the projected running balance. */
export interface ForecastSeriesPoint { date: string; balance: number; }

export const FORECAST_OK_COLOR = '#3b7dd8';
export const FORECAST_NEGATIVE_COLOR = '#ef4444';

/**
 * The forecast line's Chart.js `data`. The whole line is dashed (it is a
 * projection); only the left-edge "today" point (index 0) gets a solid dot, since
 * that opening balance is the one actual figure. The line turns red when the
 * projected balance dips below zero at any point in the horizon (liquidity risk).
 */
export function buildForecastChartData(series: ForecastSeriesPoint[], dipsNegative: boolean) {
  const lineColor = dipsNegative ? FORECAST_NEGATIVE_COLOR : FORECAST_OK_COLOR;
  return {
    labels: series.map(s => s.date),
    datasets: [{
      data: series.map(s => s.balance),
      borderColor: lineColor,
      borderDash: [5, 4],
      borderWidth: 2,
      stepped: true as const,
      pointRadius: series.map((_, i) => (i === 0 ? 4 : 0)),
      pointBackgroundColor: lineColor,
      pointHoverRadius: 4,
      backgroundColor: (ctx: ScriptableCtx) => {
        const area = ctx.chart.chartArea;
        if (!area) return 'rgba(59,125,216,0.10)';
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, dipsNegative ? 'rgba(239,68,68,0.18)' : 'rgba(59,125,216,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      },
      fill: true,
    }],
  };
}
