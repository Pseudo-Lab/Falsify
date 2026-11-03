/** Small geometry for Find lines. Points are [x, y] in image pixels. */

export type Pt = [number, number];

export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
export const dot = (a: Pt, b: Pt): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Pt, b: Pt): number => a[0] * b[1] - a[1] * b[0];
export const norm = (a: Pt): number => Math.hypot(a[0], a[1]);
export const unit = (a: Pt): Pt => {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n] : [0, 0];
};

/** Python's round(): halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function pathLength(p: readonly Pt[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
  return s;
}

/** The leading stretch of `p` within arc length `L`. */
export function prefixWithin(p: readonly Pt[], L: number): Pt[] {
  if (p.length < 2) return p.slice();
  const out: Pt[] = [p[0]!];
  let d = 0;
  for (let i = 1; i < p.length; i++) {
    d += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
    if (d > L) break;
    out.push(p[i]!);
  }
  return out;
}

export function centroid(p: readonly Pt[]): Pt {
  let x = 0, y = 0;
  for (const q of p) {
    x += q[0];
    y += q[1];
  }
  return [x / p.length, y / p.length];
}

/** Least-squares polynomial, coefficients highest power first (numpy.polyfit). */
export function polyfit(x: readonly number[], y: readonly number[], deg: number): number[] | null {
  const n = x.length;
  if (n === 0) return null;
  let sc = 0;
  for (const v of x) sc = Math.max(sc, Math.abs(v));
  if (sc === 0) sc = 1;
  const m = deg + 1;
  // Householder QR on the scaled Vandermonde matrix
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    const t = x[i]! / sc;
    for (let j = 0; j < m; j++) row.push(t ** (deg - j));
    A.push(row);
  }
  const b = y.slice();
  const R = A.map((r) => r.slice());
  for (let k = 0; k < Math.min(m, n); k++) {
    let nrm = 0;
    for (let i = k; i < n; i++) nrm += R[i]![k]! ** 2;
    nrm = Math.sqrt(nrm);
    if (nrm < 1e-300) continue;
    const alpha = R[k]![k]! > 0 ? -nrm : nrm;
    const v: number[] = new Array(n).fill(0);
    v[k] = R[k]![k]! - alpha;
    for (let i = k + 1; i < n; i++) v[i] = R[i]![k]!;
    let vv = 0;
    for (let i = k; i < n; i++) vv += v[i]! ** 2;
    if (vv < 1e-300) continue;
    for (let j = k; j < m; j++) {
      let s = 0;
      for (let i = k; i < n; i++) s += v[i]! * R[i]![j]!;
      s = (2 * s) / vv;
      for (let i = k; i < n; i++) R[i]![j] = R[i]![j]! - s * v[i]!;
    }
    let s = 0;
    for (let i = k; i < n; i++) s += v[i]! * b[i]!;
    s = (2 * s) / vv;
    for (let i = k; i < n; i++) b[i] = b[i]! - s * v[i]!;
  }
  const c = new Array<number>(m).fill(0);
  for (let j = Math.min(m, n) - 1; j >= 0; j--) {
    let s = b[j]!;
    for (let k = j + 1; k < m; k++) s -= R[j]![k]! * c[k]!;
    const d = R[j]![j]!;
    c[j] = Math.abs(d) < 1e-12 ? 0 : s / d;
  }
  // undo the scaling: c[j] multiplies (x/sc)^(deg-j)
  return c.map((v, j) => v / sc ** (deg - j));
}

export function polyval(c: readonly number[], x: number): number {
  let s = 0;
  for (const v of c) s = s * x + v;
  return s;
}

/** The fair interpolation between two line ends: a cubic Hermite from p0
 * leaving along t0 to p1 arriving along t1, interior points only. A dot or a
 * short dash has no direction worth bending to, so `straight` draws a chord. */
export function hermite(p0: Pt, t0: Pt, p1: Pt, t1: Pt, straight = false, step = 1): Pt[] {
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const n = Math.max(2, Math.trunc(L / step));
  const out: Pt[] = [];
  for (let i = 1; i < n; i++) {
    const s = i / n;
    if (straight) {
      out.push([p0[0] + (p1[0] - p0[0]) * s, p0[1] + (p1[1] - p0[1]) * s]);
      continue;
    }
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
    const h10 = s ** 3 - 2 * s ** 2 + s;
    const h01 = -2 * s ** 3 + 3 * s ** 2;
    const h11 = s ** 3 - s ** 2;
    out.push([
      h00 * p0[0] + h10 * L * t0[0] + h01 * p1[0] + h11 * L * t1[0],
      h00 * p0[1] + h10 * L * t0[1] + h01 * p1[1] + h11 * L * t1[1],
    ]);
  }
  return out;
}

/** Nearest distance from each point of `a` to the point set `b` (small sets). */
export function nearestDistances(a: readonly Pt[], b: readonly Pt[]): number[] {
  return a.map((p) => {
    let best = Infinity;
    for (const q of b) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  });
}

/** Net turning of a path, sampled every ~3 px so pixel staircases do not add up. */
export function netTurn(p: readonly Pt[]): number {
  if (p.length < 3) return 0;
  const d: number[] = [0];
  for (let i = 1; i < p.length; i++) d.push(d[i - 1]! + Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]));
  const total = d[d.length - 1]!;
  const q: Pt[] = [];
  let j = 0;
  for (let s = 0; s < total; s += 3) {
    while (j < d.length && d[j]! < s) j++;
    q.push(p[Math.min(j, p.length - 1)]!);
  }
  if (q.length < 3) return 0;
  let prev = Math.atan2(q[1]![1] - q[0]![1], q[1]![0] - q[0]![0]);
  const first = prev;
  let acc = prev;
  for (let i = 2; i < q.length; i++) {
    const a = Math.atan2(q[i]![1] - q[i - 1]![1], q[i]![0] - q[i - 1]![0]);
    let da = a - prev;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    acc += da;
    prev = a;
  }
  return acc - first;
}
