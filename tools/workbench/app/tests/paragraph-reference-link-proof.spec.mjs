import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import create from '../src/paragraph-vendor/runtime/editcore.js';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
const app=process.cwd();
const bundle=await build({stdin:{contents:'export {PdfEngine} from "./src/paragraph-vendor/engine/core.js";export {editPdf} from "./src/paragraph-vendor/editor.mjs";export {transportParagraphLinks} from "./src/paragraph-link-transport.mjs";',resolveDir:app},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'native-runtime',setup(b){b.onResolve({filter:/^\.\/runtime\.mjs$/},()=>({path:resolve('src/paragraph-pdf-runtime.mjs')}));b.onResolve({filter:/engine-loader\.js$/},()=>({path:resolve('src/paragraph-pdf-engine-loader.mjs')}));b.onResolve({filter:/freetext-script$/},()=>({path:resolve('src/paragraph-vendor/utils/freetext-script.ts')}));}}]});
const {PdfEngine,editPdf,transportParagraphLinks}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
async function engineFactory(bytes){const M=await create({wasmBinary:await readFile('src/paragraph-vendor/runtime/editcore.wasm'),print(){},printErr(){}});const cfg=M._malloc(48);M.HEAPU8.fill(0,cfg,cfg+48);M.HEAPU32[cfg>>2]=2;M._FPDF_InitLibraryWithConfig(cfg);M._free(cfg);const e=new PdfEngine(M);if(bytes)e.open(bytes);return e;}
import {createAnnotationTransport} from '../src/document-flow-annotations.mjs';
import {createHash} from 'node:crypto';
function fixture(neighbour=false){
 const d=new mupdf.PDFDocument();try{
  const font=d.addSimpleFont(new mupdf.Font('Times-Roman'));
 const content='BT /F1 12 Tf 60 400 Td (Example Author) Tj ET BT /F1 8 Tf 0 0 1 rg 140 404 Td (2) Tj ET BT /F1 8 Tf 0 0 0 rg 144 404 Td (,) Tj ET BT /F1 8 Tf 0 0 1 rg 146 404 Td (3) Tj ET BT /F1 12 Tf 158 400 Td (, Other Author) Tj ET BT /F1 12 Tf 60 350 Td (Evidence below stays in place and defines the original column width.) Tj ET q 0 0 0 rg 220 250 20 20 re f Q';
  d.insertPage(-1,d.addPage([0,0,500,500],0,{Font:{F1:font}},content));
  const page=d.findPage(0),links=[d.addObject({Type:'Annot',Subtype:'Link',Rect:[140,403,144,413],A:{S:'URI',URI:d.newString('https://example.invalid/two')}}),d.addObject({Type:'Annot',Subtype:'Link',Rect:[146,403,150,413],A:{S:'URI',URI:d.newString('https://example.invalid/three')}}),d.addObject({Type:'Annot',Subtype:'Link',Rect:[220,250,240,270],Dest:[page,'XYZ',25,475,null]})];
  if(neighbour)links.push(d.addObject({Type:'Annot',Subtype:'Link',Rect:[152,403,156,413],A:{S:'URI',URI:d.newString('https://example.invalid/other')}}));
  page.put('Annots',links);d.getTrailer().get('Root').put('OpenAction',[page,'Fit']);const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}
 }finally{d.destroy();}
}
const adapter=createAnnotationTransport({mupdf});
async function make(neighbour=false,word=false){
 const source=fixture(neighbour),engine=await engineFactory(source);let before;
 try{engine.loadPage(0);engine.normalizeFontsForEdit();before=engine.buildModel().find(p=>p.runs.map(r=>r.text).join('').includes('Example Author')).runs.map(r=>r.text).join('');}finally{engine.close();}
 const edit={id:word?'name':'marker',pageIndex:0,before,after:word?before.replace('Example','Examples'):before.replace('2,3','2,45')};
 const result=await editPdf({sourceBytes:source,edits:[edit],reflow:true},{engineFactory,annotationAdapter:adapter});
 return {source,edit,result};
}

test('a growing name carries the existing raised links with their original destinations',async()=>{
 const {source,result}=await make(false,true);
 assert.deepEqual(result.report.paragraphLinkFailures,[]);
 assert.equal(result.report.selfCheck.ok,true);
 assert.equal(result.report.pages[0].paragraphs[0].lineRetention.status,'source_word_objects');
 const moves=result.report.paragraphLinkMoves;assert.equal(moves.length,2);assert.ok(moves.every(m=>m.dx>0&&m.dy===0));
 const a=new mupdf.PDFDocument(source),b=new mupdf.PDFDocument(result.pdf);
 try{for(const move of moves){
  const x=a.findPage(0).get('Annots',move.annotationIndex),y=b.findPage(0).get('Annots',move.annotationIndex);
  assert.equal(x.get('A','URI').asString(),y.get('A','URI').asString());
  assert.ok(Math.abs(y.get('Rect',0).asNumber()-x.get('Rect',0).asNumber()-move.dx)<.01);
 }}finally{a.destroy();b.destroy();}
});
test('numeric link extension keeps target, padding, graphic link and Fit action; rejects corruption',async()=>{
 const {source,result}=await make();
 assert.deepEqual(result.report.paragraphLinkFailures,[],JSON.stringify(result.report.paragraphLinkFailures));
 const move=result.report.paragraphLinkMoves.find(m=>m.annotationIndex===1);assert.ok(move?.rect,JSON.stringify(result.report.paragraphLinkMoves));
 const a=new mupdf.PDFDocument(source),b=new mupdf.PDFDocument(result.pdf);try{
  assert.equal(b.findPage(0).get('Annots',1,'A','URI').asString(),a.findPage(0).get('Annots',1,'A','URI').asString());
  assert.ok(b.findPage(0).get('Annots',1,'Rect',2).asNumber()>a.findPage(0).get('Annots',1,'Rect',2).asNumber()+3);
  const rect=b.findPage(0).get('Annots',1,'Rect'),page=b.loadPage(0);try{
   const hits=page.search('45');assert.ok(hits.length>0);
   for(const q of hits[0])for(const x of [q[0],q[2],q[4],q[6]])assert.ok(x>=rect.get(0).asNumber()-.05&&x<=rect.get(2).asNumber()+.05);
  }finally{page.destroy();}
  assert.equal(b.getTrailer().get('Root','OpenAction',1).asName(),'Fit');
 }finally{a.destroy();b.destroy();}
 const model=await adapter.inspect({sourceBytes:source,sourceSha256:createHash('sha256').update(source).digest('hex')});
 const request={model,sourceBytes:source,outputBytes:result.pdf,sourcePageMap:[{sourcePageIndex:0,outputPageIndex:0}],moves:result.report.paragraphLinkMoves,destinationMoves:model.annotations.flatMap(a=>(a.internalDestinations||[]).filter(d=>d.targetSourcePageIndex===0).map(d=>({id:d.id,sourcePageIndex:0,outputPageIndex:0,dx:0,dy:0}))),reflowedSourcePages:[0],preserveUnmovedUnsupported:true};
 assert.equal((await adapter.validate(request)).ok,true);
 for(const change of [d=>d.findPage(0).get('Annots').delete(1),d=>d.findPage(0).get('Annots',1).put('Rect',[146,403,150,413]),d=>d.findPage(0).get('Annots',1,'A').put('URI',d.newString('https://example.invalid/corrupt')),d=>d.getTrailer().get('Root').put('OpenAction',[d.findPage(0),'XYZ',0,0,null]),d=>d.findPage(0).get('Annots',2,'Dest').put(3,474)]){
  const d=new mupdf.PDFDocument(result.pdf);let bad;try{change(d);const b=d.saveToBuffer();try{bad=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
  assert.equal((await adapter.validate({...request,outputBytes:bad})).ok,false);
 }
});
test('numeric extension refuses a neighbouring link',async()=>{
 await assert.rejects(()=>make(true),e=>e.code==='SELF_CHECK_FAILED'&&e.report?.paragraphLinkFailures?.some(f=>f.code==='paragraph_link_unverified'));
});

test('graphic link paint changes cannot pass a no-text proof',async()=>{
 const {source,edit,result}=await make();
 const d=new mupdf.PDFDocument(result.pdf);let corrupt;
 try{
  const page=d.findPage(0),link=page.get('Annots',1);link.put('Rect',[146,403,150,413]);link.delete('P');
  const contents=page.get('Contents'),overlay=d.addStream(new TextEncoder().encode('q 1 1 1 rg 220 250 20 20 re f Q'),{});
  page.put('Contents',[contents,overlay]);const b=d.saveToBuffer();try{corrupt=b.asUint8Array().slice();}finally{b.destroy();}
 }finally{d.destroy();}
 const checked=await transportParagraphLinks({engineFactory,sourceBytes:source,outputBytes:corrupt,edits:[edit],sourcePageMap:[{sourcePageIndex:0,outputPageIndex:0}],annotationAdapter:adapter});
 assert.ok(checked.failures.some(f=>f.annotationIndex===2&&f.code==='paragraph_link_unverified'),JSON.stringify(checked.failures));
});
