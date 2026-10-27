/* Thin browser adapter to the original Falsify/BentoPDF paragraph editor.
 * AGPL-3.0-only. See paragraph-vendor/NOTICE.md for exact provenance. */
import {canonicalParagraphText, editPdf} from './paragraph-vendor/editor.mjs';
import {loadRuntime, RUNTIME} from './paragraph-pdf-runtime.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {createAnnotationTransport} from './document-flow-annotations.mjs';
import {parseFont} from './browser-fonts.mjs';

export const COORDINATE_SPACE = 'top-left-page';
export const LIMITS = Object.freeze({maxFileBytes: 25 * 1024 * 1024});
export class ParagraphPdfError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ParagraphPdfError'; this.code = code; this.details = details; }
}
function checkAbort(signal) {
  if (signal?.aborted) throw new ParagraphPdfError('aborted', 'PDF editing cancelled.');
}
async function source(request) {
  checkAbort(request.signal);
  const file = request.file;
  if (Number.isFinite(file?.size) && file.size > LIMITS.maxFileBytes) throw new ParagraphPdfError('limit', 'PDF exceeds the 25 MiB size limit.');
  if (request.fileHash && (typeof request.fileHash !== 'string' || !/^[a-f0-9]{64}$/i.test(request.fileHash))) throw new ParagraphPdfError('invalid', 'fileHash must be a SHA-256 hexadecimal digest.');
  const bytes = file instanceof Uint8Array ? new Uint8Array(file)
    : file?.bytes instanceof Uint8Array ? new Uint8Array(file.bytes)
    : typeof file?.arrayBuffer === 'function' ? new Uint8Array(await file.arrayBuffer()) : null;
  if (!bytes?.length || bytes.length > LIMITS.maxFileBytes) throw new ParagraphPdfError('invalid', 'A PDF within the size limit is required.');
  checkAbort(request.signal);
  const hash = hex(bytes);
  if (request.fileHash && request.fileHash.toLowerCase() !== hash) throw new ParagraphPdfError('stale-source', 'Source PDF differs from the inspected file.', {sourceSha256: hash});
  return {bytes, hash};
}
// Capture before the first await, so every engine in this request sees the same bytes.
function captureFonts(snapshot) {
  if (snapshot == null) return null;
  const invalid = () => { throw new ParagraphPdfError('invalid-font-snapshot', 'Font snapshot failed validation.'); };
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.fonts) || typeof snapshot.digest !== 'string') invalid();
  const metadata = [];
  const fonts = snapshot.fonts.map(face => {
    if (!face || !(face.bytes instanceof Uint8Array) || !face.bytes.length || typeof face.id !== 'string' || !['local', 'file', 'bundled'].includes(face.source)) invalid();
    const bytes = face.bytes.slice();
    if (hex(bytes) !== face.sha256) invalid();
    let parsed;
    try { parsed = parseFont(bytes); } catch { invalid(); }
    // PDFium may rewrite/subset the supplied program; do not use a face that
    // requires complete embedding until the engine can guarantee that contract.
    if (parsed.fsType & 0x100) throw new ParagraphPdfError('unsupported-font-license', 'Paragraph editing cannot guarantee full embedding for this font.');
    for (const field of ['family', 'postscriptName', 'weight', 'italic', 'fsType']) {
      if (face[field] !== parsed[field]) invalid();
    }
    const {bytes: ignored, ...descriptor} = face;
    metadata.push(descriptor);
    return {...descriptor, bytes};
  });
  if (hex(new TextEncoder().encode(JSON.stringify(metadata))) !== snapshot.digest) invalid();
  return {revision: snapshot.revision, digest: snapshot.digest, fonts, selections: []};
}
export async function inspectPage(request = {}) {
  const fontSnapshot = captureFonts(request.fontSnapshot);
  const {bytes, hash} = await source(request);
  const {engineFactory} = await loadRuntime();
  checkAbort(request.signal);
  const engine = await engineFactory(bytes, fontSnapshot);
  try {
    const pageIndex = request.pageIndex;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= engine.pageCount) throw new ParagraphPdfError('invalid-page', 'Page index is outside the document.');
    engine.loadPage(pageIndex);
    const paragraphs = engine.buildModel();
    const rotation = (engine.M._FPDFPage_GetRotation?.(engine.page) || 0) * 90;
    // PDFium page dimensions already include /Rotate, paragraph boxes remain
    // in PDF user coordinates. Recover the unrotated dimensions for mapping.
    const width = engine.pageWidth, height = engine.pageHeight;
    const pageWidth = rotation % 180 ? height : width;
    const pageHeight = rotation % 180 ? width : height;
    const bbox = box => {
      const l = box.x, r = box.x + box.w, t = box.top, b = box.top - box.h;
      if (rotation === 90) return [b, l, t, r];
      if (rotation === 180) return [pageWidth - r, b, pageWidth - l, t];
      if (rotation === 270) return [pageHeight - t, pageWidth - r, pageHeight - b, pageWidth - l];
      return [l, pageHeight - t, r, pageHeight - b];
    };
    checkAbort(request.signal);
    const skippedParagraphs = [];
    const visible = [];
    paragraphs.forEach((p, index) => {
      const b = p?.box;
      if (!b || ![b.x, b.top, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0 || !Array.isArray(p.runs)) {
        skippedParagraphs.push({index, sourceId: p?.id ?? null, code: 'paragraph-geometry-unavailable'});
      } else visible.push({p, index});
    });
    return {fileHash: hash, pageIndex, width, height, rotation, coordinateSpace: COORDINATE_SPACE,
      skippedParagraphs,
      paragraphs: visible.map(({p, index}) => ({
        id: `p${pageIndex}-${index}-${hex(new TextEncoder().encode(JSON.stringify([p.box, p.runs.map(r => r.text)]))).slice(0, 16)}`,
        // The engine resolves only source-proven line-end control markers.
        // IDs above continue to bind the untouched source geometry/raw runs.
        sourceId: p.id, text: canonicalParagraphText(p),
        bbox: bbox(p.box),
        fontName: p.runs[0]?.family || '', size: p.runs[0]?.size || 0,
        editable: p.editable !== false, runs: p.runs.map(r => ({text: r.text, fontName: r.family || '', size: r.size, rgba: r.rgba})),
      })),
    };
  } finally { engine.close(); }
}

function lazyAnnotationAdapter(signal) {
  let shared;
  const load = () => shared || (shared = (async () => {
    checkAbort(signal);
    // Native code chooses whether it needs annotation proof. This fixed local
    // namespace is shared with the existing browser writer; no request path or
    // callback can select another implementation.
    const mupdf = await import('./browser-pdf-vendor/mupdf.js');
    checkAbort(signal);
    return createAnnotationTransport({mupdf});
  })());
  const invoke = method => async input => {
    checkAbort(signal);
    const adapter = await load();
    checkAbort(signal);
    const result = await adapter[method](input);
    checkAbort(signal);
    return result;
  };
  return Object.freeze({inspect: invoke('inspect'), transport: invoke('transport'), validate: invoke('validate')});
}

// Return raw source spans for the engine only when a line start proves the
// U+FFFC/U+00AD pair is a discretionary wrap. All representations are counted
// together so a conventional match cannot hide a second source target.
export function reconcileSourceWrap(paragraphs, before) {
  if (typeof before !== 'string' || !before.trim()) return null;
  let raw = '', markers = new Map();
  paragraphs.forEach((p, pi) => {
    if (pi) raw += '\n';
    const base = raw.length, text = p.runs.map(r => r.text).join('');
    const starts = new Set((p.lines || []).map(l => l.off));
    for (let i = 0; i < text.length; i++) {
      if (text.slice(i, i + 2) === '\ufffc\u00ad' && starts.has(i + 2) && /\p{L}/u.test(text[i - 1] || '') && /\p{L}/u.test(text[i + 2] || '')) markers.set(base + i, 'pair');
      if (text[i] === '\u0002' && /\p{L}/u.test(text[i - 1] || '') && /\s/.test(text[i + 1] || '') && /\p{L}/u.test(text[i + 2] || '') && starts.has(i + 2)) markers.set(base + i, 'control');
    }
    raw += text;
  });
  if (![...markers.values()].includes('pair')) return null;
  const needle = before.replace(/\s+/g, ' '), hits = new Map();
  for (const pairMode of ['raw', 'visible', 'logical']) for (const controlMode of ['visible', 'logical']) {
    const chars = [];
    for (let i = 0; i < raw.length; i++) {
      const kind = markers.get(i);
      if (kind === 'pair' && pairMode !== 'raw') {
        if (pairMode === 'visible') { chars.push({ch:'-', a:i, b:i+1}, {ch:' ', a:i, b:i+1}); }
        i++; continue;
      }
      if (kind === 'control') {
        if (controlMode === 'visible') chars.push({ch:'-', a:i, b:i});
        else { i++; continue; }
      } else chars.push({ch:raw[i], a:i, b:i});
    }
    let norm = '', map = [];
    for (let i = 0; i < chars.length; i++) {
      let end = i;
      if (/\s/.test(chars[i].ch)) while (end + 1 < chars.length && /\s/.test(chars[end+1].ch)) end++;
      norm += /\s/.test(chars[i].ch) ? ' ' : chars[i].ch;
      map.push([chars[i].a, chars[end].b]); i = end;
    }
    for (let at = norm.indexOf(needle); at >= 0; at = norm.indexOf(needle, at + 1)) {
      const a = map[at][0], b = map[at + needle.length - 1][1];
      const hasPair = [...markers].some(([offset, kind]) => kind === 'pair' && offset >= a && offset + 1 <= b);
      const key = `${a}:${b}`;
      const prior = hits.get(key);
      hits.set(key, {a, b, reconciled: prior?.reconciled || (pairMode !== 'raw' && hasPair)});
    }
  }
  if (![...hits.values()].some(h => h.reconciled)) return null;
  if (hits.size !== 1) return {ambiguous: true, hits: hits.size};
  // Different wrap spellings in one selection would require per-marker
  // combinations. Reject rather than overlook a mixed-spelling duplicate.
  const offsets = [...markers.keys()];
  for (let i = 0; i < offsets.length; i++) for (let j = i + 1; j < offsets.length; j++) {
    if (markers.get(offsets[i]) !== 'pair' && markers.get(offsets[j]) !== 'pair') continue;
    const between = raw.slice(offsets[i] + 2, offsets[j]).replace(/\ufffc\u00ad/g, '').replace(/\u0002\s/g, '').replace(/\s+/g, ' ');
    if (between.length <= needle.length) return {unsupported: true};
  }
  const hit = hits.values().next().value;
  return {before: raw.slice(hit.a, hit.b + 1)};
}

async function reconcileEdits(bytes, edits, engineFactory, signal) {
  const engine = await engineFactory(bytes), output = edits.map(e => ({...e})), diagnostics = [];
  try {
    for (const pageIndex of new Set(edits.map(e => e.pageIndex))) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= engine.pageCount) continue;
      checkAbort(signal); engine.loadPage(pageIndex); engine.normalizeFontsForEdit();
      const paragraphs = engine.buildModel();
      for (const edit of output.filter(e => e.pageIndex === pageIndex)) {
        const result = reconcileSourceWrap(paragraphs, edit.before);
        if (result?.unsupported) throw new ParagraphPdfError('MATCH_FAILED', 'Mixed source wraps cannot be uniquely reconciled.', {failures:[{id:edit.id, pageIndex, code:'UNSUPPORTED_WRAP_COMBINATION'}]});
        if (result?.ambiguous) throw new ParagraphPdfError('MATCH_FAILED', 'Edit could not be matched exactly once.', {failures:[{id:edit.id, pageIndex, code:'AMBIGUOUS_MATCH', hits:result.hits}]});
        if (result) {
          diagnostics.push({id:edit.id, pageIndex, code:'source_wrap_reconciled', originalBefore:edit.before, originalAfter:edit.after, evidence:'U+FFFC U+00AD immediately before source line start'});
          edit.before = result.before;
        }
      }
    }
  } finally { engine.close(); }
  return {edits:output, diagnostics};
}

export async function prepare(request = {}) {
  const fontSnapshot = captureFonts(request.fontSnapshot);
  let requestedEdits = request.edits;
  let fileHash = request.fileHash || '';
  if (requestedEdits && !Array.isArray(requestedEdits)) {
    if (requestedEdits.schema && requestedEdits.schema !== 'falsify.paper-edits.v1') throw new ParagraphPdfError('invalid', 'Unknown edit snapshot schema.');
    const embeddedHash = requestedEdits.fileHash;
    if (embeddedHash) {
      if (typeof embeddedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(embeddedHash)) throw new ParagraphPdfError('invalid', 'Snapshot fileHash must be a SHA-256 hexadecimal digest.');
      if (fileHash && (typeof fileHash !== 'string' || fileHash.toLowerCase() !== embeddedHash.toLowerCase())) throw new ParagraphPdfError('stale-source', 'Request and snapshot hashes differ.');
      fileHash = embeddedHash;
    }
    requestedEdits = requestedEdits.edits;
  }
  const {bytes, hash} = await source({...request, fileHash});
  if (!Array.isArray(requestedEdits)) throw new ParagraphPdfError('invalid', 'An edits array or falsify.paper-edits.v1 snapshot is required.');
  const enabled = requestedEdits.filter(edit => edit?.enabled !== false);
  if (!enabled?.length) throw new ParagraphPdfError('no-edits', 'At least one enabled edit is required.');
  const edits = enabled.map((e, index) => ({id: e?.id || `edit-${index}`, pageIndex: e?.pageIndex, before: e?.before, after: e?.after}));
  const {engineFactory: createEngine, info} = await loadRuntime();
  const engineFactory = bytes => createEngine(bytes, fontSnapshot);
  checkAbort(request.signal);
  // Matching remains exact and all-or-nothing. Duplicate Before text is an
  // explicit AMBIGUOUS_MATCH; selection metadata never silently relocates it.
  const reconciled = await reconcileEdits(bytes, edits, engineFactory, request.signal);
  const {pdf, report} = await editPdf({sourceBytes: bytes, edits: reconciled.edits, reflow: true}, {engineFactory, runtimeInfo: info, draft: true,
    documentFlow: 'compatible-groups', annotationAdapter: lazyAnnotationAdapter(request.signal)});
  checkAbort(request.signal);
  const sha256 = hex(pdf);
  const warnings = [...(report.warnings || []), ...(report.selfCheck?.warnings || []),
    {code: 'edited_page_color_serialization', severity: 'warning'}];
  const status = report.ok === true && report.selfCheck?.status === 'passed' ? (warnings.some(w => w.severity === 'warning') ? 'warning' : 'applied') : 'failed';
  const verification = {
    schema: 'falsify.paragraph-pdf.v1', engine: RUNTIME.engine, license: RUNTIME.license,
    sourceSha256: hash, outputSha256: sha256, fontSnapshotDigest: fontSnapshot?.digest ?? null,
    fontSelections: fontSnapshot?.selections ?? [], status, layoutVerified: false, independent: false,
    coordinateSpace: COORDINATE_SPACE, pageCount: report.pagination.pages,
    edits: report.edits, checks: (report.selfCheck?.failures || []).map(item => ({...item, status: 'failed'})), warnings, runtime: info,
    quality: {independent: false, method: 'PDFium saved-file self-check', limitations: 'Same-engine structural checks; independent typography and visual QA are required.'},
    reconciliation: reconciled.diagnostics, report,
  };
  const name = String(request.file?.name || 'document.pdf').replace(/\.pdf$/i, '') + '-edited.pdf';
  return {file: new File([pdf], name, {type: 'application/pdf'}), sha256, verification,
    pageMap: report.pagination.sourcePageMap, warnings};
}
