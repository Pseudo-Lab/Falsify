// Stirling-PDF MIT core; pinned cd48ccb288f66ff884cbb084bf101b875ed7ded7. See NOTICE.md and upstream/LICENSE.

// coordination/release-20261026/table-workbench/app/src/table-vendor/upstream/frontend/src/editor/core/tools/pdfTextEditor/util/util/tableGeometry.ts
function insertColumnEdges(colEdges, k, w) {
  const out = [];
  for (let i = 0; i < k; i++) out.push(colEdges[i]);
  out.push(colEdges[k]);
  for (let i = k; i < colEdges.length; i++) out.push(colEdges[i] + w);
  return { edges: out, shift: { fromIndex: k, delta: w } };
}
function removeColumnEdges(colEdges, k) {
  const w = colEdges[k + 1] - colEdges[k];
  const out = [];
  for (let i = 0; i < colEdges.length; i++) {
    if (i === k + 1) continue;
    out.push(i <= k ? colEdges[i] : colEdges[i] - w);
  }
  return { edges: out, shift: { fromIndex: k + 1, delta: -w } };
}
function insertRowEdges(rowEdges, k, h) {
  const out = [];
  for (let i = 0; i < k; i++) out.push(rowEdges[i]);
  out.push(rowEdges[k]);
  for (let i = k; i < rowEdges.length; i++) out.push(rowEdges[i] - h);
  return { edges: out, shift: { fromIndex: k, delta: -h } };
}
function removeRowEdges(rowEdges, k) {
  const h = rowEdges[k] - rowEdges[k + 1];
  const out = [];
  for (let i = 0; i < rowEdges.length; i++) {
    if (i === k + 1) continue;
    out.push(i <= k ? rowEdges[i] : rowEdges[i] + h);
  }
  return { edges: out, shift: { fromIndex: k + 1, delta: h } };
}
function uniformColumnEdges(x, width, cols) {
  const step = width / cols;
  return Array.from({ length: cols + 1 }, (_, i) => x + i * step);
}
function uniformRowEdges(topY, height, rows) {
  const step = height / rows;
  return Array.from({ length: rows + 1 }, (_, i) => topY - i * step);
}
var MIN_TRACK = 8;
function moveColumnEdge(colEdges, k, x, min = MIN_TRACK) {
  const out = [...colEdges];
  if (k <= 0 || k >= colEdges.length - 1) return out;
  const lo = colEdges[k - 1] + min;
  const hi = colEdges[k + 1] - min;
  if (hi < lo) return out;
  out[k] = Math.min(Math.max(x, lo), hi);
  return out;
}
function moveRowEdge(rowEdges, k, y, min = MIN_TRACK) {
  const out = [...rowEdges];
  if (k <= 0 || k >= rowEdges.length - 1) return out;
  const hi = rowEdges[k - 1] - min;
  const lo = rowEdges[k + 1] + min;
  if (hi < lo) return out;
  out[k] = Math.min(Math.max(y, lo), hi);
  return out;
}
function scaleColumnEdges(colEdges, width, min = MIN_TRACK) {
  const cols = colEdges.length - 1;
  if (cols < 1) return [...colEdges];
  const x0 = colEdges[0];
  const span = colEdges[cols] - x0;
  const target = Math.max(width, min * cols);
  if (span <= 0) return uniformColumnEdges(x0, target, cols);
  const smallest = Math.min(
    ...colEdges.slice(1).map((x, i) => x - colEdges[i])
  );
  if (smallest <= 0) return uniformColumnEdges(x0, target, cols);
  const k = Math.max(target / span, min / smallest);
  return colEdges.map((x) => x0 + (x - x0) * k);
}
function scaleRowEdges(rowEdges, height, min = MIN_TRACK) {
  const rows = rowEdges.length - 1;
  if (rows < 1) return [...rowEdges];
  const y0 = rowEdges[0];
  const span = y0 - rowEdges[rows];
  const target = Math.max(height, min * rows);
  if (span <= 0) return uniformRowEdges(y0, target, rows);
  const smallest = Math.min(
    ...rowEdges.slice(1).map((y, i) => rowEdges[i] - y)
  );
  if (smallest <= 0) return uniformRowEdges(y0, target, rows);
  const k = Math.max(target / span, min / smallest);
  return rowEdges.map((y) => y0 - (y0 - y) * k);
}
function resizeColumnTrack(colEdges, k, x, min = MIN_TRACK) {
  if (k < 1 || k > colEdges.length - 1) return [...colEdges];
  const clamped = Math.max(x, colEdges[k - 1] + min);
  const delta = clamped - colEdges[k];
  return colEdges.map((v, i) => i >= k ? v + delta : v);
}
function resizeRowTrack(rowEdges, k, y, min = MIN_TRACK) {
  if (k < 1 || k > rowEdges.length - 1) return [...rowEdges];
  const clamped = Math.min(y, rowEdges[k - 1] - min);
  const delta = clamped - rowEdges[k];
  return rowEdges.map((v, i) => i >= k ? v + delta : v);
}
export {
  MIN_TRACK,
  insertColumnEdges,
  insertRowEdges,
  moveColumnEdge,
  moveRowEdge,
  removeColumnEdges,
  removeRowEdges,
  resizeColumnTrack,
  resizeRowTrack,
  scaleColumnEdges,
  scaleRowEdges,
  uniformColumnEdges,
  uniformRowEdges
};
