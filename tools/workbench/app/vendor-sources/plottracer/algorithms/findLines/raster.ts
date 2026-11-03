/**
 * Image operations for Find lines (v2.6). Pure, on row-major Float64Array /
 * Uint8Array planes of size width x height.
 *
 * The research pipeline (plottracer-ref, research/v2.6-separation) was measured
 * with scipy/skimage. These are the same operations, re-derived from their
 * published definitions so the port measures like the research did:
 * - Gaussian derivatives: scipy's kernel (truncate 4 sigma), mode 'reflect'.
 * - Grey closing/opening: flat square, separable max/min.
 * - Distance transform: exact Euclidean (Felzenszwalb and Huttenlocher).
 * - Thinning: Zhang and Suen 1984, the method skimage's skeletonize uses.
 */

export interface Plane {
  data: Float64Array;
  width: number;
  height: number;
}

/** scipy 'reflect' boundary: (d c b a | a b c d | d c b a). */
function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * n;
  let k = i % period;
  if (k < 0) k += period;
  return k < n ? k : period - 1 - k;
}

/** The 1-D Gaussian kernel (or its 1st/2nd derivative) for x = -r..r. */
export function gaussianKernel(sigma: number, order: 0 | 1 | 2): Float64Array {
  const r = Math.floor(4 * sigma + 0.5);
  const k = new Float64Array(2 * r + 1);
  const s2 = sigma * sigma;
  let sum = 0;
  for (let x = -r; x <= r; x++) {
    const v = Math.exp((-0.5 * x * x) / s2);
    k[x + r] = v;
    sum += v;
  }
  for (let x = -r; x <= r; x++) {
    const phi = k[x + r]! / sum;
    if (order === 0) k[x + r] = phi;
    else if (order === 1) k[x + r] = (-x / s2) * phi;
    else k[x + r] = ((x * x) / (s2 * s2) - 1 / s2) * phi;
  }
  return k;
}

/** out[i] = sum_x k(x) * in[i - x] along one axis (scipy's gaussian_filter1d). */
function convolveAxis(src: Float64Array, w: number, h: number, k: Float64Array, axis: 0 | 1): Float64Array {
  const r = (k.length - 1) / 2;
  const out = new Float64Array(src.length);
  if (axis === 1) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += k[d + r]! * src[row + reflect(x - d, w)]!;
        out[row + x] = s;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += k[d + r]! * src[reflect(y - d, h) * w + x]!;
        out[y * w + x] = s;
      }
    }
  }
  return out;
}

/** scipy.ndimage.gaussian_filter(a, sigma, order=(oy, ox)). */
export function gaussian(p: Plane, sigma: number, oy: 0 | 1 | 2, ox: 0 | 1 | 2): Float64Array {
  const t = convolveAxis(p.data, p.width, p.height, gaussianKernel(sigma, oy), 0);
  return convolveAxis(t, p.width, p.height, gaussianKernel(sigma, ox), 1);
}

function runningExtreme(src: Float64Array, w: number, h: number, size: number, axis: 0 | 1, max: boolean): Float64Array {
  const out = new Float64Array(src.length);
  const lo = Math.floor(size / 2);
  const n = axis === 1 ? w : h;
  const lines = axis === 1 ? h : w;
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < n; i++) {
      let best = max ? -Infinity : Infinity;
      for (let d = -lo; d < size - lo; d++) {
        const j = reflect(i + d, n);
        const v = axis === 1 ? src[l * w + j]! : src[j * w + l]!;
        if (max ? v > best : v < best) best = v;
      }
      if (axis === 1) out[l * w + i] = best;
      else out[i * w + l] = best;
    }
  }
  return out;
}

/** Flat square grey dilation (max) or erosion (min), mode 'reflect'. */
export function greyFilter(p: Plane, size: number, max: boolean): Float64Array {
  const t = runningExtreme(p.data, p.width, p.height, size, 1, max);
  return runningExtreme(t, p.width, p.height, size, 0, max);
}

/** scipy grey_closing: dilation then erosion. */
export function greyClosing(p: Plane, size: number): Float64Array {
  const d = greyFilter(p, size, true);
  return greyFilter({ data: d, width: p.width, height: p.height }, size, false);
}

/** scipy grey_opening: erosion then dilation. */
export function greyOpening(p: Plane, size: number): Float64Array {
  const e = greyFilter(p, size, false);
  return greyFilter({ data: e, width: p.width, height: p.height }, size, true);
}

/** Exact Euclidean distance from each set pixel to the nearest unset one. */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d1 = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? INF : 0;
  const pass = (n: number, get: (i: number) => number, set: (i: number, x: number) => void): void => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      const dq = q - v[k]!;
      d1[q] = dq * dq + f[v[k]!]!;
    }
    for (let i = 0; i < n; i++) set(i, d1[i]!);
  };
  for (let x = 0; x < w; x++) pass(h, (i) => g[i * w + x]!, (i, val) => (g[i * w + x] = val));
  for (let y = 0; y < h; y++) pass(w, (i) => g[y * w + i]!, (i, val) => (g[y * w + i] = val));
  for (let i = 0; i < w * h; i++) g[i] = Math.sqrt(g[i]!);
  return g;
}

/** scipy binary_dilation with its default 4-connected cross, `iterations` times. */
export function dilateCross(mask: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const nxt = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cur[y * w + x]) continue;
        if ((x > 0 && cur[y * w + x - 1]) || (x < w - 1 && cur[y * w + x + 1]) ||
            (y > 0 && cur[(y - 1) * w + x]) || (y < h - 1 && cur[(y + 1) * w + x])) nxt[y * w + x] = 1;
      }
    }
    cur = nxt;
  }
  return cur;
}

/** Connected-component labels (1..n, 0 = background). `eight` picks the
 * neighbourhood; scipy's default is the 4-connected cross. */
export function label(mask: Uint8Array, w: number, h: number, eight: boolean): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h);
  let count = 0;
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    count++;
    labels[s] = count;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!eight && dx && dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) {
            labels[j] = count;
            stack.push(j);
          }
        }
      }
    }
  }
  return { labels, count };
}

/** Zhang-Suen thinning to a one-pixel centreline. */
export function skeletonize(mask: Uint8Array, w: number, h: number): Uint8Array {
  const img = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) img[i] = mask[i] ? 1 : 0;
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]!);
  let changed = true;
  const del: number[] = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          del.push(y * w + x);
        }
      }
      if (del.length) {
        changed = true;
        for (const i of del) img[i] = 0;
      }
    }
  }
  return img;
}
