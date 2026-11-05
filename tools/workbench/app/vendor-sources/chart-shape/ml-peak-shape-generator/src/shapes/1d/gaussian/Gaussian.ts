import {
  GAUSSIAN_EXP_FACTOR,
  ROOT_2LN2,
  ROOT_LN2,
  ROOT_PI_OVER_LN2,
} from '../../../util/constants.ts';
import erfinv from '../../../util/erfinv.ts';
import type { GetData1DOptions } from '../GetData1DOptions.ts';
import type { Shape1DClass, Shape1DDerivative } from '../Shape1DClass.ts';
import type { GaussianShape1D } from '../shape_1d.ts';

interface CalculateGaussianHeightOptions {
  /**
   * @default 500
   */
  fwhm?: number;
  /**
   * @default 1
   */
  area?: number;
  sd?: number;
}

export interface GaussianClassOptions {
  /**
   * Full width at half maximum.
   * @default 500
   */
  fwhm?: number;
  /**
   * The halft width between the inflection points or standard deviation.
   * If it is defined the fwhm would be re-assigned.
   */
  sd?: number;
}

interface GetGaussianAreaOptions {
  /**
   * The maximum intensity value of the shape.
   * @default 1
   */
  height?: number;
  /**
   * Full width at half maximum.
   * @default 500
   */
  fwhm?: number;
  /**
   * The half width between the inflection points or standard deviation.
   * If it is defined the fwhm would be re-assigned.
   */
  sd?: number;
}

export class Gaussian implements Shape1DClass {
  public readonly kind = 'gaussian' as const;
  /**
   * Full width at half maximum.
   * @default 500
   */
  public fwhm: number;

  public constructor(options: GaussianClassOptions = {}) {
    const { fwhm = 500, sd } = options;

    this.fwhm = sd ? gaussianWidthToFWHM(2 * sd) : fwhm;
  }

  public fwhmToWidth(fwhm = this.fwhm) {
    return gaussianFwhmToWidth(fwhm);
  }

  public widthToFWHM(width: number) {
    return gaussianWidthToFWHM(width);
  }

  public fct(x: number) {
    return gaussianFct(x, this.fwhm);
  }

  public getArea(height = calculateGaussianHeight({ fwhm: this.fwhm })) {
    return getGaussianArea({ fwhm: this.fwhm, height });
  }

  public getFactor(area?: number) {
    return getGaussianFactor(area);
  }

  public getData(options: GetData1DOptions = {}) {
    return getGaussianData(this, options);
  }

  public calculateHeight(area = 1) {
    return calculateGaussianHeight({ fwhm: this.fwhm, area });
  }

  public getParameters(): GaussianParameter[] {
    return ['fwhm'];
  }

  /**
   * Descriptor of this shape, so `JSON.stringify` round-trips through `getShape1D`.
   * @returns the shape descriptor.
   */
  public toJSON(): GaussianShape1D {
    return { kind: this.kind, fwhm: this.fwhm };
  }

  public derivative(x: number): Shape1DDerivative {
    const { fct, dx, dFwhm } = gaussianDerivative(x, this.fwhm);
    return { fct, dx, parameters: [dFwhm] };
  }
}

/** Parameters characterizing a gaussian shape. */
export type GaussianParameter = 'fwhm';

/**
 * Calculate the peak height for a given area and fwhm.
 * @param options - fwhm, area, and optional sd.
 * @returns the peak height.
 */
export function calculateGaussianHeight(
  options: CalculateGaussianHeightOptions,
) {
  const { area = 1, sd } = options;
  let { fwhm = 500 } = options;

  if (sd) fwhm = gaussianWidthToFWHM(2 * sd);

  return (2 * area) / ROOT_PI_OVER_LN2 / fwhm;
}

/**
 * Evaluate the gaussian function centered at x=0.
 * @param x - position at which to evaluate.
 * @param fwhm - full width at half maximum.
 * @returns the intensity at x.
 */
export function gaussianFct(x: number, fwhm: number) {
  return Math.exp(GAUSSIAN_EXP_FACTOR * (x / fwhm) ** 2);
}

/**
 * Analytical value and partial derivatives of the gaussian function centered at x=0.
 * @param x - position at which to evaluate.
 * @param fwhm - full width at half maximum.
 * @returns the value `fct` and its partial derivatives with respect to `x` (`dx`) and `fwhm` (`dFwhm`).
 */
export function gaussianDerivative(x: number, fwhm: number) {
  const fct = gaussianFct(x, fwhm);
  const dx = ((2 * GAUSSIAN_EXP_FACTOR * x) / (fwhm * fwhm)) * fct;
  const dFwhm =
    ((-2 * GAUSSIAN_EXP_FACTOR * x * x) / (fwhm * fwhm * fwhm)) * fct;
  return { fct, dx, dFwhm };
}

/**
 * Convert inflection-point width to full width at half maximum.
 * @param width - width between inflection points.
 * @returns full width at half maximum.
 */
export function gaussianWidthToFWHM(width: number) {
  return width * ROOT_2LN2;
}

/**
 * Convert full width at half maximum to inflection-point width.
 * @param fwhm - full width at half maximum.
 * @returns width between inflection points.
 */
export function gaussianFwhmToWidth(fwhm: number) {
  return fwhm / ROOT_2LN2;
}

/**
 * Calculate the area under a gaussian peak.
 * @param options - fwhm, height, and optional sd.
 * @returns the area.
 */
export function getGaussianArea(options: GetGaussianAreaOptions) {
  const { sd, height = 1 } = options;
  let { fwhm = 500 } = options;

  if (sd) fwhm = gaussianWidthToFWHM(2 * sd);

  return (height * ROOT_PI_OVER_LN2 * fwhm) / 2;
}

/**
 * Calculate the width factor corresponding to a given area coverage fraction.
 * @param area - target area fraction (0–1). Defaults to `0.9999`.
 * @returns the factor by which to multiply fwhm to cover the given area.
 */
export function getGaussianFactor(area = 0.9999) {
  if (area >= 1) {
    throw new Error('area should be (0 - 1)');
  }
  return erfinv(area) / ROOT_LN2;
}

/**
 * Generate an intensity array for a gaussian shape.
 * @param shape - gaussian shape parameters (fwhm, sd).
 * @param options - sampling options (length, factor, height).
 * @returns Float64Array of intensity values.
 */
export function getGaussianData(
  shape: GaussianClassOptions = {},
  options: GetData1DOptions = {},
) {
  const { sd } = shape;
  let { fwhm = 500 } = shape;
  if (sd) fwhm = gaussianWidthToFWHM(2 * sd);

  const {
    factor = getGaussianFactor(),
    height = calculateGaussianHeight({ fwhm }),
  } = options;
  let { length } = options;

  if (!length) {
    length = Math.min(Math.ceil(fwhm * factor), 2 ** 25 - 1);
    if (length % 2 === 0) length++;
  }

  const center = (length - 1) / 2;
  const data = new Float64Array(length);
  for (let i = 0; i <= center; i++) {
    const value = gaussianFct(i - center, fwhm) * height;
    data[i] = value;
    data[length - 1 - i] = value;
  }

  return data;
}
