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
 * How far from a point counts as hovering it, in pixels. Generous on purpose:
 * a projection is read by scrubbing along it, not by aiming at one date, and a
 * hit radius costs nothing visually. Comfortably larger than a fingertip too,
 * which is what makes the same chart usable by touch.
 */
export const FORECAST_POINT_HIT_RADIUS = 24;

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
      pointHoverRadius: 5,
      // The invisible half of the hit target. `pointRadius` is what the user
      // SEES (0 for all but today, so a 90-day line isn't a string of beads);
      // `pointHitRadius` is what the user has to hit, and it renders nothing.
      // Together with the index-mode interaction below, this turns a chart you
      // had to trace exactly into one you can scrub across.
      pointHitRadius: FORECAST_POINT_HIT_RADIUS,
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

/**
 * The forecast chart's Chart.js `options`.
 *
 * Lives here rather than inline in the page for the same reason the `data` does:
 * the interaction settings below are the difference between a chart you can read
 * and one you can't, and they are worth a test that doesn't need a canvas.
 *
 * The hover behaviour is the point:
 *
 *   mode: 'index'      hovering anywhere in the plot picks the nearest DATE and
 *                      shows its balance, rather than requiring the pointer to
 *                      find the line itself. On a stepped 90-day projection the
 *                      line spends most of its length flat, so "near the line
 *                      vertically" was a very thin target.
 *   intersect: false   the pointer no longer has to touch the geometry at all —
 *                      this is what removes the pixel-perfect placement.
 *   axis: 'x'          distance is measured horizontally only, so moving up and
 *                      down within a column never switches dates.
 *
 * Calculations are untouched: this configures presentation only, over whatever
 * series `buildForecastChartData` was given.
 */
export function buildForecastChartOptions(opts: {
  formatDate: (iso: string) => string;
  formatMoney: (value: number) => string;
  formatAxisMoney: (value: number) => string;
}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    // Applies to hover AND tooltips, so the two can never disagree about which
    // point is being inspected.
    interaction: { mode: 'index' as const, intersect: false, axis: 'x' as const },
    hover: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: 'index' as const,
        intersect: false,
        // Follow the pointer rather than pinning to the point: on a flat stretch
        // the nearest point can be far away horizontally, and a tooltip that
        // jumps to it reads as the wrong date being highlighted.
        position: 'nearest' as const,
        displayColors: false,
        padding: 10,
        callbacks: {
          title: (items: { label: string }[]) => opts.formatDate(items[0]?.label ?? ''),
          label: (item: { raw: unknown }) => `Balance: ${opts.formatMoney(Number(item.raw))}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          maxTicksLimit: 6, maxRotation: 0, autoSkip: true,
          color: '#9ca3af', font: { size: 11 },
          callback(this: { getLabelForValue(v: number): string }, value: number) {
            const raw = this.getLabelForValue(value as number);
            const d = new Date(`${raw}T00:00:00Z`);
            return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
          },
        },
      },
      y: {
        grid: { color: 'rgba(120,120,120,0.12)' },
        ticks: {
          color: '#9ca3af', font: { size: 11 },
          callback: (value: number) => opts.formatAxisMoney(Number(value)),
        },
      },
    },
  };
}
