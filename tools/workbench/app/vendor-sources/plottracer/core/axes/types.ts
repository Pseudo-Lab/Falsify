import type { Calibration } from '../calibration.js';

export type AxesMetadata = Record<string, unknown>;

/**
 * Common shape shared by every axes class (there are nine). `calibrate`/`dataToPixel`
 * signatures vary per concrete type (see each axes/*.ts file) - this is
 * intentionally loose rather than forcing an exact shared signature, because
 * the types genuinely differ: a bar inverts onto one line, XY onto a plane,
 * and several cannot invert at all. A shared signature would have to lie for
 * most of them.
 */
export interface Axes {
  calibration: Calibration | null;
  isCalibrated(): boolean;
  pixelToData(px: number, py: number): number[];
  getMetadata(): AxesMetadata;
  setMetadata(obj: AxesMetadata): void;
  name: string;
}

export interface AxesStatic {
  numCalibrationPointsRequired(): number;
  getDimensions(): number;
  getAxesLabels(): string[];
}
