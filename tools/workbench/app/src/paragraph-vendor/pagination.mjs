// Continuation pages for long edits on the BentoPDF editcore.
//
// When a reflowed edit no longer fits above the page's footer floor, the
// edited paragraph and the body text that follows it on the same page form
// one flow. The flow is split by its actual line objects into the source
// page (shifted down, as cascade does) and new continuation pages inserted
// directly after the source page in the same document. Line objects are
// moved with FPDFPage_RemoveObject/FPDFPage_InsertObject, so fonts, runs,
// colours and source line pitch are the original objects' own; fonts are
// re-bound by object number into the new page's resources by PDFium's
// content generator.
//
// Scope is deliberately narrow: one top-level single-column body flow on an
// unrotated page with no crop/media offset and no Type3 segments. Anything
// else (multi-column, foreign images/paths or unassignable text inside the
// flow, edge paragraphs inside the flow, shared objects, form-XObject text)
// is reported as an explicit *_unsupported error before anything moves.
// Continuation pages carry the moved body lines plus source-style copies of
// the source page's edge text (running headers/footers in the source font,
// size, colour, render mode, matrix and position; a standalone Arabic page
// number as source number plus decimal suffix, see continuation-template.mjs).
// Original edge objects and page numbers are never moved or changed; no
// label is synthesized (see docs/PAGINATION.md for the page map contract).

import { CONTINUATION_STYLE, applyPageEdges, preflightPageEdges, snapshotPageEdges, verifyPageEdges } from "./continuation-template.mjs";

const OBJ_TEXT = 1;
const EPS = 0.01;

export const PAGINATION_LIMITS = Object.freeze({ defaultMaxNewPages: 8, maxNewPages: 32 });

export const PAGINATION_CAPABILITY = Object.freeze({
  supported: true,
  scope: "single-column top-level body text flow below the edited paragraph on unrotated, uncropped pages",
  continuationPages: "same size as the source page, inserted directly after it; moved body lines plus source-style copies of the source page's header/footer text; a standalone Arabic page number becomes source number plus decimal suffix (10.1, 10.2); no synthesized label",
  fixedEdgeGraphics: "graphics wholly within the physical edge band stay on the original page and are omitted on text-only continuations, with an explicit warning; body-intersecting graphics still refuse",
  sourcePageNumbers: "unchanged; existing page-number objects stay on their source page",
  continuationStyle: Object.freeze({ version: CONTINUATION_STYLE.version, policy: CONTINUATION_STYLE.policy }),
  downstreamPages: "never modified; only their output index shifts, see report.pagination.sourcePageMap",
  maxNewPagesDefault: PAGINATION_LIMITS.defaultMaxNewPages,
  maxNewPagesLimit: PAGINATION_LIMITS.maxNewPages,
  unsupported: Object.freeze([
    "multi_column_flow",
    "foreign_object_in_flow",
    "edge_paragraph_in_flow",
    "rotated_page",
    "cropped_or_offset_page",
    "type3_segments",
    "non_top_level_text",
    "shared_objects",
    "edge_graphics",
    "edge_clip",
    "edge_text_layout",
    "edge_style",
    "ambiguous_page_number",
    "page_number_spacing",
    "page_number_glyph_missing",
  ]),
});

const bottomOf = (b) => b.top - b.h;
const hOverlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const sameColumn = (a, b) => hOverlap(a, b) >= 0.35 * Math.min(a.w, b.w);

// Groups object boxes ({ top, bottom, order }) into lines by vertical centre
// membership. Zero-height boxes are returned as `loose` for attachment.
export function groupLines(items) {
  const seeds = items.filter((it) => it.top - it.bottom > EPS).sort((a, b) => b.top - a.top || a.order - b.order);
  const lines = [];
  for (const it of seeds) {
    const cy = (it.top + it.bottom) / 2;
    const l = lines[lines.length - 1];
    const lc = l ? (l.top + l.bottom) / 2 : 0;
    if (l && ((cy <= l.top + EPS && cy >= l.bottom - EPS) || (lc <= it.top + EPS && lc >= it.bottom - EPS))) {
      l.items.push(it);
      l.top = Math.max(l.top, it.top);
      l.bottom = Math.min(l.bottom, it.bottom);
    } else {
      lines.push({ top: it.top, bottom: it.bottom, items: [it] });
    }
  }
  return { lines, loose: items.filter((it) => !(it.top - it.bottom > EPS)) };
}

// Splits ordered flow lines (virtual positions after the in-page shift)
// into the source page (index 0) and continuation pages. Each continuation
// page starts with its first line's top at bodyTop. Pure and bounded: every
// page takes at least one line and at most maxNewPages pages are added.
export function planFlow(lines, { bodyTop, floor, maxNewPages }) {
  if (!(bodyTop > floor)) return { ok: false, code: "pagination_body_band_invalid" };
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (!((b.top + b.bottom) / 2 < (a.top + a.bottom) / 2 && b.top <= a.top + EPS)) return { ok: false, code: "pagination_flow_not_monotonic", line: i };
  }
  const pages = [{ offset: 0, lines: [] }];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const page = pages[pages.length - 1];
    if (l.bottom + page.offset >= floor - EPS) {
      page.lines.push(i);
      continue;
    }
    const offset = bodyTop - l.top;
    if (l.bottom + offset < floor - EPS) return { ok: false, code: "pagination_line_exceeds_body", line: i };
    if (pages.length - 1 >= maxNewPages) return { ok: false, code: "pagination_budget_exceeded", maxNewPages };
    pages.push({ offset, lines: [i] });
  }
  return { ok: true, pages };
}

function listObjects(M, page) {
  const n = M._FPDFPage_CountObjects(page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(page, i) >>> 0);
  return out;
}

function readBox(M, page, fn) {
  const p = M._malloc(16);
  try {
    if (!M[fn](page, p, p + 4, p + 8, p + 12)) return null;
    return [0, 1, 2, 3].map((k) => M.HEAPF32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}

// Rejects page geometry this module does not model. Returns a code or null.
export function unsupportedPage(engine) {
  const M = engine.M;
  if (engine._t3seg && Object.keys(engine._t3seg).length) return "pagination_unsupported_type3_segments";
  if (typeof M._FPDFPage_GetRotation === "function" && M._FPDFPage_GetRotation(engine.page) !== 0) return "pagination_unsupported_rotated_page";
  const t = engine.pageT || [1, 0, 0, 1, 0, 0];
  if ([1, 0, 0, 1, 0, 0].some((v, i) => Math.abs(t[i] - v) > 1e-4)) return "pagination_unsupported_cropped_or_offset_page";
  const media = typeof M._FPDFPage_GetMediaBox === "function" ? readBox(M, engine.page, "_FPDFPage_GetMediaBox") : null;
  if (media && (Math.abs(media[0]) > 1e-3 || Math.abs(media[1]) > 1e-3)) return "pagination_unsupported_cropped_or_offset_page";
  const crop = typeof M._FPDFPage_GetCropBox === "function" ? readBox(M, engine.page, "_FPDFPage_GetCropBox") : null;
  if (crop && media && crop.some((v, i) => Math.abs(v - media[i]) > 1e-3)) return "pagination_unsupported_cropped_or_offset_page";
  return null;
}

// Builds the flow plan without mutating anything. ctx comes from
// capturePageLayout (pre-commit); grown carries { id, box, delta } for each
// edited paragraph that grew. floor is the cascade's body floor.
export function buildFlowPlan(engine, ctx, grown, { floor, maxNewPages }) {
  const M = engine.M;
  const err = (code, extra = {}) => ({ ok: false, code, ...extra });
  const bad = unsupportedPage(engine);
  if (bad) return err(bad);
  const grownIds = new Set(grown.map((g) => g.id));
  const flowTop = Math.max(...grown.map((g) => g.box.top));
  const anchor = grown.find((g) => g.box.top === flowTop).box;
  const objects = listObjects(M, engine.page);
  const indexOf = new Map(objects.map((h, i) => [h, i]));
  const bounds = (h) => {
    const b = engine.objectBounds(h);
    return b ? { top: b.y + b.h, bottom: b.y, x: b.x, w: b.w } : null;
  };

  const owner = new Map();
  const current = new Map();
  for (const q of ctx.paras) {
    const hs = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
    current.set(q.id, hs);
    for (const h of hs) {
      if (owner.has(h) && owner.get(h) !== q.id) return err("pagination_unsupported_shared_objects");
      owner.set(h, q.id);
    }
  }

  const flow = [];
  for (const q of ctx.paras) {
    if (!q.box) continue;
    const cy = q.box.top - q.box.h / 2;
    const below = q.box.top <= flowTop + 0.5;
    if (q.role !== "body") {
      if (cy > floor + EPS && cy < flowTop && below) return err("pagination_unsupported_edge_paragraph_in_flow");
      continue;
    }
    if (!below) continue;
    if (!sameColumn(q.box, anchor)) return err("pagination_unsupported_multi_column_flow");
    if (!q.editable || q.sharesObjects) return err("pagination_unsupported_shared_objects");
    if (!q.topLevel && !grownIds.has(q.id)) return err("pagination_unsupported_non_top_level_text");
    flow.push(q);
  }
  flow.sort((a, b) => b.box.top - a.box.top || a.box.x - b.box.x);

  // In-page shift: the growth of every grown paragraph above (as cascade).
  const shiftOf = (q) => {
    let s = 0;
    for (const g of grown) {
      if (g.id === q.id || q.box.top > bottomOf(g.box) + 0.5 || !sameColumn(q.box, g.box)) continue;
      s += g.delta;
    }
    return s;
  };

  const lines = [];
  const untouchedLines = [];
  for (const q of flow) {
    const shift = shiftOf(q);
    const items = [];
    for (const h of current.get(q.id)) {
      if (!indexOf.has(h)) return err("pagination_unsupported_non_top_level_text");
      const b = bounds(h);
      if (!b) return err("pagination_unsupported_non_top_level_text");
      items.push({ h, order: indexOf.get(h), ...b });
    }
    const { lines: ls, loose } = groupLines(items);
    if (!ls.length && loose.length) ls.push({ top: Math.max(...loose.map((i) => i.top)), bottom: Math.min(...loose.map((i) => i.bottom)), items: [] });
    for (const it of loose) {
      const l = ls.find((x) => it.bottom <= x.top + 0.5 && it.bottom >= x.bottom - 0.5) || ls[ls.length - 1];
      l.items.push(it);
    }
    for (const l of ls) {
      const line = { para: q.id, shift, top: l.top, bottom: l.bottom, items: l.items };
      lines.push(line);
      if (!grownIds.has(q.id) && shift >= 0) untouchedLines.push(line);
    }
  }

  // Objects inside the flow band that no paragraph owns: soft hyphens and
  // empty spacing objects ride with the untouched line they sit on; any
  // other object there makes the flow ambiguous.
  let orphans = 0;
  for (const h of objects) {
    if (owner.has(h)) continue;
    const b = bounds(h);
    if (!b) return err("pagination_unsupported_foreign_object_in_flow");
    const cy = (b.top + b.bottom) / 2;
    if (cy < floor - EPS || cy > flowTop + 0.5) continue;
    if (b.x + b.w < anchor.x - 0.5 || b.x > anchor.x + anchor.w + 0.5) {
      return err("pagination_unsupported_multi_column_flow");
    }
    if (M._FPDFPageObj_GetType(h) !== OBJ_TEXT) {
      // A short zero-height link underline is an inline decoration, not a
      // foreign figure. Bind it only to one width-matching text object on
      // the current line; tables, filled shapes and ambiguous marks refuse.
      const hits = M._FPDFPageObj_GetType(h) === 2 && b.top - b.bottom <= EPS && b.w > EPS
        ? lines.filter((line) => {
          const size = ctx.paras.find((q) => q.id === line.para)?.size || 0;
          const text = line.items.filter((it) => {
            const cx = it.x + it.w / 2;
            return cx >= b.x - 3 && cx <= b.x + b.w + 3 && it.bottom - b.top >= -1 && it.bottom - b.top <= 0.4 * size;
          });
          const single = text.some((it) => Math.abs(it.x - b.x) <= 1 && Math.abs(it.x + it.w - b.x - b.w) <= 1);
          return size > 0 && b.w <= 2 * size && text.length && (single || Math.abs(Math.min(...text.map((it) => it.x)) - b.x) <= 3 && Math.abs(Math.max(...text.map((it) => it.x + it.w)) - b.x - b.w) <= 3);
        }) : [];
      if (hits.length !== 1) return err("pagination_unsupported_foreign_object_in_flow");
      hits[0].items.push({ h, order: indexOf.get(h), ...b });
      continue;
    }
    const l = untouchedLines.find((x) => cy <= x.top + 0.5 && cy >= x.bottom - 0.5);
    if (l) {
      l.items.push({ h, order: indexOf.get(h), ...b });
      continue;
    }
    if (b.top - b.bottom <= EPS && b.w <= EPS) {
      orphans++;
      continue;
    }
    return err("pagination_unsupported_foreign_object_in_flow");
  }

  let bodyTop = -Infinity;
  for (const q of ctx.paras) {
    if (q.role !== "body") continue;
    for (const h of current.get(q.id)) {
      const b = indexOf.has(h) ? bounds(h) : null;
      if (b && b.top - b.bottom > EPS) bodyTop = Math.max(bodyTop, b.top);
    }
  }
  const virtual = lines.map((l) => ({ top: l.top - l.shift, bottom: l.bottom - l.shift }));
  const split = planFlow(virtual, { bodyTop, floor, maxNewPages });
  if (!split.ok) return err(split.code, { line: split.line, maxNewPages: split.maxNewPages });
  // Paragraph boxes use font metrics; bodyTop is measured glyph ink. The
  // report's flow band must not begin above the measured body band merely
  // because an ascender metric extends farther than its actual glyphs.
  return { ok: true, lines, pages: split.pages, bodyTop, flowTop: Math.min(flowTop, bodyTop), floor, orphans, objects };
}

const coded = (code) => Object.assign(new Error(code), { code });

// Closes cached page handles above pageIndex; their content was generated
// when the engine switched away from them, and their cache keys are about
// to name different pages.
function evictPagesAfter(engine, pageIndex) {
  const M = engine.M;
  const cache = engine._pageCache;
  if (!cache) return;
  for (const [k, h] of [...cache.entries()]) {
    if (k <= pageIndex || !h || h === engine.page) continue;
    M._ec_history_drop_page?.(engine.session, h);
    M._FPDF_ClosePage(h);
    cache.delete(k);
  }
}

// Applies a flow plan: shift kept lines, generate the source page so every
// object has a content stream, then move continuation lines (in source
// object order) onto new pages inserted after pageIndex, between the
// source-style edge clones of the page edges. `edges` is the pre-mutation
// snapshotPageEdges result; the source page is re-snapshotted after its
// content is generated because font dealiasing there may replace edge
// objects (and their handles). Throws on any engine refusal or clone
// mismatch; the caller discards the whole document then.
export function applyFlowPlan(engine, pageIndex, plan, edges = null) {
  const M = engine.M;
  if (engine.pageIndex !== pageIndex) throw new Error("page_not_current");
  for (const [p, page] of plan.pages.entries()) {
    for (const i of page.lines) {
      const l = plan.lines[i];
      const dy = -l.shift + (p ? page.offset : 0);
      if (Math.abs(dy) < 1e-6) continue;
      for (const it of l.items) engine.translateObject(it.h, 0, dy);
    }
  }
  engine._pageDirty = true;
  if (!engine.generateContent()) throw new Error("source_generate_failed");
  const added = plan.pages.length - 1;
  const lineCounts = [];
  if (added > 0) {
    if (edges) {
      const fresh = snapshotPageEdges(engine, plan.floor, plan.bodyTop);
      if (!fresh.ok) throw coded(fresh.code);
      const key = (s) => JSON.stringify(s.items.map((i) => [i.role, i.text, i.chars.map((c) => [c.u, c.ox.toFixed(2), c.oy.toFixed(2)])]));
      if (key(fresh) !== key(edges)) throw coded("continuation_edge_snapshot_drift");
      const pre = preflightPageEdges(engine, fresh, added);
      if (!pre.ok) throw coded(pre.code);
      edges = fresh;
    }
    evictPagesAfter(engine, pageIndex);
    const W = engine.pageWidth, H = engine.pageHeight;
    const before = M._FPDFPage_CountObjects(engine.page);
    let movedTotal = 0;
    let copiedEdges = 0;
    for (let p = 1; p <= added; p++) {
      const np = M._FPDFPage_New(engine.doc, pageIndex + p, W, H);
      if (!np) throw new Error("page_new_failed");
      try {
        const now = new Map(listObjects(M, engine.page).map((h, i) => [h, i]));
        const handles = plan.pages[p].lines.flatMap((i) => plan.lines[i].items.map((it) => it.h));
        if (handles.some((h) => !now.has(h))) throw new Error("object_not_on_source_page");
        handles.sort((a, b) => now.get(a) - now.get(b));
        // Edge clones keep their source stream position relative to the body.
        const bodyIndex = edges ? Math.min(...handles.map((h) => edges.order.get(h) ?? Infinity)) : Infinity;
        const applied = edges ? applyPageEdges(engine, np, edges, p, bodyIndex) : { ok: true, items: [], bodyAt: 0 };
        if (!applied.ok) throw coded(applied.code);
        // Clones first get their own content stream; see applyPageEdges.
        if (applied.items.length && !M._FPDFPage_GenerateContent(np)) throw new Error("continuation_generate_failed");
        let at = applied.bodyAt;
        for (const h of handles) {
          if (!M._FPDFPage_RemoveObject(engine.page, h)) throw new Error("remove_failed");
          if (!M._FPDFPage_InsertObjectAtIndex(np, h, at++)) throw new Error("insert_failed");
        }
        if (M._FPDFPage_CountObjects(np) !== handles.length + applied.items.length) throw new Error("insert_count_mismatch");
        if (edges) {
          const proof = verifyPageEdges(engine, np, edges, p, applied);
          if (!proof.ok) throw coded(proof.code);
        }
        if (!M._FPDFPage_GenerateContent(np)) throw new Error("continuation_generate_failed");
        movedTotal += handles.length;
        copiedEdges += applied.items.length;
        lineCounts.push(plan.pages[p].lines.length);
      } finally {
        M._FPDF_ClosePage(np);
      }
    }
    if (M._FPDFPage_CountObjects(engine.page) !== before - movedTotal) throw new Error("source_count_mismatch");
    engine._pageDirty = true;
    if (!engine.generateContent()) throw new Error("source_generate_failed");
    // Drop the session's model of the old handle (it still names the moved
    // objects) and reload the page from the regenerated document.
    M._ec_history_drop_page?.(engine.session, engine.page);
    engine._pageStale = true;
    engine.buildModel();
    engine.pageCount = M._FPDF_GetPageCount(engine.doc);
    return { added, lineCounts, keptLines: plan.pages[0].lines.length, copiedEdges };
  }
  return { added, lineCounts, keptLines: plan.pages[0].lines.length, copiedEdges: 0 };
}

// quality.repairPageLayout hook: plan, then apply. Returns
// { ok, warnings, repairs, added, lineCounts, bodyTop, floor, continuationStyle }.
// Edge snapshot and suffix-glyph preflight run before anything moves, so
// unsupported edges are rejected with their specific code.
export function paginateOverflow(engine, ctx, grown, { floor, maxNewPages }) {
  const warnings = [];
  const repairs = [];
  const reject = (code, extra = {}) => {
    warnings.push({ code, severity: "error", ...extra });
    repairs.push({ kind: "pagination", action: "rejected", reason: code });
    return { ok: false, warnings, repairs, added: 0 };
  };
  const plan = buildFlowPlan(engine, ctx, grown, { floor, maxNewPages });
  if (!plan.ok) return reject(plan.code, plan.maxNewPages !== undefined ? { maxNewPages: plan.maxNewPages } : {});
  let edges = null;
  if (plan.pages.length > 1) {
    // Flow lines (including the grown paragraph still overflowing the
    // floor) are body, not edges.
    const flow = new Set(plan.lines.flatMap((l) => l.items.map((it) => it.h)));
    edges = snapshotPageEdges(engine, plan.floor, plan.bodyTop, flow);
    if (!edges.ok) return reject(edges.code);
    const pre = preflightPageEdges(engine, edges, plan.pages.length - 1);
    if (!pre.ok) return reject(pre.code);
  }
  let r;
  try {
    r = applyFlowPlan(engine, ctx.pageIndex, plan, edges);
  } catch (e) {
    warnings.push(e?.code ? { code: e.code, severity: "error" } : { code: "pagination_apply_failed", severity: "error", reason: String(e?.message || e).slice(0, 80) });
    repairs.push({ kind: "pagination", action: "failed" });
    return { ok: false, warnings, repairs, added: 0 };
  }
  if (edges?.fixedGraphics) warnings.push({ code: "continuation_fixed_edge_graphics_not_repeated", severity: "warning", count: edges.fixedGraphics, policy: "source-graphics-preserved-text-only-continuation" });
  if (plan.orphans) warnings.push({ code: "pagination_empty_objects_kept", severity: "info", count: plan.orphans });
  repairs.push({ kind: "pagination", action: r.added ? "continued" : "shifted", added: r.added, keptLines: r.keptLines, lineCounts: r.lineCounts, copiedEdges: r.copiedEdges, floor: +plan.floor.toFixed(2), bodyTop: +plan.bodyTop.toFixed(2) });
  const continuationStyle = r.added ? { version: CONTINUATION_STYLE.version, policy: CONTINUATION_STYLE.policy, applied: true } : undefined;
  return { ok: true, warnings, repairs, added: r.added, lineCounts: r.lineCounts, keptLines: r.keptLines, bodyTop: plan.bodyTop, flowTop: plan.flowTop, floor: plan.floor, continuationStyle };
}
