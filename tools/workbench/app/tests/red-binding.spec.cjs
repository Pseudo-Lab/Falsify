'use strict';
// Node VM regression for RED source binding vs harness-change/reset/replacement races.
// Synthetic DOM, mocked crypto/bridge/ledger; no browser, network, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const C=require('../dist/document-red-core.js'),SOURCE=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.js'),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function element(id){
  const e=new EventTarget(),classes=new Set();
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
function world(){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);};
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>element(''),body:element('body')});
  get('red-level').value='1';get('red-budget').value='4';get('red-harness').value='h1';get('document-red').hidden=true;
  // Each digest stays pending until the test settles it, so binding can be observed mid-flight.
  const digests=[];const crypto={randomUUID:()=>'u'+Math.random().toString(16).slice(2),subtle:{digest:(_,bytes)=>new Promise((resolve,reject)=>digests.push({label:new TextDecoder().decode(bytes),resolve:()=>resolve(new Uint8Array(32).buffer),reject}))}};
  const lab={calls:[],busy(role,v){if(role==='red')lab.calls.push(!!v);},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>'run1'};
  const bridge={calls:[],busy(role,v){if(role==='red')bridge.calls.push(!!v);},session:()=>null,state:()=>({status:'manual',connected:false,cap:null}),capabilities:()=>({red:true,pdf:false})};
  const ctx=vm.createContext({document,crypto,FalsifyDocumentRed:C,FalsifyHarness:require('../dist/harness-core.js'),FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},TextEncoder,TextDecoder,CustomEvent,Event,URL,Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String});
  vm.runInContext(SOURCE,ctx,{filename:'document-red.js'});
  const fire=(type,detail)=>document.dispatchEvent(new CustomEvent(type,{cancelable:true,detail}));
  const load=(name,text)=>fire('falsify:document',{file:{name,type:'text/plain',arrayBuffer:async()=>new TextEncoder().encode('FILE:'+name).buffer},result:{text,format:'TXT',segments:[{label:'p1',text}]}});
  // Resolve/reject matching digests (including ones a binding creates after an earlier digest settles).
  async function settle(match,fail=false){for(let round=0;round<4;round++){await flush();const hit=digests.filter(d=>match(d.label));if(!hit.length)continue;for(const d of hit){digests.splice(digests.indexOf(d),1);fail?d.reject(new Error('digest failed')):d.resolve();}}await flush();}
  const busy=()=>({lab:lab.calls.at(-1),bridge:bridge.calls.at(-1)});
  return {get,fire,load,settle,busy,lab,bridge,digests};
}
const of=name=>l=>l.includes(name)||l===({'a.txt':'alpha','b.txt':'beta','c.txt':'gamma'})[name];

test('delayed binding freezes harness, bridge and execution until both hashes finish',async()=>{const w=world();w.load('a.txt','alpha');await flush();
  assert.equal(w.digests.length>0,true,'hash pending');assert.deepEqual(w.busy(),{lab:true,bridge:true});
  for(const id of ['red-level','red-budget','red-start','red-request','red-import-response','red-download','red-plan'])assert.equal(w.get(id).disabled,true,id);
  assert.equal(w.get('document-red').hidden,true);
  await w.settle(of('a.txt'));
  assert.deepEqual(w.busy(),{lab:false,bridge:false});assert.equal(w.get('document-red').hidden,false);assert.match(w.get('red-document-summary').textContent,/^a\.txt/);
  assert.equal(w.get('red-request').disabled,false);assert.equal(w.get('red-import-response').disabled,false);assert.equal(w.get('red-level').disabled,false);
  w.get('red-consent').checked=true;w.get('red-consent').dispatchEvent(new Event('change'));assert.equal(w.get('red-start').disabled,false,'runnable after binding');});

test('harness-change racing an in-flight binding keeps the current input and its busy freeze',async()=>{const w=world();w.load('a.txt','alpha');await flush();
  w.fire('falsify:harness-change',{role:'red'});assert.deepEqual(w.busy(),{lab:true,bridge:true},'still frozen');assert.equal(w.get('red-start').disabled,true);
  await w.settle(of('a.txt'));
  assert.equal(w.get('document-red').hidden,false,'legitimate input not abandoned');assert.match(w.get('red-document-summary').textContent,/^a\.txt/);assert.deepEqual(w.busy(),{lab:false,bridge:false});});

test('replacement discards stale hashes without restoring the old doc or releasing the newer binding',async()=>{const w=world();w.load('a.txt','alpha');await flush();w.load('b.txt','beta');await flush();
  await w.settle(of('a.txt'));
  assert.equal(w.get('document-red').hidden,true,'old file not resurrected');assert.equal(w.get('red-document-summary').textContent,'');assert.deepEqual(w.busy(),{lab:true,bridge:true},'newer busy kept');
  await w.settle(of('b.txt'));
  assert.equal(w.get('document-red').hidden,false);assert.match(w.get('red-document-summary').textContent,/^b\.txt/);assert.deepEqual(w.busy(),{lab:false,bridge:false});});

test('reset during binding releases busy and stale hashes never restore the doc or a later binding',async()=>{const w=world();w.load('a.txt','alpha');await flush();
  w.fire('falsify:document-clear');assert.deepEqual(w.busy(),{lab:false,bridge:false},'reset releases');
  await w.settle(of('a.txt'));assert.equal(w.get('document-red').hidden,true);assert.equal(w.get('red-document-summary').textContent,'');assert.equal(w.lab.calls.at(-1),false);
  w.load('a.txt','alpha');await flush();w.fire('falsify:document-clear');w.load('c.txt','gamma');await flush();
  await w.settle(of('a.txt'));
  assert.deepEqual(w.busy(),{lab:true,bridge:true},'stale completion keeps newer busy');assert.equal(w.get('document-red').hidden,true);
  await w.settle(of('c.txt'));assert.match(w.get('red-document-summary').textContent,/^c\.txt/);assert.deepEqual(w.busy(),{lab:false,bridge:false});});

test('hash failure is reported and releases busy; a stale failure is silent and keeps newer busy',async()=>{const w=world();w.load('a.txt','alpha');await flush();
  await w.settle(of('a.txt'),true);
  assert.match(w.get('red-progress').textContent,/문서 바인딩 실패: digest failed/);assert.equal(w.get('red-progress').classList.contains('error'),true);
  assert.deepEqual(w.busy(),{lab:false,bridge:false});assert.equal(w.get('document-red').hidden,true);
  w.load('a.txt','alpha');await flush();w.load('b.txt','beta');await flush();await w.settle(of('a.txt'),true);
  assert.doesNotMatch(w.get('red-progress').textContent,/바인딩 실패/);assert.deepEqual(w.busy(),{lab:true,bridge:true});
  await w.settle(of('b.txt'));assert.match(w.get('red-document-summary').textContent,/^b\.txt/);assert.deepEqual(w.busy(),{lab:false,bridge:false});});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));})();
