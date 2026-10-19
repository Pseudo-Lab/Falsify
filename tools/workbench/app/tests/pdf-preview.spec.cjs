'use strict';
// Node VM contract for the final-PDF preview: the shipped bundle with a synthetic DOM and a mocked PDF.js, plus its RED export wiring.
// No browser, network, upload, CLI, model or private PDF; PDF.js is never actually loaded here (GUI rendering is covered elsewhere).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),nodeCrypto=require('node:crypto');
const C=require('../dist/document-red-core.js');
const BUNDLE=fs.readFileSync(path.resolve(__dirname,'../dist/document-preview.js'),'utf8'),RED=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.js'),'utf8');
const HTML=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8');
const CSS=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.css'),'utf8'),SOURCE=fs.readFileSync(path.resolve(__dirname,'../src/document-preview.js'),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const sha=b=>nodeCrypto.createHash('sha256').update(b).digest('hex'),BASE='http://127.0.0.1:7815/';
const until=async(cond,label)=>{for(let i=0;i<400;i++){if(cond())return;await new Promise(r=>setTimeout(r,5));}assert.fail('timed out: '+label);};
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
const text=e=>typeof e==='string'?e:(e.textContent||'')+e.children.map(text).join('');
function element(id,tag=''){
  const e=new EventTarget(),classes=new Set(),attrs={};
  Object.assign(e,{id,tagName:tag,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],className:'',width:300,height:150,clientWidth:640,
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    setAttribute:(k,v)=>{attrs[k]=String(v);},getAttribute:k=>attrs[k]??null,
    getContext:()=>tag==='canvas'?{canvas:e}:null,
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
// focus() records document.activeElement; there is no focus fixup, so a focused button that is merely disabled stays active (as in the bug).
function dom(){const els=new Map(),created=[],get=id=>{if(!els.has(id)){const e=element(id);e.focus=()=>{document.activeElement=e;};els.set(id,e);}return els.get(id);};
  const document=new EventTarget();Object.assign(document,{baseURI:BASE,querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],
    createElement:tag=>{const e=element('',tag);created.push(e);return e;},body:element('body')});document.activeElement=document.body;return {document,get,created};}
// Mocked PDF.js: records params, detaches the given buffer like the real worker transfer, and lets tests hold load/render steps.
function pdfjs({pages=3,hold=false,manual=false,deaf=false,loadError=null,badPages=new Set()}={}){
  const log={params:[],received:[],tasks:[],renders:[],cleanups:0};
  const lib={GlobalWorkerOptions:{},getDocument(params){log.params.push(params);log.received.push(Buffer.from(params.data));params.data.buffer.transfer();
    let resolve,reject;const task={destroyed:false,promise:new Promise((a,b)=>{resolve=a;reject=b;})};task.promise.catch(()=>{});
    task.destroy=async()=>{task.destroyed=true;reject(Object.assign(new Error('Worker was destroyed'),{name:'AbortException'}));};
    task.open=()=>loadError?reject(loadError):resolve(doc);log.tasks.push(task);if(!hold)setImmediate(task.open);return task;}};
  const doc={numPages:pages,getPage:async n=>({getViewport:({scale})=>({width:612*scale,height:792*scale}),cleanup(){log.cleanups++;},
    render({canvasContext,canvas,viewport}){let ok,no;const r={cancelled:false,promise:new Promise((a,b)=>{ok=a;no=b;})};
      // deaf: cancel is recorded but the render still completes later, as when cancel races a render that already finished.
      r.cancel=()=>{if(r.done)return;r.cancelled=true;if(deaf)return;r.done=true;no(Object.assign(new Error('Rendering cancelled, page '+n),{name:'RenderingCancelledException'}));};
      r.finish=()=>{if(r.done)return;r.done=true;if(badPages.has(n))no(new Error('<b>secret extracted sentence</b>'));else{canvas.painted=n;ok();}};
      assert.equal(canvasContext.canvas,canvas);assert.ok(viewport.width>0);log.renders.push({n,r,canvas});if(!manual)setImmediate(r.finish);return r;}})};
  return {lib,log};}
const pdfBytes=(tail='synthetic final output')=>Buffer.from('%PDF-1.7\n'+tail+'\n%%EOF');
const pdfFile=(bytes,name='paper-falsify-research.pdf')=>new File([bytes],name,{type:'application/pdf'});
function preview(opts={}){const w=dom(),{lib,log}=pdfjs(opts),downloads=[],timers={setTimeout:(f,ms)=>ms>=60000?(w.timeouts.push(f),w.timeouts.length):setTimeout(f,ms),clearTimeout:id=>{if(typeof id==='number'&&id<=w.timeouts.length)w.timeouts[id-1]=null;else clearTimeout(id);}};
  w.timeouts=[];let imports=0;
  const ctx=vm.createContext({URL,TextDecoder,Uint8Array,Promise,Error,Math,Number,Array,Object,String,fetch:()=>{throw new Error('network is not allowed');}});
  vm.runInContext(BUNDLE,ctx,{filename:'document-preview.js'});
  const urls={createObjectURL:b=>{downloads.push(b);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const p=ctx.FalsifyPreview.createPreview({document:w.document,importPdf:async()=>{imports++;return lib;},subtle:globalThis.crypto.subtle,urls,timers,ratio:()=>1,...opts.create});
  return {...w,p,lib,log,downloads,get imports(){return imports;},status:()=>w.get('red-preview-status').textContent,canvas:()=>w.get('red-preview-stage').children};}

test('bundle: exact verified File bytes render page 1 locally; the File survives PDF.js buffer transfer and is reused for repeat download',async()=>{
  const v=preview(),bytes=pdfBytes(),file=pdfFile(bytes);await v.p.show({file,sha256:sha(bytes)});await until(()=>v.canvas().length===1,'page drawn');
  assert.equal(v.get('red-preview').hidden,false);assert.equal(v.canvas()[0].painted,1);assert.ok(v.log.received[0].equals(bytes),'PDF.js got exactly the downloaded bytes');
  const params=v.log.params[0];assert.equal(params.isEvalSupported,false);assert.equal(params.disableFontFace,true);assert.equal(params.disableAutoFetch,true);assert.equal(params.disableStream,true);assert.equal(params.enableXfa,false);
  assert.equal('url' in params,false,'data only, never a URL fetch');for(const k of ['cMapUrl','standardFontDataUrl','wasmUrl'])assert.ok(params[k].startsWith(BASE+'vendor/'),k+' stays on the vendored local copy');
  assert.equal(v.lib.GlobalWorkerOptions.workerSrc,BASE+'vendor/pdf.worker.mjs');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes),'transfer detached only the preview read, never the File');
  assert.match(v.status(),/^1 \/ 3쪽 · 다운로드한 바이트 그대로/);assert.equal(v.get('red-preview-page').textContent,'1 / 3쪽');assert.equal(v.get('red-preview-hash').textContent,'SHA-256 '+sha(bytes));
  assert.match(v.canvas()[0].getAttribute('aria-label'),/1쪽 미리보기 \(전체 3쪽\)/);assert.equal(v.canvas()[0].getAttribute('role'),'img');
  assert.equal(v.get('red-preview-prev').disabled,true);assert.equal(v.get('red-preview-next').disabled,false);assert.equal(v.get('red-preview-download').disabled,false);
  v.get('red-preview-download').click();assert.equal(v.downloads.length,1);assert.equal(v.downloads[0],file,'same File object, nothing regenerated');
  const a=v.created.find(e=>e.tagName==='a');assert.equal(a.download,file.name);assert.equal(v.log.cleanups,1);assert.doesNotMatch(v.status(),/통과|증명했|검증 완료/);});

test('bundle: hash mismatch, missing PDF signature, invalid hash and empty input never reach PDF.js',async()=>{
  const bytes=pdfBytes();let v=preview();await v.p.show({file:pdfFile(bytes),sha256:sha(Buffer.from('other'))});
  assert.equal(v.log.params.length,0);assert.equal(v.imports,0);assert.match(v.status(),/검증된 해시와 달라/);assert.equal(v.get('red-preview-download').disabled,true,'mismatched read cannot be re-downloaded here');
  assert.equal(v.get('red-preview-status').classList.contains('error'),true);
  v=preview();const plain=Buffer.from('not a pdf at all');await v.p.show({file:pdfFile(plain),sha256:sha(plain)});
  assert.equal(v.log.params.length,0);assert.match(v.status(),/PDF 서명이 없어/);assert.equal(v.get('red-preview-download').disabled,false,'verified bytes stay downloadable');
  for(const bad of [{},{file:pdfFile(bytes)},{file:pdfFile(bytes),sha256:'AB'.repeat(32)},{file:pdfFile(bytes),sha256:sha(bytes).slice(1)},{file:null,sha256:sha(bytes)}]){
    v=preview();await v.p.show(bad);assert.equal(v.get('red-preview').hidden,true,JSON.stringify(Object.keys(bad)));assert.equal(v.p.current(),null);}});

test('bundle: output over 64 MiB is not read or rendered; the verified download stays available',async()=>{
  const v=preview(),file={name:'big-falsify-research.pdf',size:64*1024*1024+1,arrayBuffer:()=>{throw new Error('must not read');}};
  await v.p.show({file,sha256:'ab'.repeat(32)});assert.equal(v.imports,0);assert.match(v.status(),/64 MiB를 넘어 미리보기를 생략/);assert.equal(v.get('red-preview-download').disabled,false);
  v.get('red-preview-download').click();assert.equal(v.downloads[0],file);
  const small=preview({create:{maxBytes:4}}),bytes=pdfBytes();await small.p.show({file:pdfFile(bytes),sha256:sha(bytes)});assert.equal(small.log.params.length,0,'bound is configurable and enforced before reading');});

test('stale: clear while the document is loading destroys the task and a late resolve never paints',async()=>{
  const v=preview({hold:true}),bytes=pdfBytes(),pending=v.p.show({file:pdfFile(bytes),sha256:sha(bytes)});await until(()=>v.log.tasks.length===1,'load started');
  v.p.clear();await settle();assert.equal(v.log.tasks[0].destroyed,true);v.log.tasks[0].open();await pending;await settle();
  assert.equal(v.log.renders.length,0);assert.equal(v.canvas().length,0);assert.equal(v.get('red-preview').hidden,true);assert.equal(v.status(),'');assert.equal(v.get('red-preview-download').disabled,true);});

test('stale: a newer show supersedes an older one at every step; only the newest File is painted and downloadable',async()=>{
  const v=preview({hold:true}),a=pdfBytes('A'),b=pdfBytes('B'),fa=pdfFile(a,'a.pdf'),fb=pdfFile(b,'b.pdf');
  const first=v.p.show({file:fa,sha256:sha(a)});await until(()=>v.log.tasks.length===1,'A loading');
  const second=v.p.show({file:fb,sha256:sha(b)});await settle();assert.equal(v.log.tasks[0].destroyed,true,'A torn down');
  await until(()=>v.log.tasks.length===2,'B loading');v.log.tasks[0].open();v.log.tasks[1].open();await Promise.all([first,second]);await until(()=>v.canvas().length===1,'B drawn');
  assert.equal(v.log.renders.length,1);assert.ok(v.log.received[1].equals(b));assert.equal(v.p.current().file,fb);v.get('red-preview-download').click();assert.equal(v.downloads[0],fb);
  // Superseded before its hash finished: the old read is dropped without loading PDF.js for it.
  const w=preview(),c=pdfBytes('C'),d=pdfBytes('D');const x=w.p.show({file:pdfFile(c),sha256:sha(c)}),y=w.p.show({file:pdfFile(d),sha256:sha(d)});await Promise.all([x,y]);await until(()=>w.canvas().length===1,'D drawn');
  assert.equal(w.log.params.length,1);assert.ok(w.log.received[0].equals(d));});

test('stale: page navigation cancels the in-flight render; a late stale page never replaces the current one',async()=>{
  const v=preview({manual:true}),bytes=pdfBytes();void v.p.show({file:pdfFile(bytes),sha256:sha(bytes)});await until(()=>v.log.renders.length===1,'p1 rendering');
  assert.equal(v.get('red-preview-next').disabled,false);v.get('red-preview-next').click();await until(()=>v.log.renders.length===2,'p2 rendering');
  assert.equal(v.log.renders[0].r.cancelled,true,'p1 render cancelled');v.log.renders[0].r.finish();v.get('red-preview-next').click();await until(()=>v.log.renders.length===3,'p3 rendering');
  assert.equal(v.log.renders[1].r.cancelled,true);v.log.renders[2].r.finish();await until(()=>v.canvas().length===1,'p3 drawn');
  assert.equal(v.canvas()[0].painted,3);assert.equal(v.get('red-preview-next').disabled,true,'last page');assert.equal(v.get('red-preview-prev').disabled,false);
  v.get('red-preview-next').click();await settle();assert.equal(v.log.renders.length,3,'no render past the last page');
  v.get('red-preview-prev').click();await until(()=>v.log.renders.length===4,'p2 again');v.p.clear();await settle();assert.equal(v.log.renders[3].r.cancelled,true,'clear cancels rendering');
  v.log.renders[3].r.finish();await settle();assert.equal(v.canvas().length,0);assert.equal(v.get('red-preview').hidden,true);});

test('stale: a render that completes after cancellation is discarded, never swapped in over the current page',async()=>{
  const v=preview({manual:true,deaf:true}),bytes=pdfBytes();void v.p.show({file:pdfFile(bytes),sha256:sha(bytes)});await until(()=>v.log.renders.length===1,'p1 rendering');
  v.get('red-preview-next').click();await until(()=>v.log.renders.length===2,'p2 rendering');v.log.renders[1].r.finish();await until(()=>v.canvas().length===1,'p2 drawn');
  v.log.renders[0].r.finish();await settle();assert.equal(v.canvas().length,1);assert.equal(v.canvas()[0].painted,2,'late p1 dropped');assert.equal(v.log.renders[0].canvas.width,0,'late canvas released');
  assert.equal(v.get('red-preview-page').textContent,'2 / 3쪽');
  v.get('red-preview-next').click();await until(()=>v.log.renders.length===3,'p3 rendering');v.p.clear();v.log.renders[2].r.finish();await settle();assert.equal(v.canvas().length,0,'late render after clear dropped');});

test('failure: render and load errors show fixed copy, never raw PDF/engine text, and keep the verified download',async()=>{
  const bytes=pdfBytes(),file=pdfFile(bytes);let v=preview({badPages:new Set([1])});await v.p.show({file,sha256:sha(bytes)});await until(()=>/그리지 못했습니다/.test(v.status()),'render error');
  assert.match(v.status(),/^1쪽을 그리지 못했습니다\. 다른 쪽은 이전·다음으로 시도할 수 있습니다\. 다운로드한 사본과 해시는 그대로 유효하며/);assert.doesNotMatch(v.status(),/secret|<b>/);
  assert.equal(v.get('red-preview-download').disabled,false);assert.equal(v.get('red-preview-next').disabled,false,'other pages remain reachable');v.get('red-preview-download').click();assert.equal(v.downloads[0],file);
  for(const [name,copy] of [['InvalidPDFException',/PDF 구조를 읽지 못해/],['PasswordException',/암호가 걸린 PDF/],['UnknownErrorException',/이 브라우저에서 미리보기를 그리지 못했습니다/]]){
    v=preview({loadError:Object.assign(new Error('Invalid: secret extracted sentence C:/Users/x/paper.pdf'),{name})});await v.p.show({file,sha256:sha(bytes)});await until(()=>v.get('red-preview-status').classList.contains('error'),name);
    assert.match(v.status(),copy);assert.doesNotMatch(v.status(),/secret|C:\//);assert.equal(v.get('red-preview-download').disabled,false);assert.equal(v.get('red-preview-next').disabled,true);}
  v=preview({create:{importPdf:async()=>{throw new Error('module secret');}}});await v.p.show({file,sha256:sha(bytes)});assert.match(v.status(),/이 브라우저에서 미리보기를 그리지 못했습니다/);assert.doesNotMatch(v.status(),/secret/);});

test('failure: a load that exceeds 60 s is destroyed once and the timeout copy is not overwritten by the late rejection',async()=>{
  const v=preview({hold:true}),bytes=pdfBytes();const shown=v.p.show({file:pdfFile(bytes),sha256:sha(bytes)});await until(()=>v.timeouts.length===1,'timer armed');
  v.timeouts[0]();await shown;await settle();assert.equal(v.log.tasks[0].destroyed,true);assert.match(v.status(),/^60초 안에 PDF를 열지 못해/);assert.equal(v.get('red-preview-download').disabled,false);
  v.log.tasks[0].open();await settle();assert.equal(v.log.renders.length,0);});

test('bounds: render scale fits the stage and caps side and area for oversized pages',()=>{
  const ctx=vm.createContext({URL,TextDecoder,Uint8Array,Promise,Error,Math,Number,Array,Object,String});vm.runInContext(BUNDLE,ctx);const fit=ctx.FalsifyPreview.fitScale;
  assert.equal(fit({width:612,height:792},612,1),1);assert.equal(fit({width:612,height:792},1224,1),2);assert.equal(fit({width:612,height:792},612,3),2,'device ratio capped at 2');
  const s=fit({width:20000,height:20000},800,2);assert.ok(20000*s<=4096&&20000*s*20000*s<=4096*4096);const long=fit({width:100,height:100000},640,2);assert.ok(100000*long<=4096);
  for(const bad of [{width:0,height:10},{width:NaN,height:10},{width:-1,height:-1}])assert.equal(fit(bad,640,1),0);});

test('focus: reaching a page boundary moves keyboard focus to the opposite nav button instead of dropping it',async()=>{
  const v=preview({pages:2}),bytes=pdfBytes(),prev=v.get('red-preview-prev'),next=v.get('red-preview-next');await v.p.show({file:pdfFile(bytes),sha256:sha(bytes)});await until(()=>v.canvas().length===1,'p1 drawn');
  next.focus();next.click();assert.equal(next.disabled,true,'last page');assert.equal(v.document.activeElement,prev,'focus handed to prev, not body');await until(()=>v.canvas()[0]?.painted===2,'p2 drawn');
  assert.equal(v.document.activeElement,prev);prev.click();assert.equal(prev.disabled,true,'first page');assert.equal(v.document.activeElement,next,'mirrored on page 1');await until(()=>v.canvas()[0]?.painted===1,'p1 again');
  const w=preview({pages:3}),n3=w.get('red-preview-next');await w.p.show({file:pdfFile(bytes),sha256:sha(bytes)});await until(()=>w.canvas().length===1,'3-page p1');
  n3.focus();n3.click();assert.equal(w.document.activeElement,n3,'interior page keeps focus where it was');await until(()=>w.canvas()[0]?.painted===2,'3-page p2');
  w.document.activeElement=w.document.body;n3.click();assert.equal(w.document.activeElement,w.document.body,'focus is never stolen when no nav button had it');});

test('failure: a page whose getPage/render exceeds 60 s is cancelled with fixed copy; a late finish never paints and other pages still draw',async()=>{
  const v=preview({manual:true,deaf:true}),bytes=pdfBytes(),file=pdfFile(bytes),armed=()=>v.timeouts.filter(Boolean);void v.p.show({file,sha256:sha(bytes)});await until(()=>v.log.renders.length===1,'p1 rendering');
  assert.equal(armed().length,1,'load timer cleared, one page timer armed');armed()[0]();
  assert.equal(v.log.renders[0].r.cancelled,true,'stuck render cancelled');assert.match(v.status(),/^1쪽을 60초 안에 그리지 못해 멈췄습니다\. 다른 쪽은 이전·다음으로 시도할 수 있습니다\. 다운로드한 사본과 해시는 그대로 유효하며, 「같은 사본 다시 다운로드」로 같은 파일을 다시 받을 수 있습니다\.$/);
  assert.equal(v.get('red-preview-status').classList.contains('error'),true);assert.equal(v.get('red-preview-download').disabled,false);assert.equal(v.get('red-preview-next').disabled,false);
  v.log.renders[0].r.finish();await settle();assert.equal(v.canvas().length,0,'late page 1 dropped after timeout');assert.match(v.status(),/60초 안에 그리지 못해/,'timeout copy not overwritten');
  v.get('red-preview-download').click();assert.equal(v.downloads[0],file);
  v.get('red-preview-next').click();await until(()=>v.log.renders.length===2,'p2 rendering');v.log.renders[1].r.finish();await until(()=>v.canvas()[0]?.painted===2,'p2 drawn');
  assert.equal(armed().length,0,'finished draw clears its timer');v.p.clear();await settle();assert.equal(armed().length,0);});

test('markup: toolbar and status sit before the page stage in DOM order; copy is direction-neutral; the canvas is flat',()=>{
  const at=HTML.indexOf('<section class="red-preview"'),section=HTML.slice(at,HTML.indexOf('</section>',at)),stage=section.indexOf('id="red-preview-stage"');assert.ok(stage>0);
  for(const id of ['prev','page','next','download','status'])assert.ok(section.indexOf('id="red-preview-'+id+'"')>0&&section.indexOf('id="red-preview-'+id+'"')<stage,id+' precedes the stage');
  assert.ok(section.indexOf('id="red-preview-status"')>section.indexOf('id="red-preview-download"'),'status follows the toolbar');
  // The minified bundle escapes Hangul, so fixed copy is checked in the source it is built from (the RED/failure tests cover the bundle's output).
  assert.match(section,/<button[^>]*id="red-preview-download"[^>]*>같은 사본 다시 다운로드<\/button>/);assert.match(SOURCE,/「같은 사본 다시 다운로드」로/);assert.doesNotMatch(SOURCE,/아래에서|위에서|아래의|위의/,'no direction in fixed copy');
  assert.match(section,/SHA-256을 다시 확인한 뒤에만/);assert.doesNotMatch(section,/SHA-256 일치/,'note does not assert equality before the async re-check');
  const rules=CSS.match(/[^{}]*\.red-preview[^{}]*\{[^}]*\}/g)||[];assert.ok(rules.length>=5);for(const r of rules)assert.doesNotMatch(r,/box-shadow/,r);
  assert.match(CSS,/\.red-preview-canvas\{[^}]*border:1px solid var\(--line\)/);});

test('markup: canvas-only preview with labelled controls; no iframe/object/embed; CSP unchanged',()=>{
  const section=HTML.slice(HTML.indexOf('<section class="red-preview"'),HTML.indexOf('</section>',HTML.indexOf('<section class="red-preview"')));
  assert.ok(section.includes('aria-labelledby="red-preview-title"'));assert.match(section,/id="red-preview-status"[^>]*role="status"[^>]*aria-live="polite"/);
  for(const id of ['prev','next','download'])assert.match(section,new RegExp('<button class="button secondary" type="button" id="red-preview-'+id+'" disabled>[^<]+</button>'));
  assert.doesNotMatch(HTML,/<iframe|<object|<embed/i);assert.ok(HTML.includes("object-src 'none'"));assert.match(section,/증명하지 않습니다/);
  assert.ok(HTML.indexOf('src="document-preview.js"')<HTML.indexOf('src="document-red.js"'),'bundle loads before RED');
  assert.doesNotMatch(BUNDLE,/https?:\/\/(?!127\.0\.0\.1)[a-z]/i,'no remote URL in the bundle');});

// RED wiring: the real document-red.js with a mocked bridge, the real preview bundle and the mocked PDF.js.
const SEG0='The trial shows a modest benefit in adults.',SEG1='Effects were observed only in the treated cohort.',BEFORE1='only in the treated cohort';
const SRC=Buffer.from('%PDF-1.7 synthetic source'),OUT=pdfBytes('synthetic preserved output');
function red({cap={red:true,blue:true,pdf:true},format='PDF',pdf={}}={}){
  const w=dom(),{lib,log}=pdfjs(pdf),downloads=[],calls=[],handoffs=[];let reply=async()=>({file:OUT.toString('base64'),sourceFileHash:sha(SRC),outputFileHash:sha(OUT),verification:{mode:'pdf-original-font-single-line',pages:3}});
  w.get('red-level').value='1';w.get('red-budget').value='4';w.get('document-red').hidden=true;
  const URLmock={createObjectURL:b=>{downloads.push(b);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const pctx=vm.createContext({URL,TextDecoder,Uint8Array,Promise,Error,Math,Number,Array,Object,String});vm.runInContext(BUNDLE,pctx);
  const FalsifyPreview={createPreview:()=>pctx.FalsifyPreview.createPreview({document:w.document,importPdf:async()=>lib,subtle:globalThis.crypto.subtle,urls:URLmock,timers:globalThis,ratio:()=>1})};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busy(){},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,session:()=>({request:async(p,body)=>{calls.push({path:p,body});return reply(p,body);}})};
  const textFile=async()=>({bytes:new Uint8Array(Buffer.from('plain output')),verification:null});
  const ctx=vm.createContext({document:w.document,crypto:globalThis.crypto,FalsifyDocumentRed:C,FalsifyHarness:require('../dist/harness-core.js'),FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{textFile},FalsifyPreview,TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object});
  vm.runInContext(RED,ctx,{filename:'document-red.js'});w.document.addEventListener('falsify:blue-file',e=>handoffs.push(e.detail));
  const fire=(type,detail)=>w.document.dispatchEvent(new CustomEvent(type,{cancelable:true,detail}));
  const r={...w,lib,log,downloads,calls,handoffs,fire,set reply(f){reply=f;},status:()=>text(w.get('red-export-status')),pstatus:()=>w.get('red-preview-status').textContent,canvas:()=>w.get('red-preview-stage').children,
    async ready(){const name=format==='PDF'?'paper.pdf':'paper.txt';
      fire('falsify:document',{file:{name,type:format==='PDF'?'application/pdf':'text/plain',arrayBuffer:async()=>new Uint8Array(SRC).buffer},result:{text:SEG0+'\n'+SEG1,format,segments:[{label:'p1',text:SEG0},{label:'p2',text:SEG1}]}});
      await until(()=>!w.get('document-red').hidden,'document bound');await settle();
      w.get('red-request').click();await until(()=>downloads.length===1,'request saved');const q=JSON.parse(await downloads.pop().text());
      w.get('red-response').value=JSON.stringify({schema:q.schema,revision:q.revision,sourceHash:q.sourceHash,status:'ok',candidates:[{id:'c1',segmentId:'s1',level:1,before:BEFORE1,after:'in every cohort',rationale:'Synthetic contradiction.',evidence:[{segmentId:'s1',quote:SEG1,relation:'Synthetic relation.'}],uncertainty:'Domain review required.'}]});
      w.get('red-import-response').click();await settle();const box=w.created.find(e=>e.type==='checkbox');box.checked=true;box.dispatchEvent(new Event('change'));
      const c=w.get('red-export-consent');c.checked=true;c.dispatchEvent(new Event('change'));},
    async export(){w.get('red-download').click();await until(()=>/다운로드했습니다|다운로드 차단/.test(r.status()),'export settled');await settle();},
    edit(v){const a=w.created.find(e=>e.id==='red-after-0');a.value=v;a.dispatchEvent(new Event('input'));},
    handoff(){const ev=new Event('click');Object.defineProperty(ev,'target',{value:{closest:s=>s==='#red-handoff'?{}:null}});w.document.dispatchEvent(ev);}};
  return r;}

test('RED: a verified PDF export previews the very File that was downloaded and is handed to BLUE; no automatic BLUE',async()=>{
  const r=red();await r.ready();await r.export();await until(()=>r.canvas().length===1,'preview drawn');
  assert.equal(r.get('red-preview').hidden,false);assert.equal(r.handoffs.length,0,'preview never starts BLUE');assert.equal(r.calls.filter(c=>c.path!=='/api/export').length,0,'no extra broker call');
  assert.ok(Buffer.from(await r.downloads[0].arrayBuffer()).equals(OUT),'first download unchanged');assert.ok(r.log.received[0].equals(OUT),'preview rendered the same bytes');
  assert.equal(r.get('red-preview-hash').textContent,'SHA-256 '+sha(OUT));assert.equal(r.get('red-handoff').hidden,false);
  r.get('red-preview-download').click();const again=r.downloads.at(-1);r.handoff();assert.equal(r.handoffs.length,1);assert.equal(again,r.handoffs[0].file,'repeat download and BLUE handoff share one File');
  assert.ok(Buffer.from(await again.arrayBuffer()).equals(OUT));assert.equal(r.calls.length,1,'no re-export for repeat download');});

test('RED: candidate/After changes, source reset, settings and harness changes clear the preview and drop late renders',async()=>{
  const steps=[['After edit',r=>r.edit('in every cohort, including the untreated one')],['candidate unchecked',r=>{const b=r.created.find(e=>e.type==='checkbox');b.checked=false;b.dispatchEvent(new Event('change'));}],
    ['source reset',r=>r.fire('falsify:document-clear')],['harness change',r=>r.fire('falsify:harness-change',{role:'red'})],['level change',r=>{r.get('red-level').value='2';r.get('red-level').dispatchEvent(new Event('change'));}]];
  for(const [label,step] of steps){const r=red({pdf:{manual:true}});await r.ready();await r.export();await until(()=>r.log.renders.length===1,label+': rendering');
    step(r);await settle();assert.equal(r.get('red-preview').hidden,true,label);assert.equal(r.log.renders[0].r.cancelled,true,label+': render cancelled');
    r.log.renders[0].r.finish();await settle();assert.equal(r.canvas().length,0,label+': no stale paint');assert.equal(r.pstatus(),'',label);assert.equal(r.get('red-preview-download').disabled,true,label);}
  const r=red({pdf:{hold:true}});await r.ready();await r.export();await until(()=>r.log.tasks.length===1,'loading');r.edit('changed while loading');await settle();
  assert.equal(r.log.tasks[0].destroyed,true,'pending PDF.js document destroyed');});

test('RED: a new export clears the old preview first; a failed export leaves none behind',async()=>{
  const r=red();await r.ready();await r.export();await until(()=>r.canvas().length===1,'first preview');
  r.reply=async()=>({file:OUT.toString('base64'),sourceFileHash:sha(SRC),outputFileHash:'0'.repeat(64),verification:{mode:'pdf-original-font-single-line'}});
  r.get('red-download').click();assert.equal(r.get('red-preview').hidden,true,'cleared at export start');await until(()=>/다운로드 차단/.test(r.status()),'blocked');await settle();
  assert.match(r.status(),/출력 해시와 받은 파일이 달라/);assert.equal(r.get('red-preview').hidden,true);assert.equal(r.log.params.length,1,'no preview for unverified bytes');
  r.reply=async()=>({file:OUT.toString('base64'),outputFileHash:sha(OUT),verification:{engine:'falsify-pdf-editor',layoutVerified:true,independentQA:'failed',independentChecks:{status:'failed'}}});
  r.get('red-download').click();await until(()=>/다운로드 차단/.test(r.status())&&!r.get('red-download').disabled,'qa blocked');await settle();assert.equal(r.get('red-preview').hidden,true);});

test('RED: render failure keeps the verified export, success status and BLUE handoff intact; malformed QA stays unverified',async()=>{
  const r=red({pdf:{badPages:new Set([1])}});
  await r.ready();r.reply=async()=>({file:OUT.toString('base64'),outputFileHash:sha(OUT),verification:{mode:'pdf-original-font-single-line',pages:3}});
  await r.export();await until(()=>/1쪽을 그리지 못했습니다/.test(r.pstatus()),'render failed');
  assert.match(r.status(),/^실험용 사본과 별도 변경 계획을 다운로드했습니다/);assert.equal(r.get('red-handoff').hidden,false);r.handoff();assert.equal(r.handoffs.length,1);
  assert.ok(Buffer.from(await r.handoffs[0].file.arrayBuffer()).equals(OUT));assert.equal(r.get('red-preview-download').disabled,false);
  const m=red({cap:{red:true,blue:true,pdf:true,pdfEditor:{available:true,engine:'falsify-pdf-editor',version:'0.4.1',wasmSha256:'ab'.repeat(32),reflow:true,pagination:true}}});await m.ready();
  m.reply=async()=>({file:OUT.toString('base64'),outputFileHash:sha(OUT),verification:{engine:'falsify-pdf-editor',layoutVerified:true,pagination:{inputPages:3,outputPages:3},reflow:{wrappedLines:0},independentQA:'passed',independentChecks:{schema:'falsify.pdf-quality.v1',status:'passed',method:'x',checks:[]}}});
  await m.export();await until(()=>m.canvas().length===1,'malformed-QA preview');assert.match(m.status(),/독립 검사 형식 확인 불가/);assert.doesNotMatch(m.status()+m.pstatus(),/독립 검사 통과/);});

test('RED: non-PDF exports never show a PDF preview',async()=>{
  const r=red({cap:{red:true,blue:true},format:'TXT'});await r.ready();await r.export();await settle();
  assert.match(r.status(),/다운로드했습니다/);assert.equal(r.get('red-preview').hidden,true);assert.equal(r.log.params.length,0);assert.equal(r.get('red-handoff').hidden,false,'existing handoff unchanged');});

// A test that never settles would otherwise let Node exit quietly with status 0.
let finished=false;process.on('exit',()=>{if(!finished){console.error('not ok - suite exited before every test settled');process.exitCode=1;}});
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('ok - '+name);}catch(e){failed++;console.error('not ok - '+name+'\n'+(e.stack||e));}}
  finished=true;console.log(tests.length-failed+'/'+tests.length+' pdf-preview checks passed');if(failed)process.exitCode=1;})();
