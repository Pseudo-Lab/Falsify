import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const filePath=path.join(import.meta.dirname,'../dist/paper-evidence-ui.js');
const source=fs.readFileSync(filePath,'utf8');
vm.runInThisContext(source,{filename:'paper-evidence-ui.js'});
const UI=globalThis.FalsifyPaperEvidenceUI;
const SECRET='<img src=x onerror=alert(1)> C:/secret/paper.pdf';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pdf=label=>Buffer.from('%PDF-1.4\n'+label+'\n');
const pngBytes=()=>Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3,4]);

const realCreate=URL.createObjectURL?.bind(URL);
const realRevoke=URL.revokeObjectURL?.bind(URL);
let sink=null;
URL.createObjectURL=blob=>{
  const u=realCreate?realCreate(blob):'blob:paper-evidence-'+Math.random().toString(16).slice(2);
  sink?.created.push({u,blob});
  return u;
};
URL.revokeObjectURL=u=>{sink?.revoked.push(u);if(realRevoke)realRevoke(u);};

let tail=Promise.resolve();
function serial(name, fn){
  test(name, ()=>{
    const run=tail.then(fn, fn);
    tail=run.then(()=>{},()=>{});
    return run;
  });
}
function deferred(){
  let settled=false, resolve, reject;
  const promise=new Promise((ok, bad)=>{
    resolve=v=>{if(!settled){settled=true;ok(v);}};
    reject=e=>{if(!settled){settled=true;bad(e);}};
  });
  return {promise, resolve, reject};
}
function element(tag){
  const el=new EventTarget(), classes=new Set(), attrs={};
  el.tag=tag; el.children=[]; el.hidden=false; el.disabled=false; el.checked=false; el.value='';
  el.type=''; el.name=''; el.src=''; el.alt=''; el.open=false; el._text='';
  el.classList={
    add(...xs){for(const x of xs)classes.add(x);},
    remove(...xs){for(const x of xs)classes.delete(x);},
    contains:x=>classes.has(x),
    toggle(x, on){const v=on==null?!classes.has(x):!!on; if(v)classes.add(x); else classes.delete(x); return v;}
  };
  Object.defineProperty(el,'className',{
    get(){return [...classes].join(' ');},
    set(v){classes.clear(); for(const x of String(v||'').split(/\s+/))if(x)classes.add(x);}
  });
  Object.defineProperty(el,'textContent',{
    get(){return el._text;},
    set(v){el._text=v==null?'':String(v); el.children=[];}
  });
  el.setAttribute=(k,v)=>{attrs[k]=String(v);};
  el.getAttribute=k=>Object.hasOwn(attrs,k)?attrs[k]:null;
  el.removeAttribute=k=>{delete attrs[k]; if(k==='src')el.src='';};
  el.append=(...nodes)=>{el.children.push(...nodes);};
  el.replaceChildren=(...nodes)=>{el.children=nodes;};
  el.click=()=>{el.dispatchEvent(new Event('click'));};
  return el;
}
function all(node){
  const out=[];
  (function walk(n){for(const c of n.children||[]){if(c?.tag&&c.tag!=='#text')out.push(c); if(c)walk(c);}})(node);
  return out;
}
function text(node){
  if(!node)return '';
  if(node.children?.length)return node.children.map(text).join('');
  return node.textContent||'';
}
function fileOf(bytes, hooks={}){
  const copy=Uint8Array.from(bytes);
  return {size:hooks.size??copy.length, arrayBuffer:async()=>{hooks.reads=(hooks.reads||0)+1; if(hooks.swap)hooks.swap(); return copy.slice().buffer;}};
}
function summary(hash, over={}){
  return {schema:'falsify.paper-evidence.v1', paperId:'pid-'+hash.slice(0,12), fileHash:hash, status:'ready', pageCount:3,
    counts:{tables:2, figures:1}, engine:'pymupdf-native', limitations:['caption association is heuristic'],
    expiresAt:new Date(Date.now()+3_600_000).toISOString(), ...over};
}
function item(over={}){
  return {id:'t1', type:'table', pageIndex:0, bbox:[10,20,110,90], caption:'Table '+SECRET, provenance:'pymupdf find_tables', ...over};
}
function renderOf(hash, it, over={}){
  const bytes=pngBytes();
  return {paperId:'pid-'+hash.slice(0,12), fileHash:hash, pageIndex:it.pageIndex, bbox:[...it.bbox], mimeType:'image/png',
    data:bytes.toString('base64'), sha256:sha(bytes), width:40, height:20, ...over};
}
async function flush(){for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));}
async function until(cond, label){
  const deadline=Date.now()+2000;
  while(!cond()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,1));
  assert.ok(cond(), label);
}

function harness(onRequest){
  const calls=[], created=[], revoked=[], storage=[];
  const host=element('div');
  const doc={createElement:tag=>element(tag), createTextNode(value){const n=element('#text'); n.textContent=value; return n;}};
  host.ownerDocument=doc;
  let source=null, changes=0;
  const session={request(path, body, options){
    const d=deferred();
    const rec={path, body, options, ...d};
    calls.push(rec);
    onRequest?.(rec);
    if(options?.signal?.aborted)d.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    else options?.signal?.addEventListener('abort',()=>d.reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
    return d.promise;
  }};
  sink={created, revoked};
  const ui=UI.create({
    host,
    getSession:()=>session,
    getSource:()=>source,
    onChange:()=>{changes++;}
  });
  const box=()=>all(host).find(e=>e.tag==='input'&&e.type==='checkbox');
  const status=()=>all(host).find(e=>e.tag==='p'&&e.classList.contains('form-feedback'));
  const toggle=on=>{const input=box(); input.checked=on; input.dispatchEvent(new Event('change'));};
  return {ui, host, calls, created, revoked, storage, box, status, toggle, get changes(){return changes;}, get source(){return source;}, set source(v){source=v;}};
}
function prepares(h){return h.calls.filter(c=>c.path==='/api/paper/evidence/prepare');}
function lists(h){return h.calls.filter(c=>c.body?.operation==='list');}
function renders(h){return h.calls.filter(c=>c.body?.operation==='render');}

test('source does not store paper bytes or parse paper text as HTML',()=>{
  assert.equal(typeof UI.create,'function');
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB/);
  assert.match(source,/표·그림 함께 검토/);
  assert.match(source,/\/api\/paper\/evidence\/prepare/);
  assert.match(source,/\/api\/paper\/evidence\/query/);
});

serial('unchecked evidence stays text-only and does not call the companion',async()=>{
  const h=harness();
  const bytes=pdf('idle');
  h.source={file:fileOf(bytes), fileHash:sha(bytes), revision:'r1'};
  assert.equal(await h.ui.requestEvidence(), null);
  h.ui.setBusy(false);
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.changes, 0);
  assert.match(text(h.status()), /텍스트만 검토합니다/);
  assert.equal(h.ui.snapshot().checked, false);
  assert.equal(h.ui.snapshot().paperId, null);
  assert.equal(JSON.stringify(h.ui.snapshot()).includes(bytes.toString('base64')), false);
});

serial('checking the box prepares once, shows counts, and reuses the same file',async()=>{
  const h=harness();
  const bytes=pdf('ready');
  const hash=sha(bytes);
  h.source={file:fileOf(bytes), fileHash:hash, revision:'r1'};
  h.toggle(true);
  assert.equal(h.changes, 1);
  await until(()=>prepares(h).length===1, 'prepare started');
  const snap=h.ui.snapshot();
  assert.equal(snap.preparing, true);
  assert.equal(snap.paperId, null);
  assert.equal(snap.checked, true);
  const body=prepares(h)[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['file','fileHash']);
  assert.equal(body.fileHash, hash);
  assert.equal(Buffer.from(body.file,'base64').toString(), bytes.toString());
  const pending=h.ui.requestEvidence();
  prepares(h)[0].resolve(summary(hash));
  const handle=await pending;
  assert.deepEqual(Object.keys(handle).sort(), ['fileHash','paperId']);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(handle.fileHash, hash);
  assert.equal(handle.paperId, 'pid-'+hash.slice(0,12));
  assert.match(text(h.status()), /표 2 · 그림 1 · 3쪽 · 준비됨/);
  const details=all(h.host).filter(e=>e.tag==='details');
  assert.equal(details.length, 2);
  assert.equal(details[0].open, false);
  assert.equal(details[1].open, false);
  assert.match(text(details[1]), /엔진 pymupdf-native/);
  assert.match(text(details[1]), /caption association is heuristic/);
  assert.match(text(details[1]), /추출 엔진과 한계/);
  await until(()=>lists(h).length===1, 'list started');
  assert.deepEqual(Object.keys(lists(h)[0].body).sort(), ['limit','offset','operation','paperId']);
  assert.equal(lists(h)[0].body.offset, 0);
  assert.equal(lists(h)[0].body.limit, 50);
  lists(h)[0].resolve({paperId:handle.paperId, fileHash:hash, total:1, nextOffset:null, items:[item()]});
  await flush();
  assert.equal(h.changes, 1, 'list render is not a selection change');
  assert.match(text(all(h.host).find(e=>e.classList.contains('image-rows'))), /Table <img src=x onerror=alert\(1\)>/);
  assert.equal(all(all(h.host).find(e=>e.classList.contains('image-rows'))).filter(e=>e.tag==='img').length, 0);
  h.source={...h.source, revision:'r2'};
  const again=await h.ui.requestEvidence();
  assert.equal(again.paperId, handle.paperId);
  assert.equal(prepares(h).length, 1);
  assert.equal(h.ui.snapshot().counts.tables, 2);
  assert.equal(JSON.stringify(h.ui.snapshot()).includes('Table'), false);
  assert.equal(h.storage.length, 0);
});

serial('a file change during prepare drops the stale result and prepares the new PDF',async()=>{
  const h=harness();
  const first=pdf('first'), second=pdf('second');
  const oldHash=sha(first), nextHash=sha(second);
  h.source={file:fileOf(first), fileHash:oldHash, revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'first prepare');
  const pending=h.ui.requestEvidence();
  h.source={file:fileOf(second), fileHash:nextHash, revision:'r2'};
  prepares(h)[0].resolve(summary(oldHash,{counts:{tables:7, figures:6}}));
  await assert.rejects(pending, /입력이 바뀌어 표·그림 근거를 보내지 않았습니다/);
  await until(()=>prepares(h).length===2, 'second prepare');
  assert.equal(prepares(h)[1].body.fileHash, nextHash);
  assert.equal(Buffer.from(prepares(h)[1].body.file,'base64').toString(), second.toString());
  assert.doesNotMatch(text(h.status()), /표 7/);
  prepares(h)[1].resolve(summary(nextHash,{counts:{tables:1, figures:0}, pageCount:1}));
  await until(()=>/표 1 · 그림 0 · 1쪽 · 준비됨/.test(text(h.status())), 'new counts');
  assert.equal(h.ui.snapshot().paperId, 'pid-'+nextHash.slice(0,12));
});

serial('bytes that change before the request is sent are not uploaded',async()=>{
  const h=harness();
  const first=pdf('live'), second=pdf('swapped');
  h.source={file:fileOf(first,{swap:()=>{h.source={file:fileOf(second), fileHash:sha(second), revision:'r2'};}}), fileHash:sha(first), revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'prepare after swap');
  assert.equal(prepares(h)[0].body.fileHash, sha(second));
  assert.doesNotMatch(text(h.status()), /표 \d/);
});

serial('unchecking cancels the in-flight prepare and returns null',async()=>{
  const h=harness();
  const bytes=pdf('cancel');
  h.source={file:fileOf(bytes), fileHash:sha(bytes), revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'prepare');
  const pending=h.ui.requestEvidence();
  h.toggle(false);
  assert.equal(h.changes, 2);
  assert.equal(prepares(h)[0].options.signal.aborted, true);
  assert.equal(await pending, null);
  prepares(h)[0].resolve(summary(sha(bytes)));
  await flush();
  assert.match(text(h.status()), /텍스트만 검토합니다/);
  assert.doesNotMatch(text(h.status()), /표 2/);
  assert.equal(h.ui.snapshot().paperId, null);
  assert.equal(await h.ui.requestEvidence(), null);
});

serial('failures stay on fixed copy, do not persist, and do not retry until asked',async()=>{
  const h=harness();
  const bytes=pdf('fail');
  const hash=sha(bytes);
  h.source={file:fileOf(bytes), fileHash:hash, revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'prepare');
  const pending=h.ui.requestEvidence();
  prepares(h)[0].reject(new Error(SECRET));
  await assert.rejects(pending, e=>e.message==='표·그림 준비에 실패했습니다. 다시 준비를 누르세요.'&&!e.message.includes('secret'));
  assert.doesNotMatch(text(h.status()), /secret|onerror|C:/);
  assert.equal(h.status().classList.contains('error'), true);
  h.ui.setBusy(false);
  await flush();
  assert.equal(prepares(h).length, 1);
  const retry=all(h.host).find(e=>e.tag==='button'&&text(e)==='다시 준비');
  assert.equal(retry.hidden, false);
  retry.click();
  await until(()=>prepares(h).length===2, 'manual retry');
  prepares(h)[1].resolve(summary(hash,{schema:'nope', raw:SECRET}));
  await flush();
  assert.match(text(h.status()), /실패했습니다/);
  assert.doesNotMatch(text(h.host), /secret|onerror/);
  assert.equal(h.storage.length, 0);
});

serial('hash mismatch, a non-PDF, and an oversized file never upload',async()=>{
  const h=harness();
  const bytes=pdf('hash');
  h.source={file:fileOf(bytes), fileHash:sha(pdf('other')), revision:'r1'};
  h.toggle(true);
  await until(()=>/바뀌어/.test(text(h.status())), 'hash mismatch');
  assert.equal(h.calls.length, 0);
  h.ui.clear();
  const textBytes=Buffer.from('not a pdf document');
  h.source={file:fileOf(textBytes), fileHash:sha(textBytes), revision:'r2'};
  h.toggle(true);
  await until(()=>/PDF가 아니라/.test(text(h.status())), 'not pdf');
  assert.equal(h.calls.length, 0);
  h.ui.clear();
  let reads=0;
  h.source={file:{size:25*1024*1024+1, arrayBuffer:async()=>{reads++; return textBytes.buffer;}}, fileHash:'ab'.repeat(32), revision:'r3'};
  h.toggle(true);
  await until(()=>/25 MiB/.test(text(h.status())), 'too large');
  assert.equal(reads, 0);
  assert.equal(h.calls.length, 0);
});

serial('the source list pages, the crop is an object URL, and clear revokes it',async()=>{
  const h=harness();
  const bytes=pdf('crop');
  const hash=sha(bytes);
  h.source={file:fileOf(bytes), fileHash:hash, revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'prepare');
  const before=h.changes;
  h.ui.setBusy(true);
  assert.equal(h.box().disabled, true);
  h.box().checked=false;
  h.box().dispatchEvent(new Event('change'));
  assert.equal(h.box().checked, true);
  assert.equal(h.changes, before);
  const pending=h.ui.requestEvidence();
  prepares(h)[0].resolve(summary(hash,{status:'partial', limitations:['page 2 extractor failed']}));
  const handle=await pending;
  assert.match(text(h.status()), /일부만 준비됨/);
  await until(()=>lists(h).length===1, 'list');
  const first=item({id:'t1', caption:'Alpha'});
  const second=item({id:'f1', type:'figure', pageIndex:1, bbox:[1,2,30,40], caption:'Beta'});
  lists(h)[0].resolve({paperId:handle.paperId, fileHash:hash, total:2, nextOffset:1, items:[first]});
  await flush();
  const more=all(h.host).find(e=>e.tag==='button'&&text(e)==='다음 표·그림');
  assert.equal(more.hidden, false);
  h.ui.setBusy(false);
  more.click();
  await until(()=>lists(h).length===2, 'next page');
  assert.equal(lists(h)[1].body.offset, 1);
  lists(h)[1].resolve({paperId:handle.paperId, fileHash:hash, total:2, nextOffset:null, items:[second]});
  await flush();
  assert.equal(more.hidden, true);
  const radios=all(h.host).filter(e=>e.tag==='input'&&e.type==='radio');
  assert.equal(radios.length, 2);
  radios[0].checked=true;
  radios[0].dispatchEvent(new Event('change'));
  assert.equal(h.changes, before, 'crop selection does not notify inclusion');
  await until(()=>renders(h).length===1, 'render');
  assert.equal(renders(h)[0].body.dpi, 120);
  assert.deepEqual(renders(h)[0].body.bbox, first.bbox);
  renders(h)[0].resolve(renderOf(hash, first));
  await until(()=>h.created.length===1, 'object url');
  const img=all(h.host).find(e=>e.tag==='img');
  assert.equal(img.hidden, false);
  assert.equal(img.src, h.created[0].u);
  assert.match(img.alt, /표 · 1쪽 영역/);
  assert.doesNotMatch(img.alt, /Alpha/);
  radios[1].checked=true;
  radios[1].dispatchEvent(new Event('change'));
  await until(()=>renders(h).length===2, 'second render');
  assert.equal(h.revoked.includes(h.created[0].u), true);
  renders(h)[1].resolve(renderOf(hash, second, {sha256:'ab'.repeat(32)}));
  // WebCrypto finishes on a worker thread, independently of event-loop turns.
  await until(()=>/그리지 못했습니다/.test(text(all(h.host).filter(e=>e.classList.contains('form-feedback')).at(-1))), 'mismatched crop digest');
  assert.equal(img.hidden, true);
  assert.match(text(all(h.host).filter(e=>e.classList.contains('form-feedback')).at(-1)), /그리지 못했습니다/);
  radios[1].dispatchEvent(new Event('change'));
  await until(()=>renders(h).length===3, 'retry crop');
  renders(h)[2].resolve(renderOf(hash, second));
  await until(()=>h.created.length===2, 'second url');
  assert.equal(img.hidden, false);
  const changes=h.changes;
  h.ui.clear();
  assert.equal(h.changes, changes);
  assert.equal(h.box().checked, false);
  assert.equal(h.revoked.includes(h.created.at(-1).u), true);
  assert.equal(h.ui.snapshot().paperId, null);
  assert.equal(await h.ui.requestEvidence(), null);
});

serial('a list failure keeps the prepared counts',async()=>{
  const h=harness();
  const bytes=pdf('list-fail');
  const hash=sha(bytes);
  h.source={file:fileOf(bytes), fileHash:hash, revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'prepare');
  prepares(h)[0].resolve(summary(hash));
  await until(()=>lists(h).length===1, 'list');
  lists(h)[0].reject(new Error(SECRET));
  await flush();
  assert.match(text(h.status()), /표 2 · 그림 1/);
  assert.match(text(h.host), /목록을 불러오지 못했습니다/);
  assert.doesNotMatch(text(h.host), /secret|onerror/);
});

serial('an expired prepare is refused and clear does not notify inclusion',async()=>{
  const h=harness();
  const bytes=pdf('expired');
  const hash=sha(bytes);
  h.source={file:fileOf(bytes), fileHash:hash, revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1, 'prepare');
  const pending=h.ui.requestEvidence();
  prepares(h)[0].resolve(summary(hash,{expiresAt:new Date(Date.now()-1000).toISOString()}));
  await assert.rejects(pending, /만료/);
  assert.equal(h.ui.snapshot().paperId, null);
  assert.equal(h.ui.snapshot().error, 'expired');
  const changes=h.changes;
  h.ui.clear();
  assert.equal(h.changes, changes);
  assert.match(text(h.status()), /텍스트만 검토합니다/);
});

serial('real bridge status emission does not reenter the same list request',async()=>{
  let h;
  h=harness(()=>h.ui.setBusy(false));
  const bytes=pdf('reentry'),hash=sha(bytes);
  h.source={file:fileOf(bytes),fileHash:hash,revision:'r1'};
  h.toggle(true);
  await until(()=>prepares(h).length===1,'prepare');
  prepares(h)[0].resolve(summary(hash,{limitations:Array.from({length:30},(_,i)=>'page_extract_failed:'+i)}));
  await until(()=>lists(h).length===1,'one list request');
  for(let i=0;i<5;i++)h.ui.setBusy(false);
  assert.equal(lists(h).length,1);
  lists(h)[0].resolve({paperId:'pid-'+hash.slice(0,12),fileHash:hash,items:[item({provenance:{engine:'pymupdf',method:'Page.find_tables'}})],total:1,nextOffset:null});
  await flush();
  assert.equal(h.ui.snapshot().listed,1);
  assert.equal(h.changes,1);
  assert.equal(h.ui.snapshot().error,null);
});

serial('a restarted companion cannot reuse the previous process paper handle',async()=>{
  const h=harness(),bytes=pdf('restart'),hash=sha(bytes),file=fileOf(bytes);
  h.source={file,fileHash:hash,revision:'r1',companionInstance:'ci1.one'};h.toggle(true);
  await until(()=>prepares(h).length===1,'first prepare');
  prepares(h)[0].resolve(summary(hash,{paperId:'first-process'}));
  await flush();
  const before=await h.ui.requestEvidence();assert.equal(before.paperId,'first-process');
  h.source={file,fileHash:hash,revision:'r1',companionInstance:'ci1.two'};h.ui.setBusy(false);
  await until(()=>prepares(h).length===2,'new process prepare');
  prepares(h)[1].resolve(summary(hash,{paperId:'second-process'}));
  await flush();
  assert.equal((await h.ui.requestEvidence()).paperId,'second-process');
});

serial('large source crops lower render DPI without cutting the region',async()=>{
 const h=harness(),bytes=pdf('large-crop'),hash=sha(bytes);h.source={file:fileOf(bytes),fileHash:hash};h.toggle(true);
 await until(()=>prepares(h).length===1,'prepare');prepares(h)[0].resolve(summary(hash));
 await until(()=>lists(h).length===1,'list');
 const bounds=[0,0,842,1191];lists(h)[0].resolve({paperId:'pid-'+hash.slice(0,12),fileHash:hash,items:[item({bbox:bounds})],total:1,nextOffset:null});await flush();
 const radio=all(h.host).find(e=>e.tag==='input'&&e.type==='radio');radio.checked=true;radio.dispatchEvent(new Event('change'));
 await until(()=>renders(h).length===1,'render');const request=renders(h)[0].body;assert.deepEqual(request.bbox,bounds);assert.ok(request.dpi<120);assert.ok((842*request.dpi/72)*(1191*request.dpi/72)<2000000);
});
