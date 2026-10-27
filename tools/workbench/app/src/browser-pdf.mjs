/* Browser PDF content edit. MuPDF.js (AGPL-3.0-or-later) removes matched glyphs
 * with redaction (text only; images and line art stay) and appends a real text
 * showing operator. Not a white overlay, annotation, or full-page raster.
 * Vendor notices: dist/browser-pdf-vendor/NOTICE.md
 */
import * as mupdf from 'mupdf';
import {parseFont, familyKey} from './browser-fonts.mjs';

export const ENGINE = Object.freeze({
  name: 'mupdf.js',
  version: '1.28.1',
  license: 'AGPL-3.0-or-later',
  redaction: 'pdf-redact-text-remove-image-none-line-art-none',
});

/* Public anchors use one space only: the top-left of the page view, y down,
 * in points, plus that view's width, height, and /Rotate. PDF user space
 * (bottom-left, y up) is never accepted as an anchor. */
export const COORDINATE_SPACE = 'top-left-page';
export const COORDINATES = Object.freeze({
  space: COORDINATE_SPACE,
  origin: 'top-left',
  yAxis: 'down',
  unit: 'pt',
});

export const LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxPages: 200,
  maxEdits: 24,
  maxChars: 4000,
  maxWrapLines: 8,
});

const SCHEMA = 'falsify.browser-pdf.v1';
const BASE14 = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
];
const FACE_ALIAS = {
  ArialMT: 'Helvetica', Arial: 'Helvetica', 'Arial-BoldMT': 'Helvetica-Bold',
  TimesNewRomanPSMT: 'Times-Roman', 'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic', CourierNewPSMT: 'Courier',
};
/* Windows-1252 bytes that are not Latin-1. */
const WINANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

const fonts = new Map();
let queue = Promise.resolve();

export class BrowserPdfError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserPdfError';
    this.code = code;
    this.details = details;
  }
}

function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function aborted() {
  return new BrowserPdfError('aborted', '편집이 취소되었습니다. PDF는 만들지 않았습니다.');
}

function checkAbort(signal) {
  if (signal?.aborted) throw aborted();
}

export async function prepare(request) {
  request ||= {};
  const snapshot = captureFontSnapshot(request.fontSnapshot);
  return exclusive(() => prepareExclusive({...request, fontSnapshot: snapshot}));
}

async function prepareExclusive(request) {
  checkAbort(request.signal);
  const parsed = parseRequest(request);
  const snapshot = await validateFontSnapshot(request.fontSnapshot);
  checkAbort(request.signal);
  const bytes = await readBytes(parsed.file);
  checkAbort(request.signal);
  const sourceSha256 = await sha256(bytes);
  if (parsed.fileHash && parsed.fileHash !== sourceSha256) {
    throw new BrowserPdfError('stale-source', '원본 PDF 해시가 편집 세션과 다릅니다. 파일을 다시 연 뒤 적용하세요. 출력은 만들지 않았습니다.', {
      sourceSha256, expectedSha256: parsed.fileHash,
    });
  }
  const enabled = parsed.edits.filter(edit => edit.enabled !== false);
  if (!enabled.length) throw new BrowserPdfError('no-edits', '적용할 편집이 없습니다. 원본을 변경된 파일로 반환하지 않습니다.');
  if (enabled.length > LIMITS.maxEdits) throw new BrowserPdfError('limit', `편집은 한 번에 ${LIMITS.maxEdits}개까지입니다.`);

  let doc;
  try {
    doc = openPdf(bytes);
    checkAbort(request.signal);
    const pageCount = doc.countPages();
    if (pageCount < 1 || pageCount > LIMITS.maxPages) throw new BrowserPdfError('limit', `페이지 수는 1..${LIMITS.maxPages}만 지원합니다.`);
    const models = [];
    for (let i = 0; i < pageCount; i++) {
      checkAbort(request.signal);
      models.push(readPage(doc.loadPage(i)));
    }
    const plans = [];
    const failures = [];
    enabled.forEach((edit, index) => {
      const result = locate(edit, index, models, pageCount, snapshot);
      if (result.ok) plans.push(result.plan);
      else failures.push(result.failure);
    });
    const overlaps = overlapping(plans);
    if (overlaps.length) failures.push(...overlaps);
    if (failures.length) throw unsupported(failures, models);
    checkAbort(request.signal);

    const warnings = [];
    const byPage = new Map();
    for (const plan of plans) {
      const laid = layout(plan, models[plan.pageIndex], doc.loadPage(plan.pageIndex));
      if (laid.error) failures.push(failure(plan.edit, plan.pageIndex, laid.error));
      else {
        plan.layout = laid;
        if (plan.anchorApproximate) warnings.push(warn('selection-font-metrics', 'warning', plan.pageIndex, plan.edit.id));
        if (laid.substituted) warnings.push(warn('font-substituted', 'warning', plan.pageIndex, plan.edit.id));
        if (laid.lines.length > 1) warnings.push(warn('wrapped-after', 'info', plan.pageIndex, plan.edit.id));
        if (plan.partialLine) warnings.push(warn('extraction-gap', 'info', plan.pageIndex, plan.edit.id));
        const list = byPage.get(plan.pageIndex) || [];
        list.push(plan);
        byPage.set(plan.pageIndex, list);
      }
    }
    if (failures.length) throw unsupported(failures, models);

    for (const [pageIndex, group] of byPage) {
      checkAbort(request.signal);
      const turned = group.filter(plan => plan.rotation !== 0);
      if (turned.length) throw unsupported(turned.map(plan => failure(plan.edit, plan.pageIndex, 'rotated-page')), models);
      const page = doc.loadPage(pageIndex);
      const selected = new Set(group.flatMap(plan => plan.chars));
      const protectedBoxes = removalBoxes(models[pageIndex].chars.filter(ch => !selected.has(ch)));
      for (const plan of group) redact(page, plan.chars, protectedBoxes);
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      const piece = group.map(plan => showText(doc, page, plan)).join('');
      if (piece) appendStream(doc, page, piece);
    }
    checkAbort(request.signal);
    const saved = doc.saveToBuffer('garbage=compact');
    const out = new Uint8Array(saved.asUint8Array());
    doc.destroy();
    doc = null;
    checkAbort(request.signal);
    if (out.length < 5 || String.fromCharCode(...out.slice(0, 5)) !== '%PDF-') {
      throw new BrowserPdfError('verification-failed', '저장된 출력이 PDF가 아닙니다. 파일을 반환하지 않습니다.');
    }
    const outputSha256 = await sha256(out);
    const quality = verify(bytes, out, plans, models, outputSha256 === sourceSha256);
    warnings.push(...quality.warnings);
    const checks = quality.checks;
    const status = checks.length ? 'failed' : warnings.some(item => item.severity === 'warning') ? 'warning' : 'applied';
    const file = new File([out], editedName(parsed.name), {type: 'application/pdf'});
    const pageMap = models.map((model, index) => pageMapEntry(model, index));
    const verification = {
      schema: SCHEMA,
      engine: ENGINE.name,
      engineVersion: ENGINE.version,
      license: ENGINE.license,
      redaction: ENGINE.redaction,
      coordinateSpace: COORDINATE_SPACE,
      sourceSha256,
      outputSha256,
      status,
      layoutVerified: status === 'applied',
      independent: false,
      pageCount: {source: pageCount, output: pageCount},
      pages: models.map((model, index) => verificationPage(model, index)),
      edits: plans.map(plan => {
        const editChecks = checks.filter(item => item.id === plan.edit.id);
        return {
          id: plan.edit.id,
          pageIndex: plan.pageIndex,
          status: editChecks.length ? 'failed' : 'applied',
          font: plan.layout.font,
          sourceFont: plan.sourceFont,
          fontSubstituted: plan.layout.substituted,
          encoding: plan.layout.encoding,
          size: plan.size,
          color: plan.color,
          wrappedLines: plan.layout.lines.length,
          checks: editChecks,
        };
      }),
      checks,
      quality: {
        independent: false,
        method: 'mupdf.js structured text, same engine',
        removedBefore: !checks.some(item => item.code === 'removed-before'),
        presentAfter: !checks.some(item => item.code === 'present-after'),
        untouchedText: !checks.some(item => item.code === 'untouched-text'),
        figures: !checks.some(item => item.code === 'figure-changed'),
        limitations: 'Same-engine structural check only. A failed check still returns this readable candidate. Not typography, pixel identity, independent QA, or scientific verification.',
      },
      warnings,
    };
    return {file, sha256: outputSha256, verification, pageMap, warnings};
  } catch (error) {
    if (error instanceof BrowserPdfError) throw error;
    throw new BrowserPdfError('engine', 'PDF 편집 중 엔진 오류가 났습니다. 출력 파일은 만들지 않았습니다.', {reason: error?.name || 'Error'});
  } finally {
    try { doc?.destroy(); } catch { /* already closed */ }
    for (const face of snapshot || []) { try { face.font?.destroy(); } catch { /* already closed */ } }
  }
}

function parseRequest(request) {
  const file = request.file;
  const signal = request.signal;
  let edits = request.edits;
  let fileHash = typeof request.fileHash === 'string' ? request.fileHash : '';
  if (edits && !Array.isArray(edits)) {
    if (edits.schema && edits.schema !== 'falsify.paper-edits.v1') {
      throw new BrowserPdfError('invalid', '편집 스냅샷 스키마를 알 수 없습니다.');
    }
    if (typeof edits.fileHash === 'string' && edits.fileHash) {
      if (fileHash && fileHash !== edits.fileHash) throw new BrowserPdfError('stale-source', '요청 해시와 스냅샷 해시가 다릅니다. 출력은 만들지 않았습니다.');
      fileHash = edits.fileHash;
    }
    edits = edits.edits;
  }
  if (!Array.isArray(edits)) throw new BrowserPdfError('invalid', 'edits 배열 또는 falsify.paper-edits.v1 스냅샷이 필요합니다.');
  if (fileHash && !/^[a-f0-9]{64}$/i.test(fileHash)) throw new BrowserPdfError('invalid', 'fileHash는 SHA-256 16진수여야 합니다.');
  return {file, signal, fileHash: fileHash.toLowerCase(), edits, name: file?.name || 'document.pdf'};
}

async function readBytes(file) {
  let bytes;
  if (file instanceof Uint8Array) bytes = new Uint8Array(file);
  else if (file && typeof file.arrayBuffer === 'function') bytes = new Uint8Array(await file.arrayBuffer());
  else if (file?.bytes instanceof Uint8Array) bytes = new Uint8Array(file.bytes);
  else throw new BrowserPdfError('invalid', 'PDF File 또는 bytes가 필요합니다.');
  if (bytes.byteLength > LIMITS.maxFileBytes) throw new BrowserPdfError('limit', 'PDF가 크기 제한을 넘습니다.');
  if (bytes.byteLength < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new BrowserPdfError('invalid', 'PDF 서명이 없습니다.');
  return bytes;
}

function openPdf(bytes) {
  let doc;
  try { doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF(); }
  catch { throw new BrowserPdfError('invalid', 'PDF를 열 수 없습니다.'); }
  if (!doc) throw new BrowserPdfError('invalid', 'PDF 문서가 아닙니다.');
  if (doc.needsPassword()) throw new BrowserPdfError('unsupported', '암호화된 PDF는 이 브라우저 편집에서 지원하지 않습니다. 파일을 만들지 않았습니다.');
  return doc;
}

function readPage(page) {
  const transform = page.getTransform();
  const chars = [];
  const images = [];
  const text = page.toStructuredText('preserve-whitespace,preserve-images');
  let lineId = -1;
  let lastY = null;
  text.walk({
    onChar(ch, origin, font, size, quad, color) {
      const pdf = apply(transform, origin[0], origin[1]);
      if (lastY === null || Math.abs(pdf[1] - lastY) > 1.25) { lineId += 1; lastY = pdf[1]; }
      chars.push({
        c: ch, origin: [origin[0], origin[1]], pdf, lineId,
        fontName: font.getName(), font, size: Number(size), quad: [...quad], color: rgb(color),
      });
    },
    onImageBlock(bbox) { images.push([...bbox]); },
  });
  return {chars, images, transform, bounds: page.getBounds(), rotation: rotationOf(page)};
}

function locate(edit, index, models, pageCount, snapshot) {
  const id = typeof edit?.id === 'string' && edit.id ? edit.id : `edit-${index}`;
  const pageIndex = edit?.pageIndex;
  const fail = (code) => ({ok: false, failure: {id, pageIndex: Number.isInteger(pageIndex) ? pageIndex : null, status: 'unapplied', code}});
  if (!edit || typeof edit !== 'object') return fail('invalid-edit');
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) return fail('invalid-page');
  if (typeof edit.before !== 'string' || !edit.before.trim() || edit.before.length > LIMITS.maxChars) return fail('invalid-before');
  if (typeof edit.after !== 'string' || edit.after.length > LIMITS.maxChars) return fail('invalid-after');
  const anchor = edit.anchor && typeof edit.anchor === 'object' ? edit.anchor : null;
  if (anchorConvention(edit, anchor)) return fail('invalid-anchor');
  if (anchor?.bbox && !validBox(anchor.bbox)) return fail('invalid-anchor');
  if (anchor && anchor.occurrence !== undefined && (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 0)) return fail('invalid-anchor');
  if (anchor && (anchor.start !== undefined || anchor.end !== undefined)) {
    if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.end <= anchor.start) return fail('invalid-anchor');
  }
  /* start/end are raw segment offsets. They are not page-string offsets and do not choose a hit. */
  const model = models[pageIndex];
  if (model.rotation !== 0) return fail('rotated-page');
  const {text, map} = normalized(model.chars);
  const needle = edit.before.replace(/\s+/g, ' ').trim();
  const hits = [];
  let from = 0, ordinal = 0, foundQuote = false;
  const requestedOrdinal = anchor?.occurrence;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const chars = [];
    for (let i = at; i < at + needle.length; i++) if (map[i] !== null && map[i] !== undefined) chars.push(model.chars[map[i]]);
    if (!chars.length) continue;
    foundQuote = true;
    const occurrence = ordinal++;
    // Numeric table values can repeat many times. Apply the caller's verified
    // geometry while scanning; never truncate the page before reaching its cell.
    if (requestedOrdinal !== undefined && occurrence !== requestedOrdinal) continue;
    if (anchor?.bbox) {
      const box = union(chars);
      if (!contains(box, anchor.bbox, Math.max(4, Math.min(8, (box[3] - box[1]) / 2)))) continue;
    }
    hits.push({at, chars});
    // Two surviving matches already prove ambiguity. A supplied ordinal still
    // counts page-global quotes, before geometry, as in the original contract.
    if (requestedOrdinal !== undefined || hits.length > 1) break;
  }
  const pool = hits;
  if (!pool.length) return fail(foundQuote ? 'anchor-mismatch' : 'not-found');
  if (pool.length > 1) return fail('ambiguous');
  const chars = pool[0].chars;
  const drawn = chars.filter(ch => ch.c.trim());
  if (!drawn.length) return fail('not-found');
  if (!drawn.every(ch => horizontalLine(chars.filter(item => item.lineId === ch.lineId)))) return fail('rotated-text');
  const fontsUsed = [...new Set(drawn.map(ch => ch.fontName))];
  const sizes = [...new Set(drawn.map(ch => Math.round(ch.size * 100) / 100))];
  const colors = [...new Set(drawn.map(ch => ch.color ? ch.color.map(n => Math.round(n * 1000) / 1000).join(',') : 'none'))];
  if (fontsUsed.length !== 1 || sizes.length !== 1 || colors.length !== 1 || colors[0] === 'none') return fail(colors[0] === 'none' ? 'unsupported-color' : 'mixed-style');
  const face = base14(fontsUsed[0], drawn[0].font);
  if (!face) return fail('font-unavailable');
  const supplied = snapshot ? chooseSnapshotFont(snapshot, fontsUsed[0], drawn[0].font, edit.after) : null;
  if (snapshot && !supplied) return fail('font-unavailable');
  const encoded = supplied ? {encoding: 'glyph-id', substituted: supplied.substituted} : textEncoding(face, edit.after);
  if (encoded.error) return fail(encoded.error);
  const box = pdfSpan(model.transform, chars.filter(ch => ch.lineId === chars[0].lineId));
  const partialLine = model.chars.some(ch => ch.lineId === chars[0].lineId && !chars.includes(ch) && ch.c.trim());
  return {ok: true, plan: {
    edit: {...edit, id}, pageIndex, chars, charIndex: new Set(chars.map(ch => model.chars.indexOf(ch))),
    anchorApproximate: !!anchor?.bbox && !contains(union(chars), anchor.bbox, 4),
    sourceFont: fontsUsed[0], face, supplied, encoding: encoded.encoding, substituted: encoded.substituted,
    size: sizes[0], color: drawn[0].color,
    origin: chars[0].pdf, hole: box[1] - box[0], partialLine, rotation: model.rotation,
  }};
}

function layout(plan, model, page) {
  const font = plan.supplied?.font || (plan.encoding === 'uniks-utf16' ? cjkFont() : metrics(plan.face.name));
  const fontName = plan.supplied?.name || (plan.encoding === 'uniks-utf16' ? 'ko' : plan.face.name);
  const after = plan.edit.after;
  const placed = (lines) => ({lines, font: fontName, substituted: plan.substituted, encoding: plan.encoding});
  if (!after) return placed([]);
  const width = measure(font, plan.size, after);
  if (width === null) return {error: 'missing-glyphs'};
  if (width <= plan.hole + 0.8) return placed([after]);
  if (plan.rotation !== 0) return {error: 'long-after-no-room'};
  const room = roomRight(plan, model, page);
  if (width <= room + 0.8) return placed([after]);
  const wrapWidth = Math.max(36, Math.min(room, 468));
  const lines = wrap(font, plan.size, after, wrapWidth);
  if (!lines) return {error: 'missing-glyphs'};
  if (lines.length > LIMITS.maxWrapLines) return {error: 'long-after-no-room'};
  if (!clear(lines, plan, model, font)) return {error: 'long-after-no-room'};
  return placed(lines);
}

/* MuPDF 1.28.1 sizes every horizontal glyph's redaction test from font
 * ascender to descender (FontDescriptor Ascent/Descent), then insets that box
 * by 10%. A raw structured-text quad is the same full metric box. On a tight
 * title those boxes cross the next baseline, and applyRedactions then deletes
 * each intersecting glyph whole. Edge contact counts as a hit. The quad used
 * here stays inside the selected glyph's inset box and outside every other
 * glyph's inset box. */
const REDACTION_GAP = 0.05;
const GLYPH_ORIGIN = 0.01;

function quadBounds(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]);
    y0 = Math.min(y0, points[i + 1]);
    x1 = Math.max(x1, points[i]);
    y1 = Math.max(y1, points[i + 1]);
  }
  return [x0, y0, x1, y1];
}

function removalBox(ch) {
  const [x0, y0, x1, y1] = quadBounds(ch.quad);
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return null;
  return [x0 + width / 10, y0 + height / 10, x1 - width / 10, y1 - height / 10];
}

function removalBoxes(chars) {
  const boxes = [];
  for (const ch of chars) {
    const box = removalBox(ch);
    if (box) boxes.push(box);
  }
  return boxes;
}

function subtractRect(rect, obstacle) {
  const [x0, y0, x1, y1] = rect;
  const grown = [obstacle[0] - REDACTION_GAP, obstacle[1] - REDACTION_GAP, obstacle[2] + REDACTION_GAP, obstacle[3] + REDACTION_GAP];
  if (x1 <= grown[0] || x0 >= grown[2] || y1 <= grown[1] || y0 >= grown[3]) return rect;
  const candidates = [];
  if (grown[1] > y0) candidates.push([x0, y0, x1, Math.min(y1, grown[1])]);
  if (grown[3] < y1) candidates.push([x0, Math.max(y0, grown[3]), x1, y1]);
  if (grown[0] > x0) candidates.push([x0, y0, Math.min(x1, grown[0]), y1]);
  if (grown[2] < x1) candidates.push([Math.max(x0, grown[2]), y0, x1, y1]);
  let best = null;
  let area = 0;
  for (const candidate of candidates) {
    const width = candidate[2] - candidate[0];
    const height = candidate[3] - candidate[1];
    if (width > 0 && height > 0 && width * height > area) {
      best = candidate;
      area = width * height;
    }
  }
  return best;
}

function safeRedactionRect(ch, protectedBoxes) {
  let rect = removalBox(ch);
  if (!rect) return null;
  for (let guard = 0; guard < 12; guard++) {
    let next = rect;
    for (const box of protectedBoxes) {
      next = subtractRect(next, box);
      if (!next) return null;
    }
    if (next.every((value, index) => value === rect[index])) return next;
    rect = next;
  }
  if (rect[2] - rect[0] <= 0.02 || rect[3] - rect[1] <= 0.02) return null;
  return rect;
}

function redact(page, chars, protectedBoxes) {
  const quads = [];
  for (const ch of chars) {
    const rect = safeRedactionRect(ch, protectedBoxes);
    if (!rect) {
      if (!ch.c.trim()) continue;
      throw new BrowserPdfError('unsupported', '선택한 글자의 글꼴 상자가 인접 글자와 겹쳐 그 글자만 지울 수 없습니다. 부분 적용 파일은 만들지 않았습니다.', {
        code: 'glyph-overlap',
      });
    }
    const [x0, y0, x1, y1] = rect;
    quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  if (!quads.length) return;
  const annot = page.createAnnotation('Redact');
  /* quads.flat() is 8 numbers per glyph. The Rect has to cover every one. */
  const box = quadBounds(quads.flat());
  annot.setRect(box);
  annot.setQuadPoints(quads);
  annot.update();
}

/* Tm is PDF user space and is written only after a zero /Rotate check.
 * The public anchor is never converted into this space. */
function showText(doc, page, plan) {
  if (!plan.layout.lines.length) return '';
  const cjk = plan.layout.encoding === 'uniks-utf16';
  const resource = plan.supplied ? ensureSnapshotFont(doc, page, plan) : cjk ? ensureCjkFont(doc, page) : ensureFont(doc, page, plan.layout.font);
  const [r, g, b] = plan.color;
  const leading = plan.size * 1.2;
  let body = `q BT /${resource} ${num(plan.size)} Tf ${num(r)} ${num(g)} ${num(b)} rg\n`;
  plan.layout.lines.forEach((line, index) => {
    const literal = plan.supplied ? glyphHex(plan.supplied.font, line) : cjk ? utf16hex(line) : winAnsi(line);
    body += `1 0 0 1 ${num(plan.origin[0])} ${num(plan.origin[1] - index * leading)} Tm ${literal} Tj\n`;
  });
  return body + 'ET Q\n';
}

function appendStream(doc, page, text) {
  const stream = doc.addStream(new TextEncoder().encode(text), {});
  const obj = page.getObject();
  const contents = obj.get('Contents');
  if (contents.isArray()) { contents.push(stream); return; }
  const array = doc.newArray();
  if (!contents.isNull()) array.push(contents);
  array.push(stream);
  obj.put('Contents', array);
}

function verify(sourceBytes, outBytes, plans, models, unchanged) {
  const warnings = [];
  const checks = [];
  let check;
  try { check = mupdf.Document.openDocument(outBytes, 'application/pdf').asPDF(); }
  catch { throw new BrowserPdfError('engine', '저장 결과를 다시 열 수 없습니다. 파일을 반환하지 않습니다.'); }
  try {
    if (check.countPages() !== models.length) checks.push({pageIndex: null, status: 'failed', code: 'page-count'});
    const edited = new Set(plans.map(plan => plan.pageIndex));
    for (let i = 0; i < models.length; i++) {
      const page = check.loadPage(i);
      const again = readPage(page);
      if (!sameImages(models[i].images, again.images)) checks.push({pageIndex: i, status: 'failed', code: 'figure-changed'});
      if (!edited.has(i)) {
        if (normalizeText(again.chars) !== normalizeText(models[i].chars)) checks.push({pageIndex: i, status: 'failed', code: 'untouched-text'});
      } else if (!keptOutsideSelection(models[i].chars, again.chars, selectedCharIndexes(plans, i))) {
        checks.push({pageIndex: i, status: 'failed', code: 'untouched-text'});
      }
    }
    for (const plan of plans) {
      const text = normalizeText(readPage(check.loadPage(plan.pageIndex)).chars);
      const before = plan.edit.before.replace(/\s+/g, ' ').trim();
      const after = plan.edit.after.replace(/\s+/g, ' ').trim();
      const sourceText = normalizeText(models[plan.pageIndex].chars);
      if (after && !text.includes(after)) {
        const words = after.split(' ').filter(Boolean);
        if (words.length && words.every(word => text.includes(word))) warnings.push(warn('after-extraction-order', 'warning', plan.pageIndex, plan.edit.id));
        else checks.push({id: plan.edit.id, pageIndex: plan.pageIndex, status: 'failed', code: 'present-after'});
      }
      const expected = Math.max(0, count(sourceText, before) - 1 + count(after, before));
      if (count(text, before) > expected) checks.push({id: plan.edit.id, pageIndex: plan.pageIndex, status: 'failed', code: 'removed-before'});
    }
    if (unchanged || (outBytes.length === sourceBytes.length && outBytes.every((byte, index) => byte === sourceBytes[index]))) {
      checks.push({status: 'failed', code: 'unchanged-output'});
    }
  } finally {
    try { check.destroy(); } catch { /* ignore */ }
  }
  return {warnings, checks};
}

function selectedCharIndexes(plans, pageIndex) {
  const selected = new Set();
  for (const plan of plans) {
    if (plan.pageIndex !== pageIndex) continue;
    for (const index of plan.charIndex) selected.add(index);
  }
  return selected;
}

/* Saved bytes of an edited page: every unselected drawn glyph must come back
 * once, same character, within GLYPH_ORIGIN of its PDF origin. A miss is a
 * failed check on the returned candidate. Spaces are outside the selection map. */
function keptOutsideSelection(sourceChars, outputChars, selected) {
  const pool = outputChars.map(ch => ({c: ch.c, x: ch.pdf[0], y: ch.pdf[1], used: false}));
  for (let index = 0; index < sourceChars.length; index++) {
    if (selected.has(index)) continue;
    const ch = sourceChars[index];
    if (!ch.c.trim()) continue;
    let found = -1;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (item.used || item.c !== ch.c) continue;
      if (Math.abs(item.x - ch.pdf[0]) <= GLYPH_ORIGIN && Math.abs(item.y - ch.pdf[1]) <= GLYPH_ORIGIN) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    pool[found].used = true;
  }
  return true;
}

function unsupported(failures, models) {
  const indexes = [...new Set(failures.map(item => item.pageIndex).filter(index => Number.isInteger(index)))];
  return new BrowserPdfError('unsupported', `적용하지 않은 편집이 있습니다 (${failures.map(item => item.code).join(', ')}). 페이지 ${indexes.map(index => index + 1).join(', ') || '-'}. 부분 적용 파일은 만들지 않았습니다.`, {
    coordinateSpace: COORDINATE_SPACE,
    pages: models.map((model, index) => verificationPage(model, index)),
    edits: failures,
  });
}

function anchorConvention(edit, anchor) {
  const spaces = [edit?.coordinateSpace, anchor?.coordinateSpace].filter(value => value !== undefined);
  if (spaces.some(value => value !== COORDINATE_SPACE)) return 'invalid-anchor';
  if (anchor?.origin !== undefined && anchor.origin !== COORDINATES.origin) return 'invalid-anchor';
  const axes = [edit?.yAxis, anchor?.yAxis].filter(value => value !== undefined);
  if (axes.some(value => value !== COORDINATES.yAxis)) return 'invalid-anchor';
  const units = [edit?.unit, anchor?.unit].filter(value => value !== undefined);
  if (units.some(value => value !== COORDINATES.unit)) return 'invalid-anchor';
  return null;
}

function pageMapEntry(model, index) {
  const view = pageView(model);
  return {
    sourcePageIndex: index,
    outputPageIndex: index,
    continuationPageIndices: [],
    coordinateSpace: COORDINATE_SPACE,
    origin: COORDINATES.origin,
    yAxis: COORDINATES.yAxis,
    unit: COORDINATES.unit,
    width: view.width,
    height: view.height,
    rotation: model.rotation,
  };
}

function verificationPage(model, index) {
  const entry = pageMapEntry(model, index);
  return {
    pageIndex: index,
    coordinateSpace: entry.coordinateSpace,
    origin: entry.origin,
    yAxis: entry.yAxis,
    unit: entry.unit,
    width: entry.width,
    height: entry.height,
    rotation: entry.rotation,
    editable: entry.rotation === 0,
  };
}

function pageView(model) {
  const bounds = model.bounds;
  return {
    width: Math.round((bounds[2] - bounds[0]) * 1000) / 1000,
    height: Math.round((bounds[3] - bounds[1]) * 1000) / 1000,
  };
}

function failure(edit, pageIndex, code) {
  return {id: edit.id, pageIndex, status: 'unapplied', code};
}

function warn(code, severity, pageIndex, editId) {
  return {code, severity, pageIndex, editId};
}

function overlapping(plans) {
  const failures = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      if (plans[i].pageIndex !== plans[j].pageIndex) continue;
      for (const index of plans[i].charIndex) if (plans[j].charIndex.has(index)) {
        failures.push(failure(plans[j].edit, plans[j].pageIndex, 'overlap'));
        break;
      }
    }
  }
  return failures;
}

function normalized(chars) {
  let text = '';
  const map = [];
  let gap = false;
  let line = null;
  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index];
    if (line !== null && ch.lineId !== line) gap = true;
    line = ch.lineId;
    if (!ch.c.trim()) { gap = true; continue; }
    if (gap && text) { text += ' '; map.push(null); }
    gap = false;
    text += ch.c;
    map.push(index);
  }
  return {text, map};
}

function normalizeText(chars) {
  return normalized(chars).text;
}

function horizontalLine(chars) {
  if (chars.length < 2) return true;
  const ys = chars.map(ch => ch.pdf[1]);
  if (Math.max(...ys) - Math.min(...ys) > 1.5) return false;
  for (let i = 1; i < chars.length; i++) if (chars[i].pdf[0] + 0.4 < chars[i - 1].pdf[0]) return false;
  return true;
}


// A snapshot is immutable input to this request, never stored in the global metrics cache.
function captureFontSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.fonts) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || typeof snapshot.digest !== 'string')
    throw new BrowserPdfError('invalid', 'Invalid font snapshot.');
  return {...snapshot, fonts: snapshot.fonts.map(face => {
    if (!face || !(face.bytes instanceof Uint8Array)) throw new BrowserPdfError('invalid', 'Invalid font snapshot bytes.');
    return {...face, bytes: face.bytes.slice()};
  })};
}
async function validateFontSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.fonts) || !Number.isInteger(snapshot.revision) || typeof snapshot.digest !== 'string')
    throw new BrowserPdfError('invalid', 'Invalid font snapshot.');
  const faces = [];
  for (const face of snapshot.fonts) {
    if (!(face.bytes instanceof Uint8Array) || typeof face.sha256 !== 'string')
      throw new BrowserPdfError('invalid', 'Invalid font snapshot bytes.');
    const bytes = face.bytes.slice();
    if (await sha256(bytes) !== face.sha256.toLowerCase())
      throw new BrowserPdfError('invalid', 'Font snapshot bytes do not match their SHA-256.');
    let parsed;
    try { parsed = parseFont(bytes); } catch { throw new BrowserPdfError('unsupported', 'Font is invalid or embedding is restricted.'); }
    if (typeof face.id !== 'string' || !['local', 'file', 'bundled'].includes(face.source) ||
        ['family', 'postscriptName', 'weight', 'italic', 'fsType'].some(field => face[field] !== parsed[field]))
      throw new BrowserPdfError('invalid', 'Font snapshot metadata does not match its bytes.');
    // MuPDF addFont embeds the complete font. Never invoke save-time font subsetting.
    faces.push({...face, bytes});
  }
  const metadata = snapshot.fonts.map(({bytes, ...rest}) => rest);
  if (await sha256(new TextEncoder().encode(JSON.stringify(metadata))) !== snapshot.digest.toLowerCase())
    throw new BrowserPdfError('invalid', 'Font snapshot metadata digest does not match.');
  return faces;
}

function chooseSnapshotFont(faces, sourceName, sourceFont, text) {
  const source = familyKey(sourceName);
  const matches = face => source && (source === familyKey(face.postscriptName) || source === familyKey(face.family));
  const ranked = faces.filter(face => matches(face) || face.source === 'bundled').sort((a, b) =>
    (matches(a) ? 0 : 10000) - (matches(b) ? 0 : 10000) +
    (a.italic === sourceFont.isItalic() ? 0 : 1000) - (b.italic === sourceFont.isItalic() ? 0 : 1000) +
    Math.abs(a.weight - (sourceFont.isBold() ? 700 : 400)) - Math.abs(b.weight - (sourceFont.isBold() ? 700 : 400)));
  for (const face of ranked) {
    let font;
    try { font = face.font || new mupdf.Font(face.postscriptName || face.family, face.bytes); }
    catch { continue; }
    if ([...text].every(ch => font.encodeCharacter(ch.codePointAt(0))))
      { face.font = font; return {font, name: font.getName(), substituted: !matches(face), face}; }
    if (!face.font) font.destroy();
  }
  return null;
}
function glyphHex(font, text) {
  return '<' + [...text].map(ch => font.encodeCharacter(ch.codePointAt(0)).toString(16).padStart(4, '0')).join('') + '>';
}
function ensureSnapshotFont(doc, page, plan) {
  const resources = ownResources(doc, page);
  let dict = resources.get('Font');
  if (dict.isNull()) { dict = doc.newDictionary(); resources.put('Font', dict); }
  else dict = dict.resolve();
  const taken = new Set(); dict.forEach((_value, key) => taken.add(String(key)));
  let name = 'FwEmbedded'; while (taken.has(name)) name += 'x';
  const pdfFont = doc.addFont(plan.supplied.font);
  const mappings = new Map();
  for (const line of plan.layout.lines) for (const ch of line) {
    const gid = plan.supplied.font.encodeCharacter(ch.codePointAt(0));
    if (mappings.has(gid) && mappings.get(gid) !== ch) throw new BrowserPdfError('unsupported', 'Font maps multiple Unicode characters to one glyph.');
    mappings.set(gid, ch);
  }
  const entries = [...mappings].map(([gid, ch]) => `<${gid.toString(16).padStart(4, '0')}> ${utf16hex(ch)}`);
  let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FwUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100); cmap += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
  }
  cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  pdfFont.put('ToUnicode', doc.addStream(new TextEncoder().encode(cmap), {}));
  dict.put(name, pdfFont);
  return name;
}

function base14(fontName, font) {
  const bare = String(fontName || '').replace(/^[A-Z]{6}\+/, '');
  if (BASE14.includes(bare)) return {name: bare, substituted: false};
  if (FACE_ALIAS[bare]) return {name: FACE_ALIAS[bare], substituted: true};
  if (!font) return null;
  const bold = font.isBold();
  const italic = font.isItalic();
  const family = font.isMono() ? 'Courier' : font.isSerif() ? 'Times' : 'Helvetica';
  const name = family === 'Times'
    ? (bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman')
    : family === 'Courier'
      ? (bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier')
      : (bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica');
  return {name, substituted: true};
}

function metrics(name) {
  if (!fonts.has(name)) fonts.set(name, new mupdf.Font(name));
  return fonts.get(name);
}

function cjkFont() {
  return metrics('ko');
}

function textEncoding(face, after) {
  if (!after) return {encoding: 'winansi', substituted: face.substituted};
  const latin = metrics(face.name);
  const latinOk = [...after].every(ch => latin.encodeCharacter(ch)) && winAnsi(after) !== null;
  if (latinOk) return {encoding: 'winansi', substituted: face.substituted};
  const ko = cjkFont();
  if ([...after].every(ch => ko.encodeCharacter(ch))) return {encoding: 'uniks-utf16', substituted: true};
  return {error: 'missing-glyphs'};
}

function utf16hex(text) {
  let hex = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const unit = code - 0x10000;
      hex += (0xd800 + (unit >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (unit & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += code.toString(16).padStart(4, '0');
  }
  return '<' + hex + '>';
}

function measure(font, size, text) {
  let width = 0;
  for (const ch of text) {
    const gid = font.encodeCharacter(ch.codePointAt(0));
    if (!gid) return null;
    width += font.advanceGlyph(gid) * size;
  }
  return width;
}

function roomRight(plan, model, page) {
  const end = plan.origin[0] + plan.hole;
  let limit = page.getBounds('MediaBox')[2] - 36;
  for (const ch of model.chars) {
    if (plan.charIndex.has(model.chars.indexOf(ch))) continue;
    if (ch.lineId !== plan.chars[0].lineId || !ch.c.trim()) continue;
    if (ch.pdf[0] > end - 0.5) limit = Math.min(limit, ch.pdf[0] - 1);
  }
  return Math.max(0, limit - plan.origin[0]);
}

function wrap(font, size, text, maxWidth) {
  const lines = [];
  let current = '';
  const flush = () => { if (current.trim()) lines.push(current.trimEnd()); current = ''; };
  for (const part of text.split(/(\s+)/)) {
    if (!part || /^\s+$/.test(part)) {
      if (current && measure(font, size, (current + ' ').trimEnd()) <= maxWidth) current += ' ';
      continue;
    }
    const trial = current ? current + part : part;
    const width = measure(font, size, trial.trimEnd());
    if (width === null) return null;
    if (width <= maxWidth) { current = trial; continue; }
    flush();
    if (measure(font, size, part) <= maxWidth) { current = part; continue; }
    let buffer = '';
    for (const ch of part) {
      const next = buffer + ch;
      const piece = measure(font, size, next);
      if (piece === null) return null;
      if (piece > maxWidth && buffer) { lines.push(buffer); buffer = ch; }
      else buffer = next;
    }
    current = buffer;
  }
  flush();
  return lines.length ? lines : null;
}

function clear(lines, plan, model, font) {
  const leading = plan.size * 1.2;
  for (let index = 1; index < lines.length; index++) {
    const width = measure(font, plan.size, lines[index]);
    const x = plan.origin[0];
    const y = plan.origin[1] - index * leading;
    const corners = [[x, y - plan.size * 0.25], [x + width, y - plan.size * 0.25], [x, y + plan.size * 0.85], [x + width, y + plan.size * 0.85]];
    const pageBox = corners.map(point => apply(mupdf.Matrix.invert(model.transform), point[0], point[1]));
    const box = [Math.min(...pageBox.map(point => point[0])), Math.min(...pageBox.map(point => point[1])), Math.max(...pageBox.map(point => point[0])), Math.max(...pageBox.map(point => point[1]))];
    const bounds = model.bounds;
    if (box[0] < -2 || box[1] < -2 || box[2] > bounds[2] + 2 || box[3] > bounds[3] + 2) return false;
    for (const image of model.images) if (intersects(box, image, 1)) return false;
    for (let charIndex = 0; charIndex < model.chars.length; charIndex++) {
      if (plan.charIndex.has(charIndex)) continue;
      if (intersects(box, union([model.chars[charIndex]]), 0.8)) return false;
    }
  }
  return true;
}

function ensureCjkFont(doc, page) {
  const resources = ownResources(doc, page);
  let fontsDict = resources.get('Font');
  if (fontsDict.isNull()) { fontsDict = doc.newDictionary(); resources.put('Font', fontsDict); }
  else fontsDict = fontsDict.resolve();
  let existing = null;
  fontsDict.forEach((value, key) => {
    if (existing) return;
    const item = value.resolve();
    const encoding = item.get('Encoding');
    if (!encoding.isNull() && encoding.asName() === 'UniKS-UTF16-H') existing = String(key);
  });
  if (existing) return existing;
  let name = 'FwKorea';
  const taken = new Set();
  fontsDict.forEach((_value, key) => taken.add(String(key)));
  while (taken.has(name)) name += 'x';
  fontsDict.put(name, doc.addCJKFont(cjkFont(), 'ko', 0, false));
  return name;
}

function ensureFont(doc, page, baseName) {
  const resources = ownResources(doc, page);
  let fontsDict = resources.get('Font');
  if (fontsDict.isNull()) { fontsDict = doc.newDictionary(); resources.put('Font', fontsDict); }
  else fontsDict = fontsDict.resolve();
  let existing = null;
  fontsDict.forEach((value, key) => {
    if (existing) return;
    const item = value.resolve();
    const base = item.get('BaseFont');
    const encoding = item.get('Encoding');
    if (!base.isNull() && base.asName() === baseName && !encoding.isNull() && encoding.asName() === 'WinAnsiEncoding') existing = String(key);
  });
  if (existing) return existing;
  let name = 'Fw' + baseName.replace(/[^A-Za-z0-9]/g, '');
  const taken = new Set();
  fontsDict.forEach((_value, key) => taken.add(String(key)));
  while (taken.has(name)) name += 'x';
  fontsDict.put(name, doc.addObject({Type: 'Font', Subtype: 'Type1', BaseFont: baseName, Encoding: 'WinAnsiEncoding'}));
  return name;
}

function ownResources(doc, page) {
  const obj = page.getObject();
  const own = obj.get('Resources');
  if (!own.isNull()) return own.resolve();
  const copy = doc.newDictionary();
  const inherited = obj.getInheritable('Resources');
  if (!inherited.isNull()) inherited.resolve().forEach((value, key) => copy.put(key, value));
  obj.put('Resources', copy);
  return copy;
}

function winAnsi(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    let byte = null;
    if (code <= 0x7f) byte = code;
    else if (code >= 0xa0 && code <= 0xff) byte = code;
    else if (WINANSI_EXTRA[code] !== undefined) byte = WINANSI_EXTRA[code];
    if (byte === null) return null;
    bytes.push(byte);
  }
  let out = '(';
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\' + String.fromCharCode(byte);
    else if (byte < 32 || byte > 126) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return out + ')';
}

function rgb(color) {
  if (!Array.isArray(color) || color.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 3) return [color[0], color[1], color[2]];
  return null;
}

function rotationOf(page) {
  const value = page.getObject().get('Rotate');
  if (value.isNull()) return 0;
  return ((value.asNumber() % 360) + 360) % 360;
}

function apply(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

function union(chars) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ch of chars) for (let i = 0; i < 8; i += 2) {
    x0 = Math.min(x0, ch.quad[i]); y0 = Math.min(y0, ch.quad[i + 1]);
    x1 = Math.max(x1, ch.quad[i]); y1 = Math.max(y1, ch.quad[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/* Width in PDF user space. Callers reach this only for rotation 0. */
function pdfSpan(transform, chars) {
  let x0 = Infinity, x1 = -Infinity;
  for (const ch of chars) for (let i = 0; i < 8; i += 2) {
    const x = apply(transform, ch.quad[i], ch.quad[i + 1])[0];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
  }
  return [x0, x1];
}

function contains(box, bbox, tol) {
  return box[0] >= bbox[0] - tol && box[1] >= bbox[1] - tol && box[2] <= bbox[2] + tol && box[3] <= bbox[3] + tol;
}

function intersects(a, b, pad) {
  return a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;
}

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(value => typeof value === 'number' && Number.isFinite(value)) && box[0] < box[2] && box[1] < box[3];
}

function count(text, needle) {
  if (!needle) return 0;
  let found = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found += 1;
    from = at + needle.length;
  }
  return found;
}

function num(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function sameImages(a, b) {
  if (a.length !== b.length) return false;
  const key = box => box.map(value => Math.round(value * 10) / 10).join(',');
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

function editedName(name) {
  const base = String(name || 'document.pdf');
  return /\.pdf$/i.test(base) ? base.replace(/\.pdf$/i, '.edited.pdf') : base + '.edited.pdf';
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

globalThis.FalsifyBrowserPdf = {prepare, ENGINE, LIMITS, COORDINATE_SPACE, COORDINATES, BrowserPdfError};
