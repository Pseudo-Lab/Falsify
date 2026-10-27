import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserFontStore, parseFont } from '../src/browser-fonts.mjs';

const load = async style => new Uint8Array(await readFile(new URL(`../dist/vendor/standard_fonts/LiberationSans-${style}.ttf`, import.meta.url)));
const file = (name, bytes) => ({ name, arrayBuffer: async () => bytes.slice().buffer });
const local = (name, bytes, reads) => ({ family: 'Liberation Sans', postscriptName: `LiberationSans-${name}`, style: name, blob: async () => { reads.push(name); return new Blob([bytes]); } });

test('actual font metadata, style selection, subset aliases and isolated snapshots', async () => {
  const store = createBrowserFontStore();
  await store.addFiles(await Promise.all(['Regular', 'Bold', 'Italic'].map(async s => file(`${s}.ttf`, await load(s)))));
  assert.equal(store.revision, 1);
  assert.deepEqual(store.list().map(({ family, weight, italic }) => [family, weight, italic]), [
    ['Liberation Sans', 400, false], ['Liberation Sans', 700, false], ['Liberation Sans', 400, true],
  ]);
  const first = await store.resolve([{ family: 'ABCDEF+LiberationSans-Bold', bold: true, text: 'A' }, { family: 'Liberation Sans', italic: true, text: 'B' }]);
  assert.deepEqual(first.fonts.map(f => [f.weight, f.italic]), [[700, false], [400, true]]);
  const initial = first.fonts[0].bytes[0];
  first.fonts[0].bytes[0] ^= 255;
  const again = await store.resolve([{ family: 'ABCDEF+LiberationSans-Bold', bold: true, text: 'A' }, { family: 'Liberation Sans', italic: true, text: 'B' }]);
  assert.equal(again.fonts[0].bytes[0], initial);
  assert.equal(again.digest, first.digest);
  assert.notEqual((await store.resolve([{ family: 'Liberation Sans', text: 'A' }])).digest, first.digest);
  assert.equal((await store.resolve([{ family: 'Liberation', text: 'A' }])).fonts.length, 0);
  store.clear(); assert.equal(store.revision, 2); assert.deepEqual(store.list(), []);
});

test('enumeration is lazy, retries denial, and bundled fallback is truthful', async () => {
  const reads = [], regular = await load('Regular'), bold = await load('Bold');
  let attempts = 0;
  const store = createBrowserFontStore({ queryLocalFonts: async () => {
    if (++attempts === 1) throw new Error('denied');
    return [local('Regular', regular, reads), local('Bold', bold, reads)];
  } });
  await assert.rejects(store.requestLocalFonts(), /권한/);
  assert.equal(store.revision, 0);
  await store.requestLocalFonts(); await store.requestLocalFonts();
  assert.equal(store.revision, 3); assert.deepEqual(reads, []);
  const snap = await store.resolve([{ family: 'Liberation Sans', bold: true, text: 'A' }], { fallbackFonts: [{ bytes: regular }] });
  assert.deepEqual(reads, ['Bold']);
  assert.deepEqual(snap.fonts.map(f => [f.family, f.weight, f.source]), [['Liberation Sans', 700, 'local'], ['Liberation Sans', 400, 'bundled']]);
  await assert.rejects(createBrowserFontStore({ queryLocalFonts: false }).requestLocalFonts(), /지원하지 않습니다/);
});

test('malformed, collections, variable and restricted fonts are rejected without losing prior faces', async () => {
  const bytes = await load('Regular'), store = createBrowserFontStore();
  await store.addFiles([file('ok.ttf', bytes)]);
  await assert.rejects(store.addFiles([file('bad.ttf', new Uint8Array([0, 1]))]), /올바른/);
  await assert.rejects(store.addFiles([file('bad.ttc', bytes)]), /TTF 또는 OTF/);
  const collection = bytes.slice(); collection.set([0x74, 0x74, 0x63, 0x66]);
  await assert.rejects(store.addFiles([file('collection.ttf', collection)]), /컬렉션/);
  const restricted = bytes.slice(), view = new DataView(restricted.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const p = 12 + i * 16;
    if (String.fromCharCode(...restricted.slice(p, p + 4)) === 'OS/2') view.setUint16(view.getUint32(p + 8) + 8, 2);
  }
  await assert.rejects(store.addFiles([file('restricted.ttf', restricted)]), /임베딩 제한/);
  const variable = bytes.slice(); variable.set([0x66, 0x76, 0x61, 0x72], 12);
  await assert.rejects(store.addFiles([file('variable.ttf', variable)]), /가변 글꼴/);
  assert.equal(store.revision, 1); assert.equal(store.list().length, 1);
});

// Minimal bounded SFNT metadata fixture; no host fonts or permissions required.
function fixture(family, postscript, weight = 400, italic = false, fsType = 0) {
  const strings = [family, postscript].map(s => Buffer.from([...s].flatMap(c => [0, c.charCodeAt(0)])));
  const name = Buffer.alloc(30 + strings[0].length + strings[1].length);
  name.writeUInt16BE(2, 2); name.writeUInt16BE(30, 4);
  for (let i = 0, off = 0; i < 2; i++) {
    const p = 6 + i * 12; name.writeUInt16BE(3, p); name.writeUInt16BE(1, p + 2);
    name.writeUInt16BE(0x409, p + 4); name.writeUInt16BE(i ? 6 : 1, p + 6);
    name.writeUInt16BE(strings[i].length, p + 8); name.writeUInt16BE(off, p + 10);
    strings[i].copy(name, 30 + off); off += strings[i].length;
  }
  const os2 = Buffer.alloc(64), head = Buffer.alloc(46);
  os2.writeUInt16BE(weight, 4); os2.writeUInt16BE(fsType, 8); os2.writeUInt16BE(italic ? 1 : 0, 62);
  const parts = [['name', name], ['OS/2', os2], ['head', head]], out = Buffer.alloc(60 + parts.reduce((n, p) => n + p[1].length, 0));
  out.writeUInt32BE(0x10000, 0); out.writeUInt16BE(3, 4);
  let offset = 60;
  parts.forEach(([tag, data], i) => { const p = 12 + i * 16; out.write(tag, p); out.writeUInt32BE(offset, p + 8); out.writeUInt32BE(data.length, p + 12); data.copy(out, offset); offset += data.length; });
  return new Uint8Array(out);
}

test('PostScript aliases select the corresponding full family and style', async () => {
  const store = createBrowserFontStore();
  await store.addFiles([
    file('t.ttf', fixture('Times New Roman', 'TimesNewRomanPSMT')),
    file('tb.ttf', fixture('Times New Roman', 'TimesNewRomanPS-BoldItalicMT', 700, true)),
    file('a.ttf', fixture('Arial', 'ArialMT')),
    file('ab.ttf', fixture('Arial', 'Arial-BoldMT', 700)),
    file('other.ttf', fixture('Arial Narrow', 'ArialNarrow', 400)),
  ]);
  const snap = await store.resolve([{ family: 'ABCDEF+TimesNewRomanPS-BoldItalicMT' }, { family: 'ArialMT-Bold' }, { family: 'Arial Narrow' }]);
  assert.deepEqual(snap.fonts.map(f => [f.family, f.weight, f.italic]), [['Times New Roman', 700, true], ['Arial', 700, false], ['Arial Narrow', 400, false]]);
  assert.equal((await store.resolve([{ family: 'Arial Narrower' }])).fonts.length, 0);
});

test('unusable local face is noted and public fallback remains available', async () => {
  const good = fixture('Example', 'Example-Regular');
  const bad = fixture('Example', 'Example-Bold', 700, false, 2);
  const store = createBrowserFontStore({ queryLocalFonts: async () => [{ family: 'Example', postscriptName: 'Example-Bold', style: 'Bold', blob: async () => new Blob([bad]) }] });
  await store.requestLocalFonts();
  const result = await store.resolve([{ family: 'Example', bold: true }], { fallbackFonts: [{ bytes: good }] });
  assert.equal(result.fonts[0].source, 'bundled');
  assert.equal(result.notes.length, 1); assert.match(result.notes[0].message, /임베딩 제한/);
});

test('clearing or re-requesting invalidates pending operations and resolve snapshots', async () => {
  let releaseBlob, releaseQuery;
  const data = fixture('Example', 'Example-Regular');
  const localFace = { family: 'Example', postscriptName: 'Example-Regular', style: 'Regular', blob: () => new Promise(resolve => { releaseBlob = () => resolve(new Blob([data])); }) };
  let calls = 0;
  const store = createBrowserFontStore({ queryLocalFonts: () => ++calls === 1 ? Promise.resolve([localFace]) : new Promise(resolve => { releaseQuery = resolve; }) });
  await store.requestLocalFonts();
  const pending = store.resolve([{ family: 'Example' }]);
  store.clear(); releaseBlob();
  await assert.rejects(pending, /변경/); assert.deepEqual(store.list(), []);
  const query = store.requestLocalFonts(); store.clear(); releaseQuery([localFace]);
  await assert.rejects(query, /변경/); assert.deepEqual(store.list(), []);
});

test('parseFont exports bounded parsing and honors least restrictive embedding bits', () => {
  assert.throws(() => parseFont(new Uint8Array([0, 1])), /올바른/);
  assert.equal(parseFont(fixture('Example', 'Example', 400, false, 0x10e)).fsType, 0x10e);
  assert.throws(() => parseFont(fixture('Example', 'Example', 400, false, 0x202)), /임베딩 제한/);
});

test('new permission request replaces handles and invalidates an in-flight resolution', async () => {
  const bytes = fixture('Example', 'Example-Regular'); let release, calls = 0;
  const oldFace = { family: 'Example', postscriptName: 'Example-Regular', style: 'Regular', blob: () => new Promise(r => { release = () => r(new Blob([bytes])); }) };
  const newFace = { ...oldFace, blob: async () => new Blob([bytes]) };
  const store = createBrowserFontStore({ queryLocalFonts: async () => [++calls === 1 ? oldFace : newFace] });
  await store.requestLocalFonts();
  const pending = store.resolve([{ family: 'Example' }]);
  await store.requestLocalFonts(); release();
  await assert.rejects(pending, /변경/);
  assert.equal((await store.resolve([{ family: 'Example' }])).fonts.length, 1);
});
