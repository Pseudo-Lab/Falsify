/**
 * FIND LINES (v2.6, first version) - every line of one colour, each its own
 * line, even where same-colour lines meet, cross, run together or are cut by
 * their own labels.
 *
 * Ported from the research pipeline that was measured against pixel truth on
 * unseen figures (plottracer-ref, research/v2.6-separation, FINDINGS.md). The
 * stages, each covering another's blind spot:
 *
 *  1. ink coverage -> centreline graph (ends, junctions, chains)
 *  2. where lines CROWD (centres a few px apart, side by side), sub-pixel ridge
 *     chains replace the centreline - the pixels still separate them there
 *  3. junctions joined by short chains collapse into one MEETING PLACE, and the
 *     branch ends there are PAIRED so each continues the direction it arrived
 *     on. Contours: only non-crossing pairings (contours never cross). A pairing
 *     is used only when it beats the runner-up by a margin.
 *  4. a SHARED STRETCH (two lines run together and part): the stretch belongs
 *     to BOTH; which exit continues which entry is decided across it
 *  5. a LABEL owns the gap it sits in (matplotlib's clabel in reverse): the two
 *     ends either side of it, pointing at it, are one line
 *  6. dash gaps: ends that point at each other, never passing another line
 *  7. contours cannot cross or spiral: a join that makes them is cut again
 *  8. closure is MEASURED from the ink
 *
 * ⚑⚑ DAVID'S RULE (2026-10-07) runs through every stage: a gap, a crossing, a
 * label cut is PRESENTATION - bridge it with a fair interpolation, recorded as
 * one line - but only with confidence. Where the pairing is unsure, SPLIT: the
 * pieces stay separate lines and the place is reported (`places`), so the user
 * can join them. Nothing is guessed silently.
 */
import { dilateCross, distanceTransform, label, skeletonize } from './raster.js';
import { inkCoverage, lineMask, ridgeChains, ridgePoints, type Box, type RGB } from './ink.js';
import { skeletonGraph, type GraphEdge, type YX } from './graph.js';
import {
  centroid, cross, dot, hermite, nearestDistances, netTurn, norm, pathLength, polyfit, polyval,
  prefixWithin, roundHalfEven, sub, unit, type Pt,
} from './geom.js';

/** measured: on the ink. bridged: a fair interpolation across a gap the figure
 * drew none in. shared: on a stretch two lines run along together. */
export type PointRole = 'measured' | 'bridged' | 'shared';

export interface FoundLine {
  points: Pt[];
  roles: PointRole[];
  closed: boolean;
  /** Gaps bridged by pairing two ends: [end before, end after]. */
  gaps: [Pt, Pt][];
}

/** A place the first version was unsure about, for the user to check (K1). */
export interface Place {
  /** bridge: lines met and were joined; split: pieces left apart where unsure;
   * end: a line stops inside the plot, where it may well carry on; unresolved:
   * merged ink not recorded as a line. */
  kind: 'bridge' | 'split' | 'end' | 'unresolved';
  at: Pt;
  /** Indices into `lines` this place touches. */
  lines: number[];
}

export interface FindLinesResult {
  lines: FoundLine[];
  /** Small isolated ink: label digits and the like. Shown, never a line (F7). */
  labelInk: Pt[][];
  /** Ink where lines merge beyond what the pixels separate (N1). Shown, not a line. */
  unresolved: Pt[][];
  places: Place[];
  /** The measured line width, px. */
  lineWidth: number;
}

export interface FindLinesOptions {
  /** Contours never cross; curves may. The chart type the user chose. */
  contour: boolean;
  /** Regions the user marked as not data (a legend). Lines may bridge across them. */
  masks?: readonly Box[];
  /** Each level is drawn in its own colour (the figure has a colour key): only
   * this colour's lines are wanted, so neighbouring colours must be refused. */
  coloursAreLevels?: boolean;
  /** For measurement only: override the residual tolerance. */
  residualTolerance?: number;
}

const O = {
  margin: 0.25, maxTurn: 0.6, gapAngle: 0.8, gapMax: 6.0, region: 3.0, spur: 2.0, minLen: 8.0,
  complexLen: 45, predictW: 0.1, smoothW: 0.15, labelExt: 22.0, labelBox: 30.0, gapLabel: 90.0,
  charGap: 5.0, labelCost: 0.6, dashAlign: 20, straightBelow: 8.0, crowdR: 3.5, crowdMin: 25,
  bandSkip: 4.0, bandLat: 3.0, unresLen: 40.0, selfClose: 4.0, maxBranches: 8,
  predictRatio: 0.6, sharedMargin: 0.15, smoothRatio: 0.6, touchP: 1.6, crossP: 1.3, runalongP: 2.7,
};

const xyOf = (pix: readonly YX[]): Pt[] => pix.map(([y, x]) => [x, y]);

class Piece {
  pts: Pt[];
  node: [number | null, number | null] = [null, null];
  shared = false;
  loop = false;
  constructor(pts: Pt[]) {
    this.pts = pts;
  }
  end(k: 0 | 1): Pt {
    return k === 0 ? this.pts[0]! : this.pts[this.pts.length - 1]!;
  }
  /** Unit direction the line travels when it LEAVES the piece at end k. */
  tangent(k: 0 | 1, skip = 0, span = 10): Pt {
    const p = k === 1 ? this.pts : [...this.pts].reverse();
    const n = p.length;
    let a = Math.max(0, n - 1 - skip - span);
    let b = Math.max(0, n - 1 - skip);
    if (b - a < 2) {
      a = 0;
      b = n - 1;
    }
    return unit(sub(p[b]!, p[a]!));
  }
  /** Points starting AT end k and running away from it. */
  away(k: 0 | 1, skip: number): Pt[] {
    const p = k === 1 ? [...this.pts].reverse() : this.pts;
    return p.slice(skip);
  }
  length(): number {
    return pathLength(this.pts);
  }
}

type End = readonly [number, 0 | 1];
const ek = (e: End): string => `${e[0]}:${e[1]}`;
const pk = (a: End, b: End): string => {
  const x = ek(a), y = ek(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
};

/** A tracker's question: fit the arriving arm with a quadratic in its own frame,
 * extrapolate it across the meeting place, and measure how far the leaving arm
 * lies from the prediction (rms px). Null if undefined. */
function predictErr(armIn: readonly Pt[], armOut: readonly Pt[], span = 80, ahead = 40): number | null {
  const A = prefixWithin(armIn, span);
  const C = prefixWithin(armOut, ahead);
  if (A.length < 8 || C.length < 4) return null;
  const o = A[0]!;
  const t = sub(A[0]!, A[A.length - 1]!);
  const nt = norm(t);
  if (nt < 1e-6) return null;
  const tu: Pt = [t[0] / nt, t[1] / nt];
  const nr: Pt = [-tu[1], tu[0]];
  const xa = A.map((p) => dot(sub(p, o), tu));
  const ya = A.map((p) => dot(sub(p, o), nr));
  const xc = C.map((p) => dot(sub(p, o), tu));
  const yc = C.map((p) => dot(sub(p, o), nr));
  if (xc.reduce((s, v) => s + v, 0) / xc.length <= 0) return null;
  const co = polyfit(xa, ya, 2);
  if (!co) return null;
  let s = 0;
  for (let i = 0; i < xc.length; i++) s += (polyval(co, xc[i]!) - yc[i]!) ** 2;
  return Math.sqrt(s / xc.length);
}

/** How well ONE smooth curve explains an arriving and a leaving branch: rms
 * residual of a cubic through both in their joint chord's frame. */
function smoothCost(pa: readonly Pt[], pb: readonly Pt[], span = 30): number | null {
  const A = prefixWithin(pa, span);
  const B = prefixWithin(pb, span);
  if (A.length < 5 || B.length < 5) return null;
  return fitResidual([...[...A].reverse(), ...B], 3);
}

function fitResidual(Q: readonly Pt[], deg: number): number | null {
  const c = centroid(Q);
  const u0 = sub(Q[Q.length - 1]!, Q[0]!);
  const n = norm(u0);
  if (n < 1e-6) return null;
  const u: Pt = [u0[0] / n, u0[1] / n];
  const v: Pt = [-u[1], u[0]];
  const x = Q.map((p) => dot(sub(p, c), u));
  const y = Q.map((p) => dot(sub(p, c), v));
  if (Math.max(...x) - Math.min(...x) < 1e-6) return null;
  const co = polyfit(x, y, deg);
  if (!co) return null;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (polyval(co, x[i]!) - y[i]!) ** 2;
  return Math.sqrt(s / x.length);
}

/** Perfect (or one-left-out, for odd counts) matchings of n branch ends, in the
 * research's generation order. Contours: only non-crossing ones in the cyclic
 * order around the place. */
function* matchings(seq: number[], contour: boolean): Generator<[number, number][]> {
  if (contour) {
    if (!seq.length) {
      yield [];
      return;
    }
    if (seq.length % 2 === 1) {
      for (let k = 0; k < seq.length; k++) yield* matchings([...seq.slice(0, k), ...seq.slice(k + 1)], true);
      return;
    }
    const a = seq[0]!;
    for (let k = 1; k < seq.length; k += 2) {
      for (const left of matchings(seq.slice(1, k), true)) {
        for (const right of matchings(seq.slice(k + 1), true)) yield [[a, seq[k]!], ...left, ...right];
      }
    }
    return;
  }
  if (seq.length < 2) {
    yield [];
    return;
  }
  if (seq.length % 2 === 1) {
    for (let k = 0; k < seq.length; k++) yield* matchings([...seq.slice(0, k), ...seq.slice(k + 1)], false);
    return;
  }
  const a = seq[0]!;
  for (let k = 1; k < seq.length; k++) {
    for (const m of matchings([...seq.slice(1, k), ...seq.slice(k + 1)], false)) yield [[a, seq[k]!], ...m];
  }
}

function bestMatching(n: number, cost: number[][], contour: boolean, angles: number[]): { pairs: [number, number][]; best: number; runner: number } {
  const order = contour ? [...Array(n).keys()].sort((i, j) => angles[i]! - angles[j]!) : [...Array(n).keys()];
  const seen = new Set<string>();
  const results: { c: number; m: [number, number][] }[] = [];
  let count = 0;
  for (const m of matchings(order, contour)) {
    if (++count > 20000) break;
    const key = m.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    let c = n - 2 * m.length;
    for (const [i, j] of m) c += cost[i]![j]!;
    results.push({ c, m });
  }
  if (!results.length) return { pairs: [], best: 0, runner: 0 };
  results.sort((a, b) => a.c - b.c);
  const best = results[0]!;
  return { pairs: best.m, best: best.c, runner: results.length > 1 ? results[1]!.c : best.c + 99 };
}

/**
 * Find lines inside `box`. ⚑ The image is CROPPED to the box (plus a margin
 * for the background estimate and the ridge filters) before any image work
 * (audit B7): every stage is per-pixel, and run over a whole 3000x3000 scan
 * it held the UI thread ~18 s for ink that can only be inside the box anyway.
 */
export function findLines(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, colour: RGB, box: Box, opts: FindLinesOptions): FindLinesResult {
  const m = 16;
  const x0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1)) - m), y0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1)) - m);
  const x1 = Math.min(w - 1, Math.ceil(Math.max(box.x0, box.x1)) + m), y1 = Math.min(h - 1, Math.ceil(Math.max(box.y0, box.y1)) + m);
  if (x1 <= x0 || y1 <= y0) return { lines: [], labelInk: [], unresolved: [], places: [], lineWidth: 1.5 };
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const crop = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) crop.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  const shiftBox = (b: Box): Box => ({ x0: b.x0 - x0, y0: b.y0 - y0, x1: b.x1 - x0, y1: b.y1 - y0 });
  const res = findLinesInCrop(crop, cw, ch, colour, shiftBox(box), { ...opts, masks: (opts.masks ?? []).map(shiftBox) });
  const back = (p: Pt): Pt => [p[0] + x0, p[1] + y0];
  return {
    lines: res.lines.map((L) => ({ ...L, points: L.points.map(back), gaps: L.gaps.map(([a, b]) => [back(a), back(b)] as [Pt, Pt]) })),
    labelInk: res.labelInk.map((q) => q.map(back)),
    unresolved: res.unresolved.map((q) => q.map(back)),
    places: res.places.map((pl) => ({ ...pl, at: back(pl.at) })),
    lineWidth: res.lineWidth,
  };
}

function findLinesInCrop(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, colour: RGB, box: Box, opts: FindLinesOptions): FindLinesResult {
  const contour = opts.contour;
  const masks = opts.masks ?? [];
  const cov = inkCoverage(rgba, w, h, colour);
  // ⚑⚑ WHEN EACH LEVEL HAS ITS OWN COLOUR, THE RESIDUAL MUST BE TIGHT. It is how
  // far a pixel is from any paper-to-ink mix. 70 was measured on same-colour
  // figures, where nothing near the picked colour is a different line - and a
  // fixed tight value broke them (heldout2 337 -> 302 whole; on scan-like
  // copies a coloured line's OWN pixels sit at ~44). On a viridis contour plot
  // the next level's line sits only ~22 from the picked one (measured on
  // contour-coloured-key: own line 0, neighbours 22-23), so with 70 one press
  // took four levels' lines and merged them (F11). The user saying "this plot
  // has a colour key" is what says the colours ARE the levels - and then the
  // tolerance is MEASURED from the figure: how much the picked ink's own solid
  // pixels stray from a pure mix (see ownInkResidual). Measured on the clean
  // coloured-key figure: 5 keeps both level-24 lines (98.9% covered) and no
  // other level; 15 let 19 pieces of levels 22 and 26 through.
  const resTol = opts.residualTolerance ?? (opts.coloursAreLevels ? ownInkResidual(rgba, w, h, colour, cov, box) : 70);
  const mask = lineMask(cov, w, h, box, masks, 0.3, resTol);
  const skel = skeletonize(mask, w, h);
  const graph = skeletonGraph(skel, w, h);
  const nodes = graph.nodes;
  let edges = graph.edges;
  const dt = distanceTransform(mask, w, h);
  const lw = (() => {
    const v: number[] = [];
    for (const e of edges) for (const [y, x] of e.pix.slice(2, -2)) v.push(dt[y * w + x]!);
    if (!v.length) return 1.5;
    v.sort((a, b) => a - b);
    const med = v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
    return Math.max(1, 2 * med - 1);
  })();

  // --- 2. where lines CROWD, the ridge chains take over from the centreline
  let crowd: Uint8Array | null = null;
  if (contour) {
    // the same residual as the mask - one rule for what counts as this ink
    const rp = ridgePoints(cov, w, h, box, 0.7, 0.03, 3, 0.12, resTol);
    const cr = new Uint8Array(w * h);
    if (rp.count) {
      const near = new Map<number, number[]>();
      const cell = O.crowdR;
      const grid = new Map<string, number[]>();
      for (let i = 0; i < rp.count; i++) {
        const k = `${Math.floor(rp.px[i]! / cell)},${Math.floor(rp.py[i]! / cell)}`;
        let c = grid.get(k);
        if (!c) grid.set(k, (c = []));
        c.push(i);
      }
      for (let i = 0; i < rp.count; i++) {
        const cx = Math.floor(rp.px[i]! / cell), cy = Math.floor(rp.py[i]! / cell);
        const list: number[] = [];
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          for (const j of grid.get(`${cx + a},${cy + b}`) ?? []) {
            if (Math.hypot(rp.px[j]! - rp.px[i]!, rp.py[j]! - rp.py[i]!) <= O.crowdR) list.push(j);
          }
        }
        near.set(i, list);
      }
      for (let i = 0; i < rp.count; i++) {
        for (const j of near.get(i)!) {
          const vx = rp.px[j]! - rp.px[i]!, vy = rp.py[j]! - rp.py[i]!;
          const lat = Math.abs(vx * rp.dy[i]! - vy * rp.dx[i]!);
          if (lat > 1.0 && Math.abs(rp.dx[i]! * rp.dx[j]! + rp.dy[i]! * rp.dy[j]!) > 0.8) {
            const x = roundHalfEven(rp.px[i]!), y = roundHalfEven(rp.py[i]!);
            if (x >= 0 && y >= 0 && x < w && y < h) cr[y * w + x] = 1;
            break;
          }
        }
      }
    }
    // only real crowds, not one stray pair
    const { labels: lab, count } = label(dilateCross(cr, w, h, 2), w, h, false);
    const size = new Int32Array(count + 1);
    for (let i = 0; i < w * h; i++) if (cr[i]) size[lab[i]!] = size[lab[i]!]! + 1;
    const big = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < w * h; i++) if (lab[i] && size[lab[i]!]! >= O.crowdMin) {
      big[i] = 1;
      any = true;
    }
    if (any) {
      crowd = dilateCross(big, w, h, 3);
      const inR = (y: number, x: number): boolean => {
        const yy = roundHalfEven(y), xx = roundHalfEven(x);
        return yy >= 0 && xx >= 0 && yy < h && xx < w && crowd![yy * w + xx] === 1;
      };
      const next: GraphEdge[] = [];
      for (const e of edges) {
        let run: YX[] = [];
        let startIsOrig = true;
        for (const p of e.pix) {
          if (!inR(p[0], p[1])) run.push(p);
          else {
            if (run.length >= 2) next.push({ a: startIsOrig ? e.a : null, b: null, pix: run });
            run = [];
            startIsOrig = false;
          }
        }
        if (run.length >= 2) next.push({ a: startIsOrig ? e.a : null, b: e.b, pix: run, ...(startIsOrig && e.loop ? { loop: true } : {}) });
      }
      for (const c of ridgeChains(rp)) {
        let run: YX[] = [];
        for (const i of c) {
          const x = rp.px[i]!, y = rp.py[i]!;
          if (inR(y, x)) run.push([y, x]);
          else {
            if (run.length >= 2) next.push({ a: null, b: null, pix: run });
            run = [];
          }
        }
        if (run.length >= 2) next.push({ a: null, b: null, pix: run });
      }
      edges = next;
    }
  }
  const onFrame = (p: Pt): boolean => Math.min(p[0] - box.x0, box.x1 - p[0], p[1] - box.y0, box.y1 - p[1]) < 3 + 3 + lw;

  // --- prune spurs: short end-to-junction whiskers
  const spur = O.spur * lw + 3;
  const deg = new Map<number, number>();
  for (const e of edges) for (const k of [e.a, e.b]) if (k !== null) deg.set(k, (deg.get(k) ?? 0) + 1);
  edges = edges.filter((e) => {
    if (e.a === null || e.b === null || e.pix.length >= spur) return true;
    const ka = nodes[e.a]!.kind, kb = nodes[e.b]!.kind;
    return !((ka === 'end' && kb === 'junc' && deg.get(e.b)! >= 3) || (kb === 'end' && ka === 'junc' && deg.get(e.a)! >= 3));
  });

  // --- meeting places: junctions joined by short chains are ONE place
  const regionLen = contour ? O.region * lw + 4 : Math.max(O.region * lw + 4, O.complexLen);
  const parent = nodes.map((_, i) => i);
  const find = (k: number): number => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]!]!;
      k = parent[k]!;
    }
    return k;
  };
  const isJunc = (k: number | null): k is number => k !== null && nodes[k]!.kind === 'junc';
  const pieceEdges: GraphEdge[] = [];
  for (const e of edges) {
    if (isJunc(e.a) && isJunc(e.b) && e.pix.length < regionLen) parent[find(e.a)] = find(e.b);
    else pieceEdges.push(e);
  }
  const P: Piece[] = [];
  for (const e of pieceEdges) {
    const pts = xyOf(e.pix);
    if (pts.length < 2) continue;
    const pc = new Piece(pts);
    pc.node = [e.a, e.b];
    pc.loop = !!e.loop;
    P.push(pc);
  }
  const endsAt = new Map<number, End[]>();
  P.forEach((pc, i) => {
    for (const k of [0, 1] as const) {
      const nd = pc.node[k];
      if (isJunc(nd)) {
        const r = find(nd);
        if (!endsAt.has(r)) endsAt.set(r, []);
        endsAt.get(r)!.push([i, k]);
      }
    }
  });
  const partner = new Map<string, End>();
  const bridges = new Map<string, Pt[]>();
  const gaps = new Map<string, [Pt, Pt]>();
  const link = (a: End, b: End, br: Pt[], gap?: [Pt, Pt]): void => {
    partner.set(ek(a), b);
    partner.set(ek(b), a);
    bridges.set(pk(a, b), br);
    if (gap) gaps.set(pk(a, b), gap);
  };
  const skip = roundHalfEven(lw) + 1;
  const places: { kind: Place['kind']; at: Pt; ends: End[] }[] = [];

  // --- 4. SHARED STRETCH: Y - one stroke - Y
  const handled = new Set<number>();
  const nOrig = P.length;
  for (let ei = 0; ei < nOrig; ei++) {
    const pc = P[ei]!;
    const [n0, n1] = pc.node;
    if (!isJunc(n0) || !isJunc(n1)) continue;
    const r1 = find(n0), r2 = find(n1);
    if (r1 === r2 || (endsAt.get(r1)?.length ?? 0) !== 3 || (endsAt.get(r2)?.length ?? 0) !== 3) continue;
    if (handled.has(r1) || handled.has(r2)) continue;
    const o1 = endsAt.get(r1)!.filter((b) => !(b[0] === ei && b[1] === 0));
    const o2 = endsAt.get(r2)!.filter((b) => !(b[0] === ei && b[1] === 1));
    if (o1.length !== 2 || o2.length !== 2) continue;
    const te0 = pc.tangent(0, skip);
    const te1 = pc.tangent(1, skip);
    const T1 = o1.map(([i, k]) => P[i]!.tangent(k, skip));
    const T2 = o2.map(([i, k]) => P[i]!.tangent(k, skip));
    if (Math.max(...T1.map((t) => 1 + dot(t, te0))) > O.maxTurn || Math.max(...T2.map((t) => 1 + dot(t, te1))) > O.maxTurn) continue;
    const turn = (a: number, c: number): number => 1 + dot(T1[a]!, T2[c]!);
    const cKeep = turn(0, 0) + turn(1, 1);
    const cSwap = turn(0, 1) + turn(1, 0);
    let choice: 'keep' | 'swap' | null = null;
    const inO1 = (b: End): boolean => o1.some((x) => x[0] === b[0] && x[1] === b[1]);
    if (contour) {
      const d = unit(sub(pc.pts[pc.pts.length - 1]!, pc.pts[0]!));
      const side = (b: End): number => {
        const pts = b[1] === 0 ? P[b[0]]!.pts : [...P[b[0]]!.pts].reverse();
        const q = sub(pts[Math.min(pts.length - 1, 8)]!, inO1(b) ? pc.end(0) : pc.end(1));
        return Math.sign(d[0] * q[1] - d[1] * q[0]);
      };
      const s1 = o1.map(side), s2 = o2.map(side);
      if (![...s1, ...s2].includes(0) && s1[0] !== s1[1] && s2[0] !== s2[1]) choice = s1[0] === s2[0] ? 'keep' : 'swap';
    } else {
      // predict across the stretch, as a tracker does
      const armPts = (b: End): Pt[] => P[b[0]]!.away(b[1], skip);
      const pe = (a: number, c: number): number | null => {
        const far = pc.length() + 40;
        const v1 = predictErr(armPts(o1[a]!), [...pc.pts, ...armPts(o2[c]!)], 80, far);
        const v2 = predictErr(armPts(o2[c]!), [...[...pc.pts].reverse(), ...armPts(o1[a]!)], 80, far);
        const vv = [v1, v2].filter((v): v is number => v !== null);
        return vv.length ? vv.reduce((s, v) => s + v, 0) / vv.length : null;
      };
      const pkp = [pe(0, 0), pe(1, 1)], psp = [pe(0, 1), pe(1, 0)];
      if (![...pkp, ...psp].includes(null)) {
        const kk = pkp[0]! + pkp[1]!, ss = psp[0]! + psp[1]!;
        if (Math.min(kk, ss) < O.predictRatio * Math.max(kk, ss)) choice = kk < ss ? 'keep' : 'swap';
      }
      if (choice === null && Math.abs(cKeep - cSwap) >= O.sharedMargin) choice = cKeep < cSwap ? 'keep' : 'swap';
      else if (choice === null) {
        const arm = (b: End, span = 40): Pt[] | null => {
          const p = P[b[0]]!.away(b[1], skip);
          return p.length < 2 ? null : prefixWithin(p, span);
        };
        const fit4 = (a: number, c: number): number | null => {
          const A = arm(o1[a]!), C = arm(o2[c]!);
          if (!A || !C || A.length < 5 || C.length < 5) return null;
          return fitResidual([...[...A].reverse(), ...pc.pts, ...C], 4);
        };
        // how the gap GROWS away from the touch: ~s^2 a tangent touch, ~s a crossing
        const growth = (arms: End[], base: number): number | null => {
          const A = arm(arms[0]!, 90), B = arm(arms[1]!, 90);
          if (!A || !B || A.length < 8 || B.length < 8) return null;
          const dB = nearestDistances(A, B);
          const sA: number[] = [base];
          for (let i = 1; i < A.length; i++) sA.push(sA[i - 1]! + norm(sub(A[i]!, A[i - 1]!)));
          const lx: number[] = [], ly: number[] = [];
          for (let i = 0; i < A.length; i++) if (dB[i]! > 1.5 && sA[i]! > 2) {
            lx.push(Math.log(sA[i]!));
            ly.push(Math.log(dB[i]!));
          }
          if (lx.length < 6) return null;
          return polyfit(lx, ly, 1)?.[0] ?? null;
        };
        const Ls = pc.length() / 2 + skip;
        const g1 = growth(o1, Ls), g2 = growth(o2, Ls);
        if (g1 !== null && g2 !== null) {
          const d = unit(sub(pc.pts[pc.pts.length - 1]!, pc.pts[0]!));
          const relSide = (arms: End[]): number => {
            const A = arm(arms[0]!, 90)!, B = arm(arms[1]!, 90)!;
            const k = Math.min(A.length, B.length) - 1;
            if (k < 4) return 0;
            const q = sub(A[k]!, B[k]!);
            return Math.sign(d[0] * q[1] - d[1] * q[0]);
          };
          const r1s = relSide(o1), r2s = relSide(o2);
          if (r1s !== 0 && r2s !== 0) {
            const same = r1s === r2s ? 'keep' : 'swap';
            const other = same === 'keep' ? 'swap' : 'keep';
            if (Math.max(g1, g2) > O.runalongP) {
              /* a long coincident stretch, not a touch */
            } else if (Math.min(g1, g2) > O.touchP) choice = same;
            else if (Math.max(g1, g2) < O.crossP) choice = other;
          }
        }
        const k1 = fit4(0, 0), k2 = fit4(1, 1), s1 = fit4(0, 1), s2 = fit4(1, 0);
        if (choice === null && k1 !== null && k2 !== null && s1 !== null && s2 !== null) {
          const kr = k1 + k2, sr = s1 + s2;
          if (Math.min(kr, sr) < O.smoothRatio * Math.max(kr, sr)) choice = kr < sr ? 'keep' : 'swap';
        }
      }
    }
    if (choice === null) continue;
    const pairs: [number, number][] = choice === 'keep' ? [[0, 0], [1, 1]] : [[0, 1], [1, 0]];
    const twin = new Piece(pc.pts.map((p) => [p[0], p[1]] as Pt));
    twin.node = [pc.node[0], pc.node[1]];
    twin.shared = true;
    pc.shared = true;
    P.push(twin);
    const ti = P.length - 1;
    pairs.forEach(([a, c], idx) => {
      const e = idx === 0 ? ei : ti;
      const A = o1[a]!, C = o2[c]!;
      for (const [X, Y] of [[A, [e, 0] as End], [[e, 1] as End, C]] as [End, End][]) {
        link(X, Y, [P[X[0]]!.end(X[1]), P[Y[0]]!.end(Y[1])]);
      }
    });
    handled.add(r1);
    handled.add(r2);
    places.push({ kind: 'bridge', at: centroid(pc.pts), ends: [...o1, ...o2] });
  }

  // --- 3. pair the branch ends at each meeting place
  const placeBest = new Map<number, Set<string>>();
  for (const [reg, br] of endsAt) {
    if (handled.has(reg) || br.length < 2) continue;
    if (br.length > O.maxBranches) {
      places.push({ kind: 'split', at: centroid(br.map(([i, k]) => P[i]!.end(k))), ends: br });
      continue;
    }
    const T = br.map(([i, k]) => P[i]!.tangent(k, skip));
    const E = br.map(([i, k]) => P[i]!.end(k));
    const c = centroid(E);
    const ang = E.map((e) => Math.atan2(e[1] - c[1], e[0] - c[0]));
    const n = br.length;
    const away = br.map(([i, k]) => P[i]!.away(k, skip));
    const cost: number[][] = [];
    for (let i = 0; i < n; i++) {
      cost.push([]);
      for (let j = 0; j < n; j++) {
        let v = 1 + dot(T[i]!, T[j]!);
        if (i !== j) {
          const sc = smoothCost(away[i]!, away[j]!);
          if (sc !== null) v += (O.smoothW * sc) / Math.max(lw, 1);
          if (!contour) {
            const pv = [predictErr(away[i]!, away[j]!), predictErr(away[j]!, away[i]!)].filter((x): x is number => x !== null);
            if (pv.length) v += (O.predictW * (pv.reduce((s, x) => s + x, 0) / pv.length)) / Math.max(lw, 1);
          }
        }
        cost[i]!.push(v);
      }
    }
    const { pairs, best, runner } = bestMatching(n, cost, contour, ang);
    placeBest.set(reg, new Set(pairs.map(([i, j]) => pk(br[i]!, br[j]!))));
    if (runner - best < O.margin) {
      // unsure: every branch stays its own line, and the place is reported
      places.push({ kind: 'split', at: c, ends: br });
      continue;
    }
    for (const [i, j] of pairs) {
      if (cost[i]![j]! > O.maxTurn) continue;
      link(br[i]!, br[j]!, hermite(E[i]!, T[i]!, E[j]!, [-T[j]![0], -T[j]![1]]));
    }
    if (n > 2) places.push({ kind: 'bridge', at: c, ends: br });
  }

  // --- 5/6. gaps: free ends that point at each other
  const isLoopEnd = (pc: Piece): boolean => pc.node[0] === null && pc.node[1] === null && pc.pts.length > 0 &&
    Math.abs(pc.pts[0]![0] - pc.pts[pc.pts.length - 1]![0]) < 1e-8 && Math.abs(pc.pts[0]![1] - pc.pts[pc.pts.length - 1]![1]) < 1e-8;
  let free: End[] = [];
  P.forEach((pc, i) => {
    for (const k of [0, 1] as const) {
      if (partner.has(ek([i, k]))) continue;
      if (pc.node[k] === null && isLoopEnd(pc)) continue;
      free.push([i, k]);
    }
  });
  free = free.filter(([i, k]) => !onFrame(P[i]!.end(k)));
  const gmax = O.gapMax * lw + 18;
  const atEdge = (m: Box, p: Pt): boolean => m.x0 - 4 <= p[0] && p[0] <= m.x1 + 4 && m.y0 - 4 <= p[1] && p[1] <= m.y1 + 4;
  type Cand = { cost: number; a: End; b: End; pe: Pt; te: Pt; pf: Pt; tf: Pt };
  const cand: Cand[] = [];
  for (let ai = 0; ai < free.length; ai++) {
    const [i, k] = free[ai]!;
    const pe = P[i]!.end(k), te = P[i]!.tangent(k, 1);
    for (let bi = ai + 1; bi < free.length; bi++) {
      const [j, l] = free[bi]!;
      if (j === i && P[i]!.length() < O.selfClose * norm(sub(P[j]!.end(l), pe)) + 30) continue;
      const pf = P[j]!.end(l), tf = P[j]!.tangent(l, 1);
      const g = sub(pf, pe);
      const L = norm(g);
      if ((L > O.gapLabel && !masks.length) || L < 1e-6) continue;
      const gh: Pt = [g[0] / L, g[1] / L];
      let acrossMask = false;
      for (const m of masks) {
        const mid: Pt = [(pe[0] + pf[0]) / 2, (pe[1] + pf[1]) / 2];
        if (atEdge(m, pe) && atEdge(m, pf) && m.x0 <= mid[0] && mid[0] <= m.x1 && m.y0 <= mid[1] && mid[1] <= m.y1) acrossMask = true;
      }
      if (L > gmax && !acrossMask) continue;
      if (contour) {
        // the far end must sit ON the near end's line, not beside it
        const lat = Math.max(Math.abs(cross(g, te)), Math.abs(cross(g, tf)));
        const mx = roundHalfEven((pe[0] + pf[0]) / 2), my = roundHalfEven((pe[1] + pf[1]) / 2);
        const crowded = crowd !== null && crowd[Math.min(Math.max(my, 0), h - 1) * w + Math.min(Math.max(mx, 0), w - 1)] === 1;
        const tight = crowded ? [0.6, 0.06] : [0.8, 0.12];
        if (lat > tight[0]! + tight[1]! * L) continue;
      }
      const ca = 1 - dot(te, gh), cb = 1 - dot(tf, [-gh[0], -gh[1]]), cc = 1 + dot(te, tf);
      if (Math.max(ca, cb) > O.gapAngle * 0.5) continue;
      // a SMALL piece joins only along the gap's chord: a dash does, a digit stroke does not
      let bad = false;
      for (const q of [P[i]!, P[j]!]) {
        if (contour && q.length() < O.labelExt) {
          const d = sub(q.pts[q.pts.length - 1]!, q.pts[0]!);
          const nd = norm(d);
          if (nd < 2 || Math.abs(dot([d[0] / nd, d[1] / nd], gh)) < Math.cos((O.dashAlign * Math.PI) / 180)) bad = true;
        }
      }
      if (bad) continue;
      cand.push({ cost: ca + cb + 0.5 * cc + (0.3 * L) / gmax, a: free[ai]!, b: free[bi]!, pe, te, pf, tf });
    }
  }
  cand.sort((x, y) => x.cost - y.cost);

  // NO PASSING (tree rings, ice layers): on a CONTOUR plot a bridge never
  // crosses another line - contours cannot cross. Curves may cross, so for them
  // a dash-gap bridge is not held to it (audit D4).
  const ownerImg = new Int32Array(w * h).fill(-1);
  P.forEach((pc, ii) => {
    if (pc.length() < O.labelExt) return;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const [x, y] of pc.pts) {
      mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y);
    }
    const ext = Math.hypot(mxx - mnx, mxy - mny);
    if (ext < O.labelBox && !partner.has(ek([ii, 0])) && !partner.has(ek([ii, 1])) && !onFrame(pc.pts[0]!) && !onFrame(pc.pts[pc.pts.length - 1]!)) return;
    for (const [x, y] of pc.pts) {
      const qx = roundHalfEven(x), qy = roundHalfEven(y);
      if (qx >= 0 && qy >= 0 && qx < w && qy < h) ownerImg[qy * w + qx] = ii;
    }
  });
  const passes = (br: Pt[], i: number, j: number): boolean => {
    if (!br.length) return false;
    const b0 = br[0]!, b1 = br[br.length - 1]!;
    for (const p of br) {
      if (norm(sub(p, b0)) <= 2.5 || norm(sub(p, b1)) <= 2.5) continue;
      const qx = roundHalfEven(p[0]), qy = roundHalfEven(p[1]);
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const hit = ownerImg[qy * w + qx]!;
      if (hit >= 0 && hit !== i && hit !== j) return true;
    }
    return false;
  };
  const neg = (t: Pt): Pt => [-t[0], -t[1]];

  if (contour) {
    // LABEL-CENTRIC (matplotlib clabel, in reverse): each label owns one gap;
    // its two ends lie either side of it, equally far, both pointing at it
    const small = P.map((pc, ii) => [pc, ii] as const).filter(([pc]) => pc.length() < O.labelExt).map(([, ii]) => ii);
    const groups = groupPieces(small.map((ii) => P[ii]!.pts), O.charGap);
    const fe = free.filter(([i]) => P[i]!.length() >= O.labelExt);
    type Opt = { cost: number; ea: End; eb: End; pa: Pt; ta: Pt; pb: Pt; tb: Pt };
    const optsL: Opt[] = [];
    for (const g of groups) {
      const pts = g.flatMap((q) => P[small[q]!]!.pts);
      const c = centroid(pts);
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const [x, y] of pts) {
        mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y);
      }
      const ext = Math.hypot(mxx - mnx, mxy - mny);
      const near: { e: End; p: Pt; t: Pt; d: number }[] = [];
      for (const e of fe) {
        const p = P[e[0]]!.end(e[1]);
        const v = sub(c, p);
        const dist = norm(v);
        if (dist < 1 || dist > ext / 2 + 4 * lw + 25) continue;
        const t = P[e[0]]!.tangent(e[1], 1);
        if (dot(t, [v[0] / dist, v[1] / dist]) < Math.cos((35 * Math.PI) / 180)) continue;
        near.push({ e, p, t, d: dist });
      }
      for (let a = 0; a < near.length; a++) {
        for (let b = a + 1; b < near.length; b++) {
          const A = near[a]!, B = near[b]!;
          if (A.e[0] === B.e[0] && P[A.e[0]]!.length() < 3 * ext) continue;
          if (dot(sub(A.p, c), sub(B.p, c)) >= 0) continue; // same side of the label
          const ch = sub(B.p, A.p);
          const L = norm(ch);
          if (L < ext * 0.8) continue;
          const chh: Pt = [ch[0] / L, ch[1] / L];
          let cost = Math.abs(A.d - B.d) / (A.d + B.d) + (1 - dot(A.t, chh)) + (1 - dot(B.t, neg(chh)));
          cost += Math.abs(dot(sub(c, A.p), [-chh[1], chh[0]])) / Math.max(L, 1);
          optsL.push({ cost, ea: A.e, eb: B.e, pa: A.p, ta: A.t, pb: B.p, tb: B.t });
        }
      }
    }
    optsL.sort((x, y) => x.cost - y.cost);
    for (const o of optsL) {
      if (o.cost > O.labelCost || partner.has(ek(o.ea)) || partner.has(ek(o.eb))) continue;
      const br = hermite(o.pa, o.ta, o.pb, neg(o.tb));
      if (passes(br, o.ea[0], o.eb[0])) continue;
      link(o.ea, o.eb, br, [o.pa, o.pb]);
    }
  }
  for (const c of cand) {
    if (partner.has(ek(c.a)) || partner.has(ek(c.b))) continue;
    const straight = Math.min(P[c.a[0]]!.length(), P[c.b[0]]!.length()) < O.straightBelow;
    const br = hermite(c.pe, c.te, c.pf, neg(c.tf), straight);
    if (contour && passes(br, c.a[0], c.b[0])) continue;
    link(c.a, c.b, br, [c.pe, c.pf]);
  }

  // --- ORDER-PRESERVING BAND BRIDGE: deliberately NOT in the first version.
  // Where lines merge beyond the pixels, the first version SPLITS and reports
  // the stretch (David, 2026-10-10: N1 splits; bridging in order comes later).

  // --- assemble lines by walking partners
  const used = new Set<number>();
  const lines: FoundLine[] = [];
  const labelInk: Pt[][] = [];
  for (let start = 0; start < P.length; start++) {
    if (used.has(start)) continue;
    let cur: End = [start, 0];
    const seenW = new Set([start]);
    while (partner.has(ek(cur))) {
      const [j, l] = partner.get(ek(cur))!;
      if (seenW.has(j)) break;
      seenW.add(j);
      cur = [j, (1 - l) as 0 | 1];
    }
    const first = cur;
    const pts: Pt[] = [];
    const roles: PointRole[] = [];
    const lineGaps: [Pt, Pt][] = [];
    const ids: number[] = [];
    let closed = false;
    let pi: number;
    for (;;) {
      const [i, k] = cur;
      pi = i;
      used.add(i);
      ids.push(i);
      const seg = k === 0 ? P[i]!.pts : [...P[i]!.pts].reverse();
      for (const p of seg) {
        pts.push(p);
        roles.push(P[i]!.shared ? 'shared' : 'measured');
      }
      const out: End = [i, (1 - k) as 0 | 1];
      if (!partner.has(ek(out))) break;
      const nxt = partner.get(ek(out))!;
      const g = gaps.get(pk(out, nxt));
      if (g) lineGaps.push(g);
      let br = bridges.get(pk(out, nxt));
      if (br && br.length) {
        const here = P[out[0]]!.end(out[1]);
        if (norm(sub(br[0]!, here)) > norm(sub(br[br.length - 1]!, here))) br = [...br].reverse();
        // a two-point shared link is just the two ends; nothing to add between them
        const interior = br.length === 2 && norm(sub(br[0]!, here)) < 1e-9 ? [] : br;
        for (const p of interior) {
          pts.push(p);
          roles.push('bridged');
        }
      }
      if (used.has(nxt[0])) {
        closed = nxt[0] === first[0] && nxt[1] === first[1];
        break;
      }
      cur = nxt;
    }
    if (!closed && first[0] === pi && P[pi]!.loop) closed = true;
    const L = pathLength(pts);
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const [x, y] of pts) {
      mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y);
    }
    const ext = Math.hypot(mxx - mnx, mxy - mny);
    const isolated = ids.length === 1 && !(onFrame(pts[0]!) || onFrame(pts[pts.length - 1]!));
    if (L < Math.max(O.minLen, 4 * lw) || (isolated && ext < O.labelExt)) {
      labelInk.push(pts); // too small and alone to be a line: shown as label ink, never dropped
      continue;
    }
    if (closed && pts.length > 1) {
      const a = pts[0]!, b = pts[pts.length - 1]!;
      if (a[0] !== b[0] || a[1] !== b[1]) {
        pts.push([a[0], a[1]]);
        roles.push(roles[0]!);
      }
    }
    lines.push({ points: pts, roles, closed, gaps: lineGaps });
  }

  // N1: short fragments wholly inside a crowded band are UNRESOLVED ink
  let kept = lines;
  const unresolved: Pt[][] = [];
  if (contour && crowd) {
    kept = [];
    for (const L of lines) {
      let inside = 0, cnt = 0;
      for (const [x, y] of L.points) {
        const qx = roundHalfEven(x), qy = roundHalfEven(y);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        cnt++;
        if (crowd[qy * w + qx]) inside++;
      }
      const frac = cnt ? inside / cnt : 0;
      if (pathLength(L.points) < O.unresLen && frac > 0.8 && !L.closed) unresolved.push(L.points);
      else kept.push(L);
    }
  }
  let out = kept;
  if (contour) {
    out = unspiral(out, O.gapLabel);
    out = uncross(out);
    closeLoops(out, labelInk, onFrame);
  }

  // places, mapped onto the final lines by position (lines may have been cut)
  const nearestLines = (p: Pt, r: number): number[] => {
    const hit: number[] = [];
    out.forEach((L, li) => {
      for (const q of L.points) if (norm(sub(q, p)) <= r) {
        hit.push(li);
        return;
      }
    });
    return hit;
  };
  const placesOut: Place[] = places.map((pl) => ({ kind: pl.kind, at: pl.at, lines: nearestLines(pl.at, 3 * lw + 6) }));
  for (const u of unresolved) placesOut.push({ kind: 'unresolved', at: centroid(u), lines: nearestLines(centroid(u), 3 * lw + 6) });
  // A line that STOPS inside the plot is a place to check: a contour cannot end
  // there, and a curve rarely does - most often it is a dash gap or a crossing
  // the first version did not bridge. Ends near each other are one place.
  const ends: { at: Pt; line: number }[] = [];
  out.forEach((L, li) => {
    if (L.closed || L.points.length < 2) return;
    for (const p of [L.points[0]!, L.points[L.points.length - 1]!]) if (!onFrame(p)) ends.push({ at: p, line: li });
  });
  const grouped = new Set<number>();
  ends.forEach((e, i) => {
    if (grouped.has(i)) return;
    const group = [i];
    grouped.add(i);
    ends.forEach((f, j) => {
      if (!grouped.has(j) && norm(sub(e.at, f.at)) < 25) {
        group.push(j);
        grouped.add(j);
      }
    });
    if (placesOut.some((pl) => norm(sub(pl.at, e.at)) < 25)) return;
    const lines = [...new Set(group.map((g) => ends[g]!.line))];
    placesOut.push({ kind: lines.length > 1 ? 'split' : 'end', at: centroid(group.map((g) => ends[g]!.at)), lines });
  });
  return { lines: out, labelInk, unresolved, places: placesOut, lineWidth: lw };
}

/** Pieces whose points come within `gap` px of each other, grouped. */
export function groupPieces(pts: readonly Pt[][], gap: number): number[][] {
  const n = pts.length;
  const parent = [...Array(n).keys()];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const bx = pts.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of p) {
      a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
    }
    return [a, b, c, d] as const;
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bx[i]!, b = bx[j]!;
      if (a[0] - gap > b[2] || b[0] - gap > a[2] || a[1] - gap > b[3] || b[1] - gap > a[3]) continue;
      let close = false;
      for (const p of pts[j]!) {
        for (const q of pts[i]!) if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 <= gap * gap) {
          close = true;
          break;
        }
        if (close) break;
      }
      if (close) parent[find(i)] = find(j);
    }
  }
  const g = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!g.has(r)) g.set(r, []);
    g.get(r)!.push(i);
  }
  return [...g.values()];
}

/** Bridged runs of a line as [last measured index before, first index after]. */
function bridgeSpans(L: FoundLine): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < L.roles.length) {
    if (L.roles[i] !== 'bridged') {
      i++;
      continue;
    }
    const s = i;
    while (i < L.roles.length && L.roles[i] === 'bridged') i++;
    spans.push([Math.max(0, s - 1), Math.min(L.roles.length - 1, i)]);
  }
  return spans;
}

function sliceLine(L: FoundLine, a: number, b: number): FoundLine {
  const at = (t: Pt): number => L.points.findIndex((x) => x[0] === t[0] && x[1] === t[1]);
  return {
    points: L.points.slice(a, b + 1),
    roles: L.roles.slice(a, b + 1),
    closed: false,
    gaps: L.gaps.filter(([p, q]) => {
      const ip = at(p), iq = at(q);
      return ip >= a && ip <= b && iq >= a && iq <= b;
    }),
  };
}

/** A closed line opened at the bridge [b0, b1]: from b1 round to b0. */
function openRingAt(L: FoundLine, b0: number, b1: number): FoundLine {
  const n = L.points.length - 1; // the last point repeats the first
  const order: number[] = [];
  for (let i = b1; i < n; i++) order.push(i);
  for (let i = 0; i <= b0; i++) order.push(i);
  const pts = order.map((i) => L.points[i]!);
  const keys = new Set(pts.map((p) => `${p[0]},${p[1]}`));
  return {
    points: pts,
    roles: order.map((i) => L.roles[i]!),
    closed: false,
    gaps: L.gaps.filter(([p, q]) => keys.has(`${p[0]},${p[1]}`) && keys.has(`${q[0]},${q[1]}`)),
  };
}

/** Close a line across the gap between its ends with the fair interpolation:
 * bridged points, the gap recorded (so a label sitting in it gets its slot -
 * audit C8), ending on its first point (S4). */
function closeAcrossGap(L: FoundLine): void {
  const p = L.points;
  const a = p[p.length - 1]!, b = p[0]!;
  const gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (gap > 1.5) {
    const t0 = unit(sub(a, p[Math.max(0, p.length - 8)]!));
    const t1 = p.length > 1 ? unit(sub(p[Math.min(p.length - 1, 1)]!, b)) : t0;
    for (const q of hermite(a, t0, b, t1)) {
      L.points.push(q);
      L.roles.push('bridged');
    }
    L.gaps.push([a, b]);
  }
  L.points.push([b[0], b[1]]);
  L.roles.push(L.roles[0]!);
  L.closed = true;
}

/** Contours never cross: where two output lines do, cut the BRIDGE nearest the
 * crossing. Crossings with no bridge near are measured ink and left alone. */
export function uncross(lines: FoundLine[], iters = 30): FoundLine[] {
  let cur = lines;
  for (let it = 0; it < iters; it++) {
    const cr = crossings(cur);
    if (!cr.length) break;
    let best: [number, number, number, number] | null = null;
    for (const [i, si, j, sj] of cr) {
      for (const [li, sk] of [[i, si], [j, sj]] as [number, number][]) {
        for (const [b0, b1] of bridgeSpans(cur[li]!)) {
          const d = b0 <= sk && sk <= b1 ? 0 : Math.min(Math.abs(sk - b0), Math.abs(sk - b1));
          if (d <= 6 && (best === null || d < best[0])) best = [d, li, b0, b1];
        }
      }
    }
    if (!best) break;
    const [, li, b0, b1] = best;
    const L = cur[li]!;
    // ⚑ A CLOSED line cut at one bridge is ONE open line (audit B4): it runs
    // from the far side of the bridge round through its old start to the near
    // side - cutting it at both ends of the bridge made two lines of one contour.
    const parts = L.closed
      ? [openRingAt(L, b0, b1)].filter((x) => x.points.length >= 2)
      : [sliceLine(L, 0, b0), sliceLine(L, b1, L.points.length - 1)].filter((x) => x.points.length >= 2);
    cur = [...cur.slice(0, li), ...parts, ...cur.slice(li + 1)];
  }
  return cur;
}

function crossings(lines: readonly FoundLine[], cell = 6): [number, number, number, number][] {
  const segs: [number, number, Pt, Pt][] = [];
  const buckets = new Map<string, number[]>();
  lines.forEach((L, li) => {
    for (let k = 0; k < L.points.length - 1; k++) {
      const a = L.points[k]!, b = L.points[k + 1]!;
      segs.push([li, k, a, b]);
      const x0 = Math.floor(Math.min(a[0], b[0]) / cell), y0 = Math.floor(Math.min(a[1], b[1]) / cell);
      const x1 = Math.floor(Math.max(a[0], b[0]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(segs.length - 1);
      }
    }
  });
  const orient = (a: Pt, b: Pt, c: Pt): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const out: [number, number, number, number][] = [];
  const seen = new Set<string>();
  for (const ids of buckets.values()) {
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const s1 = segs[ids[x]!]!, s2 = segs[ids[y]!]!;
        if (s1[0] === s2[0]) continue;
        const key = ids[x]! < ids[y]! ? `${ids[x]},${ids[y]}` : `${ids[y]},${ids[x]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [a, b, c, d] = [s1[2], s1[3], s2[2], s2[3]];
        if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) out.push([s1[0], s1[1], s2[0], s2[1]]);
      }
    }
  }
  return out;
}

/** A contour cannot spiral: net turning past a full turn without closing is a
 * wrong join. Cut at the bridge that leaves a piece closing on itself. */
export function unspiral(lines: FoundLine[], closeGap: number): FoundLine[] {
  const out: FoundLine[] = [];
  const todo = [...lines];
  let guard = 0;
  const closesOnItself = (q: Pt[]): boolean => q.length >= 10 && norm(sub(q[q.length - 1]!, q[0]!)) < closeGap && Math.abs(Math.abs(netTurn(q)) - 2 * Math.PI) < 0.6;
  while (todo.length && guard++ < 500) {
    const L = todo.pop()!;
    const spans = bridgeSpans(L);
    if (L.closed || Math.abs(netTurn(L.points)) < 2 * Math.PI * 1.15 || !spans.length) {
      out.push(L);
      continue;
    }
    let best: [number, number, number] | null = null;
    for (const [b0, b1] of spans) {
      for (const part of [L.points.slice(0, b0 + 1), L.points.slice(b1)]) {
        if (part.length < 10) continue;
        const gap = norm(sub(part[part.length - 1]!, part[0]!));
        if (gap < closeGap && Math.abs(Math.abs(netTurn(part)) - 2 * Math.PI) < 0.6 && (best === null || gap < best[0])) best = [gap, b0, b1];
      }
    }
    if (!best) {
      out.push(L);
      continue;
    }
    const [, b0, b1] = best;
    for (const X of [sliceLine(L, 0, b0), sliceLine(L, b1, L.points.length - 1)]) {
      // ⚑ closed by a BRIDGE, never a straight step recorded as measured (audit B5)
      if (closesOnItself(X.points)) closeAcrossGap(X);
      if (X.points.length >= 2) todo.push(X);
    }
  }
  return [...out, ...todo];
}

/** CLOSURE MEASURED FROM THE INK (F8): a line whose ends meet, or face each other
 * across a gap holding label ink, with a full turn of turning, is a loop. */
function closeLoops(lines: FoundLine[], labelInk: Pt[][], onFrame: (p: Pt) => boolean): void {
  const inkC = labelInk.filter((l) => l.length).map(centroid);
  for (const L of lines) {
    if (L.closed) continue;
    const p = L.points;
    if (p.length < 10 || onFrame(p[0]!) || onFrame(p[p.length - 1]!)) continue;
    const g = sub(p[p.length - 1]!, p[0]!);
    const gap = norm(g);
    if (Math.abs(Math.abs(netTurn(p)) - 2 * Math.PI) > 0.6) continue;
    let ok = gap <= 1.5;
    if (!ok && gap <= O.gapLabel && inkC.length) {
      const gh: Pt = [g[0] / gap, g[1] / gap];
      const t0 = unit(sub(p[p.length - 1]!, p[Math.max(0, p.length - 8)]!));
      const t1 = unit(sub(p[0]!, p[Math.min(p.length - 1, 7)]!));
      if (dot(t0, [-gh[0], -gh[1]]) > Math.cos((35 * Math.PI) / 180) && dot(t1, gh) > Math.cos((35 * Math.PI) / 180)) {
        ok = inkC.some((c) => {
          const rel = sub(c, p[p.length - 1]!);
          const al = dot(rel, [-gh[0], -gh[1]]);
          const ac = dot(rel, [gh[1], -gh[0]]);
          return al > 1 && al < gap - 1 && Math.abs(ac) < Math.max(8, 0.3 * gap);
        });
      }
    }
    if (!ok) continue;
    closeAcrossGap(L);
  }
}


/**
 * How far the picked ink's OWN pixels stray from a pure paper-to-ink mix - the
 * figure's noise for that colour (JPEG, scanning), measured on pixels that are
 * plainly the ink (nearly its colour, coverage near 1). The tolerance is a
 * margin over that, never below 5: on a clean render the ink's own pixels sit
 * at 0, and the next level's colour at ~22.
 */
function ownInkResidual(rgba: Uint8ClampedArray | Uint8Array, w: number, _h: number, colour: RGB, cov: { alpha: Float64Array; residual: Float64Array }, box: Box): number {
  const vals: number[] = [];
  // clamped to the image: a box past an edge wrapped rows or read past the end (audit D6)
  const h = rgba.length / 4 / w;
  for (let y = Math.max(0, Math.ceil(box.y0)); y <= Math.min(h - 1, Math.floor(box.y1)); y++) {
    for (let x = Math.max(0, Math.ceil(box.x0)); x <= Math.min(w - 1, Math.floor(box.x1)); x++) {
      const i = y * w + x;
      const o = i * 4;
      const d = Math.hypot(rgba[o]! - colour[0], rgba[o + 1]! - colour[1], rgba[o + 2]! - colour[2]);
      // within 12 of the picked colour: the next level's ink is ~22 away and must not count as this one
      if (d < 12 && cov.alpha[i]! > 0.85 && cov.alpha[i]! < 1.15) vals.push(cov.residual[i]!);
    }
  }
  if (vals.length < 20) return 15;
  vals.sort((a, b) => a - b);
  const p95 = vals[Math.floor(vals.length * 0.95)]!;
  return Math.max(5, Math.min(70, 2 * p95 + 3));
}
