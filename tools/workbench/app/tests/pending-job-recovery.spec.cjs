'use strict';
// Offline recovery contract. Memory storage and mocked GET only. No model, network, or live companion.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../dist/pending-job.js');
const Red=require('../dist/document-red-core.js');
const Blue=require('../dist/document-blue-core.js');
const H=require('../dist/harness-core.js');
const L=require('../dist/local-bridge.js');
const dist=path.resolve(__dirname,'../dist');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const INSTANCE='ci1.'+'ab'.repeat(32);
const OTHER='ci1.'+'cd'.repeat(32);
const FILE='11'.repeat(32);
function memory(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),dump:()=>m.get(P.storageKey('red'))};}
function blueMemory(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};}
const hashHarness=h=>H.hash(h);
function doc(over={}){return {revision:'rev-1',sourceHash:'aa'.repeat(32),fileHash:FILE,format:'TXT',name:'notes.txt',segments:[{id:'s0',label:'p',text:'The claim is absolute.'}],...over};}
function request(d,role,over={}){
  const base=role==='blue'
    ?{schema:Blue.VERSION,revision:d.revision,sourceHash:d.sourceHash,requestId:d.revision+':job-1',maxCalls:1,consent:true,segments:d.segments.map(s=>({id:s.id,label:s.label,text:s.text})),harness:H.builtin('blue')}
    :{schema:Red.VERSION,revision:d.revision,sourceHash:d.sourceHash,format:d.format,segments:d.segments,level:1,maxCalls:1,consent:true,requestId:d.revision+':job-1',harness:H.builtin('red')};
  return {...base,...over};
}
async function hold(storage,over={}){
  const role=over.role||'red',d=over.doc||doc();
  return P.hold({role,request:over.request||request(d,role,over.requestOver),doc:d,companionInstance:over.instance||INSTANCE,storage,now:over.now||1_700_000_000_000,hashHarness:over.hashHarness||hashHarness});
}
function job(record,state,extra={}){return {httpStatus:200,body:{id:record.requestId,role:record.role,state,sourceHash:record.sourceHash,revision:record.revision,harnessHash:record.harnessHash,companionInstance:record.companionInstance,requestBytesDigest:record.requestBytesDigest,progress:{completedCalls:0},...extra}};}
async function sha256Text(text){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Buffer.from(buf).toString('hex');}
function wrap(n,leaf){let v=leaf;for(let i=0;i<n;i++)v={n:v};return v;}
const validate=(d,res)=>Red.validateResponse(d,res);
function resultFor(record){return {schema:Red.VERSION,revision:record.revision,sourceHash:record.sourceHash,status:'abstain',candidates:[]};}

test('reload completed uses the real RED validator and never posts',async()=>{
  const storage=memory(),held=await hold(storage);assert.equal(held.ok,true);
  await P.note(held.record,{postReceipt:'accepted'},storage);
  let posts=0,gets=[];
  const outcome=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async id=>{gets.push(id);return job(held.record,'completed',{result:resultFor(held.record)});},post:()=>{posts++;}});
  assert.equal(outcome.status,'completed');assert.equal(outcome.gets,1);assert.deepEqual(gets,[held.record.requestId]);assert.equal(posts,0);
  assert.equal(outcome.result.status,'abstain');assert.equal(outcome.doc.fileHash,FILE);
  assert.equal(JSON.stringify(outcome.record).includes('Bearer'),false);
});
test('running job older than the result window is still fetched',async()=>{
  const storage=memory(),start=1_700_000_000_000,held=await hold(storage,{now:start});
  await P.note(held.record,{postReceipt:'accepted',disposition:'running'},storage);
  const outcome=await P.recover({role:'red',storage,now:start+2*3600*1000,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>job(held.record,'running')});
  assert.equal(outcome.status,'still-running');assert.equal(outcome.gets,1);assert.equal(outcome.record.expiresAt,null);
});
test('failed, cancelled, 404, auth, and unknown receipt stay visible and stored',async()=>{
  const storage=memory(),held=await hold(storage);await P.note(held.record,{postReceipt:'accepted'},storage);
  const failed=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>job(held.record,'failed',{error:'boom'})});
  assert.equal(failed.status,'failed');assert.equal(failed.gets,1);assert.equal(P.read('red',storage).status,'record');
  const cancelled=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>job(held.record,'cancelled')});
  assert.equal(cancelled.status,'cancelled');
  const missing=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>({httpStatus:404,body:{error:'not_found'}})});
  assert.equal(missing.status,'not-found');assert.equal(P.read('red',storage).record.requestId,held.record.requestId);
  const auth=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>({httpStatus:403,body:null})});
  assert.equal(auth.status,'auth-refused');assert.equal(auth.gets,1);
  const fresh=memory(),unknown=await hold(fresh);await P.note(unknown.record,{postReceipt:'unknown'},fresh);
  const lost=await P.recover({role:'red',storage:fresh,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>{throw new Error('socket');}});
  assert.equal(lost.status,'receipt-unknown');assert.equal(P.read('red',fresh).record.postReceipt,'unknown');
});
test('finished record past retention is expired on 404 and kept; a live 200 is still accepted',async()=>{
  const storage=memory(),held=await hold(storage);await P.note(held.record,{postReceipt:'accepted',disposition:'failed',finishedAt:1_000},storage);
  const expired=await P.recover({role:'red',storage,now:1_000+P.RETENTION_MS,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>({httpStatus:404,body:null})});
  assert.equal(expired.status,'expired');assert.equal(P.read('red',storage).status,'record');
  const live=await P.recover({role:'red',storage,now:1_000+P.RETENTION_MS,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>job(held.record,'running')});
  assert.equal(live.status,'still-running');
});
test('missing or wrong id, role, source, harness, or instance is not success',async()=>{
  const storage=memory(),held=await hold(storage);await P.note(held.record,{postReceipt:'accepted'},storage);
  const base={role:'red',storage,companionInstance:INSTANCE,hashHarness,validate};
  const drop=(key)=>{const body=job(held.record,'completed',{result:resultFor(held.record)}).body;delete body[key];return {httpStatus:200,body};};
  for(const key of ['id','role','sourceHash','revision','harnessHash','companionInstance','requestBytesDigest']){
    const outcome=await P.recover({...base,getJob:async()=>drop(key)});
    assert.notEqual(outcome.status,'completed',key);assert.equal(outcome.gets,1,key);assert.equal(outcome.result,undefined,key);
  }
  const wrong=await P.recover({...base,getJob:async()=>job({...held.record,requestId:'rev-1:other'},'completed',{result:resultFor(held.record)})});
  assert.equal(wrong.status,'request-mismatch');
  const role=await P.recover({...base,getJob:async()=>{const body=job(held.record,'completed',{result:resultFor(held.record)}).body;body.role='blue';return {httpStatus:200,body};}});
  assert.equal(role.status,'role-mismatch');
  const restarted=await P.recover({...base,companionInstance:OTHER,getJob:async()=>{throw new Error('should not get');}});
  assert.equal(restarted.status,'server-restarted');assert.equal(restarted.gets,0);
  const unverified=await P.recover({...base,companionInstance:null,getJob:async()=>{throw new Error('should not get');}});
  assert.equal(unverified.status,'instance-unverified');assert.equal(unverified.gets,0);
});
test('changed input, changed harness, and a corrupt record do not GET or overwrite',async()=>{
  const storage=memory(),held=await hold(storage);await P.note(held.record,{postReceipt:'accepted'},storage);
  const changed=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,currentDoc:{...doc(),sourceHash:'bb'.repeat(32)},getJob:async()=>{throw new Error('should not get');}});
  assert.equal(changed.status,'hash-mismatch');assert.equal(changed.gets,0);
  const raw=JSON.parse(storage.dump());raw.request.harness.instructions='changed';storage.setItem(P.storageKey('red'),JSON.stringify(raw));
  const harness=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>{throw new Error('should not get');}});
  assert.equal(harness.status,'hash-mismatch');assert.equal(harness.gets,0);
  storage.setItem(P.storageKey('red'),'{');
  const corrupt=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>{throw new Error('should not get');}});
  assert.equal(corrupt.status,'corrupt');assert.equal(corrupt.gets,0);assert.equal(storage.dump(),'{');
  const again=await hold(storage);assert.equal(again.ok,false);assert.equal(again.blocked,'corrupt');assert.equal(storage.dump(),'{');
});
test('hold does not overwrite unresolved, failed, or unknown records; discard requires acknowledgement',async()=>{
  const storage=memory(),held=await hold(storage);assert.equal(held.ok,true);assert.equal(held.record.postReceipt,'pending');
  const dup=await hold(storage,{requestOver:{requestId:'rev-1:job-2'}});assert.equal(dup.ok,false);assert.equal(dup.blocked,'unresolved');
  assert.equal(P.read('red',storage).record.requestId,held.record.requestId);
  assert.equal(P.discard('red',{storage}).ok,false);assert.equal(P.read('red',storage).status,'record');
  await P.note(held.record,{postReceipt:'unknown'},storage);
  const afterThrow=await hold(storage);assert.equal(afterThrow.blocked,'unknown');
  await P.note(P.read('red',storage).record,{postReceipt:'accepted',disposition:'failed',finishedAt:50},storage);
  const afterFail=await hold(storage);assert.equal(afterFail.blocked,'failed');
  assert.equal(P.discard('red',{acknowledge:true,storage}).ok,true);
  const next=await hold(storage,{requestOver:{requestId:'rev-1:job-2'}});assert.equal(next.ok,true);assert.equal(next.record.requestId,'rev-1:job-2');
});
test('a settled completed record can be replaced; the other role cannot',async()=>{
  const storage=memory(),box=blueMemory();
  const held=await hold(storage);await P.note(held.record,{postReceipt:'accepted',disposition:'completed',finishedAt:10},storage);
  const next=await hold(storage,{requestOver:{requestId:'rev-1:job-2'}});assert.equal(next.ok,true);
  const red=await hold(storage);assert.equal(red.ok,false);
  const blue=await P.hold({role:'blue',request:request(doc(),'blue'),doc:doc(),companionInstance:INSTANCE,storage:box,hashHarness,now:10});
  assert.equal(blue.ok,true);assert.equal(P.read('red',storage).record.role,'red');
});
test('secrets, PDF bytes, and BLUE gold or filename are rejected and not stored',async()=>{
  const storage=memory();
  for(const key of ['token','authorization','bearer','session','pdf','bytes']){
    const bad=await hold(storage,{requestOver:{[key]:'x'}});assert.equal(bad.ok,false,key);assert.equal(storage.dump(),undefined,key);
  }
  const box=blueMemory();
  const d=doc();
  const tainted=await P.hold({role:'blue',request:{...request(d,'blue'),gold:['x'],filename:'red-out.pdf'},doc:d,companionInstance:INSTANCE,storage:box,hashHarness});
  assert.equal(tainted.ok,false);assert.equal(box.getItem(P.storageKey('blue')),null);
  const clean=await P.hold({role:'blue',request:request(d,'blue'),doc:d,companionInstance:INSTANCE,storage:box,hashHarness,now:10});
  assert.equal(clean.ok,true);
  const saved=JSON.parse(box.getItem(P.storageKey('blue')));
  assert.equal(saved.request.gold,undefined);assert.equal(saved.request.filename,undefined);assert.equal(saved.request.sourceName,undefined);
  assert.deepEqual(Object.keys(saved.request).sort(),['consent','harness','maxCalls','requestId','revision','schema','segments','sourceHash']);
});
test('invalid completed body is not applied; note cannot retarget the request id',async()=>{
  const storage=memory(),held=await hold(storage);await P.note(held.record,{postReceipt:'accepted'},storage);
  const bad=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>job(held.record,'completed',{result:{schema:'no'}})});
  assert.equal(bad.status,'invalid-result');assert.equal(bad.result,undefined);
  const sneaky=await P.note({...held.record,requestId:'rev-1:other'},{postReceipt:'accepted'},storage);
  assert.equal(sneaky.ok,false);assert.equal(P.read('red',storage).record.requestId,held.record.requestId);
});
test('bridge keeps a valid companion instance and ignores an old payload',async()=>{
  const TOKEN='Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789';
  const CAP={red:true,blue:true,pdf:true,officeLayoutVerifiedExport:false,model:'gpt-6.1-sol',isolation:'x'};
  const reply=data=>({ok:true,status:200,redirected:false,type:'cors',json:async()=>data});
  const pair=async cap=>{const bridge=L.create({fetch:async()=>reply(cap),location:{hostname:'example.test',port:''}});assert.equal((await bridge.pair(TOKEN,'7816')).ok,true);return bridge.capabilities();};
  assert.equal((await pair(CAP)).companionInstance,null);
  assert.equal((await pair({...CAP,companionInstance:INSTANCE})).companionInstance,INSTANCE);
  assert.equal((await pair({...CAP,companionInstance:'launcher-secret'})).companionInstance,null);
  assert.equal(L.companionInstance(INSTANCE),INSTANCE);assert.equal(L.companionInstance('secret'),null);
});
test('shipped page loads the helper before the role modules and does not persist secrets there',()=>{
  const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
  const order=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]);
  assert.ok(order.indexOf('pending-job.js')>order.indexOf('harness-core.js'));
  assert.ok(order.indexOf('pending-job.js')<order.indexOf('document-red.js'));
  assert.ok(order.indexOf('pending-job.js')<order.indexOf('document-blue.js'));
  const helper=fs.readFileSync(path.join(dist,'pending-job.js'),'utf8');
  assert.equal(helper.includes('localStorage.setItem'),false);
  assert.match(helper,/setItem\(storageKey/);
});
test('role modules store before POST when the helper is present and keep the direct path otherwise',()=>{
  const red=fs.readFileSync(path.join(dist,'document-red.js'),'utf8');
  const blue=fs.readFileSync(path.join(dist,'document-blue.js'),'utf8');
  for(const src of [red,blue]){assert.equal(/\btoken\b/.test(src),false);assert.equal(/\bfetch\(/.test(src),false);assert.equal(src.includes('/api/session'),false);}
  assert.ok(red.indexOf('P.hold(')<red.indexOf('UNSHIPPED_TEST_ISOLATION'));
  assert.ok(blue.indexOf('P.hold(')<blue.indexOf('UNSHIPPED_TEST_ISOLATION'));
  assert.ok(red.lastIndexOf("'/api/red/jobs',request")>red.indexOf('UNSHIPPED_TEST_ISOLATION'));
  assert.ok(blue.lastIndexOf("'/api/blue/jobs',request")>blue.indexOf('UNSHIPPED_TEST_ISOLATION'));
  assert.match(red,/대기 기록 도우미가 없거나 손상되어/);assert.match(blue,/대기 기록 도우미가 없거나 손상되어/);
  assert.match(red,/busy=true;controls\(\);/);assert.match(blue,/busy=true;controls\(\);/);
  assert.match(red,/sourceFileRequired/);assert.match(red,/red-source-reselect/);assert.match(red,/acknowledge:true/);
  assert.match(blue,/acknowledge:true/);assert.equal(blue.includes('.gold'),false);
  const recover=red.slice(red.indexOf('async function recoverRed'),red.indexOf('async function confirmReselect'));
  assert.equal(recover.includes("'/api/red/jobs'"),false);assert.match(recover,/probe\('red'/);
});
test('byte digest tracks the wire JSON, and budget, level, unicode or float changes reject the other trial',async()=>{
  const storage=memory(),low=await hold(storage,{requestOver:{maxCalls:1,level:1}});
  const highBox=memory(),high=await hold(highBox,{requestOver:{maxCalls:8,level:3,requestId:'rev-1:job-1'}});
  assert.equal(low.ok,true);assert.equal(high.ok,true);
  assert.equal(low.record.requestId,high.record.requestId);
  assert.equal(low.record.harnessHash,high.record.harnessHash);
  assert.equal(low.record.sourceHash,high.record.sourceHash);
  assert.notEqual(low.record.requestBytesDigest,high.record.requestBytesDigest);
  assert.equal(low.record.requestBytesDigest,await sha256Text(JSON.stringify(low.record.request)));
  assert.notEqual(low.record.requestBytesDigest,low.record.requestFingerprint);
  assert.notEqual(P.canonical(low.record.request),JSON.stringify(low.record.request));
  const js=JSON.stringify({harness:{settings:{large:1e20,tiny:1e-7,'😀':1,'':2}},requestId:'synthetic'});
  const py='{"harness": {"settings": {"large": 1e+20, "tiny": 1e-07, "": 2, "😀": 1}}, "requestId": "synthetic"}';
  assert.notEqual(js,py);assert.notEqual(P.canonical(JSON.parse(js)),js);
  await P.note(low.record,{postReceipt:'accepted'},storage);
  const wrong=await P.recover({role:'red',storage,companionInstance:INSTANCE,hashHarness,validate,getJob:async()=>job(low.record,'completed',{result:resultFor(low.record),requestBytesDigest:high.record.requestBytesDigest})});
  assert.equal(wrong.status,'hash-mismatch');assert.equal(wrong.result,undefined);assert.equal(P.read('red',storage).record.request.maxCalls,1);
});
test('secrets at depth 13 are rejected and objects past the walk bound are rejected',async()=>{
  const storage=memory();
  const hidden=await hold(storage,{requestOver:{buried:wrap(12,{token:'deep-token'})}});
  assert.equal(hidden.ok,false);assert.match(hidden.message,/비밀/);assert.equal(storage.dump(),undefined);
  const deep=await hold(storage,{requestOver:{buried:wrap(64,{plain:1})}});
  assert.equal(deep.ok,false);assert.match(deep.message,/중첩/);assert.equal(storage.dump(),undefined);
  const seen=await hold(storage,{requestOver:{buried:wrap(11,{token:'still-seen'})}});
  assert.equal(seen.ok,false);assert.match(seen.message,/비밀/);
});
test('concurrent hold keeps one unresolved record and does not let the loser replace it',async()=>{
  const storage=memory();
  let release;const gate=new Promise(r=>{release=r;});
  const slow=async h=>{await gate;return H.hash(h);};
  const first=hold(storage,{hashHarness:slow,requestOver:{requestId:'rev-1:job-a',maxCalls:1}});
  const second=hold(storage,{requestOver:{requestId:'rev-1:job-b',maxCalls:8}});
  const early=await second;
  assert.equal(early.ok,false);assert.equal(early.blocked,'unresolved');
  release();
  const winner=await first;
  assert.equal(winner.ok,true);assert.equal(winner.record.requestId,'rev-1:job-a');
  assert.equal(P.read('red',storage).record.requestId,'rev-1:job-a');
  const again=await hold(storage,{requestOver:{requestId:'rev-1:job-b'}});
  assert.equal(again.ok,false);assert.equal(P.read('red',storage).record.request.maxCalls,1);
});
test('a record planted during hashing is not overwritten',async()=>{
  const storage=memory();
  const hashOnce=async h=>{storage.setItem(P.storageKey('red'),'{');return H.hash(h);};
  const planted=await P.hold({role:'red',request:request(doc(),'red'),doc:doc(),companionInstance:INSTANCE,storage,hashHarness:hashOnce,now:10});
  assert.equal(planted.ok,false);assert.equal(planted.blocked,'corrupt');assert.equal(storage.dump(),'{');
});

let htmlWrites=0;
function element(id){
  const e=new EventTarget();
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],files:[],className:'',
    classList:{toggle(){}},replaceChildren(){},append(){},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},
    getClientRects:()=>[],addEventListener(t,f){EventTarget.prototype.addEventListener.call(this,t,f);}});
  Object.defineProperty(e,'innerHTML',{set(){htmlWrites++;},get(){return e.textContent||'';}});
  return e;
}
function vmStorage(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),raw:m};}
async function redPage(storage,hooks,options={}){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);};
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:tag=>element(tag),body:element('body')});
  get('red-level').value='1';get('red-budget').value='8';get('red-empty').textContent='empty';
  const calls=[];
  const cap={red:true,pdf:false,companionInstance:INSTANCE};
  const bridge={busy(){},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,session:()=>({request:async(p,body)=>{calls.push({path:p,body});return hooks.reply(p,body,calls);}})};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:async(role,r)=>({...r,harness:H.builtin(role)}),record:async()=>'run-1'};
  if(options.shipped){const script=element('pending-job.js');script.src='pending-job.js';script.getAttribute=name=>name==='src'?'pending-job.js':null;document.scripts=[script];}
  const ctx=vm.createContext({document,crypto:globalThis.crypto,localStorage:storage,FalsifyDocumentRed:Red,FalsifyHarness:H,FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},TextEncoder,TextDecoder,CustomEvent,Event,URL:{createObjectURL:()=>'blob:1',revokeObjectURL(){}},Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object,console});
  if(options.helper!==false)vm.runInContext(fs.readFileSync(path.join(dist,'pending-job.js'),'utf8'),ctx,{filename:'pending-job.js'});
  vm.runInContext(fs.readFileSync(path.join(dist,'document-red.js'),'utf8'),ctx,{filename:'document-red.js'});
  const text='The claim is absolute.';
  return {get,calls,async load(){document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file:{name:'notes.txt',arrayBuffer:async()=>new TextEncoder().encode(text).buffer},result:{text,format:'TXT',segments:[{label:'p',text}]}}}));
    for(let i=0;i<50&&get('document-red').hidden!==false;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(get('document-red').hidden,false);}};
}
test('RED page writes the pending record before POST and does not POST again after a throw or a reload',async()=>{
  const storage=vmStorage();let failPost=true;
  const page=await redPage(storage,{reply:async(p)=>{if(p==='/api/red/jobs'&&failPost)throw new Error('post failed');return {id:'unused'};}});
  await page.load();page.get('red-consent').checked=true;page.get('red-start').click();
  for(let i=0;i<40;i++){const raw=storage.raw.get(P.storageKey('red'));if(raw&&JSON.parse(raw).postReceipt==='unknown')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(page.calls.length,1);assert.equal(page.calls[0].path,'/api/red/jobs');
  const saved=JSON.parse(storage.raw.get(P.storageKey('red')));
  assert.equal(saved.postReceipt,'unknown');assert.equal(saved.requestId,page.calls[0].body.requestId);
  const postsBefore=page.calls.length;
  page.get('red-start').click();await new Promise(r=>setTimeout(r,20));
  assert.equal(page.calls.length,postsBefore,'blocked record does not POST again');
  const record=saved;
  const reloaded=await redPage(storage,{reply:async(p)=>{
    assert.notEqual(p,'/api/red/jobs');
    if(p==='/api/red/jobs/'+encodeURIComponent(record.requestId))return {id:record.requestId,role:'red',state:'completed',sourceHash:record.sourceHash,revision:record.revision,harnessHash:record.harnessHash,companionInstance:record.companionInstance,requestBytesDigest:record.requestBytesDigest,result:{schema:Red.VERSION,revision:record.revision,sourceHash:record.sourceHash,status:'abstain',candidates:[]}};
    throw new Error('unexpected '+p);
  }});
  for(let i=0;i<40&&!/복구했습니다|식별이 저장된/.test(reloaded.get('red-progress').textContent);i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(reloaded.calls.some(c=>c.path==='/api/red/jobs'),false);
  assert.match(reloaded.get('red-progress').textContent,/복구했습니다/);
  reloaded.get('red-export-consent').checked=true;reloaded.get('red-download').click();await new Promise(r=>setTimeout(r,10));
  assert.equal(reloaded.calls.some(c=>c.path==='/api/export'),false);
  assert.match(reloaded.get('red-export-status').textContent,/원본 파일/);
});
function completedBody(saved){return {id:saved.requestId,role:saved.role,state:'completed',sourceHash:saved.sourceHash,revision:saved.revision,harnessHash:saved.harnessHash,companionInstance:saved.companionInstance,requestBytesDigest:saved.requestBytesDigest,progress:{completedCalls:1},result:saved.role==='blue'?{schema:Blue.VERSION,revision:saved.revision,sourceHash:saved.sourceHash,status:'abstain',findings:[]}:{schema:Red.VERSION,revision:saved.revision,sourceHash:saved.sourceHash,status:'abstain',candidates:[]}};}
test('RED hold failure keeps the visible result and rapid clicks post at most once',async()=>{
  const storage=vmStorage();
  const blocked=await redPage(storage,{reply:async()=>{throw new Error('no post');}});
  await blocked.load();
  await hold(storage);
  blocked.get('red-empty').textContent='KEEP-RESULT';
  blocked.get('red-consent').checked=true;
  blocked.get('red-start').click();
  await new Promise(r=>setTimeout(r,30));
  assert.equal(blocked.calls.filter(c=>c.path==='/api/red/jobs').length,0);
  assert.equal(blocked.get('red-empty').textContent,'KEEP-RESULT');
  assert.match(blocked.get('red-progress').textContent,/덮어쓰지 않았습니다/);
  const fresh=vmStorage();let posts=0;
  const page=await redPage(fresh,{reply:async(p,body)=>{
    if(p==='/api/red/jobs'){posts++;return {id:body.requestId,state:'running'};}
    return completedBody(JSON.parse(fresh.raw.get(P.storageKey('red'))));
  }});
  await page.load();page.get('red-consent').checked=true;page.get('red-start').click();page.get('red-start').click();
  for(let i=0;i<50&&posts<1;i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,40));
  assert.equal(posts,1);assert.equal(page.calls.filter(c=>c.path==='/api/red/jobs').length,1);
  const saved=JSON.parse(fresh.raw.get(P.storageKey('red')));
  assert.equal(saved.requestId,page.calls.find(c=>c.path==='/api/red/jobs').body.requestId);
  assert.equal(saved.requestBytesDigest,await sha256Text(JSON.stringify(saved.request)));
});
test('shipped RED page fails safe without the helper; an unshipped VM may post once',async()=>{
  const shipped=await redPage(vmStorage(),{reply:async()=>{throw new Error('posted');}},{helper:false,shipped:true});
  await shipped.load();shipped.get('red-consent').checked=true;shipped.get('red-start').click();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(shipped.calls.length,0);assert.match(shipped.get('red-progress').textContent,/보내지 않습니다/);
  let posted=null;
  const legacy=await redPage(vmStorage(),{reply:async(p,body)=>{
    if(p==='/api/red/jobs'){posted=body;return {id:body.requestId,state:'running'};}
    return {state:'completed',result:{schema:Red.VERSION,revision:posted.revision,sourceHash:posted.sourceHash,status:'abstain',candidates:[]}};
  }},{helper:false});
  await legacy.load();legacy.get('red-consent').checked=true;legacy.get('red-start').click();legacy.get('red-start').click();
  for(let i=0;i<40&&legacy.calls.filter(c=>c.path==='/api/red/jobs').length<1;i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));
  assert.equal(legacy.calls.filter(c=>c.path==='/api/red/jobs').length,1);
});
async function bluePage(storage,hooks){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);};
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:tag=>element(tag),body:element('body')});
  get('doc-blue-budget').value='4';
  const calls=[],downloads=[];
  const cap={red:true,blue:true,pdf:false,companionInstance:INSTANCE};
  const net={connected:true};
  const bridge={busy(){},state:()=>({status:net.connected?'paired':'manual',connected:net.connected,cap}),capabilities:()=>cap,session:()=>({request:async(p,body)=>{calls.push({path:p,body});return hooks.reply(p,body,calls);}})};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:async(role,r)=>({...r,harness:H.builtin(role)}),record:async()=>'run-1'};
  const importer={extract:async()=>({text:'The claim is absolute.',format:'TXT',warnings:[],segments:[{label:'p',text:'The claim is absolute.'}]})};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,localStorage:storage,FalsifyDocumentBlue:Blue,FalsifyHarness:H,FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyImport:importer,TextEncoder,TextDecoder,CustomEvent,Event,AbortController,URL:{createObjectURL(blob){downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}},Blob,File,setTimeout,clearTimeout,confirm:()=>true,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object,console});
  vm.runInContext(fs.readFileSync(path.join(dist,'pending-job.js'),'utf8'),ctx,{filename:'pending-job.js'});
  vm.runInContext(fs.readFileSync(path.join(dist,'document-blue.js'),'utf8'),ctx,{filename:'document-blue.js'});
  return {get,calls,downloads,disconnect(){net.connected=false;document.dispatchEvent(new CustomEvent('falsify:local-bridge'));},poke(){document.dispatchEvent(new CustomEvent('falsify:local-bridge'));},async load(){get('doc-blue-file').files=[{name:'notes.txt',arrayBuffer:async()=>new TextEncoder().encode('The claim is absolute.').buffer}];get('doc-blue-file').dispatchEvent(new Event('change'));
    for(let i=0;i<50&&!/추출 완료/.test(get('doc-blue-progress').textContent);i++)await new Promise(r=>setTimeout(r,5));
    assert.match(get('doc-blue-progress').textContent,/추출 완료/);}};
}
const CITE='BLUE 재독 기준 인용이 해당 문단에 없거나 중복됩니다.';
function storedBlue(storage){return JSON.parse(storage.raw.get(P.storageKey('blue')));}
function matchedJob(storage,state,extra={}){const record=storedBlue(storage);return {id:record.requestId,role:'blue',state,sourceHash:record.sourceHash,revision:record.revision,harnessHash:record.harnessHash,companionInstance:record.companionInstance,requestBytesDigest:record.requestBytesDigest,progress:{completedCalls:1,requiredCalls:1,phase:'reread'},...extra};}
function jobPosts(calls){return calls.filter(c=>c.path==='/api/blue/jobs');}
async function until(fn,label){for(let i=0;i<80&&!fn();i++)await new Promise(r=>setTimeout(r,25));assert.ok(fn(),label);}
test('optional serverFailure keeps older records and stores only a bounded safe phrase',async()=>{
  const storage=blueMemory();
  const held=await P.hold({role:'blue',request:request(doc(),'blue'),doc:doc(),companionInstance:INSTANCE,storage,hashHarness,now:10});
  assert.equal(held.ok,true);assert.equal(Object.hasOwn(held.record,'serverFailure'),false);
  await P.note(held.record,{postReceipt:'accepted',disposition:'failed',finishedAt:10},storage);
  assert.equal(P.read('blue',storage).record.serverFailure,undefined);
  const noisy=CITE+' <img src=x onerror=alert(1)>';
  const noted=await P.note(P.read('blue',storage).record,{serverFailure:'Bearer abc '+noisy},storage);
  assert.equal(noted.ok,true);assert.equal(noted.record.serverFailure.includes('Bearer'),false);assert.equal(noted.record.serverFailure.includes(CITE),true);assert.equal(noted.record.serverFailure.includes('<img src=x onerror=alert(1)>'),true);
  assert.equal(storage.getItem(P.storageKey('blue')).includes('Bearer abc'),false);
  const clipped=await P.note(noted.record,{serverFailure:'y'.repeat(301)},storage);
  assert.equal(clipped.ok,true);assert.equal(clipped.record.serverFailure,'y'.repeat(300));assert.equal(storage.getItem(P.storageKey('blue')).includes('y'.repeat(301)),false);
  const older=JSON.parse(storage.getItem(P.storageKey('blue')));delete older.serverFailure;storage.setItem(P.storageKey('blue'),JSON.stringify(older));
  assert.equal(P.read('blue',storage).status,'record');assert.equal(P.read('blue',storage).record.serverFailure,undefined);
  const poisoned=JSON.parse(storage.getItem(P.storageKey('blue')));poisoned.serverFailure='Bearer zzz';storage.setItem(P.storageKey('blue'),JSON.stringify(poisoned));
  assert.equal(P.read('blue',storage).status,'corrupt');
  assert.equal(P.safeRequest({request:{token:'x'}}),null);
  assert.equal(P.safeFailure(CITE),CITE);
  const box=blueMemory(),base=await P.hold({role:'blue',request:request(doc(),'blue'),doc:doc(),companionInstance:INSTANCE,storage:box,hashHarness,now:11});
  await P.note(base.record,{postReceipt:'accepted'},box);
  const mismatched=await P.recover({role:'blue',storage:box,companionInstance:INSTANCE,hashHarness,validate:(d,res)=>Blue.validateResponse(d,res),getJob:async()=>job(base.record,'failed',{error:CITE,id:'rev-1:other'})});
  assert.equal(mismatched.status,'request-mismatch');assert.equal(mismatched.error,undefined);assert.equal(JSON.stringify(mismatched).includes(CITE),false);
});
test('BLUE page recovers a completed job with GET only and a double-click posts once',async()=>{
  const storage=vmStorage();let failPost=true;
  const page=await bluePage(storage,{reply:async(p)=>{if(p==='/api/blue/jobs'&&failPost)throw new Error('post failed');return {id:'unused'};}});
  await page.load();page.get('doc-blue-consent').checked=true;page.get('doc-blue-start').click();
  for(let i=0;i<40;i++){const raw=storage.raw.get(P.storageKey('blue'));if(raw&&JSON.parse(raw).postReceipt==='unknown')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(page.calls.filter(c=>c.path==='/api/blue/jobs').length,1);
  const record=JSON.parse(storage.raw.get(P.storageKey('blue')));
  page.get('doc-blue-start').click();await new Promise(r=>setTimeout(r,20));
  assert.equal(page.calls.filter(c=>c.path==='/api/blue/jobs').length,1);
  const reloaded=await bluePage(storage,{reply:async(p)=>{
    assert.notEqual(p,'/api/blue/jobs');
    if(p==='/api/blue/jobs/'+encodeURIComponent(record.requestId))return completedBody(record);
    throw new Error('unexpected '+p);
  }});
  for(let i=0;i<40&&!/복구했습니다/.test(reloaded.get('doc-blue-progress').textContent);i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(reloaded.calls.some(c=>c.path==='/api/blue/jobs'),false);
  assert.match(reloaded.get('doc-blue-progress').textContent,/복구했습니다/);
  const fresh=vmStorage();let posts=0;
  const again=await bluePage(fresh,{reply:async(p,body)=>{
    if(p==='/api/blue/jobs'){posts++;return {id:body.requestId,state:'running'};}
    return completedBody(JSON.parse(fresh.raw.get(P.storageKey('blue'))));
  }});
  await again.load();
  again.get('doc-blue-result-summary').textContent='KEEP-RESULT';
  await P.hold({role:'blue',request:request(doc(),'blue'),doc:doc(),companionInstance:INSTANCE,storage:fresh,hashHarness,now:10});
  again.get('doc-blue-consent').checked=true;again.get('doc-blue-start').click();
  await new Promise(r=>setTimeout(r,30));
  assert.equal(posts,0);assert.equal(again.get('doc-blue-result-summary').textContent,'KEEP-RESULT');
  const open=vmStorage();
  const rapid=await bluePage(open,{reply:async(p,body)=>{
    if(p==='/api/blue/jobs')return {id:body.requestId,state:'running'};
    return completedBody(JSON.parse(open.raw.get(P.storageKey('blue'))));
  }});
  await rapid.load();rapid.get('doc-blue-consent').checked=true;rapid.get('doc-blue-start').click();rapid.get('doc-blue-start').click();
  for(let i=0;i<50&&rapid.calls.filter(c=>c.path==='/api/blue/jobs').length<1;i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,40));
  const bluePosts=rapid.calls.filter(c=>c.path==='/api/blue/jobs');
  assert.equal(bluePosts.length,1);
  assert.equal(JSON.parse(open.raw.get(P.storageKey('blue'))).requestId,bluePosts[0].body.requestId);
});
test('BLUE failure stays visible across live poll, reload, and connection and does not post again',async()=>{
  htmlWrites=0;
  const storage=vmStorage();
  const cite=CITE+' <img src=x onerror=alert(1)>';
  let step='run';
  const page=await bluePage(storage,{reply:async(p,body)=>{
    if(p==='/api/blue/jobs')return {id:body.requestId};
    if(String(p).endsWith('/cancel'))throw new Error('cancel was not requested');
    if(step==='run'){step='fail';return matchedJob(storage,'running');}
    if(step==='fail')return matchedJob(storage,'failed',{error:cite});
    if(step==='foreign')return matchedJob(storage,'failed',{id:'other-request',error:'SHOULD-NOT-APPEAR'});
    if(step==='cancelled')return matchedJob(storage,'cancelled',{error:cite});
    throw new Error('unexpected '+step+' '+p);
  }});
  await page.load();page.get('doc-blue-consent').checked=true;page.get('doc-blue-start').click();
  await until(()=>/BLUE 검토 중/.test(page.get('doc-blue-progress').textContent)&&!page.get('doc-blue-progress').textContent.includes(CITE),'running is not a failure');
  await until(()=>page.get('doc-blue-failure').textContent.includes(cite),'failed poll shows the server phrase');
  assert.equal(page.get('doc-blue-progress').textContent.includes(cite),true);
  assert.equal(page.get('doc-blue-progress').textContent.includes('같은 역할의 대기 기록이 남아 있습니다'),false);
  assert.equal(page.get('doc-blue-failure').textContent.includes('같은 역할의 대기 기록이 남아 있습니다'),false);
  assert.equal(htmlWrites,0);assert.equal(jobPosts(page.calls).length,1);
  const saved=storedBlue(storage),requestSnap=JSON.stringify(saved.request);
  assert.equal(saved.disposition,'failed');assert.equal(saved.serverFailure,cite);assert.equal(saved.request.segments[0].text,'The claim is absolute.');
  assert.equal(JSON.stringify(saved).includes('Bearer'),false);
  step='foreign';page.poke();
  await until(()=>page.get('doc-blue-progress').textContent.includes('바꾸지 않았습니다'),'foreign poll');
  assert.equal(page.get('doc-blue-failure').textContent.includes(cite),true);
  assert.equal(page.get('doc-blue-failure').textContent.includes('SHOULD-NOT-APPEAR'),false);
  assert.equal(page.get('doc-blue-progress').textContent.includes('SHOULD-NOT-APPEAR'),false);
  assert.equal(jobPosts(page.calls).length,1);
  const afterPoll=page.calls.length;page.disconnect();await new Promise(r=>setTimeout(r,40));
  assert.equal(page.calls.length,afterPoll);assert.equal(page.get('doc-blue-failure').textContent.includes(cite),true);
  page.get('doc-blue-start').click();await new Promise(r=>setTimeout(r,30));
  assert.equal(jobPosts(page.calls).length,1);assert.equal(JSON.stringify(storedBlue(storage).request),requestSnap);
  const before=page.downloads.length;
  page.get('doc-blue-failure-diagnostic').click();page.get('doc-blue-failure-request').click();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(page.downloads.length,before+2);
  const diagnostic=JSON.parse(await page.downloads[before].text()),exported=JSON.parse(await page.downloads[before+1].text());
  assert.deepEqual(Object.keys(diagnostic).sort(),['companionInstance','disposition','fileHash','harnessHash','postReceipt','requestBytesDigest','requestFingerprint','requestId','revision','role','schema','serverFailure','sourceHash']);
  assert.equal(diagnostic.serverFailure,cite);assert.equal(JSON.stringify(diagnostic).includes('SHOULD-NOT-APPEAR'),false);assert.equal(JSON.stringify(diagnostic).includes('Bearer'),false);
  assert.deepEqual(exported,JSON.parse(requestSnap));assert.equal(JSON.stringify(exported).includes('"token"'),false);
  let reloadStep='same';
  const reloaded=await bluePage(storage,{reply:async(p)=>{
    assert.notEqual(p,'/api/blue/jobs');
    if(reloadStep==='same')return matchedJob(storage,'failed',{error:cite});
    return matchedJob(storage,'failed',{id:'other-request',error:'SHOULD-NOT-APPEAR'});
  }});
  await until(()=>reloaded.get('doc-blue-failure').textContent.includes(cite),'reload keeps the phrase');
  assert.equal(jobPosts(reloaded.calls).length,0);assert.equal(reloaded.get('doc-blue-failure').textContent.includes('같은 역할의 대기 기록이 남아 있습니다'),false);
  reloadStep='foreign';reloaded.poke();
  await until(()=>reloaded.get('doc-blue-progress').textContent.includes('바꾸지 않았습니다'),'reload foreign poll');
  assert.equal(reloaded.get('doc-blue-failure').textContent.includes(cite),true);assert.equal(reloaded.get('doc-blue-progress').textContent.includes('SHOULD-NOT-APPEAR'),false);
  assert.equal(JSON.stringify(storedBlue(storage).request),requestSnap);assert.equal(jobPosts(reloaded.calls).length,0);
  page.get('doc-blue-pending-discard').click();
  await until(()=>page.get('doc-blue-progress').textContent.includes('버렸습니다'),'discarded');
  assert.equal(storage.raw.has(P.storageKey('blue')),false);assert.equal(jobPosts(page.calls).length,1);assert.equal(page.calls.some(c=>String(c.path).endsWith('/cancel')),false);
  assert.equal(page.get('doc-blue-failure').textContent.includes(CITE),false);
  step='cancelled';page.get('doc-blue-start').click();
  await until(()=>jobPosts(page.calls).length===2,'discard then one explicit post');
  await until(()=>page.get('doc-blue-progress').textContent.includes('BLUE 취소'),'cancelled label');
  assert.equal(page.get('doc-blue-failure').textContent.includes(CITE),false);assert.equal(page.get('doc-blue-progress').textContent.includes('BLUE 실패'),false);
  assert.equal(jobPosts(page.calls).length,2);assert.equal(storedBlue(storage).disposition,'cancelled');assert.equal(storedBlue(storage).serverFailure,undefined);
});
test('a mismatched BLUE failure does not display or store the server phrase',async()=>{
  const storage=vmStorage();
  const page=await bluePage(storage,{reply:async(p,body)=>{
    if(p==='/api/blue/jobs')return {id:body.requestId};
    const record=storedBlue(storage);
    return {id:'other-request',role:'blue',state:'failed',error:CITE+' <img src=x>',sourceHash:record.sourceHash,revision:record.revision,harnessHash:record.harnessHash,companionInstance:record.companionInstance,requestBytesDigest:record.requestBytesDigest};
  }});
  await page.load();page.get('doc-blue-consent').checked=true;page.get('doc-blue-start').click();
  await until(()=>page.get('doc-blue-progress').textContent.includes('식별이 저장한 요청과 달라'),'mismatch message');
  assert.equal(page.get('doc-blue-progress').textContent.includes(CITE),false);
  assert.equal(page.get('doc-blue-failure').textContent.includes(CITE),false);
  assert.equal(jobPosts(page.calls).length,1);assert.equal(storedBlue(storage).serverFailure,undefined);assert.notEqual(storedBlue(storage).disposition,'failed');
  const snap=JSON.stringify(storedBlue(storage).request);
  page.get('doc-blue-start').click();await new Promise(r=>setTimeout(r,30));
  assert.equal(jobPosts(page.calls).length,1);assert.equal(JSON.stringify(storedBlue(storage).request),snap);
});
test('unknown BLUE receipt survives reload and does not show a foreign server phrase',async()=>{
  const storage=vmStorage();
  const page=await bluePage(storage,{reply:async(p)=>{
    if(p==='/api/blue/jobs')throw new Error('post failed');
    const record=storedBlue(storage);
    return {id:'other-request',role:'blue',state:'failed',error:CITE+' <script>alert(1)</script>',sourceHash:record.sourceHash,revision:record.revision,harnessHash:record.harnessHash,companionInstance:record.companionInstance,requestBytesDigest:record.requestBytesDigest};
  }});
  await page.load();page.get('doc-blue-consent').checked=true;page.get('doc-blue-start').click();
  await until(()=>page.get('doc-blue-failure').textContent.includes('BLUE 상태 미확인'),'unknown');
  assert.equal(page.get('doc-blue-progress').textContent.includes(CITE),false);assert.equal(page.get('doc-blue-failure').textContent.includes('<script>'),false);
  assert.equal(jobPosts(page.calls).length,1);assert.equal(storedBlue(storage).postReceipt,'unknown');
  const snap=JSON.stringify(storedBlue(storage).request);
  page.get('doc-blue-start').click();await new Promise(r=>setTimeout(r,30));
  assert.equal(jobPosts(page.calls).length,1);
  page.poke();await new Promise(r=>setTimeout(r,40));
  assert.equal(page.get('doc-blue-failure').textContent.includes('BLUE 상태 미확인'),true);
  assert.equal(page.get('doc-blue-failure').textContent.includes(CITE),false);assert.equal(page.get('doc-blue-progress').textContent.includes(CITE),false);
  assert.equal(jobPosts(page.calls).length,1);assert.equal(JSON.stringify(storedBlue(storage).request),snap);
  const reloaded=await bluePage(storage,{reply:async()=>{throw new Error('socket');}});
  await until(()=>reloaded.get('doc-blue-failure').textContent.includes('BLUE 상태 미확인'),'reload unknown');
  assert.equal(jobPosts(reloaded.calls).length,0);assert.equal(reloaded.get('doc-blue-failure').textContent.includes(CITE),false);
  assert.equal(JSON.stringify(storedBlue(storage).request),snap);
});
(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name);console.error(e);process.exitCode=1;}}
  console.log(JSON.stringify({passed,failed:tests.length-passed}));if(passed!==tests.length)process.exit(1);})();
