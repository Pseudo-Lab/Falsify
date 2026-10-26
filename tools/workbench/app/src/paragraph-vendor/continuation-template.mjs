// Source-style running headers/footers on continuation pages.
//
// A continuation page repeats the edge text of its source page: every text
// object outside the body band is re-created on the new page with the same
// font object, size, matrix, colours, render mode and per-character
// positions (FPDFText_SetPositions, so TJ/Tc/Tw spacing is kept as absolute
// glyph offsets). A standalone Arabic page number ("10", "10 ") becomes the
// source number plus a decimal suffix ("10.1", "10.2" ...) at the source
// alignment anchor. Original edge objects are only read, never moved.
//
// Scope is text-only. Fixed artwork wholly inside the physical edge band
// stays on the source page and is not repeated. Intruding graphics, ambiguous numbers, off-baseline edge
// text and unencodable suffix glyphs are specific errors before anything is
// cloned; every clone is proven against the source glyphs via FPDFText.
// Contract: docs/PAGINATION.md.

const OBJ_TEXT = 1;
const POS_TOL = 0.05;
const ANCHOR_TOL = 0.1;
const CENTER_TOL = 2;

export const CONTINUATION_STYLE = Object.freeze({ version: 1, policy: "source-number-suffix" });

// Same page-number shape as quality.classify; anything number-like that is
// not a bare Arabic number is refused rather than copied or rewritten.
const NUMBER_LIKE = /^[\s\-–—|/.()]*(\d+|[ivxlcdm]+)([\s\-–—|/.()]*(\d+|of))*[\s\-–—|/.()]*$/i;
// Labelled numbers ("Page 3", "p. 3 of 9") would be duplicated verbatim.
const LABELLED_NUMBER = /^(page|pg\.?|p\.)\s*\d+/i;

export function classifyEdgeText(text) {
  const t = String(text).trim();
  if (/^\d+$/.test(t)) return "page_number";
  if (t && (NUMBER_LIKE.test(t) || LABELLED_NUMBER.test(t))) return "number_unsupported";
  return "running";
}

// Resolve only a spatially corroborated three-object footer fraction.
// Return the denominator object, which is fixed running text, not another
// source page number. Other multiple-number shapes remain ambiguous.
export function resolvePageFraction(items) {
  const nums = items.filter((i) => /^\d+$/.test(i.text.trim()));
  const slash = items.filter((i) => i.text.trim() === "/");
  if (slash.length !== 1) return null;
  const d = slash[0];
  const a = nums.filter((n) => n.bounds.r <= d.bounds.l + 0.5).sort((a,b) => b.bounds.r - a.bounds.r)[0];
  const b = nums.filter((n) => n.bounds.l >= d.bounds.r - 0.5).sort((a,b) => a.bounds.l - b.bounds.l)[0];
  if (!a || !b) return null;
  const baseline = (i) => i.chars?.[0]?.oy;
  if (![a, b, d].every((i) => Number.isFinite(baseline(i))) || Math.abs(baseline(a) - baseline(b)) > 0.5 || Math.abs(baseline(a) - baseline(d)) > 0.5) return null;
  if (!(a.bounds.r <= d.bounds.l + 0.5 && d.bounds.r <= b.bounds.l + 0.5)) return null;
  const size = a.bounds.t - a.bounds.b;
  if (!(size > 0) || d.bounds.l - a.bounds.r > size || b.bounds.l - d.bounds.r > size || +a.text > +b.text || +a.text < 1) return null;
  const fixedNumbers = new Set([b]);
  // A publisher date can contain a standalone year. Corroborate the
  // adjacent month/day objects; unrelated numeric headers stay ambiguous.
  const row = items.filter((i) => Math.abs(baseline(i) - baseline(a)) <= 0.5).sort((a,b) => a.bounds.l - b.bounds.l);
  for (let k = 2; k < row.length; k++) {
    if (/^(19|20)\d{2}$/.test(row[k].text.trim()) && /^\d{1,2},$/.test(row[k-1].text.trim()) && /^(January|February|March|April|May|June|July|August|September|October|November|December)$/.test(row[k-2].text.trim()) && row[k].bounds.r < a.bounds.l) fixedNumbers.add(row[k]);
  }
  return { numerator: a, denominator: b, fixedNumbers };
}

export function continuationNumberText(source, ordinal) {
  const t = String(source).trim();
  if (!/^\d+$/.test(t) || !Number.isInteger(ordinal) || ordinal < 1) return null;
  return t + "." + ordinal;
}

// Replaces the trimmed number inside the object text and keeps the
// surrounding whitespace characters ("10 " -> "10.1 ").
export function suffixedText(text, ordinal) {
  const m = /^(\s*)(\d+)(\s*)$/.exec(text);
  const n = m && continuationNumberText(m[2], ordinal);
  return n ? m[1] + n + m[3] : null;
}

// Anchor from the number's character extents ({ l, r }); trailing spaces
// widen object bounds without moving the visible number.
export function anchorOf(bounds, pageW) {
  const c = (bounds.l + bounds.r) / 2;
  if (Math.abs(c - pageW / 2) <= CENTER_TOL) return { anchor: "center", x: c };
  if (c > pageW / 2) return { anchor: "right", x: bounds.r };
  return { anchor: "left", x: bounds.l };
}

export function anchorX(anchor, b) {
  return anchor === "center" ? (b.l + b.r) / 2 : anchor === "right" ? b.r : b.l;
}

// Extents of the non-space characters from their loose (advance) boxes,
// FPDFText_GetLooseCharBox, the same measure the saved-PDF check anchors
// page numbers with; tight glyph boxes differ per glyph shape.
export function inkExtents(chars) {
  const ink = chars.filter((c) => c.u > 32 && c.u !== 0xa0 && c.ll !== null && c.ll !== undefined);
  if (!ink.length) return null;
  return { l: Math.min(...ink.map((c) => c.ll)), r: Math.max(...ink.map((c) => c.lr)) };
}

// ---------- wasm helpers ----------

function objectBox(M, h) {
  const p = M._malloc(16);
  try {
    if (!M._FPDFPageObj_GetBounds(h, p, p + 4, p + 8, p + 12)) return null;
    const f = (k) => M.HEAPF32[(p >> 2) + k];
    return { l: f(0), b: f(1), r: f(2), t: f(3) };
  } finally {
    M._free(p);
  }
}

function readMatrix(M, h) {
  const p = M._malloc(24);
  try {
    if (!M._FPDFPageObj_GetMatrix(h, p)) return null;
    return [0, 1, 2, 3, 4, 5].map((k) => M.HEAPF32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}

function writeMatrix(M, h, m) {
  const p = M._malloc(24);
  try {
    m.forEach((v, k) => (M.HEAPF32[(p >> 2) + k] = v));
    return !!M._FPDFPageObj_SetMatrix(h, p);
  } finally {
    M._free(p);
  }
}

function readColor(M, fn, h) {
  const p = M._malloc(16);
  try {
    if (!M[fn](h, p, p + 4, p + 8, p + 12)) return null;
    return [0, 1, 2, 3].map((k) => M.HEAPU32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}

function readFloat(M, fn, ...args) {
  const p = M._malloc(4);
  try {
    return M[fn](...args, p) ? M.HEAPF32[p >> 2] : null;
  } finally {
    M._free(p);
  }
}

function readFontString(M, fn, font) {
  const n = M[fn](font, 0, 0);
  if (!n || n > 4096) return "";
  const p = M._malloc(n);
  try {
    M[fn](font, p, n);
    return M.UTF8ToString(p, n).replace(/\0+$/, "");
  } finally {
    M._free(p);
  }
}

function fontInfo(M, font) {
  const p = M._malloc(4);
  let italicAngle = null;
  try {
    if (M._FPDFFont_GetItalicAngle(font, p)) italicAngle = M.HEAP32[p >> 2];
  } finally {
    M._free(p);
  }
  return {
    baseName: readFontString(M, "_FPDFFont_GetBaseFontName", font),
    family: readFontString(M, "_FPDFFont_GetFamilyName", font),
    weight: M._FPDFFont_GetWeight(font),
    italicAngle,
    flags: M._FPDFFont_GetFlags(font),
    embedded: !!M._FPDFFont_GetIsEmbedded(font),
  };
}

// Characters of each text object from one text page: non-generated chars
// only, origin and box in page space, grouped by object handle.
function charsByObject(M, page) {
  const tp = M._FPDFText_LoadPage(page);
  const out = new Map();
  if (!tp) return out;
  const b = M._malloc(32);
  try {
    const n = M._FPDFText_CountChars(tp);
    for (let i = 0; i < n; i++) {
      if (M._FPDFText_IsGenerated(tp, i) === 1) continue;
      const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
      if (!h) continue;
      const c = { u: M._FPDFText_GetUnicode(tp, i), ox: null, oy: null, l: null, b: null, r: null, t: null, ll: null, lr: null };
      if (M._FPDFText_GetCharOrigin(tp, i, b, b + 8)) {
        c.ox = M.HEAPF64[b >> 3];
        c.oy = M.HEAPF64[(b + 8) >> 3];
      }
      if (M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24)) {
        c.l = M.HEAPF64[b >> 3];
        c.r = M.HEAPF64[(b + 8) >> 3];
        c.b = M.HEAPF64[(b + 16) >> 3];
        c.t = M.HEAPF64[(b + 24) >> 3];
      }
      // FS_RECTF { left, top, right, bottom }
      if (M._FPDFText_GetLooseCharBox(tp, i, b)) {
        c.ll = M.HEAPF32[b >> 2];
        c.lr = M.HEAPF32[(b >> 2) + 2];
      }
      if (!out.has(h)) out.set(h, []);
      out.get(h).push(c);
    }
  } finally {
    M._free(b);
    M._FPDFText_ClosePage(tp);
  }
  return out;
}

const textOf = (chars) => chars.map((c) => String.fromCodePoint(c.u)).join("");

// Page-space point -> text space of matrix m.
function toTextSpace(m, x, y) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (d * (x - e) - c * (y - f)) / det, y: (-b * (x - e) + a * (y - f)) / det };
}

// FPDFFont_GetGlyphWidth/GetGlyphPath take a Unicode code point and map it
// through the font; no width or no outline means the font cannot draw it.
function glyphAvailable(M, font, size, u) {
  const w = readFloat(M, "_FPDFFont_GetGlyphWidth", font, u, size);
  if (!(w > 0)) return false;
  const path = M._FPDFFont_GetGlyphPath(font, u, size);
  return !!path && M._FPDFGlyphPath_CountGlyphSegments(path) > 0;
}

// ---------- snapshot ----------

/**
 * snapshotPageEdges(engine, floor, bodyTop, exclude?) => { ok, code, items, ... }
 * Reads the edge text objects of engine.page (bounds centre outside
 * [floor - 0.5, bodyTop + 0.5]). `exclude` (Set of object handles) names
 * body-flow objects that are not edges even while they overflow the band
 * (an edited paragraph before pagination moves it). No mutation.
 */
export function snapshotPageEdges(engine, floor, bodyTop, exclude = null) {
  const M = engine.M;
  const fail = (code, extra = {}) => ({ ok: false, code, items: [], ...extra });
  if (!(Number.isFinite(floor) && Number.isFinite(bodyTop) && bodyTop > floor)) return fail("continuation_edge_band_invalid");
  const page = engine.page;
  const pageW = M._FPDF_GetPageWidthF(page), pageH = M._FPDF_GetPageHeightF(page);
  const lo = floor - 0.5, hi = bodyTop + 0.5;
  const n = M._FPDFPage_CountObjects(page);
  const order = new Map();
  const edges = [];
  for (let i = 0; i < n; i++) {
    const h = M._FPDFPage_GetObject(page, i) >>> 0;
    order.set(h, i);
    if (exclude?.has(h)) continue;
    const bx = objectBox(M, h);
    if (!bx) continue;
    const cy = (bx.b + bx.t) / 2;
    if (cy >= lo && cy <= hi) continue;
    edges.push({ h, index: i, bounds: bx, band: cy > hi ? "top" : "bottom" });
  }
  const chars = charsByObject(M, page);
  const items = [];
  let skipped = 0;
  let fixedGraphics = 0;
  for (const e of edges) {
    const at = { index: e.index };
    if (M._FPDFPageObj_GetType(e.h) !== OBJ_TEXT) {
      // Fixed publisher artwork stays on the source page. Only graphics
      // wholly inside the physical edge band may be omitted on the text-
      // only continuation; objects intruding into body space still refuse.
      const b = e.bounds;
      if (!(b.t <= pageH * 0.1 && b.t < floor || b.b >= pageH * 0.9 && b.b > bodyTop)) return fail("continuation_edge_graphics_unsupported", at);
      fixedGraphics++;
      continue;
    }
    // A clone cannot be given the source clip path (no public setter), so a
    // clipped edge would be drawn unclipped. Runtimes without the clip-path
    // getters cannot detect this; see docs/PAGINATION.md, Known risks.
    if (typeof M._FPDFPageObj_GetClipPath === "function" && typeof M._FPDFClipPath_CountPaths === "function") {
      const clip = M._FPDFPageObj_GetClipPath(e.h);
      if (clip && M._FPDFClipPath_CountPaths(clip) > 0) return fail("continuation_edge_clip_unsupported", at);
    }
    const cs = chars.get(e.h) || [];
    const text = textOf(cs);
    if (!text.trim()) {
      skipped++;
      continue;
    }
    const role = classifyEdgeText(text);
    if (role === "number_unsupported") return fail("continuation_page_number_unsupported", at);
    const font = M._FPDFTextObj_GetFont(e.h);
    const size = readFloat(M, "_FPDFTextObj_GetFontSize", e.h);
    const matrix = readMatrix(M, e.h);
    if (!font || !(size > 0) || !matrix) return fail("continuation_edge_text_layout_unsupported", at);
    if (cs.some((c) => c.ox === null || c.l === null)) return fail("continuation_edge_text_layout_unsupported", at);
    const ts = cs.map((c) => toTextSpace(matrix, c.ox, c.oy));
    // Backward steps (positive TJ kerning) are fine: positions are absolute.
    if (ts.some((p) => !p || Math.abs(p.y - ts[0].y) > 0.01)) return fail("continuation_edge_text_layout_unsupported", at);
    const fill = readColor(M, "_FPDFPageObj_GetFillColor", e.h);
    const stroke = readColor(M, "_FPDFPageObj_GetStrokeColor", e.h);
    // Transparency beyond plain colour alpha (blend mode, soft mask) has no
    // public setter, so it cannot be re-created faithfully.
    if (M._FPDFPageObj_HasTransparency(e.h) && (!fill || fill[3] === 255) && (!stroke || stroke[3] === 255)) {
      return fail("continuation_edge_style_unsupported", at);
    }
    if (role === "page_number") {
      // The suffixed number is laid out at natural advances; that matches
      // the source look only if the source digits sit at natural advances.
      for (let k = 1; k < cs.length; k++) {
        const w = readFloat(M, "_FPDFFont_GetGlyphWidth", font, cs[k - 1].u, size);
        if (w === null || Math.abs(ts[k].x - ts[k - 1].x - w) > POS_TOL) return fail("continuation_page_number_spacing_unsupported", at);
      }
    }
    const item = {
      index: e.index,
      role,
      band: e.band,
      text,
      bounds: e.bounds,
      chars: cs.map(({ u, ox, oy, l, b, r, t, ll, lr }) => ({ u, ox, oy, l, b, r, t, ll, lr })),
      style: {
        font: fontInfo(M, font),
        size,
        matrix,
        fill,
        stroke,
        strokeWidth: readFloat(M, "_FPDFPageObj_GetStrokeWidth", e.h),
        renderMode: M._FPDFTextObj_GetTextRenderMode(e.h),
      },
      anchor: role === "page_number" ? anchorOf(inkExtents(cs), pageW) : null,
    };
    // Engine-local fields, not part of the descriptor.
    Object.defineProperty(item, "h", { value: e.h });
    Object.defineProperty(item, "textX", { value: ts.map((p) => p.x) });
    Object.defineProperty(item, "textY", { value: ts[0].y });
    items.push(item);
  }
  const fraction = resolvePageFraction(items);
  if (fraction) for (const item of items) {
    if (item.role === "page_number" && fraction.fixedNumbers.has(item)) item.role = "running";
  }
  const numbers = new Set(items.filter((i) => i.role === "page_number").map((i) => i.text.trim()));
  if (numbers.size > 1) return fail("continuation_page_number_ambiguous");
  const snap = { ok: true, code: null, version: CONTINUATION_STYLE.version, pageW, pageH, floor, bodyTop, skipped, fixedGraphics, items };
  Object.defineProperty(snap, "order", { value: order });
  return snap;
}

// ---------- expected descriptors (pure) ----------

/**
 * expectedPageEdges(snapshot, ordinal) => { ok, code, items }
 * Derived from the source snapshot and the 1-based continuation ordinal
 * only. page_number items carry the source digit chars unshifted: the
 * suffixed number keeps its anchor, so its digits move by one common dx.
 */
export function expectedPageEdges(snapshot, ordinal) {
  if (!snapshot?.ok || !Array.isArray(snapshot.items)) return { ok: false, code: "continuation_edge_snapshot_invalid", items: [] };
  if (!Number.isInteger(ordinal) || ordinal < 1) return { ok: false, code: "continuation_ordinal_invalid", items: [] };
  const items = [];
  for (const it of snapshot.items) {
    const base = { index: it.index, role: it.role, band: it.band, sourceText: it.text, style: it.style, baseline: it.chars[0]?.oy ?? null };
    if (it.role !== "page_number") {
      items.push({ ...base, text: it.text, bounds: it.bounds, anchor: null, chars: it.chars, prefixChars: null, suffix: null });
      continue;
    }
    const text = suffixedText(it.text, ordinal);
    if (text === null) return { ok: false, code: "continuation_page_number_unsupported", items: [] };
    const lead = /^\s*/.exec(it.text)[0].length;
    const digits = it.text.trim().length;
    items.push({ ...base, text, bounds: null, anchor: it.anchor, chars: null, prefixChars: it.chars.slice(lead, lead + digits), suffix: "." + ordinal });
  }
  return { ok: true, code: null, items };
}

/**
 * preflightPageEdges(engine, snapshot, count) => { ok, code, items }
 * Checks that every page-number font can draw "." and the digits of the
 * ordinals 1..count, before any page is created.
 */
export function preflightPageEdges(engine, snapshot, count) {
  const M = engine.M;
  for (const it of snapshot.items) {
    if (it.role !== "page_number") continue;
    const font = M._FPDFTextObj_GetFont(it.h);
    const need = new Set(".");
    for (let k = 1; k <= count; k++) for (const ch of String(k)) need.add(ch);
    for (const ch of need) {
      if (!font || !glyphAvailable(M, font, it.style.size, ch.codePointAt(0))) {
        return { ok: false, code: "continuation_page_number_glyph_missing", items: [], index: it.index, glyph: ch };
      }
    }
  }
  return { ok: true, code: null, items: [] };
}

// ---------- clone ----------

function setText(M, obj, text) {
  if (!text) return false;
  const p = M._malloc((text.length + 1) * 2);
  try {
    for (let i = 0; i < text.length; i++) M.HEAPU16[(p >> 1) + i] = text.charCodeAt(i);
    M.HEAPU16[(p >> 1) + text.length] = 0;
    return !!M._FPDFText_SetText(obj, p);
  } finally {
    M._free(p);
  }
}

function setPositions(M, obj, xs) {
  if (!xs.length) return true;
  const p = M._malloc(xs.length * 4);
  try {
    xs.forEach((v, k) => (M.HEAPF32[(p >> 2) + k] = v));
    return !!M._FPDFText_SetPositions(obj, p, xs.length);
  } finally {
    M._free(p);
  }
}

function cloneItem(engine, it, ordinal) {
  const M = engine.M;
  const font = M._FPDFTextObj_GetFont(it.h);
  if (!font) return null;
  const obj = M._FPDFPageObj_CreateTextObj(engine.doc, font, it.style.size);
  if (!obj) return null;
  const [a, b, c, d, e, f] = it.style.matrix;
  const x0 = it.textX[0], y0 = it.textY;
  const { fill, stroke, strokeWidth, renderMode } = it.style;
  const built =
    (it.role === "page_number"
      ? setText(M, obj, suffixedText(it.text, ordinal))
      : setText(M, obj, it.text) && setPositions(M, obj, it.textX.slice(1).map((x) => x - x0))) &&
    writeMatrix(M, obj, [a, b, c, d, e + x0 * a + y0 * c, f + x0 * b + y0 * d]) &&
    (!fill || !!M._FPDFPageObj_SetFillColor(obj, ...fill)) &&
    (!stroke || !!M._FPDFPageObj_SetStrokeColor(obj, ...stroke)) &&
    (!(strokeWidth > 0) || !!M._FPDFPageObj_SetStrokeWidth(obj, strokeWidth)) &&
    (renderMode < 0 || !!M._FPDFTextObj_SetTextRenderMode(obj, renderMode));
  if (!built) {
    M._FPDFPageObj_Destroy(obj);
    return null;
  }
  return obj >>> 0;
}

function translateX(M, h, dx) {
  const m = readMatrix(M, h);
  if (!m) return false;
  m[4] += dx;
  return writeMatrix(M, h, m);
}

/**
 * applyPageEdges(engine, newPage, snapshot, ordinal, bodyIndex = Infinity)
 *   => { ok, code, items: [{ index, role, h }], before, after, bodyAt }
 * Builds one clone per snapshot item and inserts all of them into newPage:
 * clones whose source index is below bodyIndex first (`before`), then the
 * rest (`after`). The caller generates content once with only the clones
 * (new objects have no content stream; PDFium writes them to stream 0),
 * then inserts moved body objects at `bodyAt` and generates again. Moving
 * source objects (stream index 0) onto a page together with stream-less
 * clones in one generation makes PDFium overwrite the clones' new stream.
 * Page numbers are shifted to keep the source ink anchor.
 */
export function applyPageEdges(engine, newPage, snapshot, ordinal, bodyIndex = Infinity) {
  const M = engine.M;
  const exp = expectedPageEdges(snapshot, ordinal);
  if (!exp.ok) return { ok: false, code: exp.code, items: [] };
  const made = [];
  const abort = (index) => {
    for (const m of made) M._FPDFPageObj_Destroy(m.h);
    return { ok: false, code: "continuation_edge_clone_failed", items: [], index };
  };
  for (const it of snapshot.items) {
    const h = cloneItem(engine, it, ordinal);
    if (!h) return abort(it.index);
    made.push({ index: it.index, role: it.role, h });
    if (it.role === "page_number") {
      // Measure the suffixed number's ink on the new page, then shift it so
      // the source ink anchor is kept.
      M._FPDFPage_InsertObject(newPage, h);
      const ink = inkExtents(charsByObject(M, newPage).get(h) || []);
      if (!M._FPDFPage_RemoveObject(newPage, h) || !ink) return abort(it.index);
      const dx = it.anchor.x - anchorX(it.anchor.anchor, ink);
      if (Math.abs(dx) > 1e-4 && !translateX(M, h, dx)) return abort(it.index);
    }
  }
  const before = made.filter((m) => m.index < bodyIndex).map((m) => m.h);
  const after = made.filter((m) => m.index >= bodyIndex).map((m) => m.h);
  for (const h of [...before, ...after]) M._FPDFPage_InsertObject(newPage, h);
  return { ok: true, code: null, items: made, before, after, bodyAt: before.length };
}

const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;

/**
 * verifyPageEdges(engine, newPage, snapshot, ordinal, applied)
 *   => { ok, code, items: [{ index, role, text, bounds }] }
 * Reads the clones back through FPDFText of newPage and compares them with
 * the source glyphs: same characters; running text at the same origins and
 * boxes; page-number digits moved by one common dx with the source anchor
 * kept and non-degenerate suffix glyphs on the source baseline.
 */
export function verifyPageEdges(engine, newPage, snapshot, ordinal, applied) {
  const M = engine.M;
  const exp = expectedPageEdges(snapshot, ordinal);
  if (!exp.ok) return { ok: false, code: exp.code, items: [] };
  const got = charsByObject(M, newPage);
  const items = [];
  const bad = (index, reason) => ({ ok: false, code: "continuation_edge_clone_mismatch", items, index, reason });
  for (const [k, e] of exp.items.entries()) {
    const h = applied?.items?.[k]?.h;
    const cs = got.get(h) || [];
    if (!h || textOf(cs) !== e.text) return bad(e.index, "text");
    const bounds = objectBox(M, h);
    items.push({ index: e.index, role: e.role, text: e.text, bounds });
    if (e.role !== "page_number") {
      for (const [i, c] of cs.entries()) {
        for (const key of ["ox", "oy", "l", "b", "r", "t"]) if (!near(c[key], e.chars[i][key], POS_TOL)) return bad(e.index, "geometry");
      }
      continue;
    }
    const lead = /^\s*/.exec(e.text)[0].length;
    const digits = e.prefixChars.length;
    const dx = cs[lead].ox - e.prefixChars[0].ox;
    for (let i = 0; i < digits; i++) {
      const c = cs[lead + i], s = e.prefixChars[i];
      for (const key of ["ox", "l", "r"]) if (!near(c[key], s[key] + dx, POS_TOL)) return bad(e.index, "digits");
      for (const key of ["oy", "b", "t"]) if (!near(c[key], s[key], POS_TOL)) return bad(e.index, "digits");
    }
    for (let i = lead + digits; i < lead + digits + e.suffix.length; i++) {
      const c = cs[i];
      if (!(c.r - c.l > 0.01 && c.t - c.b > 0.01) || !near(c.oy, e.prefixChars[0].oy, POS_TOL)) return bad(e.index, "suffix_glyph");
    }
    const ink = inkExtents(cs);
    if (!bounds || !ink || !near(anchorX(e.anchor.anchor, ink), e.anchor.x, ANCHOR_TOL)) return bad(e.index, "anchor");
  }
  return { ok: true, code: null, items };
}
