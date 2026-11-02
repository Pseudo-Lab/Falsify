import {inspectLayoutQuality} from './paper-layout-quality.mjs';

const TYPES = new Set(['text-clipped','ink-outside-page','text-overlap','text-image-overlap','small-body-text','body-font-deviation','caption-separated','heading-orphan','blank-column']);
const LIMITATIONS = [
  'Text paint bounds are glyph ink extents; structured text character boxes are font metrics.',
  'Only axis-aligned rectangular clip paths are checked; arbitrary clips, transparency, occlusion, rotated text, vector figure ownership, and reading order remain unverified.',
  'Scores measure detected defects only; they are not proof of visual quality.',
  'MuPDF unavailable.',
  'Column geometry is invalid or unavailable.',
  'Column anchor is unavailable, ambiguous, on another page, or inside the candidate column.'
];
const LIMIT = 1000;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Audit cancelled', 'AbortError');
}

// The inspector may contain document text in evidence, profile and errors. Only
// explicitly selected geometry and known diagnostic categories leave this boundary.
export async function auditLatexLayout({bytes,mupdf,profile={},signal}={}) {
  checkAbort(signal);
  const snapshot = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) :
    ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice() : null;
  if (!snapshot) throw new TypeError('PDF bytes required');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', snapshot);
  checkAbort(signal);
  const outputPdfHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  const result = inspectLayoutQuality({bytes:snapshot,mupdf,profile});
  checkAbort(signal);
  const validFindings = (result.issues || []).filter(i => TYPES.has(i.type) && Number.isSafeInteger(i.pageIndex) && i.pageIndex >= 0 && Array.isArray(i.bbox) && i.bbox.length === 4 && i.bbox.every(Number.isFinite));
  const findings = validFindings.slice(0,LIMIT).map(({type,pageIndex,bbox}) => ({type,pageIndex,bbox:[...bbox]}));
  const limitations = [];
  for (const item of result.limitations || []) {
    let safe = LIMITATIONS.includes(item) ? item :
      item.startsWith('Caption or associated image could not be uniquely observed:') ? 'Caption or associated image could not be uniquely observed.' :
      item.startsWith('Heading could not be uniquely observed:') ? 'Heading could not be uniquely observed.' : null;
    if (safe && !limitations.includes(safe)) limitations.push(safe);
  }
  if (result.status !== 'partial' && !limitations.includes('MuPDF unavailable.')) limitations.push('Layout inspection unavailable.');
  if (validFindings.length > LIMIT) limitations.push('Findings truncated.');
  const c = result.coverage;
  let coverage = null;
  if (c) {
    const p = {};
    for (const key of ['bodyLines','fontNames','captions','columns','headings']) p[key] = {checked:count(c.profile?.[key]?.checked),skipped:count(c.profile?.[key]?.skipped)};
    coverage = {pages:count(c.pages),textPaint:c.textPaint === true,images:c.images === true,vectorPlacements:count(c.vectorPlacements),unsupportedClipOperations:count(c.unsupportedClipOperations),clipping:'partial: axis-aligned rectangular paths only',captionOwnership:'only unique text and image matches',profile:p,findingsTruncated:validFindings.length > LIMIT};
  }
  return {schema:'falsify.latex-layout-audit.v1',outputPdfHash,status:result.status === 'partial' ? 'partial' : 'unavailable',findings,coverage,limitations};
}
