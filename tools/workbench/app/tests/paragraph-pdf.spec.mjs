import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import http from 'node:http';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';
// Use the identical pinned local module URL as the lazy adapter: separate
// MuPDF WASM namespaces in one Node realm do not share device callback maps.
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {inspectPage, prepare} from '../dist/paragraph-pdf.mjs';
import {createAnnotationTransport} from '../src/document-flow-annotations.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const before = 'Original paragraph has enough words to establish a reasonable source column width.';
const after = 'The replacement paragraph contains every requested word and expands to multiple lines in the same source column. This complete text must survive saving and extraction without shortening any sentence or using a detached appendix.';
function fixture({duplicate = false, rotate = 0} = {}) {
  const document = new mupdf.PDFDocument();
  const font = document.addSimpleFont(new mupdf.Font('Helvetica'));
  const image = document.addRawStream(Uint8Array.from([255,0,0,0,255,0,0,0,255,255,255,0]),
    {Type:'XObject', Subtype:'Image', Width:2, Height:2, ColorSpace:'DeviceRGB', BitsPerComponent:8});
  const text = `BT /F1 12 Tf 72 700 Td (${before}) Tj 0 -25 Td (${duplicate ? before : 'Following paragraph remains readable.'}) Tj 0 -475 Td (Lower body paragraph gives the column room to grow.) Tj 0 -165 Td (1) Tj ET\nq 20 0 0 20 450 450 cm /Im1 Do Q`;
  const page = document.addPage([0,0,612,792],rotate,{Font:{F1:font},XObject:{Im1:image}},text);
  document.insertPage(-1,page);
  const bytes = new Uint8Array(document.saveToBuffer().asUint8Array());
  document.destroy(); return bytes;
}
const flowBefore='Source page 0 begins';
const flowAfter=flowBefore+' A carefully preserved synthetic sentence travels into the next original source page.'.repeat(35);
function flowFixture({pages=4,foreign=false,singleStream=false}={}){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',''],add=s=>(objects.push(s),objects.length),fonts=['Helvetica','Times-Roman'].map(n=>add(`<< /Type /Font /Subtype /Type1 /BaseFont /${n} >>`)),kids=[];
  for(let p=0;p<pages;p++){
    const streams=[],raw=[];
    for(let k=0;k<2;k++){
      const text=k===0?`Source page ${p} begins the same long column with a small synthetic sentence.`:`Another paragraph on source page ${p} keeps its own font and original text.`;
      const dense=p===0&&k===1?Array.from({length:18},(_,i)=>`BT /F1 11 Tf 50 ${648-i*14} Td (The unchanged line ${i} preserves enough body text to fill the original source page.) Tj ET\n`).join(''):'';
      const content=`BT /F1 11 Tf 50 ${700-k*24} Td (${text}) Tj ET\n`+dense+(k===0?`BT /F1 8 Tf 50 760 Td (Synthetic running header) Tj ET\nBT /F1 8 Tf 290 30 Td (${p+1}) Tj ET\n`:'')+(foreign&&p===1&&k===1?'50 400 400 2 re f\n':'');
      raw.push(content);if(!singleStream)streams.push(add(`<< /Length ${content.length} >>\nstream\n${content}endstream`));
    }
    if(singleStream){const content=raw.join('');streams.push(add(`<< /Length ${content.length} >>\nstream\n${content}endstream`));}
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${fonts[p%2]} 0 R >> >> /Contents [${streams.map(i=>i+' 0 R').join(' ')}] >>`));
  }
  objects[1]=`<< /Type /Pages /Count ${pages} /Kids [${kids.map(i=>i+' 0 R').join(' ')}] >>`;
  let output='%PDF-1.4\n',offsets=[];objects.forEach((o,i)=>{offsets.push(output.length);output+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=output.length;output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(output));
}
function linkedFlowFixture(){
  // These rectangles are source glyph ink boxes for this pinned synthetic
  // Helvetica/Times fixture, independently accepted by native PDFium QA.
  const descriptors=[{page:0,rect:[50.2539978,409.8460083,68.4130020,417.8980103]},
    {page:1,rect:[50.2649994,675.9010010,68.5120010,683.4140015]},
    {page:1,edge:true,rect:[50.4359970,758.2639771,79.8680038,765.4639893]}];
  const d=new mupdf.PDFDocument(flowFixture());
  try{
    const pages=Array.from({length:4},(_,i)=>d.findPage(i)),old=pages[0].get('Contents',1),buffer=old.readStream();let content;
    try{content=new TextDecoder().decode(buffer.asUint8Array());}finally{buffer.destroy();}
    pages[0].get('Contents').put(1,d.addStream(new TextEncoder().encode(content.replace('(The unchanged line 17','(The) Tj ( unchanged line 17')),{}));
    d.getTrailer().get('Root').put('Dests',{outsideTarget:[pages[3],'XYZ',50,700,null]});
    for(const [i,{page,rect,edge}]of descriptors.entries()){
      const [l,b,r,t]=rect,annotation={Type:'Annot',Subtype:'Link',Rect:rect,QuadPoints:[l,t,r,t,l,b,r,b],Border:[0,0,0],F:4,P:pages[page],PrivateUnknown:{Keep:true}};
      if(i===1)annotation.Dest=d.newString('outsideTarget');else annotation.A={S:'URI',URI:d.newString(`https://example.invalid/never-open-${i}`),PrivateUnknown:{Keep:true,Value:d.newString('preserved-private-value')},Next:{S:'URI',URI:d.newString('https://other.invalid/never-open')}};
      const existing=pages[page].get('Annots'),annots=existing.isArray()?existing:d.newArray();annots.push(d.addObject(annotation));pages[page].put('Annots',annots);
      if(!edge&&i===1){const path=`q 0 0 1 rg 0 0 1 RG 0.4 w ${l} ${b+.25} m ${r} ${b+.25} l S Q\n`,contents=pages[page].get('Contents');contents.push(d.addStream(new TextEncoder().encode(path),{}));}
    }
    const bytes=d.saveToBuffer('garbage=0,compress=false');try{return bytes.asUint8Array().slice();}finally{bytes.destroy();}
  }finally{d.destroy();}
}
function assertLinkedFlow(source,output,verification){
  const report=verification.report,map=report.pagination.sourcePageMap;
  assert.equal(verification.pageCount.output,4);assert.equal(report.pagination.addedPages,0);assert.ok(report.pagination.flowGroups.length);assert.ok(map[0].contentOutputPageIndices.includes(1));
  assert.equal(report.pagination.documentFlowPolicy,'compatible-groups');assert.equal(report.selfCheck.annotationCheck.ok,true);assert.equal(report.pagination.annotationMoves.length,2);
  assert.ok(report.pagination.annotationMoves.every(m=>Object.keys(m).sort().join(',')==='annotationIndex,dx,dy,outputPageIndex,sourcePageIndex'));
  assert.ok(!JSON.stringify(verification).includes('example.invalid'));assert.ok(!JSON.stringify(verification).includes('preserved-private-value'));
  assert.equal(verification.runtime.moduleOverlayCommit,JSON.parse(readFileSync(join(app,'src/paragraph-vendor/overlay.json'),'utf8')).commit);
  const a=new mupdf.PDFDocument(source),b=new mupdf.PDFDocument(output);
  try{
    assert.equal(b.countPages(),4);
    for(const move of report.pagination.annotationMoves){
      const old=a.findPage(move.sourcePageIndex).get('Annots',move.annotationIndex),page=b.findPage(move.outputPageIndex),arr=page.get('Annots');let found;
      for(let i=0;i<arr.length;i++){const candidate=arr.get(i);if(old.get('A').isNull()?candidate.get('Dest').asString()==='outsideTarget':!candidate.get('A').isNull()&&candidate.get('A','URI').asString()===old.get('A','URI').asString())found=candidate;}
      assert.ok(found);assert.equal(found.get('P').asIndirect(),page.asIndirect());
      for(let k=0;k<4;k++)assert.ok(Math.abs(found.get('Rect',k).asNumber()-old.get('Rect',k).asNumber()-(k%2?move.dy:move.dx))<.01);
      if(!old.get('A').isNull()){assert.equal(found.get('A','PrivateUnknown','Value').asString(),'preserved-private-value');assert.equal(found.get('A','Next','URI').asString(),'https://other.invalid/never-open');}
    }
    const named=b.getTrailer().get('Root','Dests','outsideTarget');assert.equal(named.get(0).asIndirect(),b.findPage(map[3].outputPageIndex).asIndirect());assert.equal(named.get(2).asNumber(),50);assert.equal(named.get(3).asNumber(),700);
    const sourceEdge=a.findPage(1).get('Annots',1),targetAnnots=b.findPage(map[1].outputPageIndex).get('Annots');let edge;
    for(let i=0;i<targetAnnots.length;i++)if(targetAnnots.get(i,'A','URI').asString()==='https://example.invalid/never-open-2')edge=targetAnnots.get(i);
    assert.ok(edge);for(let k=0;k<4;k++)assert.equal(edge.get('Rect',k).asNumber(),sourceEdge.get('Rect',k).asNumber());
    const paths=[];for(let i=0;i<b.countPages();i++){const page=b.loadPage(i),dev=new mupdf.Device({strokePath(){paths.push(i);}});try{page.run(dev,[1,0,0,1,0,0]);dev.close();}finally{dev.destroy();page.destroy();}}assert.deepEqual(paths,[1]);
  }finally{a.destroy();b.destroy();}
}
function extraction(bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const result=[];
  try { for(let i=0;i<doc.countPages();i++) { const p=doc.loadPage(i); const s=p.toStructuredText(); result.push(s.asText()); s.destroy(); p.destroy(); } }
  finally {doc.destroy();}
  return result.join(' ').replace(/\s+/g,' ').trim();
}
const localFetch = async input => {
  const url = new URL(input);
  assert.equal(url.protocol, 'file:', 'Node harness forbids all external requests');
  assert.ok(url.pathname.includes('/dist/paragraph-vendor/'));
  return new Response(readFileSync(url));
};

test('SHA-256 shim matches Node for strings and PDF bytes', () => {
  for(const bytes of [new Uint8Array(),new TextEncoder().encode('abc'),fixture()]) assert.equal(hex(bytes),sha(bytes));
});

test('real PDFium paragraph inspect and reflow retain full After and following content', async () => {
  const previous = globalThis.fetch; globalThis.fetch = localFetch;
  try {
    const bytes=fixture();
    const inspected=await inspectPage({file:bytes,pageIndex:0});
    assert.equal(inspected.fileHash,sha(bytes));
    assert.equal(inspected.width,612); assert.equal(inspected.height,792);
    const target=inspected.paragraphs.find(p=>p.text===before);
    assert.ok(target); assert.ok(target.fontName.length > 0); assert.equal(target.size,12);
    assert.ok(target.bbox[1]>70 && target.bbox[1]<100);
    assert.equal((await inspectPage({file:bytes,pageIndex:0})).paragraphs[0].id, inspected.paragraphs[0].id);
    const out=await prepare({file:bytes,fileHash:inspected.fileHash,edits:[{id:'expand',pageIndex:0,before,after}]});
    const saved=new Uint8Array(await out.file.arrayBuffer());
    assert.equal(out.sha256,sha(saved)); assert.notEqual(out.sha256,sha(bytes));
    const text=extraction(saved);
    assert.ok(text.includes(after), 'full After must survive independent extraction');
    assert.ok(!text.includes(before)); assert.ok(text.includes('Following paragraph remains readable.'));
    assert.equal(out.verification.report.reflow,true);
    assert.equal(out.verification.runtime.sourceBuildVerified,false);
    assert.deepEqual(out.pageMap,out.verification.report.pagination.sourcePageMap);
    assert.equal(out.verification.pageCount.output,out.verification.report.pagination.pages.output);
    assert.notEqual(out.verification.status,'failed',JSON.stringify(out.verification.checks));
    assert.deepEqual(out.verification.checks,[]);
    const selfCheck=out.verification.report.selfCheck;
    assert.equal(selfCheck.status,'passed');
    assert.ok(selfCheck.pages.every(p=>(p.overlap?.output || 0)<=(p.overlap?.source || 0)));
    const resultInspect=await inspectPage({file:saved,pageIndex:out.pageMap[0].outputPageIndex});
    const following=resultInspect.paragraphs.find(p=>p.text.includes('Following paragraph'));
    const originalFollowing=inspected.paragraphs.find(p=>p.text.includes('Following paragraph'));
    const bottom=(data,needle)=>{const d=mupdf.Document.openDocument(data,'application/pdf'),p=d.loadPage(0);try{return p.search(needle).flat(2);}finally{p.destroy();d.destroy();}};
    const found=bottom(saved,'Following paragraph remains readable.');
    assert.ok(found.length>0,'following paragraph remains independently locatable');
    const afterQuads=bottom(saved,after), sourceFollowing=bottom(bytes,'Following paragraph remains readable.');
    assert.ok(afterQuads.length>0,'complete After has independent glyph quads');
    const ys=xs=>xs.filter((_,i)=>i%2===1);
    assert.ok(Math.min(...ys(found))>=Math.min(...ys(sourceFollowing))-.5,'following content does not move upward into the expansion');
    // MuPDF search quads include the font's ascent/descent box; these boxes
    // overlap even on normally spaced source lines. Compare successive line
    // tops against the source font size rather than treating that box as ink.
    const tops=quads=>Array.from({length:quads.length/8},(_,i)=>Math.min(quads[i*8+1],quads[i*8+3]));
    assert.ok(Math.min(...tops(found))-Math.max(...tops(afterQuads))>=target.size-1,'following paragraph has a full line of clearance after the expanded text');
    assert.ok(following && originalFollowing,'both source and output retain the following paragraph');
    // Compare image object stream and rendered image region independently.
    const render = data => { const doc=mupdf.Document.openDocument(data,'application/pdf');const p=doc.loadPage(0); const pix=p.toPixmap([1,0,0,1,0,0],mupdf.ColorSpace.DeviceRGB,false); const pixels=Uint8Array.from(pix.getPixels());const stride=pix.getStride();const sample=[];for(let y=322;y<342;y++)sample.push(...pixels.slice(y*stride+450*3,y*stride+470*3));pix.destroy();p.destroy();doc.destroy();return sample; };
    assert.deepEqual(render(saved),render(bytes),'unrelated image pixels remain unchanged');
    const ac=new AbortController();ac.abort();
    await assert.rejects(prepare({file:bytes,signal:ac.signal,edits:[]}),{code:'aborted'});
    await assert.rejects(prepare({file:bytes,fileHash:'0'.repeat(64),edits:[]}),{code:'stale-source'});
    const snapshot={schema:'falsify.paper-edits.v1',fileHash:sha(bytes).toUpperCase(),edits:[{id:'snapshot',pageIndex:0,before,after}]};
    const snapshotOut=await prepare({file:bytes,edits:snapshot});
    assert.ok(extraction(new Uint8Array(await snapshotOut.file.arrayBuffer())).includes(after));
    await assert.rejects(prepare({file:bytes,edits:{...snapshot,fileHash:'0'.repeat(64)}}),{code:'stale-source'});
    await assert.rejects(prepare({file:bytes,fileHash:'0'.repeat(64),edits:snapshot}),{code:'stale-source'});
    await assert.rejects(prepare({file:bytes,edits:{...snapshot,schema:'unknown'}}),{code:'invalid'});
    await assert.rejects(inspectPage({file:{size:25*1024*1024+1,arrayBuffer(){throw new Error('must reject before reading');}},pageIndex:0}),{code:'limit'});
    await assert.rejects(prepare({file:fixture({duplicate:true}),edits:[{id:'duplicate',pageIndex:0,before,after}]}),error=>JSON.stringify(error.report || error.details).includes('AMBIGUOUS_MATCH'));
    const turned=await inspectPage({file:fixture({rotate:90}),pageIndex:0});
    assert.equal(turned.rotation,90);assert.equal(turned.width,792);assert.equal(turned.height,612);
  } finally {globalThis.fetch=previous;}
});

test('default compatible groups compact existing pages with raw links and keep barrier warnings truthful',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=localFetch;
  try{
    const source=linkedFlowFixture(),original=source.slice(),result=await prepare({file:source,fileHash:sha(source),documentFlow:false,annotationAdapter:{inspect(){assert.fail('request callback must never be used');}},edits:[{id:'grow',pageIndex:0,before:flowBefore,after:flowAfter}]});
    const output=new Uint8Array(await result.file.arrayBuffer());assert.deepEqual(source,original);assert.equal(result.sha256,sha(output));assert.notEqual(result.verification.status,'failed',JSON.stringify(result.verification.checks));assertLinkedFlow(source,output,result.verification);assert.ok(extraction(output).includes(flowAfter));
    const adapter=createAnnotationTransport({mupdf}),model=await adapter.inspect({sourceBytes:source,sourceSha256:sha(source)}),reflowed=[...new Set(result.verification.report.pagination.flowGroups.flatMap(g=>g.sourcePages.map(p=>p.sourcePageIndex)))];
    assert.equal((await adapter.validate({model,sourceBytes:source,outputBytes:output,sourcePageMap:result.pageMap,moves:result.verification.report.pagination.annotationMoves,reflowedSourcePages:reflowed})).ok,true);
    const barrier=await prepare({file:flowFixture({pages:3,foreign:true,singleStream:true}),edits:[{id:'grow',pageIndex:0,before:flowBefore,after:flowAfter}]});
    assert.equal(barrier.verification.report.pagination.documentFlowPolicy,'compatible-groups');assert.equal(barrier.verification.report.pagination.flowGroups.length,0);assert.ok(barrier.warnings.some(w=>w.code==='document_flow_barrier_not_compacted'));assert.ok(barrier.verification.report.pagination.addedPages>0);assert.equal(barrier.verification.layoutVerified,false);assert.equal(barrier.verification.independent,false);
    const manifest=JSON.parse(readFileSync(join(app,'dist/paragraph-vendor/manifest.json'),'utf8'));assert.equal(Object.keys(manifest.editorModuleSha256).length,9);for(const [name,digest]of Object.entries(manifest.editorModuleSha256))assert.equal(digest,sha(readFileSync(join(app,'src/paragraph-vendor',name))));
  }finally{globalThis.fetch=previous;}
});

test('classic loader is lazy, cancellation is request-isolated, stale IDs ignored', async () => {
  const workers=[];
  class FakeWorker { constructor(){workers.push(this);} postMessage(message){this.message=message;} terminate(){this.terminated=true;} }
  const context={document:{currentScript:{src:'https://example.test/dist/paragraph-pdf.js'}},Worker:FakeWorker,URL,File,Map,Uint8Array,ArrayBuffer,Promise,Error};
  vm.runInNewContext(readFileSync(join(app,'dist/paragraph-pdf.js'),'utf8'),context);
  assert.equal(workers.length,0);
  const controller=new AbortController();const bytes=fixture();
  const first=context.FalsifyParagraphPdf.inspectPage({file:bytes,pageIndex:0,signal:controller.signal});
  const second=context.FalsifyParagraphPdf.inspectPage({file:bytes,pageIndex:0});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(workers.length,2);
  workers[1].onmessage({data:{id:workers[0].message.id,ok:true,result:{bad:true}}});
  controller.abort();await assert.rejects(first,{code:'aborted'});assert.equal(workers[0].terminated,true);assert.equal(workers[1].terminated,undefined);
  workers[1].onmessage({data:{id:workers[1].message.id,ok:true,result:{pageIndex:0}}});
  assert.equal((await second).pageIndex,0);assert.equal(workers[1].terminated,true);
});

test('isolated Chromium worker performs inspect/prepare with real WASM and no upload', async t => {
  const {chromium}=await import('playwright');
  const executable=[process.env.BROWSER_EXECUTABLE,chromium.executablePath(),join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe')].find(p=>p && existsSync(p));
  if(!executable){t.skip('Chromium executable unavailable');return;}
  const hits=[];
  const server=http.createServer((req,res)=>{
    // Workers have their own response policy; exercise that policy too.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'");
    hits.push({method:req.method,url:req.url});
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    if(pathname==='/harness.html'){res.setHeader('content-type','text/html');res.end('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; worker-src \'self\'; connect-src \'self\'; object-src \'none\'"><script src="/dist/paragraph-pdf.js"></script>');return;}
    const path=resolve(app,'.'+pathname);
    if(!path.startsWith(app+sep)){res.writeHead(403).end();return;}
    try{res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'})[extname(path)] || 'application/octet-stream');res.end(readFileSync(path));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({executablePath:executable,headless:true});
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
    await page.goto(origin+'/harness.html');
    assert.equal(hits.some(h=>h.url.includes('.wasm')),false,'loader must not eagerly fetch WASM');
    const inspectOnly=await page.evaluate(async bytes=>{const file=new File([new Uint8Array(bytes)],'linked-inspect.pdf',{type:'application/pdf'});return FalsifyParagraphPdf.inspectPage({file,pageIndex:0});},Array.from(linkedFlowFixture()));
    assert.ok(inspectOnly.paragraphs.length);assert.equal(hits.some(h=>h.url.includes('browser-pdf-vendor')),false,'inspectPage never loads MuPDF even when the source has links');
    const result=await page.evaluate(async ({bytes,before,after})=>{
      const file=new File([new Uint8Array(bytes)],'fixture.pdf',{type:'application/pdf'});
      const api=window.FalsifyParagraphPdf;
      const inspected=await api.inspectPage({file,pageIndex:0});
      const output=await api.prepare({file,edits:{schema:'falsify.paper-edits.v1',fileHash:inspected.fileHash,edits:[{id:'expand',pageIndex:0,before,after}]}});
      let stale='';try{await api.inspectPage({file,pageIndex:0,fileHash:'0'.repeat(64)});}catch(e){stale=e.code;}
      const ac=new AbortController();const pending=api.inspectPage({file,pageIndex:0,signal:ac.signal});ac.abort();let cancelled='';try{await pending;}catch(e){cancelled=e.code;}
      const bytesOut=Array.from(new Uint8Array(await output.file.arrayBuffer()));
      return {inspected,sha256:output.sha256,verification:output.verification,pageMap:output.pageMap,bytes:bytesOut,stale,cancelled,node:typeof process};
    },{bytes:Array.from(fixture()),before,after});
    assert.equal(result.node,'undefined');assert.equal(result.cancelled,'aborted');assert.equal(result.stale,'stale-source');
    assert.equal(result.inspected.fileHash,sha(fixture()));
    assert.equal(result.sha256,sha(Uint8Array.from(result.bytes)));
    assert.ok(extraction(Uint8Array.from(result.bytes)).includes(after));
    assert.notEqual(result.verification.status,'failed');assert.ok(result.pageMap.length);
    assert.deepEqual(errors,[]);assert.ok(hits.some(h=>h.url.includes('editcore.wasm?sha256=')));
    for(const hit of hits.filter(h=>/editcore\.(js|wasm)/.test(h.url))) {
      const hash=new URL(hit.url,origin).searchParams.get('sha256');
      assert.equal(hash,hit.url.includes('editcore.wasm') ? '9b14b88937a9b21697565df94e82b28ac645547413606d4994d50d9200529c6e' : '6e6989a9994715951720e05355111aca7eab898e92b519ebea160167875bb3eb');
    }
    const linked=linkedFlowFixture(),savedSource=linked.slice();
    const linkedResult=await page.evaluate(async({bytes,before,after})=>{
      const file=new File([new Uint8Array(bytes)],'linked-flow.pdf',{type:'application/pdf'}),hash=async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const sourceHash=await hash(),out=await FalsifyParagraphPdf.prepare({file,fileHash:sourceHash,edits:[{id:'grow',pageIndex:0,before,after}]});return {sourceHash,sourceAfterHash:await hash(),bytes:Array.from(new Uint8Array(await out.file.arrayBuffer())),sha256:out.sha256,verification:out.verification};
    },{bytes:Array.from(linked),before:flowBefore,after:flowAfter});
    assert.equal(linkedResult.sourceHash,sha(linked));assert.equal(linkedResult.sourceAfterHash,sha(linked));assert.deepEqual(linked,savedSource);assert.equal(linkedResult.sha256,sha(Uint8Array.from(linkedResult.bytes)));assert.notEqual(linkedResult.verification.status,'failed',JSON.stringify(linkedResult.verification.checks));assertLinkedFlow(linked,Uint8Array.from(linkedResult.bytes),linkedResult.verification);
    assert.ok(hits.some(h=>h.url.includes('/browser-pdf-vendor/mupdf-wasm.wasm')),'native annotation proof lazily loads the existing fixed same-origin MuPDF runtime');assert.deepEqual(errors,[]);
    assert.ok(hits.every(h=>h.method==='GET'),'no PDF bytes uploaded');
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
