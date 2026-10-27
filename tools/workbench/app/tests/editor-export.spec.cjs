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
function world(cap){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);},created=[],downloads=[],calls=[],handoffs=[];
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>{const e=element('');created.push(e);return e;},body:element('body')});
  get('red-level').value='1';get('red-budget').value='4';get('document-red').hidden=true;
  let reply=async()=>{throw new Error('no broker reply configured');};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busyCalls:[],busy(role,v){if(role==='red')bridge.busyCalls.push(!!v);},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,
    session:()=>({request:(p,body)=>{calls.push({path:p,body});const out=Promise.resolve().then(()=>reply(p,body));w.inflight++;out.then(()=>{w.inflight--;},()=>{w.inflight--;});return out;}})};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentRed:C,FalsifyHarness:require('../dist/harness-core.js'),FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object});
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

test('descriptor: new broker keeps pdf boolean and a sanitized frozen pdfEditor; legacy broker has none',async()=>{
  const boot=async caps=>{const b=L.create({fetch:async p=>({ok:true,json:async()=>p==='/api/session'?{token:'t'.repeat(32)}:caps}),location:{hostname:'127.0.0.1',port:'7816'}});await b.ready;return b.capabilities();};
  const fresh=await boot({...NEW,pdfEditor:{...EDITOR,extra:'dropped'}});
  assert.equal(fresh.pdf,true);assert.deepEqual({...fresh.pdfEditor,limits:{...fresh.pdfEditor.limits}},{...EDITOR,continuationStyle:null},'no style capability unless declared');assert.equal(Object.isFrozen(fresh.pdfEditor),true);
  const legacy=await boot(OLD);assert.equal(legacy.pdf,true);assert.equal(legacy.pdfEditor,null);
  const missing=await boot({red:true,blue:true,pdf:false,pdfEditor:{available:false,engine:'falsify-pdf-editor',version:null,wasmSha256:null,reflow:true,pagination:true}});
  assert.equal(missing.pdf,false);assert.equal(missing.pdfEditor.available,false);});

test('descriptor: malformed core fields drop it, bounded optional fields are cleaned',()=>{
  for(const bad of [null,[],'x',{...EDITOR,engine:'other'},{...EDITOR,available:'yes'},{...EDITOR,reflow:1},{...EDITOR,pagination:null},{...EDITOR,wasmSha256:'AB'.repeat(32)},{...EDITOR,wasmSha256:'ab'},{...EDITOR,version:'1 2'},{...EDITOR,version:'v'.repeat(41)},{...EDITOR,version:undefined}])
    assert.equal(L.pdfEditor(bad),null,JSON.stringify(bad));
  for(const url of ['http://github.com/Shinick-Han/x','https://evil.example/Shinick-Han/x','https://github.com/other/x','https://github.com/Shinick-Han/x?ref=1','https://u:p@github.com/Shinick-Han/x','https://github.com:444/Shinick-Han/x','javascript:alert(1)',42,'https://github.com/Shinick-Han/'+'a'.repeat(300)])
    assert.equal(L.pdfEditor({...EDITOR,sourceUrl:url}).sourceUrl,null,String(url));
  assert.deepEqual({...L.pdfEditor({...EDITOR,limits:{good:3,neg:-1,frac:1.5,'bad key':2,str:'9'}}).limits},{good:3});
  assert.equal(L.pdfEditor({...EDITOR,limits:'x'.repeat(500)}).limits.length,300);});

const STYLE={supported:true,policy:'source-number-suffix',scope:'text-only source-style header/footer; standalone Arabic source number plus decimal suffix; originals unchanged'};
const STYLED={...NEW,pdfEditor:{...EDITOR,continuationStyle:STYLE}};
// Status parts by class, not position: headline + separate continuation line share red-export-outcome.
const outcomes=w=>w.get('red-export-status').children.filter(c=>c.className==='red-export-outcome'),part=(w,cls)=>w.get('red-export-status').children.find(c=>c.className===cls);
test('descriptor: continuationStyle is declared, exact-policy, fixed scope; never inferred from pagination',()=>{
  const s=L.pdfEditor({...EDITOR,continuationStyle:{...STYLE,scope:'C:/Users/x/paper.pdf · Secret header text',extra:1}}).continuationStyle;
  assert.deepEqual({...s},STYLE,'engine scope text is not echoed');assert.equal(Object.isFrozen(s),true);
  assert.equal(L.pdfEditor({...EDITOR,pagination:true}).continuationStyle,null,'pagination true alone is not a style capability');
  for(const bad of [null,true,'source-number-suffix',[],[STYLE],{...STYLE,supported:'true'},{...STYLE,supported:1},{...STYLE,policy:'renumber-all'},{supported:true},{policy:'source-number-suffix'}])
    assert.equal(L.pdfEditor({...EDITOR,continuationStyle:bad}).continuationStyle,null,JSON.stringify(bad));
  assert.equal(L.pdfEditor({...EDITOR,pagination:false,continuationStyle:STYLE}).continuationStyle,null,'no style without pagination');
  assert.notEqual(L.pdfEditor({...EDITOR,continuationStyle:{...STYLE,supported:'x'}}),null,'malformed optional style keeps the descriptor');});

const NUMBERING='원래 쪽번호는 바꾸지 않으며, 원본에 단독 아라비아 숫자 쪽번호가 있으면 추가 페이지는 그 번호에 소수 접미(예: 10.1)를 붙입니다.';
test('mode line: declared style explains unchanged originals and a conditional decimal suffix in separate blocks; copy claimed only per report',async()=>{
  let w=world(STYLED);await w.ready();const mt=text(w.get('red-export-mode'));
  assert.ok(mt.includes('추가 페이지에도 원본 머리말·꼬리말 텍스트와 글꼴을 이어갑니다. '+NUMBERING+' 이미지·도형 머리말·꼬리말이 있으면 내보내기를 차단합니다. 실제 적용 여부는 다운로드 결과에 표시합니다.'),mt);
  assert.doesNotMatch(mt,/10\.1처럼|표기합니다|추가 쪽번호는/,'numbering is conditional on a standalone Arabic source number');
  const blocks=w.get('red-export-mode').children.filter(x=>typeof x!=='string'&&x.className==='red-export-outcome').map(x=>x.textContent);
  assert.equal(blocks.length,2,'scope, added pages and self-check boundary are separate sentence groups');assert.match(blocks[0],/^추가 페이지에도 원본 머리말/);assert.match(blocks[1],/^실제 줄바꿈·페이지 수는 출력 사본의 엔진 자체검사 결과로만 표시합니다\./);
  const help=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8');assert.ok(help.includes('지원 엔진은 원본 텍스트와 글꼴을 복제합니다. '+NUMBERING),'shared help uses the same conditional numbering');assert.doesNotMatch(help,/10\.1처럼|표기하며/);
  assert.doesNotMatch(mt,/본문만 담고 머리말·꼬리말·쪽번호가 없으며/);assert.doesNotMatch(mt,/보이지 않|모든 형식|독립 검증 완료/);
  w=world({...NEW,pdfEditor:{...EDITOR,continuationStyle:{...STYLE,policy:'other'}}});await w.ready();
  assert.match(text(w.get('red-export-mode')),/본문만 담고 머리말·꼬리말·쪽번호가 없으며/,'unsupported style keeps body-only copy');assert.doesNotMatch(text(w.get('red-export-mode')),/10\.1/);});

test('success: header/footer copy only when the output report declares it, in its own block; malformed reports under a styled engine read unknown',async()=>{
  const run=async(cap,continuationStyle)=>{const w=world(cap);await w.ready();w.reply=ok({...ACTUAL,continuationStyle});w.get('red-download').click();await flush();return w;};
  const OK={policy:'source-number-suffix',applied:true,copiedPages:2};
  let w=await run(STYLED,OK);const [main,cont]=outcomes(w),check=part(w,'red-export-check');assert.equal(outcomes(w).length,2,'headline and continuation are two outcome nodes');
  assert.match(main.textContent,/페이지 2 → 4 \(새 페이지 2쪽\)/);assert.doesNotMatch(main.textContent,/머리말|꼬리말|쪽번호/,'page growth and continuation scan separately');
  assert.equal(cont.className,'red-export-outcome');
  assert.equal(cont.textContent,'엔진 보고: 추가 페이지 2쪽 모두에 원본 머리말·꼬리말 텍스트를 이어 붙였습니다. 원래 쪽번호는 바꾸지 않으며, 원본에 단독 아라비아 숫자 쪽번호가 있으면 추가 페이지는 그 번호에 소수 접미를 붙입니다.');
  assert.doesNotMatch(w.status(),/본문만 있고|표기했습니다|10\.1|독립 검증|보이지 않/,'no numbering fact in the report: no past tense, no example as this output');assert.equal(text(check.children[0]),'같은 엔진 자체검사');
  const body=async(label,over)=>{const x=world(STYLED);await x.ready();x.reply=ok({...ACTUAL,continuationStyle:OK,...over});x.get('red-download').click();await flush();const s=x.status();
    assert.equal(outcomes(x)[1].textContent,'추가 페이지 머리말·꼬리말·쪽번호 적용 여부는 엔진이 확인 가능한 형태로 보고하지 않았습니다.',label);
    assert.doesNotMatch(s,/본문만 있고|머리말·꼬리말·쪽번호가 없으며|이어 붙였습니다|10\.1/,label);assert.equal(x.downloads.length,1,label);};
  for(const bad of [undefined,null,'yes',{...OK,applied:'true'},{...OK,copiedPages:3},{...OK,copiedPages:1},{...OK,copiedPages:-1},{...OK,copiedPages:1.5},{...OK,copiedPages:'2'},
      {policy:'source-number-suffix',applied:true},{...OK,policy:'renumber'},{...OK,copiedPages:0}])await body(JSON.stringify(bad),{continuationStyle:bad});
  for(const [label,over] of [['addedPages missing',{addedPages:undefined}],['addedPages mismatch',{addedPages:1}],['addedPages string',{addedPages:'2'}]])await body(label,over);
  await body('over 32 pages',{pagination:{inputPages:1,outputPages:34},addedPages:33,continuationStyle:{...OK,copiedPages:33}});
  const edge=world(STYLED);await edge.ready();edge.reply=ok({...ACTUAL,pagination:{inputPages:1,outputPages:33},addedPages:32,continuationStyle:{...OK,copiedPages:32}});edge.get('red-download').click();await flush();
  assert.match(outcomes(edge)[1].textContent,/추가 페이지 32쪽 모두에/);
  for(const [label,cap] of [['no style',NEW],['other policy',{...NEW,pdfEditor:{...EDITOR,continuationStyle:{...STYLE,policy:'other'}}}]])for(const report of [undefined,{...OK,copiedPages:3}]){const x=await run(cap,report);
    assert.equal(outcomes(x)[1].textContent,'추가된 이어지는 페이지에는 본문만 있고 머리말·꼬리말·쪽번호가 없으며, 뒤쪽 원래 페이지의 쪽번호는 다시 매기지 않았습니다.',label+' keeps body-only');
    assert.doesNotMatch(x.status(),/확인 가능한 형태로 보고하지|이어 붙였습니다/,label);}
  w=world(STYLED);await w.ready();w.reply=ok({...ACTUAL,continuationStyle:OK,layoutVerified:false});w.get('red-download').click();await flush();
  assert.match(w.status(),/^다운로드 차단/);assert.doesNotMatch(w.status(),/이어 붙였습니다/);assert.equal(w.downloads.length,0);
  w=world(STYLED);await w.ready();w.reply=ok({...ACTUAL,pagination:{inputPages:2,outputPages:2},continuationStyle:{policy:'source-number-suffix',applied:true,copiedPages:0}});w.get('red-download').click();await flush();
  assert.doesNotMatch(w.status(),/머리말·꼬리말|10\.1/,'no added pages, no continuation claim');});

test('styled capability: failed export keeps selection, edited After and source; nothing downloads',async()=>{const w=world(STYLED);await w.ready();
  w.reply=async()=>{throw new Error('synthetic: EDGE_SUFFIX_GLYPH_MISSING');};w.get('red-download').click();await flush();
  assert.match(w.status(),/^다운로드 차단: synthetic: EDGE_SUFFIX_GLYPH_MISSING/);assert.equal(w.downloads.length,0);assert.equal(w.get('red-handoff').hidden,true);
  assert.equal(w.boxes()[1].checked,true);assert.equal(w.area(1).value,'in every cohort, including the untreated one');
  w.reply=ok({...ACTUAL,continuationStyle:{policy:'source-number-suffix',applied:true,copiedPages:2}});w.get('red-download').click();await flush();
  assert.equal(w.calls[1].body.file,w.calls[0].body.file,'same source bytes on retry');assert.deepEqual(Object.keys(w.calls[1].body).sort(),['file','fileHash','format','patches'],'no style field sent');});

test('export mode line distinguishes reflow engine, legacy single-line and missing editor',async()=>{
  let w=world(NEW);await w.ready();const m=w.get('red-export-mode'),mt=text(m);
  assert.equal(m.hidden,false);assert.match(mt,/falsify-pdf-editor 0\.4\.1/);assert.match(mt,/줄바꿈 재배치와 필요 시 이어지는 페이지 추가/);assert.match(mt,/엔진 자체검사 결과로만/);assert.equal(w.get('red-download').disabled,false);
  assert.match(mt,/1단·회전 없음·잘림 없음인 최상위 본문 텍스트뿐/);assert.match(mt,/본문만 담고 머리말·꼬리말·쪽번호가 없으며, 뒤쪽 원래 페이지의 쪽번호는 다시 매기지 않습니다/);
  assert.equal(w.get('red-download').textContent,'PDF 다운로드');
  w=world(OLD);await w.ready();assert.match(text(w.get('red-export-mode')),/^기존 한 줄 보존 편집/);assert.match(text(w.get('red-export-mode')),/최신 companion/);assert.equal(w.get('red-download').disabled,false);
  assert.equal(w.get('red-download').textContent,'PDF 다운로드','legacy single-line label unchanged');
  w=world({...OLD,pdfEditor:{...EDITOR,reflow:false,pagination:false}});await w.ready();assert.match(text(w.get('red-export-mode')),/줄바꿈 재배치를 지원하지 않아/);assert.equal(w.get('red-download').textContent,'PDF 다운로드');
  w=world({...OLD,pdfEditor:{...EDITOR,available:false}});await w.ready();assert.match(text(w.get('red-export-mode')),/아직 준비되지 않았습니다.*연결 패널/);
  w=world({red:true,blue:true,pdf:false,pdfEditor:{...EDITOR,available:false}});await w.ready();
  assert.equal(w.get('red-download').disabled,true);assert.equal(w.get('red-export-mode').hidden,true);assert.match(w.status(),/연결 패널.*After는 그대로/);assert.equal(w.get('red-plan').disabled,false,'plan JSON still available');});

test('nothing is auto-selected or auto-run; export needs a checked candidate',async()=>{const w=world(NEW);await w.load();await w.candidates();
  assert.equal(w.boxes().every(b=>!b.checked),true);assert.equal(w.get('red-download').disabled,true);assert.equal(w.calls.length,0);
  w.check(0);assert.equal(w.get('red-download').disabled,false);assert.equal(w.calls.length,0);});

test('same /api/export body: only checked candidates with the user-edited After; pending locks and honest progress',async()=>{const w=world(NEW);await w.ready();
  let release;w.reply=()=>new Promise(r=>{release=r;});w.get('red-download').click();await flush();
  assert.equal(w.calls.length,1);const {path:p,body}=w.calls[0];assert.equal(p,'/api/export');
  assert.deepEqual(Object.keys(body).sort(),['file','fileHash','format','patches']);assert.equal(body.format,'PDF');assert.equal(body.fileHash,sha(SRC));assert.equal(Buffer.from(body.file,'base64').equals(SRC),true);
  assert.equal(body.patches.length,1);assert.equal(body.patches[0].id,'c2');assert.equal(body.patches[0].before,BEFORE1);assert.equal(body.patches[0].after,'in every cohort, including the untreated one');assert.equal(body.patches[0].edited,true);
  for(const id of ['red-download','red-plan','red-request','red-import-response','red-level'])assert.equal(w.get(id).disabled,true,id);
  assert.equal(w.bridge.busyCalls.at(-1),true,'bridge frozen during export');assert.match(w.status(),/줄바꿈 재배치·엔진 자체검사하는 중/);assert.doesNotMatch(w.status(),/\d+\s*%/);
  release(await ok(REFLOWED)());await flush();
  assert.equal(w.bridge.busyCalls.at(-1),false);assert.equal(w.get('red-download').disabled,false);
  assert.equal(w.area(1).value,'in every cohort, including the untreated one','After kept after export');});

test('verified success reports wrapping and new pages, downloads copy + separate plan, offers unchanged BLUE handoff',async()=>{const w=world(NEW);await w.ready();w.reply=ok(REFLOWED);w.get('red-download').click();await flush();
  const s=w.status();assert.match(s,/다운로드했습니다/);assert.match(s,/줄바꿈 재배치 3줄/);assert.match(s,/페이지 10 → 11 \(새 페이지 1쪽\)/);assert.match(s,/과학적 타당성·결함 품질 판정이 아닙니다/);assert.match(s,/Synthetic engine limits/);
  assert.match(s,/머리말·꼬리말·쪽번호가 없으며/,'continuation limitation whenever pages grow');assert.doesNotMatch(s,/엔진 검증 결과/);
  assert.match(s,/엔진 자체검사 · 독립성 미보고/,'legacy payload without selfCheck claims no independence');assert.match(s,/독립 검수 상태 미보고/);
  assert.equal(w.get('red-export-status').classList.contains('error'),false);
  assert.equal(w.downloads.length,1);assert.equal(Buffer.from(await w.downloads[0].arrayBuffer()).equals(OUT),true);
  w.get('red-plan').click();await flush();assert.equal(w.downloads.length,2);const plan=JSON.parse(await w.downloads[1].text());assert.equal(plan.outputFileHash,sha(OUT));assert.deepEqual(plan.verification.pagination,REFLOWED.pagination);assert.equal(plan.status.gold,'pending');
  assert.equal(w.get('red-handoff').hidden,false);assert.equal(w.handoffs.length,0,'BLUE never started automatically');
  w.clickDoc('#red-handoff');await flush();assert.equal(w.handoffs.length,1);const h=w.handoffs[0];
  assert.deepEqual(Object.keys(h).sort(),['file','sourceRunId'],'BLUE receives only the copy and the run relation');assert.equal(Buffer.from(await h.file.arrayBuffer()).equals(OUT),true);assert.equal(typeof h.sourceRunId,'string');});

test('engine error is actionable and keeps candidates, selection, edited After and the source',async()=>{const w=world(NEW);await w.ready();
  w.reply=async()=>{throw new Error('synthetic: rotated text block cannot be reflowed');};w.get('red-download').click();await flush();
  const s=w.status();assert.match(s,/^다운로드 차단: synthetic: rotated text block/);
  assert.equal(w.get('red-export-status').classList.contains('error'),true);assert.equal(w.downloads.length,0);
  assert.equal(w.boxes()[1].checked,true);assert.equal(w.boxes()[0].checked,false);assert.equal(w.area(1).value,'in every cohort, including the untreated one');
  assert.equal(w.get('red-download').disabled,false,'retry possible');assert.equal(w.get('red-handoff').hidden,true);
  w.reply=ok(REFLOWED);w.get('red-download').click();await flush();assert.equal(w.calls[1].body.patches[0].after,'in every cohort, including the untreated one');assert.equal(w.calls[1].body.file,w.calls[0].body.file);assert.match(w.status(),/다운로드했습니다/);
  w.edit(1,'in every cohort');assert.equal(w.status(),'');assert.equal(w.get('red-export-status').classList.contains('error'),false);assert.equal(w.get('red-handoff').hidden,true,'edit invalidates handoff');});

test('legacy broker error points to the single-line limit and a reflow-capable companion',async()=>{const w=world(OLD);await w.ready();
  w.reply=async()=>{throw new Error('줄바꿈이 필요한 변경입니다.');};w.get('red-download').click();await flush();
  assert.match(w.status(),/줄바꿈이 필요한 변경입니다/);assert.match(w.calls[0].body.patches[0].after,/untreated/);});

test('reset during a pending export discards the late result without downloading',async()=>{const w=world(NEW);await w.ready();
  let release;w.reply=()=>new Promise(r=>{release=r;});w.get('red-download').click();await flush();
  w.fire('falsify:document-clear');release(await ok(REFLOWED)());await flush();
  assert.equal(w.downloads.length,0);assert.doesNotMatch(w.status(),/다운로드했습니다/);assert.equal(w.get('document-red').hidden,true);assert.equal(w.bridge.busyCalls.at(-1),false);});

test('no blanket success: unverified layout, hash mismatch and missing pagination are reported honestly',async()=>{
  let w=world(NEW);await w.ready();w.reply=ok({...REFLOWED,layoutVerified:false,diagnostics:['Table cell overflow on page 4',{message:'Footnote collision'},7]});w.get('red-download').click();await flush();
  assert.match(w.status(),/레이아웃 검증을 통과시키지 못해/);assert.match(w.status(),/Table cell overflow on page 4 \/ Footnote collision/);assert.equal(w.downloads.length,0);
  w=world(NEW);await w.ready();w.reply=async()=>({...(await ok(REFLOWED)()),outputFileHash:'0'.repeat(64)});w.get('red-download').click();await flush();
  assert.match(w.status(),/출력 해시와 받은 파일이 달라/);assert.equal(w.downloads.length,0);
  w=world(NEW);await w.ready();w.reply=ok({engine:'falsify-pdf-editor',layoutVerified:true,reflow:{wrappedLines:'3'},pagination:{inputPages:10,outputPages:9},diagnostics:['Hyphenation differs from source']});w.get('red-download').click();await flush();
  assert.match(w.status(),/줄바꿈 결과 미보고/);assert.match(w.status(),/페이지 수 변화 미검증/);assert.match(w.status(),/심각도 미보고 · 엔진 진단 \(Hyphenation differs/);assert.doesNotMatch(w.status(),/새 페이지|머리말·꼬리말/);
  assert.match(w.status(),/다운로드했습니다/,'honest missing counters only with layoutVerified true');assert.equal(w.downloads.length,1);
  w=world(OLD);await w.ready();w.reply=ok({mode:'pdf-original-font-single-line',pages:10,limits:'96dpi'});w.get('red-download').click();await flush();
  assert.match(w.status(),/기존 한 줄 교체 · 줄바꿈·페이지 추가 없음 · 10쪽/);assert.doesNotMatch(w.status(),/새 페이지|재배치 \d/);});

test('actual engine payload: ink outcome, same-engine self-check state, mapped diagnostics with severity and codes',async()=>{const w=world(NEW);await w.ready();w.reply=ok(ACTUAL);w.get('red-download').click();await flush();
  const e=w.get('red-export-status'),[outcome,cont]=outcomes(w),check=part(w,'red-export-check'),notes=part(w,'red-export-notes');assert.equal(outcomes(w).length,2);assert.equal(e.classList.contains('error'),false);assert.equal(w.downloads.length,1);
  assert.equal(outcome.className,'red-export-outcome');assert.match(outcome.textContent,/다운로드했습니다.*페이지 2 → 4 \(새 페이지 2쪽\) · 줄바꿈 결과 미보고/);assert.doesNotMatch(outcome.textContent,/별도 변경 계획을 다운로드/);
  assert.equal(cont.className,'red-export-outcome');assert.match(cont.textContent,/^추가된 이어지는 페이지에는 본문만 있고 머리말·꼬리말·쪽번호가 없으며, 뒤쪽 원래 페이지의 쪽번호는 다시 매기지 않았습니다/);assert.doesNotMatch(outcome.textContent,/머리말/);
  assert.doesNotMatch(outcome.textContent,/engine_|pagination_required|주의/,'diagnostics stay out of the outcome line');
  assert.equal(check.className,'red-export-check');assert.equal(check.children[0].className,'status-label');assert.equal(check.children[0].textContent,'같은 엔진 자체검사');
  assert.match(text(check),/독립 추출\/렌더링·사람 검수 대기/);assert.doesNotMatch(w.status(),/독립 검증 완료|엔진 검증 결과|독립성 미보고/);
  assert.equal(notes.className,'red-export-notes');const items=notes.children.map(text);assert.equal(items.length,3);
  assert.equal(items[0],'정보 · 엔진 내부 줄 모델이 편집 뒤 갱신되지 않았다고 보고됨 (engine_model_lines_stale, p. 1)');
  assert.equal(items[1],'정보 · 긴 After를 담으려고 이어지는 페이지가 필요했다고 보고됨 (pagination_required, p. 1)');
  assert.equal(items[2],'주의 · 엔진이 추가 콘텐츠의 그리기/추출 순서 확인을 요청함 (content_stream_append_order, p. 1)');assert.doesNotMatch(items[2],/원본과 다름/,'structural warning is not a defect verdict');
  assert.equal(notes.children.map(li=>li.children[0].className).join(),'note-info,note-info,note-warning','only warning severity is marked 주의');
  const v=world(NEW);await v.ready();v.reply=ok({...ACTUAL,warnings:[{pageIndex:'x',code:'<b>new_code</b>'+'z'.repeat(80)},{code:'pagination_required',severity:'bogus'},{code:'__proto__',severity:'info'}]});v.get('red-download').click();await flush();
  const unknown=v.get('red-export-status').children.find(c=>c.className==='red-export-notes').children.map(text);
  assert.equal(unknown[0],'심각도 미보고 · 알 수 없는 엔진 진단 코드 (<b>new_code</b>'+'z'.repeat(49)+')','unknown code: fixed text, bounded code kept as text');
  assert.equal(unknown[1],'심각도 미보고 · 긴 After를 담으려고 이어지는 페이지가 필요했다고 보고됨 (pagination_required)');assert.match(unknown[2],/^정보 · 알 수 없는 엔진 진단 코드 \(__proto__\)/);
  assert.doesNotMatch(SOURCE,/innerHTML|insertAdjacentHTML|outerHTML/);});

test('engine source link and limits sit next to the engine metadata; unsafe or absent URLs render no link',async()=>{
  let w=world({...NEW,pdfEditor:{...EDITOR,limits:{maxEdits:12,maxTextChars:4000,maxFileBytes:26214400,other:9}}});await w.ready();const m=w.get('red-export-mode'),a=m.children.find(x=>typeof x!=='string'&&x.className==='red-engine-source');
  assert.ok(a,'engine source anchor');assert.equal(a.href,EDITOR.sourceUrl);assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');assert.equal(a.textContent,'엔진 소스');
  assert.match(text(m),/^PDF 편집 엔진 falsify-pdf-editor 0\.4\.1 \(엔진 소스\) · /);assert.match(text(m),/엔진 제한: 변경 최대 12개 · After 최대 4,000자 · 파일 최대 25 MB\./);assert.doesNotMatch(text(m),/other/);
  for(const sourceUrl of [null,'javascript:alert(1)','https://evil.example/Shinick-Han/x','https://github.com/Shinick-Han/x"><img>']){w=world({...NEW,pdfEditor:{...EDITOR,sourceUrl}});await w.ready();
    assert.equal(w.get('red-export-mode').children.some(x=>typeof x!=='string'&&x.className==='red-engine-source'),false,String(sourceUrl));assert.equal(w.calls.length,0,'nothing fetched');}});

// falsify.pdf-quality.v1: independent QA is its own label next to the same-engine self-check; only an exact consistent payload reads passed.
const QA=(status,checks,extra={})=>({...ACTUAL,independentQA:status,independentChecks:{schema:'falsify.pdf-quality.v1',status,method:'pdfjs-text-render',checks,limitations:['Bounded check only.'],...extra}});
const qaPart=w=>w.get('red-export-status').children.find(c=>c.className==='red-export-check red-export-qa');
const runQA=async v=>{const w=world(NEW);await w.ready();w.reply=ok(v);w.get('red-download').click();await flush();return w;};
test('independent QA: passed, warning and unavailable are distinct from the self-check and never claim full proof',async()=>{
  let w=await runQA(QA('passed',[{code:'text_extract',status:'passed',pages:[1,2]},{code:'render_nonblank',status:'passed',pages:[1,2,3,4]}]));
  const self=part(w,'red-export-check');assert.equal(text(self.children[0]),'같은 엔진 자체검사','self-check chip unchanged');assert.doesNotMatch(text(self),/대기 ·|미보고|독립 검사/);
  let q=qaPart(w);assert.equal(q.children[0].className,'status-label');assert.equal(q.children[0].textContent,'독립 검사 통과');
  assert.equal(text(q),'독립 검사 통과 제한된 독립 추출·렌더 검사 2항목 통과 (pdfjs-text-render). 전체 시각 품질·성능을 증명하지는 않습니다. 사람의 과학 검수는 아직 대기 중입니다.');
  assert.equal(w.downloads.length,1);assert.equal(w.get('red-export-status').classList.contains('error'),false);
  w=await runQA(QA('warning',[{code:'text_extract',status:'passed',pages:[1]},{code:'render_diff_high',status:'warning',pages:[3,3,4]},{code:'C:/Users/x/<b>secret</b>',status:'warning',pages:[2]}],{method:'C:/tools/qa.exe'}));
  q=qaPart(w);assert.equal(q.children[0].textContent,'독립 검사 주의');assert.match(text(q),/확인할 항목: render_diff_high 2쪽, 형식 외 코드 1쪽\. 다운로드는 그대로 진행했습니다\. 사람의 과학 검수는 아직 대기 중입니다\.$/);
  assert.doesNotMatch(w.status(),/C:\/|<b>|secret|qa\.exe|검사 통과|Bounded check/);assert.equal(w.downloads.length,1);assert.equal(w.get('red-export-status').classList.contains('error'),false);assert.equal(w.get('red-handoff').hidden,false,'warning still hands off');
  w=await runQA(QA('unavailable',[{code:'renderer_missing',status:'unavailable',pages:[]}]));q=qaPart(w);
  assert.equal(q.children[0].textContent,'독립 검사 미실행');assert.match(text(q),/이 환경에서 독립 추출·렌더 검사를 하지 못했습니다 \(renderer_missing\)\. 사람의 과학 검수는 아직 대기 중입니다\.$/);assert.equal(w.downloads.length,1);
  w=await runQA(ACTUAL);assert.equal(qaPart(w),undefined,'legacy pending keeps the self-check line');assert.match(text(part(w,'red-export-check')),/독립 추출\/렌더링·사람 검수 대기/);});

test('independent QA: unknown or malformed states never read passed',async()=>{
  const one=[{code:'a',status:'passed',pages:[1]}];
  for(const [label,v] of [['schema',QA('passed',one,{schema:'falsify.pdf-quality.v2'})],['status mismatch',{...QA('passed',one),independentChecks:QA('warning',one).independentChecks}],['passed with warning item',QA('passed',[{code:'a',status:'warning',pages:[1]}])],
      ['empty passed',QA('passed',[])],['zero page',QA('passed',[{code:'a',status:'passed',pages:[0]}])],['string page',QA('passed',[{code:'a',status:'passed',pages:['1']}])],['bad item status',QA('passed',[{code:'a',status:'ok',pages:[1]}])],
      ['checks object missing',{...ACTUAL,independentQA:'passed'}],['limitations not strings',QA('passed',one,{limitations:[1]})],['method missing',QA('passed',one,{method:undefined})],['warning with failed item is not warning',QA('warning',[{code:'a',status:'failed',pages:[1]}])]]){
    const w=await runQA(v);assert.equal(qaPart(w).children[0].textContent,'독립 검사 형식 확인 불가',label);assert.doesNotMatch(w.status(),/검사 통과|항목 통과/,label);assert.equal(w.downloads.length,1,label);}
  for(const s of ['PASSED','passed ',null,42]){const w=await runQA({...QA('passed',one),independentQA:s});assert.equal(qaPart(w),undefined,String(s));assert.match(w.status(),/독립 검수 상태 미보고/,String(s));assert.doesNotMatch(w.status(),/통과/,String(s));}});

test('independent QA failed never downloads even when the companion returns bytes; selection and After stay',async()=>{
  const cases=[['failed',QA('failed',[{code:'render_blank',status:'failed',pages:[2,5]},{code:'text_extract',status:'passed',pages:[1]}])],['checks failed under passed',{...QA('passed',[]),independentChecks:QA('failed',[]).independentChecks}],['failed without checks',{...ACTUAL,independentQA:'failed'}]];
  for(const [label,v] of cases){const w=await runQA(v);
    assert.match(w.status(),/^다운로드 차단: 독립 추출·렌더 검사가 실패로 보고되어 받은 파일을 다운로드하지 않았습니다\./,label);assert.doesNotMatch(w.status(),/다운로드했습니다/,label);
    assert.equal(w.downloads.length,0,label);assert.equal(w.get('red-handoff').hidden,true,label);assert.equal(w.handoffs.length,0,label);
    assert.equal(w.boxes()[1].checked,true,label);assert.equal(w.area(1).value,'in every cohort, including the untreated one',label);assert.equal(w.get('red-download').disabled,false,label);}
  const w=await runQA(cases[0][1]);assert.match(w.status(),/실패 항목: render_blank 2쪽\./);});

test('help states the reflow scope; status is a block container; footer source link has a >=12px, 24px target',()=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8'),css=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.css'),'utf8');
  assert.match(html,/1단·회전 없음·잘림 없음인 최상위 본문 텍스트뿐/);assert.match(html,/머리말·꼬리말 지원 여부는 연결된 엔진에 따라/);assert.match(html,/원본에 단독 아라비아 숫자 쪽번호가 있으면 추가 페이지는 그 번호에 소수 접미\(예: 10\.1\)를 붙입니다/);assert.doesNotMatch(html,/10\.1처럼/);assert.match(html,/독립 추출\/렌더링·사람 검수는 별도로 필요/);assert.doesNotMatch(html,/특이한 레이아웃에서는 재배치가 거부/);
  assert.match(html,/<div id="red-export-status" class="form-feedback" role="status" aria-live="polite"><\/div>/);
  assert.match(css,/\.page-foot \.source-link\{display:inline-flex;align-items:center;min-height:24px;font-size:12px\}/);assert.match(css,/\.red-export-outcome\{[^}]*font-size:14px[^}]*color:var\(--ink\)/);});

test('fail closed: new-engine export without layoutVerified === true never downloads or offers handoff',async()=>{
  const {layoutVerified,...unproven}=REFLOWED;void layoutVerified;
  const cases=[['undefined (field omitted)',unproven],['null',{...REFLOWED,layoutVerified:null}],['string "true"',{...REFLOWED,layoutVerified:'true'}],['1',{...REFLOWED,layoutVerified:1}],
    ['engine field missing in reflow mode',{...REFLOWED,engine:undefined}],['legacy-shaped verification from reflow mode',{mode:'pdf-original-font-single-line',pages:10}],['verification missing',undefined]];
  for(const [label,verification] of cases){const w=world(NEW);await w.ready();w.reply=ok(verification);w.get('red-download').click();await flush();
    assert.match(w.status(),/^다운로드 차단: 엔진이 이 출력의 레이아웃 검증 통과를 증명하지 않아 다운로드하지 않았습니다/,label);assert.doesNotMatch(w.status(),/다운로드했습니다|새 페이지|줄바꿈 재배치 \d/,label);
    assert.equal(w.downloads.length,0,label);assert.equal(w.get('red-handoff').hidden,true,label);assert.equal(w.handoffs.length,0,label);
    assert.equal(w.boxes()[1].checked,true,label);assert.equal(w.area(1).value,'in every cohort, including the untreated one',label);assert.equal(w.get('red-download').disabled,false,label);}
  const w=world(OLD);await w.ready();w.reply=ok({...REFLOWED,layoutVerified:null});w.get('red-download').click();await flush();
  assert.match(w.status(),/검증 통과를 증명하지 않아/,'engine claim is checked even on a legacy-mode broker');assert.equal(w.downloads.length,0);});

test('AGPL source link sits once in the shared footer, outside every tab view',()=>{const html=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8');
  const links=html.match(/<a\b[^>]*href="https:\/\/github\.com\/Shinick-Han\/falsify-workbench"[^>]*>[^<]*<\/a>/g)||[];assert.equal(links.length,1);
  assert.match(links[0],/AGPL-3\.0-only/);assert.match(links[0],/rel="noopener noreferrer"/);assert.match(links[0],/class="source-link"/);
  const foot=html.match(/<footer class="page-foot">[\s\S]*?<\/footer>/)[0],at=html.indexOf(foot),lastView=html.lastIndexOf('<section class="view',at);
  assert.ok(foot.includes(links[0]),'link lives in the footer');assert.ok(html.indexOf('</section>',lastView)<at,'footer is after the last view closes');
  assert.ok(html.indexOf('<div class="content">')<at&&html.indexOf('</main>')>at,'footer is in the shared content column');});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));})();
