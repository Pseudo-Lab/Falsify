'use strict';
// Node VM regression for the ledger cloud hooks: FalsifyLab.cloudSnapshot() and FalsifyLab.previewSharedHarness().
// Synthetic DOM and storage, synthetic paper and responses; no browser, network, server, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const H=require('../dist/harness-core.js'),R=require('../dist/document-red-core.js'),dist=path.resolve(__dirname,'../dist'),KEY='falsify.experiment-ledger.v1';
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const plain=x=>JSON.parse(JSON.stringify(x));
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
// Same synthetic DOM as ledger-provenance.spec.cjs: elements register by id; querySelector('#id') resolves or creates.
function ledger(stored){
  const els=new Map(),store=new Map(stored||[]),writes=[],events=[];
  function element(tag){const e=new EventTarget(),classes=new Set();let id='';
    Object.defineProperty(e,'id',{get:()=>id,set:v=>{id=v;els.set(v,e);}});
    Object.assign(e,{tagName:String(tag).toUpperCase(),disabled:false,hidden:false,checked:false,value:'',textContent:'',placeholder:'',children:[],files:[],parent:null,dataset:{},attrs:{},
      classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
      setAttribute(k,v){this.attrs[k]=v;},append(...c){for(const x of c){if(x&&typeof x==='object')x.parent=this;this.children.push(x);}},replaceChildren(...c){this.children=[];this.append(...c);},prepend(...c){this.children.unshift(...c);},after(){},remove(){},reset(){},focus(){},
      closest(sel){let n=this;while(n){if(n.tagName===sel.toUpperCase())return n;n=n.parent;}return null;}});
    Object.defineProperty(e,'innerHTML',{set(){}});Object.defineProperty(e,'firstChild',{get(){return this.children[0]??null;}});return e;}
  const get=id=>{if(!els.has(id))element('div').id=id;return els.get(id);};
  const document=new EventTarget();Object.assign(document,{readyState:'complete',createElement:element,querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],body:element('body')});
  for(const type of ['falsify:harness-change','falsify:harness-consent'])document.addEventListener(type,e=>events.push(type+':'+e.detail.role));
  const ctx=vm.createContext({document,FalsifyHarness:H,FalsifyLocalBridge:{capabilities:()=>null,state:()=>({status:'manual',connected:false,cap:null})},FalsifyDocumentRed:R,FalsifyDocumentBlue:require('../dist/document-blue-core.js'),
    localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>{writes.push(k);store.set(k,v);}},crypto:globalThis.crypto,TextEncoder,CustomEvent,Event,URL,Blob,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(dist,'experiment-ledger.js'),'utf8'),ctx,{filename:'experiment-ledger.js'});
  return {get,lab:ctx.FalsifyLab,store,writes,events};
}
const segments=[{id:'s0',label:'p1',text:'Study does not show benefit.'},{id:'s1',label:'p2',text:'Only an association was observed.'}];
const candidate={id:'c1',segmentId:'s0',level:1,before:'Study does not show benefit.',after:'Study does show benefit.',rationale:'Synthetic contradiction.',evidence:[{segmentId:'s1',quote:'Only an association was observed.',relation:'Synthetic qualification.'}],uncertainty:'Synthetic fixture only.'};
async function paper(){return {revision:'synthetic-rev',sourceHash:await sha(segments.map(s=>s.text).join('\n\n')),fileHash:'f'.repeat(64),name:'synthetic.txt',format:'TXT',segments};}
async function recordRun(w){const doc=await paper(),request=plain(await w.lab.bind('red',R.request(doc,1,8)));
  const response={schema:R.VERSION,revision:doc.revision,sourceHash:doc.sourceHash,status:'ok',candidates:[candidate],harness:request.harness,harnessHash:await H.hash(request.harness),model:'gpt-6.1-sol',coverage:{complete:true,completedChunks:1,chunks:1,calls:2}};
  return w.lab.record('red',doc,request,response,'local-codex');}
const shared={...H.builtin('blue'),id:'shared-blue',name:'Shared BLUE',adapter:{type:'stdio',executable:'C:\\Synthetic\\harness.exe',args:[]}};

test('cloudSnapshot waits for ready and returns a deep copy of the validated ledger',async()=>{
  const w=ledger(),pending=w.lab.cloudSnapshot();const first=await pending;assert.deepEqual(plain(first.harnesses.map(h=>h.config.id).sort()),['builtin-blue','builtin-red']);
  const id=await recordRun(w),snap=await w.lab.cloudSnapshot(),raw=w.store.get(KEY);assert.equal(snap.runs.length,1);assert.equal(snap.runs[0].id,id);
  snap.runs[0].response.status='mutated';snap.harnesses.length=0;snap.runs.push({});
  const again=await w.lab.cloudSnapshot();assert.equal(again.runs.length,1);assert.equal(again.runs[0].response.status,'ok');assert.equal(again.harnesses.length,2);assert.equal(w.store.get(KEY),raw,'snapshot never writes storage');});

test('cloudSnapshot refuses to export unreadable storage and leaves it untouched',async()=>{
  const w=ledger([[KEY,'{"schema":"corrupt"']]);await assert.rejects(w.lab.cloudSnapshot(),/백업 JSON을 복원/);assert.equal(w.store.get(KEY),'{"schema":"corrupt"');assert.deepEqual(w.writes,[]);
  const bad=ledger([[KEY,JSON.stringify({schema:KEY,harnesses:[{config:H.builtin('red'),hash:'0'.repeat(64)}],runs:[],reviews:[]})]]);await assert.rejects(bad.lab.cloudSnapshot());assert.deepEqual(bad.writes,[]);});

test('cloud payloads built from a snapshot validate against the shared core',async()=>{
  const C=await import('../dist/cloud-records-core.mjs'),w=ledger();await recordRun(w);const snap=await w.lab.cloudSnapshot(),run=snap.runs[0];
  const payload=C.runFromLocal(run,{harness:H,caseLabel:'case-1'});assert.deepEqual(await C.validatePayload('run',payload,{harness:H}),payload);assert.equal(payload.calls,2);assert.ok(!('evidence' in payload));
  const h=plain(snap.harnesses.find(x=>x.hash===run.harnessHash));assert.deepEqual(await C.validatePayload('harness',{config:h.config,hash:h.hash},{harness:H}),h);
  const full=C.runFromLocal(run,{harness:H,includeEvidence:true});assert.deepEqual(await C.validatePayload('run',full,{harness:H}),full);});

test('previewSharedHarness fills editor and review panel only: no registration, selection, events or storage',async()=>{
  const w=ledger(),pending=w.lab.previewSharedHarness(plain(shared));const hash=await pending;await flush();
  assert.equal(hash,await H.hash(shared));assert.deepEqual(JSON.parse(w.get('harness-editor').value),H.validate(shared),'ready default editor value does not overwrite the shared config');
  const box=w.get('harness-preview');assert.equal(box.hidden,false);assert.equal(box.children[0].textContent,'공유 Harness 검토');assert.match(JSON.stringify(box.children.map(c=>c.children.map(x=>x.textContent))),/미등록/);
  assert.match(w.get('harness-status').textContent,/등록·선택·실행은 하지 않았습니다/);
  assert.deepEqual(w.writes,[]);assert.equal(w.store.get(KEY),undefined);const snap=await w.lab.cloudSnapshot();assert.ok(!snap.harnesses.some(h=>h.hash===hash));
  assert.deepEqual(w.get('blue-harness').children.map(o=>o.value),[await H.hash(H.builtin('blue'))],'selection menu lists registered versions only');assert.ok(!w.events.some(e=>e.startsWith('falsify:harness-change')));
  assert.equal(await w.lab.previewSharedHarness(plain(shared),hash),hash,'matching expected hash accepted');});

test('previewSharedHarness rejects invalid configs and mismatched hashes without loading them',async()=>{
  const w=ledger();await w.lab.ready;const before=w.get('harness-editor').value;
  await assert.rejects(w.lab.previewSharedHarness({...shared,role:'gold'}));assert.equal(w.get('harness-preview').hidden,true);assert.equal(w.get('harness-editor').value,before);assert.ok(w.get('harness-status').classList.contains('error'));
  await assert.rejects(w.lab.previewSharedHarness(plain(shared),'0'.repeat(64)),/내용 해시/);assert.equal(w.get('harness-editor').value,before);assert.deepEqual(w.writes,[]);});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));if(passed!==tests.length)process.exit(1);})();
