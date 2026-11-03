'use strict';
// Synthetic DOM: no browser, network, model, or private paper.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const UI=require('../dist/paper-enrichment-ui.js');
const source=fs.readFileSync(path.join(__dirname,'../dist/paper-enrichment-ui.js'),'utf8');
const HASH_A='a'.repeat(64), HASH_B='b'.repeat(64), IMAGE='c'.repeat(64);
const SECRET='<img src=x onerror=alert(1)> C:\\secret\\paper.pdf';

function element(tag){
  const el=new EventTarget(), classes=new Set(), attrs={};
  el.tagName=tag.toUpperCase();
  el.children=[];
  el.hidden=false;
  el.disabled=false;
  el.value='';
  el.open=false;
  el.type='';
  el.href='';
  el.download='';
  el.rel='';
  el.rowSpan=1;
  el.colSpan=1;
  el.style={};
  el._text='';
  el.classList={
    add(...xs){for(const x of xs)classes.add(x);},
    remove(...xs){for(const x of xs)classes.delete(x);},
    contains:x=>classes.has(x),
    toggle(x,on){const v=on==null?!classes.has(x):!!on;if(v)classes.add(x);else classes.delete(x);return v;}
  };
  Object.defineProperty(el,'className',{
    get(){return [...classes].join(' ');},
    set(v){classes.clear();for(const x of String(v||'').split(/\s+/))if(x)classes.add(x);}
  });
  Object.defineProperty(el,'textContent',{
    get(){return el._text;},
    set(v){el._text=v==null?'':String(v);el.children=[];}
  });
  el.setAttribute=(k,v)=>{attrs[k]=String(v);};
  el.getAttribute=k=>Object.hasOwn(attrs,k)?attrs[k]:null;
  el.append=(...nodes)=>{el.children.push(...nodes);};
  el.replaceChildren=(...nodes)=>{el.children=nodes;};
  el.setPointerCapture=()=>{};
  el.click=()=>{if(!el.disabled)el.dispatchEvent(new Event('click'));};
  return el;
}
function all(node){
  const out=[];
  (function walk(n){for(const child of n.children||[]){if(child?.tagName)out.push(child);if(child)walk(child);}})(node);
  return out;
}
function text(node){
  if(!node)return '';
  if(node.children?.length)return node.children.map(text).join('');
  return node.textContent||'';
}
function button(host,label){return all(host).find(el=>el.tagName==='BUTTON'&&el.textContent===label);}
function detailsNamed(host,label){return all(host).find(el=>el.tagName==='DETAILS'&&el.children[0]?.textContent===label);}
function progressOf(host){return all(host).find(el=>el.tagName==='P'&&el.getAttribute('aria-live')==='polite');}
function deferred(){
  let settled=false, resolve, reject;
  const promise=new Promise((ok,bad)=>{
    resolve=v=>{if(!settled){settled=true;ok(v);}};
    reject=e=>{if(!settled){settled=true;bad(e);}};
  });
  return {promise,resolve,reject};
}
async function settle(){for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));}
async function until(fn,label){
  const start=Date.now();
  while(!fn()){
    if(Date.now()-start>5000)throw new Error('timeout '+label);
    await new Promise(r=>setTimeout(r,10));
  }
}
function fileOf(){return {name:'t.pdf',size:8,arrayBuffer:async()=>{throw new Error('ui must not read pdf bytes');}};}
function pointer(type,x,y,id=1){
  const event=new Event(type);
  event.clientX=x;event.clientY=y;event.pointerId=id;event.button=0;
  return event;
}
function envelope(hash,data,over={}){
  return {paperId:'pid-'+hash.slice(0,8),fileHash:hash,analysisId:'an1',kind:over.kind||'ocr',pageIndex:over.pageIndex||0,bbox:Object.hasOwn(over,'bbox')?over.bbox:null,
    inputImage:{sha256:IMAGE,width:20,height:10,dpi:144},data,state:'completed',id:'job1',...(over.job||{})};
}
function ocrData(textValue='Alpha line',over={}){
  return {schema:'falsify.ocr-page.v1',status:'ready',language:'en',lines:[{id:'l1',text:textValue,confidence:0.42,bbox:[1,2,3,4]}],tables:[],provenance:{engine:'rapidocr',version:'3.10.0',method:'recognize'},issues:['low contrast'],...over};
}
function chartData(over={}){
  return {schema:'falsify.chart-data.v1',status:'ready',columns:['A','B'],rows:[['50%',null]],numericCells:[{row:0,column:0,raw:'50%',value:0.5,unit:'%',origin:'model-estimate'}],title:'Fig',chartType:'unknown',axes:{x:{label:'time',scale:'unknown',unit:null},y:{label:'n',scale:'linear',unit:null}},provenance:{engine:'deplot',method:'generate',device:'cpu'},issues:['estimate'],rawOutput:'A | 50%',...over};
}

function world(){
  const calls=[], results=[], previews=[], prepares=[], busyEvents=[];
  let changes=0, source=null;
  let prepareImpl=async()=>{
    const hash=source&&source.fileHash;
    return {paperId:'pid-'+String(hash||'').slice(0,8),fileHash:hash};
  };
  globalThis.FalsifyBlueVisual={async previewBluePage(args){
    if(!Number.isSafeInteger(args.page)||args.page>3)throw new Error('visual_selection_invalid');
    previews.push(args);
    const canvas=element('canvas');
    canvas.getBoundingClientRect=()=>({left:0,top:0,width:300,height:400,right:300,bottom:400});
    return {canvas,page:args.page,pages:3,width:600,height:800,wholeFits:true};
  }};
  const host=element('div');
  host.ownerDocument={createElement:tag=>element(tag)};
  const session={request(path,body,options){
    const job=deferred();
    const rec={path,body,options,...job};
    calls.push(rec);
    if(options?.signal?.aborted)job.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    else options?.signal?.addEventListener('abort',()=>job.reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
    return job.promise;
  }};
  const ui=UI.create({
    host,
    getSource:()=>source,
    getSession:()=>session,
    preparePaper:()=>{prepares.push(source&&source.fileHash);return prepareImpl();},
    onResult:payload=>results.push(payload),
    onBusyChange:value=>busyEvents.push(value),
    onChange:()=>{changes++;}
  });
  const posts=()=>calls.filter(call=>call.path==='/api/paper/evidence/jobs');
  const gets=()=>calls.filter(call=>call.path.startsWith('/api/paper/evidence/jobs/')&&!call.path.endsWith('/cancel'));
  const cancels=()=>calls.filter(call=>call.path.endsWith('/cancel'));
  async function open(){
    const details=host.children[0];
    const before=previews.length;
    details.open=true;
    details.dispatchEvent(new Event('toggle'));
    await until(()=>previews.length>before&&all(host).some(el=>el.tagName==='CANVAS'),'preview');
  }
  return {ui,host,calls,results,previews,prepares,busyEvents,posts,gets,cancels,open,button:label=>button(host,label),
    get changes(){return changes;},get source(){return source;},set source(value){source=value;},
    set prepare(fn){prepareImpl=fn;}};
}
let tail=Promise.resolve();
function serial(name,fn){
  test(name,()=>{
    const run=tail.then(fn,fn);
    tail=run.then(()=>{},()=>{});
    return run;
  });
}

test('module stays on the existing preview and bridge without caching paper text',()=>{
  assert.equal(typeof UI.create,'function');
  assert.equal(Object.isFrozen(UI),true);
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|eval\(|new Function|arrayBuffer/);
  assert.doesNotMatch(source,/정확|exact|ground truth|정답/);
  assert.match(source,/previewBluePage/);
  assert.match(source,/\/api\/paper\/evidence\/jobs/);
  assert.throws(()=>UI.create({}),TypeError);
});

serial('panel starts collapsed and does not preview or infer',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  const details=h.host.children[0];
  assert.equal(details.tagName,'DETAILS');
  assert.equal(details.open,false);
  assert.equal(details.children[0].textContent,'스캔·그래프 읽기');
  assert.equal(h.button('글자 읽기 (OCR)').className,'button primary');
  assert.equal(h.button('그래프를 표로 읽기').className,'button secondary');
  assert.equal(h.previews.length,0);
  assert.equal(h.prepares.length,0);
  assert.equal(h.calls.length,0);
  assert.equal(h.changes,0);
  await h.open();
  assert.equal(h.previews.length,1);
  assert.equal(h.previews[0].page,1);
  assert.equal(h.previews[0].fileHash,HASH_A);
  assert.equal(h.previews[0].file.name,'t.pdf');
  assert.equal(h.calls.length,0);
  assert.equal(h.changes,0);
  details.open=false;
  details.dispatchEvent(new Event('toggle'));
  assert.equal(all(h.host).find(el=>el.classList.contains('blue-picker-stage')).children.length,0);
  h.button('다음 쪽').click();
  await settle();
  assert.equal(h.previews.length,1);
  assert.equal(h.ui.snapshot().page,2);
  assert.equal(h.changes,1);
  await h.open();
  assert.equal(h.previews.at(-1).page,2);
  assert.equal(h.calls.length,0);
});

serial('page input is 1-based and language is a user change only',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  const input=all(h.host).find(el=>el.getAttribute('aria-label')==='쪽');
  assert.equal(input.value,'1');
  assert.equal(h.button('이전 쪽').disabled,true);
  h.button('이전 쪽').click();
  assert.equal(h.changes,0);
  input.value='3';
  input.dispatchEvent(new Event('change'));
  assert.equal(h.ui.snapshot().page,3);
  assert.equal(h.changes,1);
  const lang=all(h.host).find(el=>el.getAttribute('aria-label')==='언어');
  lang.value='ko';
  lang.dispatchEvent(new Event('change'));
  assert.equal(h.ui.snapshot().language,'ko');
  assert.equal(h.changes,2);
  assert.equal(h.calls.length,0);
});

serial('drag stores PDF-point XYXY; chart sends it and OCR sends the full page',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  await h.open();
  const stage=all(h.host).find(el=>el.classList.contains('blue-picker-stage'));
  stage.dispatchEvent(pointer('pointerdown',0,0));
  stage.dispatchEvent(pointer('pointerup',150,200));
  const canvas=all(h.host).find(el=>el.tagName==='CANVAS');
  assert.deepEqual(h.ui.snapshot().bbox,[0,0,300,400], JSON.stringify({status:text(all(h.host).find(el=>el.classList.contains('form-feedback'))), canvas:!!canvas, rect:canvas&&canvas.getBoundingClientRect&&canvas.getBoundingClientRect(), listeners:stage.eventNames?.()}));
  assert.equal(h.changes,1);
  h.button('그래프를 표로 읽기').click();
  await until(()=>h.posts().length===1,'chart post');
  const chart=h.posts()[0];
  assert.equal(chart.body.kind,'chart');
  assert.equal(chart.body.pageIndex,0);
  assert.equal(chart.body.language,'en');
  assert.deepEqual(chart.body.bbox,[0,0,300,400]);
  assert.equal(chart.body.fileHash,HASH_A);
  chart.resolve({id:'job-chart',state:'completed',result:envelope(HASH_A,chartData(),{kind:'chart',bbox:[0,0,300,400]})});
  await until(()=>h.results.length===1,'chart result');
  assert.equal(h.results[0].data.origin,undefined);
  assert.match(text(h.host),/50%/);
  assert.match(text(detailsNamed(h.host,'출처·모델')),/눈금 미확인/);
  assert.match(text(h.host),/눈금 미확인/);
  assert.equal(h.changes,1);
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===2,'ocr post');
  assert.equal(h.posts()[1].body.kind,'ocr');
  assert.equal(h.posts()[1].body.bbox,null);
  assert.equal(h.posts()[1].body.pageIndex,0);
  h.posts()[1].resolve({id:'job-ocr',state:'completed',result:envelope(HASH_A,ocrData(SECRET))});
  await until(()=>text(h.host).includes(SECRET),'ocr text');
  assert.equal(all(h.host).some(el=>el.tagName==='IMG'),false);
  assert.doesNotMatch(JSON.stringify(h.ui.snapshot()),/SECRET|onerror|<img|Alpha|50%/);
  const issues=detailsNamed(h.host,'자세한 한계');
  assert.equal(issues.open,false);
  assert.match(text(issues),/low contrast/);
  assert.match(text(h.host),/모델이 이미지에서 추정해 읽은 결과입니다/);
  assert.match(text(h.host),/rapidocr/);
});

serial('completed job reports only the current file and keeps the last result after failure',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'post');
  assert.deepEqual(Object.keys(h.posts()[0].body).sort(),['bbox','fileHash','kind','language','pageIndex','paperId','requestId']);
  assert.match(h.posts()[0].body.requestId,/^[a-f0-9]{32}$/);
  assert.deepEqual(h.busyEvents,[true]);
  h.posts()[0].resolve({id:'job-a',state:'running',progress:{completed:1,total:4}});
  await until(()=>h.gets().length===1,'get');
  assert.equal(h.gets()[0].path,'/api/paper/evidence/jobs/job-a');
  assert.equal(h.gets()[0].body,null);
  assert.match(text(progressOf(h.host)),/1\/4/);
  h.gets()[0].resolve({id:'job-a',state:'completed',result:envelope(HASH_A,ocrData('Alpha line'))});
  await until(()=>h.results.length===1,'result');
  await settle();assert.deepEqual(h.busyEvents,[true,false]);
  assert.equal(h.results[0].fileHash,HASH_A);
  assert.equal(h.results[0].kind,'ocr');
  assert.equal(Object.isFrozen(h.results[0]),true);
  assert.equal(h.changes,0);
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===2,'second');
  h.posts()[1].reject(Object.assign(new Error('no'),{httpStatus:422}));
  await settle();
  assert.equal(h.results.length,1);
  assert.match(text(h.host),/Alpha line/);
  assert.match(text(progressOf(h.host)),/접수되지 않았습니다/);
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===3,'third');
  h.posts()[2].resolve({id:'job-b',state:'completed',result:envelope(HASH_A,ocrData('Beta',{status:'unavailable'}))});
  await settle();
  assert.equal(h.results.length,1);
  assert.match(text(h.host),/Alpha line/);
  assert.doesNotMatch(text(h.host),/Beta/);
});

serial('a lost POST is reconciled by the same client job id without another POST',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'one post');
  assert.equal(h.posts().length,1);
  h.posts()[0].reject(new Error('network'));
  await settle();
  await settle();
  assert.equal(h.posts().length,1);
  assert.equal(h.ui.snapshot().receipt,'held');
  assert.match(text(progressOf(h.host)),/같은 작업/);
  assert.deepEqual(h.busyEvents,[true]);
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.gets().length===1,'receipt reconciliation');
  const requestId=h.posts()[0].body.requestId;
  assert.equal(h.gets()[0].path,'/api/paper/evidence/jobs/'+requestId);
  h.gets()[0].resolve({id:requestId,state:'completed',result:envelope(HASH_A,ocrData('Recovered'))});
  await until(()=>h.results.length===1,'recovered result');await settle();
  assert.equal(h.posts().length,1);assert.deepEqual(h.busyEvents,[true,false]);
});

serial('poll failures query the same job and do not submit another',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'post');
  h.posts()[0].resolve({id:'job-held',state:'running'});
  for(let i=0;i<3;i++){
    await until(()=>h.gets().length===i+1,'get '+i);
    h.gets()[i].reject(new Error('network'));
  }
  await until(()=>/진행을 확인하지 못했습니다/.test(text(progressOf(h.host)))&&!h.button('그래프를 표로 읽기').disabled,'gave up');
  assert.equal(h.posts().length,1);
  assert.equal(h.ui.snapshot().jobId,'job-held');
  h.button('그래프를 표로 읽기').click();
  await until(()=>h.gets().length===4,'resume');
  assert.equal(h.posts().length,1);
  assert.equal(h.prepares.length,1);
  h.gets()[3].resolve({id:'job-held',state:'completed',result:envelope(HASH_A,ocrData('Held line'))});
  await until(()=>h.results.length===1,'held result');
  assert.match(text(h.host),/Held line/);
});

serial('file and revision changes cannot take another file result',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'post');
  h.posts()[0].resolve({id:'job-a',state:'completed',result:envelope(HASH_A,ocrData('Alpha line'))});
  await until(()=>h.results.length===1,'first');
  let releasePrepare;
  h.prepare=()=>new Promise(resolve=>{releasePrepare=resolve;});
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.prepares.length===2,'second prepare');
  h.source={file:fileOf(),fileHash:HASH_B,revision:'r9'};
  releasePrepare({paperId:'pid-'+HASH_A.slice(0,8),fileHash:HASH_A});
  await settle();
  assert.equal(h.posts().length,1);
  assert.equal(h.results.length,1);
  assert.doesNotMatch(text(h.host),/Alpha line/);
  assert.equal(h.changes,0);
  h.prepare=async()=>({paperId:'pid-'+h.source.fileHash.slice(0,8),fileHash:h.source.fileHash});
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===2,'reposted');
  h.posts()[1].resolve({id:'job-r',state:'running'});
  await until(()=>h.gets().length===1,'watch');
  h.source={...h.source,revision:'r2'};
  h.gets()[0].resolve({id:'job-r',state:'running',result:envelope(HASH_A,ocrData('Beta'))});
  await settle();
  assert.equal(h.results.length,1);
  assert.equal(h.cancels().length,1);
  assert.equal(h.cancels()[0].path,'/api/paper/evidence/jobs/job-r/cancel');
  assert.deepEqual(h.cancels()[0].body,{});
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===3,'after revision');
  h.posts()[2].resolve({id:'job-mismatch',state:'completed',result:envelope(HASH_B,ocrData('Other file'))});
  await settle();
  assert.equal(h.results.length,1);
  assert.doesNotMatch(text(h.host),/Other file/);
});

serial('clear cancels the owned job and drops its late result',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'post');
  h.posts()[0].resolve({id:'job-clear',state:'running'});
  await until(()=>h.gets().length===1,'get');
  h.ui.clear();
  assert.equal(h.cancels().length,1);
  assert.deepEqual(h.cancels()[0].body,{});
  h.gets()[0].resolve({id:'job-clear',state:'completed',result:envelope(HASH_A,ocrData('Late'))});
  await settle();
  assert.equal(h.results.length,0);
  assert.doesNotMatch(text(h.host),/Late/);
  assert.equal(h.ui.snapshot().open,false);
  assert.equal(h.ui.snapshot().page,1);
});

serial('busy parent and missing region do not submit work',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.ui.setBusy(true);
  assert.equal(h.ui.snapshot().busy,true);
  assert.equal(h.button('글자 읽기 (OCR)').disabled,true);
  h.button('글자 읽기 (OCR)').click();
  await settle();
  assert.equal(h.prepares.length,0);
  assert.equal(h.calls.length,0);
  h.ui.setBusy(false);
  h.button('그래프를 표로 읽기').click();
  await settle();
  assert.equal(h.calls.length,0);
  assert.match(text(progressOf(h.host)),/영역을 드래그/);
  h.prepare=async()=>({paperId:'pid-other',fileHash:HASH_B});
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.prepares.length===1,'bad prepare');
  await settle();
  assert.equal(h.posts().length,0);
  assert.match(text(progressOf(h.host)),/바뀌어/);
});

serial('downloads keep raw text and chart csv stays on the string table',async()=>{
  const blobs=[];
  const previousCreate=URL.createObjectURL, previousRevoke=URL.revokeObjectURL;
  URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:test';};
  URL.revokeObjectURL=()=>{};
  try{
    const h=world();
    h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
    await h.open();
    const stage=all(h.host).find(el=>el.classList.contains('blue-picker-stage'));
    stage.dispatchEvent(pointer('pointerdown',0,0));
    stage.dispatchEvent(pointer('pointerup',150,200));
    h.button('그래프를 표로 읽기').click();
    await until(()=>h.posts().length===1,'post');
    h.posts()[0].resolve({id:'job-chart',state:'completed',result:envelope(HASH_A,chartData({rows:[['=1+1','only']]}),{kind:'chart',bbox:[0,0,300,400]})});
    await until(()=>h.results.length===1,'result');
    h.button('JSON 다운로드').click();
    h.button('CSV 다운로드').click();
    await settle();
    assert.equal(blobs.length,2);
    const json=await blobs[0].text();
    const csv=await blobs[1].text();
    assert.match(json,/50%|=1\+1/);
    assert.match(json,/model-estimate/);
    assert.match(csv,/50%|=1\+1/);
    assert.match(csv,/only/);
    assert.doesNotMatch(csv,/0\.5/);
    assert.match(csv,/^'=1\+1|=1\+1|'=1\+1/);
    const cells=all(h.host).filter(el=>el.tagName==='TD').map(el=>el.textContent);
    assert.deepEqual(cells,['=1+1','only']);
    const raw=detailsNamed(h.host,'모델 원문');
    assert.equal(raw.open,false);
    assert.match(text(raw),/A \| 50%/);
  }finally{
    if(previousCreate)URL.createObjectURL=previousCreate;else delete URL.createObjectURL;
    if(previousRevoke)URL.revokeObjectURL=previousRevoke;else delete URL.revokeObjectURL;
  }
});

serial('ocr table keeps an empty cell and a merged span without inventing text',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'post');
  const data=ocrData('line',{tables:[{rows:2,columns:2,cells:[{row:0,column:0,rowSpan:2,columnSpan:1,text:'merged'},{row:0,column:1,rowSpan:1,columnSpan:1,text:''}]}]});
  h.posts()[0].resolve({id:'job-table',state:'completed',result:envelope(HASH_A,data)});
  await until(()=>h.results.length===1,'result');
  const cells=all(h.host).filter(el=>el.tagName==='TD');
  assert.equal(cells.length,3);
  assert.equal(cells[0].textContent,'merged');
  assert.equal(cells[0].rowSpan,2);
  assert.equal(cells[1].textContent,'');
  assert.equal(cells[2].textContent,'');
});

serial('same-color curves keep distinct series in the table and both downloads',async()=>{
  const blobs=[], previousCreate=URL.createObjectURL, previousRevoke=URL.revokeObjectURL;
  URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:curves';};
  URL.revokeObjectURL=()=>{};
  try{
    const h=world();h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
    await h.open();
    const stage=all(h.host).find(el=>el.classList.contains('blue-picker-stage'));
    stage.dispatchEvent(pointer('pointerdown',0,0));stage.dispatchEvent(pointer('pointerup',150,200));
    h.button('그래프를 표로 읽기').click();await until(()=>h.posts().length===1,'curve post');
    const rows=[['series-1','left','1','10'],['series-2','left','1','7.0710678']];
    const geometry={series:rows.map((row,index)=>({id:row[0],color:'#1f77b4',axisBinding:'left',
      points:[{x:1,y:Number(row[3]),xPixel:120,yPixel:320+index*40,sourcePoint:[72,100+index*20]}]}))};
    const data=chartData({columns:['series','axis','x','y'],rows,geometry,numericCells:[],issues:[],rawOutput:'',
      provenance:{engine:'opencv+rapidocr',method:'ocr-tick-pixel-calibration',revision:'geometry-2',device:'cpu'}});
    h.posts()[0].resolve({state:'completed',result:envelope(HASH_A,data,{kind:'chart',bbox:[0,0,300,400]})});
    await until(()=>h.results.length===1,'curve result');
    assert.deepEqual(all(h.host).filter(el=>el.tagName==='TD').map(el=>el.textContent),rows.flat());
    h.button('JSON 다운로드').click();h.button('CSV 다운로드').click();await settle();
    assert.equal(blobs.length,2);
    const json=JSON.parse(await blobs[0].text()), csv=await blobs[1].text();
    assert.deepEqual(json.data.geometry,geometry);
    assert.deepEqual(json.data.rows,rows);
    assert.match(csv,/series-1/);assert.match(csv,/series-2/);
    assert.match(csv,/7\.0710678/);assert.match(csv,/10/);
    assert.doesNotMatch(csv,/8\.4089/);
  }finally{
    if(previousCreate)URL.createObjectURL=previousCreate;else delete URL.createObjectURL;
    if(previousRevoke)URL.revokeObjectURL=previousRevoke;else delete URL.revokeObjectURL;
  }
});

serial('bridge path refusal is not treated as a lost job',async()=>{
  const h=world();
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();
  await until(()=>h.posts().length===1,'post');
  h.posts()[0].reject(new Error('허용되지 않은 로컬 경로입니다.'));
  await settle();
  assert.match(text(progressOf(h.host)),/경로를 아직 허용하지 않습니다/);
  assert.equal(h.ui.snapshot().receipt,'none');
  assert.equal(h.ui.snapshot().error,'path');
});

serial('Korean spacing displays separately and keeps every original character',async()=>{
  const h=world();h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();await until(()=>h.posts().length===1,'spacing post');
  const raw='치료군6.269.8',displayText='치료군 6.2 69.8';
  h.posts()[0].resolve({state:'completed',result:envelope(HASH_A,ocrData(raw,{lines:[{text:raw,displayText,confidence:.9,bbox:[0,0,20,10]}]}))});
  await until(()=>h.results.length===1,'spacing result');
  assert.equal(h.results[0].data.lines[0].text,raw);assert.equal(h.results[0].data.lines[0].displayText,displayText);
  assert.match(text(h.host),/치료군 6\.2 69\.8/);assert.match(text(detailsNamed(h.host,'띄어쓰기 전 판독문')),/치료군6\.269\.8/);
});

serial('spacing cannot change a number in the BLUE transcription',async()=>{
  const h=world();h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  h.button('글자 읽기 (OCR)').click();await until(()=>h.posts().length===1,'number post');
  h.posts()[0].resolve({state:'completed',result:envelope(HASH_A,ocrData('7.8',{lines:[{text:'7.8',displayText:'7.9',confidence:.9}]}))});
  await until(()=>h.results.length===1,'number result');
  assert.equal(h.results[0].data.lines[0].text,'7.8');assert.equal(h.results[0].data.lines[0].displayText,undefined);
});
