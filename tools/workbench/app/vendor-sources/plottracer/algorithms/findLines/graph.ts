/**
 * The centreline as a GRAPH: nodes are free ends and junction clusters, edges
 * the pixel chains between them. A pixel's degree is its topological degree
 * (1 end, 2 chain, 3+ junction) because redundant diagonal links are dropped -
 * a diagonal step that an orthogonal pair already covers is not a second path.
 */

/** A pixel, or a sub-pixel point, as [y, x] (row first, as the image is stored). */
export type YX = readonly [number, number];

export interface GraphNode {
  pix: YX[];
  kind: 'junc' | 'end' | 'dot';
  /** Centre, as x, y. */
  c: [number, number];
}

export interface GraphEdge {
  a: number | null;
  b: number | null;
  pix: YX[];
  loop?: boolean;
}

const N8: readonly [number, number][] = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** Neighbours of every set pixel in `skel`, with redundant diagonals dropped. */
function pixelAdjacency(skel: Uint8Array, w: number, h: number): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  const on = (y: number, x: number): boolean => y >= 0 && x >= 0 && y < h && x < w && skel[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!skel[y * w + x]) continue;
      adj.set(y * w + x, []);
    }
  }
  for (const [i] of adj) {
    const x = i % w, y = (i - x) / w;
    for (const [dy, dx] of N8) {
      const yy = y + dy, xx = x + dx;
      if (!on(yy, xx)) continue;
      if (dy && dx && (on(y + dy, x) || on(y, x + dx))) continue;
      adj.get(i)!.push(yy * w + xx);
    }
  }
  return adj;
}

export function skeletonGraph(skel: Uint8Array, w: number, h: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const adj = pixelAdjacency(skel, w, h);
  const yx = (i: number): YX => [Math.floor(i / w), i % w];
  const deg = (i: number): number => adj.get(i)!.length;
  const owner = new Map<number, number>();
  const nodes: GraphNode[] = [];
  // junction pixels that touch form one node
  for (const [i] of adj) {
    if (deg(i) < 3 || owner.has(i)) continue;
    const comp: number[] = [];
    const stack = [i];
    owner.set(i, nodes.length);
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      for (const q of adj.get(p)!) {
        if (deg(q) >= 3 && !owner.has(q)) {
          owner.set(q, nodes.length);
          stack.push(q);
        }
      }
    }
    nodes.push({ pix: comp.map(yx), kind: 'junc', c: [0, 0] });
  }
  for (const [i] of adj) {
    if (deg(i) <= 1) {
      owner.set(i, nodes.length);
      nodes.push({ pix: [yx(i)], kind: deg(i) === 1 ? 'end' : 'dot', c: [0, 0] });
    }
  }
  for (const n of nodes) {
    let sx = 0, sy = 0;
    for (const [y, x] of n.pix) {
      sx += x;
      sy += y;
    }
    n.c = [sx / n.pix.length, sy / n.pix.length];
  }
  const edges: GraphEdge[] = [];
  const used = new Set<string>();
  const key = (p: number, q: number): string => (p < q ? `${p},${q}` : `${q},${p}`);
  nodes.forEach((n, nid) => {
    for (const [py, px] of n.pix) {
      const p = py * w + px;
      for (const q of adj.get(p)!) {
        if (owner.get(q) === nid) continue;
        const k = key(p, q);
        if (used.has(k)) continue;
        used.add(k);
        const path = [p, q];
        let prev = p, cur = q;
        while (!owner.has(cur)) {
          const nxt = adj.get(cur)!.filter((r) => r !== prev);
          if (!nxt.length) break;
          const r = nxt[0]!;
          used.add(key(cur, r));
          path.push(r);
          prev = cur;
          cur = r;
        }
        edges.push({ a: nid, b: owner.has(cur) ? owner.get(cur)! : null, pix: path.map(yx) });
      }
    }
  });
  // loops with no node at all
  const seen = new Set<number>();
  for (const e of edges) for (const [y, x] of e.pix) seen.add(y * w + x);
  for (const i of owner.keys()) seen.add(i);
  const visited = new Set<number>();
  for (const [s] of adj) {
    if (visited.has(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    visited.add(s);
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      for (const q of adj.get(p)!) if (!visited.has(q)) {
        visited.add(q);
        stack.push(q);
      }
    }
    if (comp.some((p) => seen.has(p))) continue;
    const start = comp[0]!;
    const path = [start];
    let prev = -1, cur = start;
    for (;;) {
      const tail = path.slice(-2);
      const nxt = adj.get(cur)!.filter((r) => r !== prev && !tail.includes(r));
      if (!nxt.length || (nxt[0] === start && path.length > 2)) break;
      prev = cur;
      cur = nxt[0]!;
      if (cur === start) break;
      path.push(cur);
    }
    edges.push({ a: null, b: null, pix: [...path, start].map(yx), loop: true });
  }
  return { nodes, edges };
}
