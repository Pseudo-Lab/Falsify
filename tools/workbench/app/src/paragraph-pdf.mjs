/* Thin browser adapter to the original Falsify/BentoPDF paragraph editor.
 * AGPL-3.0-only. See paragraph-vendor/NOTICE.md for exact provenance. */
import {canonicalParagraphText, editPdf} from './paragraph-vendor/editor.mjs';
import {loadRuntime, RUNTIME} from './paragraph-pdf-runtime.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

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
export async function inspectPage(request = {}) {
  const {bytes, hash} = await source(request);
  const {engineFactory} = await loadRuntime();
  checkAbort(request.signal);
  const engine = await engineFactory(bytes);
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

export async function prepare(request = {}) {
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
  const {engineFactory, info} = await loadRuntime();
  checkAbort(request.signal);
  // Matching remains exact and all-or-nothing. Duplicate Before text is an
  // explicit AMBIGUOUS_MATCH; selection metadata never silently relocates it.
  const {pdf, report} = await editPdf({sourceBytes: bytes, edits, reflow: true}, {engineFactory, runtimeInfo: info, draft: true});
  checkAbort(request.signal);
  const sha256 = hex(pdf);
  const warnings = [...(report.warnings || []), ...(report.selfCheck?.warnings || []),
    {code: 'edited_page_color_serialization', severity: 'warning'}];
  const status = report.ok === true && report.selfCheck?.status === 'passed' ? (warnings.some(w => w.severity === 'warning') ? 'warning' : 'applied') : 'failed';
  const verification = {
    schema: 'falsify.paragraph-pdf.v1', engine: RUNTIME.engine, license: RUNTIME.license,
    sourceSha256: hash, outputSha256: sha256, status, layoutVerified: false, independent: false,
    coordinateSpace: COORDINATE_SPACE, pageCount: report.pagination.pages,
    edits: report.edits, checks: (report.selfCheck?.failures || []).map(item => ({...item, status: 'failed'})), warnings, runtime: info,
    quality: {independent: false, method: 'PDFium saved-file self-check', limitations: 'Same-engine structural checks; independent typography and visual QA are required.'},
    report,
  };
  const name = String(request.file?.name || 'document.pdf').replace(/\.pdf$/i, '') + '-edited.pdf';
  return {file: new File([pdf], name, {type: 'application/pdf'}), sha256, verification,
    pageMap: report.pagination.sourcePageMap, warnings};
}
