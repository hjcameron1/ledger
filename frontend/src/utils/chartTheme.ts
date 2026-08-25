/**
 * How a chart is DRAWN in each view — the shared half of every Chart.js config.
 *
 *   'technical'  axes, dashed gridlines, monospaced ticks, straight segments and
 *                visible data points. A chart you read numbers off.
 *   'peaceful'   no axes on the small charts, curved line, soft gradient. A chart
 *                you take the shape from; the headline above it carries the
 *                number, so repeating it in tick labels is just noise.
 *
 * Only presentation lives here. Every series, every value and every tooltip
 * string is computed elsewhere and passed in unchanged, so switching view can
 * never change what a chart says — only how it looks saying it.
 *
 * PURE — no canvas, no React — which is why it can be tested at all: Chart.js
 * options are unreadable once they're inside a rendered <canvas>.
 */

import type { ViewMode } from './appearance';

/** Ticks and axis labels in the technical view. Mono so digits line up. */
export const MONO_FONT = {
  family: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  size: 10,
};

export const GRID_COLOR = 'rgba(120,120,120,0.18)';
export const AXIS_COLOR = 'rgba(120,120,120,0.35)';
export const TICK_COLOR = '#9ca3af';

/** Dashed grid — the graph-paper feel, without the weight of solid rules. */
export function gridStyle(mode: ViewMode, show = true) {
  if (mode !== 'technical') {
    return { display: show, color: GRID_COLOR, drawTicks: false };
  }
  return {
    display: show,
    color: GRID_COLOR,
    borderDash: [3, 3] as number[],
    drawTicks: true,
    tickLength: 4,
    tickColor: AXIS_COLOR,
  };
}

/** Tick labels — monospaced and slightly tighter in the technical view. */
export function tickStyle(mode: ViewMode) {
  return mode === 'technical'
    ? { color: TICK_COLOR, font: MONO_FONT, padding: 2 }
    : { color: TICK_COLOR, font: { size: 11 }, padding: 4 };
}

/**
 * The line itself. Technical draws the actual segments between readings —
 * a smoothed curve invents values between two points, which is fine when you're
 * reading a shape and wrong when you're reading a number off the grid.
 */
export function lineStyle(mode: ViewMode, pointCount: number) {
  if (mode === 'technical') {
    return {
      borderWidth: 1.75,
      tension: 0,
      pointRadius: pointCount <= 90 ? 1.5 : 0,
      pointHoverRadius: 4,
      fill: false,
    };
  }
  return {
    borderWidth: 2.5,
    cubicInterpolationMode: 'monotone' as const,
    pointRadius: pointCount <= 6 ? 3 : 0,
    pointHoverRadius: 4,
    fill: true,
  };
}

/** Tooltips: square and monospaced for technical, soft and roomy for peaceful. */
export function tooltipStyle(mode: ViewMode) {
  return mode === 'technical'
    ? {
        displayColors: false,
        cornerRadius: 2,
        padding: 8,
        titleFont: MONO_FONT,
        bodyFont: { ...MONO_FONT, size: 11 },
      }
    : { displayColors: false, cornerRadius: 10, padding: 10 };
}

/**
 * The scales for a small trend chart — Overview's net worth, Investments' P/L.
 * Peaceful hides them entirely (that IS the peaceful sparkline); technical turns
 * the same chart into something with a readable frame.
 *
 * `x` is always a linear (epoch-ms) scale pinned to the caller's window, so the
 * plotted window is identical in both views.
 */
export function trendScales(mode: ViewMode, opts: {
  min: number;
  max: number;
  formatX: (ms: number) => string;
  formatY: (value: number) => string;
}) {
  const x = { type: 'linear' as const, min: opts.min, max: opts.max };
  if (mode !== 'technical') {
    return { x: { ...x, display: false }, y: { display: false } };
  }
  return {
    x: {
      ...x,
      display: true,
      grid: gridStyle('technical', false),
      ticks: {
        ...tickStyle('technical'),
        maxTicksLimit: 6,
        maxRotation: 0,
        autoSkip: true,
        callback: (v: string | number) => opts.formatX(Number(v)),
      },
    },
    y: {
      display: true,
      position: 'right' as const,
      grid: gridStyle('technical'),
      ticks: {
        ...tickStyle('technical'),
        maxTicksLimit: 5,
        callback: (v: string | number) => opts.formatY(Number(v)),
      },
    },
  };
}

/**
 * Doughnuts: a thin measured ring in technical, a fat rounded one in peaceful.
 * Spread straight into Chart.js `options` — `elements.arc` is used rather than
 * dataset fields so the caller's data object is left completely alone.
 */
export function doughnutStyle(mode: ViewMode) {
  return mode === 'technical'
    ? { cutout: '76%', elements: { arc: { borderWidth: 0, borderRadius: 0, hoverOffset: 2 } } }
    : { cutout: '62%', elements: { arc: { borderWidth: 0, borderRadius: 6, hoverOffset: 6 } } };
}
