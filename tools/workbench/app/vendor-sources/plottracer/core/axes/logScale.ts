/**
 * Whether a log axis's two calibration endpoints can actually be logged.
 *
 * ⚑ WHY THIS MODULE EXISTS. `Math.log(0)` is `-Infinity` and
 * `Math.log(negative)` is `NaN`, and every axes class that supports a log
 * scale feeds its endpoints straight into `Math.log`. Unguarded, the poisoned
 * value is baked into the transform and `calibrate()` returns true anyway:
 * `isCalibrated()` says yes while every reading comes back NaN or null. That
 * is tenet 1's worst shape - nothing on screen looks wrong.
 *
 * The rule is NOT the same for every axis, which is exactly why it lives here
 * rather than being written out four times and drifting:
 *
 *  - An **XY** axis may run through the negative decades (WPD supports a
 *    calibration of, say, −100 to −1, and reflects it). So its endpoints must
 *    merely avoid zero and avoid MIXING signs.
 *  - A **radius** or a **bar/spider value** has no negative branch in its
 *    class at all, so both endpoints must be strictly positive.
 *
 * The interactive path refuses these cases with a sentence the user can act on
 * (`calibrationSession.ts`'s `logScaleGuards`). These functions are the
 * MODEL's own refusal, which is what the other entrances need: `plotData.ts`
 * calls `calibrate()` when loading a project and never inspects the result,
 * and the importers call it directly.
 */

/**
 * XY's rule: neither endpoint is zero, and the two share a sign.
 *
 * An all-negative pair is legitimate - that is a negative-decade axis, which
 * the caller reflects before taking the logarithm. Writing this as "both must
 * be positive" would refuse a real figure.
 */
export function logEndpointsUsable(a: number | null | undefined, b: number | null | undefined): boolean {
  // ⚑ `Number.isFinite`, not `typeof === 'number'`. NaN and Infinity are both
  // numbers and both slipped through the first version of this guard, written
  // the same morning: two NaNs "share a sign" (neither is > 0, so the
  // comparison is false === false), and Infinity is a perfectly positive
  // number with no finite logarithm. `1e999` parses to Infinity, so this is
  // reachable by typing, not only by a hand-edited file.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 || b === 0) return false;
  return (a as number) > 0 === (b as number) > 0;
}

/**
 * The rule for a scale with no negative branch - a polar radius, a bar's
 * value, a spider spoke: both endpoints strictly positive.
 */
export function logPositiveEndpointsUsable(
  a: number | null | undefined,
  b: number | null | undefined
): boolean {
  // Finite, for the same reason as above: `Infinity > 0` is true.
  return Number.isFinite(a) && Number.isFinite(b) && (a as number) > 0 && (b as number) > 0;
}
