/**
 * Originally ported from the pure functions of
 * ui-patches/engauge-algos.js's Segment Fill section (built 2026-07,
 * clean-room reimplementation of the flood-fill curve-tracing concept -
 * see that file's header for the original provenance note). Ported here
 * per CLAUDE.md's Step 1 scope: these were already proven framework-
 * independent this session; this is a straight TS port, not a rewrite.
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface FloodFillResult {
  /**
   * The segment itself: 1 for each pixel that PASSED the colour test.
   *
   * **This used to be the BFS's `visited` array, and that was a live bug**
   * (found by audit + execution, 2026-07-16). One array was doing two jobs -
   * bookkeeping ("don't examine this pixel twice") and output ("this pixel is
   * part of the curve") - and those are different sets: BFS must mark a pixel
   * examined *whether or not* it matches, or it re-examines it forever. So
   * every rejected pixel was landing in the exported mask, which is the fill
   * **dilated by one pixel** in every direction. A 1px-wide line exported three
   * columns of points, two of them where the curve does not exist.
   *
   * The name was honest and the usage was not. They are now two arrays.
   */
  mask: Uint8Array;
  /** How many pixels are in `mask`. */
  filled: number;
}

const MAX_FILL_PX = 80000;

/**
 * BFS flood fill from (seedX, seedY) collecting pixels whose RGB color is
 * within `threshold` (0-255 Euclidean distance) of the seed pixel.
 * `data` is a flat RGBA Uint8ClampedArray/Uint8Array (4 bytes per pixel),
 * same shape as ImageData.data. Caps at MAX_FILL_PX to prevent runaway
 * fills on large uniform regions.
 */
export function floodFill(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  threshold: number
): FloodFillResult {
  const idx = (seedY * width + seedX) * 4;
  const sr = data[idx]!;
  const sg = data[idx + 1]!;
  const sb = data[idx + 2]!;

  // Two arrays, deliberately: `seen` is BFS bookkeeping (examined already),
  // `mask` is the answer (passed the colour test). Conflating them dilated
  // every trace by 1px -- see FloodFillResult.mask.
  const seen = new Uint8Array(width * height);
  const mask = new Uint8Array(width * height);
  const queue: number[] = [seedX | (seedY << 16)]; // pack x,y into one int (images < 65535px)
  seen[seedY * width + seedX] = 1;
  mask[seedY * width + seedX] = 1; // the seed defines the colour, so it always matches
  let head = 0;
  let filled = 0;

  while (head < queue.length && filled < MAX_FILL_PX) {
    const packed = queue[head++]!;
    const cx = packed & 0xffff;
    const cy = (packed >> 16) & 0xffff;
    filled++;

    const neighbours: [number, number][] = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];
    for (let i = 0; i < neighbours.length; i++) {
      const [nx, ny] = neighbours[i]!;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const vi = ny * width + nx;
      if (seen[vi]) continue;
      seen[vi] = 1; // examined -- regardless of the verdict below
      const ni = vi * 4;
      const dr = data[ni]! - sr;
      const dg = data[ni + 1]! - sg;
      const db = data[ni + 2]! - sb;
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= threshold) {
        mask[vi] = 1; // and only THIS is part of the curve
        queue.push(nx | (ny << 16));
      }
    }
  }

  return { mask, filled };
}

/**
 * A run continues across a hole this many pixels tall.
 *
 * 0 would mean strictly contiguous, which is right in principle -- a
 * flood-filled segment IS connected -- but an anti-aliased curve traced with a
 * tight threshold can drop the odd interior pixel, and splitting a 3px curve
 * into two "branches" over a single hole would invent a second curve. 1 spans
 * that without being able to bridge two real branches, which are separated by
 * the plot's own whitespace.
 */
const DEFAULT_RUN_GAP = 1;

/**
 * Convert a segment mask to {x, y} image coordinates: **one point per run per
 * column**, at the run's centre.
 *
 * **This replaces `orderByColumnMedian`, which silently deleted half a curve**
 * (found by audit, 2026-07-16; mechanism nailed down by execution after a first
 * explanation proved wrong -- see below, it is worth not re-learning).
 *
 * That function took one point per column at the median y. On a curve that
 * doubles back -- hysteresis, an unloading branch, stress-strain past the peak
 * -- a column holds pixels from BOTH branches, and one point cannot describe
 * two. Executed on a C-shape with a correct mask: `upperKept=0`, `lowerKept=6`.
 * **The entire upper branch vanished, and the output looked immaculate** -- a
 * clean 7-point curve, every point genuinely on the figure, nothing to see. A
 * plausible answer to a question nobody asked. That is the "poisoning a
 * downstream dataset" failure in its quietest form, in the feature whose whole job is
 * to spare you tracing by hand.
 *
 * **What it did NOT do, despite this comment once saying so: fabricate.**
 * `ys[mid]` is a member of the column's own pixel list, so a median can never
 * return a y outside the mask. The points-in-empty-space that the audit
 * observed were real, but they came from the *dilation* bug (see
 * FloodFillResult.mask) corrupting the very list the median then sampled --
 * near a vertical feature the dilation smeared it across neighbouring columns.
 * **Two entangled bugs, and the first diagnosis credited the wrong one.** Both
 * are fixed; the distinction is kept because "loses data" and "invents data"
 * need different defences.
 *
 * Its own header named the assumption ("works perfectly for monotonic curves -
 * the primary at-scale use case") rather than deciding it. The shape of the
 * mistake is this repo's recurring one: a **capture convenience** ("scan the
 * columns, take the middle") promoted to a **data model**.
 *
 * ⚑⚑ A COLUMN CAN HOLD MORE THAN ONE RUN, and collapsing them to one point is
 * what loses a doubling-back curve. Each contiguous run of filled pixels in a
 * column is its own reading, and runs merge only by proximity in BOTH x and y,
 * so two branches of a curve passing through the same column never collapse into
 * each other.
 *
 * ⚑ A flood-filled segment is connected by construction, so contiguity IS the
 * run boundary and no averaging-window height is needed to find one.
 *
 * ⚑ Engauge's `src/Segment/SegmentFactory.cpp` keeps multiple runs per column
 * too. Read for the CONCEPT ONLY and never ported: it is GPL-2.0, and this
 * project keeps reading and implementing strictly separated.
 *
 * Output is in column order, which is NOT curve order for a doubling-back
 * curve -- see orderByNearestNeighbour, which is the other half of the fix.
 */
export function pointsFromColumnRuns(
  mask: Uint8Array,
  width: number,
  height: number,
  gap: number = DEFAULT_RUN_GAP
): Point2D[] {
  const points: Point2D[] = [];
  for (let x = 0; x < width; x++) {
    let runStart = -1;
    let runEnd = -1;
    for (let y = 0; y < height; y++) {
      if (mask[y * width + x]) {
        if (runStart === -1) {
          runStart = y;
        } else if (y - runEnd > gap + 1) {
          // Far enough from the last pixel to be a different branch.
          points.push({ x, y: Math.round((runStart + runEnd) / 2) });
          runStart = y;
        }
        runEnd = y;
      }
    }
    if (runStart !== -1) points.push({ x, y: Math.round((runStart + runEnd) / 2) });
  }
  return points;
}

/**
 * Re-order points into curve order by a greedy nearest-neighbour walk.
 *
 * **The other half of the doubling-back fix, and it closes parity gap #14.**
 * Per-column runs recover both branches, but they arrive in column order, so a
 * C-shape zigzags upper-lower-upper-lower and is still wrong as a curve.
 * Sorting by x cannot fix that -- for a curve that doubles back, x is not a key.
 * Only walking the curve is.
 *
 * Originally ported from WPD's own connectivity sort
 * (`javascript/widgets/dataTable.js:238-269`, the `isConnectivity` branch),
 * which `core/dataProviders.ts:240` already advertises as `allowConnectivity`
 * with **no implementation behind it** -- the contract was ported at checkpoint
 * 74 and this is the function it was promising. Same greedy rule: from each
 * point, the nearest unused point becomes the next; O(n²), which is fine at our
 * scale (MAX_FILL_PX caps the mask, and a trace is subsampled to 500 before
 * export).
 *
 * ⚑ Distances are measured in PIXEL space, where x and y are the same unit.
 * Comparing in data space would weigh the two axes by whatever the calibration
 * happens to make them worth, so a tall thin chart and a short wide one would
 * trace differently from identical ink. Pixels are isotropic; the axes are not.
 *
 * Starts from `points[0]`, the leftmost column's first run - a defined starting
 * point, rather than whatever order the caller happened to hand over.
 */
export function orderByNearestNeighbour(points: readonly Point2D[]): Point2D[] {
  return nearestNeighbourOrder(points).map((i) => ({ x: points[i]!.x, y: points[i]!.y }));
}

/**
 * The permutation of INDICES that {@link orderByNearestNeighbour} applies -- the
 * same greedy walk, returning `order` such that `order[k]` is the original index
 * of the k-th point in curve order. Split out (checkpoint 130's fix) so a caller
 * that must carry per-point payload through the reorder -- e.g. a Dataset's
 * per-pixel metadata (`label`, `overrides`), which the point-only version would
 * strip -- can permute the payload by the same order instead of rebuilding bare
 * coordinates. Behaviour is identical to the point version by construction: the
 * anchor at position `i` and the swap of positions `i+1`/`nearest` match exactly.
 */
export function nearestNeighbourOrder(points: readonly Point2D[]): number[] {
  const px = points.map((p) => p.x);
  const py = points.map((p) => p.y);
  const order = points.map((_, i) => i);
  for (let i = 0; i < order.length - 1; i++) {
    let nearest = -1;
    let nearestDist = Infinity;
    const ax = px[order[i]!]!;
    const ay = py[order[i]!]!;
    for (let j = i + 1; j < order.length; j++) {
      const dx = ax - px[order[j]!]!;
      const dy = ay - py[order[j]!]!;
      const dist = dx * dx + dy * dy; // squared: monotonic, so no sqrt needed
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = j;
      }
    }
    if (nearest === -1) break;
    const swap = order[i + 1]!;
    order[i + 1] = order[nearest]!;
    order[nearest] = swap;
  }
  return order;
}

/**
 * The index in `existing` at which to splice a newly placed point `q` so it
 * disturbs the ordered polyline as little as possible -- v1.1 #1's insert-in-
 * place ordering. Returns a value in [0, existing.length].
 *
 * "Cheapest insertion" over the OPEN path: an internal edge (a, b) costs
 * dist(a,q) + dist(q,b) - dist(a,b) -- the extra path length q adds between two
 * neighbours -- while prepending before the first point costs dist(q, p0) and
 * appending after the last costs dist(pn-1, q). The smallest wins. Ties resolve
 * toward APPEND (append is the initial best and only a STRICTLY smaller cost
 * displaces it), so a normal left-to-right trace -- each new point nearest the
 * last -- keeps landing at the end exactly as a plain append would. The new
 * behaviour only bites when a point is dropped back into the middle of a curve
 * it belongs in, moving just that one point (every other index is preserved by
 * splicing at the chosen edge).
 *
 * Only the ORDER is decided here; the point's coordinates are never touched
 * (tenet 9). Empty -> 0, a single existing point -> 1 (append). True distances
 * (not squared) are required: the a->q->b minus a->b comparison is a triangle-
 * inequality quantity that squared distances don't preserve.
 */
export function bestInsertionIndex(existing: readonly Point2D[], q: Point2D): number {
  const n = existing.length;
  if (n === 0) return 0;
  const d = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);
  // Append is the default and the tie-winner (strict `<` below never unseats it
  // on an equal cost).
  let bestIndex = n;
  let bestCost = d(existing[n - 1]!, q);
  const prepend = d(q, existing[0]!);
  if (prepend < bestCost) {
    bestCost = prepend;
    bestIndex = 0;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = existing[i]!;
    const b = existing[i + 1]!;
    const cost = d(a, q) + d(q, b) - d(a, b);
    if (cost < bestCost) {
      bestCost = cost;
      bestIndex = i + 1;
    }
  }
  return bestIndex;
}

/**
 * Subsample an ordered point array to at most `maxPoints`, evenly spaced
 * rather than clustered, **keeping both endpoints**.
 *
 * The old step was `length / maxPoints` over `i < maxPoints`, so the last index
 * taken was `round((maxPoints-1) * length/maxPoints)` -- for 100 points capped
 * at 10, index 90, and points 91-99 were silently discarded. **The end of a
 * traced curve is rarely the boring end**: on a stress-strain curve it is the
 * failure point, which is usually the reason the figure was digitized at all.
 * Spanning `length - 1` over `maxPoints - 1` intervals lands exactly on both
 * ends.
 */
export function subsample(points: Point2D[], maxPoints: number): Point2D[] {
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 1) return points.length > 0 ? [points[0]!] : [];
  const step = (points.length - 1) / (maxPoints - 1);
  const result: Point2D[] = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(points[Math.round(i * step)]!);
  }
  return result;
}
