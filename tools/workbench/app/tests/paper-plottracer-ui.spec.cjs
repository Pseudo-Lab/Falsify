'use strict';
// Synthetic DOM, same shape as paper-enrichment-ui.spec.cjs. No browser, network, model, or private paper.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../dist/paper-enrichment-ui.js');

const HASH_A='a'.repeat(64), HASH_B='b'.repeat(64), IMAGE='c'.repeat(64);
const VIEW={width:600,height:800}, CSS={width:300,height:400};

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
function labeled(host,label){return all(host).find(el=>el.getAttribute('aria-label')===label);}
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
function partialChart(over={}){
  return {schema:'falsify.chart-data.v1',status:'partial',columns:[],rows:[],numericCells:[],title:null,chartType:'unknown',
    axes:{x:{label:null,scale:'unknown',unit:null},y:{label:null,scale:'unknown',unit:null}},
    provenance:{engine:'plottracer',method:'oss-pixel-calibration',device:'cpu'},issues:['axis-calibration-required'],rawOutput:'',
    geometry:{series:[]},...over};
}
function world(){
  const calls=[], results=[], previews=[], prepares=[];
  const pixels=new Map([['150,200',[10,20,30,255]],['300,400',[255,0,128,255]]]);
  let source=null;
  globalThis.FalsifyBlueVisual={async previewBluePage(args){
    previews.push(args);
    const canvas=element('canvas');
    canvas.width=VIEW.width;
    canvas.height=VIEW.height;
    canvas.getBoundingClientRect=()=>({left:0,top:0,width:CSS.width,height:CSS.height,right:CSS.width,bottom:CSS.height});
    canvas.getContext=()=>({getImageData(x,y,w,h){
      if(w!==1||h!==1)throw new Error('one pixel');
      return {data:pixels.get(x+','+y)||[1,2,3,255]};
    }});
    return {canvas,page:args.page,pages:3,width:VIEW.width,height:VIEW.height,wholeFits:true};
  }};
  const host=element('div');
  host.ownerDocument={createElement:tag=>element(tag)};
  const session={request(path,body,options){
    const job=deferred();
    calls.push({path,body,options,...job});
    if(options?.signal?.aborted)job.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    else options?.signal?.addEventListener('abort',()=>job.reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
    return job.promise;
  }};
  const ui=UI.create({
    host,
    getSource:()=>source,
    getSession:()=>session,
    preparePaper:()=>{prepares.push(source&&source.fileHash);return {paperId:'pid-'+String(source.fileHash).slice(0,8),fileHash:source.fileHash};},
    onResult:payload=>results.push(payload)
  });
  const posts=()=>calls.filter(call=>call.path==='/api/paper/evidence/jobs');
  const gets=()=>calls.filter(call=>call.path.startsWith('/api/paper/evidence/jobs/')&&!call.path.endsWith('/cancel'));
  async function open(){
    const details=host.children[0];
    const before=previews.length;
    details.open=true;
    details.dispatchEvent(new Event('toggle'));
    await until(()=>previews.length>before&&all(host).some(el=>el.tagName==='CANVAS'),'preview');
  }
  return {ui,host,results,previews,prepares,posts,gets,open,button:label=>button(host,label),
    get source(){return source;},set source(value){source=value;}};
}
let tail=Promise.resolve();
function serial(name,fn){
  test(name,()=>{
    const run=tail.then(fn,fn);
    tail=run.then(()=>{},()=>{});
    return run;
  });
}
function stageOf(h){return all(h.host).find(el=>el.classList.contains('blue-picker-stage'));}
function canvasClick(h,x,y){
  const stage=stageOf(h);
  stage.dispatchEvent(pointer('pointerdown',x,y));
  stage.dispatchEvent(pointer('pointerup',x,y));
}
function setValue(h,label,value){
  const input=labeled(h.host,label);
  input.value=value;
  input.dispatchEvent(new Event('input'));
}
async function readyChart(h){
  h.source={file:fileOf(),fileHash:HASH_A,revision:'r1'};
  await h.open();
  const stage=stageOf(h);
  stage.dispatchEvent(pointer('pointerdown',0,0));
  stage.dispatchEvent(pointer('pointerup',150,200));
  assert.deepEqual(h.ui.snapshot().bbox,[0,0,300,400]);
  h.button('그래프를 표로 읽기').click();
  await until(()=>h.posts().length===1,'chart post');
  assert.equal(Object.hasOwn(h.posts()[0].body,'chartOptions'),false);
  assert.deepEqual(Object.keys(h.posts()[0].body).sort(),['bbox','fileHash','kind','language','pageIndex','paperId','requestId']);
  h.posts()[0].resolve({id:'job-chart',state:'completed',result:envelope(HASH_A,partialChart(),{kind:'chart',bbox:[0,0,300,400]})});
  await until(()=>h.results.length===1,'chart result');
  await settle();
  const section=detailsNamed(h.host,'축·곡선 지정');
  assert.equal(section.open,false);
  assert.equal(detailsNamed(h.host,'자세한 한계').open,false);
  assert.equal(detailsNamed(h.host,'출처·모델').open,false);
  assert.match(text(h.host),/일부만 읽힘/);
  assert.match(text(detailsNamed(h.host,'자세한 한계')),/axis-calibration-required/);
  assert.deepEqual(h.results[0].data.geometry,{series:[]});
  assert.ok(h.button('JSON 다운로드'));
  assert.ok(h.button('CSV 다운로드'));
  return h;
}
function fillAxes(h){
  h.button('X1 집기').click();
  canvasClick(h,75,100);
  h.button('Y1 집기').click();
  canvasClick(h,75,100);
  h.button('X2 집기').click();
  canvasClick(h,150,200);
  h.button('Y2 집기').click();
  canvasClick(h,150,200);
  setValue(h,'X1 값','0');
  setValue(h,'X2 값','10');
  setValue(h,'Y1 값','1');
  setValue(h,'Y2 값','100');
  const yScale=labeled(h.host,'세로축 눈금');
  yScale.value='log';
  yScale.dispatchEvent(new Event('change'));
}

serial('axis pick maps the preview point through the result crop',async()=>{
  const h=await readyChart(world());
  // CSS 300x400 shows a 600x800 PDF viewport. Crop is [0,0,300,400] on an image 20x10.
  // Client (75,100) -> PDF (150,200) -> x 10/20 of the crop, y 5/10.
  h.button('X1 집기').click();
  const stage=stageOf(h);
  stage.dispatchEvent(pointer('pointerdown',75,100));
  stage.dispatchEvent(pointer('pointerup',90,100));
  assert.equal(all(h.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'미지정');
  assert.match(text(all(h.host).find(el=>el.getAttribute('aria-live')==='polite'&&el.classList.contains('form-feedback'))),/움직였습니다/);
  canvasClick(h,75,100);
  assert.equal(all(h.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'10');
  h.button('Y1 집기').click();
  canvasClick(h,75,100);
  assert.equal(all(h.host).find(el=>el.getAttribute('data-axis')==='y1').textContent,'5');
  h.button('X2 집기').click();
  canvasClick(h,210,20);
  assert.equal(all(h.host).find(el=>el.getAttribute('data-axis')==='x2').textContent,'미지정');
  assert.match(text(h.host),/그래프 영역 밖/);
  canvasClick(h,150,200);
  assert.equal(all(h.host).find(el=>el.getAttribute('data-axis')==='x2').textContent,'20');
  h.button('Y2 집기').click();
  canvasClick(h,150,200);
  assert.equal(all(h.host).find(el=>el.getAttribute('data-axis')==='y2').textContent,'10');
  assert.equal(h.posts().length,1);
});

serial('reread sends chartOptions for the current crop and polls that job',async()=>{
  const h=await readyChart(world());
  fillAxes(h);
  h.button('곡선 추가').click();
  canvasClick(h,75,100);
  h.button('곡선 추가').click();
  canvasClick(h,150,200);
  const secondName=labeled(h.host,'곡선 2 이름');
  secondName.value='';
  secondName.dispatchEvent(new Event('input'));
  assert.equal(all(h.host).find(el=>el.tagName==='SPAN'&&el.getAttribute('data-curve-id')==='c1').textContent,'#0a141e');
  assert.equal(all(h.host).find(el=>el.tagName==='SPAN'&&el.getAttribute('data-curve-id')==='c2').textContent,'#ff0080');
  h.button('보정해서 다시 읽기').click();
  await until(()=>h.posts().length===2,'reread post');
  const body=h.posts()[1].body;
  assert.equal(body.kind,'chart');
  assert.equal(body.fileHash,HASH_A);
  assert.equal(body.pageIndex,0);
  assert.equal(body.language,'en');
  assert.deepEqual(body.bbox,[0,0,300,400]);
  assert.deepEqual(body.chartOptions,{
    imageSha256:IMAGE,
    calibration:{
      x:{scale:'linear',points:[{pixel:10,value:0},{pixel:20,value:10}]},
      y:{scale:'log',points:[{pixel:5,value:1},{pixel:10,value:100}]}
    },
    series:[{id:'c1',color:'#0a141e',name:'곡선 1'},{id:'c2',color:'#ff0080'}]
  });
  assert.equal(h.prepares.length,2);
  h.posts()[1].resolve({id:'job-cal',state:'running'});
  await until(()=>h.gets().length===1,'poll');
  assert.equal(h.gets()[0].path,'/api/paper/evidence/jobs/job-cal');
  assert.equal(h.gets()[0].body,null);
  h.gets()[0].resolve({id:'job-cal',state:'completed',result:envelope(HASH_A,partialChart({rows:[['1','2']]}),{kind:'chart',bbox:[0,0,300,400]})});
  await until(()=>h.results.length===2,'reread result');
  await settle();
  assert.equal(h.posts().length,2);
  assert.deepEqual(all(h.host).filter(el=>el.tagName==='TD').map(el=>el.textContent),['1','2']);
});

serial('incomplete axis, identical points, log zero, and no curve do not post',async()=>{
  const h=await readyChart(world());
  const progress=()=>all(h.host).find(el=>el.tagName==='P'&&el.getAttribute('aria-live')==='polite');
  h.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(h.posts().length,1);
  assert.match(text(progress()),/위치와 값을 모두 지정/);
  h.button('X1 집기').click();
  canvasClick(h,75,100);
  h.button('X2 집기').click();
  canvasClick(h,75,100);
  h.button('Y1 집기').click();
  canvasClick(h,75,100);
  h.button('Y2 집기').click();
  canvasClick(h,150,200);
  setValue(h,'X1 값','0');
  setValue(h,'X2 값','10');
  setValue(h,'Y1 값','1');
  setValue(h,'Y2 값','100');
  h.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(h.posts().length,1);
  assert.match(text(progress()),/달라야 합니다/);
  h.button('X2 집기').click();
  canvasClick(h,150,200);
  const yScale=labeled(h.host,'세로축 눈금');
  yScale.value='log';
  yScale.dispatchEvent(new Event('change'));
  setValue(h,'Y1 값','0');
  h.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(h.posts().length,1);
  assert.match(text(progress()),/0보다 큰 값/);
  setValue(h,'Y1 값','1');
  h.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(h.posts().length,1);
  assert.match(text(progress()),/곡선을 하나 이상/);
});

serial('file, page, and region changes drop calibration and do not send the old image',async()=>{
  const pageH=await readyChart(world());
  fillAxes(pageH);
  pageH.button('곡선 추가').click();
  canvasClick(pageH,75,100);
  assert.equal(all(pageH.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'10');
  pageH.button('다음 쪽').click();
  assert.equal(all(pageH.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'미지정');
  pageH.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(pageH.posts().length,1);
  assert.equal(pageH.posts().some(post=>Object.hasOwn(post.body,'chartOptions')),false);

  const regionH=await readyChart(world());
  fillAxes(regionH);
  regionH.button('곡선 추가').click();
  canvasClick(regionH,75,100);
  assert.equal(all(regionH.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'10');
  const stage=stageOf(regionH);
  stage.dispatchEvent(pointer('pointerdown',10,10));
  stage.dispatchEvent(pointer('pointerup',40,40));
  assert.notDeepEqual(regionH.ui.snapshot().bbox,[0,0,300,400]);
  assert.equal(all(regionH.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'미지정');
  regionH.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(regionH.posts().length,1);
  assert.equal(regionH.posts().some(post=>Object.hasOwn(post.body,'chartOptions')),false);

  const fileH=await readyChart(world());
  fillAxes(fileH);
  fileH.button('곡선 추가').click();
  canvasClick(fileH,75,100);
  assert.equal(all(fileH.host).find(el=>el.getAttribute('data-axis')==='x1').textContent,'10');
  fileH.source={file:fileOf(),fileHash:HASH_B,revision:'r2'};
  fileH.button('보정해서 다시 읽기').click();
  await settle();
  assert.equal(fileH.posts().length,1);
  assert.equal(fileH.posts().some(post=>Object.hasOwn(post.body,'chartOptions')),false);
  assert.equal(detailsNamed(fileH.host,'축·곡선 지정'),undefined);
});

serial('curve picks stop at 8 and a removal frees one slot',async()=>{
  const h=await readyChart(world());
  for(let i=0;i<8;i++){
    h.button('곡선 추가').click();
    canvasClick(h,75,100);
  }
  assert.equal(all(h.host).filter(el=>el.tagName==='SPAN'&&el.getAttribute('data-curve-id')).length,8);
  assert.equal(h.button('곡선 추가').disabled,true);
  h.button('곡선 추가').click();
  assert.equal(all(h.host).filter(el=>el.tagName==='SPAN'&&el.getAttribute('data-curve-id')).length,8);
  h.button('빼기').click();
  assert.equal(h.button('곡선 추가').disabled,false);
  h.button('곡선 추가').click();
  canvasClick(h,150,200);
  const ids=all(h.host).filter(el=>el.tagName==='SPAN'&&el.getAttribute('data-curve-id')).map(el=>el.getAttribute('data-curve-id'));
  assert.deepEqual(ids,['c2','c3','c4','c5','c6','c7','c8','c9']);
  assert.equal(h.button('곡선 추가').disabled,true);
  assert.equal(h.posts().length,1);
});
