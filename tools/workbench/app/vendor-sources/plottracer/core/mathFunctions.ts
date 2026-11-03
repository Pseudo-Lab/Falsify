/**
 * Originally ported from wpd-core's core/mathFunctions.js.
 * Original: WebPlotDigitizer, Copyright (C) 2025 Ankit Rohatgi, AGPL-3.0.
 * Ported 2026-07 as part of PlotTracer's Product #1 rebuild (see
 * CLAUDE.md "Current scoped task - Step 1: extract core/"). Behavior is
 * intended to be bit-for-bit identical to the original - verified by
 * golden-value tests and a cross-check against the live wpd-core.
 */

/** Inverse tan with range [0, 2π). */
export function taninverse(y: number, x: number): number {
  let invAns: number;
  if (y > 0) {
    invAns = Math.atan2(y, x);
  } else {
    invAns = Math.atan2(y, x) + 2 * Math.PI;
  }
  if (invAns >= 2 * Math.PI) {
    invAns = 0.0;
  }
  return invAns;
}

export function sqDist2d(x1: number, y1: number, x2: number, y2: number): number {
  return (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2);
}

export function dist2d(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(sqDist2d(x1, y1, x2, y2));
}

/** A 2x2 matrix is represented as a flat 4-tuple [a, b, c, d] === [[a,b],[c,d]]. */
export type Mat2x2 = [number, number, number, number];
export type Vec2 = [number, number];

export const mat = {
  det2x2(m: Mat2x2): number {
    return m[0] * m[3] - m[1] * m[2];
  },

  inv2x2(m: Mat2x2): Mat2x2 {
    const det = mat.det2x2(m);
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  },

  mult2x2(m1: Mat2x2, m2: Mat2x2): Mat2x2 {
    return [
      m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    ];
  },

  mult2x2Vec(m: Mat2x2, v: Vec2): Vec2 {
    return [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
  },

  multVec2x2(v: Vec2, m: Mat2x2): Vec2 {
    return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
  },
};

export interface CubicSpline {
  x: number[];
  y: number[];
  len: number;
  d: number[];
}

export interface Circle {
  x0: number;
  y0: number;
  radius: number;
}

/** The circle through 3 points. Non-finite when they are collinear, which the
 *  callers check rather than nudging. */
export function getCircleFrom3Pts(pts: [Vec2, Vec2, Vec2]): Circle {
  const Ax = pts[0][0], Bx = pts[1][0], Cx = pts[2][0];
  const Ay = pts[0][1], By = pts[1][1], Cy = pts[2][1];
  const a = dist2d(Cx, Cy, Bx, By);
  const b = dist2d(Ax, Ay, Cx, Cy);
  const c = dist2d(Bx, By, Ax, Ay);
  const s = (a + b + c) / 2.0;
  const R = (a * b * c) / 4.0 / Math.sqrt(s * (s - a) * (s - b) * (s - c));
  const b1 = a * a * (b * b + c * c - a * a);
  const b2 = b * b * (a * a + c * c - b * b);
  const b3 = c * c * (a * a + b * b - c * c);
  const X: Vec2 = [
    (Ax * b1 + Bx * b2 + Cx * b3) / (b1 + b2 + b3),
    (Ay * b1 + By * b2 + Cy * b3) / (b1 + b2 + b3),
  ];
  return { x0: X[0], y0: X[1], radius: R };
}

/**
 * Best-fit circle through 3 OR MORE points (v1.6, the pie's outline).
 *
 * Three points define a circle exactly, and that case delegates to
 * `getCircleFrom3Pts` above so the two never disagree. Beyond three there is no
 * exact answer, so this is Kåsa's algebraic least-squares fit: minimising
 * (x²+y²) - (2x·x0 + 2y·y0 + c) is LINEAR in the unknowns, which makes it a 3x3
 * solve with no iteration, no initial guess and no convergence to report - the
 * least modelling that answers the question (tenet 10).
 *
 * ⚑ Why more than three is worth allowing: three rim clicks always fit perfectly,
 * so a bad one is undetectable. A fourth is genuine redundancy about the FIGURE
 * (different ink, not the same boundary twice), and the residual it produces says
 * something real - a rim that will not fit a circle is a pie that is not circular.
 *
 * Returns null when the points are collinear or too few, rather than a circle of
 * infinite radius.
 */
export function fitCircle(pts: readonly Vec2[]): Circle | null {
  if (pts.length < 3) return null;
  if (pts.length === 3) {
    const c = getCircleFrom3Pts([pts[0]!, pts[1]!, pts[2]!]);
    return Number.isFinite(c.x0) && Number.isFinite(c.y0) && Number.isFinite(c.radius) && c.radius > 0 ? c : null;
  }
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sz += z;
    sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z;
  }
  // Normal equations for [2x0, 2y0, c] against the centred moments.
  const a11 = sxx - (sx * sx) / n;
  const a12 = sxy - (sx * sy) / n;
  const a22 = syy - (sy * sy) / n;
  const b1 = (sxz - (sx * sz) / n) / 2;
  const b2 = (syz - (sy * sz) / n) / 2;
  const det = a11 * a22 - a12 * a12;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null; // collinear
  const x0 = (b1 * a22 - b2 * a12) / det;
  const y0 = (b2 * a11 - b1 * a12) / det;
  let r = 0;
  for (const [x, y] of pts) r += Math.hypot(x - x0, y - y0);
  r /= n;
  return Number.isFinite(r) && r > 0 ? { x0, y0, radius: r } : null;
}

/** A fitted ellipse, as the two CONJUGATE SEMI-AXIS VECTORS from its centre.
 *
 * ⚑ Returned as vectors rather than (a, b, angle) because that is the form the
 * measurement needs: an ellipse is an AFFINE image of a circle, and `a`/`b` are the
 * images of two orthogonal circle radii. Expressing a pixel in that basis and taking
 * atan2 gives the angle ON THE RECOVERED CIRCLE - the true angle - with the inverse
 * map applied implicitly. No un-rotating, no un-squashing, no branch.
 */
export interface Ellipse {
  x0: number;
  y0: number;
  /** First semi-axis vector (from the centre). */
  ax: number;
  ay: number;
  /** Second semi-axis vector, orthogonal to the first on the recovered circle. */
  bx: number;
  by: number;
}

/**
 * Best-fit ellipse through 5 or more points (v1.6, a tilted or 3D pie).
 *
 * ⚑ WHY THIS EARNS ITS PLACE: about 12% of real pie figures are drawn in 3D
 * (measured on the PMC corpus), and a 3D pie's TOP FACE is a complete, unoccluded
 * ellipse - an exact affine image of the circle. Read flat, its angles are badly
 * wrong: on a real 2:1 figure a 7% slice reads 13.4%, while the readings still sum
 * to 100 so nothing looks amiss. Inverting the map is the difference between a
 * number and a plausible number.
 *
 * Fits the general conic Ax² + Bxy + Cy² + Dx + Ey = 1 by ordinary least squares -
 * linear in five unknowns, so a 5x5 normal-equation solve with no iteration and no
 * eigen-decomposition of the design matrix. Returns null unless the result really is
 * an ellipse (a hyperbola or parabola means the points do not describe one).
 */
export function fitEllipse(pts: readonly Vec2[]): Ellipse | null {
  if (pts.length < 5) return null;
  // Centre and scale the points first: a conic fit on raw pixel coordinates is badly
  // conditioned (x² terms in the millions against x terms in the hundreds).
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let scale = 0;
  for (const [x, y] of pts) scale = Math.max(scale, Math.hypot(x - mx, y - my));
  if (!(scale > 0)) return null;

  const M: number[][] = [];
  const rhs: number[] = [];
  for (const [px, py] of pts) {
    const x = (px - mx) / scale;
    const y = (py - my) / scale;
    M.push([x * x, x * y, y * y, x, y]);
    rhs.push(1);
  }
  // Normal equations MᵀM p = Mᵀ1
  const n = 5;
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b: number[] = new Array<number>(n).fill(0);
  for (let r = 0; r < M.length; r++) {
    for (let i = 0; i < n; i++) {
      b[i]! += M[r]![i]! * rhs[r]!;
      for (let j = 0; j < n; j++) A[i]![j]! += M[r]![i]! * M[r]![j]!;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[piv]![i]!)) piv = r;
    if (Math.abs(A[piv]![i]!) < 1e-12) return null; // singular: no unique conic
    [A[i], A[piv]] = [A[piv]!, A[i]!];
    [b[i], b[piv]] = [b[piv]!, b[i]!];
    for (let r = i + 1; r < n; r++) {
      const f = A[r]![i]! / A[i]![i]!;
      for (let c = i; c < n; c++) A[r]![c]! -= f * A[i]![c]!;
      b[r]! -= f * b[i]!;
    }
  }
  const p = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let acc = b[i]!;
    for (let c = i + 1; c < n; c++) acc -= A[i]![c]! * p[c]!;
    p[i] = acc / A[i]![i]!;
  }
  const [ca, cb, cc, cd, ce] = p as [number, number, number, number, number];
  const cf = -1; // the constant we normalised to

  // Ellipse iff the discriminant B² - 4AC is negative.
  if (!(cb * cb - 4 * ca * cc < 0)) return null;

  // Centre: solve [2A B; B 2C][x0,y0]ᵀ = [-D,-E]ᵀ
  const det = 4 * ca * cc - cb * cb;
  const x0 = (cb * ce - 2 * cc * cd) / det;
  const y0 = (cb * cd - 2 * ca * ce) / det;
  // Constant after translating to the centre.
  const fc = cf + (cd * x0 + ce * y0) / 2;
  // Eigenvalues of [[A, B/2], [B/2, C]] give the axis lengths.
  const tr = ca + cc;
  const dsc = Math.sqrt(Math.max(0, (ca - cc) * (ca - cc) + cb * cb));
  const l1 = (tr + dsc) / 2;
  const l2 = (tr - dsc) / 2;
  const r1 = Math.sqrt(-fc / l1);
  const r2 = Math.sqrt(-fc / l2);
  if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0 || r2 <= 0) return null;
  // Orientation of the first principal axis.
  const th = 0.5 * Math.atan2(cb, ca - cc);
  const cosT = Math.cos(th), sinT = Math.sin(th);
  // ⚑ MAJOR AXIS FIRST. The eigenvalue ordering can hand back either one, and for
  // measurement it makes no difference (the pair stays orthogonal, so the frame just
  // rotates a quarter turn and sector DIFFERENCES are untouched). It matters for
  // everything else: `a` is what the radius readout and any drawn overlay mean by
  // "the radius", and a frame that silently flips between figures is a bug waiting to
  // be reported as one.
  const swap = r2 > r1;
  const rA = swap ? r2 : r1;
  const rB = swap ? r1 : r2;
  const cA = swap ? -sinT : cosT;
  const sA = swap ? cosT : sinT;
  return {
    x0: x0 * scale + mx,
    y0: y0 * scale + my,
    ax: rA * cA * scale,
    ay: rA * sA * scale,
    bx: -rB * sA * scale,
    by: rB * cA * scale,
  };
}

/** How far the points stray from a fitted circle (RMS, in pixels) - a property of
 * the FIGURE, not of the fit: a rim that will not sit on a circle is telling you the
 * pie is tilted or was drawn as an ellipse. Reported, never acted on (the app does
 * not infer tilt). */
export function circleFitResidual(pts: readonly Vec2[], circle: Circle): number {
  if (pts.length === 0) return 0;
  let acc = 0;
  for (const [x, y] of pts) {
    const d = Math.hypot(x - circle.x0, y - circle.y0) - circle.radius;
    acc += d * d;
  }
  return Math.sqrt(acc / pts.length);
}

/** Normalize an angle in degrees to [0, 360). */
export function normalizeAngleDeg(angleDeg: number): number {
  let normDeg = angleDeg % 360;
  if (normDeg < 0) {
    normDeg += 360.0;
  }
  return normDeg;
}

/**
 * ⚑⚑ "ARE THESE TWO DIRECTIONS THE SAME DIRECTION" IS A QUESTION ABOUT AN
 * ANGLE, so the answer must not carry the size of the figure.
 *
 * `|sin(theta)|` between two 2-D directions: the cross product divided by both
 * lengths. Zero-length directions answer 0, which reads as "no angle at all" -
 * they are another check's case (two clicks on one pixel) and a 0/0 NaN would
 * slip past every comparison rather than being refused.
 *
 * ⚑ It exists because the raw cross product is `|d1| |d2| sin(theta)`, so
 * comparing THAT against a fixed epsilon asks a question that tightens as the
 * figure grows: on a 300px frame an epsilon of 1e-9 fires at about 1e-14, which
 * is exact degeneracy and nothing else. Photograph the same figure twice the
 * size and it answers differently about a reading of identical quality.
 */
export function sineBetween(ax: number, ay: number, bx: number, by: number): number {
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (!(lengths > 0) || !Number.isFinite(lengths)) return 0;
  const sine = Math.abs(ax * by - ay * bx) / lengths;
  return Number.isFinite(sine) ? sine : 0;
}

/**
 * ⚑⚑ BELOW THIS ANGLE A READING HAS STOPPED MEANING ANYTHING, so a calibration
 * that rests on it is refused rather than reported.
 *
 * 0.01 is about 0.57 degrees, and it is deliberately the conservative end:
 * sensitivity to a click goes as `1 / sin(theta)`, so there one pixel of click
 * error on a 300px frame moves a value by tens of units on a 0..100 scale, while
 * a badly distorted photograph sits at tens of degrees and is thousands of times
 * clear of it. A guard wants that margin: it refuses only frames that cannot be
 * read, and never argues with a real figure.
 */
export const MIN_READABLE_SINE = 0.01;
