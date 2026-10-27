const error = message => new Error(message);
const key = value => String(value || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[\s_-]+/g, '');
const style = value => ({ weight: /bold/i.test(value || '') ? 700 : 400, italic: /italic|oblique/i.test(value || '') });

// Read only bounded SFNT tables; collections and variable fonts are deliberately unsupported.
export function parseFont(bytes) {
  const bad = () => { throw error('올바른 TTF 또는 OTF 글꼴 파일을 선택해 주세요.'); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = o => { if (o < 0 || o + 2 > bytes.length) bad(); return view.getUint16(o); };
  const u32 = o => { if (o < 0 || o + 4 > bytes.length) bad(); return view.getUint32(o); };
  const tag = o => String.fromCharCode(...bytes.subarray(o, o + 4));
  const sig = u32(0);
  if (sig === 0x74746366) throw error('글꼴 컬렉션(TTC/OTC)은 지원하지 않습니다. 단일 TTF 또는 OTF를 선택해 주세요.');
  if (sig !== 0x00010000 && sig !== 0x4f54544f && sig !== 0x74727565) bad();
  const count = u16(4), tables = new Map();
  if (!count || 12 + count * 16 > bytes.length) bad();
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, name = tag(p), offset = u32(p + 8), length = u32(p + 12);
    if (offset > bytes.length || length > bytes.length - offset || tables.has(name)) bad();
    tables.set(name, { offset, length });
  }
  if (tables.has('fvar')) throw error('가변 글꼴은 지원하지 않습니다. 고정 굵기의 TTF 또는 OTF를 선택해 주세요.');
  const names = tables.get('name'), os2 = tables.get('OS/2'), head = tables.get('head');
  if (!names || names.length < 6 || !os2 || os2.length < 64 || !head || head.length < 46) bad();
  const n = names.offset, entries = u16(n + 2), strings = n + u16(n + 4), end = n + names.length;
  if (n + 6 + entries * 12 > end || strings > end) bad();
  const values = new Map();
  for (let i = 0; i < entries; i++) {
    const p = n + 6 + i * 12, platform = u16(p), encoding = u16(p + 2), language = u16(p + 4), id = u16(p + 6), length = u16(p + 8), start = strings + u16(p + 10);
    if (start > end || length > end - start) bad();
    if (![1, 2, 6, 16, 17].includes(id)) continue;
    let text;
    if (platform === 0 || platform === 3) {
      if (length % 2) bad();
      text = ''; for (let j = 0; j < length; j += 2) text += String.fromCharCode(u16(start + j));
    } else if (platform === 1 && encoding === 0) text = String.fromCharCode(...bytes.subarray(start, start + length));
    else continue;
    text = text.replace(/\0/g, '').trim();
    const score = (platform === 3 ? 4 : platform === 0 ? 3 : 1) + (language === 0x409 ? 2 : 0);
    if (text && (!values.has(id) || values.get(id).score < score)) values.set(id, { text, score });
  }
  const get = id => values.get(id)?.text;
  const family = get(16) || get(1), postscriptName = get(6);
  if (!family) bad();
  const weight = u16(os2.offset + 4), fsType = u16(os2.offset + 8), selection = u16(os2.offset + 62), macStyle = u16(head.offset + 44);
  if (weight < 1 || weight > 1000) bad();
  if ((fsType & 0x200) || ((fsType & 0x2) && !(fsType & 0xc))) throw error('이 글꼴은 임베딩 제한 또는 비트맵 전용 제한이 있어 PDF에 사용할 수 없습니다. 다른 글꼴을 선택해 주세요.');
  return { family, ...(postscriptName ? { postscriptName } : {}), weight, italic: Boolean((selection & 1) || (macStyle & 2)), fsType };
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function familyKey(value) {
  let name = String(value || '').replace(/^[A-Z]{6}\+/, '');
  name = name.replace(/^(TimesNewRomanPS|Arial)-(BoldItalic|BoldOblique|Bold|Italic|Oblique)MT$/i, (_, family, variant) => `${/^arial$/i.test(family) ? 'Arial' : 'TimesNewRoman'}-${variant}`);
  name = name.replace(/[-,](?:bolditalic|boldoblique|bold|italic|oblique|regular|roman)$/i, '');
  const normalized = key(name);
  return ({ timesnewromanpsmt: 'timesnewroman', arialmt: 'arial' })[normalized] || normalized;
}
function matches(face, req) {
  const wanted = familyKey(req.family);
  return !!wanted && (familyKey(face.family) === wanted || familyKey(face.postscriptName) === wanted);
}
function rank(face, req) {
  const suffix = String(req.family || '').match(/[-,](bolditalic|boldoblique|bold|italic|oblique|regular|roman)(?:mt)?$/i)?.[1] || '';
  const bold = req.bold || /bold/i.test(suffix), italic = req.italic || /italic|oblique/i.test(suffix);
  return (face.italic === !!italic ? 0 : 1000) + Math.abs(face.weight - (bold ? 700 : 400));
}
function metadata(face) {
  const { id, family, postscriptName, weight, italic, source, fsType } = face;
  return { id, family, ...(postscriptName ? { postscriptName } : {}), weight, italic, source, ...(fsType === undefined ? {} : { fsType }) };
}

export function createBrowserFontStore(options = {}) {
  let revision = 0, faces = [], epoch = 0, requestSerial = 0;
  const stale = () => error('글꼴 목록이 변경되었습니다. 다시 시도해 주세요.');
  const materialize = async (face, expectedEpoch) => {
    if (!face.bytes) {
      let raw;
      try { raw = new Uint8Array(await (await face.fontData.blob()).arrayBuffer()); }
      catch { throw error('로컬 글꼴을 읽지 못했습니다. 권한을 확인하거나 글꼴 파일을 직접 선택해 주세요.'); }
      const parsed = parseFont(raw);
      const hash = await sha256(raw);
      if (epoch !== expectedEpoch) throw stale();
      Object.assign(face, parsed, { bytes: raw.slice(), sha256: hash });
    }
    return face;
  };
  return {
    get revision() { return revision; },
    list() { return faces.map(metadata); },
    clear() { epoch++; requestSerial++; if (faces.length) { faces = []; revision++; } },
    async requestLocalFonts() {
      const query = options.queryLocalFonts ?? globalThis.queryLocalFonts;
      if (typeof query !== 'function') throw error('이 브라우저는 로컬 글꼴 접근을 지원하지 않습니다. TTF 또는 OTF 파일을 직접 선택해 주세요.');
      const serial = ++requestSerial, expectedEpoch = ++epoch;
      if (faces.some(f => f.source === 'local')) {
        faces = faces.filter(f => f.source !== 'local');
        revision++;
      }
      let result;
      try { result = await query.call(globalThis); }
      catch { throw error('로컬 글꼴 접근이 거부되었거나 실패했습니다. 브라우저 권한을 확인한 후 다시 시도하거나 파일을 선택해 주세요.'); }
      if (serial !== requestSerial || epoch !== expectedEpoch) throw stale();
      const next = [], existing = new Set();
      for (const fontData of result) {
        if (!fontData.family || !fontData.postscriptName || typeof fontData.blob !== 'function') continue;
        const id = `local:${fontData.postscriptName}`;
        if (existing.has(id)) continue;
        existing.add(id);
        next.push({ id, family: fontData.family, postscriptName: fontData.postscriptName, ...style(fontData.style), source: 'local', fontData });
      }
      const previous = faces.filter(f => f.source === 'local');
      if (previous.length || next.length) {
        faces = [...faces.filter(f => f.source !== 'local'), ...next];
        revision++; epoch++;
      }
      return faces.map(metadata);
    },
    async addFiles(fileList) {
      const expectedEpoch = epoch;
      const staged = [];
      for (const file of Array.from(fileList || [])) {
        if (!/\.(ttf|otf)$/i.test(file.name || '')) throw error('TTF 또는 OTF 글꼴 파일을 선택해 주세요.');
        let bytes;
        try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { throw error('글꼴 파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.'); }
        const parsed = parseFont(bytes), hash = await sha256(bytes);
        staged.push({ id: `file:${hash}`, ...parsed, source: 'file', bytes: bytes.slice(), sha256: hash });
      }
      if (epoch !== expectedEpoch) throw stale();
      const ids = new Set(faces.map(f => f.id));
      let changed = false;
      for (const face of staged) if (!ids.has(face.id)) { faces.push(face); ids.add(face.id); changed = true; }
      if (changed) { revision++; epoch++; }
      return faces.map(metadata);
    },
    async resolve(requirements, { fallbackFonts = [] } = {}) {
      const selected = [], notes = [], expectedEpoch = epoch, snapshotRevision = revision;
      const snapshot = faces.slice();
      for (const req of requirements || []) {
        const candidates = snapshot.filter(f => matches(f, req)).sort ( (a, b) => rank(a, req) - rank(b, req));
        for (const candidate of candidates) {
          try {
            const face = await materialize(candidate, expectedEpoch);
            if (matches(face, req)) { if (!selected.includes(face)) selected.push(face); break; }
          } catch (cause) {
            if (epoch !== expectedEpoch) throw stale();
            if (candidate.source !== 'local') throw cause;
            notes.push({ id: candidate.id, message: cause.message });
          }
        }
      }
      for (const fallback of fallbackFonts) {
        const bytes = new Uint8Array(fallback.bytes).slice(), parsed = parseFont(bytes), hash = await sha256(bytes);
        if (!selected.some(f => f.sha256 === hash)) selected.push({ id: fallback.id || `bundled:${hash}`, ...parsed, source: 'bundled', bytes, sha256: hash });
      }
      const snapshotFaces = selected.map(face => ({ ...metadata(face), sha256: face.sha256, bytes: face.bytes.slice() }));
      const digestInput = new TextEncoder().encode(JSON.stringify(snapshotFaces.map(({ bytes, ...rest }) => rest)));
      const digest = await sha256(digestInput);
      if (epoch !== expectedEpoch) throw stale();
      return { revision: snapshotRevision, digest, fonts: snapshotFaces, notes };
    },
  };
}
