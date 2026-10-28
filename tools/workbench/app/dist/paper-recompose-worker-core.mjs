var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// app/src/paragraph-pdf-crypto.mjs
function rotr(x, n) {
  return (x >>> n | x << 32 - n) >>> 0;
}
function sha256(bytes) {
  const bitLen = bytes.length * 8, withPad = new Uint8Array(bytes.length + 9 + 63 >> 6 << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 128;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0, false);
  const H = Uint32Array.from([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const w = new Uint32Array(64);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ w[t - 15] >>> 3, s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ w[t - 2] >>> 10;
      w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f ^ ~e >>> 0 & g) >>> 0, t1 = h + s1 + ch + K[t] + w[t] >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b ^ a & c ^ b & c) >>> 0, t2 = s0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H[0] = H[0] + a >>> 0;
    H[1] = H[1] + b >>> 0;
    H[2] = H[2] + c >>> 0;
    H[3] = H[3] + d >>> 0;
    H[4] = H[4] + e >>> 0;
    H[5] = H[5] + f >>> 0;
    H[6] = H[6] + g >>> 0;
    H[7] = H[7] + h >>> 0;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
  return out;
}
var K, hex;
var init_paragraph_pdf_crypto = __esm({
  "app/src/paragraph-pdf-crypto.mjs"() {
    K = Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    hex = (bytes) => Array.from(sha256(bytes), (x) => x.toString(16).padStart(2, "0")).join("");
  }
});

// app/src/paper-furniture.mjs
var paper_furniture_exports = {};
__export(paper_furniture_exports, {
  buildFurniturePlan: () => buildFurniturePlan
});
function buildFurniturePlan({ document, flow, editedBlockIds = [] } = {}) {
  if (document?.schema !== "falsify.paper-document.v1" || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets) || flow?.schema !== "falsify.paper-flow.v1" || flow.sourceSha256 !== document.sourceSha256 || !Array.isArray(flow.items) || !Array.isArray(editedBlockIds)) throw new TypeError("Expected source-bound document and flow");
  const blocks = new Map([...document.blocks, ...flow.fragments || []].map((b) => [b.id, b]));
  const assets = new Map(document.assets.map((a) => [a.id, a]));
  const edited = new Set(editedBlockIds), diagnostics = [], pages = document.pages.map((p) => ({ sourcePage: p.sourcePageIndex, header: [], footer: [] }));
  const pageMap = new Map(document.pages.map((p, i) => [p.sourcePageIndex, { page: p, plan: pages[i] }]));
  const selected = /* @__PURE__ */ new Set();
  const isEdited = (b) => edited.has(b.id) || b.parentBlockId && edited.has(b.parentBlockId);
  const textEntry = (item, b, kind) => ({ kind, itemId: item.id, blockId: b.id, source: clone(b.source), bbox: clone(b.source.bbox), sourcePage: b.source.pageIndex, text: b.text, styleId: b.styleId ?? null, parentBlockId: b.parentBlockId ?? null });
  const add = (item, edge, entry) => {
    pageMap.get(item.source.pageIndex).plan[edge].push(entry);
    selected.add(item.id);
  };
  for (const item of flow.items) {
    if (!["header", "footer"].includes(item.kind)) continue;
    const p = pageMap.get(item.source?.pageIndex)?.page, bs = (item.blockIds || []).map((id2) => blocks.get(id2));
    if (!p || item.inline || item.assetIds?.length || item.blockIds?.length !== 1 || !bs[0] || !bs[0].text || isEdited(bs[0]) || bs[0].source?.pageIndex !== item.source.pageIndex || JSON.stringify(bs[0].source?.bbox) !== JSON.stringify(item.source.bbox) || !inside(bs[0].source?.bbox, p) || !inside(item.source?.bbox, p)) {
      diagnostics.push({ code: "furniture-retained", itemId: item.id, reason: "edited or unsupported ownership or geometry" });
      continue;
    }
    const ordinary = flow.items.filter((x) => x.source?.pageIndex === item.source.pageIndex && ["paragraph", "heading"].includes(x.kind) && boxOK3(x.source?.bbox) && (x.blockIds || []).some((id2) => blocks.get(id2)?.text?.trim()));
    if (bs[0].kind !== item.kind && ordinary.some((x) => item.kind === "header" ? x.source.bbox[3] <= item.source.bbox[1] : x.source.bbox[1] >= item.source.bbox[3])) {
      diagnostics.push({ code: "furniture-retained", itemId: item.id, reason: "ordinary text outside inferred edge" });
      continue;
    }
    add(item, item.kind, textEntry(item, bs[0], "text"));
  }
  const nearEdge = (item, edge) => {
    const pair = pageMap.get(item.source?.pageIndex), box5 = item.source?.bbox;
    if (!pair || !inside(box5, pair.page)) return false;
    const refs = pair.plan[edge].filter((e) => e.kind === "text");
    if (!refs.length) return false;
    const near3 = refs.some((e) => box5[1] <= e.bbox[3] + 20 && box5[3] >= e.bbox[1] - 20);
    if (!near3) return false;
    const body = flow.items.filter((x) => x.source?.pageIndex === item.source.pageIndex && !["header", "footer", "asset"].includes(x.kind) && x.id !== item.id && (x.blockIds || []).some((id2) => blocks.get(id2)?.text) && boxOK3(x.source?.bbox));
    return edge === "header" ? body.every((x) => x.source.bbox[2] <= box5[0] || x.source.bbox[0] >= box5[2] || box5[3] <= x.source.bbox[1]) : body.every((x) => x.source.bbox[2] <= box5[0] || x.source.bbox[0] >= box5[2] || box5[1] >= x.source.bbox[3]);
  };
  const assetGroups = /* @__PURE__ */ new Map();
  for (const item of flow.items.filter((i) => i.kind === "asset")) {
    const as = (item.assetIds || []).map((id2) => assets.get(id2)), bs = (item.blockIds || []).map((id2) => blocks.get(id2));
    if (!as.length || as.some((a) => !a || a.kind !== "image" || a.source?.pageIndex !== item.source?.pageIndex) || bs.some((b) => !b || b.text || isEdited(b)) || bs.some((b) => !(b.assetIds || []).some((id2) => item.assetIds.includes(id2))) || item.captionIds?.length) continue;
    const keys = as.map((a) => {
      const c = a.content, png = bytesKey(c?.bytes), mask = c?.mask ? bytesKey(c.mask.bytes) : "none";
      return png && mask && c.representation === "mupdf-decoded-png" && Array.isArray(a.source.transform) ? [png, mask, c.width, c.height, c.alpha, a.source.bbox, a.source.transform] : null;
    });
    if (keys.some((x) => !x)) continue;
    const key = JSON.stringify([item.source.bbox, keys]);
    if (!assetGroups.has(key)) assetGroups.set(key, []);
    assetGroups.get(key).push(item);
  }
  for (const group of assetGroups.values()) {
    const first = group[0].assetIds.map((id2) => assets.get(id2).content);
    const identical = group.filter((item) => item.assetIds.every((id2, i) => {
      const c = assets.get(id2).content, ref = first[i];
      return sameBytes(c.bytes, ref.bytes) && (!c.mask && !ref.mask || c.mask && ref.mask && sameBytes(c.mask.bytes, ref.mask.bytes));
    }));
    if (new Set(identical.map((i) => i.source.pageIndex)).size < 2) continue;
    const supported = identical.filter((item) => nearEdge(item, "header") || nearEdge(item, "footer"));
    for (const item of identical) for (const edge of ["header", "footer"]) if (nearEdge(item, edge) || edge === "header" && supported.filter((peer) => nearEdge(peer, edge)).length >= 2 && !pageMap.get(item.source.pageIndex).plan[edge].some((e) => e.kind === "text") && inside(item.source.bbox, pageMap.get(item.source.pageIndex).page) && item.source.bbox[1] < pageMap.get(item.source.pageIndex).page.height * 0.12 && flow.items.filter((x) => x.source?.pageIndex === item.source.pageIndex && !["header", "footer", "asset"].includes(x.kind) && (x.blockIds || []).some((id2) => blocks.get(id2)?.text) && boxOK3(x.source.bbox)).every((x) => x.source.bbox[2] <= item.source.bbox[0] || x.source.bbox[0] >= item.source.bbox[2] || item.source.bbox[3] <= x.source.bbox[1])) {
      add(item, edge, { kind: "asset", itemId: item.id, source: clone(item.source), sourcePage: item.source.pageIndex, bbox: clone(item.source.bbox), blockIds: [...item.blockIds || []], assetIds: [...item.assetIds], renderAssetId: item.renderAssetId ?? null, assets: item.assetIds.map((id2) => ({ id: id2, source: clone(assets.get(id2).source) })) });
      break;
    }
  }
  const counters = /* @__PURE__ */ new Map();
  for (const item of flow.items) {
    if (selected.has(item.id) || item.kind !== "paragraph" || item.inline || item.assetIds?.length || item.blockIds?.length !== 1) continue;
    const b = blocks.get(item.blockIds[0]), pi = item.source?.pageIndex;
    if (!b || b.source?.pageIndex !== pi || JSON.stringify(b.source?.bbox) !== JSON.stringify(item.source?.bbox) || isEdited(b) || !nearEdge(item, "footer") || b.text.trim() !== `${pi + 1} / ${document.pages.length}` && b.text.trim() !== `${pi + 1}/${document.pages.length}`) continue;
    const style = (b.source.characters || []).map((c) => c.styleId).filter((id2, i, a) => i === 0 || id2 !== a[i - 1]);
    const key = JSON.stringify([b.source.bbox, b.styleId, style]);
    if (!counters.has(key)) counters.set(key, []);
    counters.get(key).push({ item, b });
  }
  for (const group of counters.values()) if (new Set(group.map((x) => x.item.source.pageIndex)).size >= 2) for (const { item, b } of group) add(item, "footer", textEntry(item, b, "counter"));
  const margins = { top: 36, right: 36, bottom: 36, left: 36 };
  for (const { sourcePage, header, footer } of pages) {
    const p = pageMap.get(sourcePage).page;
    for (const e of header) margins.top = Math.max(margins.top, e.bbox[3] + Math.max(4, e.bbox[3] - e.bbox[1]));
    for (const e of footer) margins.bottom = Math.max(margins.bottom, p.height - e.bbox[1] + Math.max(4, e.bbox[3] - e.bbox[1]));
  }
  if (document.pages.some((p) => margins.top + margins.bottom >= p.height || margins.left + margins.right >= p.width)) {
    diagnostics.push({ code: "furniture-impossible-space", margins: { ...margins }, pages: document.pages.filter((p) => margins.top + margins.bottom >= p.height || margins.left + margins.right >= p.width).map((p) => ({ sourcePage: p.sourcePageIndex, width: p.width, height: p.height })) });
    for (const p of pages) {
      p.header = [];
      p.footer = [];
    }
    selected.clear();
    margins.top = 36;
    margins.bottom = 36;
  }
  const excludedItemIds = flow.items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const excludedBlockIds = flow.items.filter((i) => selected.has(i.id)).flatMap((i) => i.blockIds || []);
  return { sourceSha256: document.sourceSha256, margins, pages, excludedBlockIds, excludedItemIds, diagnostics };
}
var boxOK3, inside, clone, bytesKey, sameBytes;
var init_paper_furniture = __esm({
  "app/src/paper-furniture.mjs"() {
    init_paragraph_pdf_crypto();
    boxOK3 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
    inside = (b, p) => boxOK3(b) && b[0] >= 0 && b[1] >= 0 && b[2] <= p.width && b[3] <= p.height;
    clone = (value) => structuredClone(value);
    bytesKey = (b) => b instanceof Uint8Array && b.length ? `${b.length}:${hex(b)}` : null;
    sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);
  }
});

// app/src/paper-document.mjs
init_paragraph_pdf_crypto();
import * as mupdf from "./browser-pdf-vendor/mupdf.js";
var HASH = /^[a-f0-9]{64}$/;
var MAX_BYTES = 25 * 1024 * 1024;
var id = (kind, value) => `${kind}-${hex(new TextEncoder().encode(JSON.stringify(value))).slice(0, 24)}`;
var checkAbort = (signal) => {
  if (signal?.aborted) {
    const e = new Error("Document reading cancelled");
    e.name = "AbortError";
    e.code = "aborted";
    throw e;
  }
};
var boxOK = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
var cloneBox = (b) => boxOK(b) ? [...b] : null;
var quadBox = (q) => q?.length === 8 ? [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])] : null;
function normalizeDocument({ sourceSha256, pages, signal } = {}) {
  checkAbort(signal);
  if (typeof sourceSha256 !== "string" || !HASH.test(sourceSha256) || !Array.isArray(pages)) throw new TypeError("Expected lowercase sourceSha256 and observed pages");
  const model = { schema: "falsify.paper-document.v1", sourceSha256, pages: [], blocks: [], styles: [], assets: [], relations: [], diagnostics: [] };
  const styles = /* @__PURE__ */ new Map();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    checkAbort(signal);
    const page = pages[pageIndex];
    if (!page || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 || !Array.isArray(page.blocks) || !Array.isArray(page.images)) throw new TypeError("Invalid observed page");
    let offset = 0, pageText = "";
    const blocks = [];
    for (let index = 0; index < page.blocks.length; index++) {
      checkAbort(signal);
      const item = page.blocks[index];
      if (!Array.isArray(item.chars)) throw new TypeError("Invalid observed block characters");
      const start = offset, chars = [], styleIds = [];
      let text = "";
      for (const c of item.chars) {
        if (typeof c.text !== "string") throw new TypeError("Invalid observed character");
        const from = offset;
        offset += c.text.length;
        text += c.text;
        const style = { fontName: typeof c.fontName === "string" ? c.fontName : null, size: Number.isFinite(c.size) ? c.size : null, color: Array.isArray(c.color) ? [...c.color] : null };
        const key = JSON.stringify(style);
        let styleId = styles.get(key);
        if (!styleId) {
          styleId = id("style", [sourceSha256, style]);
          styles.set(key, styleId);
          model.styles.push({ id: styleId, ...style });
        }
        styleIds.push(styleId);
        chars.push({ start: from, end: offset, bbox: cloneBox(c.bbox), styleId });
      }
      pageText += text;
      if (!text.length) continue;
      const bbox = cloneBox(item.bbox);
      if (!bbox || chars.some((c) => !c.bbox)) model.diagnostics.push({ code: "text-geometry-unavailable", pageIndex, blockIndex: index });
      if (item.lines && (!Array.isArray(item.lines) || item.lines.some((line) => !Number.isInteger(line.start) || !Number.isInteger(line.end) || line.start < 0 || line.start > line.end || line.end > chars.length))) throw new TypeError("Invalid observed line ranges");
      const lines = Array.isArray(item.lines) ? item.lines.map((line) => ({
        range: { start: line.start === chars.length ? offset : chars[line.start].start, end: line.end === 0 ? start : chars[line.end - 1].end },
        bbox: cloneBox(line.bbox),
        direction: Array.isArray(line.direction) ? [...line.direction] : null,
        writingMode: Number.isFinite(line.writingMode) ? line.writingMode : null,
        baseline: line.baseline ? line.baseline.map((p) => [...p]) : null
      })) : [];
      if (!lines.length) model.diagnostics.push({ code: "line-boundaries-unavailable", pageIndex, blockIndex: index });
      blocks.push({ id: id("block", [sourceSha256, pageIndex, start, offset]), kind: "paragraph", text, source: { pageIndex, bbox, range: { start, end: offset }, characters: chars, lines, readerPosition: Number.isInteger(item.readerPosition) ? item.readerPosition : null }, styleId: styleIds.every((s) => s === styleIds[0]) ? styleIds[0] : null, assetIds: [], captionIds: [] });
    }
    let ordered = blocks, gutter = null;
    if (blocks.length >= 2 && blocks.every((b) => b.source.bbox)) {
      const edges = [...new Set(blocks.flatMap((b) => [b.source.bbox[0], b.source.bbox[2]]))].sort((a, b) => a - b);
      const candidates = [];
      for (let i = 0; i < edges.length - 1; i++) {
        const l = edges[i], r = edges[i + 1], mid = (l + r) / 2;
        if (r - l >= Math.max(12, page.width * 0.025) && blocks.every((b) => b.source.bbox[2] <= mid || b.source.bbox[0] >= mid)) {
          const left = blocks.filter((b) => b.source.bbox[2] <= mid), right = blocks.filter((b) => b.source.bbox[0] >= mid);
          if (left.length >= 2 && right.length >= 2 && Math.max(...left.map((b) => b.source.bbox[3])) >= Math.min(...right.map((b) => b.source.bbox[1])) && Math.max(...right.map((b) => b.source.bbox[3])) >= Math.min(...left.map((b) => b.source.bbox[1]))) candidates.push({ l, r, left, right });
        }
      }
      if (candidates.length === 1) {
        const c = candidates[0];
        gutter = [c.l, c.r];
        const order = (a, b) => a.source.bbox[1] - b.source.bbox[1] || a.source.bbox[0] - b.source.bbox[0] || a.source.range.start - b.source.range.start;
        ordered = [...c.left.sort(order), ...c.right.sort(order)];
      }
    }
    if (!gutter && blocks.length > 1) model.diagnostics.push({ code: "reading-order-unresolved", pageIndex, detail: "Reader order retained; no unique page-wide column gutter established." });
    model.pages.push({ sourcePageIndex: pageIndex, width: page.width, height: page.height, text: pageText, geometry: page.geometry ?? { frame: "caller-observed", originalPageMapping: "unverified" }, readingOrder: gutter ? "geometry-columns" : "reader", columnGutter: gutter });
    if (gutter) model.diagnostics.push({ code: "reading-order-heuristic", pageIndex, detail: "Column gutter ordering is geometric, not semantic proof." });
    if (page.geometry?.originalPageMapping !== "verified") model.diagnostics.push({ code: "original-page-geometry-unverified", pageIndex, detail: "Source boxes are in the observed frame; mapping to original PDF coordinates is not established." });
    model.blocks.push(...ordered);
    for (let index = 0; index < page.images.length; index++) {
      const image = page.images[index], bbox = cloneBox(image.bbox), assetId = id("asset", [sourceSha256, pageIndex, index, bbox]);
      const source = { pageIndex, bbox, occurrence: index, readerPosition: Number.isInteger(image.readerPosition) ? image.readerPosition : null, transform: Array.isArray(image.transform) ? [...image.transform] : null };
      model.assets.push({ id: assetId, kind: "image", source, content: image.content ?? null });
      model.blocks.push({ id: id("figure", [sourceSha256, pageIndex, index, bbox]), kind: "figure", text: "", source, styleId: null, assetIds: [assetId], captionIds: [] });
      if (!bbox) model.diagnostics.push({ code: "image-geometry-unavailable", pageIndex, occurrence: index });
      if (!image.content) model.diagnostics.push({ code: "image-content-unavailable", pageIndex, occurrence: index });
    }
    if (!blocks.length) model.diagnostics.push({ code: "no-extracted-text", pageIndex });
  }
  model.diagnostics.push({ code: "font-program-unavailable", detail: "Structured-text Font exposes observed names, not source font programs or verified PDF resource identity." });
  model.diagnostics.push({ code: "semantic-structure-unavailable", detail: "Text block kinds are placeholders; caption links, vector assets and OCR are not recovered." });
  return model;
}
function probeOcclusion(bytes, model, pageIndex, asset, signal) {
  const pageInfo = model.pages[pageIndex], box5 = asset.source.bbox, transform = pageInfo.geometry?.pageTransform;
  if (!boxOK(box5) || !transform || transform[1] !== 0 || transform[2] !== 0 || pageInfo.width * pageInfo.height * 4 > 12e6) return null;
  const source = model.blocks.filter((b) => b.text && b.source.pageIndex === pageIndex).flatMap((b) => b.source.characters.map((c) => ({ c, text: pageInfo.text.slice(c.start, c.end) })));
  const overlaps5 = (b) => boxOK(b) && b[0] < box5[2] && box5[0] < b[2] && b[1] < box5[3] && box5[1] < b[3];
  if (!source.some((x) => overlaps5(x.c.bbox))) return null;
  let doc, page, annot, st, pix;
  try {
    checkAbort(signal);
    doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
    page = doc.loadPage(pageIndex);
    const raster = () => {
      pix = page.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
      try {
        return { width: pix.getWidth(), height: pix.getHeight(), pixels: Uint8Array.from(pix.getPixels()) };
      } finally {
        pix.destroy();
        pix = null;
      }
    };
    const before = raster();
    annot = page.createAnnotation("Redact");
    annot.setRect(box5);
    annot.update();
    page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    const after = raster();
    if (before.width !== after.width || before.height !== after.height || before.pixels.length !== after.pixels.length || before.pixels.some((v, i) => v !== after.pixels[i])) return null;
    st = page.toStructuredText("preserve-whitespace,preserve-images");
    const remaining = [];
    st.walk({ onChar(text, origin, font, size, quad) {
      remaining.push({ text, bbox: quadBox(quad) });
    }, onImageBlock(b, t, image) {
      image.destroy();
    } });
    const matched = /* @__PURE__ */ new Set();
    for (const x of remaining) {
      const candidates = [];
      for (let i = 0; i < source.length; i++) {
        const y = source[i];
        if (!matched.has(i) && String.fromCharCode(y.text.codePointAt(0)) === x.text && y.c.bbox?.every((v, j) => Math.abs(v - x.bbox[j]) < 0.02)) candidates.push(i);
      }
      if (candidates.length !== 1) return null;
      matched.add(candidates[0]);
    }
    const removed = source.filter((x, i) => !matched.has(i));
    if (!removed.length || removed.some((x) => !overlaps5(x.c.bbox))) return null;
    const ranges = [];
    for (const x of removed) {
      const last = ranges.at(-1);
      if (last && last.end === x.c.start) last.end = x.c.end;
      else ranges.push({ start: x.c.start, end: x.c.end });
    }
    return { sourceSha256: model.sourceSha256, pageIndex, assetId: asset.id, bbox: [...box5], ranges, proof: { scale: 2, changedChannels: 0, removedCharacters: removed.length } };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return null;
  } finally {
    pix?.destroy();
    st?.destroy();
    annot?.destroy();
    page?.destroy();
    doc?.destroy();
  }
}
async function readDocument({ file, fileHash, signal } = {}) {
  checkAbort(signal);
  if (fileHash !== void 0 && (typeof fileHash !== "string" || !/^[a-f0-9]{64}$/i.test(fileHash))) throw new TypeError("fileHash must be a SHA-256 hex digest");
  if (Number.isFinite(file?.size) && file.size > MAX_BYTES) throw new Error("PDF exceeds 25 MiB");
  const bytes = file instanceof Uint8Array ? new Uint8Array(file) : file?.bytes instanceof Uint8Array ? new Uint8Array(file.bytes) : typeof file?.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : null;
  checkAbort(signal);
  if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error("Expected a PDF within 25 MiB");
  const sourceSha256 = hex(bytes);
  if (fileHash && sourceSha256 !== fileHash.toLowerCase()) {
    const e = new Error("Source hash mismatch");
    e.code = "stale-source";
    throw e;
  }
  let doc;
  const pages = [];
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
    if (!doc || doc.needsPassword()) throw new Error("Unsupported PDF");
    for (let i = 0; i < doc.countPages(); i++) {
      checkAbort(signal);
      let page, st;
      try {
        page = doc.loadPage(i);
        const bounds = page.getBounds();
        if (bounds[0] !== 0 || bounds[1] !== 0) throw new Error("Unsupported page origin");
        const observed = { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], geometry: { frame: "mupdf-display", bounds: [...bounds], pageTransform: [...page.getTransform()], originalPageMapping: "unverified" }, blocks: [], images: [] };
        let block, line, readerPosition = 0;
        st = page.toStructuredText("preserve-whitespace,preserve-images");
        st.walk({
          beginTextBlock(bbox) {
            checkAbort(signal);
            block = { bbox: [...bbox], chars: [], lines: [], readerPosition: readerPosition++ };
            observed.blocks.push(block);
          },
          beginLine(bbox, writingMode, direction) {
            checkAbort(signal);
            line = { bbox: [...bbox], writingMode, direction: [...direction], start: block.chars.length, end: block.chars.length, baseline: null };
            block.lines.push(line);
          },
          onChar(text, origin, font, size, quad, color) {
            checkAbort(signal);
            if (!block || !line) throw new Error("Unexpected character outside text line");
            block.chars.push({ text, bbox: quadBox(quad), fontName: font.getName(), size, color: color ? [...color] : null });
            line.end = block.chars.length;
            const point = [...origin];
            if (!line.baseline) line.baseline = [point, point];
            else line.baseline[1] = point;
          },
          endLine() {
            line = null;
          },
          endTextBlock() {
            block = null;
          },
          onImageBlock(bbox, transform, image) {
            checkAbort(signal);
            let pixmap, mask, maskPixmap, content = null;
            try {
              pixmap = image.toPixmap();
              mask = image.getMask();
              if (mask) maskPixmap = mask.toPixmap();
              content = { representation: "mupdf-decoded-png", bytes: pixmap.asPNG().slice(), width: pixmap.getWidth(), height: pixmap.getHeight(), alpha: !!pixmap.getAlpha(), mask: maskPixmap ? { bytes: maskPixmap.asPNG().slice(), width: maskPixmap.getWidth(), height: maskPixmap.getHeight(), alpha: !!maskPixmap.getAlpha() } : null };
            } catch {
            } finally {
              maskPixmap?.destroy();
              mask?.destroy();
              pixmap?.destroy();
              image.destroy();
            }
            observed.images.push({ bbox: [...bbox], transform: [...transform], readerPosition: readerPosition++, content });
          }
        });
        let scalarText;
        try {
          const json = JSON.parse(st.asJSON());
          if (!Array.isArray(json.blocks)) throw new Error("Missing blocks");
          scalarText = json.blocks.filter((b) => b.type === "text").flatMap((b) => {
            if (!Array.isArray(b.lines)) throw new Error("Missing lines");
            return b.lines.flatMap((l) => {
              if (typeof l.text !== "string") throw new Error("Missing text");
              return [...l.text];
            });
          });
          const chars = observed.blocks.flatMap((b) => b.chars);
          if (chars.length !== scalarText.length || scalarText.some((s, j) => {
            const cp = s.codePointAt(0);
            return cp >= 55296 && cp <= 57343 || chars[j].text !== String.fromCharCode(cp);
          })) throw new Error("Reader streams differ");
          chars.forEach((c, j) => {
            c.text = scalarText[j];
          });
        } catch (cause) {
          const e = new Error("Unicode-preserving structured text correspondence unavailable", { cause });
          e.code = "unicode-extraction-unavailable";
          throw e;
        }
        pages.push(observed);
      } finally {
        st?.destroy();
        page?.destroy();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    doc?.destroy();
  }
  checkAbort(signal);
  const model = normalizeDocument({ sourceSha256, pages, signal });
  model.occlusions = [];
  for (const [index, asset] of model.assets.entries()) {
    checkAbort(signal);
    const b = asset.source.bbox, pi = asset.source.pageIndex;
    const candidate = boxOK(b) && model.blocks.some((x) => x.text && x.source.pageIndex === pi && x.source.characters.some((c) => boxOK(c.bbox) && c.bbox[0] < b[2] && b[0] < c.bbox[2] && c.bbox[1] < b[3] && b[1] < c.bbox[3]));
    if (!candidate) continue;
    const evidence = index < 32 ? probeOcclusion(bytes, model, pi, asset, signal) : null;
    if (evidence) model.occlusions.push(evidence);
    else model.diagnostics.push({ code: "occlusion-unavailable", pageIndex: pi, assetId: asset.id, detail: "Candidate did not establish unchanged raster and unambiguous removed source characters." });
  }
  return model;
}

// app/src/paper-source-spacing.mjs
init_paragraph_pdf_crypto();
var abort = (signal) => {
  if (signal?.aborted) throw new DOMException("Source spacing cancelled", "AbortError");
};
var near = (a, b, t = 0.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= t;
var validBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
var strip = (text) => text.replace(/\s/gu, "");
async function recoverSourceSpaces({ bytes, document, pdfjs, signal } = {}) {
  abort(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document) throw new TypeError("Expected source bytes and document");
  const sourceSha256 = hex(bytes);
  if (document.sourceSha256 !== sourceSha256) {
    const e = new Error("Source hash mismatch");
    e.code = "stale-source";
    throw e;
  }
  const view = structuredClone(document), evidence = { pages: 0, matchedLines: 0, hints: 0 };
  for (const b of view.blocks || []) if (b.source) delete b.source.wordSpaceOffsets;
  if (!pdfjs?.getDocument) return { document: view, sourceSha256, evidence };
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise;
    abort(signal);
    if (pdf.numPages !== view.pages?.length) return { document: view, sourceSha256, evidence };
    for (let p = 0; p < pdf.numPages; p++) {
      abort(signal);
      const page = await pdf.getPage(p + 1);
      try {
        const vp = page.getViewport({ scale: 1 }), model = view.pages[p], frame = model?.geometry;
        if (frame?.frame !== "mupdf-display" || !Array.isArray(frame.pageTransform) || !Array.isArray(vp.transform) || frame.pageTransform.length !== 6 || vp.transform.length !== 6 || !frame.pageTransform.every((v, i) => near(v, vp.transform[i], 0.01)) || !near(model.width, vp.width, 0.01) || !near(model.height, vp.height, 0.01)) continue;
        evidence.pages++;
        const content = await page.getTextContent();
        abort(signal);
        const lines = [];
        for (const b of view.blocks || []) if (b.source?.pageIndex === p && typeof b.text === "string") for (const line of b.source.lines || []) {
          const r = line.range, base = line.baseline, range = b.source.range;
          if (!r || !range || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < range.start || r.end > range.end || r.start >= r.end || line.writingMode !== 0 || !Array.isArray(line.direction) || !near(line.direction[0], 1, 0.01) || !near(line.direction[1], 0, 0.01) || !Array.isArray(base) || base.length !== 2 || !near(base[0]?.[1], base[1]?.[1], 0.1)) continue;
          const chars = (b.source.characters || []).filter((c) => c.start >= r.start && c.end <= r.end);
          if (!chars.length || chars.some((c) => !validBox(c.bbox)) || chars[0].start !== r.start || chars.at(-1).end !== r.end || chars.some((c, i) => i && c.start !== chars[i - 1].end)) continue;
          const text = b.text.slice(r.start - range.start, r.end - range.start);
          if (view.pages[p].text?.slice(r.start, r.end) !== text) continue;
          lines.push({ b, r, base, chars, text });
        }
        for (const item of content.items || []) {
          if (typeof item.str !== "string" || !/\s/u.test(item.str) || item.dir !== "ltr" || !Array.isArray(item.transform) || item.transform.length !== 6 || !item.transform.every(Number.isFinite) || !near(item.transform[1], 0, 0.01) || !near(item.transform[2], 0, 0.01) || !Number.isFinite(item.width) || item.width <= 0) continue;
          const x = vp.transform[0] * item.transform[4] + vp.transform[2] * item.transform[5] + vp.transform[4], y = vp.transform[1] * item.transform[4] + vp.transform[3] * item.transform[5] + vp.transform[5];
          const candidates = lines.filter((l2) => near(l2.base[0][1], y, 0.5) && near(l2.chars[0].bbox[0], x, 1) && near(l2.chars.at(-1).bbox[2], x + item.width, 2) && strip(l2.text) === strip(item.str));
          if (candidates.length !== 1) continue;
          const l = candidates[0];
          const same2 = (content.items || []).filter((q) => q !== item && typeof q.str === "string" && Array.isArray(q.transform) && near(q.transform[4], item.transform[4], 0.5) && near(q.transform[5], item.transform[5], 0.5) && strip(q.str) === strip(item.str));
          if (same2.length) continue;
          const raw = [];
          for (let i = 0; i < l.text.length; i++) if (!/\s/u.test(l.text[i])) raw.push(i);
          let n = 0, pending = false;
          const offsets = [];
          for (let i = 0; i < item.str.length; i++) {
            if (/\s/u.test(item.str[i])) {
              if (n) pending = true;
              continue;
            }
            const pos = raw[n++];
            if (pending && n > 1 && pos === raw[n - 2] + 1) offsets.push(l.r.start + pos);
            pending = false;
          }
          if (offsets.length) {
            l.b.source.wordSpaceOffsets = [.../* @__PURE__ */ new Set([...l.b.source.wordSpaceOffsets || [], ...offsets])].sort((a, b) => a - b);
            evidence.hints += offsets.length;
          }
          evidence.matchedLines++;
        }
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await task.destroy();
  }
  abort(signal);
  return { document: view, sourceSha256, evidence };
}

// app/src/paper-source-links.mjs
init_paragraph_pdf_crypto();
import * as mupdf2 from "./browser-pdf-vendor/mupdf.js";
var abort2 = (signal) => {
  if (signal?.aborted) {
    const e = new Error("Source link reading cancelled");
    e.name = "AbortError";
    throw e;
  }
};
var box = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
var SOURCE_LINK_TOLERANCE = 0.1;
var sourceGlyphInsideLink = (a, b) => a[0] >= b[0] - SOURCE_LINK_TOLERANCE && a[1] >= b[1] - SOURCE_LINK_TOLERANCE && a[2] <= b[2] + SOURCE_LINK_TOLERANCE && a[3] <= b[3] + SOURCE_LINK_TOLERANCE;
var overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
var pointIn = (p, b) => box(b) && p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
var freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
var same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) < 0.01);
function sourceRelation(document, pageIndex, bounds, verified) {
  if (!verified || !box(bounds)) return { status: "unresolved", reason: verified ? "invalid-link-bounds" : "page-frame-unverified", ranges: [], assetIds: [] };
  const blocks = (document.blocks || []).filter((b) => b.source?.pageIndex === pageIndex && b.source.range && Array.isArray(b.source.characters));
  const selected = [];
  for (const block of blocks) for (const c of block.source.characters) {
    if (box(c.bbox) && sourceGlyphInsideLink(c.bbox, bounds)) selected.push({ block, c });
  }
  const ambiguous = selected.some((x, i) => selected.some((y, j) => i !== j && same(x.c.bbox, y.c.bbox)));
  const ranges = [];
  if (!ambiguous) for (const { block, c } of selected) {
    const last = ranges.at(-1);
    if (last && last.blockId === block.id && last.end === c.start) last.end = c.end;
    else ranges.push({ blockId: block.id, start: c.start, end: c.end });
  }
  const assetIds = (document.assets || []).filter((a) => a.source?.pageIndex === pageIndex && box(a.source.bbox) && overlaps(a.source.bbox, bounds)).map((a) => a.id);
  return { status: ambiguous ? "unresolved" : ranges.length ? "text" : assetIds.length ? "asset" : "unresolved", reason: ambiguous ? "ambiguous-character-geometry" : ranges.length ? "characters-within-subpixel-tolerance" : assetIds.length ? "overlapping-assets" : "no-unique-geometry", ranges, assetIds };
}
function targetRelation(document, pageIndex, point, verified) {
  if (!verified || !point || !point.every(Number.isFinite)) return { status: "page-anchor", reason: verified ? "position-unavailable" : "page-frame-unverified" };
  const chars = (document.blocks || []).filter((b) => b.source?.pageIndex === pageIndex && b.source.range).flatMap((b) => (b.source.characters || []).filter((c) => pointIn(point, c.bbox)).map((c) => ({ blockId: b.id, start: c.start, end: c.end })));
  if (chars.length === 1) return { status: "text", ...chars[0] };
  const assets = (document.assets || []).filter((a) => a.source?.pageIndex === pageIndex && pointIn(point, a.source.bbox));
  if (!chars.length && assets.length === 1) return { status: "asset", assetId: assets[0].id };
  return { status: "page-anchor", reason: chars.length > 1 || assets.length > 1 ? "ambiguous-geometry" : "no-unique-geometry" };
}
async function readSourceLinks({ bytes, document, signal } = {}) {
  abort2(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document || !Array.isArray(document.pages) || !Array.isArray(document.blocks)) throw new TypeError("Expected source bytes and document");
  const snapshot = Uint8Array.from(bytes), sourceSha256 = hex(snapshot), model = structuredClone(document);
  if (model.sourceSha256 !== sourceSha256) throw new Error("Source hash mismatch");
  for (const b of model.blocks) if (b.source?.range) {
    const r = b.source.range, text = model.pages[b.source.pageIndex]?.text;
    if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end < r.start || typeof b.text !== "string" || typeof text !== "string" || text.slice(r.start, r.end) !== b.text || !Array.isArray(b.source.characters) || b.source.characters.some((c) => !Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start < r.start || c.end > r.end || c.start >= c.end)) throw new Error("Unsafe source character range");
  }
  let pdf;
  const links = [], frames = [];
  try {
    pdf = mupdf2.Document.openDocument(snapshot, "application/pdf").asPDF();
    if (!pdf || pdf.needsPassword()) throw new Error("Unsupported PDF");
    if (pdf.countPages() !== model.pages.length) throw new Error("Source page count mismatch");
    for (let i = 0; i < pdf.countPages(); i++) {
      abort2(signal);
      const page = pdf.loadPage(i);
      let nativeLinks = [];
      try {
        const bounds = page.getBounds(), transform = page.getTransform(), p = model.pages[i], g = p.geometry;
        const verified = g?.frame === "mupdf-display" && same(g.bounds, bounds) && same(g.pageTransform, transform) && Math.abs(p.width - (bounds[2] - bounds[0])) < 0.01 && Math.abs(p.height - (bounds[3] - bounds[1])) < 0.01;
        frames.push({ pageIndex: i, bounds: [...bounds], pageTransform: [...transform], verified });
        nativeLinks = page.getLinks();
        for (let j = 0; j < nativeLinks.length; j++) {
          abort2(signal);
          const link = nativeLinks[j], bbox = [...link.getBounds()], uri = link.getURI(), external = link.isExternal();
          let target = null;
          if (!external) {
            try {
              const dest = pdf.resolveLinkDestination(link), pageIndex = pdf.resolveLink(link);
              const pos = dest.type === "XYZ" && Number.isFinite(dest.x) && Number.isFinite(dest.y) ? [dest.x, dest.y] : null;
              target = { status: Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pdf.countPages() ? "resolved" : "unresolved", pageIndex: Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pdf.countPages() ? pageIndex : null, position: pos, destination: { type: dest.type, chapter: dest.chapter, page: dest.page, x: Number.isFinite(dest.x) ? dest.x : null, y: Number.isFinite(dest.y) ? dest.y : null, width: Number.isFinite(dest.width) ? dest.width : null, height: Number.isFinite(dest.height) ? dest.height : null, zoom: Number.isFinite(dest.zoom) ? dest.zoom : null } };
            } catch {
              target = { status: "unresolved", pageIndex: null, position: null };
            }
          }
          links.push({ id: `link-${hex(new TextEncoder().encode(JSON.stringify([sourceSha256, i, j]))).slice(0, 24)}`, source: { pageIndex: i, occurrence: j, bbox, frame: "mupdf-display", frameVerified: verified }, uri, external, relation: sourceRelation(model, i, bbox, verified), target });
        }
      } finally {
        for (const link of nativeLinks) link.destroy();
        page.destroy();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    abort2(signal);
    for (const link of links) if (link.target?.status === "resolved") link.target.relation = targetRelation(model, link.target.pageIndex, link.target.position, frames[link.target.pageIndex].verified);
    return freeze({ schema: "falsify.paper-source-links.v1", sourceSha256, frames, links });
  } finally {
    pdf?.destroy();
  }
}

// app/src/paper-flow.mjs
init_paragraph_pdf_crypto();
var boxOK2 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
var overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
var union = (boxes) => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
var contains = (a, b) => b[0] >= a[0] - 1 && b[1] >= a[1] - 1 && b[2] <= a[2] + 1 && b[3] <= a[3] + 1;
var median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};
var reading = (a, b) => (a.pos ?? Infinity) - (b.pos ?? Infinity) || a.index - b.index;
var geom = (a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0] || reading(a, b);
var textKey = (b) => (b.text || "").trim().replace(/\s+/g, " ");
var sameNumbers = (a, b, tolerance = 0.01) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v - b[i]) < tolerance);
function linkedEdgeCandidates(document, inventory) {
  if (inventory?.schema !== "falsify.paper-source-links.v1" || inventory.sourceSha256 !== document.sourceSha256 || !Array.isArray(inventory.frames) || !Array.isArray(inventory.links)) return [];
  const result = [];
  for (const link of inventory.links) {
    const s = link.source, page = document.pages.find((p) => p.sourcePageIndex === s?.pageIndex), frame = inventory.frames.find((f) => f.pageIndex === s?.pageIndex), g = page?.geometry;
    if (!page || !frame?.verified || !s?.frameVerified || s.frame !== "mupdf-display" || g?.frame !== "mupdf-display" || !sameNumbers(frame.bounds, g.bounds) || !sameNumbers(frame.pageTransform, g.pageTransform) || !boxOK2(s.bbox) || typeof link.uri !== "string" || !link.uri || link.relation?.status !== "text" || !["fully-contained-characters", "characters-within-subpixel-tolerance"].includes(link.relation.reason)) continue;
    const ranges = link.relation.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 1) continue;
    const r = ranges[0], b = document.blocks.find((b2) => b2.id === r.blockId && b2.source?.pageIndex === s.pageIndex), br = b?.source?.range;
    if (!br || r.start !== br.start || r.end !== br.end || !textKey(b) || !boxOK2(b.source.bbox) || page.text?.slice(br.start, br.end) !== b.text) continue;
    const chars = b.source.characters;
    if (!Array.isArray(chars) || !chars.length || chars[0].start !== br.start || chars.at(-1).end !== br.end || chars.some((c, i) => !boxOK2(c.bbox) || i && chars[i - 1].end !== c.start || !sourceGlyphInsideLink(c.bbox, s.bbox))) continue;
    const edge = b.source.bbox[3] <= page.height * 0.12 ? "header" : b.source.bbox[1] >= page.height * 0.88 ? "footer" : null;
    if (edge) result.push({ b, link, edge });
  }
  return result.filter((x) => result.some((y) => y !== x && y.b.source.pageIndex !== x.b.source.pageIndex && y.edge === x.edge && y.link.uri === x.link.uri && textKey(y.b) === textKey(x.b) && sameNumbers(y.b.source.bbox, x.b.source.bbox, 2) && sameNumbers(y.link.source.bbox, x.link.source.bbox, 2)));
}
function splitBlock(b, hash2, styles) {
  const { lines, characters, range } = b.source || {};
  if (!b.text || !Array.isArray(lines) || lines.length < 2 || !Array.isArray(characters) || !range || lines.some((l) => !boxOK2(l.bbox) || !l.range)) return [b];
  if (lines[0].range.start !== range.start || lines.at(-1).range.end !== range.end || lines.some((l, i) => l.range.start >= l.range.end || i && lines[i - 1].range.end !== l.range.start)) return [b];
  const groups = [];
  for (const line of lines) {
    const group = groups.at(-1), prev = group?.at(-1), h = line.bbox[3] - line.bbox[1];
    const gap = prev ? line.bbox[1] - prev.bbox[3] : 0;
    const sameColumn = prev && Math.min(line.bbox[2], prev.bbox[2]) - Math.max(line.bbox[0], prev.bbox[0]) > Math.min(line.bbox[2] - line.bbox[0], prev.bbox[2] - prev.bbox[0]) * 0.3;
    const indent = prev && line.bbox[0] - prev.bbox[0] > h;
    const lineSize = (l) => median(characters.filter((c) => c.start >= l.range.start && c.end <= l.range.end).map((c) => styles.get(c.styleId)?.size).filter(Number.isFinite));
    const a = prev && lineSize(prev), z = lineSize(line);
    const sizeChange = a && z && Math.max(a, z) > Math.min(a, z) * 1.2;
    if (!prev || !sameColumn || gap < -h * 0.5 || gap > h * 0.8 || indent || sizeChange) groups.push([line]);
    else group.push(line);
  }
  if (groups.length === 1) return [b];
  return groups.map((group) => {
    const start = group[0].range.start, end = group.at(-1).range.end;
    const chars = characters.filter((c) => c.start >= start && c.end <= end);
    const id2 = `fragment-${hex(new TextEncoder().encode(JSON.stringify([hash2, b.source.pageIndex, start, end]))).slice(0, 24)}`;
    return { ...b, id: id2, parentBlockId: b.id, text: b.text.slice(start - range.start, end - range.start), source: { ...b.source, bbox: union(group.map((l) => l.bbox)), range: { start, end }, characters: chars, lines: group } };
  });
}
function inlineFragments(blocks, hash2) {
  const replacements = /* @__PURE__ */ new Map(), groups = [];
  for (const host of blocks) {
    const lines = host.source?.lines, chars = host.source?.characters, range = host.source?.range;
    if (replacements.has(host.id) || !host.text || !Array.isArray(lines) || !Array.isArray(chars) || !range || lines.length < 1 || !boxOK2(host.source?.bbox)) continue;
    const inserts = [];
    for (const guest of blocks) {
      if (guest === host || replacements.has(guest.id) || !guest.text || guest.text.length > 80 || !boxOK2(guest.source?.bbox) || guest.source.pageIndex !== host.source.pageIndex) continue;
      const gb = guest.source.bbox;
      if (!contains(host.source.bbox, gb) || gb[2] - gb[0] > (host.source.bbox[2] - host.source.bbox[0]) * 0.45) continue;
      const line = lines.filter((l) => boxOK2(l.bbox) && l.range && gb[1] < l.bbox[3] && gb[3] > l.bbox[1] && gb[2] >= l.bbox[0] - 20 && gb[0] <= l.bbox[2] + 3).sort((a, b) => Math.min(gb[3], b.bbox[3]) - Math.max(gb[1], b.bbox[1]) - (Math.min(gb[3], a.bbox[3]) - Math.max(gb[1], a.bbox[1])))[0];
      if (!line) continue;
      const lc = chars.filter((c) => c.start >= line.range.start && c.end <= line.range.end && boxOK2(c.bbox));
      const next = lc.find((c) => (c.bbox[0] + c.bbox[2]) / 2 >= (gb[0] + gb[2]) / 2);
      const at = next?.start ?? line.range.end;
      if (at < range.start || at >= range.end) continue;
      inserts.push({ guest, at });
    }
    if (!inserts.length) continue;
    inserts.sort((a, b) => a.at - b.at || a.guest.source.bbox[0] - b.guest.source.bbox[0]);
    const cuts = [range.start, ...new Set(inserts.map((x) => x.at).filter((at) => at > range.start)), range.end], parts = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i], end = cuts[i + 1], partChars = chars.filter((c) => c.start >= start && c.end <= end);
      const partLines = lines.filter((l) => l.range && l.range.start < end && l.range.end > start).map((l) => ({ ...l, range: { start: Math.max(start, l.range.start), end: Math.min(end, l.range.end) }, bbox: union(partChars.filter((c) => c.start < l.range.end && c.end > l.range.start && boxOK2(c.bbox)).map((c) => c.bbox)) })).filter((l) => boxOK2(l.bbox));
      if (!partLines.length) {
        parts.length = 0;
        break;
      }
      const id2 = `fragment-${hex(new TextEncoder().encode(JSON.stringify([hash2, host.source.pageIndex, start, end]))).slice(0, 24)}`;
      parts.push({ ...host, id: id2, parentBlockId: host.parentBlockId || host.id, text: host.text.slice(start - range.start, end - range.start), source: { ...host.source, bbox: union(partLines.map((l) => l.bbox)), range: { start, end }, characters: partChars, lines: partLines } });
    }
    if (!parts.length) continue;
    const order = inserts.filter((x) => x.at === range.start).map((x) => x.guest);
    for (let i = 0; i < parts.length; i++) {
      order.push(parts[i]);
      order.push(...inserts.filter((x) => x.at === cuts[i + 1]).map((x) => x.guest));
    }
    replacements.set(host.id, parts);
    for (const x of inserts) replacements.set(x.guest.id, null);
    groups.push(order);
  }
  return { replacements, groups };
}
function occlusionFragments(block, evidence, hash2) {
  const range = block.source?.range, chars = block.source?.characters, lines = block.source?.lines;
  if (!range || !chars?.length || !lines?.length) return [block];
  const cuts = /* @__PURE__ */ new Set([range.start, range.end]);
  for (const e of evidence) for (const r of e.ranges) if (r.start >= range.start && r.end <= range.end) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  if (sorted.length === 2) return [block];
  const parts = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i], end = sorted[i + 1], cs = chars.filter((c) => c.start >= start && c.end <= end);
    if (!cs.length || cs.some((c) => !boxOK2(c.bbox))) return [block];
    const ls = lines.filter((l) => l.range.start < end && l.range.end > start).map((l) => ({ ...l, range: { start: Math.max(start, l.range.start), end: Math.min(end, l.range.end) }, bbox: union(cs.filter((c) => c.start < l.range.end && c.end > l.range.start).map((c) => c.bbox)) }));
    parts.push({ ...block, id: `fragment-${hex(new TextEncoder().encode(JSON.stringify([hash2, block.source.pageIndex, start, end]))).slice(0, 24)}`, parentBlockId: block.id, text: block.text.slice(start - range.start, end - range.start), source: { ...block.source, range: { start, end }, characters: cs, lines: ls, bbox: union(cs.map((c) => c.bbox)) } });
  }
  return parts;
}
function buildPaperFlow(document, { drawings = document?.drawings || [], links } = {}) {
  if (document?.schema !== "falsify.paper-document.v1" || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets)) throw new TypeError("Expected falsify.paper-document.v1");
  const items = [], relations = [], diagnostics = [], fragments = [], regions = [];
  const styles = new Map((document.styles || []).map((s) => [s.id, s]));
  const evidence = (document.occlusions || []).filter((e) => e.sourceSha256 === document.sourceSha256 && Array.isArray(e.ranges) && e.proof?.changedChannels === 0 && e.proof?.removedCharacters > 0);
  let flowBlocks = document.blocks.flatMap((b) => occlusionFragments(b, evidence.filter((e) => e.pageIndex === b.source?.pageIndex), document.sourceSha256)).flatMap((b) => splitBlock(b, document.sourceSha256, styles));
  const inline = inlineFragments(flowBlocks, document.sourceSha256);
  flowBlocks = flowBlocks.flatMap((b) => inline.replacements.has(b.id) ? inline.replacements.get(b.id) || [b] : [b]);
  fragments.push(...flowBlocks.filter((b) => b.parentBlockId));
  const textBlocks = flowBlocks.filter((b) => b.text);
  const sizeOf = (b) => median((b.source?.characters || []).map((c) => styles.get(c.styleId)?.size).filter(Number.isFinite)) || styles.get(b.styleId)?.size || 0;
  const bodySize = median(textBlocks.flatMap((b) => (b.source?.characters || []).map((c) => styles.get(c.styleId)?.size).filter(Number.isFinite))) || median(textBlocks.map(sizeOf).filter(Boolean));
  const linkedEdges = linkedEdgeCandidates(document, links);
  const repeats = /* @__PURE__ */ new Map();
  for (const b of textBlocks) {
    const page = document.pages.find((p) => p.sourcePageIndex === b.source?.pageIndex), box5 = b.source?.bbox;
    if (!page || !boxOK2(box5) || !(box5[1] < page.height * 0.12 || box5[3] > page.height * 0.88)) continue;
    const key = b.text.trim().replace(/\s+/g, " ");
    if (key) {
      if (!repeats.has(key)) repeats.set(key, /* @__PURE__ */ new Set());
      repeats.get(key).add(b.source.pageIndex);
    }
  }
  const decoratedFooter = /* @__PURE__ */ new Set();
  for (const page of document.pages) {
    const pi = page.sourcePageIndex;
    const candidates = textBlocks.filter((b) => b.source?.pageIndex === pi && boxOK2(b.source.bbox) && b.source.bbox[1] >= page.height * 0.94 && textKey(b) && repeats.get(textKey(b))?.size >= 3);
    for (const band of drawings.filter((d) => d.pageIndex === pi && d.operation === "fill" && boxOK2(d.bbox) && d.bbox[1] >= page.height * 0.94 && d.bbox[2] - d.bbox[0] >= page.width * 0.8 && d.bbox[3] - d.bbox[1] <= page.height * 0.035)) {
      const members = candidates.filter((b) => overlap(b.source.bbox, band.bbox));
      if (new Set(members.map(textKey)).size < 2) continue;
      if (document.assets.some((a) => a.source?.pageIndex === pi && boxOK2(a.source.bbox) && overlap(a.source.bbox, band.bbox))) continue;
      if (drawings.some((d) => d !== band && d.pageIndex === pi && boxOK2(d.bbox) && overlap(d.bbox, band.bbox))) continue;
      const matchingPages = document.pages.filter((p) => {
        if (p.width !== page.width || p.height !== page.height || !members.every((b) => textBlocks.filter((other) => other.source?.pageIndex === p.sourcePageIndex && textKey(other) === textKey(b) && sameNumbers(other.source.bbox, b.source.bbox, 2)).length === 1)) return false;
        const decorations = drawings.filter((d) => d.pageIndex === p.sourcePageIndex && d.operation === "fill" && sameNumbers(d.bbox, band.bbox, 2));
        if (decorations.length !== 1) return false;
        const decoration = decorations[0];
        return !document.assets.some((a) => a.source?.pageIndex === p.sourcePageIndex && boxOK2(a.source.bbox) && overlap(a.source.bbox, decoration.bbox)) && !drawings.some((d) => d !== decoration && d.pageIndex === p.sourcePageIndex && boxOK2(d.bbox) && overlap(d.bbox, decoration.bbox));
      });
      const bodyPages = matchingPages.filter((p) => textBlocks.some((b) => b.source?.pageIndex === p.sourcePageIndex && boxOK2(b.source.bbox) && b.source.bbox[1] >= p.height * 0.12 && b.source.bbox[3] <= p.height * 0.88 && (b.text || "").trim().length >= 100));
      if (matchingPages.length >= 3 && bodyPages.length >= 2) for (const b of members) decoratedFooter.add(b.id);
    }
  }
  for (const page of document.pages) {
    const pi = page.sourcePageIndex;
    const blocks = flowBlocks.map((b, index) => ({ b, index, box: b.source?.bbox, pos: b.source?.readerPosition })).filter((x) => x.b.source?.pageIndex === pi);
    const assets = document.assets.map((a, index) => ({ a, index, box: a.source?.bbox, pos: a.source?.readerPosition })).filter((x) => x.a.source?.pageIndex === pi);
    const owned = /* @__PURE__ */ new Set(), represented = /* @__PURE__ */ new Set();
    let serial = 0;
    const make = (kind, bs, as, box5, pos, index) => ({ id: `flow-${pi}-${serial++}`, kind, blockIds: bs.map((x) => x.b.id), assetIds: as.map((x) => x.a.id), source: { pageIndex: pi, bbox: boxOK2(box5) ? [...box5] : null }, columns: 1, span: "page", captionIds: [], box: box5, pos, index });
    const entries = [];
    const paths = drawings.filter((d) => d.pageIndex === pi && boxOK2(d.bbox)).map((d) => d.bbox);
    const centralText = blocks.filter((x) => x.b.text?.trim() && (!boxOK2(x.box) || x.box[1] < page.height * 0.9 && x.box[3] > page.height * 0.1));
    let form = false;
    if (paths.length >= 2e3 && centralText.length === 0 && blocks.every((x) => boxOK2(x.box)) && assets.every((x) => boxOK2(x.box))) {
      const raw = union([...paths, ...blocks.map((x) => x.box), ...assets.map((x) => x.box)]);
      const box5 = [Math.max(0, raw[0] - 1), Math.max(0, raw[1] - 1), Math.min(page.width, raw[2] + 1), Math.min(page.height, raw[3] + 1)];
      if (boxOK2(box5) && box5[2] - box5[0] > page.width * 0.5 && box5[3] - box5[1] > page.height * 0.5 && [...paths, ...blocks.map((x) => x.box), ...assets.map((x) => x.box)].every((b) => contains(box5, b))) {
        const id2 = `region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256, pi, box5]))).slice(0, 24)}`;
        const entry = make("asset", blocks, assets, box5, Math.min(...blocks.map((x) => x.pos ?? Infinity)), 0);
        entry.renderAssetId = id2;
        entries.push(entry);
        regions.push({ id: id2, pageIndex: pi, bbox: [...box5], blockIds: blocks.map((x) => x.b.id), assetIds: assets.map((x) => x.a.id), classification: "outline-artwork" });
        blocks.forEach((x) => owned.add(x.b.id));
        assets.forEach((x) => represented.add(x.a.id));
        form = true;
      }
    }
    const captions = blocks.filter((x) => boxOK2(x.box) && /^\s*(?:extended\s+data\s+)?(?:fig(?:ure)?\.?|table)\s*\d/i.test(x.b.text || ""));
    const plotBottom = Math.min(page.height * 0.9, ...captions.map((x) => x.box[1]));
    const plotText = blocks.filter((x) => x.b.text && boxOK2(x.box) && x.box[1] >= page.height * 0.05 && x.box[3] <= plotBottom);
    const plotPaths = paths.filter((b) => b[0] >= 0 && b[1] >= page.height * 0.05 && b[2] <= page.width && b[3] <= plotBottom);
    let plot = false;
    if (!form) {
      const central = blocks.filter((x) => x.b.text && boxOK2(x.box) && x.box[1] >= page.height * 0.05 && x.box[3] <= page.height * 0.9);
      const narrative = (x) => {
        const lines = x.b.source?.lines || [];
        return captions.includes(x) || bodySize && sizeOf(x.b) >= bodySize * 0.88 && x.box[2] - x.box[0] >= page.width * 0.3 && (lines.length >= 2 || x.b.text.trim().length >= 55);
      };
      const barriers = central.filter(narrative).sort(geom);
      const limits = [page.height * 0.05, ...barriers.flatMap((x) => [x.box[1], x.box[3]]), page.height * 0.9].sort((a, b) => a - b);
      for (let i = 0; i < limits.length - 1; i++) {
        const top = limits[i], bottom = limits[i + 1];
        if (bottom <= top || barriers.some((x) => x.box[1] < bottom && x.box[3] > top)) continue;
        const as = assets.filter((x) => !represented.has(x.a.id) && boxOK2(x.box) && x.box[1] >= top && x.box[3] <= bottom);
        if (as.length < 2) continue;
        const labels = central.filter((x) => !owned.has(x.b.id) && !narrative(x) && x.box[1] >= top && x.box[3] <= bottom);
        if (labels.length < 3) continue;
        const ps = paths.filter((b) => b[1] >= top && b[3] <= bottom);
        const raw = union([...as.map((x) => x.box), ...labels.map((x) => x.box), ...ps]);
        const box5 = [Math.max(0, raw[0] - 2), Math.max(0, raw[1] - 2), Math.min(page.width, raw[2] + 2), Math.min(page.height, raw[3] + 2)];
        if (box5[2] - box5[0] < page.width * 0.4 || box5[3] - box5[1] < page.height * 0.2) continue;
        if (blocks.some((x) => x.b.text && boxOK2(x.box) && overlap(box5, x.box) && !labels.includes(x)) || assets.some((x) => boxOK2(x.box) && overlap(box5, x.box) && !as.includes(x))) continue;
        const bs = [...labels, ...blocks.filter((x) => !owned.has(x.b.id) && (x.b.assetIds || []).some((id3) => as.some((a) => a.a.id === id3)))];
        bs.forEach((x) => owned.add(x.b.id));
        as.forEach((x) => represented.add(x.a.id));
        const id2 = `region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256, pi, box5]))).slice(0, 24)}`;
        const entry = make("asset", bs, as, box5, Math.min(...bs.map((x) => x.pos ?? Infinity)), Math.min(...bs.map((x) => x.index)));
        entry.renderAssetId = id2;
        entries.push(entry);
        regions.push({ id: id2, pageIndex: pi, bbox: [...box5], blockIds: bs.map((x) => x.b.id), assetIds: as.map((x) => x.a.id), classification: "compound-figure" });
        plot = true;
      }
    }
    if (!form && !plot && plotPaths.length >= 1e3) {
      const artwork = union(plotPaths);
      const plotBlocks = plotText.filter((x) => {
        const text = x.b.text.trim(), lines = x.b.source?.lines || [];
        const dx = Math.max(artwork[0] - x.box[2], x.box[0] - artwork[2], 0);
        const dy = Math.max(artwork[1] - x.box[3], x.box[1] - artwork[3], 0);
        const distance = Math.max(10, Math.min(15, (sizeOf(x.b) || x.box[3] - x.box[1]) * 1.5));
        const smallArtworkText = contains(artwork, x.box) && bodySize && sizeOf(x.b) && sizeOf(x.b) <= bodySize * 0.9;
        return smallArtworkText || text.length <= 30 && text.split(/\s+/).length <= 3 && !/[.!?]\s*$/.test(text) && lines.length <= 1 && (text.length <= 2 || !bodySize || !sizeOf(x.b) || sizeOf(x.b) <= bodySize * 1.1) && dx <= distance && dy <= distance;
      });
      let box5 = union([artwork, ...plotBlocks.map((x) => x.box)]);
      const touching = assets.filter((x) => boxOK2(x.box) && overlap(box5, x.box));
      if (touching.every((x) => x.box[0] >= 0 && x.box[1] >= page.height * 0.05 && x.box[2] <= page.width && x.box[3] <= plotBottom)) box5 = union([box5, ...touching.map((x) => x.box)]);
      if (plotBlocks.length >= 20 && !blocks.some((x) => x.b.text && boxOK2(x.box) && overlap(box5, x.box) && !plotBlocks.includes(x)) && touching.every((x) => contains(box5, x.box)) && box5[2] - box5[0] > page.width * 0.4 && box5[3] - box5[1] > page.height * 0.2) {
        const as = assets.filter((x) => boxOK2(x.box) && contains(box5, x.box));
        const figureBlocks = blocks.filter((x) => (x.b.assetIds || []).some((id3) => as.some((a) => a.a.id === id3)));
        plotBlocks.push(...figureBlocks.filter((x) => !plotBlocks.includes(x)));
        plotBlocks.forEach((x) => owned.add(x.b.id));
        as.forEach((x) => represented.add(x.a.id));
        const id2 = `region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256, pi, box5]))).slice(0, 24)}`;
        const entry = make("asset", plotBlocks, as, box5, Math.min(...plotBlocks.map((x) => x.pos ?? Infinity)), plotBlocks[0].index);
        entry.renderAssetId = id2;
        entries.push(entry);
        regions.push({ id: id2, pageIndex: pi, bbox: [...box5], blockIds: plotBlocks.map((x) => x.b.id), assetIds: as.map((x) => x.a.id) });
        plot = true;
      }
    }
    if (!form && !plot && paths.length > 2e3) diagnostics.push({ code: "dense-vector-region-unresolved", pageIndex: pi });
    const seen = /* @__PURE__ */ new Set();
    for (let n = 0; n < (form || plot || paths.length > 2e3 ? 0 : paths.length); n++) {
      if (seen.has(n)) continue;
      const cluster = [n];
      seen.add(n);
      for (let k = 0; k < cluster.length; k++) for (let j = 0; j < paths.length; j++) {
        if (seen.has(j)) continue;
        const a = paths[cluster[k]], b = paths[j];
        if (a[0] <= b[2] + 1 && b[0] <= a[2] + 1 && a[1] <= b[3] + 1 && b[1] <= a[3] + 1) {
          seen.add(j);
          cluster.push(j);
        }
      }
      if (cluster.length < 10) continue;
      const boxes = cluster.map((i) => paths[i]), box5 = union(boxes);
      const horizontal = boxes.filter((b) => b[2] - b[0] > 10 && b[3] - b[1] < 3).length;
      const vertical = boxes.filter((b) => b[3] - b[1] > 10 && b[2] - b[0] < 3).length;
      if (horizontal < 3 || vertical < 3 || box5[2] - box5[0] < 40 || box5[3] - box5[1] < 20) continue;
      const bs = blocks.filter((x) => x.b.text && !owned.has(x.b.id) && boxOK2(x.box) && contains(box5, x.box));
      if (bs.length < 4 || blocks.some((x) => x.b.text && boxOK2(x.box) && overlap(box5, x.box) && !bs.includes(x)) || assets.some((x) => boxOK2(x.box) && overlap(box5, x.box) && !contains(box5, x.box))) continue;
      const as = assets.filter((x) => !represented.has(x.a.id) && boxOK2(x.box) && contains(box5, x.box));
      bs.push(...blocks.filter((x) => !owned.has(x.b.id) && !bs.includes(x) && (x.b.assetIds || []).some((id3) => as.some((a) => a.a.id === id3))));
      bs.forEach((x) => owned.add(x.b.id));
      as.forEach((x) => represented.add(x.a.id));
      const id2 = `region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256, pi, box5]))).slice(0, 24)}`;
      const entry = make("asset", bs, as, box5, Math.min(...bs.map((x) => x.pos ?? Infinity)), bs[0].index);
      entry.renderAssetId = id2;
      entries.push(entry);
      regions.push({ id: id2, pageIndex: pi, bbox: [...box5], blockIds: bs.map((x) => x.b.id), assetIds: as.map((x) => x.a.id) });
    }
    for (const a of assets) {
      if (represented.has(a.a.id)) continue;
      const group = [a];
      represented.add(a.a.id);
      if (boxOK2(a.box)) {
        for (let i = 0; i < group.length; i++) for (const other of assets) if (!represented.has(other.a.id) && boxOK2(other.box) && overlap(group[i].box, other.box)) {
          group.push(other);
          represented.add(other.a.id);
        }
      }
      const box5 = group.every((x) => boxOK2(x.box)) ? union(group.map((x) => x.box)) : null;
      const proofs = evidence.filter((e) => e.pageIndex === pi && group.some((y) => y.a.id === e.assetId));
      const confirmed = (x) => x.b.text && x.b.source?.range && proofs.some((e) => {
        const r = x.b.source.range;
        return e.ranges.some((z) => z.start <= r.start && z.end >= r.end);
      });
      const bs = blocks.filter((x) => !owned.has(x.b.id) && ((x.b.assetIds || []).some((id2) => group.some((y) => y.a.id === id2)) || confirmed(x)));
      bs.forEach((x) => owned.add(x.b.id));
      const entry = make("asset", bs, group, box5, a.pos, a.index);
      if (proofs.length && bs.some(confirmed) && boxOK2(box5)) {
        const id2 = `region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256, pi, box5]))).slice(0, 24)}`;
        entry.renderAssetId = id2;
        regions.push({ id: id2, pageIndex: pi, bbox: [...box5], blockIds: bs.map((x) => x.b.id), assetIds: group.map((x) => x.a.id), classification: "verified-occlusion" });
      }
      entries.push(entry);
    }
    const artworkNear = (x) => paths.some((p) => overlap(p, x.box)) || assets.some((a) => boxOK2(a.box) && a.box[0] < x.box[2] + 15 && a.box[2] > x.box[0] - 15 && a.box[1] < x.box[3] + 15 && a.box[3] > x.box[1] - 15);
    const repeated = (x) => repeats.get(textKey(x.b))?.size >= 2;
    const peer = (x) => blocks.some((y) => y !== x && y.b.text?.trim() && boxOK2(y.box) && repeated(y) && y.box[1] < x.box[3] && x.box[1] < y.box[3] && (y.box[2] < x.box[0] || x.box[2] < y.box[0]) && !artworkNear(y));
    const separatedBody = (x) => blocks.some((y) => y !== x && y.b.text && boxOK2(y.box) && y.box[1] >= page.height * 0.12 && y.box[3] <= page.height * 0.88);
    const linked = (x) => linkedEdges.find((e) => e.b.id === x.b.id && e.b.source.range.start === x.b.source.range?.start && e.b.source.range.end === x.b.source.range?.end);
    const inferredEdge = (x) => boxOK2(x.box) && repeated(x) && bodySize && sizeOf(x.b) && separatedBody(x) && !artworkNear(x) && (sizeOf(x.b) < bodySize * 0.9 || peer(x) || linked(x));
    for (const x of blocks) {
      if (owned.has(x.b.id)) continue;
      owned.add(x.b.id);
      const b = x.b, box5 = x.box;
      let kind = "paragraph";
      if (b.kind === "figure" || b.kind === "table") kind = "asset";
      else if (b.kind === "caption" || /^\s*(?:extended\s+data\s+)?(?:fig(?:ure)?\.?|table)\s*\d+[\w.:-]*/i.test(b.text || "")) kind = "caption";
      else if (b.kind === "header" || b.kind === "footer") kind = b.kind;
      else if (decoratedFooter.has(b.id)) kind = "footer";
      else if (inferredEdge(x)) {
        if (box5[1] < page.height * 0.12) kind = "header";
        else if (box5[3] > page.height * 0.88) kind = "footer";
      } else if (b.kind === "heading" || bodySize > 0 && sizeOf(b) > bodySize * 1.3 && (b.text || "").trim().length >= 12 && (b.text || "").length < 150) kind = "heading";
      entries.push(make(kind, [x], [], box5, x.pos, x.index));
    }
    for (const edge of entries.filter((x) => ["header", "footer"].includes(x.kind))) {
      if (edge.blockIds.some((id2) => flowBlocks.find((b) => b.id === id2)?.kind === edge.kind) || !boxOK2(edge.box)) continue;
      const ordinary = entries.filter((x) => ["paragraph", "heading"].includes(x.kind) && boxOK2(x.box) && x.blockIds.some((id2) => flowBlocks.find((b) => b.id === id2)?.text?.trim()));
      if (ordinary.some((x) => edge.kind === "header" ? x.box[3] <= edge.box[1] : x.box[1] >= edge.box[3])) edge.kind = "paragraph";
    }
    const parentGroups = /* @__PURE__ */ new Map();
    for (const b of flowBlocks.filter((b2) => b2.parentBlockId && b2.source.pageIndex === pi)) {
      if (!parentGroups.has(b.parentBlockId)) parentGroups.set(b.parentBlockId, []);
      parentGroups.get(b.parentBlockId).push(b);
    }
    for (const group of parentGroups.values()) {
      if (group.length < 3 || group.some((b) => inline.groups.some((g) => g.includes(b)))) continue;
      group.sort((a, b) => a.source.range.start - b.source.range.start);
      const box5 = union(group.map((b) => b.source.bbox));
      if (!boxOK2(box5) || box5[3] - box5[1] > 60 || group.some((b, i) => i && group[i - 1].source.range.end !== b.source.range.start)) continue;
      const members = group.map((b) => entries.find((e) => e.blockIds.length === 1 && e.blockIds[0] === b.id));
      if (members.some((x) => !x || x.kind !== "paragraph")) continue;
      const first = members[0];
      first.blockIds = group.map((b) => b.id);
      first.inline = true;
      first.joiners = Array(group.length - 1).fill("");
      first.box = box5;
      first.source.bbox = [...box5];
      for (const member of members.slice(1)) entries.splice(entries.indexOf(member), 1);
    }
    for (const group of inline.groups) {
      const members = group.map((b) => entries.find((e) => e.blockIds.length === 1 && e.blockIds[0] === b.id));
      if (members.some((x) => !x || x.kind !== "paragraph")) continue;
      const first = members[0];
      first.blockIds = group.map((b) => b.id);
      first.inline = true;
      first.joiners = Array(group.length - 1).fill("");
      first.box = union(members.map((x) => x.box));
      first.source.bbox = [...first.box];
      for (const member of members.slice(1)) entries.splice(entries.indexOf(member), 1);
    }
    const blockMap2 = new Map(flowBlocks.map((b) => [b.id, b]));
    const signature = (e) => {
      const chars = e.blockIds.flatMap((id2) => blockMap2.get(id2)?.source?.characters || []);
      const counts = /* @__PURE__ */ new Map();
      for (const c of chars) {
        const s = styles.get(c.styleId);
        if (!s?.fontName || !Number.isFinite(s.size)) continue;
        const key = `${s.fontName.replace(/(?:Bold|Semibold|Italic|Oblique)/gi, "")}|${Math.round(s.size * 10) / 10}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const bounds = (e) => e.blockIds.map((id2) => blockMap2.get(id2)?.source?.range).filter(Boolean);
    const start = (e) => Math.min(...bounds(e).map((r) => r.start));
    const end = (e) => {
      const ranges = bounds(e).sort((a, b) => a.start - b.start || a.end - b.end);
      let last = ranges[0]?.end;
      for (const r of ranges.slice(1)) {
        if (r.start > last) break;
        last = Math.max(last, r.end);
      }
      return last;
    };
    const lineCount = (e) => e.blockIds.reduce((n, id2) => n + (blockMap2.get(id2)?.source?.lines?.length || 0), 0);
    for (const caption of entries.filter((e) => e.kind === "caption" && boxOK2(e.box))) {
      let last = caption;
      const members = [caption];
      while (true) {
        const lastEnd = end(last), sig = signature(last);
        if (!Number.isFinite(lastEnd) || !sig) break;
        const next = entries.filter((e) => e.kind === "paragraph" && !members.includes(e) && boxOK2(e.box) && start(e) === lastEnd && signature(e) === sig && lineCount(e) >= 1);
        const eligible = next.filter((e) => {
          const h = median(last.blockIds.flatMap((id2) => (blockMap2.get(id2)?.source?.lines || []).map((l) => boxOK2(l.bbox) ? l.bbox[3] - l.bbox[1] : 0)).filter(Boolean));
          if (!h) return false;
          const sameColumn = Math.min(last.box[2], e.box[2]) - Math.max(last.box[0], e.box[0]) > Math.min(last.box[2] - last.box[0], e.box[2] - e.box[0]) * 0.5;
          const gap = e.box[1] - last.box[3];
          const adjacent = sameColumn && gap >= -h && gap <= h;
          const wrap = !sameColumn && e.box[0] > last.box[2] && lineCount(last) >= 2 && lineCount(e) >= 2 && Math.abs(e.box[1] - caption.box[1]) <= h && last.box[3] > e.box[1] + 2 * h;
          if (!adjacent && !wrap) return false;
          const corridor = wrap ? [e.box[0], e.box[1], e.box[2], e.box[1] + h] : [Math.min(last.box[0], e.box[0]), Math.min(last.box[3], e.box[1]), Math.max(last.box[2], e.box[2]), Math.max(last.box[3], e.box[1])];
          return !entries.some((x) => x !== last && x !== e && !members.includes(x) && !["header", "footer"].includes(x.kind) && boxOK2(x.box) && overlap(corridor, x.box));
        });
        if (eligible.length !== 1) break;
        last = eligible[0];
        members.push(last);
      }
      if (members.length > 1) {
        const ids = [], joiners = [];
        for (const member of members) {
          if (ids.length) joiners.push(" ");
          ids.push(...member.blockIds);
          if (member.inline) joiners.push(...member.joiners);
          else for (let i = 1; i < member.blockIds.length; i++) joiners.push("");
        }
        caption.blockIds = ids;
        caption.inline = true;
        caption.joiners = joiners;
        caption.memberBoxes = members.map((e) => [...e.box]);
        caption.box = union(caption.memberBoxes);
        caption.source.bbox = [...caption.box];
        for (const member of members.slice(1)) entries.splice(entries.indexOf(member), 1);
        diagnostics.push({ code: "caption-continuation-grouped", pageIndex: pi, itemId: caption.id, memberItemIds: members.map((e) => e.id), blockIds: [...ids] });
      }
    }
    for (const caption of entries.filter((x) => x.kind === "caption" && boxOK2(x.box))) {
      const text = caption.blockIds.map((id2) => flowBlocks.find((b) => b.id === id2)?.text || "").join("");
      const table = /^\s*(?:extended\s+data\s+)?table\s*\d/i.test(text);
      const near3 = entries.filter((x) => x.kind === "asset" && boxOK2(x.box) && x.box[0] < caption.box[2] && caption.box[0] < x.box[2]).map((x) => {
        const position = caption.box[3] <= x.box[1] ? "above" : caption.box[1] >= x.box[3] ? "below" : null;
        const gap = position === "above" ? x.box[1] - caption.box[3] : position === "below" ? caption.box[1] - x.box[3] : Infinity;
        const area3 = (x.box[2] - x.box[0]) * (x.box[3] - x.box[1]);
        return { x, position, gap, area: area3 };
      }).filter((c) => c.position && c.gap <= Math.max(30, page.height * 0.05)).sort((a, b) => a.gap - b.gap || b.area - a.area);
      const best = near3[0];
      if (best && (near3.length === 1 || near3[1].gap - best.gap > 10 || table && best.position === "above" && best.area > near3[1].area * 2 && best.gap < near3[1].gap)) {
        best.x.captionIds.push(...caption.blockIds);
        best.x.captionPositions ||= {};
        for (const id2 of caption.blockIds) best.x.captionPositions[id2] = best.position;
        relations.push({ kind: "caption", assetItemId: best.x.id, captionItemId: caption.id, position: best.position });
      } else diagnostics.push({ code: "caption-association-unresolved", pageIndex: pi, itemId: caption.id });
    }
    const headers = entries.filter((x) => x.kind === "header").sort(geom), footers = entries.filter((x) => x.kind === "footer").sort(geom);
    for (const edge of [...headers, ...footers]) entries.splice(entries.indexOf(edge), 1);
    let continuousOrder = null;
    if (entries.some((x) => !boxOK2(x.box)) || !Number.isFinite(page.width)) {
      diagnostics.push({ code: "reading-order-fallback", pageIndex: pi, detail: "Missing geometry; reader order retained." });
      entries.sort(reading);
    } else {
      const lineBoxes = blocks.filter((x) => x.b.text && !ownedByAsset(x, entries)).flatMap((x) => {
        const lines = x.b.source?.lines?.map((l) => l.bbox).filter(boxOK2) || [];
        return lines.length ? lines : [x.box];
      }).filter(boxOK2);
      const candidates = [];
      for (let mid = page.width * 0.25; mid <= page.width * 0.75; mid += Math.max(1, page.width / 400)) {
        const left = lineBoxes.filter((b) => b[2] < mid && b[2] > page.width * 0.2 && b[2] - b[0] > page.width * 0.25), right = lineBoxes.filter((b) => b[0] > mid && b[0] < page.width * 0.8 && b[2] - b[0] > page.width * 0.25);
        if (left.length < 2 || right.length < 2 || !left.some((a) => right.some((b) => a[1] < b[3] && b[1] < a[3]))) continue;
        const l = Math.max(...left.map((b) => b[2])), r = Math.min(...right.map((b) => b[0]));
        if (r - l >= Math.max(8, page.width * 0.015)) candidates.push({ mid: (l + r) / 2, l, r, score: Math.min(left.length, right.length) });
      }
      candidates.sort((a, b) => b.score - a.score || Math.abs(a.mid - page.width / 2) - Math.abs(b.mid - page.width / 2));
      const g = candidates[0];
      if (!g) {
        entries.sort(geom);
        diagnostics.push({ code: "single-column-or-unresolved", pageIndex: pi });
      } else {
        const splitCaption = (x) => x.kind === "caption" && x.memberBoxes?.length > 1 && x.memberBoxes.every((b) => b[2] <= g.mid || b[0] >= g.mid) && x.memberBoxes.some((b) => b[2] <= g.mid) && x.memberBoxes.some((b) => b[0] >= g.mid);
        for (const item of entries.filter(splitCaption)) item.measuredColumns = 2;
        if (entries.some(splitCaption)) {
          const layoutBox = (x) => splitCaption(x) ? x.memberBoxes[0] : x.box;
          const spans2 = entries.filter((x) => !splitCaption(x) && x.box[0] < g.mid && x.box[2] > g.mid).sort(geom);
          const side2 = entries.filter((x) => !spans2.includes(x)), groups2 = [];
          for (const s of spans2) {
            const last = groups2.at(-1);
            if (last && s.box[1] < last.bottom) {
              last.items.push(s);
              last.bottom = Math.max(last.bottom, s.box[3]);
            } else groups2.push({ items: [s], top: s.box[1], bottom: s.box[3] });
          }
          for (const c of side2.filter((x) => x.kind === "caption")) if (side2.some((x) => x !== c && x.kind === "paragraph" && x.box[3] < c.box[1] - 5) && !groups2.some((g2) => c.box[1] >= g2.top && c.box[1] < g2.bottom)) groups2.push({ items: [], top: c.box[1], bottom: c.box[1] });
          groups2.sort((a, b) => a.top - b.top);
          const bands2 = Array.from({ length: groups2.length + 1 }, () => []);
          for (const x of side2) {
            let n = groups2.findIndex((g2) => x.box[1] < g2.bottom && x.box[3] > g2.top);
            if (n >= 0) groups2[n].items.push(x);
            else {
              n = groups2.findIndex((g2) => x.box[3] <= g2.top);
              bands2[n < 0 ? groups2.length : n].push(x);
            }
          }
          continuousOrder = [];
          for (let i = 0; i < bands2.length; i++) {
            const xs = bands2[i], left = xs.filter((x) => layoutBox(x)[2] <= g.mid).sort(geom), right = xs.filter((x) => layoutBox(x)[0] >= g.mid).sort(geom), both = left.length && right.length || xs.some(splitCaption);
            for (const x of xs) x.continuousColumns = both ? 2 : 1;
            continuousOrder.push(...left, ...right);
            if (groups2[i]) continuousOrder.push(...groups2[i].items.sort(geom));
          }
        }
        const spans = entries.filter((x) => x.box[0] < g.mid && x.box[2] > g.mid).sort(geom);
        const side = entries.filter((x) => !spans.includes(x));
        const groups = [];
        for (const s of spans) {
          const last = groups.at(-1);
          if (last && s.box[1] < last.bottom) {
            last.items.push(s);
            last.bottom = Math.max(last.bottom, s.box[3]);
          } else groups.push({ items: [s], top: s.box[1], bottom: s.box[3] });
        }
        for (const c of side.filter((x) => x.kind === "caption")) if (side.some((x) => x !== c && x.kind === "paragraph" && x.box[3] < c.box[1] - 5) && !groups.some((g2) => c.box[1] >= g2.top && c.box[1] < g2.bottom)) groups.push({ items: [], top: c.box[1], bottom: c.box[1] });
        groups.sort((a, b) => a.top - b.top);
        const bands = Array.from({ length: groups.length + 1 }, () => []);
        for (const x of side) {
          let n = groups.findIndex((g2) => x.box[1] < g2.bottom && x.box[3] > g2.top);
          if (n >= 0) {
            groups[n].items.push(x);
            diagnostics.push({ code: "band-overlap", pageIndex: pi, itemId: x.id });
          } else {
            n = groups.findIndex((g2) => x.box[3] <= g2.top);
            bands[n < 0 ? groups.length : n].push(x);
          }
        }
        const orderBand = (xs) => {
          const left = xs.filter((x) => x.box[2] <= g.mid).sort(geom), right = xs.filter((x) => x.box[0] >= g.mid).sort(geom);
          const both = left.length && right.length;
          for (const x of xs) {
            x.columns = both ? 2 : 1;
            x.span = both ? "column" : "page";
          }
          return [...left, ...right];
        };
        const ordered = [];
        for (let i = 0; i < bands.length; i++) {
          ordered.push(...orderBand(bands[i]));
          if (groups[i]) ordered.push(...groups[i].items.sort(geom));
        }
        entries.splice(0, entries.length, ...ordered);
        diagnostics.push({ code: "geometry-order-heuristic", pageIndex: pi, gutter: [g.l, g.r] });
      }
    }
    for (const header of headers) {
      const at = entries.findIndex((e) => boxOK2(e.box) && e.box[1] >= header.box[1]);
      entries.splice(at < 0 ? entries.length : at, 0, header);
      if (continuousOrder) {
        const n = continuousOrder.findIndex((e) => boxOK2(e.box) && e.box[1] >= header.box[1]);
        continuousOrder.splice(n < 0 ? continuousOrder.length : n, 0, header);
      }
    }
    if (continuousOrder) [...continuousOrder, ...footers].forEach((item, i) => item.continuousPosition = i);
    items.push(...[...entries, ...footers].map(({ box: box5, pos, index, memberBoxes, ...item }) => item));
  }
  const blockMap = new Map([...document.blocks, ...fragments].map((b) => [b.id, b]));
  const frameOK = (p) => p && p.geometry?.frame === "mupdf-display" && sameNumbers(p.geometry.bounds, [0, 0, p.width, p.height]) && Array.isArray(p.geometry.pageTransform) && p.geometry.pageTransform.length === 6 && p.geometry.pageTransform.every(Number.isFinite);
  for (const page of document.pages) {
    const next = document.pages.find((p) => p.sourcePageIndex === page.sourcePageIndex + 1);
    if (!frameOK(page) || !frameOK(next) || !sameNumbers(page.geometry.bounds, next.geometry.bounds) || !sameNumbers(page.geometry.pageTransform, next.geometry.pageTransform)) continue;
    const current = items.filter((i) => i.source.pageIndex === page.sourcePageIndex && !["header", "footer"].includes(i.kind));
    const caption = current.at(-1);
    if (caption?.kind !== "caption" || !boxOK2(caption.source.bbox) || caption.source.bbox[3] < page.height * 0.88 || relations.some((r) => r.kind === "caption" && r.captionItemId === caption.id)) continue;
    const blocks = caption.blockIds.map((id2) => blockMap.get(id2));
    if (blocks.some((b) => !b || b.source?.pageIndex !== page.sourcePageIndex || !b.source.range || page.text?.slice(b.source.range.start, b.source.range.end) !== b.text)) continue;
    const text = blocks.map((b) => b.text).join("");
    if (!/^\s*(?:extended\s+data\s+)?fig(?:ure)?\.?\s*\d/i.test(text) || !/[.!?][)\]"'\u2019\u201d]*\s*$/.test(text)) continue;
    const following = items.filter((i) => i.source.pageIndex === next.sourcePageIndex && !["header", "footer"].includes(i.kind));
    if (following.length !== 1 || following[0].kind !== "asset") continue;
    const artwork = following[0], box5 = artwork.source.bbox;
    const region = regions.find((r) => r.id === artwork.renderAssetId && r.pageIndex === next.sourcePageIndex && r.classification === "compound-figure");
    if (!region || !boxOK2(box5) || !sameNumbers(region.bbox, box5) || box5[2] - box5[0] < next.width * 0.7 || box5[3] - box5[1] < next.height * 0.7 || artwork.captionIds.length || region.blockIds.length !== artwork.blockIds.length || region.assetIds.length !== artwork.assetIds.length || region.blockIds.some((id2) => !artwork.blockIds.includes(id2)) || region.assetIds.some((id2) => !artwork.assetIds.includes(id2))) continue;
    artwork.captionIds.push(...caption.blockIds);
    artwork.captionPositions ||= {};
    for (const id2 of caption.blockIds) artwork.captionPositions[id2] = "above";
    relations.push({ kind: "caption", assetItemId: artwork.id, captionItemId: caption.id, position: "above", provenance: { rule: "adjacent-page-bottom-caption-full-page-artwork", sourceSha256: document.sourceSha256, captionPageIndex: page.sourcePageIndex, artworkPageIndex: next.sourcePageIndex, frame: "mupdf-display", regionId: region.id } });
    const unresolved = diagnostics.findIndex((d) => d.code === "caption-association-unresolved" && d.itemId === caption.id);
    if (unresolved >= 0) diagnostics.splice(unresolved, 1);
  }
  return { schema: "falsify.paper-flow.v1", sourceSha256: document.sourceSha256, items, relations, diagnostics, fragments, regions };
}
function ownedByAsset(x, entries) {
  return entries.some((e) => e.kind === "asset" && e.blockIds.includes(x.b.id));
}

// app/src/paper-source-assets.mjs
init_paragraph_pdf_crypto();
import * as mupdf3 from "./browser-pdf-vendor/mupdf.js";
var abort3 = (signal) => {
  if (signal?.aborted) {
    const e = new Error("Source asset reading cancelled");
    e.name = "AbortError";
    throw e;
  }
};
var validBox2 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
function collectFonts(resources, pageIndex, path, fonts, seen, ancestors = /* @__PURE__ */ new Set()) {
  if (!resources || resources.isNull()) return;
  const dict = resources.get("Font");
  if (dict.isDictionary()) dict.forEach((ref, name) => {
    const obj = ref.resolve(), descendants = obj.get("DescendantFonts");
    const descendant = descendants.isArray() && descendants.length ? descendants.get(0) : null;
    const descriptor = (descendant && !descendant.isNull() ? descendant : obj).get("FontDescriptor");
    const baseName = obj.get("BaseFont").asName() || null;
    const identity = { pageIndex, resourcePath: `${path}/Font/${name}`, objectNumber: ref.isIndirect() ? ref.asIndirect() : null };
    const key = `${pageIndex}:${identity.resourcePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    let bytes = null, format = null;
    for (const field of ["FontFile", "FontFile2", "FontFile3"]) {
      const stream = descriptor.isNull() ? null : descriptor.get(field);
      if (stream?.isStream()) {
        const buffer = stream.readStream();
        try {
          bytes = buffer.asUint8Array().slice();
        } finally {
          buffer.destroy();
        }
        format = field;
        break;
      }
    }
    fonts.push({ id: `font-${hex(new TextEncoder().encode(JSON.stringify(identity))).slice(0, 24)}`, family: baseName, source: identity, bytes, format, subtype: obj.get("Subtype").asName() || null, flags: !descriptor.isNull() && descriptor.get("Flags").isNumber() ? descriptor.get("Flags").asNumber() : null, embedded: !!bytes, embeddingPermissions: "unknown", subset: !!baseName && /^[A-Z]{6}\+/.test(baseName), coverage: "unverified" });
  });
  const xobjects = resources.get("XObject");
  if (xobjects.isDictionary()) xobjects.forEach((ref, name) => {
    const key = ref.isIndirect() ? ref.asIndirect() : null;
    if (key !== null && ancestors.has(key)) return;
    const obj = ref.resolve();
    if (obj.get("Subtype").asName() !== "Form") return;
    const next = new Set(ancestors);
    if (key !== null) next.add(key);
    collectFonts(obj.get("Resources"), pageIndex, `${path}/XObject/${name}/Resources`, fonts, seen, next);
  });
}
async function readSourceAssets({ bytes, document, regions = [], signal } = {}) {
  abort3(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document || !Array.isArray(regions)) throw new TypeError("Expected source bytes, document and regions");
  const snapshot = Uint8Array.from(bytes), sourceSha256 = hex(snapshot);
  document = structuredClone(document);
  regions = structuredClone(regions);
  if (document.sourceSha256 !== sourceSha256) throw new Error("Source hash mismatch");
  const assets = document.assets || [], fonts = [], diagnostics = [], drawings = [];
  const ids = /* @__PURE__ */ new Set(), occurrences = /* @__PURE__ */ new Set();
  for (const asset of assets) {
    if (!asset.id || ids.has(asset.id)) throw new Error(`Duplicate or missing asset ID: ${asset.id}`);
    ids.add(asset.id);
    if (asset.source?.occurrence != null) {
      const key = `${asset.source.pageIndex}:${asset.source.occurrence}`;
      if (occurrences.has(key)) throw new Error(`Duplicate asset occurrence: ${key}`);
      occurrences.add(key);
    }
  }
  for (const region of regions) {
    if (!region?.id || ids.has(region.id)) throw new Error(`Duplicate or missing region ID: ${region?.id}`);
    ids.add(region.id);
  }
  for (const block of document.blocks || []) {
    const r = block.source?.range;
    if (r && (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end < r.start || typeof block.text !== "string" || r.end - r.start !== block.text.length || document.pages?.[block.source.pageIndex]?.text?.slice(r.start, r.end) !== block.text)) throw new Error(`Unsafe source range for block: ${block.id}`);
  }
  let pdf;
  try {
    pdf = mupdf3.Document.openDocument(snapshot, "application/pdf").asPDF();
    if (!pdf || pdf.needsPassword()) throw new Error("Unsupported PDF");
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < pdf.countPages(); i++) {
      abort3(signal);
      const page = pdf.loadPage(i);
      try {
        collectFonts(page.getObject().getInheritable("Resources"), i, "Resources", fonts, seen);
        const dev = new mupdf3.Device({
          fillPath(path, evenOdd, ctm, colorspace) {
            try {
              drawings.push({ pageIndex: i, bbox: path.getBounds(null, ctm), operation: "fill" });
            } finally {
              path.destroy();
              colorspace.destroy();
            }
          },
          strokePath(path, stroke, ctm, colorspace) {
            try {
              drawings.push({ pageIndex: i, bbox: path.getBounds(stroke, ctm), operation: "stroke" });
            } finally {
              path.destroy();
              stroke.destroy();
              colorspace.destroy();
            }
          }
        });
        try {
          page.run(dev, mupdf3.Matrix.identity);
          dev.close();
        } finally {
          dev.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    for (const region of regions) {
      abort3(signal);
      if (!region || typeof region.id !== "string" || !region.id || !Number.isInteger(region.pageIndex) || region.pageIndex < 0 || region.pageIndex >= pdf.countPages() || !validBox2(region.bbox) || !Array.isArray(region.blockIds)) throw new TypeError("Invalid source region");
      const page = pdf.loadPage(region.pageIndex);
      let device, pixmap;
      try {
        const bounds = page.getBounds(), b = region.bbox;
        if (b[0] < bounds[0] || b[1] < bounds[1] || b[2] > bounds[2] || b[3] > bounds[3]) throw new RangeError("Region outside source page");
        const scale = 3, width = b[2] - b[0], height = b[3] - b[1];
        const pw = Math.ceil(width * scale), ph = Math.ceil(height * scale);
        if (pw * ph > 1e8) throw new RangeError("Region raster exceeds 100 million pixels");
        pixmap = new mupdf3.Pixmap(mupdf3.ColorSpace.DeviceRGB, [0, 0, pw, ph], true);
        pixmap.clear();
        device = new mupdf3.DrawDevice(mupdf3.Matrix.identity, pixmap);
        page.run(device, [scale, 0, 0, scale, -b[0] * scale, -b[1] * scale]);
        device.close();
        device.destroy();
        device = null;
        const png = pixmap.asPNG();
        let binary = "";
        for (let i = 0; i < png.length; i += 32768) binary += String.fromCharCode(...png.subarray(i, i + 32768));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${pw / scale}" height="${ph / scale}" href="data:image/png;base64,${btoa(binary)}"/></svg>`;
        assets.push({ id: region.id, kind: "region", source: { pageIndex: region.pageIndex, bbox: [...b], blockIds: [...region.blockIds], assetIds: [...region.assetIds || []] }, content: { representation: "mupdf-cropped-svg", encoding: "raster-png", dpi: 216, bytes: new TextEncoder().encode(svg), width, height } });
      } finally {
        device?.destroy();
        pixmap?.destroy();
        page.destroy();
      }
    }
  } finally {
    pdf?.destroy();
  }
  return { sourceSha256, assets, fonts, drawings, diagnostics };
}

// app/src/paper-fonts.mjs
async function inspectFonts(text, fonts = {}) {
  const codepoints = [...new Set(Array.from(text, (c) => c.codePointAt(0)))].filter((cp) => cp !== 9 && cp !== 10 && cp !== 13);
  if (typeof fonts.hasGlyph !== "function") return { status: "unavailable", missing: [], detail: "Font coverage API unavailable; full-font coverage and fallback are unverified." };
  try {
    const missing = [];
    for (const cp of codepoints) if (!await fonts.hasGlyph(cp)) missing.push(cp);
    return { status: missing.length ? "missing" : "covered", missing };
  } catch (error2) {
    return { status: "unavailable", missing: [], detail: `Font coverage failed: ${error2.message}` };
  }
}
var isScalar = (cp) => Number.isInteger(cp) && cp >= 0 && cp <= 1114111 && !(cp >= 55296 && cp <= 57343);
var isLayoutControl = (cp) => cp === 9 || cp === 10 || cp === 13;
var hex2 = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function fontFamily(bytes) {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tables = v.getUint16(4), decoder = new TextDecoder("utf-16be");
    for (let i = 0; i < tables; i++) {
      const t = 12 + i * 16;
      if (v.getUint32(t) !== 1851878757) continue;
      const base = v.getUint32(t + 8), count = v.getUint16(base + 2), strings = base + v.getUint16(base + 4), names = [];
      for (let j = 0; j < count; j++) {
        const n = base + 6 + j * 12, platform = v.getUint16(n), language = v.getUint16(n + 4), id2 = v.getUint16(n + 6), len = v.getUint16(n + 8), off = v.getUint16(n + 10);
        if (id2 !== 1 && id2 !== 16 || platform !== 0 && platform !== 3) continue;
        const value = decoder.decode(bytes.subarray(strings + off, strings + off + len)).replace(/\0/g, "").trim();
        if (value) names.push({ value, rank: (id2 === 16 ? 4 : 0) + (language === 1033 ? 2 : 0) + (platform === 3 ? 1 : 0) });
      }
      return names.sort((a, b) => b.rank - a.rank)[0]?.value || null;
    }
  } catch {
  }
  return null;
}
async function createFontPlan({ text, fonts = [] }, { mupdf: mupdf6 } = {}) {
  if (typeof text !== "string" || !Array.isArray(fonts)) throw new TypeError("Expected text and fonts array");
  const codepoints = [...new Set(Array.from(text, (c) => c.codePointAt(0)))];
  if (!codepoints.every(isScalar)) throw new TypeError("Text contains an invalid Unicode scalar");
  const glyphCodepoints = codepoints.filter((cp) => !isLayoutControl(cp));
  const layoutControls = codepoints.filter(isLayoutControl);
  const ids = /* @__PURE__ */ new Set();
  const snapshots = fonts.map((input) => {
    const id2 = input?.id, family = input?.family, source = input?.bytes;
    if (typeof id2 !== "string" || !id2 || ids.has(id2) || typeof family !== "string" || !family) throw new TypeError("Each font needs a unique id and family");
    ids.add(id2);
    return { id: id2, family, bytes: source instanceof ArrayBuffer ? new Uint8Array(source.slice(0)) : source instanceof Uint8Array ? Uint8Array.from(source) : null };
  });
  const candidates = [];
  for (const { id: id2, family: suppliedFamily, bytes: snapshot } of snapshots) {
    let bytes, sha2562 = null, buffer, font;
    const family = fontFamily(snapshot || new Uint8Array()) || suppliedFamily;
    const glyphs = /* @__PURE__ */ new Map();
    let detail = null;
    try {
      if (!snapshot) throw new TypeError("Font bytes unavailable");
      bytes = snapshot;
      sha2562 = hex2(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
      if (!mupdf6?.Buffer || !mupdf6?.Font) throw new Error("MuPDF font API unavailable");
      buffer = new mupdf6.Buffer(bytes);
      font = new mupdf6.Font(id2, buffer);
      for (const cp of glyphCodepoints) {
        const gid = font.encodeCharacter(cp);
        if (!Number.isInteger(gid) || gid < 0) throw new Error("Invalid glyph result");
        glyphs.set(cp, gid !== 0);
      }
    } catch (error2) {
      detail = String(error2?.message || error2);
      glyphs.clear();
    } finally {
      try {
        font?.destroy();
      } finally {
        buffer?.destroy();
      }
    }
    const coverage = detail ? { status: "unavailable", missing: [], detail } : { status: glyphCodepoints.every((cp) => glyphs.get(cp)) ? "covered" : "missing", missing: glyphCodepoints.filter((cp) => !glyphs.get(cp)) };
    candidates.push(Object.freeze({
      id: id2,
      family,
      sha256: sha2562,
      coverage: Object.freeze({ ...coverage, missing: Object.freeze(coverage.missing) }),
      getBytes: () => bytes?.slice() ?? null,
      hasGlyph: (cp) => isScalar(cp) && glyphs.has(cp) ? glyphs.get(cp) : null
    }));
  }
  const selected = candidates.find((c) => c.coverage.status === "covered") || null;
  const fallback = codepoints.map((codepoint) => {
    if (isLayoutControl(codepoint)) return Object.freeze({ codepoint, kind: "layout-control", fontId: null, family: null });
    const candidate = selected || candidates.find((c) => c.hasGlyph(codepoint) === true);
    return Object.freeze({ codepoint, kind: "glyph", fontId: candidate?.id ?? null, family: candidate?.family ?? null });
  });
  const missing = fallback.filter((x) => x.kind === "glyph" && x.fontId === null).map((x) => x.codepoint);
  const unavailable = missing.length > 0 && candidates.some((c) => c.coverage.status === "unavailable") || candidates.length === 0;
  const status = unavailable ? "unavailable" : missing.length ? "missing" : "covered";
  return Object.freeze({
    status,
    selected,
    candidates: Object.freeze(candidates),
    codepoints: Object.freeze(codepoints),
    layoutControls: Object.freeze(layoutControls),
    missing: Object.freeze(missing),
    fallback: Object.freeze(fallback),
    hasGlyph: (cp) => isScalar(cp) && codepoints.includes(cp) && !isLayoutControl(cp) ? fallback.find((x) => x.codepoint === cp).fontId !== null ? true : unavailable ? null : false : null
  });
}

// app/src/paper-style-profile.mjs
var median2 = (values) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};
function deriveLayoutProfile(document, flow) {
  const styles = new Map((document.styles || []).map((s) => [s.id, s]));
  const blocks = new Map((document.blocks || []).map((b) => [b.id, b]));
  const items = flow?.items || [];
  const byKind = (kind) => items.filter((i) => i.kind === kind).flatMap((i) => (i.blockIds || []).map((id2) => blocks.get(id2)).filter(Boolean));
  const body = byKind("paragraph");
  const stats = (bs) => {
    const sizes = [], names = [];
    for (const b of bs) {
      const chars = b.source?.characters || [];
      if (chars.length) for (const c of chars) {
        const s = styles.get(c.styleId);
        const n = Math.max(1, (c.end || 0) - (c.start || 0));
        if (s?.size > 0) for (let i = 0; i < Math.min(n, 256); i++) sizes.push(s.size);
        if (s?.fontName) names.push(s.fontName);
      }
      else {
        const s = styles.get(b.styleId);
        if (s?.size > 0) sizes.push(s.size);
        if (s?.fontName) names.push(s.fontName);
      }
    }
    return { size: median2(sizes), fontNames: [...new Set(names)] };
  };
  const rhythm = [];
  for (const b of body) {
    const lines = b.source?.lines || [];
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1].bbox, z = lines[i].bbox;
      if (Array.isArray(a) && Array.isArray(z)) {
        const d = z[1] - a[1];
        if (d > 0 && d < 50) rhythm.push(d);
      }
    }
  }
  const bodyStats = stats(body), headingStats = stats(byKind("heading")), captionStats = stats(byKind("caption"));
  const columnGroups = /* @__PURE__ */ new Map();
  for (const i of items) {
    const box5 = i.source?.bbox, pi = i.source?.pageIndex, page = document.pages?.find((p) => p.sourcePageIndex === pi) || document.pages?.[pi];
    if (i.columns !== 2 || !Array.isArray(box5) || !Number.isFinite(page?.width)) continue;
    const side = (box5[0] + box5[2]) / 2 < page.width / 2 ? "left" : "right", key = `${pi}:${side}`;
    const prev = columnGroups.get(key);
    columnGroups.set(key, { pageIndex: pi, bbox: prev ? [Math.min(prev.bbox[0], box5[0]), Math.min(prev.bbox[1], box5[1]), Math.max(prev.bbox[2], box5[2]), Math.max(prev.bbox[3], box5[3])] : [...box5] });
  }
  const columns = [...columnGroups.values()];
  const captions = items.filter((i) => i.kind === "asset").flatMap((i) => (i.captionIds || []).map((id2) => ({ text: blocks.get(id2)?.text || "", assetPageIndex: i.source?.pageIndex, assetBbox: i.source?.bbox ? [...i.source.bbox] : null })));
  return { coordinateSpace: "source", bodyFontSize: bodyStats.size, bodyFontNames: bodyStats.fontNames, bodyLineHeight: median2(rhythm), headingFontSize: headingStats.size, headingFontNames: headingStats.fontNames, captionFontSize: captionStats.size, captionFontNames: captionStats.fontNames, captions, headings: byKind("heading").map((b) => ({ text: b.text })), columns };
}

// app/src/paper-link-plan.mjs
init_paragraph_pdf_crypto();
var overlaps2 = (a, b) => a.start < b.end && b.start < a.end;
var labelFor = (key) => `link-target-${hex(new TextEncoder().encode(JSON.stringify(key))).slice(0, 24)}`;
var validRange = (r) => Number.isSafeInteger(r?.start) && Number.isSafeInteger(r?.end) && r.start >= 0 && r.start < r.end;
function buildLinkPlan({ document, flow, links, edits = [] } = {}) {
  if (!document || !flow || !links || !Array.isArray(flow.items) || !Array.isArray(links.links) || !Array.isArray(edits)) throw new TypeError("Expected document, flow, link inventory and edits");
  if (!document.sourceSha256 || document.sourceSha256 !== flow.sourceSha256 || document.sourceSha256 !== links.sourceSha256) throw new Error("Source hash mismatch");
  const blocks = new Map([...document.blocks || [], ...flow.fragments || []].map((b) => [b.id, b]));
  const parents = new Map((document.blocks || []).map((b) => [b.id, b]));
  const owned = [];
  for (const item of flow.items) for (const id2 of item.blockIds || []) {
    const block = blocks.get(id2);
    if (block?.source?.range) owned.push({ item, block, parentId: block.parentBlockId || id2 });
  }
  const assetItem = (id2) => flow.items.find((i) => i.kind === "asset" && (i.assetIds || []).includes(id2));
  const diagnostics = [], targets = [], targetMap = /* @__PURE__ */ new Map(), raw = [], sourceAssets = [];
  const nativeEdits = [];
  for (const e of edits) {
    if (e.enabled === false) continue;
    const p = parents.get(e.blockId), r = p?.source?.range;
    if (!p || !validRange(e) || e.pageIndex !== p.source.pageIndex || e.start < r.start || e.end > r.end || typeof e.before !== "string" || typeof e.after !== "string" || p.text.slice(e.start - r.start, e.end - r.start) !== e.before) {
      diagnostics.push({ code: "edit-unmapped", editId: e.id ?? null });
      continue;
    }
    nativeEdits.push(e);
  }
  function target(link) {
    const t = link.target, rel = t?.relation;
    if (t?.status !== "resolved" || !rel) {
      diagnostics.push({ code: "target-unresolved", linkId: link.id });
      return null;
    }
    const page = t.pageIndex;
    let loc;
    if (rel.status === "text") {
      const matches = owned.filter((o) => o.parentId === rel.blockId && o.item.kind !== "asset" && o.block.source.pageIndex === page && o.block.source.range.start <= rel.start && o.block.source.range.end >= rel.end);
      const changed = nativeEdits.filter((e) => e.blockId === rel.blockId && overlaps2(e, rel));
      if (changed.length) {
        const change = changed.some((e) => e.after === "") ? "deleted" : "replaced";
        targets.push({ status: change, sourcePage: page, sourceRelation: { ...rel }, linkIds: [link.id], editIds: changed.map((e) => e.id ?? null) });
        diagnostics.push({ code: "target-changed", linkId: link.id, editIds: changed.map((e) => e.id ?? null), change });
        return null;
      }
      if (matches.length === 1) loc = { blockId: matches[0].block.id, start: rel.start, end: rel.end };
      else {
        const assets = owned.filter((o) => o.parentId === rel.blockId && o.item.kind === "asset" && o.block.source.pageIndex === page && o.block.source.range.start <= rel.start && o.block.source.range.end >= rel.end);
        if (assets.length === 1) loc = { assetItemId: assets[0].item.id };
      }
    } else if (rel.status === "asset") {
      const i = assetItem(rel.assetId);
      if (i && i.source?.pageIndex === page) loc = { assetItemId: i.id };
    } else if (rel.status === "page-anchor") {
      for (const i of flow.items) {
        if (i.source?.pageIndex !== page || i.kind === "header" || i.kind === "footer") continue;
        if (i.kind === "asset") {
          loc = { assetItemId: i.id };
          break;
        }
        for (const id2 of i.blockIds || []) {
          const b = blocks.get(id2), r = b?.source?.range;
          if (!r) continue;
          let at = r.start;
          while (at < r.end) {
            const edit = nativeEdits.find((e) => e.blockId === (b.parentBlockId || b.id) && e.start <= at && at < e.end);
            if (!edit) break;
            at = edit.end;
          }
          if (at < r.end) {
            loc = { blockId: b.id, start: at, end: at };
            break;
          }
        }
        if (loc) break;
      }
    }
    if (!loc) {
      diagnostics.push({ code: "target-unmapped", linkId: link.id, sourcePage: page });
      return null;
    }
    const key2 = [document.sourceSha256, page, loc], label = labelFor(key2);
    if (!targetMap.has(label)) {
      const x = { label, sourcePage: page, ...loc };
      targetMap.set(label, x);
      targets.push(x);
    }
    return label;
  }
  for (const link of links.links) {
    const destinationLabel = link.external ? null : target(link);
    const dest = link.external ? { uri: link.uri } : destinationLabel ? { destinationLabel, uri: link.uri } : { uri: link.uri, destinationStatus: targets.find((t) => t.linkIds?.includes(link.id))?.status || "unresolved" };
    for (const range of link.relation?.ranges || []) {
      if (!validRange(range)) {
        diagnostics.push({ code: "source-range-invalid", linkId: link.id });
        continue;
      }
      let found = false;
      for (const o of owned) {
        if (o.parentId !== range.blockId || o.block.source.pageIndex !== link.source?.pageIndex || o.item.kind === "asset") continue;
        const r = o.block.source.range, start = Math.max(range.start, r.start), end = Math.min(range.end, r.end);
        if (start < end) {
          raw.push({ blockId: o.block.id, parentBlockId: o.parentId, start, end, ...dest, linkIds: [link.id] });
          found = true;
        }
      }
      if (!found && !owned.some((o) => o.parentId === range.blockId && o.item.kind === "asset" && overlaps2(o.block.source.range, range))) diagnostics.push({ code: "source-unmapped", linkId: link.id, blockId: range.blockId });
    }
    for (const id2 of link.relation?.assetIds || []) {
      const item = assetItem(id2);
      if (item) sourceAssets.push({ assetItemId: item.id, assetId: id2, ...dest, linkIds: [link.id] });
      else diagnostics.push({ code: "source-asset-unmapped", linkId: link.id, assetId: id2 });
    }
  }
  const key = (r) => JSON.stringify([r.blockId, r.uri, r.destinationLabel, r.destinationStatus]);
  raw.sort((a, b) => a.blockId.localeCompare(b.blockId) || a.start - b.start || a.end - b.end || key(a).localeCompare(key(b)));
  const sourceRuns = [];
  for (const r of raw) {
    const prior = sourceRuns.find((x) => key(x) === key(r) && r.start < x.end && x.start < r.end);
    if (prior) {
      prior.start = Math.min(prior.start, r.start);
      prior.end = Math.max(prior.end, r.end);
      prior.linkIds = [.../* @__PURE__ */ new Set([...prior.linkIds, ...r.linkIds])];
    } else sourceRuns.push({ ...r, linkIds: [...r.linkIds] });
  }
  for (let i = 0; i < sourceRuns.length; i++) for (let j = i + 1; j < sourceRuns.length; ) {
    const a = sourceRuns[i], b = sourceRuns[j];
    if (key(a) === key(b) && overlaps2(a, b)) {
      a.start = Math.min(a.start, b.start);
      a.end = Math.max(a.end, b.end);
      a.linkIds = [.../* @__PURE__ */ new Set([...a.linkIds, ...b.linkIds])];
      sourceRuns.splice(j, 1);
      j = i + 1;
    } else j++;
  }
  for (let i = 0; i < sourceRuns.length; i++) for (let j = i + 1; j < sourceRuns.length; j++) {
    const a = sourceRuns[i], b = sourceRuns[j];
    if (a.blockId === b.blockId && key(a) !== key(b) && overlaps2(a, b)) {
      a.conflicted = true;
      b.conflicted = true;
      diagnostics.push({ code: "source-link-conflict", blockId: a.blockId, start: Math.max(a.start, b.start), end: Math.min(a.end, b.end), linkIds: [.../* @__PURE__ */ new Set([...a.linkIds, ...b.linkIds])] });
    }
  }
  const changes = nativeEdits.map((e) => {
    const portions = sourceRuns.filter((r) => r.parentBlockId === e.blockId && overlaps2(r, e)).map((r) => ({ blockId: r.blockId, start: Math.max(r.start, e.start), end: Math.min(r.end, e.end), linkIds: [...r.linkIds], ...r.destinationLabel ? { destinationLabel: r.destinationLabel, uri: r.uri } : { uri: r.uri }, conflicted: !!r.conflicted }));
    const candidates = links.links.filter((l) => (l.relation?.ranges || []).some((r) => r.blockId === e.blockId && r.start <= e.start && r.end >= e.end));
    const destinations = new Set(candidates.map((l) => JSON.stringify([l.external, l.uri, l.target])));
    const ordered = [...portions].sort((a, b) => a.start - b.start);
    let cursor = e.start;
    for (const p of ordered) if (p.start <= cursor) cursor = Math.max(cursor, p.end);
    const covered = cursor >= e.end && portions.every((p) => !p.conflicted) && candidates.length && destinations.size === 1 && candidates.every((l) => l.external || sourceRuns.some((r) => r.linkIds.includes(l.id) && r.destinationLabel));
    return { editId: e.id ?? null, blockId: e.blockId, start: e.start, end: e.end, portions, inherit: covered ? { linkIds: candidates.map((l) => l.id), ...candidates[0].external ? { uri: candidates[0].uri } : { destinationLabel: targetMap.size ? sourceRuns.find((r) => r.linkIds.includes(candidates[0].id))?.destinationLabel : void 0, uri: candidates[0].uri } } : null };
  });
  return { schema: "falsify.paper-link-plan.v1", sourceSha256: document.sourceSha256, sourceRuns, sourceAssets, targets, changes, diagnostics };
}

// app/src/paper-source-glyphs.mjs
import * as mupdf4 from "./browser-pdf-vendor/mupdf.js";
function readSourceGlyphs({ bytes, document, changes = /* @__PURE__ */ new Map() }) {
  const styles = new Map((document.styles || []).map((s) => [s.id, s]));
  const targets = [];
  for (const block of document.blocks) for (const c of block.source?.characters || []) {
    const start = c.start - block.source.range.start, end = c.end - block.source.range.start;
    const value = block.text.slice(start, end), cp = value.codePointAt(0);
    if (!(value.length === 1 && (cp === 65533 || cp < 32 && cp !== 9 && cp !== 10 && cp !== 13 || cp === 127 || cp >= 55296 && cp <= 57343))) continue;
    if ((changes.get(block.id) || []).some((e) => start < e.end && end > e.start)) continue;
    const line = (block.source.lines || []).find((l) => l.range.start <= c.start && l.range.end >= c.end);
    targets.push({ blockId: block.id, pageIndex: block.source.pageIndex, start: c.start, end: c.end, bbox: c.bbox, font: styles.get(c.styleId)?.fontName, baseline: line?.baseline?.[0]?.[1], matches: [] });
  }
  if (!targets.length) return { glyphs: [], unavailable: [] };
  let doc, failure;
  try {
    doc = mupdf4.Document.openDocument(bytes, "application/pdf");
    for (const pageIndex of new Set(targets.map((t) => t.pageIndex))) {
      const page = doc.loadPage(pageIndex);
      const dev = new mupdf4.Device({ fillText(text, ctm, cs, color, alpha) {
        try {
          text.walk({ showGlyph(font, trm, gid, scalar, wmode) {
            try {
              if (!(scalar === 65533 || scalar < 32 || scalar === 127 || scalar >= 55296 && scalar <= 57343 || scalar > 1114111)) return;
              const matrix = mupdf4.Matrix.concat(trm, ctm), name = font.getName();
              for (const target of targets) {
                const b = target.bbox;
                if (target.pageIndex !== pageIndex || target.font !== name || !b || !Number.isFinite(target.baseline) || !matrix.every(Number.isFinite) || Math.abs(matrix[4] - b[0]) > 0.05 || matrix[5] < b[1] - 0.05 || matrix[5] > b[3] + 0.05 || wmode !== 0 || Math.abs(matrix[1]) > 1e-3 || Math.abs(matrix[2]) > 1e-3 || matrix[0] <= 0 || matrix[3] >= 0) continue;
                const glyph = new mupdf4.Text();
                let buffer, writer, out;
                try {
                  glyph.showGlyph(font, trm, gid, scalar, wmode);
                  const ink = glyph.getBounds(null, ctm), width = ink[2] - ink[0], height = ink[3] - ink[1];
                  const advance = font.advanceGlyph(gid, wmode) * Math.hypot(matrix[0], matrix[1]);
                  if (!ink.every(Number.isFinite) || width <= 0 || height <= 0 || advance <= 0) continue;
                  buffer = new mupdf4.Buffer();
                  writer = new mupdf4.DocumentWriter(buffer, "svg", "");
                  out = writer.beginPage([0, 0, width, height]);
                  out.fillText(glyph, mupdf4.Matrix.concat(ctm, [1, 0, 0, 1, -ink[0], -ink[1]]), cs, color, alpha);
                  writer.endPage();
                  writer.close();
                  target.matches.push({ gid, scalar, trm: [...trm], ctm: [...ctm], ink, origin: [matrix[4], matrix[5]], width, height, advance, baselineShift: ink[3] - target.baseline, offsetX: ink[0] - matrix[4], bytes: new Uint8Array(buffer.asUint8Array()) });
                } finally {
                  out?.destroy();
                  writer?.destroy();
                  buffer?.destroy();
                  glyph.destroy();
                }
              }
            } finally {
              font.destroy();
            }
          } });
        } finally {
          text.destroy();
          cs?.destroy();
        }
      } });
      try {
        page.run(dev, mupdf4.Matrix.identity);
        dev.close();
      } finally {
        dev.destroy();
        page.destroy();
      }
    }
  } catch (error2) {
    failure = String(error2?.message || error2);
  } finally {
    doc?.destroy();
  }
  const glyphs = [], unavailable = [];
  for (const { matches, ...target } of targets) {
    const shared = matches.length === 1 && targets.some((other) => other !== targets.find((t) => t.matches === matches) && other.pageIndex === target.pageIndex && other.matches.some((m) => JSON.stringify(m.ctm) === JSON.stringify(matches[0].ctm) && JSON.stringify(m.trm) === JSON.stringify(matches[0].trm) && m.gid === matches[0].gid));
    if (!failure && matches.length === 1 && !shared) glyphs.push({ ...target, ...matches[0] });
    else unavailable.push({ ...target, reason: failure ? "paint-read-failed" : matches.length || shared ? "ambiguous-paint-match" : "no-paint-match", ...failure ? { detail: failure } : {} });
  }
  return { glyphs, unavailable };
}

// app/src/paper-source-wrap.mjs
init_paragraph_pdf_crypto();
var box2 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
var near2 = (a, b, t = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= t;
var tokenChar = (c) => !!c && /[\p{L}\p{N}\p{M}_\-−–]/u.test(c);
var addressLike = (text) => /(?:https?:\/\/|www\.|@|[\\/])/iu.test(text);
function findSourceWrapOmissions({ document, bytes } = {}) {
  if (!document || !/^[a-f0-9]{64}$/.test(document.sourceSha256 || "") || !Array.isArray(document.pages) || !Array.isArray(document.blocks)) throw new TypeError("Expected source document");
  if (bytes !== void 0) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError("Expected source bytes");
    if (hex(bytes) !== document.sourceSha256) {
      const e = new Error("Source hash mismatch");
      e.code = "stale-source";
      throw e;
    }
  }
  const verified = [], styles = new Map((document.styles || []).map((s) => [s.id, s]));
  for (const block of document.blocks) {
    const s = block.source, p = document.pages[s?.pageIndex], r = s?.range;
    if (!block.text || !r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end - r.start !== block.text.length || p?.sourcePageIndex !== s.pageIndex || p.geometry?.frame !== "mupdf-display" || !Array.isArray(p.geometry.pageTransform) || p.geometry.pageTransform.length !== 6 || !p.geometry.pageTransform.every(Number.isFinite) || !near2(p.geometry.pageTransform[1], 0) || !near2(p.geometry.pageTransform[2], 0) || p.geometry.pageTransform[0] <= 0 || p.geometry.pageTransform[3] >= 0 || p.text?.slice(r.start, r.end) !== block.text || !Array.isArray(s.lines) || !Array.isArray(s.characters)) continue;
    const lines = [];
    let cursor = r.start;
    for (const line of s.lines) {
      const lr = line.range, chars = s.characters.filter((c) => c.start >= lr?.start && c.end <= lr?.end);
      if (!lr || lr.start !== cursor || !Number.isInteger(lr.end) || lr.end <= lr.start || lr.end > r.end || !box2(line.bbox) || line.writingMode !== 0 || !near2(line.direction?.[0], 1) || !near2(line.direction?.[1], 0) || !Array.isArray(line.baseline) || line.baseline.length !== 2 || !near2(line.baseline[0]?.[1], line.baseline[1]?.[1], 0.1) || !chars.length || chars[0].start !== lr.start || chars.at(-1).end !== lr.end || chars.some((c, i) => !box2(c.bbox) || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.end <= c.start || /mono|courier|consolas/iu.test(styles.get(c.styleId)?.fontName || "") || i > 0 && c.start !== chars[i - 1].end)) {
        lines.length = 0;
        break;
      }
      lines.push({ line, chars, text: p.text.slice(lr.start, lr.end) });
      cursor = lr.end;
    }
    if (lines.length && cursor === r.end && s.characters.length === lines.reduce((n, l) => n + l.chars.length, 0)) verified.push({ block, lines });
  }
  const occurrences = (word, exclude) => verified.flatMap(({ block, lines }) => lines.flatMap(({ line, text }) => {
    const found = [];
    let at = -1;
    while ((at = text.indexOf(word, at + 1)) !== -1) {
      if (!addressLike(text) && !tokenChar(text[at - 1]) && !tokenChar(text[at + word.length])) {
        const start = line.range.start + at, end = start + word.length;
        if (!(exclude && block.source.pageIndex === exclude.pageIndex && start < exclude.end && end > exclude.start) && !(block.source.wordSpaceOffsets || []).some((x) => x > start && x < end)) found.push({ pageIndex: block.source.pageIndex, blockId: block.id, start, end });
      }
    }
    return found;
  }));
  const omissions = [];
  for (const { block, lines } of verified) for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i], b = lines[i + 1], boundary = a.line.range.end;
    if (boundary !== b.line.range.start || b.line.baseline[0][1] <= a.line.baseline[0][1] || b.line.baseline[0][1] - a.line.baseline[0][1] > 3 * Math.max(a.line.bbox[3] - a.line.bbox[1], b.line.bbox[3] - b.line.bbox[1]) || (block.source.wordSpaceOffsets || []).includes(boundary)) continue;
    if (addressLike(a.text + b.text)) continue;
    const left = a.text.match(/(?:^|[^\p{L}\p{N}\p{M}_\-−–])([a-z]{3,})-$/u), right = b.text.match(/^([a-z]{2,})(?=$|[^\p{L}\p{N}\p{M}_\-−–])/u);
    if (!left || !right) continue;
    const start = boundary - 1 - left[1].length, end = boundary + right[1].length;
    if ((block.source.wordSpaceOffsets || []).some((x) => x > start && x < end)) continue;
    const joined = left[1] + right[1], compound = left[1] + "-" + right[1];
    const corroboration = occurrences(joined, { pageIndex: block.source.pageIndex, start, end });
    if (!corroboration.length || occurrences(compound).length) continue;
    omissions.push({ blockId: block.id, pageIndex: block.source.pageIndex, start: boundary - 1, end: boundary, evidence: { joined, sourceRange: { start, end }, lineRanges: [{ ...a.line.range }, { ...b.line.range }], corroboration } });
  }
  return { sourceSha256: document.sourceSha256, omissions };
}
function sourceWrapOffsetsForBlock(block, omissions) {
  const r = block?.source?.range;
  if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || typeof block.text !== "string" || r.end - r.start !== block.text.length) return [];
  return (omissions || []).filter((o) => o.pageIndex === block.source.pageIndex && (o.blockId === block.id || o.blockId === block.parentBlockId) && o.start >= r.start && o.end === o.start + 1 && o.end <= r.end && block.text[o.start - r.start] === "-").map((o) => o.start - r.start);
}

// app/src/paper-compose.mjs
var abort4 = (signal) => {
  if (signal?.aborted) throw new DOMException("Composition cancelled", "AbortError");
};
var fail = (message) => {
  throw new Error(message);
};
var captionOrder = (item) => [...(item.captionIds || []).filter((id2) => item.captionPositions?.[id2] === "above"), ...(item.captionIds || []).filter((id2) => item.captionPositions?.[id2] !== "above")];
var hash = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
function typstString(value) {
  return '"' + Array.from(value, (c) => {
    const n = c.codePointAt(0);
    if (c === '"' || c === "\\") return "\\" + c;
    if (n < 32 || n === 127) return `\\u{${n.toString(16)}}`;
    return c;
  }).join("") + '"';
}
function lineBoundaries(block) {
  const { range, lines = [] } = block.source;
  if (!range || range.end - range.start !== block.text.length) fail("Invalid block source range");
  let prev = range.start;
  const bounds = [];
  for (const line of lines) {
    const r = line.range;
    if (!r || r.start !== prev || r.end < r.start || r.end > range.end) fail("Invalid line ranges");
    if (r.start > range.start) bounds.push(r.start - range.start);
    prev = r.end;
  }
  if (lines.length && prev !== range.end) fail("Incomplete line ranges");
  return bounds;
}
function separators(block) {
  const raw = block.text, base = block.source.range.start;
  const hints = new Set((block.source.wordSpaceOffsets || []).filter((x) => Number.isInteger(x) && x > base && x < base + raw.length).map((x) => x - base));
  const guessed = lineBoundaries(block).filter((i) => i > 0 && i < raw.length && !/\s/u.test(raw[i - 1]) && !/\s/u.test(raw[i]) && raw[i - 1] !== "-" && !(raw[i - 1] === "\u2212" && /[0-9]/u.test(raw[i])));
  return new Set([...guessed, ...hints].filter((i) => !/\s/u.test(raw[i - 1]) && !/\s/u.test(raw[i])));
}
function logicalText(block, changes, omitted = /* @__PURE__ */ new Set(), spaces = separators(block)) {
  const raw = block.text;
  let logical = "";
  const before = [], after = [];
  for (let i = 0; i <= raw.length; i++) {
    before[i] = logical.length;
    if (spaces.has(i)) logical += " ";
    after[i] = logical.length;
    if (i < raw.length && !omitted.has(i)) logical += raw[i];
  }
  let out = "", cursor = 0;
  for (const edit of [...changes].sort((a, b) => a.start - b.start)) {
    const start = after[edit.start], end = before[edit.end];
    out += logical.slice(cursor, start) + edit.after;
    cursor = end;
  }
  return out + logical.slice(cursor);
}
function ambiguousBoundaries(block, changes) {
  const raw = block.text;
  return lineBoundaries(block).filter((i) => !(block.source.wordSpaceOffsets || []).includes(i + block.source.range.start) && i > 0 && i < raw.length && !changes.some((e) => e.start < i && i < e.end) && !/\s/u.test(raw[i - 1]) && !/\s/u.test(raw[i]) && raw[i - 1] !== "-" && !(raw[i - 1] === "\u2212" && /[0-9]/u.test(raw[i])));
}
async function composeDocument({ document, edits = [], flow, assets, links, signal, sourceBytes, runningFurniture = false, layoutPolicy, layoutMode, figurePlacement = "float" } = {}, { compile, fonts = {}, outputCheck, furniturePlanner } = {}) {
  abort4(signal);
  if (document) document = structuredClone(document);
  flow = flow == null ? null : structuredClone(flow);
  assets = assets == null ? null : structuredClone(assets);
  links = links == null ? null : structuredClone(links);
  edits = edits.map((e) => ({ ...e }));
  layoutPolicy = layoutPolicy == null ? layoutPolicy : structuredClone(layoutPolicy);
  sourceBytes = sourceBytes instanceof Uint8Array ? new Uint8Array(sourceBytes) : sourceBytes;
  const plannerDocument = structuredClone(document);
  const originalFonts = fonts, glyphLookup = fonts.hasGlyph;
  const snapshots = (fonts.candidates || []).map((c) => {
    const b = c.getBytes?.();
    const bytes2 = b instanceof Uint8Array ? Uint8Array.from(b) : null;
    return { id: c.id, family: c.family, sha256: c.sha256, getBytes: () => bytes2?.slice() ?? null };
  });
  const glyphResults = /* @__PURE__ */ new Map();
  if (typeof glyphLookup === "function") for (const cp of new Set(Array.from((document?.blocks || []).map((b) => b.text || "").join("") + edits.map((e) => e.after || "").join("") + " ", (c) => c.codePointAt(0)))) {
    if (cp === 9 || cp === 10 || cp === 13) continue;
    try {
      const pending = Promise.resolve(glyphLookup.call(originalFonts, cp));
      pending.catch(() => {
      });
      glyphResults.set(cp, pending);
    } catch (error2) {
      const pending = Promise.reject(error2);
      pending.catch(() => {
      });
      glyphResults.set(cp, pending);
    }
  }
  fonts = { ...fonts, candidates: snapshots, selected: fonts.selected ? { ...fonts.selected } : null, fallback: (fonts.fallback || []).map((x) => ({ ...x })), hasGlyph: typeof glyphLookup === "function" ? (cp) => glyphResults.get(cp) : void 0 };
  if (document?.schema !== "falsify.paper-document.v1" || !/^[a-f0-9]{64}$/.test(document.sourceSha256) || !Array.isArray(document.blocks) || !Array.isArray(document.pages) || !document.pages.length) fail("Invalid paper document");
  if (!(sourceBytes instanceof Uint8Array) || await hash(sourceBytes) !== document.sourceSha256) fail("Source hash mismatch or source bytes unavailable");
  abort4(signal);
  if (typeof compile !== "function") fail("Compiler is required");
  const ids = /* @__PURE__ */ new Set();
  for (const block of document.blocks) {
    if (!block.id || ids.has(block.id) || block.text != null && typeof block.text !== "string") fail("Ambiguous block ID or invalid text");
    ids.add(block.id);
  }
  const linkPlan = links ? buildLinkPlan({ document, flow, links, edits }) : null;
  const changes = /* @__PURE__ */ new Map();
  for (const edit of edits) {
    const matches = document.blocks.filter((b2) => b2.id === edit.blockId && b2.source?.pageIndex === edit.pageIndex && b2.source?.range && edit.start >= b2.source.range.start && edit.end <= b2.source.range.end);
    if (matches.length !== 1 || !Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start >= edit.end || typeof edit.before !== "string" || typeof edit.after !== "string") fail("Ambiguous or invalid edit target");
    const b = matches[0], start = edit.start - b.source.range.start, end = edit.end - b.source.range.start;
    if (b.text.slice(start, end) !== edit.before) fail("Edit before text mismatch");
    const list = changes.get(b.id) || [];
    if (list.some((e) => start < e.end && end > e.start)) fail("Overlapping edit targets");
    list.push({ start, end, after: edit.after, inherit: linkPlan?.changes.find((c) => c.blockId === edit.blockId && c.start === edit.start && c.end === edit.end)?.inherit || null });
    changes.set(b.id, list);
  }
  const sourceWrap = findSourceWrapOmissions({ document, bytes: sourceBytes });
  const sourceWrapCandidates = sourceWrap.omissions.filter((o) => {
    const r = o.evidence.sourceRange;
    return !edits.some((e) => e.blockId === o.blockId && e.pageIndex === o.pageIndex && e.start < r.end && e.end > r.start) && !(links?.links || []).some((l) => l.source?.pageIndex === o.pageIndex && l.relation?.ranges?.some((x) => x.blockId === o.blockId && x.start < r.end && x.end > r.start));
  });
  const projectedSpaces = /* @__PURE__ */ new Map(), projectedAmbiguous = [];
  if (flow?.fragments?.length) {
    const parents = new Map(document.blocks.map((b) => [b.id, b])), groups = /* @__PURE__ */ new Map();
    for (const f of flow.fragments) {
      const parent = parents.get(f.parentBlockId), r = f.source?.range, pr = parent?.source?.range;
      if (!parent || !r || !pr || f.id === parent.id || ids.has(f.id) || f.source.pageIndex !== parent.source.pageIndex || r.start < pr.start || r.end > pr.end || r.start >= r.end || f.text !== parent.text.slice(r.start - pr.start, r.end - pr.start)) fail("Invalid flow fragment");
      ids.add(f.id);
      const group = groups.get(parent.id) || [];
      group.push(f);
      groups.set(parent.id, group);
    }
    for (const [id2, group] of groups) {
      const parent = parents.get(id2), pr = parent.source.range;
      group.sort((a, b) => a.source.range.start - b.source.range.start);
      let cursor = pr.start;
      for (const f of group) {
        if (f.source.range.start !== cursor) fail("Flow fragments do not cover parent exactly");
        cursor = f.source.range.end;
      }
      if (cursor !== pr.end) fail("Flow fragments do not cover parent exactly");
      const parentChanges = changes.get(id2) || [], parentSpaces = separators(parent);
      const ambiguous2 = new Set(ambiguousBoundaries(parent, parentChanges));
      for (const f of group) {
        const start = f.source.range.start - pr.start, end = f.source.range.end - pr.start;
        const spaces = new Set([...parentSpaces].filter((i) => i >= start && i < end && !parentChanges.some((e) => e.start < i && i < e.end)).map((i) => i - start));
        projectedSpaces.set(f.id, spaces);
        for (const i of ambiguous2) if (i >= start && i < end) projectedAmbiguous.push({ blockId: f.id, offset: pr.start + i });
      }
      for (const edit of parentChanges) {
        const a = pr.start + edit.start, b = pr.start + edit.end, overlap3 = group.filter((x) => a < x.source.range.end && b > x.source.range.start);
        for (const [i, f] of overlap3.entries()) {
          const r = f.source.range, list = changes.get(f.id) || [];
          list.push({ start: Math.max(a, r.start) - r.start, end: Math.min(b, r.end) - r.start, after: i === 0 ? edit.after : "", inherit: i === 0 ? edit.inherit : null });
          changes.set(f.id, list);
        }
      }
      changes.delete(id2);
    }
    document.blocks = document.blocks.flatMap((b) => groups.get(b.id) || [b]);
    for (const id2 of groups.keys()) ids.delete(id2);
  }
  if (flow) {
    if (flow.schema !== "falsify.paper-flow.v1" || flow.sourceSha256 !== document.sourceSha256 || !Array.isArray(flow.items)) fail("Invalid paper flow");
    const owners = /* @__PURE__ */ new Set();
    for (const item of flow.items) for (const id2 of item.blockIds || []) {
      if (!ids.has(id2) || owners.has(id2)) fail("Unknown or duplicate flow block");
      owners.add(id2);
      if (item.kind === "asset" && changes.has(id2)) fail("Cannot edit text owned by a source asset");
    }
    for (const block of document.blocks) if (block.text && !owners.has(block.id)) fail("Flow omits text block");
  }
  const bodyText = new Map(document.blocks.map((b) => [b.id, b.text || ""]));
  if (layoutMode === "measured-continuous" && flow?.items.some((i) => i.columns === 2 && i.span !== "page" && i.kind === "paragraph" && (i.blockIds || []).reduce((n, id2) => n + (bodyText.get(id2)?.length || 0), 0) >= 150)) {
    const pages = /* @__PURE__ */ new Map();
    for (const item of flow.items) {
      const page2 = item.source?.pageIndex;
      if (!pages.has(page2)) pages.set(page2, []);
      pages.get(page2).push(item);
    }
    for (const group of pages.values()) if (group.length && group.every((i) => Number.isInteger(i.continuousPosition))) {
      const ordered = [...group].sort((a, b) => a.continuousPosition - b.continuousPosition);
      let n = 0;
      flow.items = flow.items.map((i) => group.includes(i) ? ordered[n++] : i);
      for (const item of ordered) if (item.continuousColumns) {
        item.columns = item.continuousColumns;
        item.span = item.continuousColumns === 2 ? "column" : "page";
      }
    }
  }
  for (const item of flow?.items || []) if (item.inline && Array.isArray(item.joiners)) for (let i = 1; i < (item.blockIds || []).length; i++) {
    if (/\s$/u.test(item.joiners[i - 1] || "")) projectedSpaces.get(item.blockIds[i])?.delete(0);
  }
  const spacesFor = (b) => projectedSpaces.get(b.id) || separators(b);
  const assetOwned = new Set((flow?.items || []).filter((item) => item.kind === "asset").flatMap((item) => item.blockIds || []));
  const wrapOmissions = sourceWrapCandidates.filter((o) => document.blocks.some((b) => !assetOwned.has(b.id) && sourceWrapOffsetsForBlock(b, [o]).length));
  const orderedById = new Map(document.blocks.map((b) => [b.id, b]));
  const linked = new Set((flow?.items || []).filter((i) => i.kind === "asset").flatMap((i) => i.captionIds || []));
  const orderedBlocks = flow ? flow.items.flatMap((i) => i.kind === "asset" ? captionOrder(i).map((id2) => orderedById.get(id2)) : (i.blockIds || []).filter((id2) => !linked.has(id2)).map((id2) => orderedById.get(id2))) : document.blocks;
  const sourceGlyphResult = readSourceGlyphs({ bytes: sourceBytes, document: { ...document, blocks: document.blocks.filter((b) => !assetOwned.has(b.id)) }, changes });
  const glyphsByBlock = /* @__PURE__ */ new Map();
  for (const glyph of sourceGlyphResult.glyphs) {
    const list = glyphsByBlock.get(glyph.blockId) || [];
    list.push(glyph);
    glyphsByBlock.set(glyph.blockId, list);
  }
  const wrapOffsetsFor = (b) => new Set(sourceWrapOffsetsForBlock(b, wrapOmissions));
  const omittedFor = (b) => /* @__PURE__ */ new Set([...wrapOffsetsFor(b), ...(glyphsByBlock.get(b.id) || []).flatMap((g) => Array.from({ length: g.end - g.start }, (_, i) => g.start - b.source.range.start + i))]);
  let expectedBlocks = orderedBlocks.filter((b) => typeof b?.text === "string" && b.text.length).map((b) => ({ id: b.id, text: logicalText(b, changes.get(b.id) || [], omittedFor(b), spacesFor(b)) }));
  if (flow) for (const item of flow.items.filter((i) => i.inline)) {
    if (!Array.isArray(item.joiners) || item.joiners.length !== (item.blockIds || []).length - 1 || item.joiners.some((j) => typeof j !== "string")) fail("Invalid inline joiners");
    const indexes = item.blockIds.map((id2) => expectedBlocks.findIndex((b) => b.id === id2));
    if (indexes.some((x, i) => x < 0 || i && x !== indexes[0] + i)) fail("Inline blocks must be consecutive");
    const text = indexes.map((idx, i) => expectedBlocks[idx].text + (item.joiners[i] || "")).join("");
    expectedBlocks.splice(indexes[0], indexes.length, { id: item.blockIds[0], text });
  }
  const artworkBlocks = document.blocks.filter((b) => assetOwned.has(b.id) && b.text).map((b) => ({ id: b.id, text: logicalText(b, [], /* @__PURE__ */ new Set(), spacesFor(b)) }));
  const texts = expectedBlocks.map((b) => b.text);
  const ambiguous = [...projectedAmbiguous, ...document.blocks.filter((b) => !projectedSpaces.has(b.id) && typeof b.text === "string" && b.text.length).flatMap((b) => ambiguousBoundaries(b, changes.get(b.id) || []).map((offset) => ({ blockId: b.id, offset: offset + b.source.range.start })))];
  const coverage = await inspectFonts(texts.join("\n"), fonts);
  abort4(signal);
  const page = document.pages[0];
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) fail("Invalid page size");
  let plan = null;
  if (runningFurniture === true && flow) {
    const build = furniturePlanner || (await Promise.resolve().then(() => (init_paper_furniture(), paper_furniture_exports))).buildFurniturePlan;
    plan = build({ document: { ...plannerDocument, assets: plannerDocument.assets || [] }, flow, editedBlockIds: edits.map((e) => e.blockId) });
    for (const id2 of plan.excludedBlockIds || []) projectedSpaces.get(id2)?.delete(0);
  }
  const suppressedLabels = new Set((linkPlan?.targets || []).filter((t) => t.label && (t.blockId && plan?.excludedBlockIds?.includes(t.blockId) || t.assetItemId && plan?.excludedItemIds?.includes(t.assetItemId))).map((t) => t.label));
  if (linkPlan) for (const label of suppressedLabels) linkPlan.diagnostics.push({ code: "target-furniture-unresolved", label });
  if (linkPlan) for (const id2 of new Set(linkPlan.sourceAssets.map((a) => a.assetItemId))) {
    const candidates2 = linkPlan.sourceAssets.filter((a) => a.assetItemId === id2);
    const destinations = new Set(candidates2.map((a) => JSON.stringify([a.destinationLabel || null, a.destinationLabel ? null : a.uri, a.destinationStatus || null])));
    if (destinations.size > 1) linkPlan.diagnostics.push({ code: "source-asset-link-conflict", assetItemId: id2, linkIds: [...new Set(candidates2.flatMap((a) => a.linkIds))] });
  }
  const margins = plan?.margins || { top: 36, right: 36, bottom: 36, left: 36 };
  const sourceProfile = deriveLayoutProfile(document, flow);
  const layoutProfile = { coordinateSpace: "output", sourceProfile, headings: sourceProfile.headings };
  const policy = layoutPolicy ?? {};
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("Invalid layout policy");
  const bounds = { lineHeightScale: [0.95, 1.05], paragraphSpacingEm: [0.25, 1], columnGutterEm: [0.8, 2] };
  for (const [key, value] of Object.entries(policy)) {
    const limit = bounds[key];
    if (!limit || !Number.isFinite(value) || value < limit[0] || value > limit[1]) fail("Invalid layout policy: " + key);
    if (!sourceProfile.bodyFontSize || key === "lineHeightScale" && !sourceProfile.bodyLineHeight) fail("Layout policy requires source measurements: " + key);
  }
  if (layoutMode != null && layoutMode !== "measured-continuous") fail("Invalid layout mode");
  if (!["float", "page"].includes(figurePlacement)) fail("Invalid figure placement");
  const flowBlockText = new Map(document.blocks.map((b) => [b.id, b.text || ""]));
  const firstBodyIndex = flow?.items.findIndex((i) => i.columns === 2 && i.span !== "page" && i.kind === "paragraph" && (i.blockIds || []).reduce((n, id2) => n + (flowBlockText.get(id2)?.length || 0), 0) >= 150) ?? -1;
  const lastBodyIndex = flow?.items.findLastIndex((i) => i.columns === 2 && i.span !== "page" && i.kind === "paragraph" && (i.blockIds || []).reduce((n, id2) => n + (flowBlockText.get(id2)?.length || 0), 0) >= 150) ?? -1;
  const measuredContinuous = layoutMode === "measured-continuous" && firstBodyIndex >= 0;
  const enginePlan = { requested: layoutMode || "existing", actual: measuredContinuous ? "measured-continuous" : "existing", figurePlacement: measuredContinuous ? figurePlacement : null, reason: layoutMode && !measuredContinuous ? "no explicit two-column body" : null };
  const continuousColumns = measuredContinuous || !!flow?.items.length && flow.items.every((i) => i.columns === 2 && i.span !== "page" && i.kind !== "asset");
  let source = `#set page(width: ${page.width}pt, height: ${page.height}pt, margin: (top: ${margins.top}pt, right: ${margins.right}pt, bottom: ${margins.bottom}pt, left: ${margins.left}pt)${continuousColumns ? ", columns: 2" : ""})
`;
  const candidates = fonts.candidates?.filter((c) => c.getBytes?.()) || [];
  const families = [...new Set([fonts.selected?.family, ...candidates.map((c) => c.family)].filter(Boolean))];
  if (!families.length && fonts.family) families.push(String(fonts.family));
  const bodySize = sourceProfile.bodyFontSize;
  if (families.length || bodySize) source += `#set text(${families.length ? `font: (${families.map(typstString).join(", ")},)` : ""}${families.length && bodySize ? ", " : ""}${bodySize ? `size: ${bodySize}pt` : ""})
`;
  source += `#set par(justify: true${policy.paragraphSpacingEm !== void 0 ? `, spacing: ${policy.paragraphSpacingEm * bodySize}pt` : ""})
#set text(hyphenate: false)
`;
  if (policy.columnGutterEm !== void 0) source += `#set columns(gutter: ${policy.columnGutterEm * bodySize}pt)
`;
  const files = {};
  const assetList = Array.isArray(assets) ? assets : assets?.assets || document.assets || [];
  for (const target of linkPlan?.targets || []) if (target.label && target.assetItemId && !suppressedLabels.has(target.label)) {
    const item = flow?.items.find((i) => i.id === target.assetItemId);
    const id2 = item?.renderAssetId || (item?.assetIds?.length === 1 ? item.assetIds[0] : null);
    const asset = assetList.find((a) => a.id === id2), content = asset?.content, bytes2 = content?.bytes, rep = String(content?.representation || "").toLowerCase();
    const svg = rep.includes("svg") && bytes2 instanceof Uint8Array && /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes2));
    const png = rep.includes("png") && bytes2 instanceof Uint8Array && bytes2.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every((b, i) => bytes2[i] === b) && [73, 69, 78, 68, 174, 66, 96, 130].every((b, i) => bytes2[bytes2.length - 8 + i] === b);
    const same2 = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const captureValid = !item?.renderAssetId || asset && same2(asset.source?.assetIds || [], item.assetIds || []) && same2(asset.source?.blockIds || [], item.blockIds || []) && asset.source?.pageIndex === item.source?.pageIndex && JSON.stringify(asset.source?.bbox) === JSON.stringify(item.source?.bbox);
    const original = (document.assets || []).find((a) => a.id === id2), originalValid = !original?.source || asset?.source && asset.source.pageIndex === original.source.pageIndex && JSON.stringify(asset.source.bbox) === JSON.stringify(original.source.bbox);
    if (!id2 || !(svg || png) || content?.mask || asset?.mask || !captureValid || !originalValid) {
      suppressedLabels.add(target.label);
      linkPlan.diagnostics.push({ code: "target-asset-unavailable", label: target.label, assetItemId: target.assetItemId });
    }
  }
  const blockById = new Map(document.blocks.map((b) => [b.id, b]));
  const styleById = new Map((document.styles || []).map((s) => [s.id, s]));
  const textById = new Map(document.blocks.filter((b) => typeof b.text === "string" && b.text.length && !assetOwned.has(b.id)).map((b) => [b.id, logicalText(b, changes.get(b.id) || [], /* @__PURE__ */ new Set(), spacesFor(b))]));
  function paragraphContext(blocks, kind, rendered) {
    if (!rendered) return "";
    const sizes = [];
    for (const block of blocks) {
      if (!block) continue;
      const chars = block.source?.characters || [];
      if (chars.length) for (const c of chars) {
        const size2 = styleById.get(c.styleId)?.size;
        if (Number.isFinite(size2) && size2 > 0) for (let n = 0; n < Math.min(256, Math.max(1, (c.end || 0) - (c.start || 0))); n++) sizes.push(size2);
      }
      else {
        const size2 = styleById.get(block.styleId)?.size;
        if (Number.isFinite(size2) && size2 > 0) sizes.push(size2);
      }
    }
    sizes.sort((a, b) => a - b);
    const size = sizes[Math.floor(sizes.length / 2)];
    const heading = kind === "heading";
    const settings = [size ? `#set text(size: ${size}pt)` : "", heading ? "#set par(justify: false)\n#set text(hyphenate: false)" : "", kind === "paragraph" && policy.lineHeightScale !== void 0 ? `#set par(leading: ${0.65 * policy.lineHeightScale}em)` : ""].filter(Boolean).join("\n");
    return settings ? `#block[${settings}
${rendered}]` : rendered;
  }
  const furniture = { enabled: runningFurniture === true, templates: [], retained: [] };
  const furnitureIds = /* @__PURE__ */ new Set();
  furniture.plan = plan;
  const placedAssets = /* @__PURE__ */ new Set(), assetFindings = [];
  if (assets?.sourceSha256 && assets.sourceSha256 !== document.sourceSha256) fail("Asset source hash mismatch");
  const suppliedIds = /* @__PURE__ */ new Set();
  for (const a of assetList) {
    if (!a?.id || suppliedIds.has(a.id)) fail("Unknown or duplicate asset occurrence ID");
    suppliedIds.add(a.id);
  }
  const ownedIds = /* @__PURE__ */ new Set();
  for (const item of flow?.items || []) for (const id2 of item.assetIds || []) {
    if (ownedIds.has(id2)) fail("Duplicate flow asset ownership");
    ownedIds.add(id2);
  }
  for (const a of document.assets || []) if (flow && !ownedIds.has(a.id)) assetFindings.push({ code: "asset-unowned", assetId: a.id });
  function spanMarker(id2, sourcePage, edge) {
    return `#context [#let p = here().position();#metadata((id: ${typstString(id2)}, page: p.page, x: p.x / 1pt, y: p.y / 1pt, sourcePage: ${Number.isInteger(sourcePage) ? sourcePage : "none"}, edge: ${typstString(edge)}))#label(${typstString(`paper-${edge === "start" ? "block" : "block-end"}`)})]`;
  }
  function renderBlock(block, mark = true) {
    const text = textById.get(block.id);
    if (!text) return "";
    const marker = mark ? spanMarker(block.id, block.source?.pageIndex, "start") : "";
    const endMarker = mark ? spanMarker(block.id, block.source?.pageIndex, "end") : "";
    const chars = block.source?.characters || [];
    if (!linkPlan && (!chars.length || !styleById.size) && !fonts.fallback?.length && !(glyphsByBlock.get(block.id) || []).length && !text.includes("	") && !(changes.get(block.id) || []).some((e) => e.after.includes("\n"))) return marker + `#text(${typstString(text)})` + endMarker;
    const raw = block.text, spaces = spacesFor(block), wrapOffsets = wrapOffsetsFor(block);
    let logical = "", styles = [], glyphMap = [], destinations = [], offsets = [], before = [], after = [];
    const destinationAt = (offset) => {
      const active = (linkPlan?.sourceRuns || []).filter((r2) => r2.blockId === block.id && r2.start <= offset && offset < r2.end);
      const keys = new Map(active.map((r2) => [JSON.stringify([r2.destinationLabel || null, r2.destinationLabel ? null : r2.uri, r2.destinationStatus || null]), r2]));
      const r = keys.size === 1 ? [...keys.values()][0] : null;
      return r && !r.destinationStatus && !suppressedLabels.has(r.destinationLabel) ? r : null;
    };
    const sourceGlyphs = new Map((glyphsByBlock.get(block.id) || []).map((g) => [g.start - block.source.range.start, g]));
    const styleAt = (i) => chars.find((c) => c.start <= i + block.source.range.start && c.end > i + block.source.range.start)?.styleId || block.styleId;
    for (let i = 0; i <= raw.length; i++) {
      before[i] = logical.length;
      if (spaces.has(i)) {
        logical += " ";
        styles.push(styleAt(Math.max(0, i - 1)));
        glyphMap.push(null);
        destinations.push(null);
        offsets.push(null);
      }
      after[i] = logical.length;
      if (i < raw.length && !wrapOffsets.has(i)) {
        logical += raw[i];
        styles.push(styleAt(i));
        glyphMap.push(sourceGlyphs.get(i) || null);
        destinations.push(destinationAt(block.source.range.start + i));
        offsets.push(block.source.range.start + i);
      }
    }
    let result = "", mapped = [], mappedGlyphs = [], mappedDest = [], mappedOffsets = [], cursor = 0;
    for (const edit of [...changes.get(block.id) || []].sort((a, b) => a.start - b.start)) {
      const a = after[edit.start], b = before[edit.end];
      result += logical.slice(cursor, a) + edit.after;
      for (let i = cursor; i < a; i++) {
        mapped.push(styles[i]);
        mappedGlyphs.push(glyphMap[i]);
        mappedDest.push(destinations[i]);
        mappedOffsets.push(offsets[i]);
      }
      const editStyle = styleAt(edit.start);
      for (let i = 0; i < edit.after.length; i++) {
        mapped.push(editStyle);
        mappedGlyphs.push(null);
        mappedDest.push(suppressedLabels.has(edit.inherit?.destinationLabel) ? null : edit.inherit);
        mappedOffsets.push(null);
      }
      cursor = b;
    }
    result += logical.slice(cursor);
    for (let i = cursor; i < styles.length; i++) {
      mapped.push(styles[i]);
      mappedGlyphs.push(glyphMap[i]);
      mappedDest.push(destinations[i]);
      mappedOffsets.push(offsets[i]);
    }
    const familyAt = (i) => fonts.fallback?.find((entry) => entry.codepoint === result.codePointAt(i) && entry.kind === "glyph")?.family || null;
    const labels = /* @__PURE__ */ new Map();
    if (mark) {
      for (const target of linkPlan?.targets || []) if (target.label && !suppressedLabels.has(target.label) && target.blockId === block.id) {
        const at = mappedOffsets.indexOf(target.start);
        if (at >= 0) {
          const list = labels.get(at) || [];
          list.push(target.label);
          labels.set(at, list);
        }
      }
    }
    const key = (d) => d?.destinationLabel ? `label:${d.destinationLabel}` : d?.uri ? `uri:${d.uri}` : "";
    const wrap = (content, d) => d?.destinationLabel ? `#link(label(${typstString(d.destinationLabel)}))[${content}]` : d?.uri ? `#link(${typstString(d.uri)})[${content}]` : content;
    const emitLabels = (i) => (labels.get(i) || []).map((l) => `#box[]#label(${typstString(l)})`).join("");
    const runs = [];
    for (let i = 0; i < result.length; ) {
      let j = i + (result.codePointAt(i) > 65535 ? 2 : 1);
      const family = familyAt(i), glyph = mappedGlyphs[i];
      const editLineBreak = result[i] === "\n" && mappedOffsets[i] === null, tab = result[i] === "	";
      while (!glyph && !editLineBreak && !tab && j < result.length && result[j] !== "	" && !(result[j] === "\n" && mappedOffsets[j] === null) && !labels.has(j) && !mappedGlyphs[j] && mapped[j] === mapped[i] && familyAt(j) === family && key(mappedDest[j]) === key(mappedDest[i])) j += result.codePointAt(j) > 65535 ? 2 : 1;
      let content;
      if (glyph) {
        const path = `source-glyphs/${glyph.pageIndex}-${glyph.start}.svg`;
        files[path] = new Uint8Array(glyph.bytes);
        content = `#box(width: ${glyph.advance}pt, height: ${glyph.height}pt, baseline: ${glyph.baselineShift}pt)[#move(dx: ${glyph.offsetX}pt)[#image(${typstString(path)}, width: ${glyph.width}pt)]]`;
      } else {
        const style = styleById.get(mapped[i]), size = style?.size;
        let opts = Number.isFinite(size) && size > 0 ? `size: ${size}pt, ` : "";
        if (family) opts += `font: ${typstString(family)}, `;
        const name = style?.fontName || "";
        if (/bold/i.test(name)) opts += 'weight: "bold", ';
        if (/italic|oblique/i.test(name)) opts += 'style: "italic", ';
        content = editLineBreak ? `#text(${opts}${typstString(" ")})#linebreak()` : `#text(${opts}${typstString(tab ? " " : result.slice(i, j))})`;
      }
      runs.push(emitLabels(i) + wrap(content, mappedDest[i]));
      i = j;
    }
    return marker + runs.join("") + endMarker;
  }
  function renderAsset(id2, item, mark = true, fit = null) {
    const asset = assetList.find((a) => a.id === id2);
    const original = (document.assets || []).find((a) => a.id === id2);
    if (original?.source && (!asset?.source || asset.source.pageIndex !== original.source.pageIndex || JSON.stringify(asset.source.bbox) !== JSON.stringify(original.source.bbox))) {
      assetFindings.push({ code: "asset-source-mismatch", assetId: id2 });
      return "";
    }
    const content = asset?.content;
    const bytes2 = content?.bytes;
    const rep = String(content?.representation || "").toLowerCase();
    const ext = rep.includes("svg") ? "svg" : rep.includes("png") ? "png" : null;
    const validPng = ext === "png" && bytes2 instanceof Uint8Array && bytes2.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every((b, i) => bytes2[i] === b) && [73, 69, 78, 68, 174, 66, 96, 130].every((b, i) => bytes2[bytes2.length - 8 + i] === b);
    const validSvg = ext === "svg" && bytes2 instanceof Uint8Array && /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes2));
    if (!validPng && !validSvg) {
      assetFindings.push({ code: asset ? "asset-invalid-format" : "asset-missing", assetId: id2 });
      return "";
    }
    if (content?.mask || asset?.mask) {
      assetFindings.push({ code: "asset-mask-unsupported", assetId: id2 });
      return "";
    }
    const path = `assets/${placedAssets.size}.${ext}`;
    files[path] = new Uint8Array(bytes2);
    placedAssets.add(id2);
    const bbox = asset.source?.bbox || item?.source?.bbox;
    const sourceWidth = Array.isArray(bbox) ? bbox[2] - bbox[0] : null;
    const sourceHeight = Array.isArray(bbox) ? bbox[3] - bbox[1] : null;
    const available = (page.width - margins.left - margins.right) / (item?.span === "page" || item?.columns !== 2 ? 1 : 2);
    const maxHeight = Math.max(1, page.height - margins.top - margins.bottom - ((item?.captionIds || []).length ? 20 : 0));
    const heightLimited = Number.isFinite(sourceHeight) && sourceHeight > 0 && Number.isFinite(sourceWidth) && sourceWidth > 0 ? maxHeight * sourceWidth / sourceHeight : Infinity;
    const width = Number.isFinite(sourceWidth) && sourceWidth > 0 ? fit && Number.isFinite(sourceHeight) && sourceHeight > 0 ? "paper-fit-width" : `${Math.min(sourceWidth, available, heightLimited)}pt` : "100%";
    const sourcePage = asset.source?.pageIndex ?? item?.source?.pageIndex;
    const marker = mark ? spanMarker(id2, sourcePage, "start") : "", endMarker = mark ? spanMarker(id2, sourcePage, "end") : "";
    const labels = mark ? (linkPlan?.targets || []).filter((t) => t.label && !suppressedLabels.has(t.label) && t.assetItemId === item?.id).map((t) => `#box[]#label(${typstString(t.label)})`).join("") : "";
    const candidates2 = (linkPlan?.sourceAssets || []).filter((a) => a.assetItemId === item?.id);
    const unique = new Map(candidates2.map((a) => [JSON.stringify([a.destinationLabel || null, a.destinationLabel ? null : a.uri, a.destinationStatus || null]), a]));
    const only = unique.size === 1 ? [...unique.values()][0] : null;
    const dest = only && !only.destinationStatus && !suppressedLabels.has(only.destinationLabel) ? only : null;
    const image = `#image(${typstString(path)}, width: ${width})`;
    const linked2 = dest?.destinationLabel ? `#link(label(${typstString(dest.destinationLabel)}))[${image}]` : dest?.uri ? `#link(${typstString(dest.uri)})[${image}]` : image;
    if (Number.isFinite(sourceWidth) && sourceWidth > 0 && Number.isFinite(sourceHeight) && sourceHeight > 0) {
      const w = Math.min(sourceWidth, available, heightLimited), h = w * sourceHeight / sourceWidth;
      if (fit) Object.assign(fit, { width: w, height: h, ratio: sourceWidth / sourceHeight });
      const frameWidth = fit ? width : `${w}pt`, frameHeight = fit ? `(${width} * ${sourceHeight / sourceWidth})` : `${h}pt`;
      return `#box(width: ${frameWidth}, height: ${frameHeight}, baseline: ${frameHeight})[#place(top + left)[${linked2}]#place(top + left)[#box(width: 0pt, height: 0pt)[${marker}${labels}]]#place(bottom + left)[#box(width: 0pt, height: 0pt)[${endMarker}]]]`;
    }
    return `#box[${marker}${labels}${linked2}${endMarker}]`;
  }
  if (plan) {
    const excludedItems = new Set(plan.excludedItemIds), excludedBlocks = new Set(plan.excludedBlockIds);
    const rendered = /* @__PURE__ */ new Map();
    for (const pg of plan.pages) for (const kind of ["header", "footer"]) for (const entry of pg[kind]) {
      let content = "";
      if (entry.kind === "asset") {
        const item = flow.items.find((i) => i.id === entry.itemId);
        const id2 = entry.renderAssetId || (entry.assetIds?.length === 1 ? entry.assetIds[0] : null);
        if (id2 && item) {
          const capture = assetList.find((a) => a.id === id2);
          const same2 = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
          const validCapture = !item.renderAssetId || capture && same2(capture.source?.assetIds || [], item.assetIds || []) && same2(capture.source?.blockIds || [], item.blockIds || []) && capture.source?.pageIndex === item.source?.pageIndex && JSON.stringify(capture.source?.bbox) === JSON.stringify(item.source?.bbox);
          if (validCapture) content = renderAsset(id2, { ...item, span: "page", columns: 1 }, false);
          else assetFindings.push({ code: "asset-capture-mismatch", assetId: id2 });
        }
        if (!content) {
          excludedItems.delete(entry.itemId);
          for (const id3 of entry.blockIds || []) excludedBlocks.delete(id3);
          continue;
        }
        for (const id3 of entry.assetIds || []) placedAssets.add(id3);
      } else {
        const block = blockById.get(entry.blockId);
        if (!block) {
          excludedItems.delete(entry.itemId);
          excludedBlocks.delete(entry.blockId);
          continue;
        }
        if (entry.kind === "counter") {
          const style = styleById.get(block.source?.characters?.[0]?.styleId || block.styleId), size = style?.size, name = style?.fontName || "";
          let opts = Number.isFinite(size) && size > 0 ? `size: ${size}pt, ` : "";
          if (/bold/i.test(name)) opts += 'weight: "bold", ';
          if (/italic|oblique/i.test(name)) opts += 'style: "italic", ';
          content = `#text(${opts}counter(page).display("1 / 1", both: true))`;
        } else content = renderBlock(block, false);
      }
      rendered.set(entry, content);
      furniture.templates.push({ kind, sourcePage: pg.sourcePage, text: entry.kind === "text" ? textById.get(entry.blockId) : entry.text, originalText: entry.text, bbox: entry.bbox, occurrences: [{ itemId: entry.itemId, blockId: entry.blockId, source: entry.source }], entryKind: entry.kind });
    }
    for (const id2 of excludedBlocks) furnitureIds.add(id2);
    expectedBlocks = expectedBlocks.filter((b) => !furnitureIds.has(b.id));
    source += `#let paper-source-page() = { let p = here().page(); let starts = query(<paper-block>).filter(m => m.value.sourcePage != none); let ends = query(<paper-block-end>); let covering = starts.filter(s => { let e = ends.find(x => x.value.id == s.value.id); e != none and s.value.page <= p and e.value.page >= p }); if covering.len() > 0 { covering.first().value.sourcePage } else { none } }
`;
    for (const kind of ["header", "footer"]) {
      const cases = plan.pages.filter((pg) => pg[kind].some((e) => rendered.has(e))).map((pg) => {
        const rows = [];
        for (const entry of pg[kind].filter((e) => rendered.has(e)).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
          const row = rows.find((r) => Math.min(r.bottom, entry.bbox[3]) - Math.max(r.top, entry.bbox[1]) > 0);
          if (row) {
            row.entries.push(entry);
            row.top = Math.min(row.top, entry.bbox[1]);
            row.bottom = Math.max(row.bottom, entry.bbox[3]);
          } else rows.push({ top: entry.bbox[1], bottom: entry.bbox[3], entries: [entry] });
        }
        const parts = rows.map((row, ri) => {
          const entries = row.entries.sort((a, b) => a.bbox[0] - b.bbox[0]);
          const defs = entries.map((entry, i) => {
            const content = rendered.get(entry), x = entry.bbox[0];
            const bandTop = kind === "header" ? 0 : page.height - margins.bottom;
            const bandBottom = kind === "header" ? margins.top : page.height;
            const limit = Math.min(bandBottom, rows[ri + 1]?.top ?? bandBottom);
            return `let c${i} = box[${content}]; let size${i} = measure(c${i}); let w${i} = size${i}.width; let fits${i} = ${entry.bbox[1]}pt >= ${bandTop}pt and ${entry.bbox[1]}pt + size${i}.height <= ${limit}pt; let x${i} = ${i ? `calc.max(${x}pt, x${i - 1} + w${i - 1} + 3pt)` : `calc.max(0pt, ${x}pt)`};`;
          }).join(" ");
          const last = entries.length - 1;
          const placements = entries.map((entry, i) => {
            const y = entry.bbox[1], dy = kind === "header" ? y : y - (page.height - margins.bottom);
            const id2 = entry.blockId || entry.itemId;
            return `place(top + left, dx: (if fits { x${i} - shift } else { ${entry.bbox[0]}pt }) - ${margins.left}pt, dy: ${dy}pt)[#context [#let p = here().position();#box(width: 0pt, height: 0pt)[#metadata((id: ${typstString(id2)}, sourcePage: ${pg.sourcePage}, page: p.page, x: p.x / 1pt, y: p.y / 1pt, kind: ${typstString(kind)}))#label("paper-furniture")]]#c${i}];`;
          }).join(" ");
          return `#context { ${defs} let shift = calc.max(0pt, x${last} + w${last} - ${page.width}pt); let fits = x0 - shift >= 0pt and ${entries.map((_, i) => `fits${i}`).join(" and ")}; box(width: 0pt, height: 0pt)[#metadata((sourcePage: ${pg.sourcePage}, kind: ${typstString(kind)}, row: ${ri}, status: if fits { "measured" } else { "source-position-fallback" }))#label("paper-furniture-layout")]; ${placements} }`;
        });
        return `if sp == ${pg.sourcePage} [${parts.join("")}]`;
      });
      if (cases.length) source += `#set page(${kind}-ascent: 0pt, ${kind}: context { let sp = paper-source-page(); box(height: ${kind === "header" ? margins.top : margins.bottom}pt)[#${cases.join(" else ")}] })
`.replace("footer-ascent", "footer-descent");
    }
    plan.excludedItemIds = [...excludedItems];
  }
  if (flow) {
    if (flow.schema !== "falsify.paper-flow.v1" || flow.sourceSha256 !== document.sourceSha256 || !Array.isArray(flow.items)) fail("Invalid paper flow");
    let group = [], columns = 0, bodyStarted = false;
    const fullWidth = page.width - margins.left - margins.right, fullHeight = page.height - margins.top - margins.bottom;
    const measured = (content) => `#context { let group = [${content}]; if measure(block(width: ${fullWidth}pt, group)).height > ${Math.max(1, fullHeight - 20)}pt { page(columns: 1, group) } else { place(top, float: true, scope: "parent", block(width: 100%, group)) } }`;
    const flush = () => {
      if (!group.length) return;
      const content = group.join("\n\n");
      if (measuredContinuous && columns === 1) source += bodyStarted ? `#page(columns: 1)[${content}]
` : measured(content) + "\n";
      else source += columns === 2 && !continuousColumns ? `#columns(2)[
${content}
]
` : content + "\n";
      if (columns === 2) bodyStarted = true;
      group = [];
    };
    const captionById = new Map(flow.items.filter((i) => i.kind === "caption").flatMap((i) => (i.blockIds || []).map((id2) => [id2, i]))), linkedCaptions = /* @__PURE__ */ new Set();
    for (const item of flow.items) if (item.kind === "asset") for (const id2 of item.captionIds || []) {
      if (!captionById.has(id2) || linkedCaptions.has(id2)) fail("Unknown or duplicate caption link");
      linkedCaptions.add(id2);
    }
    const keepBeforeAsset = /* @__PURE__ */ new Map(), deferredItems = /* @__PURE__ */ new Set();
    if (measuredContinuous && figurePlacement === "page") for (const [assetIndex, asset] of flow.items.entries()) {
      if (assetIndex < firstBodyIndex || asset.kind !== "asset" || asset.span !== "page" || !asset.captionIds?.length) continue;
      const significant = flow.items.slice(0, assetIndex).filter((i) => !plan?.excludedItemIds.includes(i.id));
      const caption = significant.at(-1), item = significant.at(-2);
      if (!caption || caption.kind !== "caption" || !item || item.kind !== "paragraph" || item.span === "page" || item.columns !== 2) continue;
      const ids2 = caption.blockIds || [];
      if (!ids2.length || ids2.some((id2) => !asset.captionIds.includes(id2) || asset.captionPositions?.[id2] !== "above") || asset.captionIds.length !== ids2.length) continue;
      const src = item.source, cs = caption.source, as = asset.source, box5 = src?.bbox, cb = cs?.bbox, sourcePage = document.pages[src?.pageIndex];
      if (!sourcePage || src.pageIndex !== cs?.pageIndex || as?.pageIndex !== src.pageIndex + 1 || !Array.isArray(box5) || !Array.isArray(cb) || box5.length !== 4 || cb.length !== 4 || !box5.every(Number.isFinite) || !cb.every(Number.isFinite) || box5[1] < sourcePage.height * 0.5 || box5[3] > cb[1] || cb[1] - box5[3] > sourcePage.height * 0.08) continue;
      const blocks = (item.blockIds || []).map((id2) => blockById.get(id2));
      if (!blocks.length || blocks.some((b) => !b || b.source?.pageIndex !== src.pageIndex || !b.source?.range || b.source.range.end - b.source.range.start !== b.text?.length || !b.source.lines?.length)) continue;
      const lines = blocks.reduce((n, b) => n + b.source.lines.length, 0);
      const current = blocks.reduce((n, b) => n + logicalText(b, changes.get(b.id) || [], omittedFor(b), spacesFor(b)).length, 0) + (item.joiners || []).reduce((n, j) => n + j.length, 0);
      if (lines > 3 || current > 240) continue;
      keepBeforeAsset.set(asset, item);
      deferredItems.add(item);
    }
    const renderFlowItem = (item) => {
      const blocks = (item.blockIds || []).map((id2) => blockById.get(id2));
      const parts = blocks.map((b) => renderBlock(b));
      const rendered = item.inline ? parts.map((p, i) => p + (i < parts.length - 1 ? `#text(${typstString(item.joiners[i])})` : "")).join("") : parts.filter(Boolean).join("\n");
      return paragraphContext(blocks, item.kind, rendered);
    };
    const renderCaption = renderFlowItem;
    for (const [itemIndex, item] of flow.items.entries()) {
      if (plan?.excludedItemIds.includes(item.id) || deferredItems.has(item)) continue;
      if (item.kind === "caption" && (item.blockIds || []).every((id2) => linkedCaptions.has(id2))) continue;
      const box5 = item.source?.bbox, noteBlocks = (item.blockIds || []).map((id2) => blockById.get(id2));
      const noteSizes = noteBlocks.flatMap((b) => (b?.source?.characters || []).map((c) => styleById.get(c.styleId)?.size));
      const titlePageNote = measuredContinuous && itemIndex >= firstBodyIndex && item.kind === "paragraph" && item.span === "page" && item.source?.pageIndex === 0 && Array.isArray(box5) && box5.length === 4 && box5.every(Number.isFinite) && box5[0] >= 0 && box5[2] <= page.width && box5[2] > box5[0] && box5[1] >= page.height * 0.8 && box5[3] <= page.height && box5[3] > box5[1] && box5[3] - box5[1] <= page.height * 0.08 && noteSizes.length > 0 && Number.isFinite(bodySize) && noteSizes.every((size) => Number.isFinite(size) && size > 0 && size <= bodySize * 0.95);
      const count = measuredContinuous && itemIndex < firstBodyIndex ? 1 : titlePageNote || measuredContinuous && item.measuredColumns === 2 ? 2 : item.span === "page" ? 1 : item.columns === 2 ? 2 : 1;
      if (count !== columns) {
        flush();
        columns = count;
      }
      let parts = [], fit = null;
      if (item.kind === "asset") {
        if (measuredContinuous && itemIndex >= firstBodyIndex && item.span === "page" && item.captionIds?.length) fit = {};
        if (item.renderAssetId) {
          const capture = assetList.find((a) => a.id === item.renderAssetId), owned = capture?.source?.assetIds || [], blocks = capture?.source?.blockIds || [];
          const same2 = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
          if (!capture || !same2(owned, item.assetIds || []) || !same2(blocks, item.blockIds || []) || capture.source.pageIndex !== item.source?.pageIndex || JSON.stringify(capture.source.bbox) !== JSON.stringify(item.source?.bbox)) assetFindings.push({ code: "asset-capture-mismatch", assetId: item.renderAssetId });
          else {
            parts = [renderAsset(item.renderAssetId, item, true, fit)].filter(Boolean);
            if (parts.length) for (const id2 of item.assetIds || []) placedAssets.add(id2);
          }
        } else if ((item.assetIds || []).length > 1) assetFindings.push({ code: "asset-union-required", assetIds: [...item.assetIds] });
        else parts = (item.assetIds || []).map((id2) => renderAsset(id2, item, true, fit)).filter(Boolean);
        const captionItems = [...new Set(captionOrder(item).map((id2) => captionById.get(id2)))];
        for (const caption of captionItems) {
          const ids2 = caption.blockIds || [], position = (id2) => item.captionPositions?.[id2] === "above" ? "above" : "below";
          if (ids2.some((id2) => !(item.captionIds || []).includes(id2) || position(id2) !== position(ids2[0]))) fail("Incomplete or inconsistent caption link");
        }
        const above = captionItems.filter((c) => item.captionPositions?.[c.blockIds[0]] === "above").map(renderCaption).filter(Boolean);
        const below = captionItems.filter((c) => item.captionPositions?.[c.blockIds[0]] !== "above").map(renderCaption).filter(Boolean);
        if (parts.length && below.length) parts = [`#block(sticky: true)[${parts.join("\n")}]`];
        const kept = keepBeforeAsset.get(item);
        const aboveParts = [...kept ? [renderFlowItem(kept)] : [], ...above.map((caption) => `#block(sticky: true)[${caption}]`)];
        if (fit?.width && parts.length === 1) {
          const emptyFrame = `#box(width: ${fit.width}pt, height: 0pt)[]`;
          const probe = [...aboveParts, below.length ? `#block(sticky: true)[${emptyFrame}]` : emptyFrame, ...below].join("\n\n");
          const content = [...aboveParts, ...parts, ...below].join("\n\n");
          const budget = Math.max(1, fullHeight - 20);
          parts = [`#context { let overhead = measure(block(width: ${fullWidth}pt, [${probe}])).height; let remaining = ${budget}pt - overhead; let paper-fit-width = if remaining >= ${fit.height / 2}pt { calc.min(${fit.width}pt, remaining * ${fit.ratio}) } else { ${fit.width}pt }; [${content}] }`];
        } else parts = [...aboveParts, ...parts, ...below];
      } else {
        parts = (item.blockIds || []).filter((id2) => !linkedCaptions.has(id2)).map((id2) => blockById.get(id2)).filter(Boolean).map((b) => renderBlock(b));
        if (!item.inline) parts = parts.filter(Boolean);
      }
      if (parts.length) {
        const rendered = item.inline ? parts.map((p, i) => p + (i < parts.length - 1 ? `#text(${typstString(item.joiners[i])})` : "")).join("") : parts.join(item.kind === "asset" ? "\n\n" : "\n");
        const scoped = item.kind === "asset" ? rendered : paragraphContext((item.blockIds || []).map((id2) => blockById.get(id2)), item.kind, rendered);
        const result = item.kind === "heading" ? `#block(sticky: true)[${scoped}]` : scoped;
        if (measuredContinuous && itemIndex >= firstBodyIndex && item.kind === "asset" && item.span === "page") {
          flush();
          source += (figurePlacement === "float" && item.captionIds?.length && itemIndex <= lastBodyIndex ? measured(result) : `#page(columns: 1)[${result}]`) + "\n";
        } else group.push(result);
      }
    }
    flush();
  } else {
    source += `#columns(2)[
${document.blocks.map((b) => paragraphContext([b], b.kind || "paragraph", renderBlock(b))).filter(Boolean).join("\n\n")}
]`;
  }
  const compiled = await compile({ source, fonts, files, signal });
  abort4(signal);
  const returnedBytes = compiled instanceof Uint8Array ? compiled : compiled?.bytes;
  const bytes = returnedBytes instanceof Uint8Array ? new Uint8Array(returnedBytes) : returnedBytes;
  if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") fail("Compiler did not return PDF bytes");
  const sha2562 = await hash(bytes);
  abort4(signal);
  const warnings = ["Content, layout and asset preservation have not been independently verified."];
  if (sourceGlyphResult.glyphs.length) warnings.push("Source glyph artwork has unknown Unicode and is excluded from searchable-text expectations.");
  if (sourceGlyphResult.unavailable.length) warnings.push("Source glyph artwork unavailable for " + sourceGlyphResult.unavailable.length + " character(s).");
  if (compiled?.queryError) warnings.push(`Output location query failed: ${compiled.queryError}`);
  if (compiled?.furnitureLayout?.some((x) => x.status === "source-position-fallback")) warnings.push("\uC77C\uBD80 \uBA38\uB9AC\uB9D0\xB7\uAF2C\uB9AC\uB9D0\uC740 \uC5EC\uC720 \uACF5\uAC04\uC774 \uBD80\uC871\uD574 \uC6D0\uB798 \uC704\uCE58\uB97C \uC720\uC9C0\uD588\uC2B5\uB2C8\uB2E4.");
  if (document.assets?.some((a) => !placedAssets.has(a.id)) || document.blocks.some((b) => (b.assetIds?.length || b.kind === "figure" || b.kind === "table" || b.kind === "formula") && !(b.assetIds?.length && b.assetIds.every((id2) => placedAssets.has(id2))))) warnings.push("Source assets and non-text figure, table or formula content are not placed by this candidate, including image blocks without source ranges.");
  if (assetFindings.length) warnings.push("Source asset findings: " + assetFindings.map((f) => `${f.code} (${f.assetId || f.assetIds.join(", ")})`).join("; "));
  if (coverage.status !== "covered") warnings.push(`Font coverage ${coverage.status}; output may lose glyphs.`);
  let outputTextCheck = "unavailable", checkReport = null;
  if (typeof outputCheck === "function") {
    try {
      checkReport = await outputCheck({ bytes: new Uint8Array(bytes), document: structuredClone(document), flow: structuredClone(flow), fontPlan: fonts, assetSpans: structuredClone(compiled?.blockSpans ?? null), expectedBlocks: expectedBlocks.map((b) => ({ ...b })), expectedFurniture: structuredClone(furniture.templates), outputFurniture: structuredClone(compiled?.furnitureMap ?? null), blockSpans: structuredClone(compiled?.blockSpans ?? null), bodyFrame: { left: margins.left, top: margins.top, right: page.width - margins.right, bottom: page.height - margins.bottom }, layoutProfile: structuredClone(layoutProfile) });
      abort4(signal);
      outputTextCheck = checkReport?.findings?.some((f) => f.code === "content-mismatch") ? "finding" : checkReport?.checks?.content?.status || "unavailable";
    } catch (error2) {
      abort4(signal);
      warnings.push(`Output text check unavailable: ${error2.message}`);
    }
  }
  const flowCheck = measuredContinuous ? checkReport?.checks?.flow?.status === "checked" ? structuredClone(checkReport.checks.flow) : ["pass", "normalized"].includes(outputTextCheck) ? { status: "checked", comparison: "Ordered content without caption relocation." } : checkReport?.checks?.flow?.status === "finding" ? structuredClone(checkReport.checks.flow) : { status: "unavailable", reason: "Output caption ownership or ordered content is unavailable." } : { status: "not-requested" };
  if (ambiguous.length) {
    warnings.push("Ambiguous source line boundaries use a spacing convention; content verification is unavailable.");
  }
  if (outputTextCheck === "finding") warnings.push("Output text check found content loss or mismatch.");
  const verification = { flowCheck, status: outputTextCheck === "finding" || assetFindings.length || flowCheck.status === "finding" ? "finding" : "warning", sourceSha256: document.sourceSha256, contentVerified: flowCheck.status !== "finding" && outputTextCheck === "pass" && !furniture.templates.length && !ambiguous.length && !assetOwned.size && !assetFindings.length && !sourceGlyphResult.glyphs.length && !sourceGlyphResult.unavailable.length, sourceGlyphs: sourceGlyphResult, layoutVerified: false, coverage, outputTextCheck, checkReport, artworkBlocks, assetFindings, ambiguousBoundaries: ambiguous, furniture: { ...furniture, margins: { ...margins }, output: compiled?.furnitureMap ?? null }, edits: edits.map((e) => ({ blockId: e.blockId, start: e.start, end: e.end, status: "bound" })) };
  verification.sourceNormalization = { sourceSha256: sourceWrap.sourceSha256, lineWrapHyphens: wrapOmissions.map((o) => ({ pageIndex: o.pageIndex, start: o.start, end: o.end, corroboration: o.evidence.corroboration })) };
  verification.furniture.spacing = Array.isArray(compiled?.furnitureLayout) ? compiled.furnitureLayout : null;
  return { linkPlan, layoutProfile, enginePlan, layoutPolicy: { ...policy }, file: new File([bytes], "recomposed.pdf", { type: "application/pdf" }), sha256: sha2562, verification, pageMap: null, blockMap: compiled?.blockMap ?? null, blockSpans: compiled?.blockSpans ?? null, furnitureMap: compiled?.furnitureMap ?? null, warnings };
}

// app/src/paper-layout-quality.mjs
var valid = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
var area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
var intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
var contains2 = (a, b) => a[0] <= b[0] + 1 && a[1] <= b[1] + 1 && a[2] >= b[2] - 1 && a[3] >= b[3] - 1;
var union2 = (boxes) => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
var norm = (s) => s.replace(/\s+/gu, " ").trim();
var fontIdentity = (name) => String(name).replace(/^[A-Z]{6}\+/u, "");
function inspectLayoutQuality({ bytes, mupdf: mupdf6, profile = {}, sourceBytes, sourcePageIndexes } = {}) {
  const issues = [], pages = [], captionObservations = [], limitations = [
    "Text paint bounds are glyph ink extents; structured text character boxes are font metrics.",
    "Only axis-aligned rectangular clip paths are checked; arbitrary clips, transparency, occlusion, rotated text, vector figure ownership, and reading order remain unverified.",
    "Scores measure detected defects only; they are not proof of visual quality."
  ], profileCoverage = { coordinateSpace: profile.coordinateSpace || "unspecified", bodyLines: { checked: 0, skipped: 0 }, fontNames: { checked: 0, skipped: 0 }, captions: { checked: 0, skipped: 0 }, columns: { checked: 0, skipped: 0 }, headings: { checked: 0, skipped: 0 } };
  const add = (type, pageIndex, bbox, penalty, evidence) => issues.push({ type, pageIndex, bbox: bbox.map((x) => Math.round(x * 100) / 100), penalty, evidence });
  if (!mupdf6?.Document || !mupdf6?.Device) return { schema: "falsify.layout-quality.v1", status: "unavailable", score: null, penaltyTerms: {}, issues, limitations: [...limitations, "MuPDF unavailable."] };
  let doc;
  try {
    doc = mupdf6.Document.openDocument(bytes, "application/pdf");
    if (doc.countPages() > 500) throw Error("page limit exceeded");
    for (let p = 0; p < doc.countPages(); p++) {
      const page = doc.loadPage(p);
      let st, dev;
      try {
        const bounds = [...page.getBounds()], runs = [], images = [], lines = [], vectors = [], clips = [];
        let unsupportedClips = 0;
        if (!valid(bounds) || bounds[0] !== 0 || bounds[1] !== 0) throw Error("unsupported page bounds");
        st = page.toStructuredText("preserve-whitespace,preserve-images");
        let line = null;
        st.walk({
          beginLine(_box, wmode, direction) {
            line = { text: "", chars: [], horizontal: wmode === 0 && direction[0] > 0 && Math.abs(direction[1]) < 0.01 };
          },
          onChar(c, _origin, font, size, quad) {
            if (!line) return;
            const b = [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]), Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
            line.text += c;
            if (valid(b) && c.trim()) line.chars.push({ bbox: b, size, font: font.getName() });
          },
          endLine() {
            if (line?.chars.length) lines.push({ ...line, bbox: union2(line.chars.map((c) => c.bbox)) });
            line = null;
          },
          onImageBlock(bbox, _transform, image) {
            try {
              if (valid(bbox)) images.push([...bbox]);
            } finally {
              image.destroy();
            }
          }
        });
        const collect = (text, ctm, resources, alpha) => {
          try {
            if (alpha > 0) {
              const b = [...text.getBounds(null, ctm)];
              if (valid(b)) {
                runs.push(b);
                const active = clips.filter(Boolean);
                if (active.length && !clips.includes(null)) {
                  const clip = active.reduce(intersection);
                  if (!contains2(clip, b) && area(intersection(clip, b)) < area(b) - 1) add("text-clipped", p, b, 10, { clipBounds: clip, source: "text-paint-and-rectangular-clip" });
                }
              }
            }
          } finally {
            text.destroy();
            resources.forEach((r) => r?.destroy());
          }
        };
        const path = (obj, stroke, ctm, cs, alpha) => {
          try {
            if (alpha > 0) {
              const b = [...obj.getBounds(stroke, ctm)];
              if (valid(b)) vectors.push(b);
            }
          } finally {
            obj.destroy();
            stroke?.destroy();
            cs?.destroy();
          }
        };
        dev = new mupdf6.Device({ clipPath(o, _eo, c) {
          try {
            const points = [];
            let closed = false, complex = false;
            o.walk({ moveTo(x, y) {
              points.push([x, y]);
            }, lineTo(x, y) {
              points.push([x, y]);
            }, curveTo() {
              complex = true;
            }, closePath() {
              closed = true;
            } });
            const axis = Math.abs(c[1]) < 1e-8 && Math.abs(c[2]) < 1e-8;
            const xs = [...new Set(points.map((q) => q[0]))], ys = [...new Set(points.map((q) => q[1]))];
            const rectangle = !complex && closed && points.length === 4 && xs.length === 2 && ys.length === 2 && points.every((q, i) => {
              const n = points[(i + 1) % 4];
              return q[0] === n[0] !== (q[1] === n[1]);
            });
            const b = [...o.getBounds(null, c)];
            if (axis && rectangle && valid(b)) clips.push(b);
            else {
              clips.push(null);
              unsupportedClips++;
            }
          } finally {
            o.destroy();
          }
        }, clipText(t) {
          t.destroy();
          clips.push(null);
          unsupportedClips++;
        }, clipStrokeText(t, stroke) {
          t.destroy();
          stroke.destroy();
          clips.push(null);
          unsupportedClips++;
        }, clipStrokePath(o, stroke) {
          o.destroy();
          stroke.destroy();
          clips.push(null);
          unsupportedClips++;
        }, clipImageMask(image) {
          image.destroy();
          clips.push(null);
          unsupportedClips++;
        }, popClip() {
          clips.pop();
        }, fillText(t, c, cs, _color, a) {
          collect(t, c, [cs], a);
        }, strokeText(t, s, c, cs, _color, a) {
          collect(t, c, [s, cs], a);
        }, fillPath(o, _eo, c, cs, _color, a) {
          path(o, null, c, cs, a);
        }, strokePath(o, s, c, cs, _color, a) {
          path(o, s, c, cs, a);
        } });
        page.run(dev, mupdf6.Matrix.identity);
        dev.close();
        if (runs.length > 2e3 || lines.length > 1e4 || images.length > 2e3 || vectors.length > 2e4) throw Error("geometry limit exceeded");
        for (const b of runs) if (b[0] < -1 || b[1] < -1 || b[2] > bounds[2] + 1 || b[3] > bounds[3] + 1) add("ink-outside-page", p, b, 10, { pageBounds: bounds, source: "text-paint-ink" });
        for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
          const a = runs[i], b = runs[j], over = intersection(a, b), n = area(over);
          if (n > 4 && over[2] - over[0] > 3 && over[3] - over[1] > 2 && n / Math.min(area(a), area(b)) > 0.12 && !contains2(a, b) && !contains2(b, a)) add("text-overlap", p, over, 8, { first: a, second: b, overlapArea: n, source: "text-paint-ink" });
        }
        for (const line2 of lines) if (line2.horizontal) {
          for (const b of images) {
            const overlap3 = intersection(line2.bbox, b), n = area(overlap3);
            if (n > 4 && n / area(line2.bbox) > 0.2 && !contains2(b, line2.bbox)) add("text-image-overlap", p, overlap3, 8, { text: line2.text, image: b, overlapArea: n, source: "structured-text-and-image" });
          }
        }
        pages.push({ pageIndex: p, bounds, lines, images, vectorCount: vectors.length, unsupportedClips });
      } finally {
        dev?.destroy();
        st?.destroy();
        page.destroy();
      }
    }
    for (const body of profile.bodyLines || []) {
      const target = norm(body?.text || "");
      const matches = target ? pages.flatMap((page2) => page2.lines.filter((line2) => line2.horizontal && norm(line2.text) === target).map((line2) => ({ page: page2, line: line2 }))) : [];
      if (matches.length !== 1) {
        profileCoverage.bodyLines.skipped++;
        continue;
      }
      const { page, line } = matches[0];
      profileCoverage.bodyLines.checked++;
      const sizes = line.chars.map((c) => c.size).filter(Number.isFinite).sort((a, b) => a - b), size = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
      const expectedSize = Number.isFinite(body.sourceFontSize) && body.sourceFontSize > 0 ? body.sourceFontSize : profile.bodyFontSize;
      if (Number.isFinite(expectedSize) && size && size < expectedSize * 0.8) add("small-body-text", page.pageIndex, line.bbox, 5, { text: line.text, size, expectedSize, source: "unique-output-body-line" });
      const aliases = profile.outputBodyFontNames;
      if (Array.isArray(aliases) && aliases.length) {
        profileCoverage.fontNames.checked++;
        const allowed = aliases.map(fontIdentity);
        if (!line.chars.some((c) => allowed.includes(fontIdentity(c.font)))) add("body-font-deviation", page.pageIndex, line.bbox, 3, { text: line.text, fonts: [...new Set(line.chars.map((c) => c.font))], expectedFonts: aliases, source: "unique-output-body-line" });
      } else if (profile.bodyFontNames?.length) profileCoverage.fontNames.skipped++;
    }
    if (!(profile.bodyLines || []).length && (profile.bodyFontSize || profile.bodyFontNames?.length || profile.outputBodyFontNames?.length)) {
      profileCoverage.bodyLines.skipped++;
      if (profile.bodyFontNames?.length || profile.outputBodyFontNames?.length) profileCoverage.fontNames.skipped++;
    }
    for (const caption of profile.captions || []) {
      if (profile.coordinateSpace !== "output") {
        profileCoverage.captions.skipped++;
        captionObservations.push({ id: caption.id, status: "unavailable" });
        continue;
      }
      const target = norm(caption.text || "");
      const matches = [];
      if (target) for (const page2 of pages) for (let i = 0; i < page2.lines.length; i++) {
        let text = "";
        const selected = [];
        for (let j = i; j < page2.lines.length && j < i + 20; j++) {
          const line2 = page2.lines[j], previous = selected.at(-1);
          if (previous && (line2.bbox[1] < previous.bbox[1] - 1 || line2.bbox[1] - previous.bbox[3] > Math.max(20, (previous.bbox[3] - previous.bbox[1]) * 1.5) || Math.abs(line2.bbox[0] - previous.bbox[0]) > 30)) break;
          selected.push(line2);
          text = norm(text + " " + line2.text);
          if (text === target) {
            matches.push({ page: page2, line: { text, bbox: union2(selected.map((l) => l.bbox)) } });
            break;
          }
          if (!target.startsWith(text) || text.length >= target.length) break;
        }
      }
      const owner = pages[caption.assetPageIndex], assets = owner?.images.filter((b) => valid(caption.assetBbox) && area(intersection(b, caption.assetBbox)) / area(b) > 0.9 && area(intersection(b, caption.assetBbox)) / area(caption.assetBbox) > 0.9);
      if (matches.length !== 1 || assets?.length !== 1) {
        profileCoverage.captions.skipped++;
        captionObservations.push({ id: caption.id, status: "unavailable" });
        limitations.push("Caption or associated image could not be uniquely observed: " + String(caption.text || "").slice(0, 80));
        continue;
      }
      profileCoverage.captions.checked++;
      const { page, line } = matches[0], asset = assets[0];
      const gap = page.pageIndex === owner.pageIndex ? Math.max(0, line.bbox[1] - asset[3], asset[1] - line.bbox[3]) : Infinity;
      const horizontalOverlap = Math.min(line.bbox[2], asset[2]) - Math.max(line.bbox[0], asset[0]);
      const attached = page.pageIndex === owner.pageIndex && gap <= Math.max(36, (line.bbox[3] - line.bbox[1]) * 3) && horizontalOverlap > 0;
      captionObservations.push({ id: caption.id, status: attached ? "observed" : "separated", text: target, pageIndex: page.pageIndex, bbox: line.bbox, assetBbox: asset });
      if (!attached) add("caption-separated", page.pageIndex, line.bbox, 6, { assetPageIndex: owner.pageIndex, assetBbox: asset, gap: Number.isFinite(gap) ? gap : null, text: line.text });
    }
    for (const heading of profile.headings || []) {
      const matches = pages.flatMap((p) => p.lines.filter((l) => norm(l.text) === norm(heading.text || "")).map((line2) => ({ page: p, line: line2 })));
      if (matches.length !== 1) {
        profileCoverage.headings.skipped++;
        limitations.push("Heading could not be uniquely observed: " + String(heading.text || "").slice(0, 80));
        continue;
      }
      profileCoverage.headings.checked++;
      const { page, line } = matches[0], next = page.lines.filter((l) => l !== line && l.bbox[1] >= line.bbox[3] - 1 && Math.min(l.bbox[2], line.bbox[2]) - Math.max(l.bbox[0], line.bbox[0]) > 0).sort((a, b) => a.bbox[1] - b.bbox[1])[0];
      if (!next || next.bbox[1] - line.bbox[3] > Math.max(36, (line.bbox[3] - line.bbox[1]) * 3)) add("heading-orphan", page.pageIndex, line.bbox, 4, { text: line.text, nextGap: next ? next.bbox[1] - line.bbox[3] : null });
    }
    for (const column of profile.columns || []) {
      if (profile.coordinateSpace !== "output") {
        profileCoverage.columns.skipped++;
        continue;
      }
      const page = pages[column.pageIndex], box5 = column.bbox;
      if (!page || !valid(box5) || !contains2(page.bounds, box5)) {
        profileCoverage.columns.skipped++;
        limitations.push("Column geometry is invalid or unavailable.");
        continue;
      }
      const anchor = norm(column.anchorText || ""), anchorMatches = anchor ? pages.flatMap((p) => p.lines.filter((l) => norm(l.text) === anchor).map((line) => ({ page: p, line }))) : [];
      if (anchorMatches.length !== 1 || anchorMatches[0].page.pageIndex !== page.pageIndex || area(intersection(anchorMatches[0].line.bbox, box5)) > 4) {
        profileCoverage.columns.skipped++;
        limitations.push("Column anchor is unavailable, ambiguous, on another page, or inside the candidate column.");
        continue;
      }
      profileCoverage.columns.checked++;
      const occupied = page.lines.some((l) => area(intersection(l.bbox, box5)) > 4) || page.images.some((b) => area(intersection(b, box5)) > 4);
      if (!occupied) add("blank-column", column.pageIndex, box5, 4, { source: "profile-column-with-no-observed-text-or-image", vectorInk: "unverified" });
    }
    const measure = (page) => ({ pageIndex: page.pageIndex, textCharacters: page.lines.reduce((n, l) => n + l.chars.length, 0), textAreaRatio: Math.min(1, page.lines.reduce((n, l) => n + area(intersection(l.bbox, page.bounds)), 0) / area(page.bounds)), imageCount: page.images.length, vectorCount: page.vectorCount });
    const measurements = pages.map(measure);
    const source = sourceBytes && Array.isArray(sourcePageIndexes) ? inspectLayoutQuality({ bytes: sourceBytes, mupdf: mupdf6 }) : null;
    const sparsePages = measurements.map((m, i) => {
      const sparse = m.textAreaRatio < 0.08 && m.textCharacters < 1200;
      const sourceIndex = sourcePageIndexes?.[i], sm = Number.isInteger(sourceIndex) ? source?.sparsePageEvidence?.pages?.[sourceIndex] : null;
      let classification = "not-sparse";
      if (sparse) {
        if (m.textCharacters < 40 && (m.imageCount > 0 || m.vectorCount > 0)) classification = "artwork-only";
        else if (i === measurements.length - 1) classification = "document-final";
        else if (sm && sm.textAreaRatio < 0.08 && sm.textCharacters < 1200 && sm.textAreaRatio <= Math.max(m.textAreaRatio * 1.5, m.textAreaRatio + 0.01)) classification = "source-equally-sparse";
        else if (sm) classification = "candidate";
        else classification = "source-context-unavailable";
      }
      return { ...m, classification, sourcePageIndex: sm ? sourceIndex : null, sourceTextAreaRatio: sm?.textAreaRatio ?? null };
    });
    const sparsePageEvidence = { status: "partial", pages: sparsePages, threshold: { textAreaRatioBelow: 0.08, textCharactersBelow: 1200 }, limitation: "Text box area is an approximate occupancy indicator; includes furniture, omits vector/image occupancy and can overlap. Source comparison requires caller-provided page mapping; mappings are not verified ownership. Candidates need visual review." };
    const penaltyTerms = {};
    for (const issue of issues) penaltyTerms[issue.type] = (penaltyTerms[issue.type] || 0) + issue.penalty;
    return { schema: "falsify.layout-quality.v1", status: "partial", score: null, detectedIssuesScore: Math.max(0, 100 - Object.values(penaltyTerms).reduce((a, b) => a + b, 0)), penaltyTerms, issues, captionObservations, sparsePageEvidence, coverage: { profile: profileCoverage, pages: pages.length, textPaint: true, images: true, vectorPlacements: pages.reduce((n, p) => n + p.vectorCount, 0), captionOwnership: "only unique text and image matches", clipping: "partial: axis-aligned rectangular paths only", unsupportedClipOperations: pages.reduce((n, p) => n + p.unsupportedClips, 0) }, limitations };
  } catch (error2) {
    return { schema: "falsify.layout-quality.v1", status: "unavailable", score: null, penaltyTerms: {}, issues: [], limitations: [...limitations, String(error2?.message || error2)] };
  } finally {
    doc?.destroy();
  }
}

// app/src/paper-output-glyphs.mjs
function readOutputGlyphs({ bytes, mupdf: mupdf6 }) {
  const doc = mupdf6.Document.openDocument(bytes, "application/pdf");
  const pages = [];
  try {
    for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex++) {
      const page = doc.loadPage(pageIndex), glyphs = [];
      let failed = false;
      const collect = (text, ctm, resources) => {
        try {
          text.walk({ showGlyph(font, trm, gid, scalar) {
            try {
              const matrix = mupdf6.Matrix.concat(trm, ctm);
              if (!Number.isInteger(scalar) || scalar <= 0 || scalar === 65533 || scalar > 1114111 || scalar >= 55296 && scalar <= 57343 || !matrix.every(Number.isFinite)) failed = true;
              else glyphs.push({ scalar, origin: [matrix[4], matrix[5]], pageIndex });
            } catch {
              failed = true;
            } finally {
              font.destroy();
            }
          } });
        } catch {
          failed = true;
        } finally {
          text.destroy();
          for (const resource of resources) resource?.destroy();
        }
      };
      const dev = new mupdf6.Device({
        fillText(text, ctm, cs) {
          collect(text, ctm, [cs]);
        },
        strokeText(text, stroke, ctm, cs) {
          collect(text, ctm, [stroke, cs]);
        }
      });
      try {
        page.run(dev, mupdf6.Matrix.identity);
        dev.close();
      } catch {
        failed = true;
      } finally {
        dev.destroy();
        page.destroy();
      }
      pages.push(failed ? null : glyphs);
    }
  } finally {
    doc.destroy();
  }
  return pages;
}

// app/src/paper-compose-check.mjs
var normalize = (value) => value.replace(/\s+/gu, " ").trim();
function representationComparison(expected, observed, prefix = false) {
  let i = 0, j = 0;
  const differences = [];
  while (i < expected.length && j < observed.length) {
    const a = expected.codePointAt(i), b = observed.codePointAt(j);
    if (a === b) {
      i += a > 65535 ? 2 : 1;
      j += b > 65535 ? 2 : 1;
      continue;
    }
    if (a === 181 && b === 956) {
      differences.push({ kind: "micro-sign-to-greek-mu", sourceOffset: i, outputOffset: j, source: "U+00B5", output: "U+03BC" });
      i++;
      j++;
      continue;
    }
    if (a === 173 && expected.codePointAt(i + 1) === b) {
      differences.push({ kind: "discretionary-soft-hyphen-omitted", sourceOffset: i, outputOffset: j, source: "U+00AD", output: null });
      i++;
      continue;
    }
    return { matches: false, differences: [] };
  }
  return { matches: i === expected.length && (prefix || j === observed.length), differences, consumed: j };
}
async function checkRecomposition({ bytes, expectedBlocks, edits = {}, pdfjs, exporter, mupdf: mupdf6, expectedFurniture, outputFurniture, bodyFrame, blockSpans, layoutProfile, flowExpectations, sourceBytes, sourcePageIndexes } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || !pdfjs?.getDocument) throw new TypeError("PDF bytes and PDF.js are required");
  if (!Array.isArray(expectedBlocks) || !expectedBlocks.length || expectedBlocks.some((b) => typeof b.id !== "string" || typeof b.text !== "string") || new Set(expectedBlocks.map((b) => b.id)).size !== expectedBlocks.length) throw new TypeError("unique expected blocks are required");
  if (Object.keys(edits).some((id2) => !expectedBlocks.some((b) => b.id === id2) || typeof edits[id2] !== "string")) throw new TypeError("invalid edit");
  const findings = [], pages = [], locations = [], spacingEvidence = [];
  const furnitureEnabled = expectedFurniture !== void 0 || outputFurniture !== void 0 || bodyFrame !== void 0;
  const furnitureValid = Array.isArray(expectedFurniture) && Array.isArray(outputFurniture) && bodyFrame && ["left", "top", "right", "bottom"].every((k) => Number.isFinite(bodyFrame[k])) && bodyFrame.left < bodyFrame.right && bodyFrame.top < bodyFrame.bottom;
  if (furnitureEnabled && !furnitureValid) findings.push({ code: "furniture-unavailable", reason: "Furniture declarations, output map or body frame unavailable." });
  let sourceAssociation = { status: "unavailable", reason: "Complete valid block spans are unavailable." };
  let selectedSources = null;
  let furnitureAssets = false;
  let inspectedItems = 0;
  let glyphPages = null;
  if (mupdf6) {
    try {
      glyphPages = readOutputGlyphs({ bytes: bytes.slice(), mupdf: mupdf6 });
    } catch {
      glyphPages = null;
    }
  }
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, isEvalSupported: false });
  let doc;
  try {
    doc = await task.promise;
    if (furnitureValid) {
      const validSpan = (s) => typeof s?.id === "string" && s.id.length > 0 && Number.isInteger(s.sourcePage) && s.sourcePage >= 0 && [s.start, s.end].every((p) => Number.isInteger(p?.page) && p.page >= 1 && p.page <= doc.numPages && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.id === void 0 || p.id === s.id) && (p.sourcePage === void 0 || p.sourcePage === s.sourcePage)) && s.start.page <= s.end.page;
      if (Array.isArray(blockSpans) && blockSpans.length && blockSpans.every(validSpan) && new Set(blockSpans.map((s) => s.id)).size === blockSpans.length && blockSpans.every((s, i) => i === 0 || s.start.page >= blockSpans[i - 1].start.page)) {
        const selections = Array.from({ length: doc.numPages }, (_, i) => blockSpans.find((s) => s.start.page <= i + 1 && s.end.page >= i + 1));
        if (selections.every(Boolean)) {
          selectedSources = selections.map((s) => s.sourcePage);
          sourceAssociation = {
            status: "declared",
            pages: selectedSources.map((sourcePage, i) => ({ page: i + 1, sourcePage })),
            unusedVariants: [...new Set(expectedFurniture.map((t) => t.sourcePage))].filter((p) => !selectedSources.includes(p)),
            limitation: "Source association is declared by span metadata; PDF bytes establish text and geometry."
          };
        }
      }
    }
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const parts = [];
      let previous = null, ordinal = 0, pendingQuoteSpace = null, lineHeight = 0;
      const boundaries = [], itemScalars = [];
      const frame = viewport.transform;
      const frameSupported = viewport.rotation === 0 && Array.isArray(frame) && frame.length === 6 && frame.every(Number.isFinite) && frame[0] === 1 && frame[1] === 0 && frame[2] === 0 && frame[3] === -1 && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0;
      const excluded = /* @__PURE__ */ new Set();
      if (furnitureValid) {
        const records = content.items.map((item, index) => {
          const t = item.transform, style = content.styles?.[item.fontName];
          if (typeof item.str !== "string" || !item.str.trim() || !frameSupported || !Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite) || !Number.isFinite(item.width) || item.width < 0 || !Number.isFinite(item.height) || item.height <= 0 || t[0] <= 0 || t[3] <= 0 || Math.abs(t[1]) > 1e-6 || Math.abs(t[2]) > 1e-6 || item.dir !== "ltr" || !Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent) || style.ascent < 0 || style.descent > 0) return null;
          const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
          return { index, item, x, y, top: y - style.ascent * item.height, bottom: y - style.descent * item.height };
        });
        const claimed = /* @__PURE__ */ new Set(), mergedMarkers = /* @__PURE__ */ new Set();
        const pageMarkers = outputFurniture.filter((m) => m?.page === n);
        for (const run of records.filter(Boolean)) {
          const group = pageMarkers.filter((m) => m.kind && Math.abs(m.y - run.top) <= Math.max(4, run.item.height) && m.x >= run.x - 2 && m.x < run.x + run.item.width - 0.01).sort((a, b) => a.x - b.x);
          if (group.length < 2 || Math.abs(group[0].x - run.x) > 2 || group.some((m) => m.kind !== group[0].kind || m.sourcePage !== group[0].sourcePage)) continue;
          const templates = group.map((m) => expectedFurniture.filter((t) => t.sourcePage === m.sourcePage && t.kind === m.kind && t.occurrences?.some((o) => (o.blockId || o.itemId) === m.id)));
          if (templates.some((ts) => ts.length !== 1 || !["text", "counter"].includes(ts[0].entryKind))) continue;
          const expected2 = templates.map((ts) => ts[0].entryKind === "counter" ? `${n} / ${doc.numPages}` : ts[0].text);
          if (expected2.some((t) => typeof t !== "string") || ![expected2.join(" "), expected2.join("")].some((text) => normalize(text) === normalize(run.item.str))) continue;
          if (group[0].kind === "header" ? run.top < 0 || run.bottom > bodyFrame.top : run.top < bodyFrame.bottom || run.bottom > viewport.height) continue;
          excluded.add(run.index);
          claimed.add(run.index);
          group.forEach((m) => mergedMarkers.add(m));
        }
        for (const marker of outputFurniture.filter((m) => m?.page === n)) {
          if (mergedMarkers.has(marker)) continue;
          const matches = expectedFurniture.filter((t) => t?.sourcePage === marker.sourcePage && t.kind === marker.kind && t.occurrences?.some((o) => (o.blockId || o.itemId) === marker.id));
          if (matches.length !== 1 || !["header", "footer"].includes(marker.kind) || !Number.isFinite(marker.x) || !Number.isFinite(marker.y)) {
            findings.push({ code: "furniture-unavailable", pageIndex: n - 1, reason: "Invalid or ambiguous furniture map entry." });
            continue;
          }
          const template = matches[0];
          if (template.entryKind === "asset") {
            furnitureAssets = true;
            continue;
          }
          const target = template.entryKind === "counter" ? `${n} / ${doc.numPages}` : template.text;
          if (typeof target !== "string" || !normalize(target)) {
            findings.push({ code: "furniture-unavailable", pageIndex: n - 1, reason: "Furniture text unavailable." });
            continue;
          }
          const candidates = [];
          for (let i = 0; i < records.length; i++) {
            const first = records[i];
            if (!first || Math.abs(first.x - marker.x) > 2 || Math.abs(first.top - marker.y) > Math.max(4, first.item.height)) continue;
            let value = "", previousRun = null, indexes = [];
            for (let j = i; j < records.length; j++) {
              const run = records[j];
              if (!run) {
                if (content.items[j]?.str?.trim()) break;
                continue;
              }
              if (marker.kind === "header" ? run.top < 0 || run.bottom > bodyFrame.top : run.top < bodyFrame.bottom || run.bottom > viewport.height) break;
              if (previousRun && !/\s$/u.test(value) && !/^\s/u.test(run.item.str)) {
                const dy = Math.abs(run.y - previousRun.y), h = Math.max(run.item.height, previousRun.item.height), gap = run.x - (previousRun.x + previousRun.item.width);
                if (previousRun.item.hasEOL || dy > h * 0.5 || gap >= h * 0.3) value += " ";
                else if (dy > h * 0.1 || gap < -h * 0.1 || gap > h * 0.1) break;
              }
              value += run.item.str;
              indexes.push(j);
              previousRun = run;
              if (normalize(value) === normalize(target)) {
                candidates.push(indexes.slice());
                break;
              }
              if (normalize(value).length > normalize(target).length) break;
            }
          }
          if (candidates.length !== 1 || candidates[0].some((i) => claimed.has(i))) {
            findings.push({ code: candidates.length ? "ambiguous-furniture" : "missing-furniture", pageIndex: n - 1, id: marker.id });
            continue;
          }
          for (const i of candidates[0]) {
            excluded.add(i);
            claimed.add(i);
          }
        }
        if (selectedSources) {
          const sourcePage = selectedSources[n - 1];
          for (const marker of pageMarkers) if (marker.sourcePage !== sourcePage)
            findings.push({ code: "wrong-furniture-source", pageIndex: n - 1, sourcePage: marker.sourcePage, expectedSourcePage: sourcePage });
          for (const t of expectedFurniture.filter((t2) => t2.sourcePage === sourcePage)) {
            for (const occurrence of t.occurrences || []) {
              const id2 = occurrence.blockId || occurrence.itemId;
              if (!pageMarkers.some((m) => m.sourcePage === sourcePage && m.kind === t.kind && m.id === id2))
                findings.push({ code: "missing-furniture", pageIndex: n - 1, id: id2, sourcePage, reason: "Template occurrence has no output map entry." });
            }
          }
        }
        for (const r of records) if (r && !excluded.has(r.index) && (r.bottom <= bodyFrame.top || r.top >= bodyFrame.bottom)) {
          findings.push({ code: "unexpected-margin-text", pageIndex: n - 1, text: r.item.str });
        }
      }
      for (const [itemIndex, item] of content.items.entries()) {
        if (typeof item.str !== "string") continue;
        const t = item.transform, style = content.styles?.[item.fontName];
        const supported = frameSupported && Array.isArray(t) && t.length === 6 && t.every(Number.isFinite) && Number.isFinite(item.width) && item.width >= 0 && Number.isFinite(item.height) && item.height > 0 && t[0] > 0 && t[3] > 0 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 && item.dir === "ltr" && !style?.vertical;
        let position = null;
        if (supported) {
          const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
          if (Number.isFinite(x) && Number.isFinite(y)) position = { x, y, width: item.width, height: item.height };
        }
        if (item.str.trim()) {
          inspectedItems++;
          if (!position || !Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent) || style.ascent < 0 || style.descent > 0) {
            findings.push({ code: "unsupported-text-geometry", pageIndex: n - 1, text: item.str });
          } else {
            const top = position.y - style.ascent * position.height;
            const bottom = position.y - style.descent * position.height;
            if (position.x < -1 || position.x + position.width > viewport.width + 1 || top < -1 || bottom > viewport.height + 1) findings.push({ code: "text-outside-page", pageIndex: n - 1, text: item.str });
          }
        }
        if (excluded.has(itemIndex)) {
          for (const scalar of item.str) if (!/\s/u.test(scalar)) {
            itemScalars.push(scalar);
            ordinal++;
          }
          previous = null;
          continue;
        }
        if (pendingQuoteSpace && item.str && !/^\s+$/u.test(item.str)) {
          if (/^[”’]/u.test(item.str)) {
            pendingQuoteSpace.rightPosition = position;
            boundaries.push(pendingQuoteSpace);
          }
          pendingQuoteSpace = null;
        }
        if (item.str === " " && item.height === 0 && previous?.position && !previous.hasEOL && /^[”’]/u.test(content.items[itemIndex + 1]?.str || "")) {
          pendingQuoteSpace = { part: parts.length, ordinal, leftPosition: previous.position };
        }
        if (previous && item.str && !/\s$/u.test(previous.str) && !/^\s/u.test(item.str)) {
          if (previous.hasEOL) {
            const recent = parts.slice(-8).join("");
            const paragraphGap = position && previous.position && Math.abs(position.y - previous.position.y) > Math.max(position.height, previous.position.height, lineHeight) * 1.9;
            const columnTurn = /\S[–\-/]$/u.test(recent) && /^[\p{L}\p{N}_−]/u.test(item.str) && position && previous.position && previous.position.y > viewport.height * 0.8 && position.y < viewport.height * 0.2 && position.x > previous.position.x + previous.position.width;
            const url = /(?:https?:\/\/|www\.)[^\s]*$/iu.test(recent) && (/[./?=&-]$/u.test(recent) || /\p{L}$/u.test(recent) && /^\p{N}/u.test(item.str) || /^[\p{L}\p{N}_-]+[./]/u.test(item.str));
            if ((!paragraphGap || columnTurn) && (/\S[–\-/]$/u.test(recent) && /^[\p{L}\p{N}_−]/u.test(item.str) || /(?:^|\s)-$/u.test(recent) && /^\p{L}/u.test(item.str) || /\S$/u.test(previous.str) && /^\[/u.test(item.str) || /\S*\/\S*[?=&]$/u.test(previous.str) && /^[\p{L}\p{N}]/u.test(item.str) || url && /^[\p{L}\p{N}]/u.test(item.str))) {
              boundaries.push({ part: parts.length, ordinal, leftPosition: previous.position, rightPosition: position });
            }
            parts.push(" ");
          } else if (!position || !previous.position) findings.push({ code: "ambiguous-text-geometry", pageIndex: n - 1 });
          else {
            const height = Math.max(position.height, previous.position.height);
            const dy = Math.abs(position.y - previous.position.y);
            const gap = position.x - (previous.position.x + previous.position.width);
            if (dy > height * 0.5) parts.push(" ");
            else if (dy > height * 0.1 || gap < -height * 0.1 || gap > height * 0.1 && gap < height * 0.3) findings.push({ code: "ambiguous-text-geometry", pageIndex: n - 1 });
            else if (gap >= height * 0.3) parts.push(" ");
          }
        }
        if (previous?.hasEOL && item.str) lineHeight = 0;
        if (position) lineHeight = Math.max(lineHeight, position.height);
        parts.push(item.str);
        for (const scalar of item.str) if (!/\s/u.test(scalar)) {
          itemScalars.push(scalar);
          ordinal++;
        }
        if (item.str) previous = { str: item.str, hasEOL: item.hasEOL, position };
        else if (item.hasEOL && previous) previous.hasEOL = true;
      }
      if (boundaries.length) {
        const glyphs = glyphPages?.[n - 1];
        const mapped = [], encoded = [];
        if (Array.isArray(glyphs)) {
          for (let i = 0; i < glyphs.length; i++) {
            const char = String.fromCodePoint(glyphs[i].scalar);
            if (!/\s/u.test(char)) {
              mapped.push(i);
              encoded.push(char);
            }
          }
        }
        const glyphKey = (char) => char === "\xB5" ? "\u03BC" : char;
        const aligned = encoded.length === itemScalars.length && encoded.every((char, i) => glyphKey(char) === glyphKey(itemScalars[i]));
        for (const boundary of boundaries) {
          const left = mapped[boundary.ordinal - 1], right = mapped[boundary.ordinal];
          const near3 = (glyph, pos) => pos && glyph && Math.abs(glyph.origin[1] - pos.y) < Math.max(1, pos.height * 0.2) && glyph.origin[0] >= pos.x - 1 && glyph.origin[0] <= pos.x + pos.width + 1;
          if (aligned && left !== void 0 && right !== void 0 && left < right && near3(glyphs[left], boundary.leftPosition) && near3(glyphs[right], boundary.rightPosition)) {
            const spaces = glyphs.slice(left + 1, right).filter((g) => /\s/u.test(String.fromCodePoint(g.scalar)));
            const resolved = spaces.length ? " " : "";
            if (parts[boundary.part] !== resolved) spacingEvidence.push({ pageIndex: n - 1, action: resolved ? "retain-encoded-space" : "remove-inferred-space", leftScalar: glyphs[left].scalar, rightScalar: glyphs[right].scalar, leftOrigin: glyphs[left].origin, rightOrigin: glyphs[right].origin, encodedWhitespace: spaces.map((g) => g.scalar) });
            parts[boundary.part] = resolved;
          } else {
            findings.push({ code: "ambiguous-text-geometry", pageIndex: n - 1, reason: "PDF.js may discard an encoded space at a line-final hyphen or citation boundary, or infer one before a closing quote; glyph stream unavailable or misaligned." });
          }
        }
      }
      pages.push(normalize(parts.join("")));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  if (furnitureValid) {
    for (const m of outputFurniture) if (!Number.isInteger(m?.page) || m.page < 1 || m.page > (doc?.numPages || 0)) findings.push({ code: "furniture-unavailable", reason: "Furniture map page is invalid." });
    if (expectedFurniture.some((t) => t.entryKind === "asset")) furnitureAssets = true;
  }
  const observed = normalize(pages.join(" "));
  const expected = normalize(expectedBlocks.map((b) => Object.hasOwn(edits, b.id) ? edits[b.id] : b.text).join(" "));
  const layoutQuality = inspectLayoutQuality({ bytes, mupdf: mupdf6, profile: layoutProfile, sourceBytes, sourcePageIndexes });
  let flow = { status: "not-requested" }, flowMatches = false, flowDifferences = [];
  if (flowExpectations !== void 0) {
    const ids = flowExpectations?.floatingCaptionBlockIds, captions = layoutProfile?.captions;
    const removeUnique = (stream, value, allowRepresentations = false) => {
      const matches = [];
      for (let at = 0; at < stream.length; at++) {
        if (at && stream[at - 1] !== " ") continue;
        const match2 = allowRepresentations ? representationComparison(value, stream.slice(at), true) : { matches: stream.startsWith(value, at), consumed: value.length, differences: [] };
        const end = at + match2.consumed;
        if (match2.matches && (end === stream.length || stream[end] === " ")) matches.push({ at, end, differences: match2.differences });
      }
      if (matches.length !== 1) return null;
      const match = matches[0];
      return { stream: normalize(stream.slice(0, match.at) + " " + stream.slice(match.end)), differences: match.differences };
    };
    if (Array.isArray(ids) && ids.length && new Set(ids).size === ids.length && Array.isArray(captions)) {
      let left = expected, right = observed, reason = null;
      for (const id2 of ids) {
        const block = expectedBlocks.find((b) => b.id === id2), declarations = captions.filter((c) => c.id === id2), observations = layoutQuality.captionObservations?.filter((c) => c.id === id2 && c.status === "observed");
        const value = block && normalize(Object.hasOwn(edits, id2) ? edits[id2] : block.text);
        if (!value || declarations.length !== 1 || normalize(declarations[0].text || "") !== value || observations?.length !== 1) {
          reason = "Caption declaration or independent image association is ambiguous or unavailable.";
          break;
        }
        const sourceCaption = removeUnique(left, value), outputCaption = removeUnique(right, value, true);
        if (!sourceCaption || !outputCaption) {
          reason = "Caption occurrence is missing or ambiguous.";
          break;
        }
        left = sourceCaption.stream;
        right = outputCaption.stream;
        flowDifferences.push(...outputCaption.differences.map((d) => ({ ...d, scope: "caption", captionId: id2 })));
      }
      if (reason) flow = { status: "unavailable", reason };
      else {
        const body = representationComparison(left, right);
        flowMatches = body.matches;
        if (flowMatches) flowDifferences.push(...body.differences.map((d) => ({ ...d, scope: "body-after-caption-removal" })));
        flow = { status: flowMatches ? "checked" : "finding", comparison: "Ordered body after removing uniquely observed declared captions, allowing documented representation differences." };
      }
    } else flow = { status: "unavailable", reason: "Invalid floating caption declarations." };
  }
  const representation = representationComparison(expected, observed);
  const reportedDifferences = representation.matches ? representation.differences : flowMatches ? flowDifferences : [];
  if (!representation.matches && !flowMatches) findings.push({ code: "content-mismatch", expected, observed });
  const alignmentAvailable = observed === expected && !findings.some((f) => f.code === "ambiguous-text-geometry" || f.code === "unsupported-text-geometry");
  if (alignmentAvailable) {
    const pageRanges = [];
    let offset = 0;
    for (const page of pages) {
      if (!page) {
        pageRanges.push(null);
        continue;
      }
      if (offset) offset++;
      pageRanges.push({ start: offset, end: offset + page.length });
      offset += page.length;
    }
    offset = 0;
    for (const block of expectedBlocks) {
      const value = normalize(Object.hasOwn(edits, block.id) ? edits[block.id] : block.text);
      if (!value) {
        locations.push({ id: block.id, pageIndexes: [] });
        continue;
      }
      if (offset) offset++;
      const start = offset, end = start + value.length;
      const pageIndexes = pageRanges.flatMap((range, i) => range && range.start < end && range.end > start ? [i] : []);
      locations.push({ id: block.id, pageIndexes });
      offset = end;
    }
  }
  const independent = typeof exporter === "string" && exporter.trim() && !/pdf\.?js/i.test(exporter) ? { status: "declared", reader: "PDF.js text extraction", exporter, limitation: "Distinct named engines only; exporter identity is caller supplied." } : { status: "unavailable", reader: "PDF.js text extraction", reason: "Exporter path not supplied or uses PDF.js." };
  return { schema: "falsify.recomposition-check.v1", readable: true, layoutQuality, checks: { flow, furniture: furnitureEnabled ? { status: findings.some((f) => f.code === "missing-furniture" || f.code === "unexpected-margin-text" || f.code === "wrong-furniture-source") ? "finding" : !furnitureValid || !selectedSources || findings.some((f) => f.code === "furniture-unavailable" || f.code === "ambiguous-furniture") ? "unavailable" : "checked", sourceAssociation, assets: furnitureAssets ? { status: "unavailable", reason: "Furniture assets require independent visual inspection." } : { status: "not-applicable" } } : void 0, content: { status: findings.some((f) => f.code === "ambiguous-text-geometry" || f.code === "unsupported-text-geometry") ? "unavailable" : observed === expected || flowMatches && !flowDifferences.length ? "pass" : representation.matches || flowMatches ? "normalized" : "finding", comparison: "ordered text with whitespace runs collapsed; ambiguous item geometry is unavailable", representationDifferences: reportedDifferences, spacingEvidence, offsetUnit: "UTF-16 offsets in whitespace-normalized source expectation and PDF.js output; scoped flow differences use caption-local or body-after-caption-removal offsets", limitation: reportedDifferences.length ? "The listed representation differences are not byte-exact preservation." : void 0 }, bounds: { status: findings.some((f) => f.code === "text-outside-page") ? "finding" : !inspectedItems || findings.some((f) => f.code === "unsupported-text-geometry") ? "unavailable" : "checked", limitation: "Extracted upright text items only, estimated from font ascent and descent; PDF.js may omit off-page text. Not clipping or ink bounds." }, movement: alignmentAvailable ? { status: "observed", locations } : { status: "unavailable", locations: null, reason: "Complete ordered text alignment or supported geometry is unavailable." }, independent, visual: { status: "unavailable", reason: "No raster or visibility inspection." }, overlap: { status: "unavailable", reason: "Text and asset ownership not established." }, captionOwnership: { status: "unavailable", reason: "Relations not established from PDF bytes." } }, findings };
}

// app/src/browser-fonts.mjs
var error = (message) => new Error(message);
function parseFont(bytes) {
  const bad = () => {
    throw error("\uC62C\uBC14\uB978 TTF \uB610\uB294 OTF \uAE00\uAF34 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  };
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => {
    if (o < 0 || o + 2 > bytes.length) bad();
    return view.getUint16(o);
  };
  const u32 = (o) => {
    if (o < 0 || o + 4 > bytes.length) bad();
    return view.getUint32(o);
  };
  const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  const sig = u32(0);
  if (sig === 1953784678) throw error("\uAE00\uAF34 \uCEEC\uB809\uC158(TTC/OTC)\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB2E8\uC77C TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  if (sig !== 65536 && sig !== 1330926671 && sig !== 1953658213) bad();
  const count = u16(4), tables = /* @__PURE__ */ new Map();
  if (!count || 12 + count * 16 > bytes.length) bad();
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, name = tag(p), offset = u32(p + 8), length = u32(p + 12);
    if (offset > bytes.length || length > bytes.length - offset || tables.has(name)) bad();
    tables.set(name, { offset, length });
  }
  if (tables.has("fvar")) throw error("\uAC00\uBCC0 \uAE00\uAF34\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uACE0\uC815 \uAD75\uAE30\uC758 TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  const names = tables.get("name"), os2 = tables.get("OS/2"), head = tables.get("head");
  if (!names || names.length < 6 || !os2 || os2.length < 64 || !head || head.length < 46) bad();
  const n = names.offset, entries = u16(n + 2), strings = n + u16(n + 4), end = n + names.length;
  if (n + 6 + entries * 12 > end || strings > end) bad();
  const values = /* @__PURE__ */ new Map();
  for (let i = 0; i < entries; i++) {
    const p = n + 6 + i * 12, platform = u16(p), encoding = u16(p + 2), language = u16(p + 4), id2 = u16(p + 6), length = u16(p + 8), start = strings + u16(p + 10);
    if (start > end || length > end - start) bad();
    if (![1, 2, 6, 16, 17].includes(id2)) continue;
    let text;
    if (platform === 0 || platform === 3) {
      if (length % 2) bad();
      text = "";
      for (let j = 0; j < length; j += 2) text += String.fromCharCode(u16(start + j));
    } else if (platform === 1 && encoding === 0) text = String.fromCharCode(...bytes.subarray(start, start + length));
    else continue;
    text = text.replace(/\0/g, "").trim();
    const score = (platform === 3 ? 4 : platform === 0 ? 3 : 1) + (language === 1033 ? 2 : 0);
    if (text && (!values.has(id2) || values.get(id2).score < score)) values.set(id2, { text, score });
  }
  const get = (id2) => values.get(id2)?.text;
  const family = get(16) || get(1), postscriptName = get(6);
  if (!family) bad();
  const weight = u16(os2.offset + 4), fsType = u16(os2.offset + 8), selection = u16(os2.offset + 62), macStyle = u16(head.offset + 44);
  if (weight < 1 || weight > 1e3) bad();
  if (fsType & 512 || fsType & 2 && !(fsType & 12)) throw error("\uC774 \uAE00\uAF34\uC740 \uC784\uBCA0\uB529 \uC81C\uD55C \uB610\uB294 \uBE44\uD2B8\uB9F5 \uC804\uC6A9 \uC81C\uD55C\uC774 \uC788\uC5B4 PDF\uC5D0 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB2E4\uB978 \uAE00\uAF34\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  return { family, ...postscriptName ? { postscriptName } : {}, weight, italic: Boolean(selection & 1 || macStyle & 2), fsType };
}

// app/src/paper-output-profile.mjs
var norm2 = (s) => String(s ?? "").replace(/\s+/gu, " ").trim();
var valid2 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
var area2 = (b) => (b[2] - b[0]) * (b[3] - b[1]);
var overlap2 = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
function buildOutputProfile({ bytes, mupdf: mupdf6, document = {}, flow = {}, expectedBlocks = [], fontPlan, selectedFamilyAliases, assetSpans = [] } = {}) {
  const evidence = { body: [], captions: [], headings: [], font: { status: "unavailable" }, columns: { status: "unavailable", reason: "Output column bounds are not independently established." } };
  const profile = { coordinateSpace: "output", bodyLines: [], captions: [], columns: [], headings: [] };
  const source = deriveLayoutProfile(document, flow);
  if (source.bodyFontSize > 0) profile.bodyFontSize = source.bodyFontSize;
  const aliases = Array.isArray(selectedFamilyAliases) ? selectedFamilyAliases.filter((x) => typeof x === "string" && x.trim()) : [];
  if (!aliases.length && fontPlan) {
    const used = new Set((fontPlan.fallback || []).filter((x) => x.kind === "glyph" && x.family).map((x) => x.family));
    if (fontPlan.selected?.family) used.add(fontPlan.selected.family);
    for (const candidate of [fontPlan.selected, ...fontPlan.candidates || []].filter(Boolean)) {
      if (!candidate.getBytes || candidate !== fontPlan.selected && !used.has(candidate.family)) continue;
      try {
        const meta = parseFont(candidate.getBytes());
        if (candidate !== fontPlan.selected && !used.has(meta.family)) continue;
        aliases.push(meta.family);
        if (meta.postscriptName) aliases.push(meta.postscriptName);
      } catch {
      }
    }
  }
  if (aliases.length) {
    profile.outputBodyFontNames = [...new Set(aliases)];
    evidence.font = { status: "available", aliases: profile.outputBodyFontNames, source: selectedFamilyAliases?.length ? "explicit-selected-aliases" : "selected-font-plan-family", limitation: "Font family may differ from the name exposed by PDF extraction; supply verified aliases." };
  } else evidence.font.reason = "No independently resolved selected family aliases.";
  let doc;
  const pages = [];
  try {
    if (!mupdf6?.Document) throw Error("MuPDF unavailable");
    doc = mupdf6.Document.openDocument(bytes, "application/pdf");
    if (doc.countPages() > 500) throw Error("page limit exceeded");
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      let st;
      try {
        const lines = [], images = [];
        st = page.toStructuredText("preserve-whitespace,preserve-images");
        let line;
        st.walk({ beginLine(_box, wmode, direction) {
          line = { text: "", horizontal: wmode === 0 && direction[0] > 0 && Math.abs(direction[1]) < 0.01 };
        }, onChar(c) {
          if (line) line.text += c;
        }, endLine() {
          if (line?.horizontal && norm2(line.text)) lines.push(norm2(line.text));
          line = null;
        }, onImageBlock(b, _t, image) {
          try {
            if (valid2(b)) images.push([...b]);
          } finally {
            image.destroy();
          }
        } });
        if (lines.length > 1e4 || images.length > 2e3) throw Error("geometry limit exceeded");
        pages.push({ lines, images });
      } finally {
        st?.destroy();
        page.destroy();
      }
    }
  } catch (error2) {
    evidence.error = String(error2?.message || error2);
    return { profile, evidence };
  } finally {
    doc?.destroy();
  }
  const expected = /* @__PURE__ */ new Map(), duplicate = /* @__PURE__ */ new Set();
  for (const b of expectedBlocks) {
    if (expected.has(b.id)) duplicate.add(b.id);
    else expected.set(b.id, norm2(b.text));
  }
  const occurrence = (target) => {
    const found = [];
    if (!target) return found;
    for (let p = 0; p < pages.length; p++) {
      const lines = pages[p].lines;
      for (let i = 0; i < lines.length; i++) {
        let text = "";
        for (let j = i; j < lines.length; j++) {
          text = norm2(text + " " + lines[j]);
          if (text === target) {
            found.push({ pageIndex: p, start: i, end: j });
            break;
          }
          if (!target.startsWith(text) || text.length >= target.length) break;
        }
      }
    }
    return found;
  };
  const uniqueExpected = (target) => !!target && [...expected.values()].filter((x) => x === target).length === 1;
  const kinds = (kind) => (flow.items || []).filter((x) => x.kind === kind).flatMap((x) => x.blockIds || []);
  const allLines = pages.flatMap((p) => p.lines), sourceBlocks = new Map((document.blocks || []).map((b) => [b.id, b])), sourceIds = new Set(sourceBlocks.keys()), styles = new Map((document.styles || []).map((s) => [s.id, s]));
  const sourceSize = (id2) => {
    const b = sourceBlocks.get(id2), sizes = [];
    for (const c of b?.source?.characters || []) {
      const size = styles.get(c.styleId)?.size;
      if (Number.isFinite(size) && size > 0) for (let n = 0; n < Math.min(256, Math.max(1, c.end - c.start)); n++) sizes.push(size);
    }
    if (!sizes.length) {
      const size = styles.get(b?.styleId)?.size;
      if (Number.isFinite(size) && size > 0) sizes.push(size);
    }
    sizes.sort((a, b2) => a - b2);
    return sizes[Math.floor(sizes.length / 2)];
  };
  for (const id2 of kinds("paragraph")) {
    const target = expected.get(id2);
    if (!sourceIds.has(id2) || duplicate.has(id2) || !uniqueExpected(target)) {
      evidence.body.push({ id: id2, status: "unavailable", reason: "Missing or ambiguous source/expected block." });
      continue;
    }
    const matches = occurrence(target);
    if (matches.length !== 1) {
      evidence.body.push({ id: id2, status: "unavailable", reason: matches.length ? "Ambiguous output block." : "Output block not observed." });
      continue;
    }
    const m = matches[0], lines = pages[m.pageIndex].lines.slice(m.start, m.end + 1);
    let count = 0;
    for (const text of lines) if (allLines.filter((x) => x === text).length === 1) {
      profile.bodyLines.push({ text, sourceFontSize: sourceSize(id2) });
      count++;
    }
    evidence.body.push({ id: id2, status: count ? "observed" : "unavailable", pageIndex: m.pageIndex, matchedLines: lines.length, nominatedLines: count, reason: count < lines.length ? "Repeated output lines skipped." : void 0 });
  }
  for (const id2 of kinds("heading")) {
    const target = expected.get(id2), matches = occurrence(target);
    if (sourceIds.has(id2) && !duplicate.has(id2) && uniqueExpected(target) && matches.length === 1 && matches[0].start === matches[0].end && allLines.filter((x) => x === target).length === 1) {
      profile.headings.push({ text: target });
      evidence.headings.push({ id: id2, status: "observed" });
    } else evidence.headings.push({ id: id2, status: "unavailable" });
  }
  for (const item of (flow.items || []).filter((x) => x.kind === "asset")) for (const id2 of item.captionIds || []) {
    const target = expected.get(id2), matches = occurrence(target), ids = [item.renderAssetId, ...item.assetIds || []].filter(Boolean), spans = assetSpans.filter((s) => ids.includes(s.id) && Number.isInteger(s.pageIndex) && valid2(s.bbox));
    const candidates = [];
    for (const [pageIndex, page] of pages.entries()) for (const b of page.images) if (spans.some((s) => s.pageIndex === pageIndex && overlap2(b, s.bbox) / area2(b) > 0.9 && overlap2(b, s.bbox) / area2(s.bbox) > 0.9)) candidates.push({ pageIndex, bbox: b });
    const reason = !sourceIds.has(id2) || duplicate.has(id2) || !uniqueExpected(target) ? "Missing or ambiguous source/expected caption." : matches.length !== 1 ? "Caption output missing or ambiguous." : matches[0].end - matches[0].start + 1 > 20 ? "Caption exceeds checker 20-line limit." : candidates.length !== 1 ? "Image placement unavailable or ambiguous (vector assets are unsupported)." : null;
    if (reason) evidence.captions.push({ id: id2, status: "unavailable", reason });
    else {
      profile.captions.push({ id: id2, text: target, assetPageIndex: candidates[0].pageIndex, assetBbox: candidates[0].bbox });
      evidence.captions.push({ id: id2, status: "observed", pageIndex: matches[0].pageIndex, lineCount: matches[0].end - matches[0].start + 1 });
    }
  }
  return { profile, evidence };
}

// app/src/paper-asset-spans.mjs
var box3 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
var overlaps3 = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
var inside2 = (b, p, t = 0.5) => b[0] >= p[0] - t && b[1] >= p[1] - t && b[2] <= p[2] + t && b[3] <= p[3] + t;
function resolveOutputAssetSpans({ bytes, mupdf: mupdf6, flow, blockSpans } = {}) {
  const spans = [], evidence = [];
  if (!mupdf6 || !(bytes instanceof Uint8Array) || !flow || !Array.isArray(flow.items) || !Array.isArray(blockSpans)) return { spans, evidence: [{ reason: "invalid-input" }] };
  const items = flow.items.filter((x) => x?.kind === "asset");
  const idFor = (i) => i.renderAssetId || (i.assetIds?.length === 1 ? i.assetIds[0] : null);
  const counts = /* @__PURE__ */ new Map();
  for (const i of items) for (const id2 of new Set([idFor(i), ...i.assetIds || []].filter(Boolean))) counts.set(id2, (counts.get(id2) || 0) + 1);
  const nominations = /* @__PURE__ */ new Map();
  for (const s of blockSpans) if (typeof s?.id === "string") nominations.set(s.id, [...nominations.get(s.id) || [], s]);
  let doc;
  try {
    doc = mupdf6.Document.openDocument(bytes, "application/pdf");
    const pages = [];
    for (let pi = 0; pi < doc.countPages(); pi++) {
      const page = doc.loadPage(pi), placements = [], clips = [];
      let failed = false, maskDepth = 0, dev;
      try {
        const bounds = [...page.getBounds()];
        dev = new mupdf6.Device({
          clipPath(path, evenOdd, ctm) {
            try {
              const points = [];
              let complex = false, closed = false;
              path.walk({ moveTo(x, y) {
                points.push([x, y]);
              }, lineTo(x, y) {
                points.push([x, y]);
              }, curveTo() {
                complex = true;
              }, closePath() {
                closed = true;
              } });
              if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
              const xs = new Set(points.map((p) => p[0])), ys = new Set(points.map((p) => p[1]));
              const axis = Math.abs(ctm[1]) < 1e-8 && Math.abs(ctm[2]) < 1e-8;
              const rect = axis && !complex && closed && points.length === 4 && xs.size === 2 && ys.size === 2 && points.every((p, i) => {
                const n = points[(i + 1) % 4];
                return p[0] === n[0] !== (p[1] === n[1]);
              });
              clips.push(rect ? [...path.getBounds(null, ctm)] : null);
            } catch {
              clips.push(null);
            } finally {
              path.destroy();
            }
          },
          clipStrokePath(path, stroke) {
            path.destroy();
            stroke.destroy();
            clips.push(null);
          },
          clipText(text) {
            text.destroy();
            clips.push(null);
          },
          clipStrokeText(text, stroke) {
            text.destroy();
            stroke.destroy();
            clips.push(null);
          },
          clipImageMask(image, ctm) {
            clips.push({ mask: image, ctm: [...ctm] });
          },
          popClip() {
            if (clips.length) clips.pop()?.mask?.destroy();
            else failed = true;
          },
          fillImage(image, ctm, alpha) {
            try {
              const [a, b, c, d, e, f] = ctm;
              const bbox = [Math.min(e, e + a, e + c, e + a + c), Math.min(f, f + b, f + d, f + b + d), Math.max(e, e + a, e + c, e + a + c), Math.max(f, f + b, f + d, f + b + d)];
              if (!maskDepth) {
                const mask = image.getMask();
                let intrinsicMasks = 0;
                const clipOK = clips.every((clip) => {
                  if (clip?.mask) {
                    intrinsicMasks++;
                    return intrinsicMasks === 1 && mask && mask.pointer === clip.mask.pointer && clip.ctm.every((v, i) => Math.abs(v - ctm[i]) < 1e-5);
                  }
                  return clip && inside2(bbox, clip);
                });
                mask?.destroy();
                placements.push({ bbox, valid: ctm.every(Number.isFinite) && a > 0 && d > 0 && Math.abs(b) < 1e-5 && Math.abs(c) < 1e-5 && alpha === 1 && box3(bbox) && inside2(bbox, bounds) && clipOK, uncertainClip: !clipOK });
              }
            } finally {
              image.destroy();
            }
          },
          fillImageMask(image, ctm) {
            try {
              if (!maskDepth) {
                const [a, b, c, d, e, f] = ctm;
                placements.push({ bbox: [Math.min(e, e + a, e + c, e + a + c), Math.min(f, f + b, f + d, f + b + d), Math.max(e, e + a, e + c, e + a + c), Math.max(f, f + b, f + d, f + b + d)], valid: false });
              }
            } finally {
              image.destroy();
            }
          },
          beginMask(area3, luminosity, colorspace) {
            maskDepth++;
            colorspace?.destroy();
          },
          endMask() {
            if (maskDepth) {
              maskDepth--;
              clips.push(null);
            } else failed = true;
          }
        });
        page.run(dev, mupdf6.Matrix.identity);
        dev.close();
        pages.push({ bounds, placements, failed });
      } catch {
        pages.push({ bounds: null, placements: [], failed: true });
      } finally {
        for (const clip of clips) clip?.mask?.destroy();
        dev?.destroy();
        page.destroy();
      }
    }
    const claims = [];
    for (const item of items) {
      const id2 = idFor(item), ids = item.assetIds || [], ns = nominations.get(id2) || [], b = item.source?.bbox;
      let reason = null, candidates = [];
      if (!id2 || !Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !x) || new Set(ids).size !== ids.length || [id2, ...ids].some((x) => counts.get(x) !== 1)) reason = "unbound-or-duplicate-id";
      else if (ns.length !== 1) reason = "missing-or-duplicate-marker";
      else if (box3(b) && items.some((other) => other !== item && other.source?.pageIndex === item.source?.pageIndex && box3(other.source?.bbox) && overlaps3(b, other.source.bbox))) reason = "overlapping-source-assets";
      else {
        const { start: s, end: e, sourcePage } = ns[0];
        if (!s || !e || !Number.isInteger(item.source?.pageIndex) || sourcePage !== item.source.pageIndex || !Number.isInteger(s.page) || s.page !== e.page || s.page < 1 || s.page > pages.length || ![s.x, s.y, e.x, e.y].every(Number.isFinite) || e.y - s.y < 5 || Math.abs(e.x - s.x) > 1 || sourcePage != null && sourcePage !== item.source?.pageIndex) reason = "invalid-marker";
        else {
          const pg = pages[s.page - 1], height = e.y - s.y, tol = 1.5;
          if (pg.failed || !box3(pg.bounds) || !inside2([s.x, s.y, s.x + 1e-3, e.y], pg.bounds)) reason = "unavailable-page";
          else {
            const matching = pg.placements.filter((p) => Math.abs(p.bbox[0] - s.x) <= tol && Math.abs(p.bbox[1] - s.y) <= tol && Math.abs(p.bbox[3] - e.y) <= tol && Math.abs(p.bbox[3] - p.bbox[1] - height) <= 2 * tol && (!box3(b) || Math.abs(Math.log((p.bbox[2] - p.bbox[0]) / (p.bbox[3] - p.bbox[1]) / ((b[2] - b[0]) / (b[3] - b[1])))) <= 0.02));
            candidates = matching.filter((p) => p.valid);
            if (candidates.length !== 1) reason = candidates.length ? "ambiguous-placement" : matching.some((p) => p.uncertainClip) ? "masked-or-clipped-placement" : "no-matching-placement";
            else if (pg.placements.some((p) => p !== candidates[0] && box3(p.bbox) && overlaps3(p.bbox, candidates[0].bbox))) reason = "overlapping-placement";
            else claims.push({ id: id2, ids, pageIndex: s.page - 1, placement: candidates[0] });
          }
        }
      }
      evidence.push({ id: id2, reason: reason || "candidate", candidateCount: candidates.length });
    }
    for (const claim of claims) {
      const shared = claims.filter((c) => c.pageIndex === claim.pageIndex && c.placement === claim.placement).length > 1;
      const entry = evidence.find((e) => e.id === claim.id);
      if (shared) {
        entry.reason = "placement-claimed-more-than-once";
        continue;
      }
      entry.reason = "resolved";
      for (const id2 of /* @__PURE__ */ new Set([claim.id, ...claim.ids])) spans.push({ id: id2, pageIndex: claim.pageIndex, bbox: [...claim.placement.bbox] });
    }
  } catch {
    return { spans: [], evidence: [{ reason: "pdf-unavailable" }] };
  } finally {
    doc?.destroy();
  }
  return { spans, evidence };
}

// app/src/paper-recompose.mjs
init_paragraph_pdf_crypto();
var abort5 = (signal) => {
  if (signal?.aborted) throw new DOMException("Recomposition cancelled", "AbortError");
};
var fail2 = (code, message, details = {}) => {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  throw e;
};
var box4 = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
var overlaps4 = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
function pageStreams(document, flow, visibleWrap = false) {
  const lookup = new Map([...document.blocks, ...flow.fragments || []].map((b) => [b.id, b]));
  const streams = /* @__PURE__ */ new Map();
  for (const item of flow.items) {
    if (item.kind === "asset") continue;
    const blocks = (item.blockIds || []).map((id2) => lookup.get(id2)).filter((b) => b?.text);
    for (const [index, b] of blocks.entries()) {
      const p = b.source.pageIndex, s = streams.get(p) || { chars: [] };
      streams.set(p, s);
      if (s.chars.length) {
        const sep = index && item.inline ? item.joiners[index - 1] : " ";
        for (const ch of sep) s.chars.push({ ch, source: null });
      }
      const boundaries = new Set((b.source.lines || []).slice(1).map((l) => l.range.start - b.source.range.start));
      const spaces = new Set(b.source.wordSpaceOffsets || []);
      for (let i = 0; i < b.text.length; i++) {
        if (boundaries.has(i) && i > 0 && !/\s/u.test(b.text[i - 1]) && !/\s/u.test(b.text[i]) && (visibleWrap || b.text[i - 1] !== "-") && !(b.text[i - 1] === "\u2212" && /[0-9]/u.test(b.text[i]))) s.chars.push({ ch: " ", source: null });
        const offset = b.source.range.start + i;
        const parent = lookup.get(b.parentBlockId || b.id), parentIndex = offset - (parent?.source?.range?.start ?? offset);
        if (spaces.has(offset) && parentIndex > 0 && !/\s/u.test(parent.text[parentIndex - 1]) && !/\s/u.test(b.text[i])) s.chars.push({ ch: " ", source: null });
        const character = (b.source.characters || []).find((c) => c.start <= offset && c.end > offset);
        s.chars.push({ ch: b.text[i], source: { blockId: b.parentBlockId || b.id, start: offset, end: offset + 1, bbox: character?.bbox || null, fragmentId: b.id } });
      }
    }
  }
  for (const s of streams.values()) {
    s.text = "";
    s.map = [];
    for (const entry of s.chars) {
      if (/\s/u.test(entry.ch)) {
        if (s.text.endsWith(" ")) {
          s.map.at(-1).push(entry.source);
          continue;
        }
        s.text += " ";
        s.map.push([entry.source]);
      } else {
        s.text += entry.ch;
        s.map.push([entry.source]);
      }
    }
  }
  return streams;
}
function explicitParts(document, flow, edit, selection, index) {
  const bad = (message, code = "INVALID_EXPLICIT") => fail2("source-binding", message, { index, id: edit.id, code });
  if (typeof selection.sourceSha256 !== "string" || selection.sourceSha256 !== document.sourceSha256) fail2("stale-source", "Explicit selection source hash mismatch.", { index, id: edit.id });
  if (!Array.isArray(selection.parts) || !selection.parts.length) bad("Explicit selection requires parts.");
  const blocks = new Map(document.blocks.map((b) => [b.id, b]));
  const lookup = new Map([...document.blocks, ...flow.fragments || []].map((b) => [b.id, b]));
  const units = [], assetRanges = [];
  for (const item of flow.items) {
    if (item.kind === "asset") {
      for (const id2 of item.blockIds || []) {
        const b = lookup.get(id2);
        if (b?.source?.range) assetRanges.push({ blockId: b.parentBlockId || b.id, ...b.source.range });
      }
      units.push(null);
      continue;
    }
    for (const id2 of item.blockIds || []) {
      const b = lookup.get(id2);
      if (!b?.text || !b.source?.range) continue;
      for (let offset = b.source.range.start; offset < b.source.range.end; offset++) units.push({ blockId: b.parentBlockId || b.id, pageIndex: b.source.pageIndex, offset });
    }
  }
  const parts = selection.parts.map((p) => {
    const b = blocks.get(p?.blockId), r = b?.source?.range;
    if (!b || !r || p.pageIndex !== edit.pageIndex || b.source.pageIndex !== p.pageIndex || !Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start < r.start || p.end > r.end || p.start >= p.end || typeof p.before !== "string" || b.text.slice(p.start - r.start, p.end - r.start) !== p.before) bad("Explicit part does not match its native source.");
    const splitsScalar = (offset) => offset > 0 && offset < b.text.length && /[\uD800-\uDBFF]/u.test(b.text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(b.text[offset]);
    if (splitsScalar(p.start - r.start) || splitsScalar(p.end - r.start)) bad("Explicit part splits a Unicode scalar.");
    if (assetRanges.some((a) => a.blockId === p.blockId && p.start < a.end && p.end > a.start)) bad("Explicit selection includes asset-owned text.");
    return { blockId: p.blockId, pageIndex: p.pageIndex, start: p.start, end: p.end, before: p.before };
  });
  const selected = parts.flatMap((p) => Array.from({ length: p.end - p.start }, (_, i) => ({ blockId: p.blockId, pageIndex: p.pageIndex, offset: p.start + i })));
  const same2 = (a, b) => a && a.blockId === b.blockId && a.pageIndex === b.pageIndex && a.offset === b.offset;
  const counts = /* @__PURE__ */ new Map();
  for (const u of units) if (u) {
    const key = JSON.stringify([u.blockId, u.pageIndex, u.offset]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (selected.some((u) => counts.get(JSON.stringify([u.blockId, u.pageIndex, u.offset])) !== 1)) bad("Explicit source units must have unique flow ownership.", "AMBIGUOUS_EXPLICIT");
  let hits = 0;
  for (let i = 0; i <= units.length - selected.length; i++) if (selected.every((u, j) => same2(units[i + j], u))) hits++;
  if (hits !== 1) bad("Explicit parts must select one contiguous, uniquely owned text range in flow order.", hits ? "AMBIGUOUS_EXPLICIT" : "INVALID_EXPLICIT");
  return parts;
}
function bindEdits(document, flow, edits, explicit = []) {
  const streams = pageStreams(document, flow), wrapped = pageStreams(document, flow, true), blocks = new Map(document.blocks.map((b) => [b.id, b]));
  const bindings = [], changes = [], used = /* @__PURE__ */ new Map(), selections = /* @__PURE__ */ new Map(), ids = /* @__PURE__ */ new Map();
  for (const [index, e] of edits.entries()) if (e?.id != null) {
    if (typeof e.id !== "string" || !e.id || ids.has(e.id)) fail2("invalid-edit", "Edit IDs must be unique nonempty strings.", { index, id: e.id });
    ids.set(e.id, index);
  }
  if (!Array.isArray(explicit)) fail2("source-binding", "Explicit bindings must be an array.", { code: "INVALID_EXPLICIT" });
  for (const selection of explicit) {
    if (!selection || selection.id == null && selection.index == null) fail2("source-binding", "Explicit binding requires an edit id or index.", { code: "INVALID_EXPLICIT" });
    const byId = selection.id == null ? null : ids.get(selection.id), byIndex = selection.index == null ? null : selection.index;
    if (selection.id != null && byId === void 0 || byIndex != null && (!Number.isInteger(byIndex) || byIndex < 0 || byIndex >= edits.length) || byId != null && byIndex != null && byId !== byIndex) fail2("source-binding", "Explicit binding identifies an unknown or inconsistent edit.", { code: "INVALID_EXPLICIT" });
    const target = byId ?? byIndex;
    if (selections.has(target)) fail2("source-binding", "Duplicate explicit binding.", { index: target, code: "INVALID_EXPLICIT" });
    selections.set(target, selection);
  }
  for (const [index, e] of edits.entries()) {
    if (e?.enabled === false) continue;
    if (!Number.isInteger(e.pageIndex) || typeof e.before !== "string" || !e.before.trim() || typeof e.after !== "string") fail2("invalid-edit", "Edit requires pageIndex, Before and After.", { index, id: e.id });
    const selection = selections.get(index);
    let parts;
    if (selection) parts = explicitParts(document, flow, e, selection, index);
    else {
      const needle = e.before.replace(/\s+/gu, " "), hits = [];
      const variants = /-[^\S\r\n]*[\r\n]/u.test(e.before) ? [streams, wrapped] : [streams];
      for (const variant of variants) {
        const stream = variant.get(e.pageIndex);
        if (stream) for (let at = stream.text.indexOf(needle); at >= 0; at = stream.text.indexOf(needle, at + 1)) {
          const refs = [];
          for (let pos = at; pos < at + needle.length; pos++) {
            refs.push(...stream.map[pos]);
          }
          const selected = refs.filter(Boolean);
          refs.splice(0, refs.length, ...selected);
          if (!refs.length) continue;
          const segmentKnown = blocks.has(e.segmentId) || (flow.fragments || []).some((f) => f.id === e.segmentId);
          if (segmentKnown && !refs.some((r) => r.blockId === e.segmentId || r.fragmentId === e.segmentId)) continue;
          const geometry = e.anchor?.bbox;
          if (box4(geometry) && !refs.some((r) => box4(r.bbox) && overlaps4(geometry, r.bbox))) continue;
          if (!hits.some((hit) => JSON.stringify(hit.map((r) => [r.blockId, r.start, r.end])) === JSON.stringify(refs.map((r) => [r.blockId, r.start, r.end])))) hits.push(refs);
        }
      }
      if (hits.length !== 1) fail2("source-binding", hits.length ? "Source quote is ambiguous." : "Source quote was not found.", { index, id: e.id, pageIndex: e.pageIndex, code: hits.length ? "AMBIGUOUS_MATCH" : "NO_MATCH", hits: hits.length });
      parts = [];
      for (const r of hits[0]) {
        const last = parts.at(-1);
        if (last && last.blockId === r.blockId && last.end === r.start) last.end = r.end;
        else if (!last || last.blockId !== r.blockId || last.end !== r.end) parts.push({ blockId: r.blockId, pageIndex: e.pageIndex, start: r.start, end: r.end });
      }
    }
    for (const [i, p] of parts.entries()) {
      const b = blocks.get(p.blockId);
      if (!b || !b.source.range) fail2("source-binding", "Source block is unavailable.", { index, id: e.id });
      const before = b.text.slice(p.start - b.source.range.start, p.end - b.source.range.start);
      if (!before || before.length !== p.end - p.start) fail2("source-binding", "Source range is invalid.", { index, id: e.id });
      const prior = used.get(p.blockId) || [];
      if (prior.some((x) => p.start < x.end && p.end > x.start)) fail2("source-binding", "Selected edits overlap.", { index, id: e.id, code: "OVERLAP" });
      prior.push(p);
      used.set(p.blockId, prior);
      p.before = before;
      changes.push({ ...p, after: i === 0 ? e.after : "" });
    }
    bindings.push({ id: e.id || `edit-${index}`, matchMethod: selection ? "explicit-source" : "quote", pageIndex: e.pageIndex, segmentId: e.segmentId ?? null, before: e.before, after: e.after, request: structuredClone(e), sourceBefore: parts.map((p) => p.before).join(""), parts });
  }
  return { bindings, changes };
}
var issueCounts = (result) => {
  const counts = {};
  for (const issue of result.verification.checkReport?.layoutQuality?.issues || []) counts[issue.type] = (counts[issue.type] || 0) + 1;
  for (const finding of result.verification.checkReport?.findings || []) if (finding.code === "text-outside-page") counts[finding.code] = (counts[finding.code] || 0) + 1;
  return counts;
};
var attemptSummary = (result) => ({ placement: result.enginePlan.figurePlacement, content: result.verification.outputTextCheck, layout: result.verification.checkReport?.layoutQuality?.status || "unavailable", issues: issueCounts(result) });
function repairIsBetter(first, candidate) {
  const a = first.verification, b = candidate.verification, report = b.checkReport;
  if (!["pass", "normalized"].includes(b.outputTextCheck) || report?.readable !== true || report.checks?.independent?.status !== "declared") return false;
  if (b.coverage?.status !== "covered" || b.sourceGlyphs?.unavailable?.length || b.assetFindings?.length) return false;
  if (report.checks?.furniture?.status === "finding" || b.furniture?.templates?.length && report.checks?.furniture?.status !== "checked") return false;
  if (candidate.warnings.some((w) => w.startsWith("Source assets and non-text"))) return false;
  if (report.checks?.bounds?.status !== "checked" || report.layoutQuality?.status === "unavailable" || !report.layoutQuality) return false;
  const before = issueCounts(first), after = issueCounts(candidate);
  if (Object.keys(after).some((type) => after[type] > (before[type] || 0))) return false;
  return !["pass", "normalized"].includes(a.outputTextCheck) || Object.keys(before).some((type) => (after[type] || 0) < before[type]);
}
async function prepare(request = {}, options = {}) {
  const signal = request.signal;
  abort5(signal);
  const layoutMode = request.layoutMode;
  if (layoutMode !== void 0 && layoutMode !== "measured-continuous") fail2("invalid", "Unknown layout mode");
  const candidates = (options.fonts || []).map((f) => ({ ...f, bytes: f.bytes instanceof Uint8Array ? Uint8Array.from(f.bytes) : f.bytes instanceof ArrayBuffer ? f.bytes.slice(0) : f.bytes }));
  const snapshot = Array.isArray(request.edits) ? { edits: request.edits } : request.edits;
  if (!snapshot || !Array.isArray(snapshot.edits) || snapshot.schema && snapshot.schema !== "falsify.paper-edits.v1") fail2("invalid", "Expected edit array or paper edit snapshot.");
  const edits = structuredClone(snapshot.edits), explicit = structuredClone(request.bindings ?? []), revision = snapshot.revision ?? request.revision ?? null;
  const hash2 = request.fileHash || snapshot.fileHash;
  if (request.fileHash && snapshot.fileHash && request.fileHash.toLowerCase() !== snapshot.fileHash.toLowerCase()) fail2("stale-source", "Request and snapshot hashes differ.");
  const input = request.file;
  const bytes = input instanceof Uint8Array ? Uint8Array.from(input) : input?.bytes instanceof Uint8Array ? Uint8Array.from(input.bytes) : typeof input?.arrayBuffer === "function" ? new Uint8Array(await input.arrayBuffer()).slice() : null;
  abort5(signal);
  if (!bytes?.length) fail2("invalid", "Source PDF is required.");
  const observed = await readDocument({ file: bytes, fileHash: hash2, signal });
  abort5(signal);
  const spacing = await recoverSourceSpaces({ bytes, document: observed, pdfjs: options.pdfjs, signal });
  const document = spacing.document;
  abort5(signal);
  const inventory = await readSourceAssets({ bytes, document, signal });
  abort5(signal);
  const links = await readSourceLinks({ bytes, document, signal });
  abort5(signal);
  const flow = buildPaperFlow(document, { drawings: inventory.drawings, links });
  const { bindings, changes } = bindEdits(document, flow, edits, explicit);
  const regions = (flow.regions || []).map((r) => structuredClone(r));
  const ids = new Set(regions.map((r) => r.id));
  for (const item of flow.items.filter((i) => i.kind === "asset" && !i.renderAssetId)) {
    const p = document.pages[item.source.pageIndex], b = item.source.bbox;
    if (!p || !box4(b)) continue;
    const clipped = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(p.width, b[2]), Math.min(p.height, b[3])];
    if (!box4(clipped)) continue;
    const id2 = `capture-${item.id}`;
    if (ids.has(id2)) fail2("invalid", "Duplicate capture ID.");
    ids.add(id2);
    item.source.bbox = clipped;
    item.renderAssetId = id2;
    regions.push({ id: id2, pageIndex: item.source.pageIndex, bbox: clipped, blockIds: [...item.blockIds || []], assetIds: [...item.assetIds || []] });
  }
  const captured = await readSourceAssets({ bytes, document: { ...document, blocks: [...document.blocks, ...flow.fragments || []] }, regions, signal });
  abort5(signal);
  const fontPlan = await createFontPlan({ text: document.blocks.map((b) => b.text || "").join("\n") + edits.filter((e) => e?.enabled !== false).map((e) => e.after).join("\n"), fonts: candidates }, { mupdf: options.mupdf });
  abort5(signal);
  const composeOptions = { compile: options.compile, fonts: fontPlan, outputCheck: async (args) => {
    if (!options.pdfjs?.getDocument || !options.mupdf?.Document) return checkRecomposition({ ...args, pdfjs: options.pdfjs, mupdf: options.mupdf, exporter: "Typst" });
    const outputFlow = args.flow || flow;
    const assets = resolveOutputAssetSpans({ bytes: args.bytes, mupdf: options.mupdf, flow: outputFlow, blockSpans: args.blockSpans });
    const { profile, evidence } = buildOutputProfile({ bytes: args.bytes, mupdf: options.mupdf, document: args.document || { ...document, blocks: [...document.blocks, ...flow.fragments || []] }, flow: outputFlow, expectedBlocks: args.expectedBlocks, fontPlan, assetSpans: assets.spans });
    const floatingCaptionBlockIds = profile.captions.map((c) => c.id);
    const flowExpectations = layoutMode === "measured-continuous" && floatingCaptionBlockIds.length ? { floatingCaptionBlockIds } : void 0;
    const report = await checkRecomposition({ ...args, flowExpectations, layoutProfile: { ...args.layoutProfile, ...profile }, pdfjs: options.pdfjs, mupdf: options.mupdf, exporter: "Typst" });
    return { ...report, outputProfileEvidence: { ...evidence, assets: assets.evidence } };
  } };
  const compose = (figurePlacement) => composeDocument({ document, sourceBytes: bytes, flow, assets: captured, links, edits: changes, signal, runningFurniture: options.runningFurniture === true, layoutMode, figurePlacement }, composeOptions);
  const first = await compose("float");
  abort5(signal);
  let result = first, attempts = [attemptSummary(first)], selectedAttempt = 1;
  if (first.enginePlan.actual === "measured-continuous" && (!["pass", "normalized"].includes(first.verification.outputTextCheck) || Object.keys(issueCounts(first)).length)) {
    try {
      const second = await compose("page");
      abort5(signal);
      attempts.push(attemptSummary(second));
      if (repairIsBetter(first, second)) {
        result = second;
        selectedAttempt = 2;
      }
    } catch (error2) {
      abort5(signal);
      if (error2?.name === "AbortError") throw error2;
      attempts.push({ placement: "page", status: "failed" });
    }
  }
  const actual = new Uint8Array(await result.file.arrayBuffer());
  abort5(signal);
  if (hex(actual) !== result.sha256) fail2("output-hash", "Output bytes do not match their hash.");
  return { ...result, repair: { attempts, selectedAttempt }, revision, bindings, sourceLinks: links, sourceBinding: { spacing: spacing.evidence, sourceSha256: document.sourceSha256, editCount: bindings.length, partCount: changes.length }, sourceAssets: { regions: regions.length, diagnostics: captured.diagnostics } };
}

// app/src/paper-typst.mjs
function createTypstCompile({ createTypstCompiler, createTypstFontBuilder, loadFonts, getModule, getWrapper }) {
  return async ({ source, files = {}, fonts = {}, signal }) => {
    const abort6 = () => {
      if (signal?.aborted) throw new DOMException("Composition cancelled", "AbortError");
    };
    const options = { getModule, getWrapper }, compiler = createTypstCompiler(), builder = createTypstFontBuilder();
    let resolver, world;
    try {
      abort6();
      await compiler.init({ ...options, beforeBuild: [loadFonts([], { assets: false })] });
      abort6();
      await builder.init(options);
      abort6();
      for (const candidate of fonts.candidates || []) {
        const bytes2 = candidate.getBytes?.();
        if (bytes2) await builder.addFontData(bytes2);
      }
      const rawBuilder = builder.fontBuilder;
      builder.fontBuilder = null;
      resolver = await rawBuilder.build();
      abort6();
      compiler.setFonts(resolver);
      compiler.addSource("/main.typ", source);
      for (const [path, bytes2] of Object.entries(files)) compiler.mapShadow("/" + path, bytes2);
      world = compiler.compiler.snapshot(void 0, "/main.typ", void 0);
      const result = world.get_artifact(1, 3);
      abort6();
      const bytes = result instanceof Uint8Array ? result : result?.result;
      if (!(bytes instanceof Uint8Array)) throw new Error("Typst PDF compilation failed: " + JSON.stringify(result));
      let blockMap = null, blockEnds = null, blockSpans = null, furnitureMap = null, furnitureLayout = null, queryError = null;
      try {
        blockMap = JSON.parse(world.query(0, "<paper-block>", "value"));
      } catch (error2) {
        queryError = String(error2?.message || error2);
      }
      try {
        blockEnds = JSON.parse(world.query(0, "<paper-block-end>", "value"));
      } catch (error2) {
        queryError ||= String(error2?.message || error2);
      }
      if (Array.isArray(blockMap) && Array.isArray(blockEnds)) blockSpans = blockMap.map((start) => {
        const end = blockEnds.find((x) => x.id === start.id);
        return { id: start.id, sourcePage: start.sourcePage, start, end: end || null };
      });
      try {
        furnitureMap = JSON.parse(world.query(0, "<paper-furniture>", "value"));
      } catch (error2) {
        queryError ||= String(error2?.message || error2);
      }
      try {
        furnitureLayout = JSON.parse(world.query(0, "<paper-furniture-layout>", "value"));
      } catch (error2) {
        queryError ||= String(error2?.message || error2);
      }
      return { bytes, blockMap, blockSpans, furnitureMap, furnitureLayout, queryError };
    } finally {
      world?.free();
      try {
        compiler.resetShadow?.();
      } finally {
        compiler.compiler?.free();
        resolver?.free();
        builder.fontBuilder?.free();
      }
    }
  };
}

// app/src/paper-recompose-worker.mjs
init_paragraph_pdf_crypto();
import * as mupdf5 from "./browser-pdf-vendor/mupdf.js";
var fail3 = (code, message) => {
  const e = new Error(message);
  e.code = code;
  throw e;
};
var digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
var hashOK = (x) => typeof x === "string" && /^[a-f0-9]{64}$/i.test(x);
function resolveAsset(path, manifestURL) {
  if (typeof path !== "string" || !path || path.includes("\\") || /%2f|%5c|%2e/i.test(path)) fail3("asset-path", "Invalid bundled asset path");
  const base = new URL(".", manifestURL), url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash || url.username || url.password) fail3("asset-path", "Asset escapes the bundled vendor directory");
  return url.href;
}
async function loadAssets(manifestURL, fetcher = fetch) {
  const manifest = new URL(manifestURL), base = new URL("../", manifest);
  const response = await fetcher(manifest.href, { credentials: "omit", redirect: "error" });
  if (!response.ok) fail3("asset-load", "Cannot load recomposition manifest");
  const m = await response.json();
  if (m?.version !== "falsify.recomposition-runtime.v1" || m.compilerModule !== "../recomposition-typst.mjs" || !m.wasm || !Array.isArray(m.fonts)) fail3("asset-manifest", "Invalid recomposition manifest");
  const ids = /* @__PURE__ */ new Set();
  async function asset(x) {
    if (!hashOK(x?.sha256)) fail3("asset-manifest", "Invalid asset hash");
    const url = resolveAsset(x.url, manifest.href), r = await fetcher(url, { credentials: "omit", redirect: "error" });
    if (!r.ok) fail3("asset-load", "Cannot load bundled asset");
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (await digest(bytes) !== x.sha256.toLowerCase()) fail3("asset-hash", "Bundled asset hash mismatch");
    return bytes;
  }
  const wasm = await asset(m.wasm), fonts = [];
  for (const f of m.fonts) {
    if (typeof f.id !== "string" || !f.id || ids.has(f.id) || typeof f.family !== "string" || !f.family) fail3("asset-manifest", "Invalid font descriptor");
    ids.add(f.id);
    fonts.push({ id: f.id, family: f.family, bytes: await asset(f) });
  }
  return { wasm, fonts, compilerURL: new URL("recomposition-typst.mjs", base).href };
}
function remapBindings(original, prepared, selections) {
  const bad = () => fail3("source-binding", "Cannot map the original selection exactly after footer cleanup");
  if (original.pages.length !== prepared.pages.length) bad();
  const out = [];
  for (const selection of selections) {
    const parts = [];
    for (const p of selection.parts || []) {
      const ob = original.blocks.find((b) => b.id === p.blockId), op = original.pages[p.pageIndex], np = prepared.pages[p.pageIndex];
      if (!ob || !op || !np || JSON.stringify([op.width, op.height, op.geometry]) !== JSON.stringify([np.width, np.height, np.geometry]) || ob.source.pageIndex !== p.pageIndex || ob.text.slice(p.start - ob.source.range.start, p.end - ob.source.range.start) !== p.before) bad();
      const selected = ob.source.characters.filter((c) => c.start >= p.start && c.end <= p.end);
      if (!selected.length || selected[0].start !== p.start || selected.at(-1).end !== p.end || selected.some((c, i) => i && selected[i - 1].end !== c.start)) bad();
      for (const c of selected) {
        const scalar = ob.text.slice(c.start - ob.source.range.start, c.end - ob.source.range.start);
        if ([...scalar].length !== 1 || !Array.isArray(c.bbox) || c.bbox.length !== 4 || !c.bbox.every(Number.isFinite)) bad();
        const matching = (doc) => doc.blocks.filter((b2) => b2.text && b2.source.pageIndex === p.pageIndex).flatMap((b2) => (b2.source.characters || []).filter((x2) => JSON.stringify(x2.bbox) === JSON.stringify(c.bbox) && b2.text.slice(x2.start - b2.source.range.start, x2.end - b2.source.range.start) === scalar).map((x2) => ({ b: b2, x: x2 })));
        if (matching(original).length !== 1) bad();
        const hits = matching(prepared);
        if (hits.length !== 1) bad();
        const { b, x } = hits[0], last = parts.at(-1);
        if (last && last.blockId === b.id && last.end === x.start) {
          last.end = x.end;
          last.before += scalar;
        } else parts.push({ blockId: b.id, pageIndex: p.pageIndex, start: x.start, end: x.end, before: scalar });
      }
    }
    if (!parts.length) bad();
    out.push({ ...selection, sourceSha256: prepared.sourceSha256, parts });
  }
  return out;
}
async function runRequest(request, deps = {}) {
  const layoutMode = request.layoutMode;
  if (layoutMode !== void 0 && layoutMode !== "measured-continuous") fail3("invalid", "Unknown layout mode");
  const input = request.file instanceof Uint8Array ? request.file : request.file instanceof ArrayBuffer ? new Uint8Array(request.file) : request.file?.bytes instanceof Uint8Array ? request.file.bytes : new Uint8Array(await request.file.arrayBuffer());
  const original = Uint8Array.from(input), originalHash = await digest(original);
  const snapshot = Array.isArray(request.edits) ? { edits: request.edits } : structuredClone(request.edits);
  if (!snapshot || !Array.isArray(snapshot.edits)) fail3("invalid", "Expected edits");
  if (request.fileHash == null && snapshot.fileHash == null) fail3("stale-source", "Original source hash is required");
  for (const h of [request.fileHash, snapshot.fileHash].filter((x) => x !== void 0 && x !== null)) if (!hashOK(h) || h.toLowerCase() !== originalHash) fail3("stale-source", "Original source hash mismatch");
  const clean = deps.clean || (await import("./blind-pdf.mjs")).prepare;
  const cleaned = await clean({ file: { bytes: original.slice() } }), bytes = cleaned.file?.bytes instanceof Uint8Array ? Uint8Array.from(cleaned.file.bytes) : new Uint8Array(await cleaned.file.arrayBuffer()), preparedHash = await digest(bytes);
  if (cleaned.sha256 !== preparedHash) fail3("source-binding", "Cleaned source hash mismatch");
  let bindings = structuredClone(request.bindings || []);
  let pdfjs = deps.pdfjs;
  if (cleaned.changed) {
    const read = deps.readDocument || readDocument;
    const old = await read({ file: original, fileHash: originalHash }), now = await read({ file: bytes, fileHash: preparedHash });
    const originalBindings = bindings.filter((b) => b.sourceSha256 === originalHash), cleanedBindings = bindings.filter((b) => b.sourceSha256 === preparedHash);
    if (originalBindings.length + cleanedBindings.length !== bindings.length) fail3("stale-source", "Explicit selection source hash mismatch");
    const covered = new Set(bindings.map((b) => b.id != null ? `id:${b.id}` : `index:${b.index}`));
    const unbound = snapshot.edits.map((e, i) => ({ e, i })).filter(({ e, i }) => e.enabled !== false && !covered.has(`id:${e.id}`) && !covered.has(`index:${i}`));
    if (unbound.length) {
      pdfjs ||= await import(new URL("./vendor/pdf.mjs", import.meta.url).href);
      if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;
      const spaced = await recoverSourceSpaces({ bytes: original, document: old, pdfjs });
      const resolved = bindEdits(spaced.document, buildPaperFlow(spaced.document), unbound.map((x) => x.e));
      for (const [j, b] of resolved.bindings.entries()) originalBindings.push({ index: unbound[j].i, sourceSha256: originalHash, parts: b.parts });
    }
    bindings = [...cleanedBindings, ...remapBindings(old, now, originalBindings)];
  }
  const assets = deps.assets || await loadAssets(new URL("./recomposition-vendor/manifest.json", import.meta.url).href);
  const facade = deps.facade || await import(assets.compilerURL);
  const module = deps.compile ? null : await WebAssembly.compile(assets.wasm);
  const compile = deps.compile || createTypstCompile({ ...facade, getModule: () => module });
  pdfjs ||= await import(new URL("./vendor/pdf.mjs", import.meta.url).href);
  if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;
  const result = await (deps.recompose || prepare)({ file: bytes, fileHash: preparedHash, edits: { ...snapshot, fileHash: preparedHash, revision: request.revision }, bindings, revision: request.revision, layoutMode }, { compile, fonts: assets.fonts, mupdf: mupdf5, pdfjs, runningFurniture: true });
  return { ...result, sourceBinding: { ...result.sourceBinding, originalSha256: originalHash, preparedSha256: preparedHash, cleanup: cleaned.verification } };
}
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = async ({ data }) => {
    if (data?.type !== "prepare" || !Number.isSafeInteger(data.id)) return;
    try {
      const result = await runRequest(data.request);
      globalThis.postMessage({ id: data.id, type: "result", result });
    } catch (e) {
      globalThis.postMessage({ id: data.id, type: "error", error: { message: String(e?.message || e), code: e?.code, details: e?.details } });
    }
  };
}
export {
  loadAssets,
  remapBindings,
  resolveAsset,
  runRequest
};
