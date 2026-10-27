'use strict';
// Node VM contract for the optional single-occurrence image replacement: strict core schemas, bridge route/descriptor, and the RED-owned panel's
// binding, freeze, stale and download rules. Synthetic DOM, mocked bridge/ledger/broker; no browser, network, CLI, model or private PDF access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),nodeCrypto=require('node:crypto');
const C=require('../dist/document-red-core.js'),I=require('../dist/image-editor-core.js'),L=require('../dist/local-bridge.js');
const dist=path.resolve(__dirname,'../dist'),read=f=>fs.readFileSync(path.join(dist,f),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const sha=b=>nodeCrypto.createHash('sha256').update(b).digest('hex'),clone=x=>JSON.parse(JSON.stringify(x));
const text=e=>typeof e==='string'?e:(e.textContent||'')+e.children.map(text).join('');
const SEG0='The trial shows a modest benefit in adults.',SEG1='Effects were observed only in the treated cohort.';
const SRC=Buffer.from('%PDF-1.7 synthetic image fixture'),OUT=Buffer.from('%PDF-1.7 synthetic image output'),OTHER=Buffer.from('%PDF-1.7 another source'),HASH=sha(SRC);
const DESCRIPTOR={available:true,schema:'falsify.image-list.v1'},CAP={red:true,blue:true,pdf:true,imageEditor:DESCRIPTOR};
// Header-only PNG: signature + IHDR (enough for the preflight; never decoded here).
function png(w,h,colour=2,extra=0){const b=Buffer.alloc(33+extra);Buffer.from([137,80,78,71,13,10,26,10]).copy(b,0);b.writeUInt32BE(13,8);b.write('IHDR',12,'latin1');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);b[24]=8;b[25]=colour;return b;}
const THUMB=png(160,80).toString('base64'),ID=[sha('a'),sha('b'),sha('c')];
const occ=(i,over={})=>({id:ID[i],pageIndex:i,bbox:[72,100,272,200],width:400,height:200,shared:false,editable:true,reason:null,thumbnail:THUMB,...over});
const listing=(over={})=>({schema:'falsify.image-list.v1',sourceSha256:HASH,complete:true,occurrences:[occ(0),occ(1,{shared:true}),occ(2,{editable:false,reason:'form-image',thumbnail:null})],limits:['single-occurrence','manual-image','text-only-blue'],...over});
const exported=(over={},report={})=>({schema:'falsify.image-export.v1',sourceSha256:HASH,occurrenceId:ID[0],outputSha256:sha(OUT),filename:'falsify-image-experiment.pdf',file:OUT.toString('base64'),
  report:{schema:'falsify.image-edit-report.v1',sourceSha256:HASH,occurrenceId:ID[0],outputSha256:sha(OUT),pageIndex:0,bbox:[72,100,272,200],changedOccurrences:1,check:'passed',limits:['engine-render-check','domain-review-pending','text-only-blue'],...report},...over});
const flush=async(n=30)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const until=async(cond,label)=>{for(let i=0;i<400&&!cond();i++)await new Promise(r=>setTimeout(r,5));assert.ok(cond(),label);};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const INJECT='<img src=x onerror=alert(1)> The trial shows C:/Users/secret/paper.pdf';

test('core: list request has fixed keys; exact listing passes and every shape, bound, reason or thumbnail deviation is refused with fixed copy',()=>{
  assert.equal(I.DEADLINE_MS,95000);const r=I.listRequest(HASH,SRC.toString('base64'));assert.deepEqual(Object.keys(r),['schema','fileHash','file']);assert.equal(r.schema,'falsify.image-list-request.v1');
  for(const bad of ['x',HASH.toUpperCase(),null])assert.throws(()=>I.listRequest(bad,'QUJD'),/원본 PDF/);assert.throws(()=>I.listRequest(HASH,'QUJ'),/원본 PDF/);assert.throws(()=>I.listRequest(HASH,'QUJE='),/원본 PDF/,'non-canonical padding bits');
  const v=I.list(listing(),{sourceSha256:HASH});assert.equal(v.occurrences.length,3);assert.equal(Object.isFrozen(v.occurrences[0].bbox),true);assert.equal(v.occurrences[2].reason,'form-image');
  assert.throws(()=>I.list(listing(),{sourceSha256:sha(OTHER)}),/현재 원본 PDF와 맞지 않아/);
  const big=png(321,10).toString('base64'),large=png(10,10,2,300*1024).toString('base64');
  const AB='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',padded=png(160,80,2,1).toString('base64'),at=padded.length-3,loose=padded.slice(0,at)+AB[AB.indexOf(padded[at])|1]+'==';
  assert.ok(padded.endsWith('==')&&loose!==padded);assert.equal(I.list(listing({occurrences:[occ(0,{thumbnail:padded})]}),{sourceSha256:HASH}).occurrences[0].thumbnail,padded);
  const mutations=[o=>{o.extra=INJECT;},o=>{delete o.limits;},o=>{o.schema='falsify.image-list.v2';},o=>{o.complete='yes';},o=>{o.limits.reverse();},o=>{o.limits.push(INJECT);},o=>{o.occurrences=null;},
    o=>{o.occurrences=Array.from({length:257},(_,i)=>occ(0,{id:sha('n'+i),pageIndex:0}));},o=>{o.occurrences[1].id=ID[0];},o=>{o.occurrences[0].id='ABC';},o=>{o.occurrences[0].pageIndex=64;},o=>{o.occurrences[0].pageIndex=-1;},o=>{o.occurrences[0].pageIndex=1.5;},
    o=>{o.occurrences[0].bbox=[272,100,72,200];},o=>{o.occurrences[0].bbox=[0,0,1];},o=>{o.occurrences[0].bbox=[0,0,'1',2];},o=>{o.occurrences[0].bbox=[0,0,1e9,2];},o=>{o.occurrences[0].width=0;},o=>{o.occurrences[0].height=1048577;},
    o=>{o.occurrences[0].shared=1;},o=>{o.occurrences[0].reason='form-image';},o=>{o.occurrences[2].reason=null;},o=>{o.occurrences[2].reason=INJECT;},o=>{o.occurrences[2].reason='toString';},o=>{o.occurrences[0].xref=12;},o=>{o.occurrences[0].text=INJECT;},
    o=>{o.occurrences[0].thumbnail='not base64!';},o=>{o.occurrences[0].thumbnail=Buffer.from('GIF89a'+'x'.repeat(40)).toString('base64');},o=>{o.occurrences[0].thumbnail=big;},o=>{o.occurrences[0].thumbnail=large;},o=>{o.occurrences[0].thumbnail=loose;}];
  for(const [i,m] of mutations.entries()){const bad=clone(listing());m(bad);let e;try{I.list(bad,{sourceSha256:HASH});}catch(x){e=x;}assert.ok(e,'mutation '+i);assert.equal(e.image,true,'mutation '+i);assert.ok(!/img|trial|secret/.test(e.message),'mutation '+i);}
  for(const bad of [null,[],'x',42])assert.throws(()=>I.list(bad,{sourceSha256:HASH}),/형식/);
  assert.deepEqual(Object.keys(I.REASONS).sort(),['clipped-image','cropped-page','dependency-unavailable','form-image','inline-image','malformed-pdf','overlapping-content','rotated-page','scan-limit','transparency','unsupported-transform']);});

test('core: PNG preflight refuses size, header, side and pixel limits before decoding',()=>{
  assert.deepEqual({...I.png(new Uint8Array(png(2000,2000)))},{width:2000,height:2000,alpha:false});assert.equal(I.png(new Uint8Array(png(10,10,6))).alpha,true);
  assert.throws(()=>I.png(new Uint8Array(4*1024*1024+1)),/4 MiB/);assert.throws(()=>I.png(new Uint8Array(Buffer.from('GIF89a'.padEnd(40,'x')))),/IHDR/);
  const wrong=png(10,10);wrong.write('IDAT',12,'latin1');assert.throws(()=>I.png(new Uint8Array(wrong)),/IHDR/);const depth=png(10,10);depth[24]=3;assert.throws(()=>I.png(new Uint8Array(depth)),/IHDR/);
  assert.throws(()=>I.png(new Uint8Array(png(8193,10))),/8192/);assert.throws(()=>I.png(new Uint8Array(png(2001,2000))),/400만/);assert.throws(()=>I.png(new Uint8Array(png(0,10))),/IHDR/);});

test('core: a real transparent RGBA PNG passes preflight and stays byte-identical in the export request',()=>{
  const encoded='iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DQwMDwnwEADH8Cf4i6MZwAAAAASUVORK5CYII=';
  assert.deepEqual({...I.png(new Uint8Array(Buffer.from(encoded,'base64')))},{width:2,height:1,alpha:true});
  assert.equal(I.exportRequest(HASH,SRC.toString('base64'),ID[0],encoded).replacement,encoded);
});

test('core: export request carries only the selected id; export result is bound to source, id, page, box and output hash',()=>{
  const r=I.exportRequest(HASH,SRC.toString('base64'),ID[0],THUMB);assert.deepEqual(Object.keys(r),['schema','fileHash','file','occurrenceId','replacement','consent']);assert.equal(r.consent,true);assert.equal(r.schema,'falsify.image-export-request.v1');
  assert.throws(()=>I.exportRequest(HASH,SRC.toString('base64'),'c1',THUMB),/요청하지 않았습니다/);
  const o=I.list(listing(),{sourceSha256:HASH}).occurrences[0],v=I.exportResult(exported(),{sourceSha256:HASH,occurrence:o});
  assert.equal(Buffer.from(v.bytes).toString(),OUT.toString());assert.equal(v.filename,'falsify-image-experiment.pdf');assert.deepEqual(Object.keys(v.report),['schema','sourceSha256','occurrenceId','outputSha256','pageIndex','bbox','changedOccurrences','check','limits']);
  const cases=[[{extra:INJECT}],[{filename:'paper.pdf'}],[{sourceSha256:sha(OTHER)},{sourceSha256:sha(OTHER)}],[{occurrenceId:ID[1]},{occurrenceId:ID[1]}],[{outputSha256:HASH},{outputSha256:HASH}],[{file:Buffer.from('<html>').toString('base64')}],[{file:'%%%'}],
    [{},{pageIndex:1}],[{},{bbox:[72,100,272,201]}],[{},{changedOccurrences:2}],[{},{check:'failed'}],[{},{limits:['engine-render-check']}],[{},{outputSha256:sha(SRC.toString()+'x')}],[{},{sourceSha256:sha(OTHER)}],[{},{raw:INJECT}],[{report:null}]];
  for(const [i,[top,rep]] of cases.entries()){let e;try{I.exportResult(exported(top,rep),{sourceSha256:HASH,occurrence:o});}catch(x){e=x;}assert.ok(e,'case '+i);assert.equal(e.image,true,'case '+i);assert.ok(!/img|trial|secret/.test(e.message),'case '+i);}});

test('bridge: only the two image routes are added; descriptor is exact-or-absent; old brokers keep every other capability',async()=>{
  assert.deepEqual({...L.imageEditor(DESCRIPTOR)},DESCRIPTOR);
  for(const bad of [null,[],true,{available:'yes',schema:DESCRIPTOR.schema},{available:true,schema:'falsify.image-list.v2'},{available:true},{...DESCRIPTOR,engine:'mupdf'}])assert.equal(L.imageEditor(bad),null,JSON.stringify(bad));
  const TOKEN='Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789',calls=[];
  const boot=async caps=>{const b=L.create({fetch:async(url,init)=>{calls.push({url,init});return {ok:true,status:200,redirected:false,json:async()=>url==='/api/session'?{token:TOKEN}:caps};},location:{hostname:'127.0.0.1',port:'7816'}});await b.ready;return b;};
  const fresh=await boot(CAP),legacy=await boot({red:true,blue:true,pdf:true});assert.deepEqual({...fresh.capabilities().imageEditor},DESCRIPTOR);assert.equal(legacy.capabilities().imageEditor,null);assert.equal(legacy.capabilities().red,true);
  const s=fresh.session();for(const p of ['/api/paper/images/x','/api/paper/images/export/1','/api/paper/image','/api/paper/images?path=C:/x','/api/paper/images/../session'])await assert.rejects(s.request(p,{}),/허용되지 않은/,p);
  for(const p of ['/api/paper/images','/api/paper/images/export','/api/paper/inspect']){await s.request(p,{schema:'x'});assert.equal(calls.at(-1).url,p);}});

function element(id){
  const e=new EventTarget(),classes=new Set(),attrs={};
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],className:'',src:'',alt:'',files:null,style:{},
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    removeAttribute(n){if(n==='src')this.src='';attrs[n]=undefined;},replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
function world(cap=CAP){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);},created=[],downloads=[],calls=[],events=[],labBusy=[],timers=[],revoked=[];
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:tag=>{const e=element('');e.tag=tag;created.push(e);return e;},body:element('body')});
  get('red-level').value='1';get('red-budget').value='4';get('document-red').hidden=true;get('image-edit').hidden=true;
  let reply=async()=>{throw new Error('no broker reply configured');},connected=true;
  const lab={busy(role,v){if(role==='red')labBusy.push(!!v);},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busyCalls:[],busy(role,v){if(role==='red')bridge.busyCalls.push(!!v);},state:()=>({status:connected?'paired':'manual',connected,cap:connected?cap:null}),capabilities:()=>connected?cap:null,
    session:()=>connected?{request:(p,body,options)=>{calls.push({path:p,body,options});return Promise.resolve().then(()=>reply(p,body,options));}}:null};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL:u=>revoked.push(u)};
  const fakeSetTimeout=(fn,ms)=>{if(ms>=60000){timers.push({fn,ms,live:true});return 'deadline-'+(timers.length-1);}return setTimeout(fn,ms);};
  const fakeClearTimeout=id=>{if(typeof id==='string'&&id.startsWith('deadline-'))timers[Number(id.slice(9))].live=false;else clearTimeout(id);};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentRed:C,FalsifyHarness:require('../dist/harness-core.js'),FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{textFile:async(file,patches)=>({bytes:new TextEncoder().encode('edited text'),verification:null})},
    TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout:fakeSetTimeout,clearTimeout:fakeClearTimeout,AbortController,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,Set,JSON,Number,String,Object,Math});
  for(const f of ['image-editor-core.js','image-editor.js','document-red.js'])vm.runInContext(read(f),ctx,{filename:f});
  for(const type of ['falsify:blue-file','falsify:blue-document'])document.addEventListener(type,()=>events.push(type));
  const fire=(type,detail)=>document.dispatchEvent(new CustomEvent(type,{cancelable:true,detail}));
  const w={get,created,downloads,calls,events,labBusy,timers,revoked,bridge,fire,set reply(f){reply=f;},set connected(v){connected=v;},
    status:()=>text(get('image-status')),exportStatus:()=>text(get('image-export-status')),
    async load(format='PDF',bytes=SRC){fire('falsify:document',{file:{name:'paper.'+format.toLowerCase(),type:'application/pdf',size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes).buffer},result:{text:SEG0+'\n'+SEG1,format,segments:[{label:'PDF p. 1',text:SEG0},{label:'PDF p. 2',text:SEG1}]}});
      await until(()=>!get('document-red').hidden,'document bound');await until(()=>!get('red-request').disabled,'binding released');await flush();},
    radios:()=>created.filter(e=>e.type==='radio'),
    async list(res=listing()){reply=async p=>{assert.equal(p,'/api/paper/images');return res;};get('image-list').click();await until(()=>!get('image-occurrences').hidden||/형식|실패|맞지/.test(w.status()),'list done');await flush();},
    pick(i){const r=w.radios()[i];r.checked=true;r.dispatchEvent(new Event('change'));},
    async png(bytes=png(400,200),name='replacement.png',size){const input=get('image-png');input.files=[{name,size:size??bytes.length,type:'image/png',arrayBuffer:async()=>new Uint8Array(bytes).buffer}];input.dispatchEvent(new Event('change'));await flush();},
    consent(){const c=get('image-consent');c.checked=true;c.dispatchEvent(new Event('change'));},
    async exportWith(res=exported()){reply=async p=>{assert.equal(p,'/api/paper/images/export');return res;};get('image-export').click();await until(()=>w.exportStatus()&&!/하는 중/.test(w.exportStatus()),'export done');await flush();},
    async ready(){await w.load();await w.list();w.pick(0);await w.png();w.consent();}};
  return w;
}

test('panel: no request on load, upload or RED candidate import; PDF-only; old, off or missing broker disables with help',async()=>{
  const w=world();await w.load();assert.equal(w.calls.length,0,'no auto-fetch on upload');assert.equal(w.get('image-edit').hidden,false);assert.equal(w.get('image-list').disabled,false);assert.match(text(w.get('image-note')),/파일을 올리기만 해서는 요청하지 않습니다/);
  w.get('red-request').click();await flush();assert.equal(w.calls.length,0);assert.deepEqual(w.events,[],'no BLUE input');
  const txt=world();await txt.load('TXT');assert.equal(txt.get('image-edit').hidden,true);txt.get('image-list').click();await flush();assert.equal(txt.calls.length,0);
  const old=world({red:true,blue:true,pdf:true});await old.load();assert.equal(old.get('image-list').disabled,true);assert.match(text(old.get('image-note')),/지원하지 않습니다\(구버전\).*업데이트/);old.get('image-list').click();await flush();assert.equal(old.calls.length,0);
  const off=world({...CAP,imageEditor:{...DESCRIPTOR,available:false}});await off.load();assert.equal(off.get('image-list').disabled,true);assert.match(text(off.get('image-note')),/엔진이 준비되지 않았습니다/);
  const none=world();none.connected=false;await none.load();assert.equal(none.get('image-list').disabled,true);assert.match(text(none.get('image-note')),/연결된 로컬 companion이 필요합니다/);assert.equal(none.get('red-request').disabled,false);});

test('panel: explicit list renders native rows with fixed reasons; export sends only the selected id and downloads PDF and report separately',async()=>{
  const w=world();await w.load();await w.list();const first=w.calls[0];assert.deepEqual(Object.keys(first.body),['schema','fileHash','file']);assert.equal(first.body.fileHash,HASH);assert.equal(first.body.file,SRC.toString('base64'));
  assert.equal(w.radios().length,3);assert.equal(w.radios()[2].disabled,true,'unsupported row is not selectable');assert.match(text(w.get('image-rows')),/교체 불가 · Form XObject 안에 그려진 그림/);assert.match(text(w.get('image-rows')),/이 위치만 교체합니다/);
  assert.match(w.status(),/그림 위치 3곳 · 교체 가능 2곳/);assert.ok(w.created.filter(e=>e.tag==='img').every(i=>i.alt&&i.src.startsWith('data:image/png;base64,')),'thumbnails are data: PNG with alt');
  assert.equal(w.get('image-replace').hidden,true);w.pick(0);assert.equal(w.get('image-replace').hidden,false);assert.match(w.get('image-before').alt,/교체 전 그림 미리보기 · p\. 1/);assert.equal(w.get('image-export').disabled,true,'needs PNG and consent');
  await w.png(png(300,300));assert.match(w.get('image-after').src,/^data:image\/png;base64,/);assert.match(text(w.get('image-stretch')),/^주의: PNG 비율\(300×300 px\)이 원래 상자 비율과 달라/);
  await w.png();assert.doesNotMatch(text(w.get('image-stretch')),/주의/);assert.match(text(w.get('image-stretch')),/원래 상자\(같은 쪽·같은 위치·같은 크기\)를 그대로 채웁니다/);
  assert.equal(w.get('image-export').disabled,true);w.consent();assert.equal(w.get('image-export').disabled,false);
  await w.exportWith();const body=w.calls[1].body;assert.deepEqual(Object.keys(body),['schema','fileHash','file','occurrenceId','replacement','consent']);assert.equal(body.occurrenceId,ID[0]);assert.equal(body.replacement,png(400,200).toString('base64'));
  assert.ok(!JSON.stringify(body).includes(ID[1])&&!JSON.stringify(body).includes('bbox'),'only the selected id, no client geometry');
  assert.match(w.exportStatus(),/교체한 실험용 PDF를 만들었습니다 · 바뀐 그림 1곳 · 엔진 자체 렌더 검사 통과/);assert.match(text(w.get('image-result-hash')),new RegExp(sha(OUT)));assert.equal(w.downloads.length,0,'no automatic download');
  w.get('image-download-pdf').click();await until(()=>w.downloads.length===1,'pdf download');assert.equal(Buffer.from(await w.downloads[0].arrayBuffer()).toString(),OUT.toString());assert.equal(w.created.filter(e=>e.tag==='a').at(-1).download,'falsify-image-experiment.pdf');
  w.get('image-download-report').click();await until(()=>w.downloads.length===2,'report download');const rep=JSON.parse(await w.downloads[1].text());assert.equal(rep.outputSha256,sha(OUT));assert.equal(rep.check,'passed');assert.equal(w.created.filter(e=>e.tag==='a').at(-1).download,'falsify-image-edit-report.json');
  assert.deepEqual(w.events,[],'no BLUE handoff');assert.equal(w.get('red-handoff').hidden,true,'text handoff untouched');assert.deepEqual(w.calls.map(c=>c.path),['/api/paper/images','/api/paper/images/export']);});

test('panel: forged listings and exports cannot inject raw text; broker error text is never echoed; output hash mismatch never downloads',async()=>{
  for(const forged of [{...listing(),raw:INJECT},listing({sourceSha256:sha(OTHER)}),listing({occurrences:[occ(0,{reason:INJECT,editable:false})]})]){
    const w=world();await w.load();await w.list(forged);assert.match(w.status(),/형식과 달라|맞지 않아/);assert.equal(w.radios().length,0);assert.ok(!/img|trial|secret/.test(w.status()));}
  const failing=world();await failing.load();failing.reply=async()=>{throw new Error(INJECT);};failing.get('image-list').click();await until(()=>!/찾는 중/.test(failing.status()),'list failed');assert.match(failing.status(),/^요청이 실패했습니다/);assert.ok(!/img|trial|secret/.test(failing.status()));
  const coded=world();await coded.ready();coded.reply=async()=>{throw Object.assign(new Error(INJECT),{code:'image_edit_rejected',reason:'transparency'});};coded.get('image-export').click();await until(()=>!/하는 중/.test(coded.exportStatus()),'export refused');
  assert.match(coded.exportStatus(),/^이 그림을 교체하지 못했습니다: 투명도가 있는 그림이라 지원하지 않음\. 목록에서 교체 가능한 다른 위치를 고르세요\./);assert.ok(!/img|trial|secret/.test(coded.exportStatus()));
  const bare=world();await bare.ready();bare.reply=async()=>{throw new Error('transparency');};bare.get('image-export').click();await until(()=>!/하는 중/.test(bare.exportStatus()),'export failed');assert.match(bare.exportStatus(),/^요청이 실패했습니다/,'error message text is never interpreted as a reason');
  const mismatch=world();await mismatch.ready();const lie=exported({file:Buffer.from('%PDF-1.7 different bytes').toString('base64')});await mismatch.exportWith(lie);
  assert.match(mismatch.exportStatus(),/보고한 출력 해시와 받은 파일이 달라/);assert.equal(mismatch.get('image-result').hidden,true);mismatch.get('image-download-pdf').click();await flush();assert.equal(mismatch.downloads.length,0);
  const wrongBox=world();await wrongBox.ready();await wrongBox.exportWith(exported({},{bbox:[0,0,10,10]}));assert.match(wrongBox.exportStatus(),/쪽·상자가 선택한 그림과 맞지 않아/);assert.equal(wrongBox.downloads.length,0);
  for(const f of ['image-editor.js','image-editor-core.js'])assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(read(f)),f);});

test('panel: list/export freeze RED, harness and bridge; no overlapping requests; release afterwards',async()=>{
  const w=world();await w.load();const d=deferred();w.reply=()=>d.promise;w.get('image-list').click();await until(()=>w.calls.length===1,'list requested');
  assert.equal(w.bridge.busyCalls.at(-1),true);assert.equal(w.labBusy.at(-1),true);for(const id of ['image-list','red-start','red-request','red-import-response','red-level','red-budget'])assert.equal(w.get(id).disabled,true,id);
  w.get('image-list').click();await flush();assert.equal(w.calls.length,1,'no double submission');assert.equal(w.timers.filter(t=>t.live).length,1);assert.equal(w.timers[0].ms,95000);
  d.resolve(listing());await until(()=>w.bridge.busyCalls.at(-1)===false,'released');assert.equal(w.labBusy.at(-1),false);assert.equal(w.get('image-list').disabled,false);assert.equal(w.timers.filter(t=>t.live).length,0,'deadline cleared');
  w.pick(0);await w.png();w.consent();const d2=deferred();w.reply=()=>d2.promise;w.get('image-export').click();await until(()=>w.calls.length===2,'export requested');
  for(const id of ['image-export','image-png','image-consent','image-list'])assert.equal(w.get(id).disabled,true,id);assert.equal(w.radios()[1].disabled,true,'selection frozen');assert.equal(w.bridge.busyCalls.at(-1),true);
  d2.resolve(exported());await until(()=>!w.get('image-result').hidden,'result');assert.equal(w.bridge.busyCalls.at(-1),false);
  // RED busy elsewhere (e.g. pre-analysis/export) disables the image actions without owning them.
  const r=world();await r.load();r.reply=()=>new Promise(()=>{});r.get('red-start').disabled=false;r.get('red-consent').checked=true;r.get('red-consent').dispatchEvent(new Event('change'));r.get('red-start').click();await flush();
  assert.equal(r.get('image-list').disabled,true,'RED run locks the image list');r.get('image-list').click();await flush();assert.ok(r.calls.every(c=>c.path!=='/api/paper/images'));});

test('panel: 95 s deadline aborts, releases busy, keeps source, selection and PNG, and does not retry',async()=>{
  const w=world();await w.ready();let signal=null;w.reply=(p,b,o)=>new Promise((_,reject)=>{signal=o.signal;signal.addEventListener('abort',()=>reject(new Error(INJECT)));});w.get('image-export').click();await until(()=>signal,'export requested');
  assert.equal(w.bridge.busyCalls.at(-1),true);const timer=w.timers.find(t=>t.live);assert.equal(timer.ms,95000);timer.fn();await flush();
  assert.equal(signal.aborted,true);assert.match(w.exportStatus(),/95초 안에 끝나지 않아 중단했습니다/);assert.ok(!/img|secret/.test(w.exportStatus()));assert.equal(w.get('image-export-status').classList.contains('error'),true);
  assert.equal(w.bridge.busyCalls.at(-1),false);assert.equal(w.labBusy.at(-1),false);assert.equal(w.radios()[0].checked,true);assert.match(w.get('image-after').src,/^data:image\/png/);assert.equal(w.get('image-export').disabled,false);
  await flush();assert.equal(w.calls.length,2,'no automatic retry');});

test('panel: source clear or replacement cancels pending requests and discards stale responses; selection/PNG changes clear output',async()=>{
  const replaced=world();await replaced.load();const d=deferred();let signal=null;replaced.reply=(p,b,o)=>{signal=o.signal;return d.promise;};replaced.get('image-list').click();await until(()=>signal,'list requested');
  await replaced.load('PDF',OTHER);assert.equal(signal.aborted,true);d.resolve(listing());await flush();assert.equal(replaced.radios().length,0);assert.equal(replaced.get('image-occurrences').hidden,true);assert.equal(replaced.bridge.busyCalls.at(-1),false);
  const cleared=world();await cleared.ready();const d2=deferred();cleared.reply=()=>d2.promise;cleared.get('image-export').click();await until(()=>cleared.calls.length===2,'export requested');cleared.fire('falsify:document-clear');d2.resolve(exported());await flush();
  assert.equal(cleared.get('image-edit').hidden,true);assert.equal(cleared.get('image-result').hidden,true);assert.equal(cleared.downloads.length,0);assert.equal(cleared.bridge.busyCalls.at(-1),false);
  const w=world();await w.ready();await w.exportWith();assert.equal(w.get('image-result').hidden,false);w.pick(1);assert.equal(w.get('image-result').hidden,true,'selection change clears output');w.get('image-download-pdf').click();await flush();assert.equal(w.downloads.length,0);
  w.consent();await w.exportWith(exported({occurrenceId:ID[1]},{occurrenceId:ID[1],pageIndex:1}));assert.equal(w.get('image-result').hidden,false);await w.png(png(800,400));assert.equal(w.get('image-result').hidden,true,'PNG change clears output');
  // Unrelated RED text settings keep the bound list and selection.
  w.get('red-level').value='2';w.get('red-level').dispatchEvent(new Event('change'));assert.equal(w.radios()[1].checked,true);assert.equal(w.get('image-occurrences').hidden,false);
  // A source file whose bytes changed after binding is refused before any request.
  const swapped=world();await swapped.load();let calls=0;swapped.fire('falsify:document',{file:{name:'paper.pdf',size:SRC.length,arrayBuffer:async()=>(calls++?new Uint8Array(OTHER):new Uint8Array(SRC)).buffer},result:{text:SEG0,format:'PDF',segments:[{label:'PDF p. 1',text:SEG0}]}});
  await until(()=>!swapped.get('red-request').disabled,'bound');swapped.reply=async()=>listing();swapped.get('image-list').click();await until(()=>/원본 파일이 올린 뒤 바뀌어/.test(swapped.status()),'hash refusal');assert.match(swapped.status(),/원본 파일이 올린 뒤 바뀌어/);assert.equal(swapped.calls.length,0);});

test('panel: Before and After share one source-box preview frame; a small or mismatched PNG is stretched into it like the export; clear resets it',async()=>{
  const geo=e=>({width:e.style.width,aspectRatio:e.style.aspectRatio,height:e.style.height,objectFit:e.style.objectFit,maxHeight:e.style.maxHeight});
  const FRAME={width:'min(100%, 320px)',aspectRatio:'200 / 100',height:'auto',objectFit:'fill',maxHeight:'320px'},NONE={width:'',aspectRatio:'',height:'',objectFit:'',maxHeight:''};
  const w=world();await w.load();await w.list(listing({occurrences:[occ(0),occ(1,{bbox:[0,0,50,200]}),occ(2,{bbox:[0,0,1000,10]})]}));w.pick(0);
  const before=w.get('image-before'),after=w.get('image-after');assert.deepEqual(geo(before),FRAME,'160 px source thumbnail framed by the 2:1 box');
  await w.png(png(96,48));assert.equal(after.hidden,false);assert.deepEqual(geo(after),geo(before),'a 96 px PNG previews at the same extent as the source thumbnail');
  await w.png(png(300,300));assert.match(text(w.get('image-stretch')),/^주의: PNG 비율\(300×300 px\)/);assert.deepEqual(geo(after),FRAME,'mismatched PNG takes the box ratio, stretched like the export');
  w.pick(1);assert.deepEqual(geo(before),{...FRAME,width:'min(100%, 80px)',aspectRatio:'50 / 200'},'tall box: 320 px long side');assert.deepEqual(geo(after),geo(before),'After follows the new selection');
  w.pick(2);assert.deepEqual(geo(before),{...FRAME,aspectRatio:'1000 / 10'},'wide box keeps its ratio within 320 px');assert.deepEqual(geo(after),geo(before));
  w.fire('falsify:document-clear');await flush();for(const e of [before,after]){assert.deepEqual(geo(e),NONE,'clear drops the stale frame');assert.equal(e.src,'');assert.equal(e.hidden,true);}});

test('panel: large or malformed PNG is refused before decode or preview; consent is required',async()=>{
  const w=world();await w.load();await w.list();w.pick(0);
  await w.png(png(10,10),'big.png',4*1024*1024+1);assert.match(text(w.get('image-png-status')),/4 MiB/);assert.equal(w.get('image-after').src,'');assert.equal(w.get('image-export').disabled,true);
  await w.png(png(9000,10));assert.match(text(w.get('image-png-status')),/8192/);assert.equal(w.get('image-after').src,'');
  await w.png(png(4000,1001));assert.match(text(w.get('image-png-status')),/400만/);assert.equal(w.get('image-after').src,'');
  await w.png(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));assert.match(text(w.get('image-png-status')),/IHDR/);assert.equal(w.get('image-after').src,'');
  await w.png();assert.equal(w.get('image-export').disabled,true,'consent still required');w.get('image-export').click();await flush();assert.equal(w.calls.length,1);});

test('panel: the separate text export and BLUE handoff are unaffected by image operations',async()=>{
  const w=world();await w.load();w.get('red-request').click();await flush();const r=JSON.parse(await w.downloads.pop().text());
  const cand=(id,seg,before,after,quote)=>({id,segmentId:seg,level:1,before,after,rationale:'Synthetic contradiction.',evidence:[{segmentId:seg,quote,relation:'Synthetic relation.'}],uncertainty:'Domain review required.'});
  w.get('red-response').value=JSON.stringify({schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status:'ok',candidates:[cand('c1','s1','only in the treated cohort','in every cohort',SEG1)]});w.get('red-import-response').click();await flush();
  const box=w.created.find(e=>e.type==='checkbox');box.checked=true;box.dispatchEvent(new Event('change'));w.get('red-export-consent').checked=true;w.get('red-export-consent').dispatchEvent(new Event('change'));
  w.reply=async()=>({file:OUT.toString('base64'),outputFileHash:sha(OUT),verification:{mode:'pdf-original-font-single-line',pages:2}});w.get('red-download').click();
  await until(()=>w.get('red-handoff').hidden===false,'text export ready');const before=w.downloads.length;
  await w.list();w.pick(0);await w.png();w.consent();await w.exportWith();assert.equal(w.get('image-result').hidden,false);
  assert.equal(w.get('red-handoff').hidden,false,'text export and handoff survive the image operation');assert.equal(w.downloads.length,before,'image export downloads nothing by itself');assert.deepEqual(w.events,[]);
  w.get('image-download-pdf').click();await until(()=>w.downloads.length===before+1,'image pdf');assert.equal(w.get('red-handoff').hidden,false);});

test('page: image modules load before RED, CSS is linked, the disclosure sits in the RED execute step outside pre-analysis',()=>{
  const html=read('index.html'),order=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]);
  assert.ok(order.indexOf('image-editor-core.js')>=0&&order.indexOf('image-editor-core.js')<order.indexOf('image-editor.js')&&order.indexOf('image-editor.js')<order.indexOf('document-red.js'));
  assert.match(html,/<link rel="stylesheet" href="image-editor\.css(?:\?v=[^"]+)?">/);const csp=html.match(/Content-Security-Policy" content="([^"]+)"/)[1];assert.match(csp,/img-src 'self' data:;/,'CSP unchanged: previews are data: URLs');
  const panel=html.match(/<details class="red-help image-edit" id="image-edit" hidden>[\s\S]*?<\/details>/)?.[0];assert.ok(panel);
  assert.ok(html.indexOf('id="red-analysis"')<html.indexOf('id="image-edit"')&&html.indexOf('id="image-edit"')<html.indexOf('id="red-level"'));assert.ok(!html.match(/<div class="red-analysis"[\s\S]*?<\/details><\/div>/)[0].includes('image-'));
  for(const id of ['image-list','image-status','image-png','image-before','image-after','image-consent','image-export','image-download-pdf','image-download-report'])assert.ok(panel.includes('id="'+id+'"'),id);
  assert.match(panel,/BLUE는 현재 사본의 텍스트만 읽습니다/);assert.match(panel,/RED 모델 성능이나 과학적 타당성 판정이 아니며/);assert.match(panel,/원본 파일은 바뀌지 않습니다/);assert.match(panel,/단순한 Form 안의 불투명 그림은 한 곳만 바꿀 수 있습니다/);assert.match(panel,/인라인 그림·잘림\(clip\)·회전·투명도·복잡한 합성은 지원하지 않습니다/);
  assert.match(panel,/id="image-status" class="form-feedback" role="status" aria-live="polite"/);assert.ok(!/document-blue|blue-file/.test(panel));
  // Static CSS inspection is line-ending neutral: a Windows checkout may hold CRLF.
  const css=read('image-editor.css');assert.match(css,/@media\(max-width:700px\)\{\r?\n\.image-compare\{grid-template-columns:1fr/);});

// A real bridge session whose non-session/capability replies come from one fixed refusal; returns the rejection of one request.
async function refused(p,status,body){
  const b=L.create({fetch:async url=>url==='/api/session'?{ok:true,status:200,redirected:false,json:async()=>({token:'Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789'})}
    :url==='/api/capabilities'?{ok:true,status:200,redirected:false,json:async()=>CAP}:{ok:false,status,redirected:false,json:async()=>body},location:{hostname:'127.0.0.1',port:'7816'}});
  await b.ready;let e;try{await b.session().request(p,{schema:'x'});}catch(x){e=x;}assert.ok(e,p);return e;}

test('core: source bounds equal the companion service limits (100000 pt, 2^20 px); export-only reasons never pass as list entries',()=>{
  const one=over=>I.list(listing({occurrences:[occ(0,over)]}),{sourceSha256:HASH}).occurrences[0];
  assert.equal(I.MAX_COORD,100000);assert.equal(I.MAX_SOURCE_SIDE,1048576);
  assert.equal(one({width:1048576,height:1048576}).height,1048576);assert.equal(one({width:65536,height:70000}).width,65536,'old 65535 cap no longer refuses');
  assert.deepEqual([...one({bbox:[-100000,-100000,100000,100000]}).bbox],[-100000,-100000,100000,100000]);assert.deepEqual([...one({bbox:[14400,0,14400.5,70000]}).bbox],[14400,0,14400.5,70000],'old 14400 cap no longer refuses');
  for(const over of [{width:1048577},{height:1048577},{width:0},{bbox:[0,0,100000.5,1]},{bbox:[-100000.5,0,1,1]},{bbox:[0,0,1,Infinity]}]){let e;try{one(over);}catch(x){e=x;}assert.ok(e&&e.image,JSON.stringify(over));}
  assert.deepEqual(I.EXPORT_REASONS.slice(0,11),Object.keys(I.REASONS));
  assert.deepEqual(I.EXPORT_REASONS.slice(11),['occurrence-not-found','not-editable','replacement-transparent','replacement-invalid','replacement-too-large','output-too-large','check-failed','no-op','engine-error']);
  for(const r of I.EXPORT_REASONS.slice(11))assert.throws(()=>one({editable:false,reason:r,thumbnail:null}),/형식/,r);});

test('core: every fixed reason and error code has fixed recovery copy; unknown, raw or prototype codes give none',()=>{
  const noop=I.refusal('export','image_edit_rejected','no-op');assert.match(noop,/^이 그림을 교체하지 못했습니다: 교체 PNG가 원래 그림과 보기에 달라지지 않음/);assert.match(noop,/눈에 띄게 다른 PNG/);assert.match(noop,/자동으로 다시 시도하지 않습니다\.$/);
  for(const kind of ['list','export'])for(const r of I.EXPORT_REASONS){const s=I.refusal(kind,'image_edit_rejected',r);assert.ok(s&&!/연결|요청이 실패/.test(s),kind+' '+r);}
  for(const c of Object.keys(I.ERRORS))assert.ok(I.refusal('export',c,null),c);
  for(const r of [INJECT,'toString','__proto__','constructor','NO-OP',null,42])assert.match(I.refusal('export','image_edit_rejected',r),/^companion 그림 엔진이 이 요청을 거부했습니다\(사유 미확인\)\. 연결 문제가 아닙니다\./,String(r));
  assert.match(I.refusal('export','image_edit_failed','no-op'),/^companion 그림 엔진 처리 중 오류/,'a reason only counts for an engine refusal');
  for(const c of [INJECT,'toString','__proto__','constructor','hasOwnProperty','',null,undefined,42,{}])assert.equal(I.refusal('export',c,'no-op'),null,String(c));});

test('bridge: image routes keep only a fixed error code and an allowlisted refusal reason; other routes keep their error semantics',async()=>{
  assert.deepEqual([...L.IMAGE_REASONS],[...I.EXPORT_REASONS]);assert.deepEqual([...L.IMAGE_ERRORS,'unauthorized'].sort(),Object.keys(I.ERRORS).sort());
  for(const p of ['/api/paper/images','/api/paper/images/export'])for(const r of I.EXPORT_REASONS){const e=await refused(p,422,{error:'image_edit_rejected',reason:r});assert.equal(e.code,'image_edit_rejected');assert.equal(e.reason,r);assert.equal(e.message,'image_edit_rejected');}
  const inherited=Object.assign(Object.create({reason:'no-op'}),{error:'image_edit_rejected'});
  for(const body of [{error:'image_edit_rejected',reason:INJECT},{error:'image_edit_rejected',reason:'toString'},{error:'image_edit_rejected',reason:'__proto__'},{error:'image_edit_rejected',reason:'NO-OP'},{error:'image_edit_rejected',reason:['no-op']},{error:'image_edit_rejected'},inherited]){
    const e=await refused('/api/paper/images/export',422,body);assert.equal(e.code,'image_edit_rejected');assert.equal(e.reason,null,JSON.stringify(body));}
  const failed=await refused('/api/paper/images/export',500,{error:'image_edit_failed',reason:'no-op'});assert.equal(failed.code,'image_edit_failed');assert.equal(failed.reason,null,'a reason only rides an engine refusal');
  for(const body of [{error:INJECT,reason:'no-op'},{error:'toString'},{error:'__proto__'},Object.assign(Object.create({error:'image_edit_rejected'}),{reason:'no-op'}),null,['image_edit_rejected']]){
    const e=await refused('/api/paper/images',422,body);assert.equal(e.code,null,JSON.stringify(body));assert.equal(e.reason,null);}
  const auth=await refused('/api/paper/images',403,{error:'image_edit_rejected',reason:'no-op'});assert.equal(auth.code,'unauthorized');assert.equal(auth.reason,null);assert.match(auth.message,/인증을 거부했습니다 \(403\)/);
  for(const p of ['/api/paper/inspect','/api/red/jobs','/api/export']){const e=await refused(p,422,{error:'image_edit_rejected',reason:'no-op'});assert.equal(e.message,'image_edit_rejected');assert.ok(!('code' in e)&&!('reason' in e),p);}});

test('panel: an engine refusal shows its fixed reason and recovery, never a connection failure; unknown codes stay generic and nothing retries',async()=>{
  const w=world();await w.ready();const noop=await refused('/api/paper/images/export',422,{error:'image_edit_rejected',reason:'no-op'});w.reply=async()=>{throw noop;};
  w.get('image-export').click();await until(()=>!/하는 중/.test(w.exportStatus()),'export refused');await flush();
  assert.match(w.exportStatus(),/^이 그림을 교체하지 못했습니다: 교체 PNG가 원래 그림과 보기에 달라지지 않음/);assert.doesNotMatch(w.exportStatus(),/연결|요청이 실패했습니다/);assert.equal(w.get('image-export-status').classList.contains('error'),true);
  assert.equal(w.radios()[0].checked,true);assert.match(w.get('image-after').src,/^data:image\/png/);assert.equal(w.get('image-result').hidden,true);assert.equal(w.get('image-export').disabled,false);assert.equal(w.bridge.busyCalls.at(-1),false);
  await flush();assert.equal(w.calls.length,2,'no automatic retry');assert.equal(w.downloads.length,0);
  const cases=[[422,{error:'image_edit_rejected',reason:'malformed-pdf'},/^그림 목록을 만들지 못했습니다: PDF 구조를 확인하지 못함\. 이 PDF에서는 그림 교체를 쓸 수 없습니다\./],[409,{error:'companion_busy'},/^companion이 다른 작업을 처리 중입니다/],
    [503,{error:'image_editor_unavailable'},/^companion에 그림 교체 엔진이 준비되지 않았습니다/],[422,{error:'image_edit_rejected',reason:INJECT},/^companion 그림 엔진이 이 요청을 거부했습니다\(사유 미확인\)/],[500,{error:INJECT},/^요청이 실패했습니다/]];
  for(const [status,body,expect] of cases){const l=world();await l.load();const e=await refused('/api/paper/images',status,body);l.reply=async()=>{throw e;};l.get('image-list').click();await until(()=>!/찾는 중/.test(l.status()),'list refused');await flush();
    assert.match(l.status(),expect);assert.ok(!/img|trial|secret/.test(l.status()));assert.equal(l.radios().length,0);assert.equal(l.calls.length,1,'no automatic retry');}});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name);console.error(e);process.exitCode=1;}}
  console.log(JSON.stringify({passed,failed:tests.length-passed,skipped:0}));if(passed!==tests.length)process.exit(1);})();
