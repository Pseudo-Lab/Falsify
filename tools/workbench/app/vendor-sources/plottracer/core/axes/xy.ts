/**
 * Originally ported from wpd-core's core/axes/xy.js.
 * Original: WebPlotDigitizer, Copyright (C) 2025 Ankit Rohatgi, AGPL-3.0.
 * See ../mathFunctions.ts for porting-provenance notes.
 */

import { mat, type Mat2x2, type Vec2 } from '../mathFunctions.js';
import { InputParser } from '../inputParser.js';
import type { Calibration } from '../calibration.js';
import type { AxesMetadata } from './types.js';
import { logEndpointsUsable } from './logScale.js';

export class XYAxes {
  calibration: Calibration | null = null;
  name = 'XY';

  private _isCalibrated = false;
  private isLogScaleX = false;
  private isLogScaleY = false;
  private isLogScaleXNegative = false;
  private isLogScaleYNegative = false;
  private isXDate = false;
  private isYDate = false;
  private noRotationFlag = false;
  private metadata: AxesMetadata = {};
  private initialFormattingX: string | null = null;
  private initialFormattingY: string | null = null;

  private x1 = 0;
  private y1 = 0;
  private x2 = 0;
  private y2 = 0;
  private x3 = 0;
  private y3 = 0;
  private x4 = 0;
  private y4 = 0;
  private xmin = 0;
  private xmax = 0;
  private ymin = 0;
  private ymax = 0;
  private a_mat: Mat2x2 = [0, 0, 0, 0];
  private a_inv_mat: Mat2x2 = [0, 0, 0, 0];
  private c_vec: Vec2 = [0, 0];

  private processCalibration(
    cal: Calibration,
    isLogX: boolean,
    isLogY: boolean,
    noRotationCorrection: boolean
  ): boolean {
    if (cal.getCount() < 4) {
      return false;
    }

    const cp1 = cal.getPoint(0)!;
    const cp2 = cal.getPoint(1)!;
    const cp3 = cal.getPoint(2)!;
    const cp4 = cal.getPoint(3)!;
    const ip = new InputParser();

    this.x1 = cp1.px;
    this.y1 = cp1.py;
    this.x2 = cp2.px;
    this.y2 = cp2.py;
    this.x3 = cp3.px;
    this.y3 = cp3.py;
    this.x4 = cp4.px;
    this.y4 = cp4.py;

    let xmin = ip.parse(cp1.dx) as number | null;
    if (!ip.isValid) return false;
    this.isXDate = ip.isDate;
    let xmax = ip.parse(cp2.dx) as number | null;
    if (!ip.isValid || ip.isDate !== this.isXDate) return false;
    this.initialFormattingX = ip.formatting;

    let ymin = ip.parse(cp3.dy) as number | null;
    if (!ip.isValid) return false;
    this.isYDate = ip.isDate;
    let ymax = ip.parse(cp4.dy) as number | null;
    if (!ip.isValid || ip.isDate !== this.isYDate) return false;
    this.initialFormattingY = ip.formatting;

    // ⚑ THE TWO VALUES ON EACH AXIS MUST DIFFER. Identical endpoints give the
    // axis no range: every pixel reads back that one constant, calibrate()
    // returns true and isCalibrated() agrees, and nothing on screen is wrong.
    // This is the same rule bar.ts, polar.ts and circularChartRecorder.ts each
    // gained on 2026-07-31 -- and XY, the most-used type (and Histogram, which
    // shares this class), was missed by that sweep. Found by the round-2 audit
    // fleet, which also showed the new class-wide test passed here for an
    // unrelated reason. Reachable by typing the same tick value twice.
    if (xmin === xmax) return false;
    if (ymin === ymax) return false;

    this.isLogScaleX = isLogX;
    this.isLogScaleY = isLogY;
    this.noRotationFlag = noRotationCorrection;

    // A log endpoint at zero or a pair of MIXED sign has no logarithm: the
    // branches below would produce -Infinity or NaN, poison the transform
    // matrix, and still return true -- isCalibrated() saying yes while every
    // reading comes back null. An all-negative pair is legitimate (WPD's own
    // negative-decade axis) and is handled by the first branch, so the test is
    // "not zero, and not a mix", never "must be positive".
    if (isLogX && !logEndpointsUsable(xmin, xmax)) return false;
    if (isLogY && !logEndpointsUsable(ymin, ymax)) return false;

    if (this.isLogScaleX === true) {
      if (xmin! < 0 && xmax! < 0) {
        this.isLogScaleXNegative = true;
        xmin = Math.log(-xmin!) / Math.log(10);
        xmax = Math.log(-xmax!) / Math.log(10);
      } else {
        xmin = Math.log(xmin!) / Math.log(10);
        xmax = Math.log(xmax!) / Math.log(10);
      }
    }

    if (this.isLogScaleY === true) {
      if (ymin! < 0 && ymax! < 0) {
        this.isLogScaleYNegative = true;
        ymin = Math.log(-ymin!) / Math.log(10);
        ymax = Math.log(-ymax!) / Math.log(10);
      } else {
        ymin = Math.log(ymin!) / Math.log(10);
        ymax = Math.log(ymax!) / Math.log(10);
      }
    }

    this.xmin = xmin!;
    this.xmax = xmax!;
    this.ymin = ymin!;
    this.ymax = ymax!;

    const dat_mat: Mat2x2 = [this.xmin - this.xmax, 0, 0, this.ymin - this.ymax];
    const pix_mat: Mat2x2 = [this.x1 - this.x2, this.x3 - this.x4, this.y1 - this.y2, this.y3 - this.y4];

    this.a_mat = mat.mult2x2(dat_mat, mat.inv2x2(pix_mat));

    if (this.noRotationFlag) {
      if (Math.abs(this.a_mat[0] * this.a_mat[3]) > Math.abs(this.a_mat[1] * this.a_mat[2])) {
        this.a_mat[1] = 0;
        this.a_mat[2] = 0;
        this.a_mat[0] = (this.xmax - this.xmin) / (this.x2 - this.x1);
        this.a_mat[3] = (this.ymax - this.ymin) / (this.y4 - this.y3);
      } else {
        this.a_mat[0] = 0;
        this.a_mat[3] = 0;
        this.a_mat[1] = (this.xmax - this.xmin) / (this.y2 - this.y1);
        this.a_mat[2] = (this.ymax - this.ymin) / (this.x4 - this.x3);
      }
    }

    this.a_inv_mat = mat.inv2x2(this.a_mat);
    this.c_vec[0] = this.xmin - this.a_mat[0] * this.x1 - this.a_mat[1] * this.y1;
    this.c_vec[1] = this.ymin - this.a_mat[2] * this.x3 - this.a_mat[3] * this.y3;

    this.calibration = cal;
    return true;
  }

  getBounds() {
    // ⚑ Undo the negative-decade REFLECTION, the same way pixelToData does.
    // For an axis calibrated -100..-1 the stored xmin/xmax hold log10(-x), so
    // raising 10 to them gave +100/+1 -- and `calibrationCheck` then took
    // Math.log(-100) = NaN and silently drew nothing, on exactly the axis type
    // that check helps most. Readings were never affected. (Round-2 audit.)
    const unlog = (v: number, isLog: boolean, negative: boolean): number =>
      isLog ? (negative ? -Math.pow(10, v) : Math.pow(10, v)) : v;
    return {
      x1: unlog(this.xmin, this.isLogScaleX, this.isLogScaleXNegative),
      x2: unlog(this.xmax, this.isLogScaleX, this.isLogScaleXNegative),
      y3: unlog(this.ymin, this.isLogScaleY, this.isLogScaleYNegative),
      y4: unlog(this.ymax, this.isLogScaleY, this.isLogScaleYNegative),
    };
  }

  isCalibrated(): boolean {
    return this._isCalibrated;
  }

  calibrate(calib: Calibration, isLogX: boolean, isLogY: boolean, noRotationCorrection: boolean): boolean {
    this.calibration = calib;
    this._isCalibrated = this.processCalibration(calib, isLogX, isLogY, noRotationCorrection);
    return this._isCalibrated;
  }

  pixelToData(pxi: number, pyi: number): number[] {
    const xp = parseFloat(String(pxi));
    const yp = parseFloat(String(pyi));

    const dat_vec = mat.mult2x2Vec(this.a_mat, [xp, yp]);
    dat_vec[0] = dat_vec[0] + this.c_vec[0];
    dat_vec[1] = dat_vec[1] + this.c_vec[1];

    let xf = dat_vec[0];
    let yf = dat_vec[1];

    if (this.isLogScaleX === true) {
      xf = this.isLogScaleXNegative ? -Math.pow(10, xf) : Math.pow(10, xf);
    }
    if (this.isLogScaleY === true) {
      yf = this.isLogScaleYNegative ? -Math.pow(10, yf) : Math.pow(10, yf);
    }

    return [xf, yf];
  }

  dataToPixel(x: number, y: number): { x: number; y: number } {
    if (this.isLogScaleX) {
      x = this.isLogScaleXNegative ? Math.log(-x) / Math.log(10) : Math.log(x) / Math.log(10);
    }
    if (this.isLogScaleY) {
      y = this.isLogScaleYNegative ? Math.log(-y) / Math.log(10) : Math.log(y) / Math.log(10);
    }

    const dat_vec: Vec2 = [x - this.c_vec[0], y - this.c_vec[1]];
    const rtnPix = mat.mult2x2Vec(this.a_inv_mat, dat_vec);

    return { x: rtnPix[0], y: rtnPix[1] };
  }

  isDate(varIndex: number): boolean {
    return varIndex === 0 ? this.isXDate : this.isYDate;
  }

  getInitialDateFormat(varIndex: number): string | null {
    return varIndex === 0 ? this.initialFormattingX : this.initialFormattingY;
  }

  isLogX(): boolean {
    return this.isLogScaleX;
  }

  isLogXNegative(): boolean {
    return this.isLogScaleXNegative;
  }

  isLogY(): boolean {
    return this.isLogScaleY;
  }

  isLogYNegative(): boolean {
    return this.isLogScaleYNegative;
  }

  noRotation(): boolean {
    return this.noRotationFlag;
  }

  getOrientation() {
    return { axes: 'Y', direction: 'increasing', angle: 90 };
  }

  getMetadata(): AxesMetadata {
    return JSON.parse(JSON.stringify(this.metadata));
  }

  setMetadata(obj: AxesMetadata): void {
    this.metadata = JSON.parse(JSON.stringify(obj));
  }

  numCalibrationPointsRequired(): number {
    return 4;
  }

  getDimensions(): number {
    return 2;
  }

  getAxesLabels(): string[] {
    return ['X', 'Y'];
  }
}
