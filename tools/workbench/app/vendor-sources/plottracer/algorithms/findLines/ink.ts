/**
 * Where the line colour IS, as coverage rather than a yes/no colour match.
 *
 * ⚑ WHY COVERAGE AND NOT A COLOUR THRESHOLD. A thin anti-aliased line is mostly
 * edge pixels, each a MIX of the line colour and the paper: bg + a * (c - bg).
 * A colour threshold shatters such a line into specks; estimating `a` keeps it
 * whole, and the residual (how far a pixel is from any such mix) refuses other
 * colours. Measured in the research (plottracer-ref, research/v2.6-separation):
 * the plain threshold was the first thing that broke on thin contours.
 *
 * Also here: sub-pixel line centres (Steger 1998, re-derived from the published
 * method) and their linking ALONG the line, used where lines crowd together.
 */
import { gaussian, greyClosing, greyOpening, type Plane } from './raster.js';

export type RGB = readonly [number, number, number];

/** A rectangle in image pixels, inclusive bounds as the research used them. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Coverage {
  /** Estimated coverage of the line colour, clipped to 0..1.5. */
  alpha: Float64Array;
  /** Distance of the pixel from the nearest bg-to-colour mix. */
  residual: Float64Array;
  /** |colour - background|: no contrast, no reading. */
  contrast: Float64Array;
}

export function inkCoverage(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, colour: RGB, size = 9): Coverage {
  const n = w * h;
  const ch = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let lum = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) ch[k]![i] = rgba[i * 4 + k]!;
    lum += (ch[0]![i]! + ch[1]![i]! + ch[2]![i]!) / 3;
  }
  lum /= n;
  const cMean = (colour[0] + colour[1] + colour[2]) / 3;
  // lines darker than the paper vanish under a closing; lighter ones under an opening
  const bg = ch.map((c) => {
    const p: Plane = { data: c, width: w, height: h };
    return lum > cMean ? greyClosing(p, size) : greyOpening(p, size);
  });
  const alpha = new Float64Array(n);
  const residual = new Float64Array(n);
  const contrast = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v0 = colour[0] - bg[0]![i]!, v1 = colour[1] - bg[1]![i]!, v2 = colour[2] - bg[2]![i]!;
    const den = Math.max(v0 * v0 + v1 * v1 + v2 * v2, 1);
    const r0 = ch[0]![i]! - bg[0]![i]!, r1 = ch[1]![i]! - bg[1]![i]!, r2 = ch[2]![i]! - bg[2]![i]!;
    const a = (r0 * v0 + r1 * v1 + r2 * v2) / den;
    const e0 = r0 - a * v0, e1 = r1 - a * v1, e2 = r2 - a * v2;
    alpha[i] = Math.min(1.5, Math.max(0, a));
    residual[i] = Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2);
    contrast[i] = Math.sqrt(den);
  }
  return { alpha, residual, contrast };
}

/** Pixels inside `box`, `inset` px in from its edges (the frame and ticks stay out). */
export function insideBox(x: number, y: number, box: Box, inset: number): boolean {
  return y >= Math.ceil(box.y0) + inset && y <= Math.floor(box.y1) - inset &&
    x >= Math.ceil(box.x0) + inset && x <= Math.floor(box.x1) - inset;
}

/** True where a user mask (a region marked "not data", such as a legend) covers. */
export function masked(x: number, y: number, masks: readonly Box[]): boolean {
  for (const m of masks) {
    if (y >= Math.max(0, Math.trunc(m.y0)) && y <= Math.ceil(m.y1) && x >= Math.max(0, Math.trunc(m.x0)) && x <= Math.ceil(m.x1)) return true;
  }
  return false;
}

/** The line's ink: coverage above `thr`, a real mix of the line colour, inside the box. */
export function lineMask(cov: Coverage, w: number, h: number, box: Box, masks: readonly Box[], thr = 0.3, resTol = 70, inset = 3): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cov.alpha[i]! > thr && cov.residual[i]! < resTol && cov.contrast[i]! > 40 && insideBox(x, y, box, inset) && !masked(x, y, masks)) m[i] = 1;
    }
  }
  return m;
}

export interface RidgePoints {
  /** Sub-pixel centres, x then y. */
  px: Float64Array;
  py: Float64Array;
  /** Unit direction ALONG the line at each centre. */
  dx: Float64Array;
  dy: Float64Array;
  count: number;
}

/** Sub-pixel centres at ridges of the smoothed coverage: the normal is the
 * Hessian's most negative eigenvector, the centre where the first derivative
 * along it crosses zero inside the pixel. */
export function ridgePoints(cov: Coverage, w: number, h: number, box: Box, sigma = 0.7, thr = 0.03, inset = 3, amin = 0.12, resTol = 70): RidgePoints {
  const n = w * h;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = cov.residual[i]! < resTol && cov.contrast[i]! > 40 ? cov.alpha[i]! : 0;
  const p: Plane = { data: a, width: w, height: h };
  const g = gaussian(p, sigma, 0, 0);
  const gy = gaussian(p, sigma, 1, 0);
  const gx = gaussian(p, sigma, 0, 1);
  const gyy = gaussian(p, sigma, 2, 0);
  const gxx = gaussian(p, sigma, 0, 2);
  const gxy = gaussian(p, sigma, 1, 1);
  const px: number[] = [], py: number[] = [], dx: number[] = [], dy: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!(x >= box.x0 + inset && x <= box.x1 - inset && y >= box.y0 + inset && y <= box.y1 - inset)) continue;
      const i = y * w + x;
      const Gxx = gxx[i]!, Gyy = gyy[i]!, Gxy = gxy[i]!;
      const disc = Math.sqrt(((Gxx - Gyy) / 2) ** 2 + Gxy * Gxy);
      const lam = (Gxx + Gyy) / 2 - disc;
      if (!(lam < -thr) || !(g[i]! > amin)) continue;
      let nx = Gxy, ny = lam - Gxx;
      if (Math.hypot(nx, ny) < 1e-9) {
        nx = lam - Gyy;
        ny = Gxy;
      }
      let nn = Math.hypot(nx, ny);
      if (nn < 1e-12) nn = 1;
      nx /= nn;
      ny /= nn;
      const num = gx[i]! * nx + gy[i]! * ny;
      let den = Gxx * nx * nx + 2 * Gxy * nx * ny + Gyy * ny * ny;
      if (Math.abs(den) < 1e-12) den = -1e-12;
      const t = -num / den;
      const ox = t * nx, oy = t * ny;
      if (Math.abs(ox) > 0.5 || Math.abs(oy) > 0.5) continue;
      px.push(x + ox);
      py.push(y + oy);
      dx.push(-ny);
      dy.push(nx);
    }
  }
  return { px: Float64Array.from(px), py: Float64Array.from(py), dx: Float64Array.from(dx), dy: Float64Array.from(dy), count: px.length };
}

/** Points within `r` of each other, through a grid of cells `r` wide. */
export function neighbourPairs(px: Float64Array, py: Float64Array, r: number): [number, number][] {
  const cells = new Map<string, number[]>();
  for (let i = 0; i < px.length; i++) {
    const key = `${Math.floor(px[i]! / r)},${Math.floor(py[i]! / r)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = []));
    c.push(i);
  }
  const out: [number, number][] = [];
  for (let i = 0; i < px.length; i++) {
    const cx = Math.floor(px[i]! / r), cy = Math.floor(py[i]! / r);
    for (let ddy = -1; ddy <= 1; ddy++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        const c = cells.get(`${cx + ddx},${cy + ddy}`);
        if (!c) continue;
        for (const j of c) {
          if (j <= i) continue;
          if (Math.hypot(px[j]! - px[i]!, py[j]! - py[i]!) <= r) out.push([i, j]);
        }
      }
    }
  }
  return out;
}

/** Link centres ALONG their direction only: each point has a front and a back
 * slot, and a neighbour BESIDE the line (lateral offset over `maxLat`) is never
 * linked - which is what keeps two lines 1.3 px apart as two lines. */
export function ridgeChains(rp: RidgePoints, radius = 2.2, maxLat = 0.75, maxTurnDeg = 35): number[][] {
  const { px, py, dx, dy, count: n } = rp;
  const ct = Math.cos((maxTurnDeg * Math.PI) / 180);
  const slot = new Int32Array(n * 2).fill(-1);
  const cands: [number, number, number, number, number][] = [];
  for (const [i, j] of neighbourPairs(px, py, radius)) {
    const vx = px[j]! - px[i]!, vy = py[j]! - py[i]!;
    const d = Math.hypot(vx, vy);
    if (d < 0.3) continue;
    const ux = vx / d, uy = vy / d;
    const c = Math.abs(dx[i]! * dx[j]! + dy[i]! * dy[j]!);
    if (c < ct) continue;
    const latI = Math.abs(vx * dy[i]! - vy * dx[i]!);
    const latJ = Math.abs(vx * dy[j]! - vy * dx[j]!);
    if (Math.max(latI, latJ) > maxLat) continue;
    const si = ux * dx[i]! + uy * dy[i]! > 0 ? 0 : 1;
    const sj = -ux * dx[j]! - uy * dy[j]! > 0 ? 0 : 1;
    cands.push([d + 2 * Math.max(latI, latJ) + 2 * (1 - c), i, si, j, sj]);
  }
  cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]);
  for (const [, i, si, j, sj] of cands) {
    if (slot[i * 2 + si]! >= 0 || slot[j * 2 + sj]! >= 0) continue;
    slot[i * 2 + si] = j;
    slot[j * 2 + sj] = i;
  }
  const seen = new Uint8Array(n);
  const chains: number[][] = [];
  const walk = (start: number, first: number): [number[], number] => {
    const c = [start];
    let prev = start, cur = first;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      c.push(cur);
      const a = slot[cur * 2]!, b = slot[cur * 2 + 1]!;
      const nx = a >= 0 && a !== prev ? a : b >= 0 && b !== prev ? b : -1;
      prev = cur;
      cur = nx;
    }
    return [c, cur];
  };
  for (let s = 0; s < n; s++) {
    if (seen[s] || (slot[s * 2]! >= 0 && slot[s * 2 + 1]! >= 0)) continue;
    seen[s] = 1;
    const nb = slot[s * 2]! >= 0 ? slot[s * 2]! : slot[s * 2 + 1]!;
    chains.push(nb >= 0 ? walk(s, nb)[0] : [s]);
  }
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    chains.push([...walk(s, slot[s * 2]!)[0], s]);
  }
  return chains;
}
