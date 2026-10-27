// Coverage is supplied by the host's font parser, not inferred from family names.
export async function inspectFonts(text, fonts = {}) {
  const codepoints = [...new Set(Array.from(text, c => c.codePointAt(0)))].filter(cp => cp !== 9 && cp !== 10 && cp !== 13);
  if (typeof fonts.hasGlyph !== 'function') return {status:'unavailable', missing:[], detail:'Font coverage API unavailable; full-font coverage and fallback are unverified.'};
  try {
    const missing = [];
    for (const cp of codepoints) if (!(await fonts.hasGlyph(cp))) missing.push(cp);
    return {status:missing.length ? 'missing' : 'covered', missing};
  } catch (error) { return {status:'unavailable', missing:[], detail:`Font coverage failed: ${error.message}`}; }
}

const isScalar = cp => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
const isLayoutControl = cp => cp === 0x09 || cp === 0x0a || cp === 0x0d;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

// Read the typographic family from the actual SFNT name table when available.
function fontFamily(bytes) {
  try {
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), tables=v.getUint16(4), decoder=new TextDecoder('utf-16be');
    for(let i=0;i<tables;i++) {
      const t=12+i*16; if(v.getUint32(t)!==0x6e616d65) continue;
      const base=v.getUint32(t+8), count=v.getUint16(base+2), strings=base+v.getUint16(base+4), names=[];
      for(let j=0;j<count;j++) {
        const n=base+6+j*12, platform=v.getUint16(n), language=v.getUint16(n+4), id=v.getUint16(n+6), len=v.getUint16(n+8), off=v.getUint16(n+10);
        if((id!==1 && id!==16) || (platform!==0 && platform!==3)) continue;
        const value=decoder.decode(bytes.subarray(strings+off,strings+off+len)).replace(/\0/g,'').trim();
        if(value) names.push({value,rank:(id===16?4:0)+(language===0x409?2:0)+(platform===3?1:0)});
      }
      return names.sort((a,b)=>b.rank-a.rank)[0]?.value || null;
    }
  } catch {} return null;
}

// The supplied text must be the union of all comparison variants.
export async function createFontPlan({text, fonts = []}, {mupdf} = {}) {
  if (typeof text !== 'string' || !Array.isArray(fonts)) throw new TypeError('Expected text and fonts array');
  const codepoints = [...new Set(Array.from(text, c => c.codePointAt(0)))];
  if (!codepoints.every(isScalar)) throw new TypeError('Text contains an invalid Unicode scalar');
  const glyphCodepoints = codepoints.filter(cp => !isLayoutControl(cp));
  const layoutControls = codepoints.filter(isLayoutControl);
  const ids = new Set();
  // Capture and validate every descriptor before asynchronous work begins.
  const snapshots = fonts.map(input => {
    const id = input?.id, family = input?.family, source = input?.bytes;
    if (typeof id !== 'string' || !id || ids.has(id) || typeof family !== 'string' || !family) throw new TypeError('Each font needs a unique id and family');
    ids.add(id);
    return {id, family, bytes: source instanceof ArrayBuffer ? new Uint8Array(source.slice(0)) : source instanceof Uint8Array ? Uint8Array.from(source) : null};
  });
  const candidates = [];
  for (const {id, family: suppliedFamily, bytes: snapshot} of snapshots) {
    let bytes, sha256 = null, buffer, font;
    const family=fontFamily(snapshot || new Uint8Array()) || suppliedFamily;
    const glyphs = new Map();
    let detail = null;
    try {
      if (!snapshot) throw new TypeError('Font bytes unavailable');
      bytes = snapshot;
      sha256 = hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
      if (!mupdf?.Buffer || !mupdf?.Font) throw new Error('MuPDF font API unavailable');
      buffer = new mupdf.Buffer(bytes);
      font = new mupdf.Font(id, buffer);
      for (const cp of glyphCodepoints) {
        const gid = font.encodeCharacter(cp);
        if (!Number.isInteger(gid) || gid < 0) throw new Error('Invalid glyph result');
        glyphs.set(cp, gid !== 0);
      }
    } catch (error) {
      detail = String(error?.message || error);
      glyphs.clear();
    } finally {
      try { font?.destroy(); } finally { buffer?.destroy(); }
    }
    const coverage = detail ? {status:'unavailable', missing:[], detail} : {status:glyphCodepoints.every(cp => glyphs.get(cp)) ? 'covered' : 'missing', missing:glyphCodepoints.filter(cp => !glyphs.get(cp))};
    candidates.push(Object.freeze({id, family, sha256, coverage: Object.freeze({...coverage, missing:Object.freeze(coverage.missing)}),
      getBytes: () => bytes?.slice() ?? null,
      hasGlyph: cp => isScalar(cp) && glyphs.has(cp) ? glyphs.get(cp) : null}));
  }
  const selected = candidates.find(c => c.coverage.status === 'covered') || null;
  const fallback = codepoints.map(codepoint => {
    if (isLayoutControl(codepoint)) return Object.freeze({codepoint, kind:'layout-control', fontId:null, family:null});
    const candidate = selected || candidates.find(c => c.hasGlyph(codepoint) === true);
    return Object.freeze({codepoint, kind:'glyph', fontId:candidate?.id ?? null, family:candidate?.family ?? null});
  });
  const missing = fallback.filter(x => x.kind === 'glyph' && x.fontId === null).map(x => x.codepoint);
  const unavailable = missing.length > 0 && candidates.some(c => c.coverage.status === 'unavailable') || candidates.length === 0;
  const status = unavailable ? 'unavailable' : missing.length ? 'missing' : 'covered';
  return Object.freeze({status, selected, candidates:Object.freeze(candidates), codepoints:Object.freeze(codepoints), layoutControls:Object.freeze(layoutControls), missing:Object.freeze(missing), fallback:Object.freeze(fallback),
    hasGlyph: cp => isScalar(cp) && codepoints.includes(cp) && !isLayoutControl(cp) ? (fallback.find(x => x.codepoint === cp).fontId !== null ? true : unavailable ? null : false) : null});
}
