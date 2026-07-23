/**
 * Shared geometry for desk charts: time-true X, padded Y, gap-aware paths.
 * Index-based X was compressing multi-hour outages into one step and stretching
 * stale flat samples across half the plot — ugly and inaccurate.
 */

export const CHART_W = 720;
export const CHART_H = 280;
export const CHART_H_TALL = 420;
export const CHART_PAD_X = 62;
export const CHART_PAD_TOP = 28;
export const CHART_PAD_BOTTOM = 36;
export const CHART_PAD_RIGHT = 20;
/** Extra horizontal inset so first/last dots are not clipped. */
export const CHART_X_EDGE = 0.02;
/** Vertical headroom so lines are not glued to the frame. */
export const CHART_Y_PAD_FRAC = 0.1;

export type ChartRange = "24h" | "7d";

export type TimedValue = { t: string; v: number; time: number };

export type PlotPoint = { x: number; y: number; v: number; t: string; time: number };

export function parseTimedPoints(
  points: Array<{ t: string; v: number }>
): TimedValue[] {
  const out: TimedValue[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.v) || p.v <= 0) continue;
    const time = Date.parse(p.t);
    if (!Number.isFinite(time)) continue;
    out.push({ t: p.t, v: p.v, time });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Drop consecutive near-duplicates (same price), keep first + last of a plateau. */
export function collapseFlatRuns(points: TimedValue[], epsRel = 1e-9): TimedValue[] {
  if (points.length < 3) return points;
  const out: TimedValue[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const tol = Math.max(Math.abs(prev.v) * epsRel, 1e-6);
    const sameAsPrev = Math.abs(cur.v - prev.v) <= tol;
    const sameAsNext = Math.abs(cur.v - next.v) <= tol;
    if (sameAsPrev && sameAsNext) continue;
    out.push(cur);
  }
  const last = points[points.length - 1]!;
  if (out[out.length - 1]!.time !== last.time) out.push(last);
  return out;
}

export function rangeWindowMs(range: ChartRange): number {
  return range === "7d" ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
}

/**
 * Fixed monitoring window: [now - range, now].
 * Falls back to data extent when samples sit outside (clock skew / empty).
 */
export function resolveTimeDomain(
  times: number[],
  range: ChartRange,
  nowMs: number = Date.now()
): { tMin: number; tMax: number } {
  const windowMs = rangeWindowMs(range);
  let tMax = nowMs;
  let tMin = nowMs - windowMs;
  if (!times.length) return { tMin, tMax };

  const dataMin = Math.min(...times);
  const dataMax = Math.max(...times);
  // Prefer fixed window; expand if data slightly outside
  tMin = Math.min(tMin, dataMin);
  tMax = Math.max(tMax, dataMax);
  if (tMax <= tMin) {
    tMin = dataMin - 60_000;
    tMax = dataMax + 60_000;
  }
  return { tMin, tMax };
}

export function resolveValueDomain(values: number[]): { min: number; max: number } {
  if (!values.length) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.002, min > 1000 ? 1 : 0.01);
    min -= pad;
    max += pad;
  } else {
    const span = max - min;
    const pad = span * CHART_Y_PAD_FRAC;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

export function plotWidth(): number {
  return CHART_W - CHART_PAD_X - CHART_PAD_RIGHT;
}

export function plotHeight(viewH: number = CHART_H): number {
  return viewH - CHART_PAD_TOP - CHART_PAD_BOTTOM;
}

export function xFromTime(time: number, tMin: number, tMax: number, plotW: number): number {
  const span = Math.max(tMax - tMin, 1);
  const innerStart = CHART_PAD_X + plotW * CHART_X_EDGE;
  const innerW = plotW * (1 - 2 * CHART_X_EDGE);
  const ratio = Math.min(1, Math.max(0, (time - tMin) / span));
  return innerStart + ratio * innerW;
}

export function yFromValue(value: number, min: number, max: number, plotH: number): number {
  const span = Math.max(max - min, 1e-12);
  return CHART_PAD_TOP + (1 - (value - min) / span) * plotH;
}

export function toPlotPoints(
  points: TimedValue[],
  tMin: number,
  tMax: number,
  vMin: number,
  vMax: number,
  plotW: number,
  plotH: number
): PlotPoint[] {
  return points.map((p) => ({
    x: xFromTime(p.time, tMin, tMax, plotW),
    y: yFromValue(p.v, vMin, vMax, plotH),
    v: p.v,
    t: p.t,
    time: p.time
  }));
}

/** Gap longer than this is treated as an outage (no line drawn across). */
export function outageThresholdMs(range: ChartRange): number {
  return range === "7d" ? 6 * 60 * 60_000 : 90 * 60_000;
}

export function splitByOutages(plotPoints: PlotPoint[], range: ChartRange): PlotPoint[][] {
  if (plotPoints.length < 2) return plotPoints.length ? [plotPoints] : [];
  const threshold = outageThresholdMs(range);
  const segments: PlotPoint[][] = [[plotPoints[0]!]];
  for (let i = 1; i < plotPoints.length; i++) {
    const prev = plotPoints[i - 1]!;
    const curr = plotPoints[i]!;
    if (curr.time - prev.time > threshold) {
      segments.push([curr]);
    } else {
      segments[segments.length - 1]!.push(curr);
    }
  }
  return segments.filter((s) => s.length >= 1);
}

export function linearLinePath(plotPoints: PlotPoint[]): string {
  if (plotPoints.length < 1) return "";
  if (plotPoints.length === 1) return "";
  let d = `M ${plotPoints[0]!.x} ${plotPoints[0]!.y}`;
  for (let i = 1; i < plotPoints.length; i++) {
    d += ` L ${plotPoints[i]!.x} ${plotPoints[i]!.y}`;
  }
  return d;
}

/**
 * Monotone-ish cubic with clamped control points (no wild overshoot).
 * Falls back to linear for short segments.
 */
export function smoothLinePath(plotPoints: PlotPoint[]): string {
  if (plotPoints.length < 2) return "";
  if (plotPoints.length === 2) {
    return `M ${plotPoints[0]!.x} ${plotPoints[0]!.y} L ${plotPoints[1]!.x} ${plotPoints[1]!.y}`;
  }

  const tension = 0.18;
  let d = `M ${plotPoints[0]!.x} ${plotPoints[0]!.y}`;

  for (let i = 0; i < plotPoints.length - 1; i++) {
    const p0 = plotPoints[Math.max(0, i - 1)]!;
    const p1 = plotPoints[i]!;
    const p2 = plotPoints[i + 1]!;
    const p3 = plotPoints[Math.min(plotPoints.length - 1, i + 2)]!;

    let cp1x = p1.x + (p2.x - p0.x) * tension;
    let cp1y = p1.y + (p2.y - p0.y) * tension;
    let cp2x = p2.x - (p3.x - p1.x) * tension;
    let cp2y = p2.y - (p3.y - p1.y) * tension;

    // Clamp control Y between segment endpoints so price lines don't invent spikes
    const yLo = Math.min(p1.y, p2.y);
    const yHi = Math.max(p1.y, p2.y);
    const pad = Math.max((yHi - yLo) * 0.15, 0.5);
    cp1y = Math.min(yHi + pad, Math.max(yLo - pad, cp1y));
    cp2y = Math.min(yHi + pad, Math.max(yLo - pad, cp2y));
    // Keep X monotonic within the segment
    cp1x = Math.min(p2.x, Math.max(p1.x, cp1x));
    cp2x = Math.min(p2.x, Math.max(p1.x, cp2x));

    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
  }

  return d;
}

export function linePathsFor(
  plotPoints: PlotPoint[],
  range: ChartRange,
  mode: "linear" | "smooth" = "smooth"
): string[] {
  const fn = mode === "linear" ? linearLinePath : smoothLinePath;
  return splitByOutages(plotPoints, range)
    .map((seg) => (seg.length >= 2 ? fn(seg) : ""))
    .filter(Boolean);
}

export function areaPathsFor(
  plotPoints: PlotPoint[],
  baseY: number,
  range: ChartRange,
  mode: "linear" | "smooth" = "smooth"
): string[] {
  const fn = mode === "linear" ? linearLinePath : smoothLinePath;
  return splitByOutages(plotPoints, range)
    .map((seg) => {
      if (seg.length < 2) return "";
      const line = fn(seg);
      if (!line) return "";
      const first = seg[0]!;
      const last = seg[seg.length - 1]!;
      return `${line} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
    })
    .filter(Boolean);
}

/** Horizontal gap bands between outage-split segments (union of all series times). */
export function outageBands(
  times: number[],
  range: ChartRange,
  tMin: number,
  tMax: number,
  plotW: number,
  plotH: number
): Array<{ x: number; width: number }> {
  if (times.length < 2) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const threshold = outageThresholdMs(range);
  const bands: Array<{ x: number; width: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b - a <= threshold) continue;
    const x1 = xFromTime(a, tMin, tMax, plotW);
    const x2 = xFromTime(b, tMin, tMax, plotW);
    const width = Math.max(x2 - x1, 1);
    if (width > 2) bands.push({ x: x1, width });
  }
  // Leading empty (window start → first sample)
  const first = sorted[0]!;
  if (first - tMin > threshold) {
    const x1 = xFromTime(tMin, tMin, tMax, plotW);
    const x2 = xFromTime(first, tMin, tMax, plotW);
    bands.unshift({ x: x1, width: Math.max(x2 - x1, 1) });
  }
  // Trailing empty
  const last = sorted[sorted.length - 1]!;
  if (tMax - last > threshold) {
    const x1 = xFromTime(last, tMin, tMax, plotW);
    const x2 = xFromTime(tMax, tMin, tMax, plotW);
    bands.push({ x: x1, width: Math.max(x2 - x1, 1) });
  }
  void plotH;
  return bands;
}

export function timeFromClientX(
  clientX: number,
  svg: SVGSVGElement,
  tMin: number,
  tMax: number,
  plotW: number
): number {
  const left = svgToClient(svg, CHART_PAD_X, CHART_PAD_TOP).x;
  const right = svgToClient(svg, CHART_PAD_X + plotW, CHART_PAD_TOP).x;
  const plotLeft = Math.min(left, right);
  const plotWidth = Math.abs(right - left) || 1;
  const ratio = Math.min(1, Math.max(0, (clientX - plotLeft) / plotWidth));
  // Match edge pad used in xFromTime
  const edge = CHART_X_EDGE;
  const inner = Math.min(1, Math.max(0, (ratio - edge) / Math.max(1 - 2 * edge, 1e-6)));
  return tMin + inner * (tMax - tMin);
}

export function svgToClient(svg: SVGSVGElement, viewX: number, viewY: number) {
  const pt = svg.createSVGPoint();
  pt.x = viewX;
  pt.y = viewY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const mapped = pt.matrixTransform(ctm);
  return { x: mapped.x, y: mapped.y };
}

export function overlayPercent(
  svg: SVGSVGElement,
  body: HTMLDivElement,
  viewX: number,
  viewY: number,
  viewW: number = CHART_W,
  viewH: number = CHART_H
) {
  const bodyRect = body.getBoundingClientRect();
  const client = svgToClient(svg, viewX, viewY);
  if (bodyRect.width <= 0 || bodyRect.height <= 0) {
    return { left: (viewX / viewW) * 100, top: (viewY / viewH) * 100 };
  }
  return {
    left: ((client.x - bodyRect.left) / bodyRect.width) * 100,
    top: ((client.y - bodyRect.top) / bodyRect.height) * 100
  };
}

export function nearestTimedPoint(
  points: PlotPoint[],
  targetTime: number,
  maxDeltaMs?: number
): PlotPoint | null {
  if (!points.length) return null;
  let best = points[0]!;
  let bestDelta = Math.abs(best.time - targetTime);
  for (let i = 1; i < points.length; i++) {
    const delta = Math.abs(points[i]!.time - targetTime);
    if (delta < bestDelta) {
      best = points[i]!;
      bestDelta = delta;
    }
  }
  if (maxDeltaMs !== undefined && bestDelta > maxDeltaMs) return null;
  return best;
}

/** Evenly spaced time tick labels across the domain. */
export function timeAxisTicks(tMin: number, tMax: number, count: number = 5): number[] {
  if (count < 2) return [tMin, tMax];
  const span = Math.max(tMax - tMin, 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(tMin + (span * i) / (count - 1));
  }
  return ticks;
}

export function yGridValues(min: number, max: number, count: number = 5): number[] {
  if (count < 2) return [min, max];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(max - ((max - min) * i) / (count - 1));
  }
  return out;
}
