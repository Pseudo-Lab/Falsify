import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {createBrowserFontStore} from '../src/browser-fonts.mjs';
import {scanTextShows} from '../src/paragraph-pdf-content-operators.mjs';
import {trySourceMarkerEdits} from '../src/paragraph-pdf-marker-path.mjs';
const bytes=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url)));
const font=await readFile(new URL('./fixtures/LMRoman7-Regular.otf',import.meta.url));
const store=createBrowserFontStore();await store.addFiles([new File([font],'LMRoman7-Regular.otf')]);const fontSnapshot=await store.resolve([{family:'LM Roman 7'}]);
const run=edits=>trySourceMarkerEdits({bytes,edits,fontSnapshot},{mupdf,scanTextShows});
test('full sentence source marker produces localized raster proof',async()=>{const result=await run([{id:'a',pageIndex:0,before:'An initial claim62 remains conditional.',after:'An initial claim63 remains conditional.'}]);assert.ok(result);assert.equal(result.reports[0].changedPixels,58);});
test('unsupported multiple changes never returns a partial result',async()=>{assert.equal(await run([{pageIndex:0,before:'62',after:'63'},{pageIndex:0,before:'An initial claim62 remains conditional.',after:'An initial claim64 remains conditional.'}]),null);assert.equal(await run([{pageIndex:0,before:'62',after:'73'}]),null);});
test('repeated quotes reject and leave no output',async()=>{
 const d=new mupdf.PDFDocument(bytes);let doubled;try{const p=d.findPage(0),c=p.get('Contents'),a=d.newArray();if(c.isArray())c.forEach(v=>a.push(v));else a.push(c);if(c.isArray())c.forEach(v=>a.push(v));else a.push(c);p.put('Contents',a);const b=d.saveToBuffer();try{doubled=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
 assert.equal(await trySourceMarkerEdits({bytes:doubled,edits:[{pageIndex:0,before:'62',after:'63'}],fontSnapshot},{mupdf,scanTextShows}),null);
});
test('shared resources and other page annotations and content stay unchanged',async()=>{
 const d=new mupdf.PDFDocument(bytes);let input;try{const p=d.findPage(0),resources=p.getInheritable('Resources');d.insertPage(-1,d.addPage([0,0,400,500],0,resources,'q 1 0 0 rg 10 10 20 20 re f Q'));d.findPage(1).put('Annots',[d.addObject({Type:'Annot',Subtype:'Text',Rect:[10,10,30,30],Contents:d.newString('preserved')})]);const b=d.saveToBuffer();try{input=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
 const result=await trySourceMarkerEdits({bytes:input,edits:[{pageIndex:0,before:'An initial claim62 remains conditional.',after:'An initial claim63 remains conditional.'}],fontSnapshot},{mupdf,scanTextShows});assert.ok(result);
 const a=new mupdf.PDFDocument(input),b=new mupdf.PDFDocument(result.bytes);try{const x=a.findPage(1),y=b.findPage(1);const xs=x.get('Contents').readStream(),ys=y.get('Contents').readStream();try{assert.deepEqual(xs.asUint8Array(),ys.asUint8Array());}finally{xs.destroy();ys.destroy();}assert.equal(y.get('Annots',0,'Contents').asString(),x.get('Annots',0,'Contents').asString());assert.equal(y.get('Resources','Font').toString(),x.get('Resources','Font').toString());}finally{a.destroy();b.destroy();}
});
