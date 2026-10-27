import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {createBrowserFontStore} from '../src/browser-fonts.mjs';
import {prepare} from '../src/browser-pdf.mjs';

function fixture() {
  const d = new mupdf.PDFDocument(), f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(-1, d.addPage([0, 0, 612, 792], 0, {Font:{F:f}}, 'BT /F 12 Tf 72 700 Td (BEFORE) Tj 0 -30 Td (Keep this text) Tj ET'));
  const b = d.saveToBuffer(), bytes = b.asUint8Array().slice(); b.destroy(); d.destroy();
  return {name:'test.pdf', bytes};
}
async function snapshot(name) {
  const bytes = new Uint8Array(await readFile(new URL(`../dist/font-assets/${name}`, import.meta.url)));
  return createBrowserFontStore().resolve([], {fallbackFonts:[{bytes}]});
}
function text(bytes) { const d = new mupdf.PDFDocument(bytes); try { return d.loadPage(0).toStructuredText().asText(); } finally { d.destroy(); } }
for (const [name, replacement] of [['LiberationSerif-Regular.ttf', 'Omega Ω'], ['STIXTwoMath-Regular.otf', 'Beta β'], ['NotoSansCJKkr-Regular.otf', '한글']]) {
  test(`embeds ${name} and preserves unselected text`, async () => {
    const fontSnapshot = await snapshot(name), source = fixture();
    const result = await prepare({file:source, edits:[{id:'cell',pageIndex:0,before:'BEFORE',after:replacement}], fontSnapshot});
    const bytes = new Uint8Array(await result.file.arrayBuffer());
    assert.match(text(bytes), new RegExp(replacement)); assert.match(text(bytes), /Keep this text/);
    assert.equal(result.verification.checks.length, 0);
    assert.equal(result.verification.edits[0].encoding, 'glyph-id');
    assert.equal(result.verification.edits[0].fontSubstituted, true);
    const d = new mupdf.PDFDocument(bytes);
    try { const fonts = d.loadPage(0).getObject().get('Resources').get('Font'); let embedded = false;
      fonts.forEach(value => { const item = value.resolve(); if (item.get('Subtype').asName() === 'Type0') { assert.equal(item.get('ToUnicode').isStream(), true); const desc = item.get('DescendantFonts').get(0).get('FontDescriptor'); const stream = !desc.get('FontFile2').isNull() ? desc.get('FontFile2') : desc.get('FontFile3'); if (!stream.isNull()) { const buffer = stream.readStream(); const actual = buffer.asUint8Array().slice(); buffer.destroy(); assert.deepEqual(actual, fontSnapshot.fonts[0].bytes); embedded = true; } } });
      assert.equal(embedded, true);
    } finally { d.destroy(); }
  });
}
test('rejects tampered snapshot bytes', async () => {
  const fontSnapshot = await snapshot('LiberationSerif-Regular.ttf'); fontSnapshot.fonts[0].bytes[100] ^= 1;
  await assert.rejects(prepare({file:fixture(), edits:[{pageIndex:0,before:'BEFORE',after:'x'}], fontSnapshot}), {code:'invalid'});
});

test('same-family source subset gains a glyph from the supplied full font', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../dist/font-assets/LiberationSerif-Regular.ttf', import.meta.url)));
  const store = createBrowserFontStore();
  await store.addFiles([new File([bytes], 'LiberationSerif-Regular.ttf')]);
  const fontSnapshot = await store.resolve([{family:'Liberation Serif'}]);
  const first = await prepare({file:fixture(), edits:[{pageIndex:0,before:'BEFORE',after:'Omega'}], fontSnapshot:await snapshot('LiberationSerif-Regular.ttf')});
  const doc = new mupdf.PDFDocument(new Uint8Array(await first.file.arrayBuffer()));
  doc.subsetFonts(); const saved = doc.saveToBuffer(); const subset = saved.asUint8Array().slice(); saved.destroy(); doc.destroy();
  const result = await prepare({file:{name:'subset.pdf',bytes:subset}, edits:[{pageIndex:0,before:'Omega',after:'β'}], fontSnapshot});
  assert.match(text(new Uint8Array(await result.file.arrayBuffer())), /β/);
  assert.match(text(new Uint8Array(await result.file.arrayBuffer())), /Keep this text/);
  assert.equal(result.verification.edits[0].fontSubstituted, false);
  assert.equal(result.verification.checks.length, 0);
});

test('no snapshot retains legacy WinAnsi behavior', async () => {
  const result = await prepare({file:fixture(), edits:[{pageIndex:0,before:'BEFORE',after:'AFTER'}]});
  assert.match(text(new Uint8Array(await result.file.arrayBuffer())), /AFTER/);
  assert.equal(result.verification.edits[0].encoding, 'winansi');
  assert.equal(result.verification.checks.length, 0);
});
test('no-subsetting flag embeds the complete font bytes', async () => {
  const {createHash} = await import('node:crypto');
  const sha = data => createHash('sha256').update(data).digest('hex');
  const fontSnapshot = await snapshot('LiberationSerif-Regular.ttf'), face = fontSnapshot.fonts[0], v = new DataView(face.bytes.buffer, face.bytes.byteOffset, face.bytes.byteLength);
  for (let i = 0; i < v.getUint16(4); i++) { const pos = 12 + i * 16; if (v.getUint32(pos) === 0x4f532f32) { const o = v.getUint32(pos + 8) + 8; v.setUint16(o, v.getUint16(o) | 0x100); break; } }
  face.fsType |= 0x100; face.sha256 = sha(face.bytes);
  fontSnapshot.digest = sha(new TextEncoder().encode(JSON.stringify(fontSnapshot.fonts.map(({bytes, ...rest}) => rest))));
  const result = await prepare({file:fixture(), edits:[{pageIndex:0,before:'BEFORE',after:'Ω'}], fontSnapshot});
  const doc = new mupdf.PDFDocument(new Uint8Array(await result.file.arrayBuffer()));
  try { let actual; doc.loadPage(0).getObject().get('Resources').get('Font').forEach(value => {
    const item = value.resolve(); if (item.get('Subtype').asName() !== 'Type0') return;
    const b = item.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2').readStream(); actual = b.asUint8Array().slice(); b.destroy();
  }); assert.deepEqual(actual, face.bytes); } finally { doc.destroy(); }
});

test('least restrictive fsType bits are accepted and metadata must describe the font', async () => {
  const {createHash} = await import('node:crypto');
  const sha = data => createHash('sha256').update(data).digest('hex');
  const fonts = await snapshot('LiberationSerif-Regular.ttf'), face = fonts.fonts[0];
  const v = new DataView(face.bytes.buffer, face.bytes.byteOffset, face.bytes.byteLength);
  for (let i = 0; i < v.getUint16(4); i++) { const p = 12 + i * 16; if (v.getUint32(p) === 0x4f532f32) { v.setUint16(v.getUint32(p + 8) + 8, 0x106); break; } }
  face.fsType = 0x106; face.sha256 = sha(face.bytes);
  const digest = () => sha(new TextEncoder().encode(JSON.stringify(fonts.fonts.map(({bytes, ...rest}) => rest))));
  fonts.digest = digest();
  const edit = {pageIndex:0,before:'BEFORE',after:'Ω'};
  const out = await prepare({file:fixture(), edits:[edit], fontSnapshot:fonts});
  assert.match(text(new Uint8Array(await out.file.arrayBuffer())), /Ω/);
  face.family = 'Forged'; fonts.digest = digest();
  await assert.rejects(prepare({file:fixture(), edits:[edit], fontSnapshot:fonts}), {code:'invalid'});
});

test('queued requests capture font bytes and metadata before caller mutation', async () => {
  const fonts = await snapshot('LiberationSerif-Regular.ttf');
  const edit = {pageIndex:0,before:'BEFORE',after:'Ω'};
  const pending = prepare({file:fixture(), edits:[edit], fontSnapshot:fonts});
  fonts.fonts[0].bytes.fill(0); fonts.fonts[0].family = 'Changed'; fonts.digest = 'changed';
  const out = await pending;
  assert.match(text(new Uint8Array(await out.file.arrayBuffer())), /Ω/);
});

test('concurrent requests retain separate snapshots', async () => {
  const a = await snapshot('LiberationSerif-Regular.ttf'), b = await snapshot('STIXTwoMath-Regular.otf');
  const edit = {pageIndex:0,before:'BEFORE',after:'Ω'};
  const outputs = await Promise.all([a,b].map(fontSnapshot => prepare({file:fixture(), edits:[edit], fontSnapshot})));
  for (let i=0;i<outputs.length;i++) {
    const bytes=new Uint8Array(await outputs[i].file.arrayBuffer()); assert.match(text(bytes), /Ω/);
    const doc=new mupdf.PDFDocument(bytes); let embedded;
    try {doc.loadPage(0).getObject().get('Resources').get('Font').forEach(value => {
      const font=value.resolve(); if(font.get('Subtype').asName()!=='Type0') return;
      const desc=font.get('DescendantFonts').get(0).get('FontDescriptor');
      const stream=!desc.get('FontFile2').isNull()?desc.get('FontFile2'):desc.get('FontFile3');
      const buffer=stream.readStream(); embedded=buffer.asUint8Array().slice(); buffer.destroy();
    }); assert.deepEqual(embedded,[a,b][i].fonts[0].bytes);} finally {doc.destroy();}
  }
});
