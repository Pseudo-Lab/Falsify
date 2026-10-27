const MARKER = 'FALSIFY RED TEAM TRAINING COPY | INTENTIONALLY ALTERED | NOT ORIGINAL';
const MARKER_ID = 'falsify-red-training-copy';
const markerHex = '46414c5349465920524544205445414d20545241494e494e4720434f505920207c2020494e54454e54494f4e414c4c5920414c544552454420207c20204e4f54204f524947494e414c';
const markerStream = /^\s*q\s+BT\s+1 0 0 1 30 17\.8 Tm\s+\/helv 7\.1 Tf \.55 \.25 \.14 RG \.55 \.25 \.14 rg \[<([a-f\d]+)>\]TJ\s+ET\s+Q\s*$/i;
const bannerStream = /^\s*q\s+25 13 (?:545\.276|562) 14 re\s+h\s+\.98 \.94 \.87 rg f\s+Q\s*$/;
const decoder = new TextDecoder('latin1');
function abort(signal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function fail(message) { const e = new Error(message); e.code = 'unsafe-marker-stream'; throw e; }
function normalize(text) { return text.replace(/\s+/g, ' ').trim(); }
function isMarkerStream(text){const match=markerStream.exec(text);return !!match&&match[1].length%2===0&&normalize(decoder.decode(Uint8Array.from(match[1].match(/../g),h=>parseInt(h,16))))===MARKER;}
function withoutMarker(text) { return normalize(text).replace(MARKER, '').trim(); }
function streams(doc, index) {
  const obj = doc.findPage(index).get('Contents');
  if (obj.isNull()) return [];
  return obj.isArray() ? Array.from({length: obj.length}, (_, i) => obj.get(i)) : [obj];
}
function decoded(ref) { if (!ref.isStream()) fail('Page content is not a stream'); const b = ref.readStream(); try { return b.asUint8Array().slice(); } finally { b.destroy(); } }
function textOf(doc, i) { const page = doc.loadPage(i), text = page.toStructuredText(); try { return text.asText(); } finally { text.destroy(); page.destroy(); } }
async function hash(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join(''); }
function comparePixels(a, b, engine) {
  const p = a.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false);
  const q = b.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false);
  if (p.getWidth() !== q.getWidth() || p.getHeight() !== q.getHeight() || p.getStride() !== q.getStride()) return false;
  const x = p.getPixels(), y = q.getPixels(), stride = p.getStride();
  // The known band is the bottom 27 points; include a small antialiasing margin.
  const limit = Math.max(0, p.getHeight() - 29) * stride;
  let same = true;
  for (let i = 0; i < limit; i++) if (x[i] !== y[i]) { same = false; break; }
  p.destroy(); q.destroy(); a.destroy(); b.destroy();
  return same;
}
export async function prepare({file, signal}) {
  abort(signal);
  const bytes = file.bytes instanceof Uint8Array ? new Uint8Array(file.bytes) : new Uint8Array(await file.arrayBuffer());
  abort(signal);
  const shaOriginal = await hash(bytes); abort(signal);
  const engine = await import('./browser-pdf-vendor/mupdf.js'); abort(signal);
  const source = engine.Document.openDocument(bytes, 'application/pdf');
  if (!(source instanceof engine.PDFDocument)) { source.destroy(); fail('Not a PDF'); }
  let original, result;
  try {
  if (source.needsPassword()) fail('Encrypted PDF is not supported');
  const count = source.countPages(), plans = [], expected = [], beforeText = [];
  for (let i = 0; i < count; i++) {
    abort(signal);
    const text = normalize(textOf(source, i)); beforeText.push(text);
    const refs = streams(source, i), data = refs.map(decoded), raw = data.map(x => decoder.decode(x));
    const marks = raw.map((s, n) => isMarkerStream(s) ? n : -1).filter(n => n >= 0);
    const bands = raw.map((s, n) => bannerStream.test(s) ? n : -1).filter(n => n >= 0);
    const hasText = text.includes(MARKER);
    const suspicious = raw.some(s => s.toLowerCase().includes(markerHex) || s.includes(MARKER));
    if (hasText || marks.length || suspicious) {
      if (!hasText || marks.length !== 1 || bands.length !== 1 || bands[0] + 1 !== marks[0] || marks[0] !== refs.length - 1) fail(`Marker on page ${i + 1} is not safely separable`);
      const page = source.loadPage(i), bounds = page.getBounds(), hits = page.search(MARKER);
      if (bounds[0] !== 0 || bounds[1] !== 0 || hits.length !== 1 || hits[0].length !== 1) fail(`Marker geometry on page ${i + 1} is unsafe`);
      const quad = hits[0][0], bbox = [Math.min(quad[0],quad[2],quad[4],quad[6]), Math.min(quad[1],quad[3],quad[5],quad[7]), Math.max(quad[0],quad[2],quad[4],quad[6]), Math.max(quad[1],quad[3],quad[5],quad[7])];
      if (bbox[0] < 29 || bbox[2] > 320 || bbox[1] < bounds[3]-29 || bbox[3] > bounds[3]-10) fail(`Marker geometry on page ${i + 1} is unsafe`);
      page.destroy();
      plans.push({pageIndex:i, marker:marks[0], banner:bands[0], bbox});
    }
    expected.push(data.filter((_, n) => !marks.includes(n) && !(marks.length && bands.includes(n))));
  }
  if (!plans.length) return {file, sha256:shaOriginal, changed:false, removed:[], verification:{status:'passed', pageCount:count, unchangedBytes:true}};
  for (const plan of plans) {
    const page = source.findPage(plan.pageIndex), refs = streams(source, plan.pageIndex), next = source.newArray();
    refs.forEach((ref, n) => { if (n !== plan.marker && n !== plan.banner) next.push(ref); });
    page.put('Contents', next);
  }
  const saved = source.saveToBuffer('garbage=1');
  let out; try { out = saved.asUint8Array().slice(); } finally { saved.destroy(); }
  abort(signal);
  original = engine.Document.openDocument(bytes, 'application/pdf');
  result = engine.Document.openDocument(out, 'application/pdf');
  if (result.countPages() !== count) fail('Page count changed');
  for (let i = 0; i < count; i++) {
    abort(signal);
    const after = normalize(textOf(result, i));
    if (after.includes(MARKER) || withoutMarker(beforeText[i]) !== after) fail(`Text verification failed on page ${i + 1}`);
    const actual = streams(result, i).map(decoded), prior = expected[i];
    if (actual.length !== prior.length || actual.some((a,n) => a.length !== prior[n].length || a.some((b,j) => b !== prior[n][j]))) fail(`Stream verification failed on page ${i + 1}`);
    if (!comparePixels(original.loadPage(i), result.loadPage(i), engine)) fail(`Rendering changed outside footer on page ${i + 1}`);
  }
  const sha256 = await hash(out); abort(signal);
  const output = typeof File === 'function' ? new File([out], file.name || 'document.pdf', {type:'application/pdf'}) : {name:file.name || 'document.pdf', type:'application/pdf', bytes:out, arrayBuffer:async () => out.buffer.slice(out.byteOffset,out.byteOffset+out.byteLength)};
  return {file:output, sha256, changed:true, removed:plans.map(p => ({pageIndex:p.pageIndex,bbox:p.bbox,markerId:MARKER_ID})), verification:{status:'passed',pageCount:count,preservedContentStreams:true,bodyText:true,markerAbsent:true,bannerAbsent:true,renderOutsideFooter:true,renderExcludedBottomPoints:29}};
  } finally { if (result) result.destroy(); if (original) original.destroy(); source.destroy(); }
}
