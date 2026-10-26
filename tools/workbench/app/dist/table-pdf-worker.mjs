// src/table-pdf-worker.mjs
import * as mupdf from "./browser-pdf-vendor/mupdf.js";

// src/table-vendor/detection.mjs
var RULE_COVERAGE = 0.5;
var RULE_EDGE_MARGIN_PT = 12;
var ROW_GAP_TOLERANCE = 2;
var DEFAULT_TABLE_OPTIONS = {
  rowTolFactor: 0.6,
  colTolFactor: 0.9,
  maxRowGapFactor: 2.5,
  minRows: 2,
  minCols: 2
};
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function toCandidates(run) {
  if (run.locked) return [];
  if (!run.text || run.text.trim().length === 0) return [];
  const { x, y, width, height } = run.bounds;
  if (width <= 0 || height <= 0) return [];
  const lines = run.paragraphLineCount ?? 1;
  if (lines <= 1) {
    return [
      {
        run,
        left: x,
        right: x + width,
        cx: x + width / 2,
        cy: y + height / 2,
        height
      }
    ];
  }
  return expandParagraph(run, lines);
}
function expandParagraph(run, lines) {
  const baselines = run.paragraphBaselines;
  const lefts = run.paragraphLineLefts;
  const texts = run.text.split("\n");
  if (!baselines || baselines.length !== lines || texts.length < lines)
    return [];
  const { x, y, width, height } = run.bounds;
  const descent = baselines[lines - 1] - y;
  const ascent = y + height - baselines[0];
  const lineHeight = ascent + descent;
  if (lineHeight <= 0) return [];
  const lengths = texts.slice(0, lines).map((s) => s.trim().length);
  const maxLen = Math.max(...lengths, 1);
  const out = [];
  for (let i = 0; i < lines; i++) {
    if (lengths[i] === 0) continue;
    const left = lefts?.[i] ?? x;
    const w = Math.max(1, width * lengths[i] / maxLen);
    const bottom = baselines[i] - descent;
    out.push({
      run,
      left,
      right: left + w,
      cx: left + w / 2,
      cy: bottom + lineHeight / 2,
      height: lineHeight
    });
  }
  return out;
}
function groupRows(cands, rowTol) {
  const sorted = [...cands].sort((a, b) => b.cy - a.cy);
  const rows = [];
  let current = [];
  let ref = 0;
  for (const c of sorted) {
    if (current.length === 0 || Math.abs(c.cy - ref) <= rowTol) {
      if (current.length === 0) ref = c.cy;
      current.push(c);
      ref += (c.cy - ref) / current.length;
    } else {
      rows.push(finishRow(current));
      current = [c];
      ref = c.cy;
    }
  }
  if (current.length > 0) rows.push(finishRow(current));
  return rows;
}
function finishRow(cands) {
  const ordered = [...cands].sort((a, b) => a.left - b.left);
  const tops = ordered.map((c) => c.cy + c.height / 2);
  const bottoms = ordered.map((c) => c.cy - c.height / 2);
  return {
    cands: ordered,
    cy: ordered.reduce((s, c) => s + c.cy, 0) / ordered.length,
    top: Math.max(...tops),
    bottom: Math.min(...bottoms)
  };
}
function columnBands(cands, minGap) {
  const intervals = cands.map((c) => ({ left: c.left, right: c.right })).sort((a, b) => a.left - b.left);
  const bands = [];
  for (const iv of intervals) {
    const last = bands[bands.length - 1];
    if (last && iv.left - last.right <= minGap) {
      last.right = Math.max(last.right, iv.right);
    } else {
      bands.push({ left: iv.left, right: iv.right });
    }
  }
  return bands;
}
function mergeAlignmentBands(bands, rows) {
  let merged = bands;
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let i = 0; i < merged.length - 1; i++) {
      const together = rows.some((r) => {
        let a = false;
        let b = false;
        for (const c of r.cands) {
          const idx = bandIndex(merged, c.cx);
          if (idx === i) a = true;
          else if (idx === i + 1) b = true;
        }
        return a && b;
      });
      if (together) continue;
      merged = [
        ...merged.slice(0, i),
        { left: merged[i].left, right: merged[i + 1].right },
        ...merged.slice(i + 2)
      ];
      changed = true;
      break;
    }
  }
  return merged;
}
var RULE_COLLINEAR_EPS = 0.75;
var RULE_JOIN_GAP = 2;
function ruleLines(rules, vertical) {
  const pieces = [];
  for (const r of rules) {
    if (r.width <= r.height !== vertical) continue;
    pieces.push(
      vertical ? { at: r.x + r.width / 2, from: r.y, to: r.y + r.height } : { at: r.y + r.height / 2, from: r.x, to: r.x + r.width }
    );
  }
  pieces.sort((a, b) => a.at - b.at || a.from - b.from);
  const out = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && Math.abs(piece.at - last.at) <= RULE_COLLINEAR_EPS && piece.from <= last.to + RULE_JOIN_GAP) {
      last.to = Math.max(last.to, piece.to);
      continue;
    }
    out.push({ ...piece });
  }
  return out;
}
function pinsAcross(lines, lo, hi, minCover, atLo, atHi) {
  const span = hi - lo;
  if (span <= 0) return [];
  const hits = lines.filter(
    (l) => (
      // Running the length of the table is not enough on its own: a second
      // table further down the page has rules just as wide, and taking those
      // in wrecks the grid. The line must sit within this table's extent too.
      l.at >= atLo - RULE_EDGE_MARGIN_PT && l.at <= atHi + RULE_EDGE_MARGIN_PT && (Math.min(l.to, hi) - Math.max(l.from, lo)) / span >= minCover
    )
  ).map((l) => l.at).sort((a, b) => a - b);
  const merged = [];
  for (const v of hits) {
    if (merged.length > 0 && v - merged[merged.length - 1] < 0.75) continue;
    merged.push(v);
  }
  return merged;
}
function pinsSeparate(centres, pins) {
  if (pins.length !== centres.length + 1) return false;
  const sorted = [...centres].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= pins[i] || sorted[i] >= pins[i + 1]) return false;
  }
  return true;
}
function snapAxis(edges, pins, centres, tol) {
  if (pins.length === 0) return { edges, drawn: false };
  const descending = edges[0] > edges[edges.length - 1];
  if (pinsSeparate(centres, pins)) {
    return { edges: descending ? [...pins].reverse() : pins, drawn: true };
  }
  const snapped = edges.map((e) => {
    let best = e;
    let bestDist = tol;
    for (const p of pins) {
      const d = Math.abs(p - e);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  });
  for (let i = 1; i < snapped.length; i++) {
    const ordered = descending ? snapped[i] < snapped[i - 1] : snapped[i] > snapped[i - 1];
    if (!ordered) return { edges, drawn: false };
  }
  return { edges: snapped, drawn: false };
}
var PIN_ROW_COVERAGE = 0.6;
var PIN_EDGE_MARGIN_FRACTION = 0.2;
function rowPins(lines, colEdges, lo, hi) {
  const cols = colEdges.length - 1;
  const margin = Math.max(
    RULE_EDGE_MARGIN_PT,
    (hi - lo) * PIN_EDGE_MARGIN_FRACTION
  );
  const out = [];
  for (const line of lines) {
    if (line.at < lo - margin || line.at > hi + margin) continue;
    const covered = /* @__PURE__ */ new Set();
    for (let c = 0; c < cols; c++) {
      const width = colEdges[c + 1] - colEdges[c];
      if (width <= 0) continue;
      const overlap2 = Math.min(line.to, colEdges[c + 1]) - Math.max(line.from, colEdges[c]);
      if (overlap2 / width >= PIN_ROW_COVERAGE) covered.add(c);
    }
    if (covered.size === 0) continue;
    const near = out.find((p) => Math.abs(p.at - line.at) < 0.75);
    if (near) {
      for (const c of covered) near.cols.add(c);
    } else {
      out.push({ at: line.at, cols: covered });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
function clusterRowPins(pins) {
  if (pins.length < 2) return pins.length > 0 ? [pins] : [];
  const gaps = [];
  for (let i = 1; i < pins.length; i++) gaps.push(pins[i - 1].at - pins[i].at);
  const typical = median(gaps.filter((g) => g > 0));
  const limit = typical > 0 ? typical * ROW_GAP_TOLERANCE : Infinity;
  const out = [[pins[0]]];
  for (let i = 1; i < pins.length; i++) {
    if (pins[i - 1].at - pins[i].at > limit) out.push([]);
    out[out.length - 1].push(pins[i]);
  }
  return out;
}
function bandByRules(cands, pins) {
  if (pins.length < 3) return null;
  const rows = [];
  for (let i = 0; i < pins.length - 1; i++) {
    const hi = pins[i].at;
    const lo = pins[i + 1].at;
    const inBand = cands.filter((c) => c.cy <= hi && c.cy >= lo);
    rows.push({
      cands: [...inBand].sort((a, b) => a.left - b.left),
      cy: (hi + lo) / 2,
      top: hi,
      bottom: lo
    });
  }
  return rows;
}
function columnPins(lines, rows, atLo, atHi) {
  const margin = Math.max(
    RULE_EDGE_MARGIN_PT,
    (atHi - atLo) * PIN_EDGE_MARGIN_FRACTION
  );
  const out = [];
  for (const line of lines) {
    if (line.at < atLo - margin) continue;
    if (line.at > atHi + margin) continue;
    const covered = /* @__PURE__ */ new Set();
    for (let r = 0; r < rows.length; r++) {
      const band = rows[r].top - rows[r].bottom;
      if (band <= 0) continue;
      const overlap2 = Math.min(line.to, rows[r].top) - Math.max(line.from, rows[r].bottom);
      if (overlap2 / band >= PIN_ROW_COVERAGE) covered.add(r);
    }
    if (covered.size === 0) continue;
    const near = out.find((p) => Math.abs(p.at - line.at) < 0.75);
    if (near) {
      for (const r of covered) near.rows.add(r);
    } else {
      out.push({ at: line.at, rows: covered });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
function rowSpans(pins, cols, row) {
  const out = [];
  let start = 0;
  for (let c = 1; c < cols; c++) {
    const pin = pins[c];
    if (pin && !pin.rows.has(row)) continue;
    out.push({ start, span: c - start });
    start = c;
  }
  out.push({ start, span: cols - start });
  return out;
}
function downSpan(pins, rows, row, start, span) {
  let reach = 1;
  while (row + reach < rows) {
    const pin = pins[row + reach];
    if (!pin) break;
    let dividesAll = true;
    for (let c = start; c < start + span; c++) {
      if (!pin.cols.has(c)) dividesAll = false;
    }
    if (dividesAll) break;
    reach++;
  }
  return reach;
}
function edgeIndex(edges, x) {
  const descending = edges[0] > edges[edges.length - 1];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = descending ? edges[i + 1] : edges[i];
    const hi = descending ? edges[i] : edges[i + 1];
    if (x >= lo && x <= hi) return i;
  }
  const firstMid = (edges[0] + edges[1]) / 2;
  return Math.abs(x - firstMid) <= Math.abs(x - edges[edges.length - 1]) ? 0 : edges.length - 2;
}
function bandIndex(bands, x) {
  for (let i = 0; i < bands.length; i++) {
    if (x >= bands[i].left && x <= bands[i].right) return i;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < bands.length; i++) {
    const centre = (bands[i].left + bands[i].right) / 2;
    const d = Math.abs(centre - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
function trimEdgeRows(block) {
  let start = 0;
  let end = block.length;
  while (start < end && block[start].cands.length < 2) start++;
  while (end > start && block[end - 1].cands.length < 2) end--;
  return block.slice(start, end);
}
function splitBlocks(rows, minGap) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    gaps.push(rows[i - 1].bottom - rows[i].top);
  }
  const typical = median(gaps.filter((g) => g > 0));
  const maxGap = Math.max(minGap, typical * ROW_GAP_TOLERANCE);
  const blocks = [];
  let current = [];
  for (let i = 0; i < rows.length; i++) {
    if (current.length === 0) {
      current.push(rows[i]);
      continue;
    }
    const prev = current[current.length - 1];
    const gap = prev.bottom - rows[i].top;
    if (gap > maxGap) {
      blocks.push(current);
      current = [rows[i]];
    } else {
      current.push(rows[i]);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}
function ruledColumnBands(block, rules) {
  const cands = block.flatMap((row) => row.cands);
  if (cands.length === 0) return null;
  const pins = columnPins(
    ruleLines(rules, true),
    block,
    Math.min(...cands.map((c) => c.left)),
    Math.max(...cands.map((c) => c.right))
  );
  if (pins.length < 3) return null;
  const edges = pins.map((pin) => pin.at);
  const horizontal = rowPins(
    ruleLines(rules, false),
    edges,
    block[block.length - 1].bottom,
    block[0].top
  );
  const rows = [block[0].top, ...block.map((row) => row.bottom)];
  if (horizontal.length !== rows.length || horizontal.some((pin, i) => Math.abs(pin.at - rows[i]) > RULE_COLLINEAR_EPS))
    return null;
  const bands = edges.slice(0, -1).map((left, i) => ({
    left,
    right: edges[i + 1]
  }));
  if (bands.some(
    (band) => block.filter(
      (row) => row.cands.some((c) => c.cx > band.left && c.cx < band.right)
    ).length < 2
  ))
    return null;
  return bands;
}
function buildTable(block, bands, pageIndex, index, opts, rules, snapTol) {
  const cols = bands.length;
  const rows = block.length;
  if (rows < opts.minRows || cols < opts.minCols) return null;
  const colGaps = [];
  for (let i = 1; i < cols; i++)
    colGaps.push(bands[i].left - bands[i - 1].right);
  const colPad = Math.max(1, median(colGaps) / 2);
  const derivedCols = [bands[0].left - colPad];
  for (let i = 1; i < cols; i++) {
    derivedCols.push((bands[i - 1].right + bands[i].left) / 2);
  }
  derivedCols.push(bands[cols - 1].right + colPad);
  const rowGaps = [];
  for (let i = 1; i < rows; i++)
    rowGaps.push(block[i - 1].bottom - block[i].top);
  const rowPad = Math.max(1, median(rowGaps) / 2);
  const derivedRows = [block[0].top + rowPad];
  for (let i = 1; i < rows; i++) {
    derivedRows.push((block[i - 1].bottom + block[i].top) / 2);
  }
  derivedRows.push(block[rows - 1].bottom - rowPad);
  const pins = columnPins(
    ruleLines(rules, true),
    block,
    derivedCols[0],
    derivedCols[cols]
  );
  const snappedCols = snapAxis(
    derivedCols,
    pins.map((p) => p.at),
    bands.map((b) => (b.left + b.right) / 2),
    snapTol
  );
  const colEdges = snappedCols.edges;
  const snappedRows = snapAxis(
    derivedRows,
    pinsAcross(
      ruleLines(rules, false),
      colEdges[0],
      colEdges[cols],
      RULE_COVERAGE,
      derivedRows[rows],
      derivedRows[0]
    ),
    block.map((r) => r.cy),
    snapTol
  );
  const rowEdges = snappedRows.edges;
  const spannable = snappedCols.drawn && pins.length === cols + 1;
  const hPins = rowPins(
    ruleLines(rules, false),
    colEdges,
    rowEdges[rows],
    rowEdges[0]
  );
  const downMergeable = spannable && hPins.length === rows + 1;
  const byCol = block.map((row) => {
    const map = /* @__PURE__ */ new Map();
    for (const c of row.cands) {
      const col = edgeIndex(colEdges, c.cx);
      const list = map.get(col) ?? [];
      list.push(c.run.id);
      map.set(col, list);
    }
    return map;
  });
  const cells = [];
  const covered = /* @__PURE__ */ new Set();
  let occupiedCells = 0;
  for (let r = 0; r < rows; r++) {
    const spans = spannable ? rowSpans(pins, cols, r) : Array.from({ length: cols }, (_, col) => ({ start: col, span: 1 }));
    for (const { start, span } of spans) {
      if (covered.has(`${r},${start}`)) continue;
      const rowSpan = downMergeable ? downSpan(hPins, rows, r, start, span) : 1;
      const runIds = [];
      for (let rr = r; rr < r + rowSpan; rr++) {
        for (let col = start; col < start + span; col++) {
          runIds.push(...byCol[rr]?.get(col) ?? []);
        }
      }
      for (let rr = r; rr < r + rowSpan; rr++) {
        for (let cc = start; cc < start + span; cc++) {
          if (rr !== r || cc !== start) covered.add(`${rr},${cc}`);
        }
      }
      if (runIds.length > 0) occupiedCells++;
      cells.push({
        row: r,
        col: start,
        runIds,
        colSpan: span,
        rowSpan,
        rect: {
          x: colEdges[start],
          y: rowEdges[r + rowSpan],
          width: colEdges[start + span] - colEdges[start],
          height: rowEdges[r] - rowEdges[r + rowSpan]
        }
      });
    }
  }
  const fill = occupiedCells / cells.length;
  if (fill < 0.4) return null;
  const rowsWithMultipleCols = block.filter(
    (r) => new Set(r.cands.map((c) => edgeIndex(colEdges, c.cx))).size >= 2
  ).length;
  if (rowsWithMultipleCols < 2) return null;
  const bounds = {
    x: colEdges[0],
    y: rowEdges[rows],
    width: colEdges[cols] - colEdges[0],
    height: rowEdges[0] - rowEdges[rows]
  };
  const confidence = Math.min(
    1,
    0.5 * fill + 0.5 * (rowsWithMultipleCols / rows)
  );
  return {
    id: `p${pageIndex}-table-${index}`,
    pageIndex,
    rows,
    cols,
    colEdges,
    rowEdges,
    bounds,
    cells,
    confidence,
    synthetic: false,
    // Only adoption can tell: it needs the render modes behind the text.
    scanned: false,
    ruled: false,
    pageRuled: snappedCols.drawn && snappedRows.drawn,
    adopted: false,
    // Styles are read off the runs when the table is adopted for editing.
    columnStyles: [],
    headerStyle: null
  };
}
function detectTables(runs, pageIndex, options = {}, rules = []) {
  const opts = { ...DEFAULT_TABLE_OPTIONS, ...options };
  const cands = runs.flatMap(toCandidates);
  if (cands.length < opts.minRows * opts.minCols) return [];
  const medHeight = median(cands.map((c) => c.height)) || 1;
  const rowTol = medHeight * opts.rowTolFactor;
  const minColGap = Math.max(3, medHeight * opts.colTolFactor);
  const maxGap = medHeight * opts.maxRowGapFactor;
  const allPins = rowPins(
    ruleLines(rules, false),
    [
      Math.min(...cands.map((c) => c.left)),
      Math.max(...cands.map((c) => c.right))
    ],
    Math.min(...cands.map((c) => c.cy)),
    Math.max(...cands.map((c) => c.cy))
  );
  const blocks = [];
  const claimed = /* @__PURE__ */ new Set();
  for (const group of clusterRowPins(allPins)) {
    if (group.length < 3) continue;
    const top = group[0].at;
    const bottom = group[group.length - 1].at;
    const inside = cands.filter((c) => c.cy <= top && c.cy >= bottom);
    if (inside.length < opts.minRows * opts.minCols) continue;
    const banded = bandByRules(inside, group);
    if (!banded) continue;
    blocks.push(banded);
    for (const c of inside) claimed.add(c);
  }
  const loose = cands.filter((c) => !claimed.has(c));
  if (loose.length > 0) {
    blocks.push(
      ...splitBlocks(
        groupRows(loose, rowTol).filter((r) => r.cands.length >= 1),
        maxGap
      )
    );
  }
  const tables = [];
  for (const raw of blocks) {
    const block = trimEdgeRows(raw);
    const multiRunRows = block.filter((r) => r.cands.length >= 2);
    if (multiRunRows.length < opts.minRows) continue;
    const bands = ruledColumnBands(block, rules) ?? mergeAlignmentBands(
      columnBands(
        multiRunRows.flatMap((r) => r.cands),
        minColGap
      ),
      block
    );
    const table = buildTable(
      block,
      bands,
      pageIndex,
      tables.length,
      opts,
      rules,
      Math.max(4, medHeight * 1.5)
    );
    if (table) tables.push(table);
  }
  return tables;
}

// src/table-adapter.mjs
var TABLE_LIMITS = Object.freeze({ maxBytes: 25 * 1024 * 1024, maxPages: 200, maxRuns: 12e3, maxRules: 12e3, maxChars: 15e4, maxCellChars: 4e3 });
var SCHEMA = "falsify.source-tables.v1";
var issued = /* @__PURE__ */ new WeakSet();
var TableAdapterError = class extends Error {
  constructor(code) {
    super(code);
    this.name = "TableAdapterError";
    this.code = code;
  }
};
var fail = (code) => {
  throw new TableAdapterError(code);
};
var boxOK = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
var union = (bs) => [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
var overlap = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.05 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.05;
var contains = (outer, inner, tol = 0) => outer[0] - tol <= inner[0] && outer[1] - tol <= inner[1] && outer[2] + tol >= inner[2] && outer[3] + tol >= inner[3];
function frozen(v) {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
}
async function digest(data) {
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
var id = async (prefix, value) => prefix + (await digest(new TextEncoder().encode(JSON.stringify(value)))).slice(0, 24);
var rect = (b) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] });
var publicBox = (r, h) => [r.x, h - r.y - r.height, r.x + r.width, h - r.y];
async function detectSourceTables({ sourceBytes, sourceSha256, revision, mupdf: mupdf2, readPages } = {}) {
  if (!(sourceBytes instanceof Uint8Array) || sourceBytes.byteLength > TABLE_LIMITS.maxBytes || sourceBytes.byteLength < 5) fail("invalid-source");
  if (typeof revision !== "string" || !revision || revision.length > 200) fail("invalid-revision");
  const bytes = sourceBytes.slice(), sha = await digest(bytes);
  if (typeof sourceSha256 !== "string" || sha !== sourceSha256) fail("stale-source");
  if (readPages !== void 0 && typeof readPages !== "function") fail("invalid-reader");
  const pages = await (readPages ? readPages(bytes) : readMuPdfTablePages(bytes, mupdf2));
  if (await digest(bytes) !== sha) fail("reader-mutated-source");
  if (!Array.isArray(pages) || !pages.length || pages.length > TABLE_LIMITS.maxPages) fail("page-limit");
  const tables = [], pageModels = [];
  let charsTotal = 0;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    if (page.pageIndex !== p || !(page.width > 0 && page.height > 0) || ![page.width, page.height].every(Number.isFinite) || page.coordinateSpace !== "top-left-page") fail("invalid-page");
    if (!Array.isArray(page.runs) || page.runs.length > TABLE_LIMITS.maxRuns || !Array.isArray(page.rules) || page.rules.length > TABLE_LIMITS.maxRules) fail("snapshot-limit");
    const seen = /* @__PURE__ */ new Set(), runs = page.runs.map((r) => {
      if (typeof r.id !== "string" || !r.id || seen.has(r.id) || typeof r.text !== "string" || !boxOK(r.bbox) || !contains([0, 0, page.width, page.height], r.bbox, 0.1)) fail("invalid-run");
      seen.add(r.id);
      charsTotal += r.text.length;
      if (charsTotal > TABLE_LIMITS.maxChars) fail("character-limit");
      return { id: r.id, text: r.text, bbox: [...r.bbox], horizontal: r.horizontal !== false };
    });
    const rules = page.rules.map((r) => {
      if (!boxOK(r.bbox)) fail("invalid-rule");
      return rect([r.bbox[0], page.height - r.bbox[3], r.bbox[2], page.height - r.bbox[1]]);
    });
    if (page.chars && (!Array.isArray(page.chars) || page.chars.length > TABLE_LIMITS.maxChars)) fail("character-limit");
    const pm = { pageIndex: p, width: page.width, height: page.height, rotation: page.rotation, runs, chars: page.chars?.map((c) => ({ c: c.c, bbox: [...c.bbox], lineId: c.lineId })) ?? null };
    if (pm.chars && pm.chars.some((c) => typeof c.c !== "string" || !boxOK(c.bbox) || !Number.isInteger(c.lineId))) fail("invalid-characters");
    pageModels.push(pm);
    if (page.rotation !== 0) continue;
    const candidates = detectTables(runs.map((r) => ({ id: r.id, text: r.text, bounds: rect([r.bbox[0], page.height - r.bbox[3], r.bbox[2], page.height - r.bbox[1]]), locked: !r.horizontal })), p, {}, rules);
    for (const table of candidates) {
      const numeric = table.cells.filter((c) => c.runIds.some((rid) => /^[\s$€£¥+−\-\d.,()%±:eE/]+$/.test(runs.find((r) => r.id === rid)?.text || "") && /\d/.test(runs.find((r) => r.id === rid)?.text || ""))).length;
      if (!table.pageRuled && (table.rows < 3 || numeric < 2)) continue;
      const bbox = publicBox(table.bounds, page.height), tableId = await id("tbl-", [sha, revision, p, bbox, table.rowEdges, table.colEdges]);
      const cells = [];
      for (const cell of table.cells) {
        const bbox2 = publicBox(cell.rect, page.height), cellId = await id("cell-", [sha, revision, p, tableId, cell.row, cell.col, bbox2, cell.runIds]);
        cells.push({ id: cellId, row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan, bbox: bbox2, runIds: [...cell.runIds] });
      }
      tables.push({ id: tableId, pageIndex: p, bbox, rows: table.rows, cols: table.cols, ruled: table.pageRuled, confidence: table.confidence, cells });
    }
  }
  const model = frozen({ schema: SCHEMA, authority: "structure-hint", sourceBinding: readPages ? "verified-bytes-reader-adapter" : "mupdf-source-read", sourceSha256: sha, revision, coordinateSpace: "top-left-page", tables, pages: pageModels });
  issued.add(model);
  return model;
}
function selectTableCell(model, { tableId, cellId, sourceSha256, revision } = {}) {
  if (!issued.has(model)) fail("unverified-model");
  if (model.sourceSha256 !== sourceSha256 || model.revision !== revision) fail("stale-selection");
  const table = model.tables.find((t) => t.id === tableId), cell = table?.cells.find((c) => c.id === cellId);
  if (!cell) fail("cell-not-found");
  const page = model.pages[table.pageIndex], selected = page.runs.filter((r) => cell.runIds.includes(r.id));
  const unsupported = (reason) => frozen({ status: "unsupported", reason, tableId, cellId, sourceSha256, revision });
  if (selected.length !== 1) return unsupported(selected.length ? "multi-run-cell" : "empty-cell");
  const run = selected[0], before = run.text;
  if (!before.trim() || before.length > TABLE_LIMITS.maxCellChars) return unsupported("cell-text-limit");
  if (!run.horizontal) return unsupported("rotated-text");
  if (!contains(cell.bbox, run.bbox, 0.2)) return unsupported("cell-boundary-uncertain");
  if (page.runs.some((r) => r.id !== run.id && r.text.trim() && overlap(r.bbox, run.bbox))) return unsupported("overlapping-text");
  const needle = before.replace(/\s+/g, " ").trim(), matching = [];
  const consider = (b) => {
    if (contains(b, run.bbox, Math.max(4, Math.min(8, (b[3] - b[1]) / 2)))) matching.push(b);
  };
  if (page.chars) {
    const { text, map } = normalizeChars(page.chars);
    let from = 0;
    while (matching.length < 2) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const bs = map.slice(at, at + needle.length).filter((n) => n !== null).map((n) => page.chars[n].bbox);
      if (bs.length) consider(union(bs));
      from = at + 1;
    }
  } else {
    for (const r of page.runs) {
      const text = r.text.replace(/\s+/g, " ").trim();
      let at = -1;
      while (matching.length < 2 && (at = text.indexOf(needle, at + 1)) >= 0) consider(r.bbox);
      if (matching.length === 2) break;
    }
  }
  if (matching.length !== 1) return unsupported(matching.length ? "ambiguous-quote" : "quote-mismatch");
  return frozen({ status: "ready", tableId, cellId, sourceSha256, revision, before, pageIndex: table.pageIndex, runIds: [run.id], cellBbox: [...cell.bbox], anchor: { bbox: [...run.bbox], coordinateSpace: "top-left-page", origin: "top-left", yAxis: "down", unit: "pt" } });
}
function normalizeChars(chars) {
  let text = "", map = [], gap = false, line = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (line !== null && c.lineId !== line) gap = true;
    line = c.lineId;
    if (!c.c.trim()) {
      gap = true;
      continue;
    }
    if (gap && text) {
      text += " ";
      map.push(null);
    }
    gap = false;
    text += c.c;
    for (let k = 0; k < c.c.length; k++) map.push(i);
  }
  return { text, map };
}
function readMuPdfTablePages(bytes, mupdf2) {
  if (!mupdf2?.Document || !mupdf2?.Device) fail("reader-unavailable");
  let doc;
  const pages = [];
  try {
    doc = mupdf2.Document.openDocument(bytes, "application/pdf").asPDF();
    if (!doc || doc.needsPassword()) fail("unsupported-document");
    if (doc.countPages() > TABLE_LIMITS.maxPages) fail("page-limit");
    for (let p = 0; p < doc.countPages(); p++) {
      const page = doc.loadPage(p), runs = [], chars = [], rules = [];
      let st, dev;
      try {
        const bounds = page.getBounds(), width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
        const object = page.getObject(), rotation = object.getInheritable("Rotate").asNumber() || 0;
        if (bounds[0] !== 0 || bounds[1] !== 0) fail("unsupported-page-origin");
        let lineChars = [], horizontal = true, lineId = -1, lastY = null;
        const transform = page.getTransform();
        const finish = () => {
          if (!lineChars.length) return;
          let start = 0;
          for (let i = 1; i <= lineChars.length; i++) {
            const a = lineChars[i - 1], b = lineChars[i];
            if (!b || b.bbox[0] - a.bbox[2] > Math.max(3, a.size * 1.5)) {
              const group = lineChars.slice(start, i);
              while (group.length && !group[0].c.trim()) group.shift();
              while (group.length && !group.at(-1).c.trim()) group.pop();
              if (group.length) runs.push({ id: `p${p}-run${runs.length}`, text: group.map((c) => c.c).join(""), bbox: union(group.map((c) => c.bbox)), horizontal });
              start = i;
            }
          }
          lineChars = [];
        };
        st = page.toStructuredText("preserve-whitespace,preserve-images");
        st.walk({ beginLine(_b, wmode, direction) {
          finish();
          horizontal = wmode === 0 && Math.abs(direction[1]) < 0.01 && direction[0] > 0;
        }, onChar(c, origin, _font, size, quad) {
          const bbox = [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]), Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
          const y = transform[1] * origin[0] + transform[3] * origin[1] + transform[5];
          if (lastY === null || Math.abs(y - lastY) > 1.25) {
            lineId++;
            lastY = y;
          }
          if (boxOK(bbox)) {
            const item = { c, bbox, lineId, size };
            chars.push(item);
            lineChars.push(item);
          }
          if (chars.length > TABLE_LIMITS.maxChars) fail("character-limit");
        }, endLine() {
          finish();
        } });
        finish();
        dev = new mupdf2.Device({ strokePath(path, stroke, ctm, _cs, _color, alpha) {
          if (alpha !== 1) return;
          let current = null, first = null;
          const point = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
          const segment = (next) => {
            if (current) {
              const dx = Math.abs(next[0] - current[0]), dy = Math.abs(next[1] - current[1]), t = Math.max(0.1, stroke.getLineWidth() * Math.hypot(ctm[0], ctm[1]));
              if (dx < 0.1 && dy > 2 || dy < 0.1 && dx > 2) rules.push({ bbox: [Math.min(current[0], next[0]) - t / 2, Math.min(current[1], next[1]) - t / 2, Math.max(current[0], next[0]) + t / 2, Math.max(current[1], next[1]) + t / 2] });
            }
            current = next;
            if (rules.length > TABLE_LIMITS.maxRules) fail("rule-limit");
          };
          path.walk({ moveTo(x, y) {
            current = first = point(x, y);
          }, lineTo(x, y) {
            segment(point(x, y));
          }, curveTo() {
            current = null;
          }, closePath() {
            if (first) segment(first);
          } });
        } });
        page.run(dev, [1, 0, 0, 1, 0, 0]);
        dev.close();
        pages.push({ pageIndex: p, width, height, rotation, coordinateSpace: "top-left-page", runs, rules, chars });
      } finally {
        dev?.destroy();
        st?.destroy();
        page.destroy();
      }
    }
    return pages;
  } finally {
    doc?.destroy();
  }
}

// src/table-pdf-worker.mjs
var MAX_CELLS = 500;
var hex = (bytes) => [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
async function inspectTables(data) {
  if (!Number.isSafeInteger(data.pageIndex) || data.pageIndex < 0 || typeof data.revision !== "string") throw new Error("invalid-request");
  const model = await detectSourceTables({ sourceBytes: new Uint8Array(data.bytes), sourceSha256: data.fileHash, revision: data.revision, mupdf });
  const page = model.pages[data.pageIndex];
  if (!page) throw new Error("page-not-found");
  const cells = [];
  let count = 0;
  for (const table of model.tables) {
    if (table.pageIndex !== data.pageIndex) continue;
    for (const cell of table.cells) {
      count++;
      if (cells.length >= MAX_CELLS) continue;
      const selection = selectTableCell(model, { tableId: table.id, cellId: cell.id, sourceSha256: data.fileHash, revision: data.revision });
      let alias = null;
      if (selection.status === "ready") {
        const key = JSON.stringify([model.sourceSha256, data.pageIndex, selection.anchor.bbox, selection.before]);
        alias = "table:" + data.pageIndex + ":" + hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))).slice(0, 24);
      }
      cells.push({ row: cell.row, col: cell.col, cellBbox: cell.bbox, alias, selection });
    }
  }
  return {
    fileHash: model.sourceSha256,
    revision: model.revision,
    pageIndex: data.pageIndex,
    width: page.width,
    height: page.height,
    cells,
    truncated: count > MAX_CELLS,
    totalCells: count,
    limit: MAX_CELLS
  };
}
async function checkFit(data) {
  const bytes = new Uint8Array(data.bytes);
  if (bytes.length > 25 * 1024 * 1024 || !Array.isArray(data.cells) || data.cells.length > 24 || data.cells.some((c) => typeof c.id !== "string" || !Number.isSafeInteger(c.pageIndex) || c.pageIndex < 0 || typeof c.after !== "string" || c.after.length > 4e3 || !Array.isArray(c.bbox) || c.bbox.length !== 4 || !c.bbox.every(Number.isFinite) || c.bbox[0] >= c.bbox[2] || c.bbox[1] >= c.bbox[3])) throw new Error("invalid-request");
  if (hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !== data.fileHash) throw new Error("stale-source");
  const pages = readMuPdfTablePages(bytes, mupdf), contains2 = (a, b) => a[0] - 0.5 <= b[0] && a[1] - 0.5 <= b[1] && a[2] + 0.5 >= b[2] && a[3] + 0.5 >= b[3];
  const results = data.cells.map((cell) => {
    if (!cell.after) return { id: cell.id, status: "empty" };
    const normalized = cell.after.replace(/\s+/g, " ").trim(), runs = pages[cell.pageIndex]?.runs || [];
    const hits = runs.filter((r) => r.text.replace(/\s+/g, " ").includes(normalized) && r.bbox[0] < cell.bbox[2] && r.bbox[2] > cell.bbox[0] && r.bbox[1] < cell.bbox[3] && r.bbox[3] > cell.bbox[1]);
    return { id: cell.id, status: hits.length === 1 ? contains2(cell.bbox, hits[0].bbox) ? "inside" : "overflow" : "unverified" };
  });
  return { fileHash: data.fileHash, revision: data.revision, pageIndex: data.pageIndex, results };
}
if (typeof self !== "undefined") {
  self.onmessage = async (event) => {
    const data = event.data || {};
    try {
      self.postMessage({ id: data.id, ok: true, result: await (data.operation === "checkFit" ? checkFit(data) : inspectTables(data)) });
    } catch (error) {
      self.postMessage({ id: data.id, ok: false, error: { code: error?.code || "table-inspection-failed" } });
    }
  };
  self.postMessage({ ready: true });
}
export {
  checkFit,
  inspectTables
};
