'use strict';
// Node VM contract for the BLUE progress phase and raw-evidence reread presentation.
// Synthetic DOM, mocked bridge/ledger/import; no browser, network, CLI, model or private paper access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),nodeCrypto=require('node:crypto');
const C=require('../dist/document-blue-core.js'),SOURCE=fs.readFileSync(path.resolve(__dirname,'../dist/document-blue.js'),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const SEG0='Full invariance was found across groups.',SEG1='Only partial invariance holds in the second sample.',SEG2='Limitations are discussed.';
const until=async(f,label)=>{for(let i=0;i<400&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f(),label);};
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
function element(id){
  const e=new EventTarget();
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],files:[],
    classList:{toggle(){},contains:()=>false},replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
function world(){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);},downloads=[],calls=[];
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>element(''),body:element('body')});
  get('doc-blue-budget').value='4';
  let reply=async()=>{throw new Error('no broker reply configured');};
  const cap={red:true,blue:true};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busy(){},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,session:()=>({request:(p,body)=>{calls.push({path:p,body});return Promise.resolve().then(()=>reply(p,body));}})};
  const importer={extract:async()=>({text:[SEG0,SEG1,SEG2].join('\n'),format:'PDF',warnings:[],segments:[{label:'p1',text:SEG0},{label:'p2',text:SEG1},{label:'p3',text:SEG2}]})};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  // Polls wait 1500 ms in the page; the synthetic clock runs them on the next macrotask.
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentBlue:C,FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyImport:importer,TextEncoder,TextDecoder,CustomEvent,Event,AbortController,URL:URLmock,Blob,File,setTimeout:f=>setTimeout(f,0),clearTimeout,confirm:()=>true,Uint8Array,Array,Promise,Error,Map,Set,JSON,Number,String,Object});
  vm.runInContext(SOURCE,ctx,{filename:'document-blue.js'});
  const w={get,calls,downloads,set reply(f){reply=f;},progress:()=>get('doc-blue-progress').textContent,
    async load(){document.dispatchEvent(new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:new File([Buffer.from('%PDF-1.7 synthetic')],'paper.pdf',{type:'application/pdf'}),sourceRunId:null}}));
      await until(()=>/추출 완료/.test(w.progress()),'document extracted');},
    async manual(coverage){get('doc-blue-request').click();await flush();const r=JSON.parse(await downloads.pop().text());
      get('doc-blue-response').value=JSON.stringify({schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status:'ok',findings:[],model:'forged-model',coverage});get('doc-blue-apply').click();await flush();},
    async start(){const c=get('doc-blue-consent');c.checked=true;c.dispatchEvent(new Event('change'));get('doc-blue-start').click();await flush();}};
  return w;
}
// Broker job: POST starts, the first poll is still running at a phase, the second poll is released by the test.
function job(w,phase,coverage){let release;const second=new Promise(r=>{release=r;});let polls=0;
  w.reply=async(p,body)=>{if(p==='/api/blue/jobs')return {id:'j1'};if(p.endsWith('/cancel'))return {};
    if(++polls===1)return {state:'running',progress:{completedCalls:1,requiredCalls:3,phase}};await second;
    const r=w.calls[0].body;return {state:'completed',result:{schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status:'ok',findings:[],model:'synthetic',coverage}};};
  return ()=>release();}
const FULL={calls:3,complete:true};

test('progress shows the server phase as a bounded token; unsafe phases are dropped',async()=>{
  for(const [phase,want] of [['reread',/BLUE 검토 중 · 1 \/ 3회 완료 · 단계: 원문 근거 재확인$/],['reviewing',/ · 단계: 검토$/],['selecting',/ · 단계: 근거 구간 선택$/],['finalizing',/ · 단계: 결과 정리$/],['chunk_2',/ · 단계: chunk_2$/],
      ['<img src=x>',/회 완료$/],['C:/Users/x/paper.pdf',/회 완료$/],['x'.repeat(40),/회 완료$/],[undefined,/회 완료$/],[{toString:()=>'reread'},/회 완료$/]]){
    const w=world();await w.load();const release=job(w,phase,FULL);await w.start();
    await until(()=>/BLUE 검토 중/.test(w.progress()),String(phase));assert.match(w.progress(),want,String(phase));assert.doesNotMatch(w.progress(),/<img|C:\/Users/);
    release();await until(()=>/개 지적/.test(w.progress()),'completed');}});

test('final status: reread performed, one-chunk direct full text, incomplete and unreported are distinct and never claim detection',async()=>{
  const done=async coverage=>{const w=world();await w.load();const release=job(w,'reviewing',coverage);await w.start();release();await until(()=>/개 지적/.test(w.progress()),'completed');return w.progress();};
  let s=await done({...FULL,reread:{status:'completed',selectedSegments:['s0','s1','s1'],deliveredChars:1234,truncated:false,meaning:'<b>server text</b>'}});
  assert.match(s,/전체 추출 텍스트 전달 완료\(탐지 보장 아님\)\. 원문 근거 재확인 수행 · 구간 2개 · 1,234자\.$/);assert.doesNotMatch(s,/server text|<b>/,'server meaning is not echoed');
  s=await done({...FULL,reread:{status:'completed',selectedSegments:['s2'],deliveredChars:20,truncated:true,meaning:'x'}});assert.match(s,/원문 근거 재확인 수행 · 구간 1개 · 20자 · 일부만 전달됨\.$/);
  s=await done({calls:1,complete:true,reread:{status:'not-needed',selectedSegments:[],deliveredChars:0,truncated:false,meaning:'x'}});assert.match(s,/한 번의 호출로 전체 추출 텍스트를 직접 검토해 별도 원문 재확인은 하지 않았습니다\.$/);
  s=await done({...FULL,reread:{status:'incomplete',selectedSegments:['s0'],deliveredChars:5,truncated:true,meaning:'x'}});assert.match(s,/원문 근거 재확인 미완료\.$/);
  s=await done(FULL);assert.match(s,/원문 근거 재확인 보고 없음\.$/);
  for(const reread of [{status:'completed',selectedSegments:['s9'],deliveredChars:3,truncated:false},{status:'completed',selectedSegments:[],deliveredChars:3,truncated:false},{status:'completed',selectedSegments:['s0'],deliveredChars:-1,truncated:false},
      {status:'completed',selectedSegments:['s0'],deliveredChars:1.5,truncated:false},{status:'completed',selectedSegments:['s0'],deliveredChars:3,truncated:'no'},{status:'completed',selectedSegments:['s0'],deliveredChars:0,truncated:false},
      {status:'not-needed',truncated:true},{status:'not-needed',selectedSegments:[],deliveredChars:0,truncated:true},{status:'not-needed',selectedSegments:['s0'],deliveredChars:0,truncated:false},{status:'not-needed',selectedSegments:[],truncated:false},{status:'done'},'completed']){
    s=await done({...FULL,reread});assert.match(s,/원문 근거 재확인 보고 형식 확인 불가\.$/,JSON.stringify(reread));assert.doesNotMatch(s,/재확인 수행/);}
  s=await done({calls:1,complete:false,reread:{status:'not-needed',selectedSegments:[],deliveredChars:0,truncated:false}});assert.match(s,/전달 미완료\. 원문 근거 재확인 보고 형식 확인 불가\.$/,'no direct full-text claim without complete delivery');assert.doesNotMatch(s,/직접 검토/);
  assert.doesNotMatch(SOURCE,/innerHTML|insertAdjacentHTML|outerHTML/);});

test('manual response is never execution-verified, even with forged reread metadata',async()=>{
  const w=world();await w.load();await w.manual({calls:2,complete:true,reread:{status:'completed',selectedSegments:['s0'],deliveredChars:40,truncated:false,meaning:'forged'}});
  const s=w.progress();assert.match(s,/수동 응답의 실행·전달 여부 미검증\. 원문 재확인 실행 여부 미검증\(수동 응답\)\.$/);assert.doesNotMatch(s,/재확인 수행|전달 완료|forged/);
  assert.match(w.get('doc-blue-result-summary').textContent,/수동 응답 · 실행 출처 미검증/);assert.equal(w.calls.length,0,'no broker call');});

test('abstain and refusal still state delivery coverage and reread instead of hiding an incomplete review',async()=>{
  for(const [status,head] of [['abstain',/^BLUE 판단 유보\. 탐지 실패로 변환하지 않습니다\. /],['refusal',/^BLUE 요청 거절\. 우회·자동 재시도하지 않습니다\. /]]){const w=world();await w.load();
    w.reply=async p=>{if(p==='/api/blue/jobs')return {id:'j1'};const r=w.calls[0].body;return {state:'completed',result:{schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status,findings:[],model:'synthetic',coverage:{calls:2,complete:false,reread:{status:'incomplete',selectedSegments:[],deliveredChars:0,truncated:false}}}};};
    await w.start();await until(()=>head.test(w.progress()),status);assert.match(w.progress(),/앱 adapter 호출 2회\. 전달 미완료\. 원문 근거 재확인 미완료\.$/,status);assert.equal(w.calls.length,2,'no retry');}});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));})();
