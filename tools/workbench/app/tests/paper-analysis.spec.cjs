'use strict';
// Node VM contract for the advisory PDF pre-analysis: strict summary schema, bridge route/descriptor, and the RED panel's binding, freeze and stale rules.
// Synthetic DOM, mocked bridge/ledger/broker; no browser, network, CLI, model or private PDF access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),nodeCrypto=require('node:crypto');
const C=require('../dist/document-red-core.js'),A=require('../dist/paper-analysis-core.js'),L=require('../dist/local-bridge.js');
const dist=path.resolve(__dirname,'../dist'),SOURCE=fs.readFileSync(path.join(dist,'document-red.js'),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const sha=b=>nodeCrypto.createHash('sha256').update(b).digest('hex'),clone=x=>JSON.parse(JSON.stringify(x));
const text=e=>typeof e==='string'?e:(e.textContent||'')+e.children.map(text).join('');
const SEG0='The trial shows a modest benefit in adults.',SEG1='Effects were observed only in the treated cohort.';
const SRC=Buffer.from('%PDF-1.7 synthetic analysis fixture'),OUT=Buffer.from('%PDF-1.7 synthetic single-line output'),HASH=sha(SRC);
const DESCRIPTOR={available:true,schema:'falsify.pdf-analysis-summary.v1'},CAP={red:true,blue:true,pdf:true,paperAnalysis:DESCRIPTOR,workbenchVersion:'0.2.0-alpha.1'};
const summary=(over={})=>({schema:'falsify.pdf-analysis-summary.v1',sourceSha256:HASH,status:'available',inventory:{pages:2,textLines:40,images:3,vectors:5,truncated:false},
  objects:{images:3,sharedImages:2,inlineImages:0,vectors:5,ambiguous:2,inspected:1,complete:true},layout:[],structure:{status:'unavailable',reason:'conversion_unconfigured'},limits:['hint-only','text-only-blue','no-object-export'],...over});
const flush=async(n=20)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('core: deadline is a fixed 60-90 s and the request carries only fixed keys and selected patches',()=>{
  assert.ok(A.DEADLINE_MS>=60000&&A.DEADLINE_MS<=90000);
  const list=A.patches([{id:'model <id>',segmentId:'s1',label:'PDF p. 2',before:'only in the treated cohort',after:'in every cohort',offset:3,edited:true}]);
  assert.deepEqual(list.map(p=>({...p})),[{id:'edit-1',pageIndex:1,before:'only in the treated cohort',after:'in every cohort'}]);
  const r=A.request(HASH,'QUJD',list);assert.deepEqual(Object.keys(r),['schema','fileHash','file','patches']);assert.equal(r.schema,'falsify.pdf-analysis-request.v1');assert.deepEqual(Object.keys(r.patches[0]),['id','pageIndex','before','after']);
  assert.deepEqual(A.request(HASH,'QUJD',A.patches([])).patches,[]);
  for(const label of ['p2','PDF p. 0','PDF p. 10000','PDF p. 2 ','ODT 문단 1',null])assert.throws(()=>A.patches([{label,before:'a',after:'b'}]),/쪽 위치/,String(label));
  assert.throws(()=>A.patches(Array.from({length:13},()=>({label:'PDF p. 1',before:'a',after:'b'}))),/12개/);
  for(const bad of ['ABC',HASH.toUpperCase(),'',null])assert.throws(()=>A.request(bad,'QUJD',[]),/원본 PDF/);});

test('core: exact summary passes; every shape, count, hash, id or reason deviation is refused with fixed copy',()=>{
  const ids=['edit-1','edit-2'],ok=summary({layout:[{id:'edit-1',status:'fits',reason:null},{id:'edit-2',status:'overflow',reason:'height'}]});
  const s=A.summary(clone(ok),{sourceSha256:HASH,ids});assert.equal(s.status,'available');assert.equal(Object.isFrozen(s.layout),true);assert.equal(s.objects.sharedImages,2);
  assert.equal(A.summary(summary({status:'unavailable'}),{sourceSha256:HASH,ids}).layout.length,0,'unavailable fallback may omit layout');
  assert.throws(()=>A.summary(clone(ok),{sourceSha256:sha(OUT),ids}),/현재 원본 PDF와 맞지 않아/);
  const INJECT='<img src=x onerror=alert(1)> The trial shows';
  const mutations=[o=>{o.extra=INJECT;},o=>{delete o.limits;},o=>{o.schema='falsify.pdf-analysis-summary.v2';},o=>{o.sourceSha256=HASH.toUpperCase();},o=>{o.status='complete';},
    o=>{o.inventory.pages=-1;},o=>{o.inventory.textLines=1.5;},o=>{o.inventory.images='3';},o=>{o.inventory.pages=10001;},o=>{o.inventory.vectors=1e12;},o=>{o.inventory.truncated=0;},o=>{o.inventory.text=INJECT;},
    o=>{o.objects.complete='yes';},o=>{o.objects.sharedImages=4;},o=>{o.objects.inspected=9;},o=>{o.objects.items=[{bbox:[0,0,10,10],xref:12}];},o=>{delete o.objects.ambiguous;},
    o=>{o.structure={status:'available',reason:null};},o=>{o.structure.reason='docling';},o=>{o.limits=['hint-only','no-object-export','text-only-blue'];},o=>{o.limits.push(INJECT);},
    o=>{o.layout.reverse();},o=>{o.layout.pop();},o=>{o.layout[0].id='c1';},o=>{o.layout[0].bbox=[1,2,3,4];},o=>{o.layout[0].reason='fits';},o=>{o.layout[1].reason=INJECT;},
    o=>{o.layout[1].reason='missing-glyphs';},o=>{o.layout[1].status='unsupported';o.layout[1].reason='height';},o=>{o.layout[1].status='verified';},o=>{o.layout[0].text=INJECT;},o=>{o.layout=null;}];
  for(const [i,m] of mutations.entries()){const bad=clone(ok);m(bad);let e;try{A.summary(bad,{sourceSha256:HASH,ids});}catch(x){e=x;}assert.ok(e,'mutation '+i);assert.equal(e.analysis,true);assert.ok(!e.message.includes('<img')&&!e.message.includes('trial'),'mutation '+i);}
  for(const bad of [null,[],'x',42])assert.throws(()=>A.summary(bad,{sourceSha256:HASH,ids:[]}),/형식/);});

test('core: fixed layout statuses read missing-glyph, line overlap and overflow without claiming quality or a full-PDF verdict',()=>{
  const ids=['edit-1','edit-2','edit-3','edit-4'],layout=[{id:'edit-1',status:'unsupported',reason:'missing-glyphs'},{id:'edit-2',status:'unsupported',reason:'line-bands-overlap'},{id:'edit-3',status:'overflow',reason:'height'},{id:'edit-4',status:'fits',reason:null}];
  const v=A.view(A.summary(summary({status:'partial',layout,inventory:{pages:2,textLines:40,images:3,vectors:5,truncated:true}}),{sourceSha256:HASH,ids}),{'edit-1':'후보 1','edit-2':'후보 3','edit-3':'후보 4','edit-4':'후보 5'});
  assert.match(v.layout[0],/^후보 1 · 측정 불가: 원본 글꼴에 없는 글자/);assert.match(v.layout[1],/^후보 3 · 측정 불가: 줄 간격이 좁아 인접 줄과 겹칠/);assert.match(v.layout[2],/^후보 4 · 원래 줄 공간을 넘침: 원래 줄 수보다/);assert.match(v.layout[3],/^후보 5 · 원래 줄 공간 안에 들어가는 것으로 측정됨$/);
  assert.match(v.headline,/^사전분석 일부만 완료 · 검사한 쪽 2쪽 \(목록 일부 생략\) · 참고용 힌트/);assert.match(v.counts[1],/공유 리소스 배치 2곳/);
  const all=[v.headline,...v.counts,...v.layout,...v.notes].join('\n');for(const claim of [/전체 PDF/,/모든 쪽/,/검증(?:됨|했습니다|완료)/,/통과/,/편집 가능합니다/,/다운로드를 차단했습니다|다운로드가 차단됩니다/])assert.ok(!claim.test(all),String(claim));
  for(const note of [/참고용 힌트/,/시각 품질·도형 정확성/,/다운로드를 막거나 허용하는 근거가 아닙니다/,/교체하거나 내보내지 않습니다/,/BLUE는 사본의 텍스트만/,/Docling\)은 설정되지 않아 실행하지 않았습니다/])assert.match(v.notes.join(' '),note);
  assert.deepEqual([...A.view(A.summary(summary(),{sourceSha256:HASH,ids:[]})).layout],['선택한 후보가 없어 줄 공간은 측정하지 않았습니다.']);
  for(const r of Object.keys(A.UNSUPPORTED))assert.equal(A.summary(summary({layout:[{id:'edit-1',status:'unsupported',reason:r}]}),{sourceSha256:HASH,ids:['edit-1']}).layout[0].reason,r);});

// Fixed broker allow-lists (app/local/paper_analysis_service.py OVERFLOW_REASONS / UNSUPPORTED_REASONS); the in-repo layout probe may emit only these.
const BROKER_UNSUPPORTED=['after-not-text','after-empty','after-too-long','invalid-bbox','invalid-font-size','invalid-line-height','invalid-obstacles','too-many-obstacles','pymupdf-unavailable','font-unavailable',
  'font-metrics-unavailable','unsupported-character','missing-glyphs','line-bands-overlap','source-not-simple','invalid-edit','source-font-not-found','source-font-ambiguous','source-font-type3',
  'source-font-program-unreadable','source-font-not-embedded','probe-error'],BROKER_OVERFLOW=['height','unbreakable-width','slot-budget'];
test('core: every fixed broker/probe layout reason survives the summary and renders fixed copy; unknown or raw reasons are still refused',()=>{
  const probe=fs.readFileSync(path.resolve(__dirname,'../local/pdf_layout_probe.py'),'utf8');
  const emitted=new Set([...probe.matchAll(/_result\([^,]+, 'unsupported', '([a-z0-9-]+)'/g),...probe.matchAll(/return None, '([a-z0-9-]+)', None/g)].map(m=>m[1]));
  for(const r of ['pymupdf-unavailable','font-unavailable','source-font-not-found','source-font-ambiguous','source-font-type3','source-font-program-unreadable','source-font-not-embedded','missing-glyphs','probe-error'])assert.ok(emitted.has(r),'probe emits '+r);
  for(const r of emitted)assert.ok(BROKER_UNSUPPORTED.includes(r),'broker allows '+r);
  assert.deepEqual(Object.keys(A.UNSUPPORTED).sort(),[...BROKER_UNSUPPORTED].sort());assert.deepEqual(Object.keys(A.OVERFLOW).sort(),[...BROKER_OVERFLOW].sort());
  for(const [status,codes,table,prefix] of [['unsupported',BROKER_UNSUPPORTED,A.UNSUPPORTED,'측정 불가: '],['overflow',BROKER_OVERFLOW,A.OVERFLOW,'원래 줄 공간을 넘침: ']])for(const r of codes){
    const s=A.summary(summary({layout:[{id:'edit-1',status,reason:r}]}),{sourceSha256:HASH,ids:['edit-1']});assert.equal(s.layout[0].reason,r);
    const line=A.view(s,{'edit-1':'후보 1'}).layout[0];assert.equal(line,'후보 1 · '+prefix+table[r]);assert.ok(!line.includes(r),r);}
  for(const r of ['source-font-missing','Source-Font-Not-Embedded','source-font-not-embedded ','font_unavailable','conversion_unconfigured','The trial shows a modest benefit','<b>x</b>','__proto__','constructor','toString','',null,0])
    for(const status of ['unsupported','overflow'])assert.throws(()=>A.summary(summary({layout:[{id:'edit-1',status,reason:r}]}),{sourceSha256:HASH,ids:['edit-1']}),e=>e.analysis===true&&/형식/.test(e.message),status+' '+String(r));});

test('bridge: only /api/paper/inspect is added; descriptor and version are exact-or-absent and shown in the status line',async()=>{
  assert.deepEqual({...L.paperAnalysis(DESCRIPTOR)},DESCRIPTOR);
  for(const bad of [null,[],true,{available:'yes',schema:DESCRIPTOR.schema},{available:true,schema:'falsify.pdf-analysis-summary.v2'},{available:true},{...DESCRIPTOR,command:'python x.py'}])assert.equal(L.paperAnalysis(bad),null,JSON.stringify(bad));
  assert.equal(L.workbenchVersion('0.2.0-alpha.1'),'0.2.0-alpha.1');for(const bad of ['v0.2.0','0.2','0.2.0-<b>','0.2.0 alpha',7,'0.2.0-'+'a'.repeat(40)])assert.equal(L.workbenchVersion(bad),null,String(bad));
  const TOKEN='Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789',calls=[];
  const boot=async caps=>{const b=L.create({fetch:async(url,init)=>{calls.push({url,init});return {ok:true,status:200,redirected:false,json:async()=>url==='/api/session'?{token:TOKEN}:caps};},location:{hostname:'127.0.0.1',port:'7816'}});await b.ready;return b;};
  const fresh=await boot(CAP),legacy=await boot({red:true,blue:true,pdf:true});
  assert.deepEqual({...fresh.capabilities().paperAnalysis},DESCRIPTOR);assert.equal(fresh.capabilities().workbenchVersion,'0.2.0-alpha.1');assert.equal(legacy.capabilities().paperAnalysis,null);assert.equal(legacy.capabilities().workbenchVersion,null);
  const s=fresh.session();for(const p of ['/api/paper/inspect/x','/api/paper/convert','/api/paper','/api/paper/inspect?path=C:/x','/api/paper/../session'])await assert.rejects(s.request(p,{}),/허용되지 않은/,p);
  const before=calls.length;await s.request('/api/paper/inspect',{schema:'x'});assert.equal(calls.length,before+1);assert.equal(calls.at(-1).url,'/api/paper/inspect');assert.equal(calls.at(-1).init.method,'POST');assert.equal(calls.at(-1).init.signal,undefined);
  const els={};const el=id=>els[id]||(els[id]={id,value:'',hidden:false,disabled:false,textContent:'',dataset:{},href:'',addEventListener(){},classList:{toggle(){}}});
  for(const id of ['local-bridge','bridge-status'])el(id);const dom={getElementById:id=>els[id]||null,querySelectorAll:()=>[],addEventListener(){}};
  L.mount(fresh,dom);assert.match(els['bridge-status'].textContent,/companion 버전 0\.2\.0-alpha\.1 · PDF 사전분석 가능/);
  L.mount(legacy,dom);assert.match(els['bridge-status'].textContent,/companion 버전 미보고\(구버전\) · PDF 사전분석 미지원\(companion 업데이트 필요\)/);});

test('bridge: an aborted request (deadline) releases the in-flight freeze and never reports success',async()=>{
  const TOKEN='Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789';let seen=null;
  const fetch=(url,init)=>url==='/api/session'?Promise.resolve({ok:true,json:async()=>({token:TOKEN})}):url==='/api/capabilities'?Promise.resolve({ok:true,json:async()=>CAP}):
    new Promise((_,reject)=>{seen=init.signal;init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));});
  const b=L.create({fetch,location:{hostname:'127.0.0.1',port:'7816'}});await b.ready;const controller=new AbortController();
  const pending=b.session().request('/api/paper/inspect',{x:1},{signal:controller.signal});assert.equal(b.state().frozen,true);assert.equal(seen,controller.signal);
  controller.abort();await assert.rejects(pending,e=>e.name==='AbortError'&&/중단/.test(e.message));assert.equal(b.state().frozen,false);});

// RED panel world (same doubles as editor-export) with the analysis core present and a controllable 75 s deadline timer.
function element(id){
  const e=new EventTarget(),classes=new Set();
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],className:'',
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
function world(cap=CAP){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);},created=[],downloads=[],calls=[],events=[],labBusy=[],timers=[];
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>{const e=element('');created.push(e);return e;},body:element('body')});
  get('red-level').value='1';get('red-budget').value='4';get('document-red').hidden=true;
  let reply=async()=>{throw new Error('no broker reply configured');},connected=true;
  const lab={busy(role,v){if(role==='red')labBusy.push(!!v);},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busyCalls:[],busy(role,v){if(role==='red')bridge.busyCalls.push(!!v);},state:()=>({status:connected?'paired':'manual',connected,cap:connected?cap:null}),capabilities:()=>connected?cap:null,
    session:()=>connected?{request:(p,body,options)=>{calls.push({path:p,body,options});return Promise.resolve().then(()=>reply(p,body,options));}}:null};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const fakeSetTimeout=(fn,ms)=>{if(ms>=60000){timers.push({fn,ms,live:true});return 'deadline-'+(timers.length-1);}return setTimeout(fn,ms);};
  const fakeClearTimeout=id=>{if(typeof id==='string'&&id.startsWith('deadline-'))timers[Number(id.slice(9))].live=false;else clearTimeout(id);};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentRed:C,FalsifyHarness:require('../dist/harness-core.js'),FalsifyPaperAnalysis:A,FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,
    setTimeout:fakeSetTimeout,clearTimeout:fakeClearTimeout,AbortController,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object});
  vm.runInContext(SOURCE,ctx,{filename:'document-red.js'});
  for(const type of ['falsify:blue-file','falsify:blue-document'])document.addEventListener(type,e=>events.push(type));
  const fire=(type,detail)=>document.dispatchEvent(new CustomEvent(type,{cancelable:true,detail}));
  const w={get,created,downloads,calls,events,labBusy,timers,bridge,fire,set reply(f){reply=f;},set connected(v){connected=v;},
    status:()=>text(get('red-analysis-status')),body:()=>text(get('red-analysis-body')),
    async load(format='PDF',bytes=SRC){fire('falsify:document',{file:{name:'paper.'+format.toLowerCase(),type:'application/pdf',size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes).buffer},result:{text:SEG0+'\n'+SEG1,format,segments:[{label:'PDF p. 1',text:SEG0},{label:'PDF p. 2',text:SEG1}]}});
      for(let i=0;i<400&&get('document-red').hidden;i++)await new Promise(r=>setTimeout(r,5));assert.equal(get('document-red').hidden,false,'document bound');for(let i=0;i<400&&get('red-analyze').disabled&&format==='PDF'&&connected&&cap?.paperAnalysis?.available;i++)await new Promise(r=>setTimeout(r,5));await flush();},
    async candidates(){get('red-request').click();await flush();const r=JSON.parse(await downloads.pop().text());
      const cand=(id,seg,before,after,quote)=>({id,segmentId:seg,level:1,before,after,rationale:'Synthetic contradiction.',evidence:[{segmentId:seg,quote,relation:'Synthetic relation.'}],uncertainty:'Domain review required.'});
      get('red-response').value=JSON.stringify({schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status:'ok',candidates:[cand('c1','s0','shows a modest benefit','shows a clear benefit',SEG0),cand('c2','s1','only in the treated cohort','in every cohort regardless of treatment',SEG1)]});
      get('red-import-response').click();await flush();},
    boxes:()=>created.filter(e=>e.type==='checkbox'),area:i=>created.find(e=>e.id==='red-after-'+i),
    check(i,v=true){const b=w.boxes()[i];b.checked=v;b.dispatchEvent(new Event('change'));},
    edit(i,v){const a=w.area(i);a.value=v;a.dispatchEvent(new Event('input'));},
    analyze(){get('red-analyze').click();}};
  return w;
}
const layoutFor=body=>body.patches.map(p=>({id:p.id,status:'overflow',reason:'height'}));

test('panel: no request on load, upload or candidate import; PDF-only; old or missing broker disables with update help',async()=>{
  const w=world();await w.load();assert.equal(w.calls.length,0,'no auto-fetch on upload');assert.equal(w.get('red-analysis').hidden,false);assert.equal(w.get('red-analyze').disabled,false);
  await w.candidates();assert.equal(w.calls.length,0,'no auto-fetch on candidate import');assert.match(text(w.get('red-analysis-note')),/선택 사항 · 연결된 companion이 원본 PDF을 검사합니다. 모델은 호출하지 않으며/);
  w.check(1);assert.match(text(w.get('red-analysis-note')),/선택한 후보 1개의 줄 공간/);assert.equal(w.calls.length,0);
  const txt=world();await txt.load('TXT');assert.equal(txt.get('red-analysis').hidden,true);txt.analyze();await flush();assert.equal(txt.calls.length,0);
  const old=world({red:true,blue:true,pdf:true,paperAnalysis:null});await old.load();assert.equal(old.get('red-analyze').disabled,true);assert.match(text(old.get('red-analysis-note')),/지원하지 않습니다\(구버전\).*업데이트/);old.analyze();await flush();assert.equal(old.calls.length,0);
  const off=world({...CAP,paperAnalysis:{...DESCRIPTOR,available:false}});await off.load();assert.equal(off.get('red-analyze').disabled,true);assert.match(text(off.get('red-analysis-note')),/지금 쓸 수 없습니다/);
  const none=world();none.connected=false;await none.load();assert.equal(none.get('red-analyze').disabled,true);assert.match(text(none.get('red-analysis-note')),/연결된 로컬 companion이 필요합니다/);none.analyze();await flush();assert.equal(none.calls.length,0);
  assert.equal(none.get('red-request').disabled,false,'manual JSON workflow stays available without a broker');});

test('panel: before a model run it sends the bound file and hash with no patches; afterwards only the selected, edited candidate',async()=>{
  const w=world();await w.load();w.reply=async(p,body)=>summary();w.analyze();await flush();
  assert.equal(w.calls.length,1);const first=w.calls[0];assert.equal(first.path,'/api/paper/inspect');assert.deepEqual(Object.keys(first.body),['schema','fileHash','file','patches']);
  assert.equal(first.body.fileHash,HASH);assert.equal(first.body.file,SRC.toString('base64'));assert.equal(JSON.stringify(first.body.patches),'[]');assert.match(w.status(),/^사전분석 완료 · 검사한 쪽 2쪽/);assert.equal(w.get('red-analysis-result').hidden,false);
  await w.candidates();w.check(1);w.edit(1,'in every cohort, including the untreated one');assert.equal(w.get('red-analysis-result').hidden,true,'selection/After change discards the old summary');
  w.reply=async(p,body)=>summary({layout:layoutFor(body)});w.analyze();await flush();
  const second=w.calls[1].body;assert.deepEqual(second.patches,[{id:'edit-1',pageIndex:1,before:'only in the treated cohort',after:'in every cohort, including the untreated one'}]);
  assert.ok(!JSON.stringify(second.patches).includes('c2')&&!JSON.stringify(second).includes('Synthetic')&&!JSON.stringify(second).includes('segmentId'),'no model ids, rationale or evidence leave the page');
  assert.match(w.body(),/후보 2 · 원래 줄 공간을 넘침: 원래 줄 수보다 많은 줄이 필요함/);assert.ok(w.calls.every(c=>c.path==='/api/paper/inspect'),'no RED job or export call');assert.deepEqual(w.events,[],'no BLUE input or run');});

test('panel: active analysis freezes RED, harness and bridge like export; one link carries the request and is released after',async()=>{
  const w=world();await w.load();await w.candidates();w.check(0);const d=deferred();w.reply=()=>d.promise;w.get('red-consent').checked=true;w.get('red-consent').dispatchEvent(new Event('change'));w.analyze();await flush();
  assert.equal(w.bridge.busyCalls.at(-1),true);assert.equal(w.labBusy.at(-1),true);for(const id of ['red-analyze','red-start','red-request','red-import-response','red-plan','red-download','red-level','red-budget'])assert.equal(w.get(id).disabled,true,id);
  assert.match(w.status(),/사전분석하는 중입니다. 모델은 호출하지 않으며 75초/);
  w.analyze();await flush();assert.equal(w.calls.length,1,'no double submission');assert.equal(w.timers.filter(t=>t.live).length,1);
  d.resolve(summary({layout:layoutFor(w.calls[0].body)}));await flush();assert.equal(w.bridge.busyCalls.at(-1),false);assert.equal(w.labBusy.at(-1),false);assert.equal(w.get('red-analyze').disabled,false);assert.equal(w.get('red-start').disabled,false);assert.equal(w.timers.filter(t=>t.live).length,0,'deadline cleared');});

test('panel: deadline aborts the request, releases the freeze and keeps source, candidates and edits',async()=>{
  const w=world();await w.load();await w.candidates();w.check(1);w.edit(1,'in every cohort, including the untreated one');let signal=null;
  w.reply=(p,body,options)=>new Promise((_,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new Error('<b>raw broker abort</b>')));});w.analyze();await flush();
  assert.equal(w.bridge.busyCalls.at(-1),true);const timer=w.timers.find(t=>t.live);assert.ok(timer.ms>=60000&&timer.ms<=90000);timer.fn();await flush();
  assert.equal(signal.aborted,true);assert.match(w.status(),/75초 안에 끝나지 않아 중단했습니다/);assert.ok(!w.status().includes('raw broker'));assert.equal(w.get('red-analysis-status').classList.contains('error'),true);
  assert.equal(w.bridge.busyCalls.at(-1),false);assert.equal(w.labBusy.at(-1),false);assert.equal(w.boxes()[1].checked,true);assert.equal(w.area(1).value,'in every cohort, including the untreated one');assert.equal(w.get('document-red').hidden,false);assert.equal(w.get('red-analyze').disabled,false);});

test('panel: source replacement, source clear, After edits and a foreign hash discard stale responses',async()=>{
  const replaced=world();await replaced.load();const d=deferred();let signal=null;replaced.reply=(p,b,o)=>{signal=o.signal;return d.promise;};replaced.analyze();await flush();
  await replaced.load('PDF',OUT);assert.equal(signal.aborted,true);d.resolve(summary());await flush();assert.equal(replaced.get('red-analysis-result').hidden,true);assert.equal(replaced.body(),'');assert.ok(!/사전분석 완료/.test(replaced.status()));assert.equal(replaced.bridge.busyCalls.at(-1),false);
  const cleared=world();await cleared.load();const d2=deferred();cleared.reply=()=>d2.promise;cleared.analyze();await flush();cleared.fire('falsify:document-clear');d2.resolve(summary());await flush();assert.equal(cleared.body(),'');assert.equal(cleared.get('document-red').hidden,true);
  const edited=world();await edited.load();await edited.candidates();edited.check(1);const d3=deferred();edited.reply=()=>d3.promise;edited.analyze();await flush();
  edited.edit(1,'in every cohort, edited while analysing');d3.resolve(summary({layout:[{id:'edit-1',status:'fits',reason:null}]}));await flush();assert.equal(edited.body(),'','After changed mid-flight: result discarded');assert.equal(edited.bridge.busyCalls.at(-1),false);
  const foreign=world();await foreign.load();foreign.reply=async()=>summary({sourceSha256:sha(OUT)});foreign.analyze();await flush();assert.match(foreign.status(),/현재 원본 PDF와 맞지 않아 버렸습니다/);assert.equal(foreign.body(),'');assert.equal(foreign.get('red-analysis-result').hidden,true);});

test('panel: a forged summary cannot inject paper text, HTML or coordinates; rendering is textContent of fixed copy only',async()=>{
  const INJECT='<script>alert(1)</script>The trial shows a modest benefit in adults.';
  for(const forged of [{...summary(),raw:INJECT},summary({inventory:{pages:2,textLines:40,images:3,vectors:5,truncated:false,text:[INJECT]}}),summary({objects:{images:3,sharedImages:2,inlineImages:0,vectors:5,ambiguous:2,inspected:1,complete:true,bbox:[1,2,3,4]}}),
    summary({status:INJECT}),summary({limits:['hint-only','text-only-blue',INJECT]}),summary({structure:{status:'unavailable',reason:INJECT}})]){
    const w=world();await w.load();w.reply=async()=>forged;w.analyze();await flush();assert.match(w.status(),/약속된 형식과 달라 표시하지 않았습니다/);assert.equal(w.body(),'');assert.ok(!w.status().includes('<script')&&!w.status().includes('trial'));}
  const w=world();await w.load();await w.candidates();w.check(0);w.reply=async(p,body)=>summary({layout:[{id:'edit-1',status:'unsupported',reason:'missing-glyphs'}]});w.analyze();await flush();
  assert.match(w.body(),/후보 1 · 측정 불가: 원본 글꼴에 없는 글자가 있음/);assert.ok(!w.body().includes(SEG0)&&!w.body().includes('shows a'),'no paper text echoed');
  const failing=world();await failing.load();failing.reply=async()=>{throw new Error('<img src=x onerror=alert(1)> Traceback C:/Users/secret/paper.pdf');};failing.analyze();await flush();
  assert.match(failing.status(),/^사전분석 요청이 실패했습니다/);assert.ok(!/img|Traceback|secret/.test(failing.status()));
  for(const f of ['document-red.js','paper-analysis-core.js'])assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(fs.readFileSync(path.join(dist,f),'utf8')),f);});

test('panel: analysis failure leaves the exported copy, BLUE handoff and RED-only workflow untouched',async()=>{
  const w=world();await w.load();await w.candidates();w.check(1);w.edit(1,'in every cohort, including the untreated one');w.get('red-export-consent').checked=true;w.get('red-export-consent').dispatchEvent(new Event('change'));
  w.reply=async()=>({file:OUT.toString('base64'),outputFileHash:sha(OUT),verification:{mode:'pdf-original-font-single-line',pages:2}});w.get('red-download').click();
  for(let i=0;i<400&&w.get('red-handoff').hidden!==false;i++)await new Promise(r=>setTimeout(r,5));assert.equal(w.get('red-handoff').hidden,false,'export ready for handoff');const exports=w.downloads.length;
  w.reply=async()=>{throw new Error('busy');};w.analyze();await flush();assert.match(w.status(),/요청이 실패했습니다/);
  assert.equal(w.get('red-handoff').hidden,false,'export and handoff survive');assert.equal(w.downloads.length,exports,'no extra download');assert.deepEqual(w.events,[],'no BLUE autorun');
  assert.deepEqual(w.calls.map(c=>c.path),['/api/export','/api/paper/inspect']);assert.equal(w.get('red-download').disabled,false);});

test('page: analysis core loads before the RED module and the panel sits in the RED execute step with an accessible status',()=>{
  const html=fs.readFileSync(path.join(dist,'index.html'),'utf8'),order=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]);
  assert.ok(order.indexOf('paper-analysis-core.js')>=0&&order.indexOf('paper-analysis-core.js')<order.indexOf('document-red.js'));
  const panel=html.match(/<div class="red-analysis" id="red-analysis" hidden>.*?<\/details><\/div>/)?.[0];assert.ok(panel);assert.ok(html.indexOf('id="red-document-summary"')<html.indexOf('id="red-analysis"'));
  assert.match(panel,/<button class="button secondary" type="button" id="red-analyze" aria-describedby="red-analysis-note" disabled>PDF 사전분석<\/button>/);assert.match(panel,/id="red-analysis-status" class="form-feedback" role="status" aria-live="polite"/);
  assert.ok(!/replace|교체 실행|object/i.test(panel.replace(/class="[^"]*"/g,'')),'no object replacement control');assert.ok(!/document-blue/.test(panel));});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name);console.error(e);process.exitCode=1;}}
  console.log(JSON.stringify({passed,failed:tests.length-passed,skipped:0}));if(passed!==tests.length)process.exit(1);})();
