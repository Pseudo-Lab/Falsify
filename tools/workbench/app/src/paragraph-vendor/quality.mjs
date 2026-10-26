// Layout and reading-order quality layer for the editor module.
//
// Shared contract with the core editor:
//   capturePageLayout(engine, pageIndex, paragraphs) => context
//   repairPageLayout(engine, pageIndex, context, touched, options?) => { repairs, warnings, pagination? }
//   inspectSavedPdf(engineFactory, sourceBytes, outputBytes, edits, options?) => report
//
// options.paginate (repair) is called when the cascade has no room; without
// it overflow stays a pagination_unsupported error. options.sourcePageMap
// (inspect) maps each source page to its output page and continuation pages.
//
// Object handles are compared as integers only. A handle captured before a
// commit is never passed back to PDFium; only handles enumerated from the
// current page (or returned by paragraphObjects on the current page) are.
// inspectSavedPdf uses the same PDFium build as the editor, so it is a
// self-check, not an independent or rendering-based release check.

import { createHash } from "node:crypto";
import { resolvePageFraction } from "./continuation-template.mjs";
import { deriveDocumentFlowBand } from "./document-flow-band.mjs";
import { deriveNativeLinkMoves, savedLinkGlyphs } from "./document-flow-links.mjs";
import { verifySavedUnderlines } from "./document-flow-underlines.mjs";

const TOL = 1;
const EDGE_BAND = 0.1;
const OBJ_TEXT = 1;

const normStr = (s) => String(s).replace(/\s+/g, " ").trim();
const paraText = (p) => (p.runs || []).map((r) => r.text || "").join("");
const bottomOf = (b) => b.top - b.h;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function ensurePage(engine, pageIndex) {
  if (!engine.page || engine.pageIndex !== pageIndex) engine.loadPage(pageIndex);
}

function listObjects(engine) {
  const M = engine.M;
  const n = M._FPDFPage_CountObjects(engine.page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return out;
}

function unionBounds(engine, handles) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const h of handles) {
    const b = engine.objectBounds(h);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!(x1 > x0)) return null;
  return { x: x0, top: y1, w: x1 - x0, h: y1 - y0 };
}

function hOverlap(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}

// Header/footer classification from the page itself. Only short paragraphs
// fully inside the top/bottom band are edge content; numeric ones are
// treated as page numbers, the rest as uncertain running headers/footers.
// Both are fixed: repair never moves them. "Short" is at most 60 characters
// on at most two lines; the word cap only excludes long word lists (a
// running header such as "Title - subtitle - section" easily has 9 words).
function classify(p, pageH, edgeBottomY) {
  if (!p.box) return "unknown";
  const text = normStr(paraText(p));
  const short = text.length <= 60 && text.split(" ").length <= 12 && (p.lines?.length || 1) <= 2;
  const inTop = bottomOf(p.box) >= edgeBottomY + pageH * (1 - EDGE_BAND);
  const inBottom = p.box.top <= edgeBottomY + pageH * EDGE_BAND;
  if (!short || !(inTop || inBottom)) return "body";
  if (/^[\s\-–—|/.()]*(\d+|[ivxlcdm]+)([\s\-–—|/.()]*(\d+|of))*[\s\-–—|/.()]*$/i.test(text)) return "page_number";
  return inTop ? "header_uncertain" : "footer_uncertain";
}

export function capturePageLayout(engine, pageIndex, paragraphs) {
  ensurePage(engine, pageIndex);
  const pageW = engine.pageWidth, pageH = engine.pageHeight;
  const objects = listObjects(engine);
  const M = engine.M;
  const types = objects.map((h) => M._FPDFPageObj_GetType(h));
  const indexOf = new Map(objects.map((h, i) => [h, i]));
  const boxes = (paragraphs || []).filter((p) => p.box).map((p) => p.box);
  const edgeBottomY = boxes.length ? Math.min(0, ...boxes.map(bottomOf)) : 0;
  const paras = (paragraphs || []).map((p) => {
    const handles = (engine.paragraphObjects(p.id) || []).map((h) => h >>> 0);
    const slots = handles.map((h) => indexOf.get(h)).filter((i) => i !== undefined).sort((a, b) => a - b);
    const baselines = (p.lines || []).map((l) => l.y).filter(Number.isFinite);
    const size = median((p.runs || []).map((r) => r.size).filter((s) => s > 0));
    return {
      id: p.id,
      role: classify(p, pageH, edgeBottomY),
      editable: !!p.editable,
      sharesObjects: !!p.sharesObjects,
      box: p.box ? { ...p.box } : null,
      baselines,
      size,
      handles,
      slots,
      topLevel: slots.length === handles.length,
    };
  });
  // A publisher footer can exceed the short-text heuristic. Require a
  // separate page number on its baseline inside the bottom edge band.
  const numbers = paras.filter((q) => q.role === "page_number" && q.box?.top <= edgeBottomY + pageH * EDGE_BAND);
  for (const q of paras) {
    if (q.role !== "body" || !q.box || q.baselines.length !== 1 || q.box.top > edgeBottomY + pageH * EDGE_BAND) continue;
    if (numbers.some((n) => n.id !== q.id && n.baselines.some((y) => Math.abs(y - q.baselines[0]) <= 0.5) && hOverlap(n.box, q.box) <= 0)) q.role = "footer_uncertain";
  }
  return { pageIndex, pageW, pageH, objects, types, paras };
}

function columnOf(ctx, box) {
  let right = box.x + box.w;
  for (const q of ctx.paras) {
    if (q.role !== "body" || !q.box) continue;
    if (hOverlap(q.box, box) < 0.35 * Math.min(box.w, q.box.w)) continue;
    right = Math.max(right, q.box.x + q.box.w);
  }
  return { left: box.x, right };
}

// True when page model coordinates are plain user space: no /Rotate and an
// identity page transform (no crop/media offset).
function uprightPage(engine) {
  const M = engine.M;
  if (typeof M._FPDFPage_GetRotation === "function" && M._FPDFPage_GetRotation(engine.page) !== 0) return false;
  const t = engine.pageT || [1, 0, 0, 1, 0, 0];
  return [1, 0, 0, 1, 0, 0].every((v, i) => Math.abs(t[i] - v) <= 1e-4);
}

// Lowest baseline (text-matrix origin) of a paragraph's current objects, or
// null when any of them is not an unrotated, unskewed text object. The
// model's source baselines are origins too, so growth measured this way is
// independent of ascenders/descenders on the first and last lines.
function lastBaseline(engine, handles) {
  const M = engine.M;
  if (!handles.length || typeof M._FPDFPageObj_GetMatrix !== "function") return null;
  const p = M._malloc(24);
  try {
    let y = Infinity;
    for (const h of handles) {
      if (M._FPDFPageObj_GetType(h) !== OBJ_TEXT || !M._FPDFPageObj_GetMatrix(h, p)) return null;
      const [a, b, c, d, e, f] = [0, 1, 2, 3, 4, 5].map((k) => M.HEAPF32[(p >> 2) + k]);
      if (Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4 || !(a > 0) || !(d > 0)) return null;
      y = Math.min(y, typeof engine.toModel === "function" ? engine.toModel(e, f).y : f);
    }
    return Number.isFinite(y) ? y : null;
  } finally {
    M._free(p);
  }
}

// Source line pitch: from the paragraph's own lines when it had several,
// otherwise from consistent baseline gaps of neighbouring body lines in the
// same column. Returns null when no consistent pitch exists.
function inferPitch(ctx, t, info) {
  const own = (t.sourceLines || info?.baselines || []).map((l) => (typeof l === "number" ? l : l?.y)).filter(Number.isFinite);
  const gaps = [];
  for (let i = 1; i < own.length; i++) gaps.push(own[i - 1] - own[i]);
  if (gaps.length) {
    const m = median(gaps);
    if (m > 0 && gaps.every((g) => Math.abs(g - m) <= 0.05 * m)) return { pitch: m, from: "source_lines" };
    return null;
  }
  const col = ctx.paras
    .filter((q) => q.role === "body" && q.box && q.baselines.length && hOverlap(q.box, t.sourceBox) >= 0.35 * Math.min(q.box.w, t.sourceBox.w))
    .flatMap((q) => q.baselines)
    .sort((a, b) => b - a);
  const size = info?.size || 0;
  const near = [];
  for (let i = 1; i < col.length; i++) {
    const g = col[i - 1] - col[i];
    if (g > 0.5 && (!size || g < 2.6 * size)) near.push(g);
  }
  if (near.length < 2) return null;
  const m = median(near);
  const agree = near.filter((g) => Math.abs(g - m) <= 0.05 * m).length;
  return agree >= Math.max(2, 0.6 * near.length) ? { pitch: m, from: "neighbour_lines" } : null;
}

// Move each re-laid-out line so the baseline pitch matches the source.
function restorePitch(engine, id, rz, pitch) {
  const lines = (rz.lines || []).map((l) => l.y);
  if (lines.length < 2) return { ok: true, dyLast: 0, moved: 0 };
  const cur = median(lines.slice(1).map((y, i) => lines[i] - y));
  if (Math.abs(cur - pitch) <= 0.25) return { ok: true, dyLast: 0, moved: 0 };
  const handles = (engine.paragraphObjects(id) || []).map((h) => h >>> 0);
  const groups = lines.map(() => []);
  for (const h of handles) {
    const b = engine.objectBounds(h);
    if (!b) return { ok: false, reason: "object_without_bounds" };
    const hits = lines.map((y, k) => (y >= b.y - 0.5 && y <= b.y + b.h + 0.5 ? k : -1)).filter((k) => k >= 0);
    if (hits.length !== 1) return { ok: false, reason: "object_line_ambiguous" };
    groups[hits[0]].push(h);
  }
  let moved = 0;
  for (let k = 1; k < lines.length; k++) {
    const dy = lines[0] - k * pitch - lines[k];
    if (Math.abs(dy) < 0.01) continue;
    for (const h of groups[k]) {
      engine.translateObject(h, 0, dy);
      moved++;
    }
  }
  const last = lines.length - 1;
  return { ok: true, dyLast: lines[0] - last * pitch - lines[last], moved };
}

export function repairPageLayout(engine, pageIndex, context, touched, options = {}) {
  const repairs = [];
  const warnings = [];
  if (!context || context.pageIndex !== pageIndex) {
    warnings.push({ code: "context_mismatch", pageIndex, severity: "error" });
    return { repairs, warnings };
  }
  ensurePage(engine, pageIndex);
  const byId = new Map(context.paras.map((q) => [q.id, q]));
  const grown = [];

  const order = [...(touched || [])].filter((t) => t?.sourceBox).sort((a, b) => b.sourceBox.top - a.sourceBox.top);
  for (const t of order) {
    const info = byId.get(t.id);
    const rec = { kind: "paragraph", id: t.id, action: "kept" };
    repairs.push(rec);
    if (info && info.role !== "body") {
      warnings.push({ code: "edited_edge_paragraph", id: t.id, role: info.role, severity: "warning" });
      continue;
    }
    const handles = (engine.paragraphObjects(t.id) || []).map((h) => h >>> 0);
    const cur = unionBounds(engine, handles);
    if (!cur) {
      warnings.push({ code: "paragraph_objects_unavailable", id: t.id, severity: "error" });
      continue;
    }
    const col = columnOf(context, t.sourceBox);
    const widened = cur.x + cur.w > col.right + TOL || cur.x < t.sourceBox.x - TOL || cur.x + cur.w > context.pageW;
    if (!widened) {
      // Surgical result stays inside its source column: keep it untouched,
      // but a surgical commit may still wrap onto more lines, and that
      // vertical growth must push (or paginate) the body below it. Growth
      // is the drop of the last baseline; the source box is a font-metric
      // line box and the current bounds are glyph-tight, so comparing their
      // bottoms would mix two measures.
      rec.action = "kept_surgical";
      const src = (t.sourceLines || []).map((l) => l?.y).filter(Number.isFinite);
      const base = src.length ? lastBaseline(engine, handles) : null;
      const delta = base !== null ? Math.min(...src) - base : bottomOf(t.sourceBox) - bottomOf(cur);
      if (delta > 0.5) {
        rec.grown = { by: +delta.toFixed(2), from: base !== null ? "baselines" : "bounds" };
        grown.push({ id: t.id, box: t.sourceBox, delta });
      }
      continue;
    }
    const colW = col.right - t.sourceBox.x;
    let width = t.sourceBox.w >= 0.85 * colW ? t.sourceBox.w : colW;
    let rz = engine.resizeParagraph(t.id, width);
    if (!rz || !rz.box) {
      warnings.push({ code: "resize_failed", id: t.id, severity: "error" });
      continue;
    }
    rec.action = "resized";
    // The engine wraps by its own advance measure, so a line's glyph ink
    // can still end past the column. Narrow once by the measured overshoot,
    // only on pages whose model space is the unrotated user space, and only
    // by a modest correction (at most a tenth of the width, TOL included)
    // that leaves a positive width. A larger overshoot (an unbreakable token
    // or an engine anomaly) is reported and left to the saved-PDF check.
    const ink = uprightPage(engine) ? unionBounds(engine, (engine.paragraphObjects(t.id) || []).map((h) => h >>> 0)) : null;
    const over = ink ? ink.x + ink.w - (col.right + TOL) : 0;
    const fix = over + TOL;
    if (over > 0 && !(fix <= 0.1 * width && width - fix > 0)) {
      warnings.push({ code: "ink_overshoot_unrepaired", id: t.id, overshoot: +over.toFixed(2), width: +width.toFixed(2), severity: "warning" });
    } else if (over > 0) {
      const narrower = engine.resizeParagraph(t.id, width - fix);
      if (!narrower || !narrower.box) {
        warnings.push({ code: "resize_failed", id: t.id, severity: "error" });
        continue;
      }
      rz = narrower;
      width -= fix;
      rec.narrowed = +fix.toFixed(2);
    }
    rec.width = +width.toFixed(2);
    rec.lines = rz.lines?.length || 0;
    let bottom = bottomOf(rz.box);
    const pitch = inferPitch(context, t, info);
    if (pitch && rec.lines > 1) {
      const r = restorePitch(engine, t.id, rz, pitch.pitch);
      if (r.ok) {
        rec.pitch = { value: +pitch.pitch.toFixed(2), from: pitch.from, objects_moved: r.moved };
        bottom += r.dyLast;
        if (r.moved) warnings.push({ code: "engine_model_lines_stale", id: t.id, severity: "info" });
      } else {
        warnings.push({ code: "line_pitch_not_restored", id: t.id, reason: r.reason, severity: "warning" });
      }
    } else if (rec.lines > 1) {
      warnings.push({ code: "line_pitch_unknown", id: t.id, severity: "warning" });
    }
    const delta = bottomOf(t.sourceBox) - bottom;
    if (delta > 0.5) grown.push({ id: t.id, box: t.sourceBox, delta });
  }

  const paginate = typeof options.paginate === "function" ? options.paginate : null;
  const overflow = grown.length ? cascade(engine, context, grown, new Set(order.map((t) => t.id)), repairs, warnings, !!paginate) : null;
  restoreSourceOrder(engine, context, repairs, warnings);
  if (!overflow) return { repairs, warnings };
  // Order is restored before any object leaves the page, so moved lines keep
  // their source object order on the continuation pages.
  const p = paginate(engine, context, grown, { floor: overflow.floor });
  repairs.push(...(p?.repairs ?? []));
  warnings.push(...(p?.warnings ?? []));
  if (!p?.ok) return { repairs, warnings, pagination: null };
  const pagination = { added: p.added, lineCounts: p.lineCounts, keptLines: p.keptLines, bodyTop: p.bodyTop, ...(p.flowTop !== undefined ? { flowTop: p.flowTop } : {}), floor: p.floor };
  if (p.continuationStyle !== undefined) {
    if (!validContinuationStyle(p.continuationStyle)) {
      warnings.push({ code: "continuation_style_invalid", pageIndex, severity: "error" });
      return { repairs, warnings, pagination: null };
    }
    pagination.continuationStyle = { ...p.continuationStyle };
  }
  return { repairs, warnings, pagination };
}

// Shift following body paragraphs of the same column by the growth above
// them. Edge paragraphs (headers, footers, page numbers) never move. If the
// shift would push body text into the footer zone, nothing is moved and the
// overflow is reported as pagination_unsupported, or, when the caller can
// paginate, returned as { floor } for the continuation-page flow.
//
// The footer zone is the edge paragraphs' top plus 2, raised to the bottom
// EDGE_BAND of the page's content extent: the saved-PDF check reads whole
// lines inside that band as header/footer content, so body text is never
// moved into it unless the source body already reached lower.
function cascade(engine, ctx, grown, touchedIds, repairs, warnings, allowOverflow = false) {
  const edgeTops = ctx.paras.filter((q) => q.box && q.role !== "body" && q.box.top < ctx.pageH / 2).map((q) => q.box.top);
  const bodyBottoms = ctx.paras.filter((q) => q.box && q.role === "body").map((q) => bottomOf(q.box));
  const pageBottom = Math.min(...ctx.paras.filter((q) => q.box).map((q) => bottomOf(q.box)));
  const floor = edgeTops.length
    ? Math.max(Math.max(...edgeTops) + 2, Math.min(pageBottom + EDGE_BAND * ctx.pageH, ...bodyBottoms))
    : Math.min(...bodyBottoms, Infinity);
  const plan = new Map();
  for (const g of grown) {
    for (const q of ctx.paras) {
      if (!q.box || q.id === g.id || q.role !== "body" || !q.editable) continue;
      if (q.box.top > bottomOf(g.box) + 0.5) continue;
      if (hOverlap(q.box, g.box) < 0.35 * Math.min(g.box.w, q.box.w)) continue;
      plan.set(q.id, (plan.get(q.id) || 0) + g.delta);
    }
  }
  const violations = [];
  for (const [id, dy] of plan) {
    const q = ctx.paras.find((p) => p.id === id);
    if (bottomOf(q.box) - dy < floor - 0.01) violations.push(id);
  }
  // Growth of the last paragraph itself must also fit.
  for (const g of grown) if (bottomOf(g.box) - g.delta < floor - 0.01) violations.push(g.id);
  if (violations.length) {
    if (allowOverflow) {
      warnings.push({ code: "pagination_required", severity: "info", paragraphs: violations, floor: +floor.toFixed(2) });
      repairs.push({ kind: "cascade", action: "deferred_to_pagination", moved: 0 });
      return { floor };
    }
    warnings.push({ code: "pagination_unsupported", severity: "error", paragraphs: violations, floor: +floor.toFixed(2) });
    repairs.push({ kind: "cascade", action: "skipped_no_room", moved: 0 });
    return null;
  }
  let moved = 0;
  for (const [id, dy] of plan) {
    if (!engine.moveParagraph(id, 0, -dy)) {
      warnings.push({ code: "move_failed", id, severity: "error" });
      continue;
    }
    if (touchedIds.has(id)) warnings.push({ code: "moved_edited_paragraph", id, severity: "info" });
    moved++;
  }
  repairs.push({ kind: "cascade", action: "shifted", moved, floor: +floor.toFixed(2) });
  return null;
}

// Put every paragraph whose objects were replaced back into the source
// object slot of that paragraph. Unrelated objects keep their relative
// order. Anything that cannot be mapped unambiguously is reported and the
// page order is left as the engine produced it.
//
// Limitation: PDFium's content generator writes objects that have no source
// content stream (every object created by a re-layout) into a new stream
// appended after the existing ones, whatever their object index. The index
// order fixes draw order inside a stream only, so a replaced paragraph that
// is followed by surviving source objects may still be serialized last. A
// changed object handle is a risk indicator, not proof of the saved order,
// so that case is reported as a warning that requires the saved text/order
// check (inspectSavedPdf) and is never labelled restored.
export function restoreSourceOrder(engine, ctx, repairs, warnings) {
  const M = engine.M;
  const current = listObjects(engine);
  const present = new Set(current);
  const ownerOfSource = new Map();
  for (const q of ctx.paras) for (const h of q.handles) ownerOfSource.set(h, q.id);

  const changed = [];
  const claimed = new Map();
  const fail = (code, extra) => {
    warnings.push({ code, severity: "warning", ...extra });
    repairs.push({ kind: "reading_order", action: "skipped", reason: code });
  };
  for (const q of ctx.paras) {
    const now = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
    for (const h of now) {
      if (claimed.has(h) && claimed.get(h) !== q.id) return fail("object_shared_between_paragraphs", { id: q.id });
      claimed.set(h, q.id);
    }
    const same = now.length === q.handles.length && now.every((h, i) => h === q.handles[i]);
    if (same) continue;
    if (!q.topLevel || now.some((h) => !present.has(h))) return fail("paragraph_not_top_level", { id: q.id });
    if (q.sharesObjects) return fail("paragraph_shares_objects", { id: q.id });
    if (!q.slots.length) return fail("paragraph_without_source_slot", { id: q.id });
    const lo = q.slots[0], hi = q.slots[q.slots.length - 1];
    for (let i = lo; i <= hi; i++) {
      if (ownerOfSource.get(ctx.objects[i]) !== q.id) return fail("interleaved_source_slot", { id: q.id });
    }
    for (const h of now) {
      const o = ownerOfSource.get(h);
      if (o !== undefined && o !== q.id) return fail("handle_identity_reused", { id: q.id });
      if (o === undefined && ctx.objects.includes(h)) return fail("handle_identity_reused", { id: q.id });
    }
    changed.push({ id: q.id, first: ctx.objects[lo], now });
  }
  if (!changed.length) {
    repairs.push({ kind: "reading_order", action: "unchanged", moved: 0 });
    return;
  }
  const changedIds = new Set(changed.map((c) => c.id));
  const firstSlot = new Map(changed.map((c) => [c.first, c]));
  const desired = [];
  for (const h of ctx.objects) {
    const c = firstSlot.get(h);
    if (c) {
      const pos = new Map(current.map((x, i) => [x, i]));
      desired.push(...[...c.now].sort((a, b) => pos.get(a) - pos.get(b)));
      continue;
    }
    if (changedIds.has(ownerOfSource.get(h))) continue;
    if (!present.has(h)) continue;
    if (claimed.has(h) && changedIds.has(claimed.get(h))) continue;
    desired.push(h);
  }
  const desiredSet = new Set(desired);
  const unmapped = current.filter((h) => !desiredSet.has(h));
  if (unmapped.length || desired.length !== current.length) {
    return fail("unmapped_new_objects", { count: unmapped.length });
  }
  const lost = ctx.objects.filter((h) => !present.has(h) && !changedIds.has(ownerOfSource.get(h)));
  if (lost.length) return fail("unrelated_object_missing", { count: lost.length });

  const typesBefore = current.filter((h) => !claimedText(M, h)).map((h) => h);
  const work = [...current];
  let moves = 0;
  for (let i = 0; i < desired.length; i++) {
    if (work[i] === desired[i]) continue;
    const j = work.indexOf(desired[i], i + 1);
    const h = desired[i];
    if (j < 0 || !M._FPDFPage_RemoveObject(engine.page, h)) {
      warnings.push({ code: "reorder_remove_failed", severity: "error" });
      break;
    }
    work.splice(j, 1);
    if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, i)) {
      // Keep ownership with the page even if the indexed insert fails.
      M._FPDFPage_InsertObject(engine.page, h);
      work.push(h);
      warnings.push({ code: "reorder_insert_failed", severity: "error" });
      break;
    }
    work.splice(i, 0, h);
    moves++;
  }
  if (moves) engine._pageDirty = true;
  const after = listObjects(engine);
  const nonText = (list) => list.filter((h) => !claimedText(M, h));
  const stackKept = nonText(after).join(",") === typesBefore.join(",");
  const exact = after.length === desired.length && after.every((h, i) => h === desired[i]);
  if (!exact) warnings.push({ code: "reading_order_not_exact", severity: "error" });
  if (!stackKept) warnings.push({ code: "nontext_order_changed", severity: "error" });
  const appended = changed.filter((c) => {
    const last = Math.max(...ctx.paras.find((q) => q.id === c.id).slots);
    return ctx.objects.slice(last + 1).some((h) => present.has(h) && !changedIds.has(ownerOfSource.get(h)));
  });
  if (appended.length) {
    warnings.push({
      code: "content_stream_append_order",
      severity: "warning",
      verification: "saved_text_order_required",
      paragraphs: appended.map((c) => c.id),
    });
  }
  repairs.push({
    kind: "reading_order",
    action: appended.length ? "index_only_stream_order_unresolved" : moves ? "restored" : "unchanged",
    moved: moves,
    paragraphs: changed.map((c) => c.id),
  });
}

function claimedText(M, h) {
  return M._FPDFPageObj_GetType(h) === OBJ_TEXT;
}

// ---------- saved-PDF self-check ----------

// Per-glyph style read from the text page: font name and flags, size, fill
// and stroke colour, render mode and the scale/rotation part of the glyph
// matrix, plus origin, loose (advance-width) box and owning text object.
// Absent when the runtime does not export the text-page style API; such a
// page cannot verify copied edge content.
const STYLE_FNS = ["_FPDFText_GetFontSize", "_FPDFText_GetFontInfo", "_FPDFText_GetFillColor", "_FPDFText_GetStrokeColor", "_FPDFText_GetMatrix", "_FPDFText_GetCharOrigin", "_FPDFText_GetLooseCharBox", "_FPDFText_GetTextObject", "_FPDFTextObj_GetTextRenderMode"];

function readStyle(M, tp, i, buf) {
  const n = M._FPDFText_GetFontInfo(tp, i, buf, 128, buf + 128);
  const font = n > 0 && n <= 128 ? M.UTF8ToString(buf, 128) : null;
  const flags = M.HEAP32[(buf + 128) >> 2];
  const rgba = (fn, at) => (M[fn](tp, i, at, at + 4, at + 8, at + 12) ? [0, 1, 2, 3].map((k) => M.HEAPU32[(at >> 2) + k]) : null);
  const fill = rgba("_FPDFText_GetFillColor", buf + 144);
  const stroke = rgba("_FPDFText_GetStrokeColor", buf + 160);
  const f32 = (at, k) => M.HEAPF32[(at >> 2) + k];
  const mat = M._FPDFText_GetMatrix(tp, i, buf + 176) ? [0, 1, 2, 3].map((k) => f32(buf + 176, k)) : null;
  const origin = M._FPDFText_GetCharOrigin(tp, i, buf + 208, buf + 216) ? [M.HEAPF64[(buf + 208) >> 3], M.HEAPF64[(buf + 216) >> 3]] : null;
  const loose = M._FPDFText_GetLooseCharBox(tp, i, buf + 224) ? [f32(buf + 224, 0), f32(buf + 224, 2)] : null;
  const obj = M._FPDFText_GetTextObject(tp, i) >>> 0;
  const render = obj ? M._FPDFTextObj_GetTextRenderMode(obj) : null;
  return { obj, origin, loose, style: { font, flags, size: M._FPDFText_GetFontSize(tp, i), fill, stroke, render, mat } };
}

function sameStyle(a, b) {
  if (!a || !b) return a === b;
  const eq = (x, y, tol = 0) => (x === null || y === null ? x === y : x.every((v, k) => Math.abs(v - y[k]) <= tol));
  return a.font !== null && a.font === b.font && a.flags === b.flags && Math.abs(a.size - b.size) <= 0.01 && a.render === b.render
    && eq(a.fill, b.fill) && eq(a.stroke, b.stroke) && eq(a.mat, b.mat, 1e-3);
}

const sameStyles = (a, b) => a.length === b.length && a.every((c, k) => sameStyle(c.style ?? null, b[k].style ?? null));

function readGlyphs(engine, pageIndex) {
  ensurePage(engine, pageIndex);
  const M = engine.M;
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const styled = STYLE_FNS.every((f) => typeof M[f] === "function") && typeof M.UTF8ToString === "function";
  const b = M._malloc(32);
  const sb = styled ? M._malloc(256) : 0;
  let text = "";
  const glyphs = [];
  const chars = [];
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    text += String.fromCharCode(u);
    if (u <= 32 || !M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24)) {
      chars.push({ u, cy: null, generated: typeof M._FPDFText_IsGenerated === "function" && M._FPDFText_IsGenerated(tp, i) === 1 });
      continue;
    }
    const l = M.HEAPF64[b >> 3], r = M.HEAPF64[(b + 8) >> 3];
    const bo = M.HEAPF64[(b + 16) >> 3], t = M.HEAPF64[(b + 24) >> 3];
    glyphs.push(styled ? { u, l, r, b: bo, t, i, ...readStyle(M, tp, i, sb) } : { u, l, r, b: bo, t, i });
    chars.push({ u, cy: (bo + t) / 2 });
  }
  M._free(b);
  if (sb) M._free(sb);
  if (tp) M._FPDFText_ClosePage(tp);
  return { text, glyphs, chars, styled, W: M._FPDF_GetPageWidthF(engine.page), H: M._FPDF_GetPageHeightF(engine.page) };
}

function offPage(g) {
  return g.glyphs.filter((c) => c.r > g.W + 0.5 || c.l < -0.5 || c.b < -0.5 || c.t > g.H + 0.5).length;
}

// adjacentKerning: pairs that are consecutive in text order on one baseline
// (kerned or ligature-like pairs such as "fi" in the source font) are type
// metrics, not layout collisions; the continued-flow check excludes them on
// both sides of the comparison.
function overlaps(g, adjacentKerning = false) {
  const cell = 12;
  const grid = new Map();
  let count = 0;
  g.glyphs.forEach((c, i) => {
    const area = Math.max(0.01, (c.r - c.l) * (c.t - c.b));
    const seen = new Set();
    for (let x = Math.floor(c.l / cell); x <= Math.floor(c.r / cell); x++) {
      for (let y = Math.floor(c.b / cell); y <= Math.floor(c.t / cell); y++) {
        const key = x + ":" + y;
        for (const j of grid.get(key) || []) {
          if (seen.has(j)) continue;
          seen.add(j);
          const d = g.glyphs[j];
          if (adjacentKerning && Math.abs(c.i - d.i) === 1 && Math.abs(c.b - d.b) <= 0.5) continue;
          const iw = Math.min(c.r, d.r) - Math.max(c.l, d.l);
          const ih = Math.min(c.t, d.t) - Math.max(c.b, d.b);
          if (iw <= 0 || ih <= 0) continue;
          const other = Math.max(0.01, (d.r - d.l) * (d.t - d.b));
          if (iw * ih > 0.3 * Math.min(area, other)) count++;
        }
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  });
  return count;
}

// Header/footer glyphs of a page: whole text lines whose every glyph centre
// lies in the top or bottom band of the page's glyph extent. A line that
// straddles a band boundary is body text (typically the first or last body
// line) and is never split into an "edge" part and a body part.
export function edgeGlyphs(g) {
  if (!g.glyphs.length) return [];
  const lo = Math.min(...g.glyphs.map((c) => c.b));
  const hi = Math.max(...g.glyphs.map((c) => c.t));
  const band = EDGE_BAND * g.H;
  const inBottom = (c) => (c.b + c.t) / 2 <= lo + band;
  const inTop = (c) => (c.b + c.t) / 2 >= hi - band;
  const keep = new Set();
  for (const line of glyphLines(g.glyphs)) {
    if (line.every(inBottom) || line.every(inTop)) for (const c of line) keep.add(c);
  }
  return g.glyphs.filter((c) => keep.has(c));
}

// Boxes of the paragraphs a page model classifies as body (see classify)
// that also reach out of the page's edge bands, so they cannot be a running
// header or footer: a body paragraph whose last lines sit in the bottom band
// of a dense page. null when model space is not plain user space.
function bodyBoxes(engine, pageIndex, g) {
  ensurePage(engine, pageIndex);
  if (typeof engine.buildModel !== "function" || !uprightPage(engine) || !g.glyphs.length) return null;
  const paras = engine.buildModel();
  const boxes = paras.filter((p) => p.box).map((p) => p.box);
  const edgeBottomY = boxes.length ? Math.min(0, ...boxes.map(bottomOf)) : 0;
  const lo = Math.min(...g.glyphs.map((c) => c.b)) + EDGE_BAND * g.H;
  const hi = Math.max(...g.glyphs.map((c) => c.t)) - EDGE_BAND * g.H;
  return paras
    .filter((p) => p.box && classify(p, engine.pageHeight, edgeBottomY) === "body" && p.box.top > lo && bottomOf(p.box) < hi)
    .map((p) => p.box);
}

const inBoxes = (c, boxes) => {
  const x = (c.l + c.r) / 2, y = (c.b + c.t) / 2;
  return boxes.some((b) => x >= b.x - 0.5 && x <= b.x + b.w + 0.5 && y >= bottomOf(b) - 0.5 && y <= b.top + 0.5);
};

// Edge-band diagnosis that tells body text from headers and footers: edge
// glyphs inside body paragraphs of the source (or, for added glyphs, of the
// output) page count as body changes; every other source edge glyph must be
// in the output at its position and style, and no other glyph may appear in
// the output edge band. The split only names the failure accurately: body
// movement in an edge band is not shown to be authorized by it, so it still
// fails. Returns null when no page model is available.
function edgeBodySplit(src, out, i, oi, s, o, es, eo) {
  const sb = bodyBoxes(src, i, s), ob = bodyBoxes(out, oi, o);
  if (!sb || !ob) return null;
  const pending = new Map();
  for (const d of eo) pending.set(d.u, [...(pending.get(d.u) || []), d]);
  const at = (c) => {
    const list = pending.get(c.u) || [];
    const k = list.findIndex((d) => Math.abs(c.l - d.l) <= 0.5 && Math.abs(c.b - d.b) <= 0.5 && sameStyle(c.style ?? null, d.style ?? null));
    return k < 0 ? null : list.splice(k, 1)[0];
  };
  let bodyChanged = 0, edgeMissing = 0;
  for (const c of es) {
    if (at(c)) continue;
    if (inBoxes(c, sb)) bodyChanged++;
    else edgeMissing++;
  }
  let edgeAdded = 0;
  for (const list of pending.values()) {
    for (const d of list) {
      if (inBoxes(d, ob) || inBoxes(d, sb)) bodyChanged++;
      else edgeAdded++;
    }
  }
  return { bodyChanged, edgeMissing, edgeAdded };
}

function extents(g) {
  if (!g.glyphs.length) return null;
  return { left: Math.min(...g.glyphs.map((c) => c.l)), right: Math.max(...g.glyphs.map((c) => c.r)) };
}

// Apply each edit once to the whitespace-normalized source page text.
export function expectedPageText(sourceText, pageEdits, options = {}) {
  const norm = normStr(sourceText);
  let matchText = "";
  const matchMap = [];
  for (let i = 0; i < norm.length; i++) {
    const expanded = norm[i] === "\u0002" ? (norm[i + 1] === " " ? "-" : "- ") : norm[i];
    matchText += expanded;
    for (let j = 0; j < expanded.length; j++) matchMap.push(i);
  }
  let logicalText = "";
  const logicalMap = [];
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] === "\u0002") { if (norm[i+1] === " ") i++; continue; }
    logicalText += norm[i]; logicalMap.push(i);
  }
  const spans = [];
  for (const e of pageEdits) {
    const needle = normStr(e.before);
    const candidates = new Map();
    for (const [text, map] of [[matchText, matchMap], [logicalText, logicalMap]]) {
      for (let k = needle ? text.indexOf(needle) : -1; k >= 0; k = text.indexOf(needle, k + 1)) {
        const a = map[k], b = map[k + needle.length - 1] + 1;
        candidates.set(a + ":" + b, { a, b, after: normStr(e.after), id: e.id });
      }
    }
    if (candidates.size !== 1) return { ok: false, id: e.id, reason: candidates.size ? "before_ambiguous" : "before_not_found" };
    spans.push(candidates.values().next().value);
  }
  spans.sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].a < spans[i - 1].b) return { ok: false, id: spans[i].id, reason: "edits_overlap" };
  }
  let out = "", at = 0;
  for (const s of spans) {
    out += norm.slice(at, s.a) + s.after;
    at = s.b;
  }
  return { ok: true, text: normStr(out + norm.slice(at)), ...(options.includeSpans ? {spans:spans.map(s=>({...s}))} : {}) };
}

export async function inspectSavedPdf(engineFactory, sourceBytes, outputBytes, edits, options = {}) {
  const failures = [];
  const warnings = [];
  const pages = [];
  const report = { ok: false, independent: false, method: "same-pdfium-text-geometry", failures, warnings, pages };
  let src = null, out = null;
  try {
    src = await engineFactory();
    out = await engineFactory();
    src.open(sourceBytes);
    out.open(outputBytes);
    const map = normalizePageMap(options.sourcePageMap, src.pageCount);
    const expectedOut = map ? map.reduce((n, m) => n + 1 + m.continuationPageIndices.length, 0) : src.pageCount;
    report.page_count = { source: src.pageCount, output: out.pageCount, expected: expectedOut, added: expectedOut - src.pageCount };
    if (!map) failures.push({ code: "page_map_invalid" });
    if (out.pageCount !== expectedOut) failures.push({ code: expectedOut === src.pageCount ? "page_count_changed" : "page_count_mismatch" });
    const byPage = new Map();
    for (const e of edits || []) byPage.set(e.pageIndex, [...(byPage.get(e.pageIndex) || []), e]);
    for (const p of byPage.keys()) {
      if (!(p >= 0 && p < src.pageCount)) failures.push({ code: "edit_page_out_of_range", pageIndex: p });
    }
    const n = map && out.pageCount === expectedOut ? src.pageCount : map ? 0 : Math.min(src.pageCount, out.pageCount);
    let annotationModel=null;
    const annotationAdapter=options.annotationAdapter;
    if(annotationAdapter&&(options.flowGroups?.length??0)>0){
      if(!['inspect','transport','validate'].every(k=>typeof annotationAdapter[k]==='function'))throw new Error('document_flow_annotation_adapter_invalid');
      annotationModel=await annotationAdapter.inspect({sourceBytes,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex')});
      if(!annotationModel||!Array.isArray(annotationModel.annotations))throw new Error('document_flow_annotation_inventory_mismatch');
    }
    const annotationMoves=[];
    const grouped = inspectDocumentGroups(src, out, map, options.flowGroups ?? [], byPage, failures, warnings, !!options.includeText, annotationModel, annotationMoves);
    for (let i = 0; i < n; i++) {
      const m = map ? map[i] : { outputPageIndex: i, continuationPageIndices: [] };
      const s = readGlyphs(src, i);
      const o = readGlyphs(out, m.outputPageIndex);
      const pageEdits = byPage.get(i) || [];
      const row = { pageIndex: i, outputPageIndex: m.outputPageIndex, edited: pageEdits.length > 0 };
      pages.push(row);
      if (grouped.has(i)) {
        Object.assign(row, grouped.get(i));
        continue;
      }
      if (m.continuationPageIndices.length) {
        row.continuationPageIndices = [...m.continuationPageIndices];
        if (!pageEdits.length) failures.push({ code: "continuation_without_edit", pageIndex: i });
        else inspectContinued(s, o, out, m, pageEdits, row, failures, warnings, !!options.includeText);
        continue;
      }
      if (!pageEdits.length) {
        row.text_equal = normStr(s.text) === normStr(o.text);
        if (!row.text_equal) failures.push({ code: "unedited_page_text_changed", pageIndex: i });
        continue;
      }
      const exp = expectedPageText(s.text, pageEdits);
      if (!exp.ok) {
        failures.push({ code: "expected_text_uncomputable", pageIndex: i, id: exp.id, reason: exp.reason });
      } else {
        row.text_equal = exp.text === normStr(o.text);
        row.expected_text = digest(exp.text, options.includeText);
        if (!row.text_equal) failures.push({ code: "edited_page_text_or_order_mismatch", pageIndex: i });
        for (const e of pageEdits) {
          const t = normStr(o.text);
          if (normStr(e.after) && !t.includes(normStr(e.after))) failures.push({ code: "after_missing", pageIndex: i, id: e.id });
        }
      }
      row.offpage = { source: offPage(s), output: offPage(o) };
      if (row.offpage.output > row.offpage.source) failures.push({ code: "glyphs_off_page", pageIndex: i, count: row.offpage.output - row.offpage.source });
      row.overlap = { source: overlaps(s), output: overlaps(o) };
      if (row.overlap.output > row.overlap.source) failures.push({ code: "glyph_overlap_increased", pageIndex: i, count: row.overlap.output - row.overlap.source });
      const se = extents(s), oe = extents(o);
      row.extents = { source: se, output: oe };
      if (se && oe && (oe.right > se.right + TOL || oe.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i });
      const es = edgeGlyphs(s), eo = edgeGlyphs(o);
      const stable = sameGlyphs(es, eo) && sameStyles(es, eo);
      row.edge_glyphs = es.length;
      row.edge_stable = stable;
      if (!stable) {
        const edgeText = normStr(String.fromCharCode(...es.map((c) => c.u)));
        const editsEdge = pageEdits.some((e) => edgeText.replace(/ /g, "").includes(normStr(e.before).replace(/ /g, "")));
        const split = editsEdge ? null : edgeBodySplit(src, out, i, m.outputPageIndex, s, o, es, eo);
        if (split) row.edge_split = split;
        if (editsEdge) warnings.push({ code: "edge_edit_unverified", pageIndex: i });
        else if (!split || split.edgeMissing || split.edgeAdded) failures.push({ code: "header_footer_moved", pageIndex: i, ...(split || {}) });
        else failures.push({ code: "edge_band_body_changed", pageIndex: i, count: split.bodyChanged });
      }
    }
    if(annotationAdapter&&annotationModel){
      const verified=await annotationAdapter.validate({model:annotationModel,sourceBytes,outputBytes,sourcePageMap:map,moves:annotationMoves,reflowedSourcePages:[...grouped.keys()]});
      if(verified?.ok!==true)failures.push({code:typeof verified?.code==='string'&&/^[a-z_]{1,64}$/.test(verified.code)?verified.code:'document_flow_annotation_verification_failed'});
      report.annotationCheck={ok:verified?.ok===true,moves:annotationMoves.length};
    }
    report.ok = failures.length === 0;
    warnings.push({ code: "self_check_not_independent", detail: "same PDFium build; independent extraction and rendering review still required" });
  } catch (err) {
    failures.push({ code: "inspection_error", message: String(err?.message || err).slice(0, 200) });
    report.ok = false;
  } finally {
    try { src?.close(); } catch {}
    try { out?.close(); } catch {}
  }
  return report;
}

function inspectDocumentGroups(src, out, map, groups, byPage, failures, warnings, includeText, annotationModel=null, annotationMoves=[]) {
  const covered=new Map(), outputs=new Set();
  const bad=()=>failures.push({code:'document_flow_map_invalid'});
  if(!Array.isArray(groups)||groups.length>64){bad();return covered;}
  for(const group of groups){
    const ss=group?.sourcePages,oo=group?.outputPages;
    const band=b=>b&&['bodyTop','flowTop','floor','x0','x1'].every(k=>Number.isFinite(b[k]))&&b.bodyTop===b.flowTop&&b.bodyTop>b.floor&&b.x1>b.x0;
    if(group?.version!==1||!Array.isArray(ss)||ss.length<2||ss.length>64||src.pageCount>64||!Array.isArray(oo)||oo.length<ss.length||oo.length>ss.length+32||!Array.isArray(group.contentMap)||group.contentMap.length!==ss.length||!map){bad();continue;}
    const ids=ss.map(b=>b.sourcePageIndex),ois=oo.map(b=>b.outputPageIndex);
    const expectedOutputs=ss.flatMap(b=>map[b.sourcePageIndex]?[map[b.sourcePageIndex].outputPageIndex,...map[b.sourcePageIndex].continuationPageIndices]:[]);
    if(ss.some((b,k)=>!band(b)||!Number.isInteger(b.sourcePageIndex)||b.sourcePageIndex<0||b.sourcePageIndex>=src.pageCount||k&&b.sourcePageIndex!==ids[k-1]+1||covered.has(b.sourcePageIndex))
      ||oo.some((b,k)=>!band(b)||!Number.isInteger(b.outputPageIndex)||b.outputPageIndex<0||b.outputPageIndex>=out.pageCount||!Number.isInteger(b.lineCount)||b.lineCount<1||outputs.has(b.outputPageIndex)||k&&b.outputPageIndex!==ois[k-1]+1)
      ||JSON.stringify(ois)!==JSON.stringify(expectedOutputs)
      ||group.contentMap.some((c,k)=>c?.sourcePageIndex!==ids[k]||!Array.isArray(c.outputPageIndices)||!c.outputPageIndices.length||c.outputPageIndices.some((x,j)=>!ois.includes(x)||j&&x<=c.outputPageIndices[j-1])||JSON.stringify(c.outputPageIndices)!==JSON.stringify(map[c.sourcePageIndex].contentOutputPageIndices))){bad();continue;}
    // Reserve membership even when proof later fails: never reroute a failed
    // group into an unrelated weaker page-level continuation check.
    for(const i of ids)covered.set(i,{documentFlow:true,text_equal:false});for(const i of ois)outputs.add(i);
    // Report bands are evidence to validate, never geometry authority. Derive
    // all source bands from immutable source bytes with the producer's same
    // classifier, then derive destination/tail bands from those results.
    let derived;
    try {derived=ids.map(i=>deriveDocumentFlowBand(src,i,capturePageLayout,annotationModel));}
    catch {bad();continue;}
    const keys=['bodyTop','flowTop','floor','x0','x1'];
    const near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<=1e-4;
    const expectedX0=Math.min(...derived.map(b=>b.x0)),expectedX1=Math.max(...derived.map(b=>b.x1));
    if(ss.some((b,k)=>keys.some(key=>!near(b[key],derived[k][key])))
      ||oo.some((b,k)=>{
        const destination=derived[Math.min(k,derived.length-1)];
        return ['bodyTop','flowTop','floor'].some(key=>!near(b[key],destination[key]))||!near(b.x0,expectedX0)||!near(b.x1,expectedX1);
      })) {bad();continue;}
    try {
      const moves=deriveNativeLinkMoves(src,derived,savedLinkGlyphs(out,oo),[...byPage.values()].flat(),annotationModel,expectedPageText);
      annotationMoves.push(...moves);
      verifySavedUnderlines(out,derived,oo,moves);
    }catch(error){failures.push({code:error?.code??'document_flow_link_mapping_failed',pageIndex:ids[0]});}
    const source=ss.map(b=>readGlyphs(src,b.sourcePageIndex)),output=oo.map(b=>readGlyphs(out,b.outputPageIndex));
    const expected=[];let valid=true;
    for(let k=0;k<ss.length;k++){
      const b=ss[k],s=source[k],m=map[b.sourcePageIndex],o=output[ois.indexOf(m.outputPageIndex)];
      const fixed=outsideBand(s,b.floor-.5,b.bodyTop+.5),fixedOut=outsideBand(o,b.floor-.5,b.bodyTop+.5);
      const body=inBand(s,b.floor-.5,b.bodyTop+.5);
      if(!body.length||b.floor<0||b.bodyTop>s.H||b.x0<0||b.x1>s.W||Math.abs(Math.min(...body.map(c=>c.l))-b.x0)>.5||Math.abs(Math.max(...body.map(c=>c.r))-b.x1)>.5||Math.abs(Math.max(...body.map(c=>c.t))-b.bodyTop)>.5){bad();valid=false;}
      // Full-body scope: every excluded source glyph must be a physical edge.
      if(fixed.some(c=>(c.b+c.t)/2>s.H*.1&&(c.b+c.t)/2<s.H*.9)) {bad();valid=false;}
      if(!sameGlyphs(fixed,fixedOut)||!sameStyles(fixed,fixedOut))failures.push({code:'document_flow_fixed_content_changed',pageIndex:b.sourcePageIndex});
      const exp=expectedPageText(bandText(s,b.floor-.5,b.bodyTop+.5),byPage.get(b.sourcePageIndex)||[]);
      if(!exp.ok){failures.push({code:'expected_text_uncomputable',pageIndex:b.sourcePageIndex});valid=false;}else expected.push(exp.text);
      if(Math.abs(s.W-o.W)>.01||Math.abs(s.H-o.H)>.01)failures.push({code:'document_flow_page_size_changed',pageIndex:b.sourcePageIndex});
    }
    const want=normStr(expected.join(' '));
    if(oo.some((b,k)=>Math.abs(b.x0-Math.min(...ss.map(s=>s.x0)))>.01||Math.abs(b.x1-Math.max(...ss.map(s=>s.x1)))>.01||b.bodyTop!==ss[Math.min(k,ss.length-1)].bodyTop||b.floor!==ss[Math.min(k,ss.length-1)].floor)){bad();valid=false;}
    const parts=output.map((g,k)=>normStr(bandText(g,oo[k].floor-.5,oo[k].bodyTop+.5)));
    const actual=joinFlowParts(parts,want).text;
    let equal=valid&&actual===want;
    if(!equal&&valid){
      const chars=output.flatMap((g,k)=>[...(k?[{u:32,generated:true}]:[]),...g.chars.filter(c=>c.cy===null||c.cy>=oo[k].floor-.5&&c.cy<=oo[k].bodyTop+.5)]);
      equal=matchesGeneratedWhitespace(want,chars);
    }
    if(!equal)failures.push({code:'document_flow_text_or_order_mismatch',pageIndex:ids[0]});
    // Unedited source bodies must retain their exact glyph styles in the
    // known ordered output; selected edits alone may introduce new glyphs.
    const actualGlyphs=output.flatMap((g,k)=>inBand(g,oo[k].floor-.5,oo[k].bodyTop+.5));
    let glyphOffset=0;
    const outputRanges=output.map((g,k)=>{const start=glyphOffset;glyphOffset+=inBand(g,oo[k].floor-.5,oo[k].bodyTop+.5).length;return {start,end:glyphOffset,index:oo[k].outputPageIndex};});
    let position=0;
    for(let k=0;k<ss.length;k++){
      const start=position;
      const g=inBand(source[k],ss[k].floor-.5,ss[k].bodyTop+.5);
      const edits=byPage.get(ids[k])||[];
      const raw=g.map(c=>String.fromCharCode(c.u)).join('');
      if(!edits.length){
        const got=actualGlyphs.slice(position,position+g.length);
        if(got.length!==g.length||got.some((c,j)=>c.u!==g[j].u||!sameStyle(c.style,g[j].style)))failures.push({code:'document_flow_unchanged_style_mismatch',pageIndex:ids[k]});
        position+=g.length;
      }else{
        const spans=edits.map(e=>{const before=e.before.replace(/\s/g,''),after=e.after.replace(/\s/g,'');const at=raw.indexOf(before);return {at,before,after};}).sort((a,b)=>a.at-b.at);
        let expected=[],at=0,styleValid=true;
        for(const span of spans){
          const selected=g.slice(span.at,span.at+span.before.length);
          if(!span.before||span.at<at||raw.indexOf(span.before,span.at+1)!==-1||!selected.length||selected.some(c=>!sameStyle(c.style,selected[0].style))){styleValid=false;break;}
          expected.push(...g.slice(at,span.at),...[...span.after].map(c=>({u:c.charCodeAt(0),style:selected[0].style})));
          at=span.at+span.before.length;
        }
        expected.push(...g.slice(at));
        if(!styleValid)failures.push({code:'document_flow_style_unverifiable',pageIndex:ids[k]});
        const got=actualGlyphs.slice(position,position+expected.length);
        if(!styleValid||got.length!==expected.length||got.some((c,j)=>c.u!==expected[j].u||!sameStyle(c.style,expected[j].style)))failures.push({code:'document_flow_edited_style_mismatch',pageIndex:ids[k]});
        position+=expected.length;
      }
      const contentPages=outputRanges.filter(r=>r.start<position&&r.end>start).map(r=>r.index);
      if(JSON.stringify(contentPages)!==JSON.stringify(group.contentMap[k].outputPageIndices))failures.push({code:'document_flow_content_map_mismatch',pageIndex:ids[k]});
    }
    if(position!==actualGlyphs.length)failures.push({code:'document_flow_style_coverage_mismatch',pageIndex:ids[0]});
    for(let k=0;k<oo.length;k++){
      const b=oo[k],g=output[k],body=inBand(g,b.floor-.5,b.bodyTop+.5);
      if(body.some(c=>c.b<b.floor-.5||c.t>b.bodyTop+.5))failures.push({code:'document_flow_body_outside_band',outputPageIndex:b.outputPageIndex});
      if(countGlyphLines(body)!==b.lineCount)failures.push({code:'document_flow_line_count_mismatch',outputPageIndex:b.outputPageIndex});
      if(offPage(g))failures.push({code:'glyphs_off_page',outputPageIndex:b.outputPageIndex});
      if(body.some(c=>c.l<Math.min(...ss.map(b=>b.x0))-1||c.r>Math.max(...ss.map(b=>b.x1))+1))failures.push({code:'text_outside_source_columns',outputPageIndex:b.outputPageIndex});
      if(overlaps(g,true)>Math.max(...source.map(s=>overlaps(s,true))))failures.push({code:'glyph_overlap_increased',outputPageIndex:b.outputPageIndex});
      if(k>=ss.length){
        const last=source.at(-1),band=ss.at(-1),edge=outsideBand(g,b.floor-.5,b.bodyTop+.5);
        checkContinuationEdges(last,outsideBand(last,band.floor-.5,band.bodyTop+.5),g,edge,k-ss.length+1,ids.at(-1),b.outputPageIndex,failures);
      }
    }
    for(const i of ids)covered.set(i,{documentFlow:true,text_equal:equal,flowSourcePageIndices:ids,flowOutputPageIndices:ois,expected_text:digest(want,includeText)});
  }
  return covered;
}

const sameGlyphs = (a, b) => a.length === b.length && a.every((c, k) => {
  const d = b[k];
  return c.u === d.u && Math.abs(c.l - d.l) <= 0.5 && Math.abs(c.b - d.b) <= 0.5;
});

const digest = (text, includeText) => ({
  sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  chars: text.length,
  ...(includeText ? { text } : {}),
});

// Identity when absent. Otherwise one entry per source page whose output
// indices are consecutive from 0: [output, ...continuation] per source page.
export function normalizePageMap(map, sourcePageCount) {
  if (map === undefined || map === null) {
    return Array.from({ length: sourcePageCount }, (_, i) => ({ sourcePageIndex: i, outputPageIndex: i, continuationPageIndices: [] }));
  }
  if (!Array.isArray(map) || map.length !== sourcePageCount) return null;
  let next = 0;
  const out = [];
  for (let i = 0; i < map.length; i++) {
    const m = map[i];
    const cont = m?.continuationPageIndices ?? [];
    if (!m || m.sourcePageIndex !== i || m.outputPageIndex !== next || !Array.isArray(cont)) return null;
    next++;
    for (const c of cont) {
      if (c !== next) return null;
      next++;
    }
    if (cont.length && !(Number.isFinite(m.bodyTop) && Number.isFinite(m.floor) && m.bodyTop > m.floor)) return null;
    if (m.flowTop !== undefined && !(cont.length && Number.isFinite(m.flowTop) && m.flowTop > m.floor && m.flowTop <= m.bodyTop + 2)) return null;
    if (cont.length && !(Array.isArray(m.lineCounts) && m.lineCounts.length === cont.length)) return null;
    if (m.continuationStyle !== undefined && !(cont.length && validContinuationStyle(m.continuationStyle))) return null;
    out.push({ ...m, continuationPageIndices: [...cont] });
  }
  return out;
}

// The only continuation style: source running header/footer objects are
// copied unchanged and a standalone Arabic source page number gets a decimal
// suffix ("10" -> "10.1"). Exact shape, no extra keys.
export function validContinuationStyle(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).sort().join() === "applied,policy,version"
    && v.version === 1 && v.policy === "source-number-suffix" && v.applied === true;
}

// Text of the body band only: whitespace and line breaks are kept, glyphs
// whose centre lies outside [floor, bodyTop] (headers, footers, page
// numbers) are dropped so they can be compared separately by position.
function bandText(g, floor, bodyTop) {
  let t = "";
  for (const c of g.chars) if (c.cy === null || (c.cy >= floor && c.cy <= bodyTop)) t += String.fromCharCode(c.u);
  return t;
}

function outsideBand(g, floor, bodyTop) {
  return g.glyphs.filter((c) => {
    const cy = (c.b + c.t) / 2;
    return cy < floor || cy > bodyTop;
  });
}

function inBand(g, floor, bodyTop) {
  return g.glyphs.filter((c) => {
    const cy = (c.b + c.t) / 2;
    return cy >= floor && cy <= bodyTop;
  });
}

function byObject(glyphs) {
  const m = new Map();
  for (const c of glyphs) m.set(c.obj, [...(m.get(c.obj) || []), c]);
  return [...m.values()].map((cs) => cs.sort((a, b) => a.i - b.i));
}

const textOf = (cs) => String.fromCharCode(...cs.map((c) => c.u));

// Source page numbers: edge text objects whose visible glyphs are only
// Arabic digits. Two such objects with different values are ambiguous.
function sourcePageNumbers(es) {
  const groups = byObject(es).map((cs) => ({ glyphs: cs, text: textOf(cs), chars: cs.map((c) => ({ oy: c.oy ?? c.b })), bounds: { l: Math.min(...cs.map((c) => c.l)), r: Math.max(...cs.map((c) => c.r)), b: Math.min(...cs.map((c) => c.b)), t: Math.max(...cs.map((c) => c.t)) }, style: cs[0]?.style }));
  const fraction = resolvePageFraction(groups);
  const items = groups.filter((g) => /^\d+$/.test(g.text) && !fraction?.fixedNumbers.has(g));
  return { items, ambiguous: new Set(items.map((x) => x.text)).size > 1 };
}

// Alignment of a number from its advance-width extent on the page.
function numberAnchor(L, R, W) {
  const c = (L + R) / 2;
  return Math.abs(c - W / 2) <= 2 ? "center" : c > W / 2 ? "right" : "left";
}

const samePlace = (c, d) => c.u === d.u && Math.abs(c.l - d.l) <= 0.5 && Math.abs(c.r - d.r) <= 0.5 && Math.abs(c.b - d.b) <= 0.5 && Math.abs(c.t - d.t) <= 0.5;

// Expected edge content of continuation page `ordinal` (1-based) is derived
// from the SOURCE page only, never from the editor report: every source
// edge glyph at its source position and style, except each source page
// number, which must read "<source number>.<ordinal>" as one text object in
// the number's style and baseline, digits at their source spacing, suffix
// at natural advance, aligned on the number's source left, centre or right
// (by page position). Anything else outside the body band is extra.
function checkContinuationEdges(s, es, g, edge, ordinal, pageIndex, outputPageIndex, failures) {
  const fail = (code, extra = {}) => failures.push({ code, pageIndex, outputPageIndex, ...extra });
  const res = { expected_glyphs: 0, output_glyphs: edge.length, page_numbers: [] };
  if (!s.styled || !g.styled) {
    fail("continuation_edge_style_unverifiable");
    return res;
  }
  const numbers = sourcePageNumbers(es);
  if (numbers.ambiguous) {
    fail("continuation_page_number_ambiguous");
    return res;
  }
  const numbered = new Set(numbers.items.flatMap((x) => x.glyphs));
  const fixed = es.filter((c) => !numbered.has(c));
  res.expected_glyphs = fixed.length + numbers.items.reduce((n, x) => n + x.text.length + 1 + String(ordinal).length, 0);
  const left = [...edge];
  let missing = 0, styled = 0;
  for (const c of fixed) {
    const k = left.findIndex((d) => samePlace(c, d));
    if (k < 0) {
      missing++;
      continue;
    }
    if (!sameStyle(c.style, left[k].style)) styled++;
    left.splice(k, 1);
  }
  if (missing) fail("continuation_edge_missing", { count: missing });
  if (styled) fail("continuation_edge_style_mismatch", { count: styled });
  const groups = byObject(left);
  for (const x of numbers.items) {
    const sd = [...x.glyphs].sort((a, b) => a.l - b.l), ref = sd[0];
    const want = x.text + "." + ordinal;
    const k = groups.findIndex((cs) => cs[0].origin && ref.origin && Math.abs(cs[0].origin[1] - ref.origin[1]) <= 0.5);
    const rest = k < 0 ? [] : groups.splice(k, 1)[0];
    const pn = { source: x.text, expected: want, output: textOf(rest), anchor: null };
    res.page_numbers.push(pn);
    if (pn.output !== want) {
      fail("continuation_page_number_mismatch", { source: x.text });
      continue;
    }
    const off = rest.filter((c) => !sameStyle(ref.style, c.style)).length;
    if (off) fail("continuation_edge_style_mismatch", { count: off });
    const n = sd.length;
    let placed = rest.every((c, j) => c.origin && c.loose && Math.abs(c.origin[1] - ref.origin[1]) <= 0.5 && (j === 0 || Math.abs(c.loose[0] - rest[j - 1].loose[1]) <= 0.5 || j < n));
    for (let j = 0; placed && j < n; j++) {
      const c = rest[j], d = sd[j];
      if (c.u !== d.u || Math.abs(c.l - rest[0].l - (d.l - ref.l)) > 0.5 || Math.abs(c.r - c.l - (d.r - d.l)) > 0.5 || Math.abs(c.b - d.b) > 0.5 || Math.abs(c.t - d.t) > 0.5) placed = false;
    }
    if (placed && ref.loose && sd[n - 1].loose) {
      const L = ref.loose[0], R = sd[n - 1].loose[1], L2 = rest[0].loose[0], R2 = rest[rest.length - 1].loose[1];
      pn.anchor = numberAnchor(L, R, s.W);
      const err = pn.anchor === "left" ? L2 - L : pn.anchor === "right" ? R2 - R : (L2 + R2 - L - R) / 2;
      if (Math.abs(err) > 0.5) placed = false;
    } else {
      placed = false;
    }
    if (!placed) fail("continuation_page_number_moved", { source: x.text });
  }
  const extra = groups.reduce((n, cs) => n + cs.length, 0);
  if (extra) fail("continuation_edge_extra", { count: extra });
  return res;
}

// Text lines: glyphs grouped by vertical-centre membership, top first.
function glyphLines(glyphs) {
  const sorted = [...glyphs].sort((a, b) => b.t - a.t);
  const lines = [];
  let top = 0, bottom = 0;
  for (const c of sorted) {
    const cy = (c.b + c.t) / 2;
    if (lines.length && cy <= top && cy >= bottom) {
      bottom = Math.min(bottom, c.b);
      lines[lines.length - 1].push(c);
      continue;
    }
    lines.push([c]);
    top = c.t;
    bottom = c.b;
  }
  return lines;
}

// Measured text lines: glyphs grouped by vertical-centre membership.
export function countGlyphLines(glyphs) {
  return glyphLines(glyphs).length;
}

// Joins page parts in order. A part ending in "-" whose expected text has a
// soft hyphen (U+0002 from PDFium) at that point is the same hyphen object
// that PDFium renders as "-" at a page end; it is joined without a space.
// Every other boundary is a plain space.
export function joinFlowParts(parts, expected) {
  let acc = parts[0] ?? "";
  let softJoins = 0;
  for (const part of parts.slice(1)) {
    if (acc.endsWith("-") && expected.startsWith(acc.slice(0, -1) + "\u0002")) {
      acc = acc.slice(0, -1) + "\u0002" + part;
      softJoins++;
    } else {
      acc = acc + " " + part;
    }
  }
  return { text: normStr(acc), softJoins };
}

// PDFium may synthesize whitespace between adjacent text objects even when
// the caller's logical text has no space there. Only whitespace explicitly
// marked generated by PDFium may be skipped; typed whitespace, visible
// hyphens, character identity and order remain mandatory.
export function matchesGeneratedWhitespace(expected, chars) {
  const tokens = [];
  for (const c of chars) {
    const ch = String.fromCharCode(c.u);
    if (/\s/.test(ch)) {
      const prev = tokens[tokens.length - 1];
      if (prev?.ch === " ") prev.optional &&= c.generated === true;
      else tokens.push({ ch: " ", optional: c.generated === true });
    } else tokens.push({ ch, optional: false });
  }
  if (tokens[0]?.ch === " ") tokens.shift();
  if (tokens[tokens.length - 1]?.ch === " ") tokens.pop();
  const text = normStr(expected);
  let at = 0;
  for (const token of tokens) {
    if (token.ch === text[at]) at++;
    else if (!(token.ch === " " && token.optional)) return false;
  }
  return at === text.length;
}

// A source page whose flow continues on new pages: the body-band text of
// the output page followed by every continuation page must equal the
// source body-band text with the edits applied, in order; everything
// outside the band must be glyph-for-glyph where it was.
function inspectContinued(s, o, out, m, pageEdits, row, failures, warnings, includeText) {
  const i = row.pageIndex;
  const { floor, bodyTop } = m;
  const lo = floor - 0.5, hi = bodyTop + 0.5;
  const flowHi = m.flowTop === undefined ? hi : Math.min(hi, m.flowTop + 0.5);
  const exp = expectedPageText(bandText(s, lo, flowHi), pageEdits);
  if (flowHi < hi) {
    const fixed = (g) => g.glyphs.filter((c) => c.b + (c.t - c.b) / 2 > flowHi && c.b + (c.t - c.b) / 2 <= hi);
    const a = fixed(s), b = fixed(o);
    row.fixed_body_stable = sameGlyphs(a, b) && sameStyles(a, b);
    if (!row.fixed_body_stable) failures.push({ code: "fixed_body_above_flow_changed", pageIndex: i });
  }
  const conts = m.continuationPageIndices.map((k) => readGlyphs(out, k));
  // Every page of the flow is compared by its body band only; anything a
  // continuation page carries outside the band is checked as edge content.
  const parts = [normStr(bandText(o, lo, flowHi)), ...conts.map((g) => normStr(bandText(g, lo, hi)))];
  const joined = joinFlowParts(parts, exp.ok ? exp.text : "");
  const got = joined.text;
  row.body_band = { floor: +floor.toFixed(2), bodyTop: +bodyTop.toFixed(2) };
  row.soft_hyphen_page_joins = joined.softJoins;
  if (!exp.ok) {
    failures.push({ code: "expected_text_uncomputable", pageIndex: i, id: exp.id, reason: exp.reason });
  } else {
    row.text_equal = exp.text === got;
    const sourceWords = new Set([...bandText(s, lo, flowHi).matchAll(/([\p{L}]+)\u0002\s*([\p{L}]+)/gu)].map((m) => m[1] + m[2]));
    const expectedTypography = exp.text.replace(/([\p{L}]+)\u0002\s*([\p{L}]+)/gu, (raw, left, right) => sourceWords.has(left + right) ? left + right : raw);
    if (!row.text_equal) {
      const selected = (g, top) => g.chars.filter((c) => c.cy === null || c.cy >= lo && c.cy <= top);
      const actual = [selected(o, flowHi), ...conts.map((g) => selected(g, hi))]
        .flatMap((part, k) => k ? [{ u: 32, generated: true }, ...part] : part);
      // Remove an actual U+0002 and its line separator only for the exact
      // discretionary word proven by the source. Keep each surviving
      // character's generated-whitespace provenance; visible '-' is real.
      const raw = actual.map((c) => String.fromCharCode(c.u)).join("");
      const drop = new Set();
      for (const match of raw.matchAll(/([\p{L}]+)\u0002\s*([\p{L}]+)/gu)) {
        if (!sourceWords.has(match[1] + match[2])) continue;
        for (let k = match.index + match[1].length; k < match.index + match[0].length - match[2].length; k++) drop.add(k);
      }
      if (matchesGeneratedWhitespace(expectedTypography, actual.filter((_, k) => !drop.has(k)))) {
        row.text_equal = true;
        row.generated_whitespace_normalized = true;
        warnings.push({ code: "continued_flow_generated_whitespace_normalized", pageIndex: i, severity: "warning", detail: "Only source-proven discretionary markers and PDFium-generated extraction whitespace differ; requested characters, literal whitespace and order are preserved" });
      }
    }
    row.expected_text = digest(exp.text, includeText);
    row.output_parts = parts.map((p) => digest(p, includeText));
    if (!row.text_equal) failures.push({ code: "edited_flow_text_or_order_mismatch", pageIndex: i });
  }
  if (parts.slice(1).some((p) => !p)) failures.push({ code: "continuation_page_empty", pageIndex: i });
  const es = outsideBand(s, lo, hi), eo = outsideBand(o, lo, hi);
  row.edge_glyphs = es.length;
  row.edge_stable = sameGlyphs(es, eo) && sameStyles(es, eo);
  if (!row.edge_stable) failures.push({ code: "header_footer_moved", pageIndex: i });
  const se = extents(s);
  row.continuation = conts.map((g, k) => {
    const bodyGlyphs = inBand(g, lo, hi);
    const edge = outsideBand(g, lo, hi);
    const c = {
      outputPageIndex: m.continuationPageIndices[k],
      lines: { planned: m.lineCounts[k], measured: countGlyphLines(bodyGlyphs) },
      offpage: offPage(g),
      overlap: overlaps(g, true),
      outside_band: edge.length,
      // Column check on the body only: edge content is verified against the
      // source page position by position, and a page-number suffix may
      // legitimately extend past the source text extent.
      extents: extents({ glyphs: bodyGlyphs }),
      size: { W: g.W, H: g.H },
    };
    if (c.lines.planned !== c.lines.measured) failures.push({ code: "continuation_line_count_mismatch", pageIndex: i, outputPageIndex: c.outputPageIndex });
    if (c.offpage) failures.push({ code: "glyphs_off_page", pageIndex: i, outputPageIndex: c.outputPageIndex, count: c.offpage });
    if (c.overlap > overlaps(s, true)) failures.push({ code: "glyph_overlap_increased", pageIndex: i, outputPageIndex: c.outputPageIndex });
    if (m.continuationStyle) {
      c.edges = checkContinuationEdges(s, es, g, edge, k + 1, i, c.outputPageIndex, failures);
    } else if (c.outside_band) {
      failures.push({ code: "continuation_outside_body_band", pageIndex: i, outputPageIndex: c.outputPageIndex });
    }
    if (se && c.extents && (c.extents.right > se.right + TOL || c.extents.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i, outputPageIndex: c.outputPageIndex });
    if (Math.abs(g.W - s.W) > 0.01 || Math.abs(g.H - s.H) > 0.01) failures.push({ code: "continuation_page_size_mismatch", pageIndex: i, outputPageIndex: c.outputPageIndex });
    return c;
  });
  row.offpage = { source: offPage(s), output: offPage(o) };
  if (row.offpage.output > row.offpage.source) failures.push({ code: "glyphs_off_page", pageIndex: i, count: row.offpage.output - row.offpage.source });
  row.overlap = { source: overlaps(s, true), output: overlaps(o, true), excludes: "adjacent_same_baseline_pairs" };
  if (row.overlap.output > row.overlap.source) failures.push({ code: "glyph_overlap_increased", pageIndex: i, count: row.overlap.output - row.overlap.source });
  const oe = extents(o);
  if (se && oe && (oe.right > se.right + TOL || oe.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i });
}
