/**
 * Colour filter - checkpoint 117, the foundation of v0.6 auto-extraction.
 *
 * The first stage of WebPlotDigitizer's auto-extraction pipeline
 * (region mask -> COLOUR FILTER -> binary mask -> algorithm -> points), adapted
 * rather than clean-roomed: WPD is AGPL-3.0, same as us, so we may take its shape
 * (tenets 5/8 -- take the mechanism, not the DOM param tables and `_wasRun` flags).
 *
 * WHY it earns its place beside Segment Fill: colour-filtering says "the curve is
 * the RED one", so a dashed / marker-only / crossed curve extracts in ONE run.
 * Segment Fill's flood fill needs an unbroken connected path and structurally
 * cannot do that -- and multi-series / broken-line charts are the field's
 * most-corroborated friction (ChartSense, and vectorbyte independently).
 *
 * Output is a Uint8Array mask (1 byte per pixel, 1 = selected) -- the EXACT shape
 * algorithms/segmentFill.ts's `pointsFromColumnRuns` (Averaging Window) and
 * `floodFill` (Blob Detector) already consume. So the tracing algorithms are
 * mostly wiring over code checkpoint 78 shipped; this filter is the new part.
 *
 * ⚑ Tenet 9: this RECORDS which pixels match a colour -- measured off the image,
 * not interpreted. WPD's INTERPOLATING algorithms (X-Step-with-interpolation,
 * custom independents) invent points where the curve was never drawn; they are
 * deliberately NOT in v0.6's first pass and belong downstream of the record (see
 * CLAUDE.md, MAP A's tenet-9 warning). Build the recording algorithms first.
 */

export type RGB = readonly [number, number, number];

/**
 * Which pixels to keep, two modes:
 * - `foreground`: pixels NEAR the target colour -- "the curve IS this colour".
 * - `background`: pixels FAR from the target -- "the curve is anything but the
 *   paper/background colour". Useful when the series colours vary but the
 *   background is uniform.
 */
export type ColorFilterMode = 'foreground' | 'background';

/** An optional rectangle to restrict the filter to (e.g. the plot box, so a
 * legend swatch or axis label of the same colour is not selected). Clamped to the
 * image; omitted => the whole image. */
export interface FilterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ColorFilterResult {
  /** 1 byte per pixel, 1 = selected. Row-major, same layout as an ImageData
   * alpha plane -- feeds pointsFromColumnRuns / floodFill unchanged. */
  mask: Uint8Array;
  /** Selected-pixel count. The UI uses it to warn before an algorithm runs: 0 =
   * nothing matched (raise the tolerance / repick the colour), or an implausibly
   * large fraction of the image = the tolerance grabbed the gridlines too. Seeing
   * the mask before committing is the most tenet-1-relevant affordance in the
   * whole suite (it prevents vectorbyte's "auto-extraction picked up the grid"). */
  count: number;
}

/**
 * Build a colour-match mask over an RGBA image (`src` is a flat RGBA byte array,
 * 4 bytes per pixel -- ImageData.data's shape). `tolerance` is a Euclidean RGB
 * distance (0..~441), squared internally to avoid a per-pixel sqrt. A fully
 * transparent pixel (alpha 0) never matches: it is not part of the figure.
 */
export function colorFilter(
  src: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  target: RGB,
  tolerance: number,
  mode: ColorFilterMode = 'foreground',
  region?: FilterRegion
): ColorFilterResult {
  const mask = new Uint8Array(width * height);
  const t2 = tolerance * tolerance;
  const [tr, tg, tb] = target;
  let count = 0;

  // Clamp the region to the image; no region => the whole image.
  const x0 = region ? Math.max(0, Math.floor(region.x)) : 0;
  const y0 = region ? Math.max(0, Math.floor(region.y)) : 0;
  const x1 = region ? Math.min(width, Math.floor(region.x + region.width)) : width;
  const y1 = region ? Math.min(height, Math.floor(region.y + region.height)) : height;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (src[i + 3] === 0) continue; // fully transparent -> not part of the figure
      const dr = src[i]! - tr;
      const dg = src[i + 1]! - tg;
      const db = src[i + 2]! - tb;
      const near = dr * dr + dg * dg + db * db <= t2;
      if (mode === 'foreground' ? near : !near) {
        mask[p] = 1;
        count++;
      }
    }
  }
  return { mask, count };
}

/**
 * Paint a colour-filter mask into an ImageData-ready RGBA byte array for an
 * on-canvas PREVIEW (checkpoint 121): matched pixels get `rgba`, every other
 * pixel stays fully transparent so the base figure shows through unchanged.
 * Row-major, same layout as the mask; length is `width * height * 4`.
 *
 * This is "see the mask before you trace it" -- the single most tenet-1-relevant
 * affordance in the whole auto-extraction suite. It is what lets the user catch,
 * BEFORE trusting a trace, that the tolerance also grabbed the gridlines / axes /
 * a same-colour legend swatch (vectorbyte's documented "auto-extraction picked up
 * the grid" failure). Pure and canvas-free so it is vitest-testable; the UI wraps
 * the result in an offscreen canvas and scales it to the view.
 */
export function maskToRGBA(
  mask: Uint8Array,
  width: number,
  height: number,
  rgba: readonly [number, number, number, number]
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const [r, g, b, a] = rgba;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p]) {
      const i = p * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return out;
}
