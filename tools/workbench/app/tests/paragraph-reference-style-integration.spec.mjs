import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import create from '../src/paragraph-vendor/runtime/editcore.js';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {inspectSavedPdf} from '../src/paragraph-vendor/quality.mjs';
const app=process.cwd();
const bundle=await build({stdin:{contents:'export {PdfEngine} from "./src/paragraph-vendor/engine/core.js";export {editPdf} from "./src/paragraph-vendor/editor.mjs";export {commitNumericMarker} from "./src/paragraph-vendor/inline-preservation.mjs";',resolveDir:app},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'native-runtime',setup(b){b.onResolve({filter:/^\.\/runtime\.mjs$/},()=>({path:resolve('src/paragraph-pdf-runtime.mjs')}));b.onResolve({filter:/engine-loader\.js$/},()=>({path:resolve('src/paragraph-pdf-engine-loader.mjs')}));b.onResolve({filter:/freetext-script$/},()=>({path:resolve('src/paragraph-vendor/utils/freetext-script.ts')}));}}]});
const {PdfEngine,editPdf,commitNumericMarker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
async function engineFactory(bytes){const M=await create({wasmBinary:await readFile('src/paragraph-vendor/runtime/editcore.wasm'),print(){},printErr(){}});const cfg=M._malloc(48);M.HEAPU8.fill(0,cfg,cfg+48);M.HEAPU32[cfg>>2]=2;M._FPDF_InitLibraryWithConfig(cfg);M._free(cfg);const e=new PdfEngine(M);if(bytes)e.open(bytes);return e;}
function fixture(wide=false){const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Times-Roman')),resources={Font:{F1:font}};
const content='BT /F1 12 Tf 60 400 Td (Example Author) Tj ET BT /F1 8 Tf 0 0 1 rg 140 404 Td (2) Tj ET BT /F1 8 Tf 0 0 0 rg 144 404 Td (,) Tj ET BT /F1 8 Tf 0 0 1 rg 146 404 Td (3) Tj ET BT /F1 12 Tf 158 400 Td (, Other Author) Tj ET BT /F1 12 Tf 60 350 Td (Evidence below stays in place.) Tj ET';
d.insertPage(-1,d.addPage([0,0,500,500],0,resources,content+(wide?' BT /F1 12 Tf 60 300 Td (A longer body line sets the original column width and remains unchanged.) Tj ET':'')));d.insertPage(-1,d.addPage([0,0,500,500],0,resources,'BT /F1 12 Tf 60 400 Td (Unedited second page.) Tj ET'));const bytes=d.saveToBuffer().asUint8Array().slice();d.destroy();return bytes;}
function raster(d,i){const p=d.loadPage(i),pix=p.toPixmap([2,0,0,2,0,0],mupdf.ColorSpace.DeviceRGB,false),bytes=pix.getPixels().slice(),width=pix.getWidth(),height=pix.getHeight();pix.destroy();p.destroy();return {bytes,width,height};}

function reorderedFixture(after=false, corrupt=false) {
 const d=new mupdf.PDFDocument();
 try {
  const font=d.addSimpleFont(new mupdf.Font('Courier'));
  const word=after?'new':'old';
  // Stream order differs from physical left-to-right order on the source.
  const content=after
   ? `BT /F1 12 Tf 60 300 Td (prefix ${word} suffix) Tj ET`
   : `BT /F1 12 Tf 110.4 300 Td (${word} suffix) Tj ET BT /F1 12 Tf 60 300 Td (prefix ) Tj ET`;
  d.insertPage(-1,d.addPage([0,0,500,500],0,{Font:{F1:font}},content+` BT /F1 12 Tf 60 200 Td (${corrupt?'Lost':'Kept'} evidence.) Tj ET`));
  const bytes=d.saveToBuffer();try{return bytes.asUint8Array().slice();}finally{bytes.destroy();}
 }finally{d.destroy();}
}

test('saved-file validation computes expected text in physical order when raw Before is absent',async()=>{
 const edits=[{id:'phrase',pageIndex:0,before:'prefix old suffix',after:'prefix new suffix'}];
 const report=await inspectSavedPdf(engineFactory,reorderedFixture(),reorderedFixture(true),edits,{includeText:true});
 assert.equal(report.pages[0].text_equal,true,JSON.stringify(report));
 assert.equal(report.failures.some(f=>f.code==='expected_text_uncomputable'),false);
 assert.deepEqual(report.pages[0].after_checks,[{id:'phrase',present:true,method:'extracted-text'}]);
 const corrupt=await inspectSavedPdf(engineFactory,reorderedFixture(),reorderedFixture(true,true),edits);
 assert.equal(corrupt.ok,false);
 assert.ok(corrupt.failures.some(f=>['expected_text_uncomputable','edited_page_text_or_order_mismatch'].includes(f.code)));
});
test('numeric marker consolidation preserves source objects and all surrounding pixels',async()=>{
 const source=fixture();let result;try{result=await editPdf({sourceBytes:source,edits:[{id:'marker',pageIndex:0,before:'2,3',after:'35'}],reflow:true},{engineFactory});}catch(e){throw new Error(JSON.stringify({code:e.code,checks:e.report?.selfCheck,paragraphs:e.report?.pages?.[0]?.paragraphs}));}
 assert.equal(result.report.status,'self-check-passed');assert.ok(result.report.pages[0].paragraphs.some(p=>p.lineRetention?.status==='source_numeric_marker'));
 const a=mupdf.Document.openDocument(source,'application/pdf'),b=mupdf.Document.openDocument(result.pdf,'application/pdf');try{
 assert.equal(b.countPages(),2);assert.deepEqual(raster(a,1),raster(b,1));const before=raster(a,0),after=raster(b,0);let changed=0;
 for(let o=0;o<before.bytes.length;o+=3)if(before.bytes[o]!==after.bytes[o]||before.bytes[o+1]!==after.bytes[o+1]||before.bytes[o+2]!==after.bytes[o+2]){const pixel=o/3,x=pixel%before.width,y=Math.floor(pixel/before.width);assert.ok(x>=278&&x<=302&&y>=172&&y<=196,`Unexpected changed pixel ${x},${y}`);changed++;}
 assert.ok(changed>0);const p=b.loadPage(0),t=p.toStructuredText();try{assert.ok(t.asText().includes('35'));}finally{t.destroy();p.destroy();}
 }finally{a.destroy();b.destroy();}
});

test('editing a name preserves its source line and separately painted superscripts',async()=>{
 const source=fixture(true),e=await engineFactory(source);let before;
 try{e.loadPage(0);e.normalizeFontsForEdit();before=e.buildModel().find(p=>p.runs.map(r=>r.text).join('').includes('Example Author')).runs.map(r=>r.text).join('');}finally{e.close();}
 let result;try{result=await editPdf({sourceBytes:source,edits:[{id:'name',pageIndex:0,before,after:before.replace('Example','Examples')}],reflow:true},{engineFactory});}catch(e){throw new Error(JSON.stringify({code:e.code,checks:e.report?.selfCheck}));}
 assert.equal(result.report.status,'self-check-passed',JSON.stringify(result.report.selfCheck));
 assert.equal(result.report.pages[0].paragraphs[0].lineRetention?.status,'source_word_objects');
 const a=mupdf.Document.openDocument(source,'application/pdf'),b=mupdf.Document.openDocument(result.pdf,'application/pdf');
 try{assert.equal(b.countPages(),2);assert.deepEqual(raster(a,1),raster(b,1));
  const x=raster(a,0),y=raster(b,0);let changed=0;
  for(let i=0;i<x.bytes.length;i+=3)if(x.bytes[i]!==y.bytes[i]||x.bytes[i+1]!==y.bytes[i+1]||x.bytes[i+2]!==y.bytes[i+2]){
   const py=Math.floor(i/3/x.width);assert.ok(py>=170&&py<=204,`Other source line changed at y=${py}`);changed++;
  }assert.ok(changed>0);
 }finally{a.destroy();b.destroy();}
});

test('a marker that would collide restores the original text before declining',async()=>{
 const source=fixture(),e=await engineFactory(source);let output;
 try{
  e.loadPage(0);e.normalizeFontsForEdit();
  const para=e.buildModel().find(p=>p.runs.map(r=>r.text).join('').includes('Example Author'));
  assert.equal(commitNumericMarker(e,para,'3','456789',{context:'2,3,',offset:2}),null);
  output=e.save();
 }finally{e.close();}
 const a=mupdf.Document.openDocument(source,'application/pdf'),b=mupdf.Document.openDocument(output,'application/pdf');
 try{assert.equal(b.countPages(),2);for(let i=0;i<2;i++)assert.deepEqual(raster(a,i),raster(b,i));}finally{a.destroy();b.destroy();}
});

test('a full author paragraph edit grows only its raised digit object',async()=>{
 const source=fixture();let result;
 const engine=await engineFactory(source);let before;
 try{engine.loadPage(0);engine.normalizeFontsForEdit();before=engine.buildModel().find(p=>p.runs.map(r=>r.text).join('').includes('Example Author')).runs.map(r=>r.text).join('');}finally{engine.close();}
 assert.match(before,/Author\s*2,3/);
 try{result=await editPdf({sourceBytes:source,edits:[{id:'raised',pageIndex:0,before,after:before.replace('2,3','2,45')}],reflow:true},{engineFactory});}
 catch(e){throw new Error(JSON.stringify({code:e.code,checks:e.report?.selfCheck,paragraphs:e.report?.pages?.[0]?.paragraphs}));}
 assert.equal(result.report.status,'self-check-passed');
 assert.ok(result.report.pages[0].paragraphs.some(p=>p.lineRetention?.status==='source_numeric_marker'&&p.lineRetention.objects===1));
 const a=mupdf.Document.openDocument(source,'application/pdf'),b=mupdf.Document.openDocument(result.pdf,'application/pdf');
 try{
  assert.equal(b.countPages(),2);assert.deepEqual(raster(a,1),raster(b,1));
  const before=raster(a,0),after=raster(b,0);let changed=0;
  for(let o=0;o<before.bytes.length;o+=3)if(before.bytes[o]!==after.bytes[o]||before.bytes[o+1]!==after.bytes[o+1]||before.bytes[o+2]!==after.bytes[o+2]){
   const pixel=o/3,x=pixel%before.width,y=Math.floor(pixel/before.width);
   assert.ok(x>=290&&x<=312&&y>=172&&y<=196,`Unexpected changed pixel ${x},${y}`);changed++;
  }
  assert.ok(changed>0);const p=b.loadPage(0),t=p.toStructuredText();try{assert.ok(t.asText().includes('45'));}finally{t.destroy();p.destroy();}
 }finally{a.destroy();b.destroy();}
});

for(const marker of ['34','63'])test(`inserting a digit into a raised marker preserves the rest of the page (${marker})`,async()=>{
 const source=fixture(),e=await engineFactory(source);let before;
 try{e.loadPage(0);e.normalizeFontsForEdit();before=e.buildModel().find(p=>p.runs.map(r=>r.text).join('').includes('Example Author')).runs.map(r=>r.text).join('');}finally{e.close();}
 let result;try{result=await editPdf({sourceBytes:source,edits:[{id:'insert-marker',pageIndex:0,before,after:before.replace('2,3','2,'+marker)}],reflow:true},{engineFactory});}
 catch(e){throw new Error(JSON.stringify({code:e.code,checks:e.report?.selfCheck}));}
 assert.equal(result.report.status,'self-check-passed');assert.ok(result.report.pages[0].paragraphs.some(p=>p.lineRetention?.status==='source_numeric_marker'&&p.lineRetention.objects===1));
 const a=mupdf.Document.openDocument(source,'application/pdf'),b=mupdf.Document.openDocument(result.pdf,'application/pdf');
 try{
  assert.equal(b.countPages(),2);assert.deepEqual(raster(a,1),raster(b,1));const old=raster(a,0),next=raster(b,0);let changed=0;
  for(let o=0;o<old.bytes.length;o+=3)if(old.bytes[o]!==next.bytes[o]||old.bytes[o+1]!==next.bytes[o+1]||old.bytes[o+2]!==next.bytes[o+2]){
   const pixel=o/3,x=pixel%old.width,y=Math.floor(pixel/old.width);assert.ok(x>=290&&x<=312&&y>=172&&y<=196,`Unexpected changed pixel ${x},${y}`);changed++;
  }
  assert.ok(changed>0);const p=b.loadPage(0),t=p.toStructuredText();try{assert.ok(t.asText().includes(marker));}finally{t.destroy();p.destroy();}
 }finally{a.destroy();b.destroy();}
});
