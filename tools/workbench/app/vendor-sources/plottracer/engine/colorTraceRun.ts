/**
 * Colour-trace orchestration (checkpoint 118) -- the click/action policy on top
 * of algorithms/colorFilter.ts + segmentFill.ts's pure functions, the exact
 * sibling of engine/segmentFillRun.ts. Extracted so it is vitest-testable on a
 * synthetic RGBA buffer, no canvas/DOM.
 *
 * Segment Fill seeds from ONE click and follows CONNECTED pixels; this instead
 * selects EVERY pixel of the curve's colour, so a dashed / marker-only / crossed
 * curve traces in one pass (the job connectivity structurally cannot do). Both
 * end in the same recording pipeline: one point per run per column
 * (doubling-back branches survive), walked into curve order, subsampled.
 */

import { colorFilter, type RGB, type ColorFilterMode, type FilterRegion } from '../algorithms/colorFilter.js';
import { pointsFromColumnRuns, orderByNearestNeighbour, subsample, type Point2D } from '../algorithms/segmentFill.js';

export interface ColorTraceSuccess {
  points: Point2D[];
  /** Matched-pixel count (before ordering/subsampling), for UI feedback. */
  matched: number;
}

export type ColorTraceResult = ColorTraceSuccess | { error: string };

const MIN_MATCHED_PIXELS = 3;
const DEFAULT_MAX_POINTS = 500;

/**
 * The bounding box of a set of calibration point pixels, as a FilterRegion. For
 * an XY chart this is the plot rectangle (X1/X2 on the x-axis, Y1/Y2 on the
 * y-axis), which is exactly the region that excludes the title, axis lines and
 * tick labels a colour trace would otherwise grab - they share the curve's
 * colour within tolerance but fall OUTSIDE the box. Returned as the default
 * trace region so a first pass stays inside the plot; the caller keeps it
 * visible and adjustable so data extending beyond the calibration points is one
 * drag/clear away. Null when the points enclose no area.
 */
export function calibrationBoxRegion(
  placed: Readonly<Record<string, { px: number; py: number }>>
): FilterRegion | null {
  const pts = Object.values(placed);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.px);
  const ys = pts.map((p) => p.py);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * Trace a curve by colour. `target` is the curve's colour (from the eyedropper),
 * `tolerance` a Euclidean RGB distance, `mode` foreground (near the colour) or
 * background (everything but it), `region` an optional plot-box restriction.
 * Fails with a clear message when too few pixels match (raise tolerance / repick),
 * rather than adding a near-empty trace.
 */
export function runColorTrace(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  target: RGB,
  tolerance: number,
  mode: ColorFilterMode = 'foreground',
  region?: FilterRegion,
  maxPoints: number = DEFAULT_MAX_POINTS
): ColorTraceResult {
  const { mask, count } = colorFilter(data, width, height, target, tolerance, mode, region);
  if (count < MIN_MATCHED_PIXELS) {
    return { error: 'No pixels matched that colour. Repick the curve colour, or raise the tolerance.' };
  }
  const runs = pointsFromColumnRuns(mask, width, height);
  const ordered = orderByNearestNeighbour(runs);
  const points = subsample(ordered, maxPoints);
  return { points, matched: count };
}

/**
 * Do this series' existing readings come from a DIFFERENT colour than the one
 * about to be traced?
 *
 * ⚑⚑ TRACING A SECOND COLOUR INTO ONE SERIES IS THE COMMONEST WAY TO RUIN A
 * GROUPED BAR CHART. Every category ends up holding two readings, the table can
 * show only one of each, and the output panel explains it AFTERWARDS - once the
 * damage is done. David, having done exactly that and undone it by hand: *"new
 * colour should automatically suggest a new series."* The offer belongs at the
 * gesture, and this is the question behind it.
 *
 * ⚑ MEASURED FROM WHAT IS ALREADY RECORDED. A trace ADOPTS its colour onto the
 * series it fills, so a series' own swatch IS the colour that produced its
 * readings. No new state, and nothing to keep in sync.
 *
 * ⚑ QUIET WHERE IT SHOULD BE. An EMPTY series can take any colour. And
 * re-tracing the SAME colour after nudging the tolerance is the ordinary
 * adjust-and-look loop - a suggestion that fires there is worse than none,
 * because it teaches the user to dismiss the one that matters.
 *
 * ⚠️ THE THRESHOLD IS DELIBERATELY GENEROUS. The question is "is this a
 * different curve", not "is this the same pixel": an eyedropper landing one
 * pixel off an anti-aliased edge picks a slightly different value for what is
 * plainly the same ink, and nagging about that would be the false positive that
 * kills the feature.
 */
export const NEW_COLOUR_DISTANCE = 90;

export function tracingADifferentColour(
  seriesColour: readonly [number, number, number],
  target: readonly [number, number, number],
  pointCount: number
): boolean {
  if (pointCount === 0) return false;
  const apart =
    Math.abs(seriesColour[0] - target[0]) +
    Math.abs(seriesColour[1] - target[1]) +
    Math.abs(seriesColour[2] - target[2]);
  return apart > NEW_COLOUR_DISTANCE;
}

/**
 * Should picking a colour off the figure set the ACTIVE SERIES' colour there and
 * then, before anything is traced?
 *
 * ⚑ DAVID, 2026-09-12: *"When we read a color for a series, we should change the
 * series color to that color."* A trace already adopts the ink it was traced
 * from, but that lands after the fact - so between the pipette and the Trace
 * button the series sits in its creation-order colour, and the swatch beside its
 * name disagrees with the mask painted over the figure. The answer to "which
 * series am I about to fill" should be visible at the gesture that decides it.
 *
 * ⚑⚑ AND ONLY WHILE THE SERIES IS EMPTY, which is not a hedge - it is what keeps
 * `tracingADifferentColour` able to fire at all. That guard measures the
 * question "do this series' readings come from a different colour than the one
 * about to be traced" from the series' OWN swatch. Adopting a picked colour onto
 * a series that already holds readings would answer the question by overwriting
 * the evidence: every pick would silently make itself look like the same colour,
 * and the offer that saves a grouped bar chart from being ruined would never
 * appear again.
 */
export function pickedColourAdopts(pointCount: number): boolean {
  return pointCount === 0;
}
