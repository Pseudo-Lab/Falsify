export const GAUSSIAN_EXP_FACTOR = -4 * Math.LN2;

/**
 * A pseudo-Voigt is a gaussian plus a lorentzian. Beyond 3.74 fwhm from the
 * centre the gaussian part is down to 1.4e-17 — too small to change a shape of
 * height one — while the lorentzian part is still 1.8e-2 and fades much more
 * slowly. Past that distance the gaussian is skipped: the `Math.exp` it costs
 * cannot change the result, and most points of a wide window lie out there.
 *
 * The limit is stored squared, so the test is `(x / fwhm)² > 14`, which saves a
 * square root. The same value works for every mixing ratio `mu`, except `mu = 1`
 * where the shape is a pure gaussian: with no lorentzian part left, skipping
 * would return zero instead of a very small number, so that case is never
 * skipped.
 */
export const GAUSSIAN_CUTOFF = 14;
export const ROOT_PI_OVER_LN2 = Math.sqrt(Math.PI / Math.LN2);
export const ROOT_LN2 = Math.sqrt(Math.LN2);
export const ROOT_THREE = Math.sqrt(3);
export const ROOT_2LN2 = Math.sqrt(2 * Math.LN2);
export const ROOT_2LN2_MINUS_ONE = Math.sqrt(2 * Math.LN2) - 1;
