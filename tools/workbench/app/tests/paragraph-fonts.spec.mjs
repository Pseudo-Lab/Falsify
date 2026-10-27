import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {parseFont} from '../src/browser-fonts.mjs';
import {inspectPage, prepare} from '../dist/paragraph-pdf.mjs';

const path = new URL('../dist/vendor/standard_fonts/LiberationSans-Regular.ttf', import.meta.url);
const fontBytes = new Uint8Array(readFileSync(path));
function snapshot(bytes = fontBytes) {
  const parsed = parseFont(bytes), face = {id:'test', ...parsed, source:'file', sha256:hex(bytes)};
  // Registry metadata order is part of its digest contract.
  const descriptor = {id:face.id, family:face.family, ...(face.postscriptName ? {postscriptName:face.postscriptName} : {}), weight:face.weight, italic:face.italic, source:face.source, fsType:face.fsType, sha256:face.sha256};
  return {revision:1, digest:hex(new TextEncoder().encode(JSON.stringify([descriptor]))), fonts:[{...descriptor, bytes:bytes.slice()}]};
}
function fixture() {
  const d = new mupdf.PDFDocument(), f = new mupdf.Font('Liberation Sans', fontBytes), font = d.addSimpleFont(f);
  const text = 'BT /F1 12 Tf 72 700 Td (Original paragraph has enough words to edit safely.) Tj ET';
  d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},text));
  d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},'BT /F1 12 Tf 72 600 Td (Unrelated paragraph remains intact.) Tj ET')); d.subsetFonts();
  const buf = d.saveToBuffer(); const bytes = buf.asUint8Array().slice(); buf.destroy(); f.destroy(); d.destroy(); return bytes;
}
function extract(bytes) { const d=mupdf.Document.openDocument(bytes,'application/pdf'); let result=''; for(let i=0;i<d.countPages();i++){const p=d.loadPage(i),t=p.toStructuredText();result+=t.asText();t.destroy();p.destroy();}d.destroy();return result; }
const localFetch = async input => {const url=new URL(input); assert.equal(url.protocol,'file:');return new Response(readFileSync(url));};

test('font snapshot uses full font for glyph absent from subset', async () => {
  const prev=globalThis.fetch; globalThis.fetch=localFetch;
  try {
    const source=fixture(), fonts=snapshot();
    const before='Original paragraph has enough words to edit safely.';
    const after='Original paragraph has enough words to edit safely Ω.';
    const inspection=await inspectPage({file:source,pageIndex:0,fontSnapshot:fonts});
    assert.ok(inspection.paragraphs.some(p=>p.text===before));
    const out=await prepare({file:source,fontSnapshot:fonts,edits:[{pageIndex:0,before,after}]});
    const saved=new Uint8Array(await out.file.arrayBuffer());
    assert.ok(extract(saved).replace(/\s+/g,' ').includes(after.replace(/\s+/g,' ')), extract(saved));
    assert.ok(extract(saved).includes('Unrelated paragraph remains intact.'));
    assert.equal(out.verification.fontSnapshotDigest,fonts.digest);
    const doc=new mupdf.PDFDocument(saved);
    const sourceDoc=new mupdf.PDFDocument(source);
    const original=sourceDoc.findPage(0).get('Resources','Font','F1','FontDescriptor','FontFile2').readStream();
    const subset=new mupdf.Font('subset',original.asUint8Array());
    assert.equal(subset.encodeCharacter('Ω'),0, 'source subset lacks Omega'); subset.destroy(); original.destroy(); sourceDoc.destroy();
    const embedded=doc.findPage(0).get('Resources','Font','FXF3','DescendantFonts',0,'FontDescriptor','FontFile2');
    assert.equal(embedded.isStream(),true, 'new glyph has an embedded output font'); doc.destroy();
  } finally {globalThis.fetch=prev;}
});









test('simultaneous requests keep their font snapshots isolated and reject tampering', async () => {
  const prev=globalThis.fetch; globalThis.fetch=localFetch;
  try {
    const source=fixture(), regular=snapshot(), bold=snapshot(new Uint8Array(readFileSync(new URL('../dist/vendor/standard_fonts/LiberationSans-Bold.ttf',import.meta.url))));
    const edit={pageIndex:0,before:'Original paragraph has enough words to edit safely.',after:'Original paragraph has enough words to edit safely Ω.'};
    const [a,b]=await Promise.all([prepare({file:source,fontSnapshot:regular,edits:[edit]}),prepare({file:source,fontSnapshot:bold,edits:[edit]})]);
    const fontName=async out=>{const d=new mupdf.PDFDocument(new Uint8Array(await out.file.arrayBuffer()));try{const stream=d.findPage(0).get('Resources','Font','FXF3','DescendantFonts',0,'FontDescriptor','FontFile2').readStream();try{return hex(stream.asUint8Array());}finally{stream.destroy();}}finally{d.destroy();}};
    assert.notEqual(await fontName(a),await fontName(b), 'each output embeds its own font bytes');
    assert.equal(a.verification.fontSnapshotDigest,regular.digest); assert.equal(b.verification.fontSnapshotDigest,bold.digest);
    const bad=snapshot(); bad.fonts[0].bytes[100]^=1;
    await assert.rejects(inspectPage({file:source,pageIndex:0,fontSnapshot:bad}),{code:'invalid-font-snapshot'});
    const alias=snapshot(); alias.fonts[0].family='Fake';
    await assert.rejects(inspectPage({file:source,pageIndex:0,fontSnapshot:alias}),{code:'invalid-font-snapshot'});
  } finally {globalThis.fetch=prev;}
});


test('same-page unrelated subset paragraph survives font substitution', async () => {
  const prev=globalThis.fetch; globalThis.fetch=localFetch;
  try {
    const d=new mupdf.PDFDocument(), f=new mupdf.Font('Liberation Sans',fontBytes), font=d.addSimpleFont(f);
    d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},'BT /F1 12 Tf 72 700 Td (Original paragraph has enough words to edit safely.) Tj 0 -30 Td (Unrelated paragraph remains intact.) Tj ET'));
    d.subsetFonts(); const buf=d.saveToBuffer(), source=buf.asUint8Array().slice();buf.destroy();f.destroy();d.destroy();
    const out=await prepare({file:source,fontSnapshot:snapshot(),edits:[{pageIndex:0,before:'Original paragraph has enough words to edit safely.',after:'Original paragraph has enough words to edit safely Ω.'}]});
    assert.ok(extract(new Uint8Array(await out.file.arrayBuffer())).includes('Unrelated paragraph remains intact.'));
  } finally {globalThis.fetch=prev;}
});

test('static CFF OTF fallbacks preserve Korean and math glyphs', async () => {
  const prev=globalThis.fetch; globalThis.fetch=localFetch;
  try {
    for (const [name, glyph] of [['NotoSansCJKkr-Regular.otf','한'],['STIXTwoMath-Regular.otf','∑']]) {
      const bytes=new Uint8Array(readFileSync(new URL('../dist/font-assets/'+name,import.meta.url)));
      const before='Original paragraph has enough words to edit safely.', after=`Short ${glyph}.`;
      const out=await prepare({file:fixture(),fontSnapshot:snapshot(bytes),edits:[{pageIndex:0,before,after}]});
      const text=extract(new Uint8Array(await out.file.arrayBuffer())).replace(/\s+/g,' ');
      assert.ok(text.includes(glyph), `${name}: ${text}`);
      assert.ok(out.verification.fontSelections.some(f=>f.sha256===hex(bytes) && f.fallback), `fallback identity: ${name}`);
    }
  } finally {globalThis.fetch=prev;}
});

test('no-subsetting flag is rejected before PDFium can subset the font', async () => {
  const prev=globalThis.fetch; globalThis.fetch=localFetch;
  try {
    const bytes=fontBytes.slice(), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let i=0;i<view.getUint16(4);i++){const p=12+i*16;if(view.getUint32(p)===0x4f532f32){const o=view.getUint32(p+8)+8;view.setUint16(o,view.getUint16(o)|0x100);break;}}
    await assert.rejects(prepare({file:fixture(),fontSnapshot:snapshot(bytes),edits:[{pageIndex:0,before:'Original paragraph has enough words to edit safely.',after:'Original paragraph has enough words to edit safely Ω.'}]}),{code:'unsupported-font-license'});
  } finally {globalThis.fetch=prev;}
});

