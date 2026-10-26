// Source-preserving inline edits.
//
// Two decisions the plain run rebuild left to chance:
// - which characters an edit really changes, and which source run style the
//   replacement inherits (unchanged tokens keep their own run and style);
// - where untouched source lines end up when the engine cannot splice a
//   paragraph and re-lays it out instead (non-surgical commit).
// Neither relaxes matching: the caller has already matched Before exactly
// once; this module only narrows the mutation inside that match.

const WS = /^\s+$/;
const tokens = (s) => s.match(/\s+|\S+/g) || [];
const isWs = (c) => /\s/.test(c.ch);
const nfc = (t) => t.normalize("NFC");
const STYLE_KEYS = ["family", "bold", "italic", "size", "rgba", "underline", "strike", "script", "renderMode", "strokeRgba", "strokeWidth", "hScale", "rise"];

export const runStyleKey = (r) => STYLE_KEYS.map((k) => String(k === "rgba" || k === "strokeRgba" ? (r?.[k] ?? 0) >>> 0 : r?.[k] ?? "")).join("|");

/**
 * Narrows one matched edit to its changed tokens.
 * chars/map: page character index and normalized map; hit: normalized
 * offset of the single match; needle: normalized Before.
 * Returns { del: chars[], inserts: [{ pi, ri, o, text }], warning? } or
 * { failure: "AMBIGUOUS_STYLE" } when no run style can be justified for the
 * replacement. A whitespace token of After equals the source whitespace it
 * faces only when it is a single plain space or the same characters.
 */
export function planInlineChange(paras, chars, map, hit, needle, after) {
  const bt = [];
  let k = 0;
  for (const t of tokens(needle)) {
    bt.push({ t, k0: k, k1: k + t.length });
    k += t.length;
  }
  const at = tokens(after);
  const rawOf = (tok) => chars.slice(map[hit + tok.k0][0], map[hit + tok.k1 - 1][1] + 1);
  const same = (b, a) => (WS.test(b.t) ? WS.test(a) && (a === " " || a === rawOf(b).map((c) => c.ch).join("")) : a === b.t);
  let p = 0;
  while (p < bt.length && p < at.length && same(bt[p], at[p])) p++;
  let s = 0;
  while (s < bt.length - p && s < at.length - p && same(bt[bt.length - 1 - s], at[at.length - 1 - s])) s++;
  const D = bt.slice(p, bt.length - s);
  const X = at.slice(p, at.length - s);
  const text = X.join("");
  const del = D.flatMap(rawOf).filter((c) => c.pi >= 0);
  if (!text) return { del, inserts: [] };
  const style = (c) => runStyleKey(paras[c.pi].runs[c.ri]);
  const place = (c, text, after = false) => ({ pi: c.pi, ri: c.ri, o: c.o + (after ? 1 : 0), text });
  const words = del.filter((c) => !isWs(c));

  if (words.length) {
    const styles = new Set(words.map(style));
    const paraSet = new Set(del.map((c) => c.pi));
    if (paraSet.size > 1) {
      // Paragraph merge: After goes into the last touched paragraph, as before.
      const lastPi = Math.max(...paraSet);
      const anchor = del.find((c) => c.pi === lastPi);
      return { del, inserts: [place(anchor, text)], warning: styles.size > 1 ? "style_inherited_across_paragraphs" : undefined };
    }
    if (styles.size === 1) return { del, inserts: [place(words[0], text)] };
    // Several styles replaced: map word to word when the token shape agrees.
    if (D.length !== X.length) return { failure: "AMBIGUOUS_STYLE" };
    // A changed After word that spells a source word of the match in another
    // style may be that word moved (then bold -> bold then): its position
    // alone justifies neither style.
    const sourceStyles = new Map();
    for (const b of bt) {
      if (WS.test(b.t)) continue;
      const set = sourceStyles.get(nfc(b.t)) ?? new Set();
      for (const c of rawOf(b)) if (c.pi >= 0) set.add(style(c));
      sourceStyles.set(nfc(b.t), set);
    }
    const keep = new Set();
    const inserts = [];
    for (let i = 0; i < D.length; i++) {
      const d = D[i], x = X[i];
      if (WS.test(d.t) !== WS.test(x)) return { failure: "AMBIGUOUS_STYLE" };
      if (WS.test(d.t)) {
        if (!same(d, x)) return { failure: "AMBIGUOUS_STYLE" };
        for (const c of rawOf(d)) keep.add(c);
        continue;
      }
      const w = rawOf(d).filter((c) => c.pi >= 0);
      if (new Set(w.map(style)).size !== 1) return { failure: "AMBIGUOUS_STYLE" };
      if (x === d.t) {
        for (const c of w) keep.add(c);
        continue;
      }
      if ([...(sourceStyles.get(nfc(x)) ?? [])].some((k) => k !== style(w[0]))) return { failure: "AMBIGUOUS_STYLE" };
      inserts.push(place(w[0], x));
    }
    return { del: del.filter((c) => !keep.has(c)), inserts };
  }

  // Pure insertion, or only whitespace replaced: inherit from the
  // neighbouring words inside the match; differing styles are ambiguous.
  const left = bt.slice(0, p).flatMap(rawOf);
  const right = bt.slice(bt.length - s).flatMap(rawOf);
  const leftWord = left.filter((c) => c.pi >= 0 && !isWs(c)).at(-1);
  const rightWord = right.find((c) => c.pi >= 0 && !isWs(c));
  const lk = leftWord && style(leftWord), rk = rightWord && style(rightWord);
  if (lk && rk && lk !== rk) return { failure: "AMBIGUOUS_STYLE" };
  const viaLeft = left.length && left.at(-1).pi >= 0 ? place(left.at(-1), text, true) : null;
  const viaRight = right.length && right[0].pi >= 0 ? place(right[0], text) : null;
  const want = lk || rk;
  if (!want) {
    // No word evidence: inherit from the replaced whitespace run if unique.
    if (del.length && new Set(del.map(style)).size === 1) return { del, inserts: [place(del[0], text)] };
    return { failure: "AMBIGUOUS_STYLE" };
  }
  const ins = [rk ? viaRight : null, lk ? viaLeft : null, viaRight, viaLeft].find((c) => c && style(c) === want);
  return ins ? { del, inserts: [ins] } : { failure: "AMBIGUOUS_STYLE" };
}

// ---------- source line retention ----------

/**
 * Source line plan for one paragraph mutation: the soft line breaks to turn
 * into hard breaks so a re-laid-out paragraph keeps its source lines, and
 * the lines the edit touches. null when the engine model has no line
 * geometry; { reason } when the source lines cannot be kept without
 * changing text (break inside a word, edited break).
 */
export function sourceLinePlan(para, del, inserts) {
  const lines = para.lines || [];
  if (!lines.length || lines.some((l) => !Number.isFinite(l?.y) || !Number.isFinite(l?.x) || !Number.isInteger(l?.off))) return null;
  const runStart = [];
  const flat = [];
  para.runs.forEach((r, ri) => {
    runStart.push(flat.length);
    for (let o = 0; o < r.text.length; o++) flat.push({ ri, o, ch: r.text[o] });
  });
  const starts = lines.map((l) => l.off);
  for (let k = 1; k < starts.length; k++) if (!(starts[k] > starts[k - 1]) || starts[k] > flat.length) return { reason: "line_offsets_invalid" };
  const lineOf = (f) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= f) k++;
    return k;
  };
  const breaks = new Set();
  for (let k = 1; k < starts.length; k++) {
    const c = flat[starts[k] - 1];
    if (c.ch === "\n") continue;
    if (!/\s/.test(c.ch)) return { reason: "break_inside_word" };
    if (del.has(c.ri + ":" + c.o)) return { reason: "edit_crosses_line" };
    breaks.add(c.ri + ":" + c.o);
  }
  const edited = new Set();
  for (const key of del) {
    const [ri, o] = key.split(":").map(Number);
    edited.add(lineOf(runStart[ri] + o));
  }
  for (const ins of inserts) {
    const f = runStart[ins.ri] + ins.o;
    edited.add(lineOf(f));
    if (f > 0) edited.add(lineOf(f - 1));
  }
  return { breaks, edited };
}

const ENGINE_FNS = ["previewParagraph", "historyBeginStep", "historyEndStep", "historyUndo", "paragraphObjects", "objectBounds", "translateObject"];
const TEXT_FNS = ["_FPDFPage_CountObjects", "_FPDFPage_GetObject", "_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetCharOrigin", "_FPDFText_GetTextObject", "_FPDFText_GetFontSize", "_FPDFText_GetFontInfo", "_FPDFText_ClosePage"];

// Whether the engine exposes what line retention needs: undoable commits,
// object geometry and per-glyph text-page reads for the kept-line proof.
export function canRetainLines(engine) {
  return ENGINE_FNS.every((f) => typeof engine?.[f] === "function") && TEXT_FNS.every((f) => typeof engine?.M?.[f] === "function");
}

// Glyph origins, font and size of the given text objects, grouped by the
// nearest of the given baselines and sorted by x; aspect is the horizontal
// scale of the glyph matrix relative to its vertical scale (microtype font
// expansion, Tz), so a uniform page CTM cancels out, and null when the
// runtime gives no matrix or the glyph is not upright and unsheared; h is
// the text object holding the glyph.
function lineGlyphs(engine, handles, lines) {
  const M = engine.M;
  const own = new Set(handles.map((h) => h >>> 0));
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const buf = M._malloc(192);
  const matrix = typeof M._FPDFText_GetMatrix === "function";
  const out = lines.map(() => []);
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
    if (u <= 32 || !own.has(h)) continue;
    if (!M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
    const x = M.HEAPF64[buf >> 3], y = M.HEAPF64[(buf + 8) >> 3];
    const len = M._FPDFText_GetFontInfo(tp, i, buf + 16, 128, buf + 144);
    const font = len > 0 && len <= 128 ? M.UTF8ToString(buf + 16, 128) : null;
    const size = M._FPDFText_GetFontSize(tp, i);
    let aspect = null;
    if (matrix && M._FPDFText_GetMatrix(tp, i, buf + 160)) {
      const [a, b, c, d] = [0, 1, 2, 3].map((j) => M.HEAPF32[((buf + 160) >> 2) + j]);
      if (a > 0 && d > 0 && Math.abs(b) <= ASPECT_TOL * d && Math.abs(c) <= ASPECT_TOL * d) aspect = a / d;
    }
    let k = -1, best = Infinity;
    lines.forEach((l, j) => {
      const d = Math.abs(l.y - y);
      if (d < best) [k, best] = [j, d];
    });
    if (k >= 0 && best <= Math.max(0.5, 0.3 * size)) out[k].push({ u, x, y, font, size, aspect, h });
  }
  M._free(buf);
  if (tp) M._FPDFText_ClosePage(tp);
  for (const g of out) g.sort((a, b) => a.x - b.x);
  return out;
}

// Moves each committed line onto its source baseline; kept lines also onto
// their source x. Returns false when an object cannot be tied to one line.
function alignLines(engine, id, committed, source, edited) {
  const groups = committed.map(() => []);
  for (const h of (engine.paragraphObjects(id) || []).map((x) => x >>> 0)) {
    const b = engine.objectBounds(h);
    if (!b) return false;
    const hits = committed.map((l, k) => (l.y >= b.y - 0.5 && l.y <= b.y + b.h + 0.5 ? k : -1)).filter((k) => k >= 0);
    if (hits.length !== 1) return false;
    groups[hits[0]].push(h);
  }
  committed.forEach((l, k) => {
    const dx = edited.has(k) ? 0 : source[k].x - l.x;
    const dy = source[k].y - l.y;
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return;
    for (const h of groups[k]) engine.translateObject(h, dx, dy);
  });
  return true;
}

export const KEPT_LINE_TOL = 0.02;
// Glyph aspect (horizontal over vertical matrix scale) a line-local line
// must keep; also the shear allowed relative to the vertical scale.
export const ASPECT_TOL = 1e-3;

// Kept lines must show the same glyphs, fonts and sizes at the source
// origins; edited lines must sit on their source baseline.
function keptLinesMatch(before, after, edited, source) {
  let max = 0;
  for (let k = 0; k < before.length; k++) {
    const a = after[k];
    if (edited.has(k)) {
      if (a.some((g) => Math.abs(g.y - source[k].y) > KEPT_LINE_TOL)) return { ok: false };
      continue;
    }
    const b = before[k];
    if (!b.length || a.length !== b.length) return { ok: false };
    for (let i = 0; i < b.length; i++) {
      const d = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
      if (a[i].u !== b[i].u || a[i].font !== b[i].font || Math.abs(a[i].size - b[i].size) > 0.01 || d > KEPT_LINE_TOL) return { ok: false };
      max = Math.max(max, d);
    }
  }
  return { ok: true, max };
}

// Page object handles in page order, and the handles of one paragraph: an
// undo must give back exactly these, so paragraph ids and the captured
// layout context stay valid without rebuilding the model.
function objectState(engine, id) {
  const M = engine.M;
  const page = [];
  const n = M._FPDFPage_CountObjects(engine.page);
  for (let i = 0; i < n; i++) page.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return page.join(",") + "|" + (engine.paragraphObjects(id) || []).map((h) => h >>> 0).join(",");
}

export class LineRetentionError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/**
 * Commits one paragraph. A surgical engine commit is kept as is. When the
 * engine re-lays the paragraph out instead and the edit fits its source
 * lines, the commit is redone with the source soft breaks as hard breaks
 * (linePlan.lineRuns), every line is moved back onto its source baseline and
 * kept lines are proven glyph for glyph against the source. If any step does
 * not hold, the plain engine re-layout is restored and reported.
 * Returns { upd, lines }: lines is null (nothing to report) or
 * { status: "surgical" | "retained" | "reflowed", reason?, ... }.
 * A reflow keeping the source line count is never reported as
 * line_count_changed: when the edited line alone overflows its source line,
 * the reason is edited_line_overflows.
 * Throws LineRetentionError when the undone state cannot be re-verified.
 */
export function commitRetainingLines(engine, para, runs, linePlan) {
  const source = para.lines || [];
  const sameCount = (u) => (u?.lines?.length ?? -1) === source.length;
  if (!linePlan?.breaks || !canRetainLines(engine)) {
    const upd = engine.commitParagraph(para.id, runs, para.format);
    if (!linePlan || !upd || upd.surgical || !sameCount(upd)) return { upd, lines: null };
    return { upd, lines: { status: "reflowed", reason: linePlan.reason ?? "engine_capability_missing" } };
  }
  const { breaks, edited, lineRuns } = linePlan;
  const step = (id, r) => {
    engine.historyBeginStep("falsify-inline-edit");
    try {
      return engine.commitParagraph(id, r, para.format);
    } finally {
      engine.historyEndStep();
    }
  };
  const state = objectState(engine, para.id);
  const undo = () => {
    if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    if (objectState(engine, para.id) !== state) throw new LineRetentionError("state_drift");
    return para.id;
  };
  const fits = breaks.size ? engine.previewParagraph(para.id, lineRuns, para.format)?.lines?.length === source.length : true;
  const before = lineGlyphs(engine, engine.paragraphObjects(para.id) || [], source);
  const upd = step(para.id, runs);
  if (!upd || upd.surgical) return { upd, lines: upd ? { status: "surgical" } : null };
  if (!fits || (!breaks.size && !sameCount(upd))) return { upd, lines: { status: "reflowed", reason: sameCount(upd) ? "edited_line_overflows" : "line_count_changed" } };
  let cur = upd;
  if (breaks.size) {
    cur = step(undo(), lineRuns);
    if (!cur) throw new LineRetentionError("commit_failed");
  }
  let reason = null;
  if (sameCount(cur)) {
    reason = "lines_not_aligned";
    const id = cur.id ?? para.id;
    if (alignLines(engine, id, cur.lines, source, edited)) {
      const proof = keptLinesMatch(before, lineGlyphs(engine, engine.paragraphObjects(id) || [], source), edited, source);
      if (proof.ok) return { upd: cur, lines: { status: "retained", lines: source.length, kept: source.length - edited.size, hardBreaks: breaks.size, maxKeptShift: +proof.max.toFixed(4) } };
      reason = "kept_lines_moved";
    }
  }
  // Restore the plain engine re-layout of the edit.
  const again = step(undo(), runs);
  reason ??= sameCount(again) ? "edited_line_overflows" : "line_count_changed";
  return { upd: again, lines: again ? { status: "reflowed", reason } : null };
}

// ---------- line-local commit ----------
//
// The engine never splices a justified paragraph surgically, and its
// re-layout gives every line one size and one word spacing: microtype
// per-line font expansion, justified spacing and the source glyph positions
// of untouched lines are lost, so the kept-line proof above cannot hold.
// When the edit stays inside one source line, only that line is re-laid
// out: its objects are moved off the page so the engine models them as a
// one-line paragraph, the edit is committed there with the line's own
// horizontal glyph scale relative to its vertical one (a justified line also
// gets the word spacing that restores its source width), and the new line is
// put back on its source baseline, at its source x and at its source place
// in the page object order. No other object of the paragraph is touched,
// which is proven glyph for glyph, and every glyph of the new line must show
// the source line's aspect. Any step that does not hold is undone.

const LOCAL_FNS = ["historyNoteMatrix", "historyNoteZOrder", "historyDepth", "buildModel", "resizeParagraph"];
const LOCAL_M = ["_FPDFPage_RemoveObject", "_FPDFPage_InsertObjectAtIndex", "_FPDFPageObj_GetType", "_FPDFText_GetMatrix"];
// Interword space a re-justified line may end with, in font sizes.
export const LOCAL_JUSTIFY = Object.freeze({ min: 0.12, max: 0.6 });
const WIDTH_TOL = 0.1;
const PLACE_TOL = 0.1;
const OBJ_TEXT = 1;

export function canCommitLineLocal(engine) {
  return canRetainLines(engine) && LOCAL_FNS.every((f) => typeof engine?.[f] === "function") && LOCAL_M.every((f) => typeof engine?.M?.[f] === "function");
}

export function pageObjectList(engine) {
  const M = engine.M;
  const out = [];
  const n = M._FPDFPage_CountObjects(engine.page);
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return out;
}

const textOf = (p) => p.runs.map((r) => r.text).join("");
const squash = (s) => s.replace(/\s+/g, " ").trim();
// Run style without the horizontal scale: a one-line model may carry the
// line's expansion that the whole-paragraph model averaged away.
const baseStyle = (r) => runStyleKey({ ...r, hScale: 1 });
const paraKey = (p) => (p.box ? [p.box.x, p.box.top, p.box.w, p.box.h].map((v) => Math.round(v * 100)).join(",") : "-") + "|" + textOf(p);

/**
 * The one source line an edit changes: { k, start, end } as character
 * offsets of the paragraph text, end before the line's trailing whitespace.
 * null without line geometry; { reason } when the edit touches more than one
 * line or the line break itself (an insertion at a line start also touches
 * the end of the previous line).
 */
export function editedLineSpan(para, del, inserts) {
  const lines = para.lines || [];
  if (!lines.length || lines.some((l) => !Number.isFinite(l?.y) || !Number.isFinite(l?.x) || !Number.isFinite(l?.w) || !Number.isInteger(l?.off))) return null;
  const runStart = [];
  let n = 0;
  for (const r of para.runs) {
    runStart.push(n);
    n += r.text.length;
  }
  const starts = lines.map((l) => l.off);
  if (starts[0] !== 0) return { reason: "line_offsets_invalid" };
  for (let k = 1; k < starts.length; k++) if (!(starts[k] > starts[k - 1]) || starts[k] > n) return { reason: "line_offsets_invalid" };
  const lineOf = (f) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= f) k++;
    return k;
  };
  const delAt = [...del].map((key) => {
    const [ri, o] = key.split(":").map(Number);
    return runStart[ri] + o;
  });
  const insAt = inserts.map((ins) => runStart[ins.ri] + ins.o);
  const touched = new Set(delAt.map(lineOf));
  for (const f of insAt) {
    touched.add(lineOf(f));
    if (f > 0) touched.add(lineOf(f - 1));
  }
  if (touched.size !== 1) return { reason: "edit_spans_lines" };
  const [k] = touched;
  const flat = textOf(para);
  const start = starts[k];
  let end = k + 1 < starts.length ? starts[k + 1] : n;
  while (end > start && /\s/.test(flat[end - 1])) end--;
  if (end === start || delAt.some((f) => f >= end) || insAt.some((f) => f > end)) return { reason: "edit_crosses_line" };
  return { k, start, end };
}

// The edited line as runs of the isolated one-line paragraph q: para runs
// cut to [start, end], with the edit applied, each taking its style (and
// sourceIndex, for the source font) from the q run holding the same text.
function lineRuns(para, q, span, del, inserts, scale) {
  const { start, end } = span;
  const qRun = [];
  q.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) qRun.push(ri);
  });
  const runs = [];
  let r0 = 0;
  para.runs.forEach((r, ri) => {
    let t = "";
    let first = -1;
    for (let o = 0; o <= r.text.length; o++) {
      const f = r0 + o;
      if (f < start || f > end) continue;
      for (const ins of inserts) if (ins.ri === ri && ins.o === o) t += ins.text;
      if (o < r.text.length && f < end) {
        if (first < 0) first = f;
        if (!del.has(ri + ":" + o)) t += r.text[o];
      }
    }
    const at = first >= 0 ? first : Math.min(r0 + r.text.length, end) - 1;
    r0 += r.text.length;
    if (!t) return;
    const qi = qRun[Math.min(Math.max(at - start, 0), qRun.length - 1)];
    const src = q.runs[qi];
    const hScale = Math.abs((src.hScale ?? 1) - 1) < 1e-3 ? scale : src.hScale;
    runs.push({ ...src, text: t, rgba: src.rgba >>> 0, sourceIndex: qi, hScale });
  });
  return runs;
}

/**
 * Re-lays out only the edited source line of paragraph paras[pi] (see
 * above). paras is the page model before the page was edited; changed lists
 * the indices of paragraphs already edited since. Returns
 * { upd, lines: { status: "line_local", ... }, ids } where ids are the
 * paragraph ids of the rebuilt page model in the order of paras, or
 * { reason } with the page objects and the page model as before.
 * Throws LineRetentionError when an undone attempt cannot be re-verified.
 */
export function commitLineLocal(engine, paras, pi, del, inserts, changed = new Set()) {
  if (!canCommitLineLocal(engine)) return { reason: "engine_capability_missing" };
  const para = paras[pi];
  const fmt = para.format || {};
  if (![0, 3].includes(fmt.align ?? 0) || fmt.dir || para.rotation || para.vertical) return { reason: "alignment_unsupported" };
  const span = editedLineSpan(para, del, inserts);
  if (!span || span.reason) return { reason: span?.reason ?? "line_geometry_missing" };
  const { k, start, end } = span;
  const source = para.lines;
  const M = engine.M;

  const handles = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
  const before = lineGlyphs(engine, handles, source);
  if (!before[k].length) return { reason: "line_objects_unresolved" };
  const linesOf = new Map();
  before.forEach((g, j) => g.forEach((c) => linesOf.set(c.h, (linesOf.get(c.h) || new Set()).add(j))));
  // Objects with no glyph on a line (link underlines, rules, stray marks)
  // stay where they are, so none may sit in the band of the edited line.
  const em = Math.max(...before[k].map((c) => c.size));
  const band = { lo: source[k].y - 0.4 * em, hi: source[k].y + em };
  const own = [];
  for (const h of handles) {
    const on = linesOf.get(h);
    if (on) {
      if (!on.has(k)) continue;
      if (on.size !== 1 || M._FPDFPageObj_GetType(h) !== OBJ_TEXT) return { reason: "line_objects_unresolved" };
      own.push(h);
      continue;
    }
    const b = engine.objectBounds(h);
    if (!b) return { reason: "line_objects_unresolved" };
    if (b.y <= band.hi && b.y + b.h >= band.lo) return { reason: "line_decoration_present" };
  }
  const pageBefore = pageObjectList(engine);
  const slots = own.map((h) => pageBefore.indexOf(h)).sort((a, b) => a - b);
  if (!own.length || slots[0] < 0 || slots.some((s, i) => s !== slots[0] + i)) return { reason: "line_objects_interleaved" };
  const anchor = slots[0] > 0 ? pageBefore[slots[0] - 1] : null;
  const ownSet = new Set(own);
  const ownBounds = own.map((h) => JSON.stringify(engine.objectBounds(h)));
  // The line's horizontal scale, not the raw matrix a: that also holds any
  // uniform page CTM, which the engine does not re-apply to new objects.
  const scales = before[k].map((g) => g.aspect);
  if (!scales.length || !scales.every(Number.isFinite)) return { reason: "line_aspect_unsupported" };
  const scale = [...scales].sort((a, b) => a - b)[scales.length >> 1];
  if (scales.some((v) => Math.abs(v - scale) > ASPECT_TOL)) return { reason: "line_aspect_mixed" };

  let steps = 0;
  const step = (label, fn) => {
    const depth = engine.historyDepth().undo;
    engine.historyBeginStep(label);
    try {
      return fn();
    } finally {
      engine.historyEndStep();
      if (engine.historyDepth().undo > depth) steps++;
    }
  };
  // Undo every recorded step; the history restores the page model with it.
  const restore = (reason) => {
    for (; steps > 0; steps--) if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    const back = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
    if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "page_objects" });
    if (back.join(",") !== handles.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_objects" });
    if (own.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== ownBounds[i])) throw new LineRetentionError("state_drift", { after: reason, part: "line_bounds" });
    return { reason };
  };

  const top = Math.max(...own.map((h) => {
    const b = engine.objectBounds(h);
    return b.y + b.h;
  }));
  const away = -(top + 200);
  step("falsify-line-isolate", () => {
    for (const h of own) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, 0, away);
    }
  });
  if (steps !== 1) {
    for (const h of own) engine.translateObject(h, 0, -away);
    return restore("history_unavailable");
  }
  const iso = engine.buildModel();
  // The undo steps refer to object handles; a model build that re-created
  // page objects leaves them pointing elsewhere, so nothing can be undone.
  if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: "line_isolate", part: "page_objects_rebuilt" });
  const mine = iso.filter((q) => (engine.paragraphObjects(q.id) || []).some((h) => ownSet.has(h >>> 0)));
  if (mine.length !== 1) return restore("line_not_isolated");
  const q = mine[0];
  const qh = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
  if (qh.length !== own.length || qh.some((h) => !ownSet.has(h)) || !q.editable || q.lines?.length !== 1) return restore("line_not_isolated");
  const flat = textOf(para);
  const lineText = flat.slice(start, end);
  if (textOf(q).replace(/\s+$/, "") !== lineText) return restore("isolated_text_mismatch");
  const pRun = [];
  para.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) pRun.push(ri);
  });
  const qRun = [];
  q.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) qRun.push(ri);
  });
  for (let j = 0; j < lineText.length; j++) {
    if (baseStyle(q.runs[qRun[j]]) !== baseStyle(para.runs[pRun[start + j]])) return restore("isolated_style_mismatch");
  }

  const runs = lineRuns(para, q, span, del, inserts, scale);
  const newLine = runs.map((r) => r.text).join("");
  const right = Math.max(...source.map((l) => l.x + l.w), para.box ? para.box.x + para.box.w : -Infinity);
  const justify = fmt.align === 3 && k < source.length - 1 && source[k].x + source[k].w >= Math.max(...source.map((l) => l.x + l.w)) - 1;
  const target = justify ? source[k].w : right - source[k].x;
  let id = q.id;
  if (!(q.box?.w >= target + 1)) {
    const rz = step("falsify-line-width", () => engine.resizeParagraph(id, target + 2));
    if (!rz) return restore("line_not_isolated");
    id = rz.id ?? id;
  }
  const qfmt = { ...q.format, align: 0, wordSpacing: 0 };
  if (engine.previewParagraph(id, runs, qfmt)?.lines?.length !== 1) return restore("edited_line_wraps");
  // A preview gives no line width, so the line is measured by committing it;
  // a re-justification undoes that commit and commits again.
  const commit = (ws) => {
    const u = step("falsify-line-local", () => engine.commitParagraph(id, runs, { ...qfmt, wordSpacing: ws }));
    return u?.lines?.length === 1 && ["x", "y", "w"].every((f) => Number.isFinite(u.lines[0][f])) ? u : null;
  };
  const recommit = (ws) => {
    if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    steps--;
    return commit(ws);
  };
  let upd = commit(0);
  if (!upd) return restore("edited_line_wraps");
  const w0 = upd.lines[0].w;
  const spaces = (newLine.match(/ /g) || []).length;
  const size = Math.max(...runs.map((r) => r.size || 0)) || 10;
  let ws = 0;
  let justified = false;
  if (justify && spaces) {
    // Already wider than the source line with no extra word spacing: squeezing
    // it with a negative word spacing would change the source font. That is
    // an overflow, so the prefix-preserving suffix reflow can run.
    if (w0 > target + WIDTH_TOL) return restore("edited_line_too_wide");
    // The engine adds the word spacing to each space before the run's
    // horizontal scale, and measures spaces by the font (not the source
    // advance) once a word spacing is set: secant steps of slope
    // spaces * scale from the unspaced width.
    const slope = spaces * scale;
    ws = (target - w0) / slope || 1e-3;
    for (let i = 0; i < 3; i++) {
      upd = recommit(ws);
      if (!upd || Math.abs(upd.lines[0].w - target) <= WIDTH_TOL) break;
      ws += (target - upd.lines[0].w) / slope;
    }
    if (!upd || Math.abs(upd.lines[0].w - target) > WIDTH_TOL) return restore("justification_unverified");
    // Each space as laid out, from the character offsets of a preview.
    const cx = engine.previewParagraph(upd.id ?? id, runs, { ...qfmt, wordSpacing: ws })?.lines?.[0]?.cx;
    if (!Array.isArray(cx) || cx.length < newLine.length) return restore("justification_unverified");
    for (let j = 0; j + 1 < newLine.length; j++) {
      if (newLine[j] !== " ") continue;
      const gap = cx[j + 1] - cx[j];
      // A collapsed or too-tight space means the edited line does not fit.
      // A gap above the justify range is a short line, not an overflow.
      if (!(gap >= LOCAL_JUSTIFY.min * size && gap <= LOCAL_JUSTIFY.max * size)) return restore(gap <= LOCAL_JUSTIFY.min * size ? "edited_line_too_wide" : "justification_out_of_range");
    }
    justified = true;
  } else if (w0 > target + WIDTH_TOL) {
    return restore("edited_line_too_wide");
  }

  const fresh = (engine.paragraphObjects(upd.id ?? id) || []).map((h) => h >>> 0);
  if (!fresh.length) return restore("line_objects_unresolved");
  const dx = source[k].x - upd.lines[0].x;
  const dy = source[k].y - upd.lines[0].y;
  let placed = true;
  step("falsify-line-place", () => {
    for (const h of fresh) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, dx, dy);
    }
    // Back into the source slot of the line, so the text order of the
    // paragraph does not depend on where the engine appended its objects.
    const cur = pageObjectList(engine);
    let at = anchor === null ? 0 : cur.indexOf(anchor) + 1;
    if (anchor !== null && at === 0) placed = false;
    for (const h of [...fresh].sort((a, b) => cur.indexOf(a) - cur.indexOf(b))) {
      if (!placed) break;
      engine.historyNoteZOrder(h);
      if (!M._FPDFPage_RemoveObject(engine.page, h)) placed = false;
      else if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, at++)) {
        M._FPDFPage_InsertObject?.(engine.page, h);
        placed = false;
      }
    }
  });
  if (!placed) return restore("line_order_not_restored");

  const after = engine.buildModel();
  if (after.length !== paras.length || after.some((p, j) => j !== pi && !changed.has(j) && paraKey(p) !== paraKey(paras[j]))) return restore("page_model_changed");
  const now = after[pi];
  if (squash(textOf(now)) !== squash(flat.slice(0, start) + newLine + flat.slice(end))) return restore("edited_text_mismatch");
  if (now.lines?.length !== source.length) return restore("line_count_changed");
  const nowHandles = (engine.paragraphObjects(now.id) || []).map((h) => h >>> 0);
  const want = new Set([...handles.filter((h) => !ownSet.has(h)), ...fresh]);
  if (nowHandles.length !== want.size || nowHandles.some((h) => !want.has(h))) return restore("paragraph_objects_changed");
  const got = lineGlyphs(engine, nowHandles, source);
  const proof = keptLinesMatch(before, got, new Set([k]), source);
  if (!proof.ok) return restore("kept_lines_moved");
  if (!got[k].length || got[k].some((g) => !Number.isFinite(g.aspect) || Math.abs(g.aspect - scale) > ASPECT_TOL)) return restore("edited_line_aspect_changed");
  const line = now.lines[k];
  if (Math.abs(line.x - source[k].x) > PLACE_TOL || line.x + line.w > right + 0.5) return restore("edited_line_misplaced");
  if (justified && Math.abs(line.x + line.w - (source[k].x + source[k].w)) > 0.5) return restore("justification_unverified");
  return {
    upd: { ...now, surgical: false },
    ids: after.map((p) => p.id),
    lines: {
      status: "line_local",
      line: k,
      lines: source.length,
      kept: source.length - 1,
      justified,
      wordSpacing: +ws.toFixed(4),
      hScale: +scale.toFixed(4),
      maxKeptShift: +proof.max.toFixed(4),
    },
  };
}

// An edit that stays on one source line but does not fit that line. The
// line-local commit refuses these; the prefix commit below is the next try.
const OVERFLOW_REASONS = new Set(["edited_line_wraps", "edited_line_too_wide"]);

function sliceRuns(runs, from) {
  const out = [];
  let n = 0;
  for (const r of runs) {
    const a = Math.max(0, from - n);
    n += r.text.length;
    if (a >= r.text.length) continue;
    const text = r.text.slice(a);
    if (text) out.push({ ...r, text });
  }
  return out;
}

const lettersOf = (s) => s.replace(/\s+/g, "");
// Physical type size: Tf times the upright text-matrix vertical scale.
// A source glyph may be Tf 1 with matrix d 9.5, and a committed glyph Tf 9.5
// with d 1. Without a finite upright matrix there is no physical size to
// compare, so the caller declines instead of using raw Tf.
const DRAWN_TOL = 0.02;
const drawnSize = (g) => {
  if (!Number.isFinite(g?.size) || !(g.size > 0)) return null;
  if (!Number.isFinite(g?.vd) || !(g.vd > 0)) return null;
  if (!Number.isFinite(g?.aspect)) return null;
  return g.size * g.vd;
};

// Glyphs of these text objects, including U+0020, sorted so a prefix can be
// compared object-for-object. Spaces are the signal a rebuilt line invented
// a word break the source text object did not have.
function collectGlyphs(engine, handles) {
  const M = engine.M;
  const own = new Set(handles.map((h) => h >>> 0));
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const buf = M._malloc(192);
  const matrix = typeof M._FPDFText_GetMatrix === "function";
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
    if (u < 32 || !own.has(h)) continue;
    if (!M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
    const x = M.HEAPF64[buf >> 3], y = M.HEAPF64[(buf + 8) >> 3];
    const len = M._FPDFText_GetFontInfo(tp, i, buf + 16, 128, buf + 144);
    const font = len > 0 && len <= 128 ? M.UTF8ToString(buf + 16, 128) : null;
    const size = M._FPDFText_GetFontSize(tp, i);
    let aspect = null;
    let vd = null;
    if (matrix && M._FPDFText_GetMatrix(tp, i, buf + 160)) {
      const [a, b, c, d] = [0, 1, 2, 3].map((j) => M.HEAPF32[((buf + 160) >> 2) + j]);
      vd = d;
      if (a > 0 && d > 0 && Math.abs(b) <= ASPECT_TOL * d && Math.abs(c) <= ASPECT_TOL * d) aspect = a / d;
    }
    out.push({ u, x, y, font, size, aspect, vd, h });
  }
  M._free(buf);
  if (tp) M._FPDFText_ClosePage(tp);
  out.sort((a, b) => a.y - b.y || a.x - b.x || a.u - b.u || a.h - b.h);
  return out;
}

function sameGlyphs(a, b) {
  if (a.length !== b.length) return { ok: false, max: Infinity };
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
    max = Math.max(max, d);
    if (a[i].u !== b[i].u || a[i].h !== b[i].h || a[i].font !== b[i].font || Math.abs(a[i].size - b[i].size) > 0.01 || d > KEPT_LINE_TOL) return { ok: false, max };
    const aspect = Number.isFinite(a[i].aspect) || Number.isFinite(b[i].aspect);
    if (aspect && !(Number.isFinite(a[i].aspect) && Number.isFinite(b[i].aspect) && Math.abs(a[i].aspect - b[i].aspect) <= ASPECT_TOL)) return { ok: false, max };
  }
  return { ok: true, max };
}

/**
 * Re-lays out the edited source line and every line after it, leaving every
 * preceding line's text objects where they are. Used when the edit stays on
 * one source line (editedLineSpan) but does not fit that line, so a one-line
 * commit would wrap or overflow. The suffix objects are moved aside until
 * the engine models them as their own paragraph, that paragraph is committed
 * at the column width, and the new objects are put back with the edited
 * line's source origin. Prefix glyphs, including U+0020, must match the
 * source. A failed attempt is undone. { reason: "no_prefix" } when the edit
 * is on the first line: there is nothing to pin, and the caller keeps the
 * plain paragraph re-layout.
 */
export function commitPrefixSuffix(engine, paras, pi, del, inserts, runs, changed = new Set()) {
  if (!canCommitLineLocal(engine)) return { reason: "engine_capability_missing" };
  const para = paras[pi];
  const fmt = para.format || {};
  if (![0, 3].includes(fmt.align ?? 0) || fmt.dir || para.rotation || para.vertical) return { reason: "alignment_unsupported" };
  const span = editedLineSpan(para, del, inserts);
  if (!span || span.reason) return { reason: span?.reason ?? "line_geometry_missing" };
  const { k, start } = span;
  if (k === 0) return { reason: "no_prefix" };
  const source = para.lines;
  const M = engine.M;
  const handles = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
  const before = lineGlyphs(engine, handles, source);
  if (before.slice(0, k).some((g) => !g.length) || before.slice(k).some((g) => !g.length)) return { reason: "prefix_objects_unresolved" };
  const linesOf = new Map();
  before.forEach((g, j) => g.forEach((c) => {
    const on = linesOf.get(c.h) || new Set();
    on.add(j);
    linesOf.set(c.h, on);
  }));
  const prefix = [];
  const suffix = [];
  for (const h of handles) {
    const on = linesOf.get(h);
    if (on) {
      const lines = [...on];
      const inPrefix = lines.some((j) => j < k);
      const inSuffix = lines.some((j) => j >= k);
      if (inPrefix && inSuffix) return { reason: "prefix_objects_span_suffix" };
      if (on.size !== 1 || M._FPDFPageObj_GetType(h) !== OBJ_TEXT) return { reason: inPrefix ? "prefix_objects_unresolved" : "suffix_objects_unresolved" };
      (inPrefix ? prefix : suffix).push(h);
      continue;
    }
    const b = engine.objectBounds(h);
    if (!b) return { reason: "line_objects_unresolved" };
    for (let j = k; j < source.length; j++) {
      const em = Math.max(...before[j].map((c) => c.size));
      if (b.y <= source[j].y + em && b.y + b.h >= source[j].y - 0.4 * em) return { reason: "line_decoration_present" };
    }
  }
  if (!prefix.length || !suffix.length) return { reason: "prefix_objects_unresolved" };
  const pageBefore = pageObjectList(engine);
  const slots = suffix.map((h) => pageBefore.indexOf(h)).sort((a, b) => a - b);
  if (slots[0] < 0 || slots.some((s, i) => s !== slots[0] + i)) return { reason: "suffix_objects_interleaved" };
  const anchor = slots[0] > 0 ? pageBefore[slots[0] - 1] : null;
  const suffixOrdered = slots.map((s) => pageBefore[s]);
  const suffixSet = new Set(suffixOrdered);
  const rights = source.map((l) => l.x + l.w).filter(Number.isFinite);
  if (para.box && Number.isFinite(para.box.x) && Number.isFinite(para.box.w)) rights.push(para.box.x + para.box.w);
  const right = Math.max(...rights);
  const width = right - source[k].x;
  if (!(width > 1)) return { reason: "suffix_width_unknown" };
  const prefixBounds = prefix.map((h) => JSON.stringify(engine.objectBounds(h)));
  const suffixBounds = suffixOrdered.map((h) => JSON.stringify(engine.objectBounds(h)));
  const prefixGlyphs = collectGlyphs(engine, prefix);
  const suffixGlyphs = collectGlyphs(engine, suffixOrdered);
  const onEdited = suffixGlyphs.filter((g) => g.u > 32 && Math.abs(g.y - source[k].y) <= 1);
  if (!prefixGlyphs.length || !onEdited.length) return { reason: "prefix_objects_unresolved" };
  if (onEdited.some((g) => drawnSize(g) == null)) return { reason: "suffix_matrix_unavailable" };
  // Already edited paragraphs no longer match the source runs in `paras`.
  // Their objects and glyphs, read before this attempt moves anything, are
  // the current page. Untouched paragraphs still have to match those runs.
  const prior = new Map();
  for (const j of changed) {
    if (j === pi) continue;
    const handles = (engine.paragraphObjects(paras[j].id) || []).map((h) => h >>> 0).sort((a, b) => a - b);
    const glyphs = collectGlyphs(engine, handles);
    if (!handles.length || !glyphs.length) return { reason: "page_model_changed" };
    prior.set(j, { handles, glyphs });
  }
  const srcSizes = onEdited.map(drawnSize);
  const srcSize = [...srcSizes].sort((a, b) => a - b)[srcSizes.length >> 1];
  const flat = textOf(para);
  const fullNew = runs.map((r) => r.text).join("");
  const suffixRuns = sliceRuns(runs, start);
  if (!suffixRuns.length || squash(flat.slice(0, start) + suffixRuns.map((r) => r.text).join("")) !== squash(fullNew)) return { reason: "edited_text_mismatch" };

  let steps = 0;
  const step = (label, fn) => {
    const depth = engine.historyDepth().undo;
    engine.historyBeginStep(label);
    try {
      return fn();
    } finally {
      engine.historyEndStep();
      if (engine.historyDepth().undo > depth) steps++;
    }
  };
  const restore = (reason) => {
    const mutated = steps > 0;
    for (; steps > 0; steps--) if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    const back = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
    if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "page_objects" });
    if (back.join(",") !== handles.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_objects" });
    if (prefix.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== prefixBounds[i])) throw new LineRetentionError("state_drift", { after: reason, part: "prefix_bounds" });
    if (suffixOrdered.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== suffixBounds[i])) throw new LineRetentionError("state_drift", { after: reason, part: "suffix_bounds" });
    if (!sameGlyphs(prefixGlyphs, collectGlyphs(engine, prefix)).ok || !sameGlyphs(suffixGlyphs, collectGlyphs(engine, suffixOrdered)).ok) {
      throw new LineRetentionError("state_drift", { after: reason, part: "glyph_restore" });
    }
    // The isolated commit can leave every paragraph id on this page pointing
    // at a replaced native paragraph. The fallback commit uses the id that
    // still owns these objects, and the caller republishes the whole id list
    // after that commit.
    let id = para.id;
    let restored = null;
    if (mutated) {
      const snap = pageBefore.join(",");
      const model = engine.buildModel();
      if (pageObjectList(engine).join(",") !== snap) throw new LineRetentionError("state_drift", { after: reason, part: "page_objects_rebuilt" });
      if (!modelMatches(engine, model, paras, pi, squash(textOf(paras[pi])), changed, prior)) {
        throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_id" });
      }
      const got = (engine.paragraphObjects(model[pi].id) || []).map((h) => h >>> 0).sort((a, b) => a - b);
      const had = [...handles].sort((a, b) => a - b);
      if (got.join(",") !== had.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_objects" });
      id = model[pi].id;
      restored = model[pi];
    }
    return { reason, mutated, id, restored, prior };
  };

  const top = Math.max(...suffixOrdered.map((h) => {
    const b = engine.objectBounds(h);
    return b.y + b.h;
  }));
  const away = -(top + 200);
  step("falsify-prefix-isolate", () => {
    for (const h of suffixOrdered) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, 0, away);
    }
  });
  if (steps !== 1) {
    for (const h of suffixOrdered) engine.translateObject(h, 0, -away);
    return restore("history_unavailable");
  }
  if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: "prefix_isolate", part: "page_objects_rebuilt" });
  const iso = engine.buildModel();
  if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: "prefix_isolate", part: "page_objects_rebuilt" });
  const mine = iso.filter((q) => (engine.paragraphObjects(q.id) || []).some((h) => suffixSet.has(h >>> 0)));
  if (mine.length !== 1) return restore("suffix_not_isolated");
  const q = mine[0];
  const qh = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
  if (!q.editable || qh.length !== suffixOrdered.length || qh.some((h) => !suffixSet.has(h)) || prefix.some((h) => qh.includes(h))) return restore("suffix_not_isolated");
  const suffixText = flat.slice(start);
  const qText = textOf(q);
  if (lettersOf(qText) !== lettersOf(suffixText)) return restore("isolated_text_mismatch");
  const pRun = [];
  para.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) pRun.push(ri);
  });
  const qRun = [];
  q.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) qRun.push(ri);
  });
  let a = 0;
  let b = 0;
  while (a < suffixText.length && b < qText.length) {
    if (/\s/.test(suffixText[a])) { a++; continue; }
    if (/\s/.test(qText[b])) { b++; continue; }
    if (suffixText[a] !== qText[b] || baseStyle(q.runs[qRun[b]]) !== baseStyle(para.runs[pRun[start + a]])) return restore(suffixText[a] !== qText[b] ? "isolated_text_mismatch" : "isolated_style_mismatch");
    a++;
    b++;
  }
  while (a < suffixText.length && /\s/.test(suffixText[a])) a++;
  while (b < qText.length && /\s/.test(qText[b])) b++;
  if (a !== suffixText.length || b !== qText.length) return restore("isolated_text_mismatch");

  let id = q.id;
  if (!(q.box?.w >= width - 0.5)) {
    const rz = step("falsify-prefix-width", () => engine.resizeParagraph(id, width));
    if (!rz) return restore("suffix_not_isolated");
    id = rz.id ?? id;
  }
  const upd = step("falsify-prefix-suffix", () => engine.commitParagraph(id, suffixRuns, fmt));
  if (!upd?.lines?.length || !["x", "y"].every((f) => Number.isFinite(upd.lines[0][f]))) return restore("suffix_commit_failed");
  if (prefix.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== prefixBounds[i])) return restore("prefix_objects_moved");
  const fresh = (engine.paragraphObjects(upd.id ?? id) || []).map((h) => h >>> 0);
  if (!fresh.length || fresh.some((h) => prefix.includes(h))) return restore("suffix_objects_unresolved");

  const dx = source[k].x - upd.lines[0].x;
  const dy = source[k].y - upd.lines[0].y;
  let placed = true;
  step("falsify-prefix-place", () => {
    for (const h of fresh) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, dx, dy);
    }
    const cur = pageObjectList(engine);
    let at = anchor === null ? 0 : cur.indexOf(anchor) + 1;
    if (anchor !== null && at === 0) placed = false;
    for (const h of [...fresh].sort((p, qh2) => cur.indexOf(p) - cur.indexOf(qh2))) {
      if (!placed) break;
      engine.historyNoteZOrder(h);
      if (!M._FPDFPage_RemoveObject(engine.page, h)) placed = false;
      else if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, at++)) {
        M._FPDFPage_InsertObject?.(engine.page, h);
        placed = false;
      }
    }
  });
  if (!placed) return restore("line_order_not_restored");
  if (prefix.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== prefixBounds[i])) return restore("prefix_objects_moved");

  const after = engine.buildModel();
  if (after.length !== paras.length || after.some((p, j) => j !== pi && !changed.has(j) && paraKey(p) !== paraKey(paras[j]))) return restore("page_model_changed");
  const now = after[pi];
  if (squash(textOf(now)) !== squash(fullNew)) return restore("edited_text_mismatch");
  const nowHandles = (engine.paragraphObjects(now.id) || []).map((h) => h >>> 0);
  const want = new Set([...prefix, ...fresh]);
  if (nowHandles.length !== want.size || nowHandles.some((h) => !want.has(h))) return restore("paragraph_objects_changed");
  const proof = sameGlyphs(prefixGlyphs, collectGlyphs(engine, prefix));
  if (!proof.ok) return restore("kept_lines_moved");
  const got = collectGlyphs(engine, fresh).filter((g) => g.u > 32);
  if (!got.length || got.some((g) => drawnSize(g) == null)) return restore("suffix_matrix_unavailable");
  if (got.some((g) => Math.abs(drawnSize(g) - srcSize) > DRAWN_TOL)) return restore("suffix_font_changed");
  const topGlyphs = got.filter((g) => Math.abs(g.y - source[k].y) <= 0.5);
  if (!topGlyphs.length || Math.abs(Math.min(...topGlyphs.map((g) => g.x)) - source[k].x) > PLACE_TOL) return restore("suffix_misplaced");
  const inkRight = Math.max(...fresh.map((h) => {
    const b = engine.objectBounds(h);
    return b ? b.x + b.w : -Infinity;
  }));
  if (inkRight > right + 1) return restore("suffix_exceeds_column");
  return {
    upd: { ...now, surgical: false },
    ids: after.map((p) => p.id),
    lines: {
      status: "reflowed",
      reason: "edited_line_overflows",
      prefixKept: k,
      suffixReflow: true,
      kept: k,
      lines: now.lines?.length ?? null,
      maxKeptShift: +proof.max.toFixed(4),
    },
  };
}

/**
 * Replaces the plain re-layout that commitRetainingLines just committed (the
 * last undo step; pre is the page object list before it) by a line-local
 * commit when one holds. An overflow that line-local refuses is retried with
 * the prefix lines pinned and only the edited line plus its suffix re-laid
 * out. Otherwise the plain re-layout is committed again and { upd, reason }
 * returned. A prefix attempt that cannot isolate the source objects records
 * that reason and still falls back to the plain re-layout; it does not
 * report the prefix as kept.
 */
// The edited runs name font sources by index into the paragraph they were
// built from. After a rollback the restored paragraph can split those runs
// differently; each edited run follows the restored run that holds the same
// source characters. A source run that lands in more than one restored run
// is not guessed.
// `expectPi` is the squashed text this paragraph should show. Paragraphs
// already edited on this page are proved by the glyph snapshot taken before
// the attempt, not by the stale source runs. Every other paragraph still
// has to match those runs. An empty or moved snapshot fails closed.
function modelMatches(engine, model, paras, pi, expectPi, changed, prior) {
  if (!model || model.length !== paras.length) return false;
  if (squash(textOf(model[pi])) !== expectPi) return false;
  for (let j = 0; j < model.length; j++) {
    if (j === pi) continue;
    if (changed.has(j)) {
      const snap = prior?.get(j);
      if (!snap?.handles.length || !snap.glyphs.length) return false;
      const got = (engine.paragraphObjects(model[j].id) || []).map((h) => h >>> 0).sort((a, b) => a - b);
      if (got.join(",") !== snap.handles.join(",")) return false;
      if (!sameGlyphs(snap.glyphs, collectGlyphs(engine, got)).ok) return false;
      continue;
    }
    if (squash(textOf(model[j])) !== squash(textOf(paras[j]))) return false;
  }
  return true;
}

function rebindRuns(edited, original, restored) {
  if (!restored) return edited;
  if (original.length === restored.length && original.every((r, i) => r.text === restored[i].text)) return edited;
  if (original.map((r) => r.text).join("") !== restored.map((r) => r.text).join("")) return null;
  const at = [];
  restored.forEach((r, i) => { for (let k = 0; k < r.text.length; k++) at.push(i); });
  const from = [];
  original.forEach((r, i) => { for (let k = 0; k < r.text.length; k++) from.push(i); });
  const hits = new Map();
  from.forEach((ri, off) => {
    const set = hits.get(ri) ?? new Set();
    set.add(at[off]);
    hits.set(ri, set);
  });
  const out = [];
  for (const r of edited) {
    const targets = [...(hits.get(r.sourceIndex) ?? [])];
    if (targets.length !== 1) return null;
    out.push({ ...r, sourceIndex: targets[0] });
  }
  return out;
}

export function replaceReflowWithLineLocal(engine, paras, pi, del, inserts, runs, pre, changed) {
  const para = paras[pi];
  if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
  if (pageObjectList(engine).join(",") !== pre.join(",")) throw new LineRetentionError("state_drift");
  const local = commitLineLocal(engine, paras, pi, del, inserts, changed);
  if (local.upd) return local;
  let reason = local.reason;
  let id = para.id;
  let commitRuns = runs;
  let republish = false;
  let prior = null;
  if (OVERFLOW_REASONS.has(local.reason)) {
    const prefix = commitPrefixSuffix(engine, paras, pi, del, inserts, runs, changed);
    if (prefix.upd) return prefix;
    if (prefix.reason && prefix.reason !== "no_prefix") reason = prefix.reason;
    if (prefix.mutated && prefix.id != null) {
      id = prefix.id;
      republish = true;
      prior = prefix.prior;
      commitRuns = rebindRuns(runs, para.runs, prefix.restored?.runs);
      if (!commitRuns) throw new LineRetentionError("state_drift", { after: prefix.reason, part: "font_source" });
    }
  }
  engine.historyBeginStep("falsify-inline-edit");
  let upd;
  try {
    upd = engine.commitParagraph(id, commitRuns, para.format);
  } finally {
    engine.historyEndStep();
  }
  if (!upd || !republish) return { reason, upd };
  const after = engine.buildModel();
  const fullNew = squash(commitRuns.map((r) => r.text).join(""));
  if (!modelMatches(engine, after, paras, pi, fullNew, changed, prior)) {
    throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_id" });
  }
  return { reason, upd, ids: after.map((p) => p.id) };
}
