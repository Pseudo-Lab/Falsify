/**
 * Originally ported from wpd-core's core/calibration.js.
 * Original: WebPlotDigitizer, Copyright (C) 2025 Ankit Rohatgi, AGPL-3.0.
 * See core/mathFunctions.ts for porting-provenance notes.
 */

export interface CalibrationPoint {
  px: number;
  py: number;
  dx: number | string | null;
  dy: number | string | null;
  dz: number | string | null;
}

export class Calibration {
  private _dim: number | undefined;
  private _px: number[] = [];
  private _py: number[] = [];
  private _dimensions: number;
  private _dp: (number | string)[] = [];
  private _selections: number[] = [];

  constructor(dim?: number) {
    this._dim = dim;
    this._dimensions = dim == null ? 2 : dim;
  }

  getCount(): number {
    return this._px.length;
  }

  getDimensions(): number {
    return this._dimensions;
  }

  addPoint(pxi: number, pyi: number, dxi: number | string, dyi: number | string, dzi?: number | string): void {
    const plen = this._px.length;
    const dlen = this._dp.length;
    this._px[plen] = pxi;
    this._py[plen] = pyi;
    this._dp[dlen] = dxi;
    this._dp[dlen + 1] = dyi;
    if (this._dimensions === 3) {
      this._dp[dlen + 2] = dzi!;
    }
  }

  getPoint(index: number): CalibrationPoint | null {
    if (index < 0 || index >= this._px.length) {
      return null;
    }
    return {
      px: this._px[index]!,
      py: this._py[index]!,
      dx: this._dp[this._dimensions * index] ?? null,
      dy: this._dp[this._dimensions * index + 1] ?? null,
      dz: this._dimensions === 2 ? null : (this._dp[this._dimensions * index + 2] ?? null),
    };
  }

  changePointPx(index: number, npx: number, npy: number): void {
    if (index < 0 || index >= this._px.length) {
      return;
    }
    this._px[index] = npx;
    this._py[index] = npy;
  }

  setDataAt(index: number, dxi: number | string, dyi: number | string, dzi?: number | string): void {
    if (index < 0 || index >= this._px.length) {
      return;
    }
    this._dp[this._dimensions * index] = dxi;
    this._dp[this._dimensions * index + 1] = dyi;
    if (this._dimensions === 3) {
      this._dp[this._dimensions * index + 2] = dzi!;
    }
  }

  findNearestPoint(x: number, y: number, threshold?: number): number {
    const thresh = threshold == null ? 50 : threshold;
    let minDist = 0;
    let minIndex = -1;

    for (let i = 0; i < this._px.length; i++) {
      const dist = Math.sqrt(
        (x - this._px[i]!) * (x - this._px[i]!) + (y - this._py[i]!) * (y - this._py[i]!)
      );
      if ((minIndex < 0 && dist <= thresh) || (minIndex >= 0 && dist < minDist)) {
        minIndex = i;
        minDist = dist;
      }
    }
    return minIndex;
  }

  selectPoint(index: number): void {
    if (this._selections.indexOf(index) < 0) {
      this._selections.push(index);
    }
  }

  selectNearestPoint(x: number, y: number, threshold?: number): void {
    const minIndex = this.findNearestPoint(x, y, threshold);
    if (minIndex >= 0) {
      this.selectPoint(minIndex);
    }
  }

  getSelectedPoints(): number[] {
    return this._selections;
  }

  unselectAll(): void {
    this._selections = [];
  }

  isPointSelected(index: number): boolean {
    return this._selections.indexOf(index) >= 0;
  }
}
