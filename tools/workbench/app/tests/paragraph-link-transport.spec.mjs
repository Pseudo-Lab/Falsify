import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,copyFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {createHash} from 'node:crypto';
import {createAnnotationTransport} from '../src/document-flow-annotations.mjs';

const app=fileURLToPath(new URL('..',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'paragraph-links-'));
mkdirSync(join(temp,'paragraph-vendor'));
for(const f of ['editcore.js','editcore.wasm'])copyFileSync(join(app,'src/paragraph-vendor/runtime',f),join(temp,'paragraph-vendor',f));
copyFileSync(join(app,'dist/paragraph-vendor/package.json'),join(temp,'paragraph-vendor/package.json'));
const plugin={name:'adapt',setup(b){
  b.onResolve({filter:/^\.\/browser-pdf-vendor\/mupdf\.js$/},()=>({path:pathToFileURL(join(app,'dist/browser-pdf-vendor/mupdf.js')).href,external:true}));
  b.onResolve({filter:/^node:crypto$/},()=>({path:join(app,'src/paragraph-pdf-crypto.mjs')}));
  b.onResolve({filter:/^\.\/runtime\.mjs$/},a=>a.importer.replaceAll('\\','/').endsWith('paragraph-vendor/editor.mjs')?({path:join(app,'src/paragraph-pdf-runtime.mjs')}):undefined);
  b.onResolve({filter:/^\.\/engine-loader\.js$/},()=>({path:join(app,'src/paragraph-pdf-engine-loader.mjs')}));
  b.onResolve({filter:/freetext-script$/},()=>({path:join(app,'src/paragraph-vendor/utils/freetext-script.ts')}));
}};
await build({entryPoints:[join(app,'src/paragraph-pdf.mjs')],outfile:join(temp,'candidate.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',plugins:[plugin]});
const {prepare}=await import(pathToFileURL(join(temp,'candidate.mjs')).href);
globalThis.fetch=async input=>new Response(readFileSync(new URL(input)));
function fixture(widget=false,wide=false,duplicate=false,wrapped=false,stationary=false){
 const d=new mupdf.PDFDocument();try{
  const font=d.addSimpleFont(new mupdf.Font('Times-Roman'));
  const text='BT /F1 11 Tf 40 700 Td (An initial claim includes supporting REFERENCE.) Tj ET BT /F1 11 Tf 40 686 Td (All measurement conditions remain explicitly stated.) Tj ET BT /F1 11 Tf 40 672 Td (The remaining evidence stays available for review.) Tj ET BT /F1 11 Tf 40 560 Td (Following paragraph remains separate and readable.) Tj ET BT /F1 11 Tf 350 700 Td (The right column is independent.) Tj ET BT /F1 11 Tf 350 686 Td (Its contents and positions should remain unchanged.) Tj ET BT /F1 11 Tf 350 672 Td (No change is requested in this column.) Tj ET';
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},(wrapped?text.replace('REFERENCE.','REF').replace('BT /F1 11 Tf 40 686 Td (All measurement conditions remain explicitly stated.) Tj ET ','')+' BT /F1 11 Tf 201 686 Td (ERENCE) Tj ET':text)+(duplicate?' BT /F1 11 Tf 350 650 Td (REFERENCE) Tj ET':'')));
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},'BT /F1 11 Tf 40 700 Td (Unchanged page.) Tj ET'));
  const page=d.findPage(0),annots=[d.addObject({Type:'Annot',Subtype:'Link',Rect:wrapped?[200,683,264,711]:wide?[145,697,263.982,711]:[201.029,697,263.982,711],A:{S:'URI',URI:d.newString('https://example.invalid/reference')}})];
  if(stationary)annots.push(d.addObject({Type:'Annot',Subtype:'Link',Rect:[350,647,413,661],A:{S:'URI',URI:d.newString('https://example.invalid/stationary')}}));
  if(widget)annots.push(d.addObject({Type:'Annot',Subtype:'Text',Rect:[400,400,420,420],Contents:d.newString('keep')}));
  page.put('Annots',annots);const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}
 }finally{d.destroy();}
}
const edit={id:'link',pageIndex:0,before:'An initial claim',after:'An expanded explanation of the measured outcome and its interpretation under the experimental conditions'};
test('ordinary expansion moves a raw URI link and validates saved geometry',async()=>{
 const src=fixture(), result=await prepare({file:src,edits:[edit]}),pdf=new Uint8Array(await result.file.arrayBuffer());
 assert.equal(result.verification.report.paragraphLinkMoves.length,1,JSON.stringify(result.verification.report.selfCheck.failures));
 const a=new mupdf.PDFDocument(src),b=new mupdf.PDFDocument(pdf);try{
  const old=a.findPage(0).get('Annots',0),link=b.findPage(0).get('Annots',0);
  assert.equal(link.get('A','URI').asString(),old.get('A','URI').asString());
  assert.notEqual(link.get('Rect',1).asNumber(),old.get('Rect',1).asNumber());
  const page=b.loadPage(0),hits=page.search('REFERENCE');
  try {const q=hits[0][0],r=Array.from({length:4},(_,i)=>link.get('Rect',i).asNumber());
    assert.ok(Math.min(r[2],q[2])-Math.max(r[0],q[0])>0);
    assert.ok(Math.min(800-r[1],q[7])-Math.max(800-r[3],q[1])>0);
  } finally {page.destroy();}
  assert.equal(b.countPages(),2);
  const pa=a.loadPage(1),pb=b.loadPage(1),ra=pa.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false),rb=pb.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false);
  try {assert.deepEqual(ra.getPixels(),rb.getPixels());} finally {ra.destroy();rb.destroy();pa.destroy();pb.destroy();}
 }finally{a.destroy();b.destroy();}
});

test('whole paragraph replacement retains unchanged URI label identity',async()=>{
 const src=fixture(), before='An initial claim includes supporting REFERENCE. All measurement conditions remain explicitly stated. The remaining evidence stays available for review.';
 const after=before.replace('An initial claim','An expanded explanation of the measured outcome and its interpretation under the experimental conditions');
 const result=await prepare({file:src,edits:[{id:'whole',pageIndex:0,before,after}]}), report=result.verification.report;
 assert.equal(report.paragraphLinkMoves.length,1,JSON.stringify(report.selfCheck.failures));
 assert.ok(!report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'),JSON.stringify(report.selfCheck.failures));
 const pdf=new Uint8Array(await result.file.arrayBuffer()), d=new mupdf.PDFDocument(pdf);
 try {assert.equal(d.findPage(0).get('Annots',0,'A','URI').asString(),'https://example.invalid/reference');} finally {d.destroy();}
 const api=createAnnotationTransport({mupdf}), model=await api.inspect({sourceBytes:src,sourceSha256:createHash('sha256').update(src).digest('hex')});
 const request={model,sourceBytes:src,outputBytes:pdf,sourcePageMap:[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i})),moves:report.paragraphLinkMoves,reflowedSourcePages:[0],preserveUnmovedUnsupported:true};
 assert.equal((await api.validate(request)).ok,true);
 for(const mutate of [doc=>doc.findPage(0).get('Annots',0,'A').put('URI',doc.newString('https://example.invalid/changed')),doc=>doc.findPage(0).get('Annots').delete(0)]){
  const doc=new mupdf.PDFDocument(pdf);let bad;
  try {mutate(doc);const buf=doc.saveToBuffer();try{bad=buf.asUint8Array().slice();}finally{buf.destroy();}} finally {doc.destroy();}
  assert.equal((await api.validate({...request,outputBytes:bad})).ok,false);
 }
});
test('link moves while the complete comment dictionary remains bound',async()=>{
 const src=fixture(true),result=await prepare({file:src,edits:[edit]}),report=result.verification.report,pdf=new Uint8Array(await result.file.arrayBuffer());
 assert.equal(report.paragraphLinkMoves.length,1,JSON.stringify(report.selfCheck.failures));
 const api=createAnnotationTransport({mupdf}),model=await api.inspect({sourceBytes:src,sourceSha256:createHash('sha256').update(src).digest('hex')});
 const request={model,sourceBytes:src,outputBytes:pdf,sourcePageMap:[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i})),moves:report.paragraphLinkMoves,reflowedSourcePages:[0],preserveUnmovedUnsupported:true};
 assert.equal((await api.validate(request)).ok,true);
 assert.equal((await api.validate({...request,preserveUnmovedUnsupported:false})).code,'annotation-subtype-unsupported');
 assert.equal((await api.validate({...request,moves:[{...report.paragraphLinkMoves[0],annotationIndex:1}]})).code,'annotation-move-invalid');
 assert.equal((await api.validate({...request,model:{...model}})).code,'annotation-model-unverified');
 const a=new mupdf.PDFDocument(src),b=new mupdf.PDFDocument(pdf);try{
  const old=a.findPage(0).get('Annots',0),link=b.findPage(0).get('Annots',0),comment=b.findPage(0).get('Annots',1);
  assert.equal(link.get('A','URI').asString(),old.get('A','URI').asString());
  assert.notEqual(link.get('Rect',1).asNumber(),old.get('Rect',1).asNumber());
  assert.equal(comment.get('Contents').asString(),'keep');
  const pa=a.loadPage(0),pb=b.loadPage(0),ra=pa.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false),rb=pb.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false);
  try {const x=ra.getPixels(),y=rb.getPixels(),stride=ra.getWidth()*ra.getNumberOfComponents();for(let row=0;row<ra.getHeight();row++)assert.deepEqual(x.slice(row*stride+320*3,(row+1)*stride),y.slice(row*stride+320*3,(row+1)*stride));} finally {ra.destroy();rb.destroy();pa.destroy();pb.destroy();}
 }finally{a.destroy();b.destroy();}
 for(const change of [d=>d.findPage(0).get('Annots',1).put('Contents',d.newString('changed')),d=>d.findPage(0).get('Annots').delete(1),d=>d.findPage(0).get('Annots').push(d.addObject({Type:'Annot',Subtype:'Text',Rect:[1,1,2,2]}))]){
  const d=new mupdf.PDFDocument(pdf);let bad;try{change(d);const buf=d.saveToBuffer();try{bad=buf.asUint8Array().slice();}finally{buf.destroy();}}finally{d.destroy();}
  assert.equal((await api.validate({...request,outputBytes:bad})).ok,false);
 }
});

test('a wrapped link with non-rigid mapping is explicitly unverified',async()=>{
 const result=await prepare({file:fixture(false,false,false,true),edits:[edit]});
 assert.equal(result.verification.report.paragraphLinkMoves.length,0);
 assert.ok(result.verification.report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'&&['document_flow_link_not_rigid_translation','document_flow_link_text_mapping_mismatch'].includes(f.reason)),JSON.stringify(result.verification.report.selfCheck.failures));
});


test('an edited link label is explicitly unverified in the saved draft',async()=>{
 const result=await prepare({file:fixture(),edits:[{id:'label',pageIndex:0,before:'REFERENCE',after:'A different linked label'}]});
 assert.ok(result.verification.report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'));
 assert.ok((await result.file.arrayBuffer()).byteLength>0);
});

test('duplicate labels do not redirect the source-owned link to the other column',async()=>{
 const result=await prepare({file:fixture(false,false,true),edits:[edit]});
 const report=result.verification.report;
 assert.equal(report.paragraphLinkMoves.length,1,JSON.stringify(report.selfCheck.failures));
 assert.ok(report.paragraphLinkMoves[0].dx<0);
});

test('stationary link is preserved while another link moves',async()=>{
 const src=fixture(false,false,true,false,true),result=await prepare({file:src,edits:[edit]});
 const report=result.verification.report;
 assert.equal(report.paragraphLinkMoves.length,1,JSON.stringify(report.selfCheck.failures));
 assert.equal(report.paragraphLinkMoves[0].annotationIndex,0);
 assert.ok(!report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'&&f.annotationIndex===1),JSON.stringify(report.selfCheck.failures));
 const a=new mupdf.PDFDocument(src),b=new mupdf.PDFDocument(new Uint8Array(await result.file.arrayBuffer()));
 try {assert.deepEqual(Array.from({length:4},(_,i)=>b.findPage(0).get('Annots',1,'Rect',i).asNumber()),Array.from({length:4},(_,i)=>a.findPage(0).get('Annots',1,'Rect',i).asNumber()));}
 finally {a.destroy();b.destroy();}
});

test('zero moves still validates and preserves the stationary raw link',async()=>{
 const initial=fixture(false,false,true,false,true),doc=new mupdf.PDFDocument(initial);let src;
 try {doc.findPage(0).get('Annots').delete(0);const buf=doc.saveToBuffer();try{src=buf.asUint8Array().slice();}finally{buf.destroy();}}finally{doc.destroy();}
 const result=await prepare({file:src,edits:[edit]}),report=result.verification.report;
 assert.equal(report.paragraphLinkMoves.length,0);
 assert.ok(!report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'),JSON.stringify(report.selfCheck.failures));
 const api=createAnnotationTransport({mupdf}),model=await api.inspect({sourceBytes:src,sourceSha256:createHash('sha256').update(src).digest('hex')});
 assert.equal((await api.validate({model,sourceBytes:src,outputBytes:new Uint8Array(await result.file.arrayBuffer()),sourcePageMap:[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i})),moves:[],preserveUnmovedUnsupported:true})).ok,true);
});

test('canonical provider preserves native ownership when saved body objects append out of raw order',async()=>{
 const {deriveNativeLinkMoves}=await import('../src/paragraph-vendor/document-flow-links.mjs');
 const {expectedPageText}=await import('../src/paragraph-vendor/quality.mjs');
 // Raw source is interleaved, while output body glyphs were appended after the second label.
 const physical='A LINK B LINK';
 const positions=[...physical].map((ch,i)=>({u:ch.charCodeAt(0),box:ch===' '?null:{l:i*10,r:i*10+8,b:10,t:20}}));
 const order=[...positions.keys()].filter(i=>i>=7).concat([...positions.keys()].filter(i=>i<7));
 const raw=order.map(i=>positions[i]);
 const heap=new Float64Array(8);
 const M={HEAPF64:heap,_malloc:()=>0,_free:()=>{},_FPDFText_LoadPage:()=>1,_FPDFText_ClosePage:()=>{},_FPDFText_CountChars:()=>raw.length,_FPDFText_GetUnicode:(_,i)=>raw[i].u,_FPDFText_GetCharBox:(_,i)=>{const b=raw[i].box;if(!b)return 0;heap.set([b.l,b.r,b.b,b.t]);return 1;},_FPDFText_GetTextObject:()=>1,_FPDFText_IsGenerated:()=>0};
 const engine={M,page:1,loadPage(){}};
 const targets=positions.filter(c=>c.box).map(c=>({...c,box:{...c.box,b:c.box.b+5,t:c.box.t+5},outputPageIndex:0}));
 const descriptor={sourcePageIndex:0,annotationIndex:0,kind:'link',eligible:true,rect:[20,10,58,20],destination:{type:'uri'}};
 const moves=deriveNativeLinkMoves(engine,[{sourcePageIndex:0,floor:0,bodyTop:100}],targets,[],{annotations:[descriptor]},expectedPageText,new Set(),(_band,chars)=>[...chars].sort((a,b)=>order[a.index]-order[b.index]));
 assert.deepEqual(moves,[{sourcePageIndex:0,annotationIndex:0,outputPageIndex:0,dx:0,dy:5}]);
 const band=[{sourcePageIndex:0,floor:0,bodyTop:100}], model={annotations:[descriptor]};
 const ordered=(_band,chars)=>[...chars].sort((a,b)=>order[a.index]-order[b.index]);
 const replacement=[{id:'whole',pageIndex:0,before:physical,after:'C LINK B LINK'}];
 const changed=targets.map((c,i)=>i===0?{...c,u:'C'.charCodeAt(0)}:c);
 assert.deepEqual(deriveNativeLinkMoves(engine,band,changed,replacement,model,expectedPageText,new Set(),ordered),moves);
 const labelEdit=[{id:'label',pageIndex:0,before:physical,after:'A LANK B LINK'}];
 const labelTargets=targets.map((c,i)=>i===2?{...c,u:'A'.charCodeAt(0)}:c);
 assert.throws(()=>deriveNativeLinkMoves(engine,band,labelTargets,labelEdit,model,expectedPageText,new Set(),ordered),e=>e.code==='document_flow_link_edited_label');
});
import {deriveNativeXYZMoves} from '../src/paragraph-vendor/document-flow-links.mjs';
test('XYZ anchors follow a unique rigid source object and reject edited or ambiguous anchors',()=>{
 const chars=[{u:65,object:7,box:{l:11,r:15,b:90,t:98}},{u:66,object:7,box:{l:15,r:19,b:90,t:98}}], heap=new Float64Array(16);
 const M={HEAPF64:heap,_malloc:()=>8,_free:()=>{},_FPDFText_LoadPage:()=>1,_FPDFText_ClosePage:()=>{},_FPDFText_CountChars:()=>chars.length,
  _FPDFText_GetUnicode:(_,i)=>chars[i].u,_FPDFText_GetTextObject:(_,i)=>chars[i].object,_FPDFText_IsGenerated:()=>0,
  _FPDFText_GetCharBox:(_,i,l,r,b,t)=>{const q=chars[i].box;heap[l>>3]=q.l;heap[r>>3]=q.r;heap[b>>3]=q.b;heap[t>>3]=q.t;return 1;}};
 const engine={M,page:1,loadPage:()=>{}}, bands=[{sourcePageIndex:0,floor:0,bodyTop:200}], model={annotations:[{internalDestinations:[{id:3,kind:'XYZ',targetSourcePageIndex:0,operands:[10,100,null]}]}]};
 const target=chars.map(c=>({u:c.u,box:{l:c.box.l+2,r:c.box.r+2,b:c.box.b-5,t:c.box.t-5},outputPageIndex:0}));
 const expected=()=>({ok:true,spans:[]});
 assert.deepEqual(deriveNativeXYZMoves(engine,bands,target,[],model,expected),[{id:3,sourcePageIndex:0,outputPageIndex:0,dx:2,dy:-5}]);
 assert.throws(()=>deriveNativeXYZMoves(engine,bands,[target[0],{...target[1],box:{...target[1].box,b:80}}],[],model,expected),{code:'document_flow_destination_not_rigid'});
 const edited=()=>({ok:true,spans:[{a:0,b:2,after:'CD'}]});
 assert.throws(()=>deriveNativeXYZMoves(engine,bands,target,[],model,edited),{code:'document_flow_link_text_mapping_mismatch'});
 chars.push({u:67,object:8,box:{l:11,r:13,b:90,t:98}});target.push({u:67,box:{l:13,r:15,b:85,t:93},outputPageIndex:0});
 assert.throws(()=>deriveNativeXYZMoves(engine,bands,target,[],model,expected),{code:'document_flow_destination_ownership_ambiguous'});
});

test('incoming-only XYZ destination follows a rigidly moved target on an annotation-free edited page',async()=>{
 const d=new mupdf.PDFDocument();let src;
 try {
  const font=d.addSimpleFont(new mupdf.Font('Times-Roman'));
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},'BT /F1 11 Tf 40 700 Td (Initial claim.) Tj ET BT /F1 11 Tf 40 660 Td (Target paragraph remains unchanged.) Tj ET'));
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},'BT /F1 11 Tf 40 700 Td (Incoming link.) Tj ET'));
  const target=d.findPage(0),from=d.findPage(1);
  from.put('Annots',[d.addObject({Type:'Annot',Subtype:'Link',Rect:[40,690,100,710],Dest:[target,'XYZ',39,669,null],Contents:d.newString('preserve-extra')})]);
  const buf=d.saveToBuffer();try{src=buf.asUint8Array().slice();}finally{buf.destroy();}
 }finally{d.destroy();}
 const result=await prepare({file:src,edits:[{id:'growth',pageIndex:0,before:'Initial claim.',after:'Initial claim and a detailed explanation of the evidence and its interpretation across multiple settings. '.repeat(5)}]});
 assert.ok(!result.verification.checks.some(c=>c.status==='failed'),JSON.stringify(result.verification.checks));
 const output=new Uint8Array(await result.file.arrayBuffer()), out=new mupdf.PDFDocument(output);
 try {
  const link=out.findPage(1).get('Annots',0), dest=link.get('Dest');
  assert.equal(dest.get(0).asIndirect(),out.findPage(0).asIndirect());assert.equal(dest.get(1).asName(),'XYZ');
  assert.equal(dest.get(2).asNumber(),39);assert.ok(dest.get(3).asNumber()<669);assert.ok(dest.get(4).isNull());
  assert.equal(link.get('Contents').asString(),'preserve-extra');
 } finally {out.destroy();}
});


test('large annotation-free document is editable but a later incoming link blocks the shortcut',async()=>{
 const make=linked=>{
  const d=new mupdf.PDFDocument();
  try {
   const font=d.addSimpleFont(new mupdf.Font('Helvetica'));
   for(let i=0;i<201;i++)d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},i===0?'BT /F1 12 Tf 72 700 Td (Original short text) Tj ET':''));
   if(linked){const target=d.findPage(0),last=d.findPage(200);last.put('Annots',[d.addObject({Type:'Annot',Subtype:'Link',Rect:[10,10,30,30],Dest:[target,'XYZ',72,700,null]})]);}
   const buf=d.saveToBuffer();try{return buf.asUint8Array().slice();}finally{buf.destroy();}
  } finally {d.destroy();}
 };
 const edit={id:'short',pageIndex:0,before:'Original short text',after:'Changed short text'};
 const empty=await prepare({file:make(false),edits:[edit]});
 assert.notEqual(empty.verification.status,'failed',JSON.stringify(empty.verification.checks));
 await assert.rejects(prepare({file:make(false),edits:[{...edit,after:'Expanded content requires more room on a continuation page. '.repeat(60)}]}),e=>(e.code==='LAYOUT_UNSUPPORTED' && e.details?.cause==='document_flow_page_budget_exceeded') || (e.code==='REPAIR_FAILED' && e.details?.codes?.includes('continuation_table_source_unavailable')));
 const linked=await prepare({file:make(true),edits:[edit]});
 assert.ok(linked.verification.checks.some(c=>c.status==='failed'),JSON.stringify(linked.verification.checks));
 assert.ok(linked.verification.report.selfCheck.failures.some(f=>f.code==='paragraph_link_inventory_unverified'&&f.reason==='annotation-document-unsupported'),JSON.stringify(linked.verification.report.selfCheck.failures));
});

test('large document inventory fails closed on invalid counts and errors and restores the edited page',async()=>{
 const {transportParagraphLinks}=await import('../src/paragraph-link-transport.mjs');
 for(const bad of [-1, undefined, 'throw']){
  let source, calls=0;
  const factory=async()=>{
   const engine={pageCount:201,page:0,loadPage(i){this.page=i;},close(){},M:{_FPDFPage_GetAnnotCount(i){if(i===200){if(bad==='throw')throw new Error('inventory');return bad;}return 0;}}};
   if(!calls++)source=engine;return engine;
  };
  const adapter={async inspect(){throw Object.assign(new Error(),{code:'annotation-document-unsupported'});}};
  const result=await transportParagraphLinks({engineFactory:factory,sourceBytes:new Uint8Array([1]),outputBytes:new Uint8Array([1]),edits:[{pageIndex:0}],sourcePageMap:[],annotationAdapter:adapter});
  assert.ok(result.failures.some(f=>f.code==='paragraph_link_inventory_unverified'));
  assert.equal(source.page,0);
 }
});

test('unchanged linked glyphs remain proved when the selection includes them',async()=>{
 const before='An initial claim includes supporting REFERENCE. All measurement conditions remain explicitly stated. The remaining evidence stays available for review.';
 const after=before.replace('stated','proved');
 const result=await prepare({file:fixture(),edits:[{id:'whole-stationary',pageIndex:0,before,after}]}),report=result.verification.report;
 assert.equal(report.paragraphLinkMoves.length,0,JSON.stringify(report.selfCheck.failures));
 assert.ok(!report.paragraphLinkFailures.some(f=>f.code==='paragraph_link_unverified'),JSON.stringify(report.paragraphLinkFailures));
});

test('a changed linked numeric marker is not silently certified as stationary',async()=>{
 const d=new mupdf.PDFDocument();let src;
 try{
  const font=d.addSimpleFont(new mupdf.Font('Times-Roman'));
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},'BT /F1 11 Tf 40 700 Td (Claim) Tj ET BT /F1 8 Tf 65 704 Td (2,) Tj ET BT /F1 8 Tf 71 704 Td (3) Tj ET BT /F1 11 Tf 75 700 Td ( with evidence.) Tj ET BT /F1 11 Tf 40 680 Td (Another unchanged statement.) Tj ET'));
  const page=d.findPage(0);page.put('Annots',[d.addObject({Type:'Annot',Subtype:'Link',Rect:[65,703,69,713],A:{S:'URI',URI:d.newString('https://example.invalid/two')}}),d.addObject({Type:'Annot',Subtype:'Link',Rect:[71,703,75,713],A:{S:'URI',URI:d.newString('https://example.invalid/three')}})]);
  const buf=d.saveToBuffer();try{src=buf.asUint8Array().slice();}finally{buf.destroy();}
 }finally{d.destroy();}
 const result=await prepare({file:src,edits:[{id:'marker',pageIndex:0,before:'Claim2,3 with evidence.',after:'Claim2,45 with evidence.'}]});
 assert.ok(result.verification.report.paragraphLinkFailures.some(f=>f.annotationIndex===1&&f.code==='paragraph_link_unverified'),JSON.stringify(result.verification.report));
});
