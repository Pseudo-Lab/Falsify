import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {createBrowserFontStore} from '../src/browser-fonts.mjs';
import {scanTextShows} from '../src/paragraph-pdf-content-operators.mjs';
import {replaceMarkerGlyph} from '../src/paragraph-pdf-marker-surgery.mjs';

const source=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url)));
const font=await readFile(new URL('./fixtures/LMRoman7-Regular.otf',import.meta.url));
const store=createBrowserFontStore(); await store.addFiles([new File([font],'LMRoman7-Regular.otf')]);
const fontSnapshot=await store.resolve([{family:'LM Roman 7'}]);
function glyphs(bytes) {
  const d=new mupdf.PDFDocument(bytes), p=d.loadPage(0), inv=mupdf.Matrix.invert(p.getTransform()), out=[];
  const s=p.toStructuredText('preserve-whitespace');
  try { s.walk({onChar(c,o,f,size,quad){out.push({c,pdf:[o[0]*inv[0]+o[1]*inv[2]+inv[4],o[0]*inv[1]+o[1]*inv[3]+inv[5]],fontName:f.getName(),size,quad:[...quad]});}}); return out; }
  finally {s.destroy();p.destroy();d.destroy();}
}
function select(bytes,quote) {
  const all=glyphs(bytes), str=all.map(g=>g.c).join(''), pos=str.indexOf(quote);
  assert.ok(pos>=0, `missing ${quote}`); assert.equal(str.indexOf(quote,pos+1),-1);
  const marker=pos+quote.indexOf('62'); return all.slice(marker,marker+2);
}
const args=(quote='62',bytes=source)=>({bytes,pageIndex:0,glyphs:select(bytes,quote),after:'63',fontSnapshot,fontPostscriptName:'LMRoman7-Regular',scanTextShows,mupdf});
for (const quote of ['62','An initial claim62 remains conditional.']) test(`source stream preserves full page for ${quote}`,async()=>{
  const input=args(quote), result=await replaceMarkerGlyph(input); assert.ok(result); assert.equal(result.report.changedPixels,58);
  const before=glyphs(source), after=glyphs(result.bytes), at=before.findIndex(g=>g.pdf[0]===input.glyphs[1].pdf[0]&&g.pdf[1]===input.glyphs[1].pdf[1]);
  assert.equal(before[at].c,'2'); assert.equal(after[at].c,'3'); assert.equal(after[at-1].c,'6'); assert.deepEqual(before.map(g=>g.c).join('').replace('62','63'),after.map(g=>g.c).join(''));
  const d=new mupdf.PDFDocument(result.bytes); try {const fonts=d.findPage(0).get('Resources').get('Font'); let f; fonts.forEach(v=>{if(v.get('Subtype').asName()==='Type0') f=v;}); assert.ok(f); assert.ok(f.get('ToUnicode').isStream()); const embedded=f.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile3').readStream(); try {assert.deepEqual(embedded.asUint8Array(),fontSnapshot.fonts[0].bytes);} finally {embedded.destroy();}} finally {d.destroy();}
});
test('rejects ambiguous source shows and mismatched source font',async()=>{
  const input=args(); const duplicate=raw=>{const p=scanTextShows(raw); return {...p,shows:[...p.shows,...p.shows]};};
  assert.equal(await replaceMarkerGlyph({...input,scanTextShows:duplicate}),null);
  assert.equal(await replaceMarkerGlyph({...input,glyphs:input.glyphs.map(g=>({...g,fontName:'wrong-font'}))}),null);
});
test('rejects hidden marker and forged font snapshot',async()=>{
  const d=new mupdf.PDFDocument(source), obj=d.findPage(0), c=obj.get('Contents'), streams=d.newArray(); if(c.isArray()) c.forEach(v=>streams.push(v)); else streams.push(c);
  const g=select(source,'62')[0]; streams.push(d.addStream(new TextEncoder().encode(`q 0 g ${g.pdf[0]-3} ${g.pdf[1]-5} 20 20 re f Q`),{})); obj.put('Contents',streams);
  const buf=d.saveToBuffer(), masked=buf.asUint8Array().slice(); buf.destroy();d.destroy();
  assert.equal(await replaceMarkerGlyph(args('62',masked)),null);
  const input=args(); const snapshot={...fontSnapshot,fonts:fontSnapshot.fonts.map(f=>({...f,bytes:f.bytes.slice()}))}; snapshot.fonts[0].bytes[100]^=1;
  assert.equal(await replaceMarkerGlyph({...input,fontSnapshot:snapshot}),null);
});
