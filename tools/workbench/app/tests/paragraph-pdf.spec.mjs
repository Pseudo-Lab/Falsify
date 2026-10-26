import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import http from 'node:http';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';
import * as mupdf from 'mupdf';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {inspectPage, prepare} from '../dist/paragraph-pdf.mjs';

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
    assert.ok(following && following.bbox[1]>originalFollowing.bbox[1], 'following paragraph moves down after expansion');
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
    assert.ok(hits.every(h=>h.method==='GET'),'no PDF bytes uploaded');
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
