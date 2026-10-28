'use strict';
// Node VM contract for the PDF editor capability descriptor and the RED export surface.
// Synthetic DOM, mocked bridge/ledger/broker; no browser, network, CLI, model or private PDF access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),nodeCrypto=require('node:crypto');
const C=require('../dist/document-red-core.js'),L=require('../dist/local-bridge.js'),SOURCE=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.js'),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
// Export hashing uses real off-thread WebCrypto: while the page is busy but no broker reply is outstanding, wait (bounded) for it to settle.
let current=null;
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));for(let i=0;i<400&&current&&current.bridge.busyCalls.at(-1)&&!current.inflight;i++)await new Promise(r=>setTimeout(r,5));for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const sha=b=>nodeCrypto.createHash('sha256').update(b).digest('hex'),WASM='ab'.repeat(32);
// Mock elements keep textContent and appended children separately; the rendered text is both, as in a real DOM.
const text=e=>typeof e==='string'?e:(e.textContent||'')+e.children.map(text).join('');
const EDITOR={available:true,engine:'falsify-pdf-editor',version:'0.4.1',wasmSha256:WASM,reflow:true,pagination:true,limits:{maxAddedPages:4,maxPatchChars:4000},sourceUrl:'https://github.com/Shinick-Han/falsify-pdf-editor'};
const SEG0='The trial shows a modest benefit in adults.',SEG1='Effects were observed only in the treated cohort.';
const BEFORE0='shows a modest benefit',BEFORE1='only in the treated cohort';
const SRC=Buffer.from('%PDF-1.7 synthetic fixture'),OUT=Buffer.from('%PDF-1.7 synthetic reflowed output');
function element(id){
  const e=new EventTarget(),classes=new Set();
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
function world(cap, workspace, selectedTypes){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);},created=[],downloads=[],calls=[],handoffs=[];
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>{const e=element('');created.push(e);return e;},body:element('body')});
  get('red-level').value='1';get('red-budget').value='4';get('document-red').hidden=true;
  if(selectedTypes)get('red-types').querySelectorAll=()=>selectedTypes.map(value=>({value}));
  let reply=async()=>{throw new Error('no broker reply configured');};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busyCalls:[],busy(role,v){if(role==='red')bridge.busyCalls.push(!!v);},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,
    session:()=>({request:(p,body)=>{calls.push({path:p,body});const out=Promise.resolve().then(()=>reply(p,body));w.inflight++;out.then(()=>{w.inflight--;},()=>{w.inflight--;});return out;}})};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentRed:C,FalsifyHarness:require('../dist/harness-core.js'),FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},FalsifyPaperWorkspace:workspace,TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object});
  vm.runInContext(SOURCE,ctx,{filename:'document-red.js'});
  document.addEventListener('falsify:blue-file',e=>handoffs.push(e.detail));
  const fire=(type,detail)=>document.dispatchEvent(new CustomEvent(type,{cancelable:true,detail}));
  const w={cap,get,created,downloads,calls,handoffs,fire,bridge,set reply(f){reply=f;},
    status:()=>text(get('red-export-status')),
    // Real WebCrypto digests finish off-thread, so wait for the bound panel instead of a fixed number of ticks.
    async load(){fire('falsify:document',{file:{name:'paper.pdf',type:'application/pdf',arrayBuffer:async()=>new Uint8Array(SRC).buffer},result:{text:SEG0+'\n'+SEG1,format:'PDF',segments:[{label:'p1',text:SEG0},{label:'p2',text:SEG1}]}});
      for(let i=0;i<400&&get('document-red').hidden;i++)await new Promise(r=>setTimeout(r,5));assert.equal(get('document-red').hidden,false,'document bound');await flush();},
    async candidates(){get('red-request').click();await flush();const r=JSON.parse(await downloads.pop().text());
      const cand=(id,seg,before,after,quote)=>({id,segmentId:seg,level:1,before,after,rationale:'Synthetic contradiction.',evidence:[{segmentId:seg,quote,relation:'Synthetic relation.'}],uncertainty:'Domain review required.'});
      get('red-response').value=JSON.stringify({schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status:'ok',candidates:[cand('c1','s0',BEFORE0,'shows a clear benefit',SEG0),cand('c2','s1',BEFORE1,'in every cohort regardless of treatment',SEG1)]});
      get('red-import-response').click();await flush();},
    boxes:()=>created.filter(e=>e.type==='checkbox'),area:i=>created.find(e=>e.id==='red-after-'+i),
    check(i){const b=w.boxes()[i];b.checked=true;b.dispatchEvent(new Event('change'));},
    edit(i,v){const a=w.area(i);a.value=v;a.dispatchEvent(new Event('input'));},
    clickDoc(sel){const ev=new Event('click');Object.defineProperty(ev,'target',{value:{closest:s=>s===sel?{}:null}});document.dispatchEvent(ev);},
    async ready(){await w.load();await w.candidates();w.check(1);w.edit(1,'in every cohort, including the untreated one');}};
  w.inflight=0;current=w;return w;
}
const ok=(verification,file=OUT)=>async()=>({file:file.toString('base64'),sourceFileHash:sha(SRC),outputFileHash:sha(file),verification});
const NEW={red:true,blue:true,pdf:true,pdfEditor:EDITOR},OLD={red:true,blue:true,pdf:true},REFLOWED={engine:'falsify-pdf-editor',layoutVerified:true,reflow:{wrappedLines:3},pagination:{inputPages:10,outputPages:11},limits:'Synthetic engine limits.'};
// Shape of the actual capture's verification (browser-receipt.json): same-engine self-check, QA pending, three warning codes.
const ACTUAL={mode:'falsify-pdf-editor',engine:'falsify-pdf-editor',version:'0.1.0-alpha.2',layoutVerified:true,reflow:{wrappedLines:null},pagination:{inputPages:2,outputPages:4},addedPages:2,
  warnings:[{pageIndex:0,code:'engine_model_lines_stale',severity:'info'},{pageIndex:0,code:'pagination_required',severity:'info'},{pageIndex:0,code:'content_stream_append_order',severity:'warning'}],
  diagnostics:['engine_model_lines_stale (p. 1)','pagination_required (p. 1)','content_stream_append_order (p. 1)'],
  selfCheck:{status:'passed',independent:false,method:'same-pdfium-text-geometry',warnings:[{pageIndex:null,code:'self_check_not_independent'}]},independentQA:'pending',
  checkBoundary:'Same-engine self-check only (same PDFium build re-reads the saved file); independent extraction, rendering and human review are still required.'};


test('one RED click downloads exactly the selected edited batch and saves its output hash',async()=>{
  const calls=[];let fail=false;
  const ws={getSource:()=>({fileHash:sha(SRC)}),getEditSnapshot:()=>({revision:7}),acceptProposals(){},async exportRedBatch(req){calls.push(req);if(fail)throw new Error('synthetic failure');return {bytes:new Uint8Array(OUT),sha256:sha(OUT),verification:{status:'passed'},workspaceRevision:7};}};
  const w=world({red:false,blue:false,pdf:false},ws);await w.ready();assert.equal(w.get('red-download').disabled,false);
  w.get('red-download').click();await flush();assert.equal(calls.length,1);assert.equal(calls[0].patches.length,1);assert.equal(calls[0].patches[0].after,'in every cohort, including the untreated one');
  assert.equal(w.calls.length,0);assert.equal(w.downloads.length,1);assert.deepEqual(Buffer.from(await w.downloads[0].arrayBuffer()),OUT);
  assert.match(w.status(),/다운로드했습니다/);w.get('red-plan').click();await flush();assert.equal(w.downloads.length,2);const plan=JSON.parse(await w.downloads[1].text());assert.equal(plan.outputFileHash,sha(OUT));assert.equal(plan.selected.length,1);
  fail=true;w.get('red-download').click();await flush();assert.match(w.status(),/다운로드 차단/);assert.equal(w.downloads.length,2);assert.equal(w.area(1).value,'in every cohort, including the untreated one');
});

test('a workspace source change during generation never downloads stale bytes',async()=>{
  let release,sourceHash=sha(SRC);const ws={getSource:()=>({fileHash:sourceHash}),getEditSnapshot:()=>({revision:7}),acceptProposals(){},exportRedBatch:()=>new Promise(r=>release=r)};
  const w=world({red:false,blue:false,pdf:false},ws);await w.ready();w.get('red-download').click();await flush();sourceHash='a'.repeat(64);
  release({bytes:new Uint8Array(OUT),sha256:sha(OUT),verification:{status:'passed'},workspaceRevision:7});await flush();assert.equal(w.downloads.length,0);assert.match(w.status(),/다운로드 차단/);
});
test('type fieldset binds selected combinations to local jobs and renders absent metadata safely',async()=>{
  const w=world(NEW,null,['contradiction','unsupported-inference']);await w.load();
  let posted;w.reply=async(path,body)=>{if(path==='/api/red/jobs'){posted=body;return {id:body.requestId};}return {state:'completed',result:{schema:posted.schema,revision:posted.revision,sourceHash:posted.sourceHash,status:'ok',candidates:[{id:'c1',segmentId:'s0',before:BEFORE0,after:'',rationale:'Synthetic.',evidence:[{segmentId:'s0',quote:SEG0,relation:'Synthetic.'}]}]}};};
  w.get('red-consent').checked=true;w.get('red-start').click();await flush();
  assert.deepEqual(Array.from(posted.attackTypes),['contradiction','unsupported-inference']);assert.equal(posted.level,undefined);
  assert.equal(w.area(0).value,'');assert.doesNotMatch(text(w.get('red-candidates')),/undefined|null/);
});
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name,e);}}if(failed)process.exitCode=1;})();
