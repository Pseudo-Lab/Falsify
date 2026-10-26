'use strict';
// Node VM regression for record provenance, outcome/coverage labels and comparable denominators in the ledger and RED page.
// Synthetic DOM, mocked bridge/storage, synthetic paper and responses; no browser, network, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const H=require('../dist/harness-core.js'),R=require('../dist/document-red-core.js'),dist=path.resolve(__dirname,'../dist'),KEY='falsify.experiment-ledger.v1';
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const plain=x=>JSON.parse(JSON.stringify(x)),until=async(f,label)=>{for(let i=0;i<400&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f(),label);};
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
// Every text under an element, depth first: what the page would show.
const texts=e=>!e||typeof e!=='object'?[]:[e.textContent,...(e.children||[]).flatMap(texts)].filter(Boolean);
const shown=e=>texts(e).join('\n');
// Synthetic DOM for the ledger: elements register by id when assigned; querySelector('#id') resolves or creates.
function ledger(stored){
  const els=new Map(),store=new Map(stored||[]);
  function element(tag){const e=new EventTarget(),classes=new Set();let id='';
    Object.defineProperty(e,'id',{get:()=>id,set:v=>{id=v;els.set(v,e);}});
    Object.assign(e,{tagName:String(tag).toUpperCase(),disabled:false,hidden:false,checked:false,value:'',textContent:'',placeholder:'',children:[],files:[],parent:null,dataset:{},attrs:{},
      classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
      setAttribute(k,v){this.attrs[k]=v;},append(...c){for(const x of c){if(x&&typeof x==='object')x.parent=this;this.children.push(x);}},replaceChildren(...c){this.children=[];this.append(...c);},prepend(...c){this.children.unshift(...c);},after(){},remove(){},reset(){},focus(){},
      closest(sel){let n=this;while(n){if(n.tagName===sel.toUpperCase())return n;n=n.parent;}return null;}});
    Object.defineProperty(e,'innerHTML',{set(){}});Object.defineProperty(e,'firstChild',{get(){return this.children[0]??null;}});return e;}
  const get=id=>{if(!els.has(id))element('div').id=id;return els.get(id);};
  const document=new EventTarget();Object.assign(document,{readyState:'complete',createElement:element,querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],body:element('body')});
  const ctx=vm.createContext({document,FalsifyReview:require('../dist/review-workbench.js'),FalsifyHarness:H,FalsifyLocalBridge:{capabilities:()=>null,state:()=>({status:'manual',connected:false,cap:null})},FalsifyDocumentRed:R,FalsifyDocumentBlue:require('../dist/document-blue-core.js'),
    localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},crypto:globalThis.crypto,TextEncoder,CustomEvent,Event,URL,Blob,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(dist,'experiment-ledger.js'),'utf8'),ctx,{filename:'experiment-ledger.js'});
  const lab=ctx.FalsifyLab,db=()=>JSON.parse(store.get(KEY));
  const rows=()=>get('ledger-table-body').children.map(tr=>tr.children.map(td=>[td.textContent,...td.children.map(s=>s.textContent)].join(' | ')));
  async function restore(data){get('ledger-status').textContent='';const raw=JSON.stringify(data);get('ledger-import').files=[{size:raw.length,text:async()=>raw}];get('ledger-import').dispatchEvent(new Event('change'));await until(()=>get('ledger-status').textContent!=='','import settled');return get('ledger-status').textContent;}
  async function review(id,verdict,score){assert.equal(await lab.review(id),true);get('evaluation-reviewer').value='Synthetic reviewer';get('evaluation-verdict').value=verdict;get('evaluation-score').value=score==null?'':String(score);get('evaluation-note').value='Synthetic test only.';
    get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));assert.match(get('evaluation-status').textContent,/검수 이력을 추가/);}
  return {get,lab,store,db,rows,restore,review,summary:()=>get('ledger-summary').textContent};
}
const segments=[{id:'s0',label:'p1',text:'Study does not show benefit.'},{id:'s1',label:'p2',text:'Only an association was observed.'}];
const evidence=[{segmentId:'s1',quote:'Only an association was observed.',relation:'Synthetic qualification.'}];
const candidate={id:'c1',segmentId:'s0',level:1,before:'Study does not show benefit.',after:'Study does show benefit.',rationale:'Synthetic contradiction.',evidence,uncertainty:'Synthetic fixture only.'};
async function paper(){return {revision:'synthetic-rev',sourceHash:await sha(segments.map(s=>s.text).join('\n\n')),fileHash:'f'.repeat(64),name:'synthetic.txt',format:'TXT',segments};}
// A broker result carries the executed harness; a manual paste may claim any coverage.
async function response(doc,request,status,coverage){return {schema:R.VERSION,revision:doc.revision,sourceHash:doc.sourceHash,status,candidates:status==='ok'?[candidate]:[],harness:request.harness,harnessHash:await H.hash(request.harness),model:'gpt-6.1-sol',coverage};}
const COMPLETE={complete:true,completedChunks:3,chunks:3,calls:4},SCAN_ABSTAIN={complete:false,completedChunks:3,chunks:3,calls:3},EARLY_REFUSAL={complete:false,completedChunks:1,chunks:3,calls:1};
// Live complete, scan-stage abstain, refusal, a forged-coverage manual paste and a final snapshot of the live run.
async function populated(){const w=ledger();await w.lab.ready;await flush();const doc=await paper(),ids={},requests={};
  for(const [name,status,coverage,provenance] of [['live','ok',COMPLETE,'local-codex'],['abstain','abstain',SCAN_ABSTAIN,'local-codex'],['refusal','refusal',EARLY_REFUSAL,'local-codex'],['manual','ok',COMPLETE,'manual-unverified']]){
    const request=plain(await w.lab.bind('red',R.request(doc,1,8)));requests[name]=request;ids[name]=await w.lab.record('red',doc,request,await response(doc,request,status,coverage),provenance);}
  ids.snapshot=await w.lab.record('red',doc,requests.live,await response(doc,requests.live,'ok',COMPLETE),'local-codex',{finalState:{selected:[{id:'c1',segmentId:'s0',label:'p1',before:candidate.before,after:'Study clearly shows benefit.',offset:0,edited:true}],outputFileHash:null,verification:null},snapshotOf:ids.live});
  return {w,doc,ids,requests};}

test('summary separates broker executions, app adapter calls, manual responses and snapshots',async()=>{const {w,ids}=await populated();
  assert.equal(new Set(Object.values(ids)).size,5);assert.match(w.summary(),/로컬 broker 실행 3건 \(앱 adapter 호출 8회\) · 수동 응답 1건 · 가져온 기록 0건 · 최종 스냅샷 1건 · 검수 이력 0건$/);assert.doesNotMatch(w.summary(),/모델 실행/);
  const stored=w.db().runs.find(r=>r.id===ids.manual);assert.equal(stored.provenance,'manual-unverified');assert.equal(stored.model,'manual-model-unverified');assert.equal(stored.response.coverage.complete,true,'stored claim kept verbatim, only labelled');});

test('board: executed and manual never share a denominator; statuses, incompleteness and unverified scores are explicit',async()=>{const {w,ids}=await populated();
  await w.review(ids.live,'supported',4);await w.review(ids.abstain,'uncertain',null);await w.review(ids.manual,'supported',5);
  const rows=w.rows();assert.equal(rows.length,2,JSON.stringify(rows));const [exec]=rows.filter(r=>r[2].startsWith('로컬 broker 실행')),[man]=rows.filter(r=>r[2].startsWith('수동 응답'));
  assert.match(exec[0],/실행 harness · [0-9a-f]{12}/);assert.match(exec[1],/^모델 gpt-6\.1-sol \/ L1 \/ 예산 8/);assert.equal(exec[2],'로컬 broker 실행 3건 | 완료 1 · 유보 1 · 거절 1 · 검토 범위 미완료 2 · 앱 adapter 호출 8회');assert.equal(exec[3],'2건 검수 · 4.00 / 5 (n=1)');assert.equal(exec[4],'1');
  assert.match(man[0],/요청 harness · /);assert.match(man[1],/^모델 미확인 \/ L1 \/ 예산 8/);assert.equal(man[2],'수동 응답 · 실행 미검증 1건 | 완료 1 · 유보 0 · 거절 0');assert.equal(man[3],'1건 검수 · 평균 미표시 (출처 미검증 점수 1건)');});

test('evaluation view shows outcome, coverage and synthesis status for every branch',async()=>{const {w,ids}=await populated();
  for(const [id,want] of [[ids.live,'결과 완료 · 전체 추출 텍스트 전달 완료 · 분할 읽기 3 / 3 · 후보 종합 단계 실행 · 앱 adapter 호출 4회'],[ids.abstain,'결과 유보 · 검토 범위 미완료 · 분할 읽기 3 / 3 · 후보 종합 단계 미실행 · 앱 adapter 호출 3회'],[ids.refusal,'결과 거절 · 검토 범위 미완료 · 분할 읽기 1 / 3 · 후보 종합 단계 미실행 · 앱 adapter 호출 1회']]){
    await w.lab.review(id);const out=texts(w.get('evaluation-output'));assert.ok(out.includes(want),id+'\n'+out.join('\n'));
    assert.match(w.get('evaluation-binding').textContent,/^RED 응답 기록 · synthetic\.txt \(TXT\) · 실행 harness 기본 RED v1 · 모델 gpt-6\.1-sol · 로컬 broker 실행 · /);}
  await w.lab.review(ids.manual);const binding=w.get('evaluation-binding').textContent,out=shown(w.get('evaluation-output'));
  assert.match(binding,/요청 harness 기본 RED v1 · 모델 미확인 · 수동 응답 · 실행 미검증/);assert.match(out,/결과 완료 · 수동 응답이라 실행·검토 범위 미검증/);assert.match(out,/요청 harness SHA-256/);assert.match(out,/이 harness로 실행됐다는 증거 없음/);
  assert.doesNotMatch(out,/전체 추출 텍스트 전달 완료|앱 adapter 호출/,'forged manual coverage is never echoed as verified');
  await w.lab.review(ids.snapshot);assert.match(w.get('evaluation-binding').textContent,new RegExp('^RED 사용자 최종 스냅샷 \\(응답 기록 '+ids.live.slice(0,8)+' 기반\\)'));});

test('mismatched broker harness is rejected before storage',async()=>{const {w,doc,requests}=await populated();const before=w.store.get(KEY);
  const forged={...await response(doc,requests.live,'ok',COMPLETE),harnessHash:'0'.repeat(64)};
  await assert.rejects(w.lab.record('red',doc,plain(await w.lab.bind('red',R.request(doc,1,8))),forged,'local-codex'),/실행 harness가 요청과 일치하지 않습니다/);assert.equal(w.store.get(KEY),before);});

test('export/reimport: imported records keep content but are never executions or scored means; tampering is blocked',async()=>{const {w,ids}=await populated();await w.review(ids.live,'supported',4);const backup=w.db();
  const t=ledger();await t.lab.ready;await flush();assert.match(await t.restore(backup),/백업을 병합했습니다\. 가져온 기록은 출처 미검증이며 실행으로 세지 않습니다\./);
  assert.ok(t.db().runs.every(r=>r.provenance==='imported-unverified'));assert.match(t.summary(),/로컬 broker 실행 0건 \(앱 adapter 호출 0회\) · 수동 응답 0건 · 가져온 기록 4건 · 최종 스냅샷 1건 · 검수 이력 1건$/);
  for(const row of t.rows()){assert.match(row[0],/실행 미확인 harness/);assert.match(row[2],/^가져온 기록 · 출처 미검증/);assert.doesNotMatch(row[3],/\d\.\d\d \/ 5/,'no mean for unverified records');}
  await t.lab.review(ids.abstain);assert.match(shown(t.get('evaluation-output')),/결과 유보 · 가져온 기록이라 실행·검토 범위 미검증/);assert.match(t.get('evaluation-binding').textContent,/모델 gpt-6\.1-sol \(미검증\)/);
  const original=t.store.get(KEY);assert.match(await t.restore(backup),/백업을 병합/);assert.equal(t.store.get(KEY),original,'idempotent');
  const claim=plain(backup);claim.runs.find(r=>r.id===ids.abstain).response.coverage.complete=true;assert.match(await t.restore(claim),/복원 차단: 같은 실행 ID의 내용이 달라/);assert.equal(t.store.get(KEY),original);
  const paperEdit=plain(backup);paperEdit.runs[0].segments[0].text+=' tampered';assert.match(await t.restore(paperEdit),/복원 차단: 실행 논문 해시 불일치/);
  const harnessEdit=plain(backup);harnessEdit.harnesses[0].config.instructions='tampered';assert.match(await t.restore(harnessEdit),/복원 차단: harness 해시/);assert.equal(t.store.get(KEY),original);
  const fresh=ledger();await fresh.lab.ready;await flush();assert.match(await fresh.restore(claim),/백업을 병합/);await fresh.lab.review(ids.abstain);assert.match(shown(fresh.get('evaluation-output')),/가져온 기록이라 실행·검토 범위 미검증/,'an edited coverage claim never reads verified');});

test('legacy stored records load unchanged: missing coverage stays unknown, missing broker hash is not attested',async()=>{const {w,ids}=await populated();await w.review(ids.abstain,'supported',3);const legacy=w.db();
  for(const r of legacy.runs){if(r.id===ids.live||r.snapshotOf===ids.live)delete r.response.coverage;if(r.id===ids.abstain)delete r.response.harnessHash;}
  const raw=JSON.stringify(legacy),l=ledger([[KEY,raw]]);await l.lab.ready;await flush();assert.equal(l.get('ledger-status').textContent,'','no recovery needed');assert.equal(l.store.get(KEY),raw,'nothing rewritten on load');
  assert.match(l.summary(),/로컬 broker 실행 3건 \(앱 adapter 호출 4회 이상, 호출 수 미보고 1건\)/,'a run without a call report is not counted as zero');await l.lab.review(ids.live);assert.ok(texts(l.get('evaluation-output')).includes('결과 완료 · 검토 범위 보고 없음'));
  const exec=l.rows().find(r=>/^로컬 broker 실행/.test(r[2])&&!/실행 미확인 harness/.test(r[0]));assert.equal(exec[2],'로컬 broker 실행 2건 | 완료 1 · 유보 0 · 거절 1 · 검토 범위 미완료 1 · 앱 adapter 호출 1회 이상, 호출 수 미보고 1건');
  await l.lab.review(ids.abstain);assert.match(l.get('evaluation-binding').textContent,/실행 미확인 harness 기본 RED v1 · 모델 gpt-6\.1-sol \(미검증\)/);
  const unknown=l.rows().find(r=>/실행 미확인 harness/.test(r[0]));assert.equal(unknown[3],'1건 검수 · 평균 미표시 (출처 미검증 점수 1건)');});

test('legacy broker records with a copied hash but another or missing harness load unchanged, unattested and unscored',async()=>{const {w,ids}=await populated();await w.review(ids.live,'supported',4);await w.review(ids.refusal,'supported',2);await w.review(ids.abstain,'supported',3);const legacy=w.db();
  for(const r of legacy.runs){if(r.id===ids.live||r.snapshotOf===ids.live)r.response.harness={...r.response.harness,instructions:'A different strategy.'};if(r.id===ids.refusal)delete r.response.harness;}
  const raw=JSON.stringify(legacy),l=ledger([[KEY,raw]]);await l.lab.ready;await flush();assert.equal(l.get('ledger-status').textContent,'','no recovery needed');assert.equal(l.store.get(KEY),raw,'nothing rewritten on load');assert.equal(l.db().runs.length,5,'no record dropped');
  const unknown=l.rows().find(r=>/실행 미확인 harness/.test(r[0])),exec=l.rows().find(r=>/^로컬 broker 실행/.test(r[2])&&!/실행 미확인 harness/.test(r[0]));
  assert.equal(unknown[2],'로컬 broker 실행 2건 | 완료 1 · 유보 0 · 거절 1 · 검토 범위 미완료 1 · 앱 adapter 호출 5회');assert.equal(unknown[3],'2건 검수 · 평균 미표시 (출처 미검증 점수 2건)');
  assert.equal(exec[3],'1건 검수 · 3.00 / 5 (n=1)','the matching broker harness keeps its own mean');
  await l.lab.review(ids.live);assert.match(l.get('evaluation-binding').textContent,/실행 미확인 harness 기본 RED v1 · 모델 gpt-6\.1-sol \(미검증\)/);
  const t=ledger();await t.lab.ready;await flush();assert.match(await t.restore(legacy),/백업을 병합/);assert.ok(t.rows().every(r=>/실행 미확인 harness/.test(r[0])&&!/\d\.\d\d \/ 5/.test(r[3])),'imported stays unverified');});

test('legacy broker records without call telemetry never show zero calls; invalid counts stay unknown',async()=>{const {w,ids}=await populated();const legacy=w.db();
  for(const r of legacy.runs){if(r.id===ids.live||r.snapshotOf===ids.live)delete r.response.coverage;if(r.id===ids.abstain)r.response.coverage={complete:false,completedChunks:3,chunks:3,calls:-1};if(r.id===ids.refusal)r.response.coverage={completedChunks:1,chunks:3};}
  const raw=JSON.stringify(legacy),l=ledger([[KEY,raw]]);await l.lab.ready;await flush();assert.equal(l.get('ledger-status').textContent,'');assert.equal(l.store.get(KEY),raw,'nothing rewritten on load');
  assert.match(l.summary(),/로컬 broker 실행 3건 \(앱 adapter 호출 수 미보고 3건\) · 수동 응답 1건/);assert.doesNotMatch(l.summary(),/호출 0회/);
  const exec=l.rows().find(r=>/^로컬 broker 실행/.test(r[2]));assert.equal(exec[2],'로컬 broker 실행 3건 | 완료 1 · 유보 1 · 거절 1 · 검토 범위 미완료 1 · 앱 adapter 호출 수 미보고 3건');
  await l.lab.review(ids.abstain);assert.ok(texts(l.get('evaluation-output')).includes('결과 유보 · 검토 범위 미완료 · 분할 읽기 3 / 3 · 후보 종합 단계 미실행'),'invalid count is omitted, not shown as a number');});

// Synthetic RED page: real document-red.js with a mocked bridge job and ledger.
function redPage(){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);};
  function element(id){const e=new EventTarget(),classes=new Set();Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});return e;}
  const document=new EventTarget();Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>element(''),body:element('body')});
  get('red-level').value='1';get('red-budget').value='8';get('red-empty').textContent='아직 후보가 없습니다.';
  const calls=[],downloads=[];let reply=null,result=null;const cap={red:true,pdf:false};
  const bridge={busy(){},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,session:()=>({request:async(p,body)=>{calls.push(p);if(p==='/api/red/jobs'){result=reply(body);return {id:'j1'};}if(p.endsWith('/cancel'))return {};return {state:'completed',result};}})};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>crypto.randomUUID()};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentRed:R,FalsifyHarness:H,FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object});
  vm.runInContext(fs.readFileSync(path.join(dist,'document-red.js'),'utf8'),ctx,{filename:'document-red.js'});
  const text=segments.map(s=>s.text).join('\n\n'),p={get,calls,progress:()=>get('red-progress').textContent,empty:()=>get('red-empty'),
    async load(){document.dispatchEvent(new CustomEvent('falsify:document',{cancelable:true,detail:{file:{name:'synthetic.txt',arrayBuffer:async()=>new TextEncoder().encode(text).buffer},result:{text,format:'TXT',segments:segments.map(({label,text})=>({label,text}))}}}));await until(()=>get('document-red').hidden===false,'bound');},
    async live(status,coverage){reply=q=>({schema:R.VERSION,revision:q.revision,sourceHash:q.sourceHash,status,candidates:status==='ok'?[candidate]:[],model:'gpt-6.1-sol',coverage});get('red-consent').checked=true;get('red-start').click();await until(()=>calls.length>=2&&!/전체 검토 예산/.test(p.progress()),'job finished');await flush();},
    // Manual exchange: download the request, paste a response for it; no broker call is made.
    async manual(status,coverage){get('red-request').click();await until(()=>downloads.length>0,'request saved');const q=JSON.parse(await downloads.pop().text());
      get('red-response').value=JSON.stringify({schema:R.VERSION,revision:q.revision,sourceHash:q.sourceHash,status,candidates:status==='ok'?[candidate]:[],model:'forged-model',coverage});get('red-import-response').click();await until(()=>/후보|유보|거절/.test(p.progress()),'response applied');}};
  return p;}

test('RED page: abstain after a full scan states incomplete coverage and no synthesis instead of a generic empty state',async()=>{const p=redPage();await p.load();await p.live('abstain',SCAN_ABSTAIN);
  assert.match(p.progress(),/^모델이 유보했습니다\. 후보를 강제로 만들지 않고 자동 재시도하지 않습니다\. 결과 유보 · 검토 범위 미완료 · 분할 읽기 3 \/ 3 · 후보 종합 단계 미실행 · 앱 adapter 호출 3회\.$/);
  assert.equal(p.empty().hidden,false);assert.equal(p.empty().textContent,'후보 없음 · 모델이 유보했습니다 · 결과 유보 · 검토 범위 미완료 · 분할 읽기 3 / 3 · 후보 종합 단계 미실행 · 앱 adapter 호출 3회. 자동 재시도하지 않았습니다.');
  assert.deepEqual(p.calls,['/api/red/jobs','/api/red/jobs/j1'],'one job, one poll, no retry');});

test('RED page: refusal and live complete keep their own outcome and coverage',async()=>{let p=redPage();await p.load();await p.live('refusal',EARLY_REFUSAL);
  assert.match(p.empty().textContent,/^후보 없음 · 모델이 거절했습니다 · 결과 거절 · 검토 범위 미완료 · 분할 읽기 1 \/ 3 · 후보 종합 단계 미실행 · 앱 adapter 호출 1회\./);assert.equal(p.calls.length,2);
  p=redPage();await p.load();await p.live('ok',COMPLETE);assert.equal(p.empty().hidden,true);assert.match(p.progress(),/^1개 후보 · 인용 위치 확인 완료, 과학적 타당성 미검증\. 결과 완료 · 전체 추출 텍스트 전달 완료 · 분할 읽기 3 \/ 3 · 후보 종합 단계 실행 · 앱 adapter 호출 4회\.$/);});

test('RED page: a pasted manual response never reads as executed, whatever coverage it claims',async()=>{let p=redPage();await p.load();await p.manual('ok',COMPLETE);
  assert.match(p.progress(),/^1개 후보 · 인용 위치 확인 완료, 과학적 타당성 미검증\. 결과 완료 · 수동 응답이라 실행·검토 범위 미검증\.$/);assert.doesNotMatch(p.progress(),/전체 추출 텍스트 전달 완료|앱 adapter 호출|forged/);
  p=redPage();await p.load();await p.manual('abstain',SCAN_ABSTAIN);assert.equal(p.empty().textContent,'후보 없음 · 모델이 유보했습니다 · 결과 유보 · 수동 응답이라 실행·검토 범위 미검증. 자동 재시도하지 않았습니다.');assert.deepEqual(p.calls,[],'no broker call');});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));if(passed!==tests.length)process.exit(1);})();
