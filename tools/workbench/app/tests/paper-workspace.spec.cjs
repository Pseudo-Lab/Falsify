'use strict';
// Node VM contract for the RED paper surface. Synthetic DOM and a mocked PDF.js.
// No browser, network, model, upload, or private PDF. Sibling edit/export modules are contract mocks.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const WS=fs.readFileSync(path.resolve(__dirname,'../dist/paper-workspace.js'),'utf8');
const HTML=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8').replace(/\?v=[^"\s]+(?=")/g,'');
const CSS=fs.readFileSync(path.resolve(__dirname,'../dist/paper-workspace.css'),'utf8');
const RED=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.js'),'utf8');
const PREVIEW_SRC=fs.readFileSync(path.resolve(__dirname,'../dist/document-preview.js'),'utf8');
const api=require('../dist/paper-workspace.js');
const previewCtx=vm.createContext({URL,TextDecoder,Uint8Array,Promise,Error,Math,Number,Array,Object,String});
vm.runInContext(PREVIEW_SRC,previewCtx,{filename:'document-preview.js'});
const Preview=previewCtx.FalsifyPreview;
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const BASE='http://127.0.0.1:7815/';
const until=async(cond,label)=>{for(let i=0;i<400;i++){if(cond())return;await new Promise(r=>setTimeout(r,5));}assert.fail('timed out: '+label);};
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
const textOf=e=>!e?'':(e.textContent||'')+(e.children||[]).map(textOf).join('');
const pdfBytes=marker=>Buffer.from('%PDF-1.7\n'+marker+'\n%%EOF');
const pdfFile=(bytes,name='paper.pdf')=>new File([bytes],name,{type:'application/pdf'});
const ITEMS=[
  {str:'Alpha',transform:[1,0,0,1,10,100],width:40,height:12,hasEOL:false},
  {str:'Alpha',transform:[1,0,0,1,10,80],width:40,height:12,hasEOL:false}
];
const TAGS={
  'paper-file':'input','paper-inline-after':'textarea','paper-draft-opt':'input','paper-draft-source':'input','paper-before-stage':'div','paper-after-stage':'div','paper-edits':'ul','paper-proposal-list':'ul',
  'paper-original-download':'button','paper-page-prev':'button','paper-page-next':'button','paper-page-jump':'input','paper-zoom-out':'button','paper-zoom-in':'button',
  'paper-inline-apply':'button','paper-inline-cancel':'button','paper-undo':'button','paper-redo':'button','paper-generate':'button',
  'paper-current-download':'button','paper-team-share':'button','paper-blue-handoff':'button','paper-draft-save':'button','paper-draft-restore':'button','paper-draft-delete':'button'
};

function element(document,id,tag=''){
  const classes=new Set(),attrs={},e=new EventTarget();
  Object.assign(e,{id,tagName:tag,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],className:'',clientWidth:640,type:'',dataset:{},
    style:{setProperty(k,v){this[k]=v;}},
    getBoundingClientRect(){return {left:0,top:0,right:0,bottom:0,width:0,height:0};},
    classList:{add(c){classes.add(c);},remove(...names){for(const c of names)classes.delete(c);},toggle(c,on){(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    setAttribute(k,v){attrs[k]=String(v);},getAttribute:k=>attrs[k]??null,
    getContext(){return tag==='canvas'?{canvas:e}:null;},
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},prepend(...c){this.children.unshift(...c);},
    after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[{width:8,height:8}],
    focus(){document.activeElement=e;},
    contains(n){if(n===this)return true;return (this.children||[]).some(c=>c.contains?c.contains(n):c===n);},
    querySelector(sel){return this.querySelectorAll(sel)[0]||null;},
    querySelectorAll(sel){const out=[];(function walk(n){for(const c of n.children||[]){const name=String(c.tagName||'').toLowerCase();if((sel==='span'&&name==='span')||(sel==='svg'&&name==='svg')||(sel==='button'&&name==='button'))out.push(c);walk(c);}})(this);return out;}});
  return e;
}
function dom(){
  const els=new Map(),created=[];
  let document;
  const make=(id,tag)=>element(document,id,tag);
  const get=id=>{if(!els.has(id)){const e=make(id,TAGS[id]||'');els.set(id,e);}return els.get(id);};
  document=new EventTarget();
  Object.assign(document,{baseURI:BASE,activeElement:null,body:null,scripts:[],
    querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,
    querySelectorAll:()=>[],
    createElement:tag=>{const e=make('',tag);created.push(e);return e;},
    createElementNS:()=>make('','svg'),
    getSelection:()=>null});
  document.body=make('body','body');document.activeElement=document.body;
  get('paper-draft-opt').type='checkbox';get('paper-draft-source').type='checkbox';get('paper-file').type='file';get('paper-page-jump').type='number';
  return {document,get,created};
}
function pdfjs({pages=2,hold=false,make,items=ITEMS,rotation=0}={}){
  const state={pageCount:pages};
  const log={params:[],received:[],tasks:[],renders:[],setPages(n){state.pageCount=n;}};
  class TextLayer{constructor({textContentSource,container}){this.container=container;this.textDivs=(textContentSource.items||[]).map(()=>make('span'));}
    render(){for(const span of this.textDivs)this.container.append(span);return Promise.resolve();}cancel(){this.cancelled=true;}}
  const lib={GlobalWorkerOptions:{},TextLayer,getDocument(params){
    log.params.push(params);const received=Buffer.from(params.data);log.received.push(received);params.data.buffer.transfer();
    const marker=received.includes('MARKER-A')?'A':received.includes('MARKER-B')?'B':received.includes('MARKER-GEN')?'GEN':'P';
    let resolve,reject;const task={destroyed:false,marker,promise:new Promise((ok,no)=>{resolve=ok;reject=no;})};task.promise.catch(()=>{});
    task.destroy=async()=>{task.destroyed=true;reject(Object.assign(new Error('Worker was destroyed'),{name:'AbortException'}));};
    task.open=()=>{if(task.destroyed)return;const count=state.pageCount;resolve({numPages:count,getPage:async n=>{
      if(n<1||n>count)throw new Error('page');
      return {getViewport:({scale})=>({width:612*scale,height:792*scale,viewBox:[0,0,612,792],rotation}),
        getTextContent:async()=>({items:items.map(item=>({...item,transform:item.transform.slice()}))}),cleanup(){},
        render({canvas}){let ok,no;const r={cancelled:false,promise:new Promise((a,b)=>{ok=a;no=b;})};
          r.cancel=()=>{if(r.done)return;r.cancelled=true;r.done=true;no(Object.assign(new Error('Rendering cancelled'),{name:'RenderingCancelledException'}));};
          r.finish=()=>{if(r.done)return;r.done=true;canvas.marker=marker;canvas.painted=n;ok();};log.renders.push(r);setImmediate(r.finish);return r;}};
    }});};log.tasks.push(task);if(!hold)setImmediate(task.open);return task;}};
  return {lib,log};
}
function memory(){const box=new Map();return {getItem:k=>box.has(k)?box.get(k):null,setItem:(k,v)=>{box.set(k,String(v));},removeItem:k=>{box.delete(k);},keys:()=>[...box.keys()]};}
function blobMemory(){const box=new Map();return {box,get:async k=>box.has(k)?box.get(k):null,put:async(k,v)=>{box.set(k,v);},delete:async k=>{box.delete(k);}};}
function editCore(){
  const added=[];let restores=0,drafts=0,last=null;
  const core={added,get restores(){return restores;},get drafts(){return drafts;},get last(){return last;},
    create({fileHash,name,resume}){
      let edits=[],past=[],future=[],listeners=[],rev=0;
      if(resume){
        if(resume.fileHash&&resume.fileHash!==fileHash)throw new Error('이어받을 스냅샷이 이 파일/이름과 맞지 않습니다.');
        if(resume.name&&resume.name!==name)throw new Error('이어받을 스냅샷이 이 파일/이름과 맞지 않습니다.');
        if(Number.isInteger(resume.revision))rev=resume.revision;
        if(Array.isArray(resume.edits))edits=resume.edits.map(e=>({...e}));
      }
      const snap=()=>({schema:'falsify.paper-edits.v1',fileHash,name,revision:rev,edits:edits.map(e=>({...e})),canUndo:past.length>0,canRedo:future.length>0});
      const emit=()=>{rev++;const s=JSON.parse(JSON.stringify(snap()));for(const fn of [...listeners])fn(s);};
      const apply=u=>{if(u.kind==='add')edits.push(u.edit);else if(u.kind==='update'){const e=edits.find(x=>x.id===u.id);if(e)e.after=u.afterNow;}};
      last={snapshot:()=>JSON.parse(JSON.stringify(snap())),subscribe(fn){listeners.push(fn);return ()=>{listeners=listeners.filter(x=>x!==fn);};},
        add(edit){
          const allowed=['pageIndex','segmentId','before','after','anchor','origin'];
          for(const k of Object.keys(edit||{}))if(!allowed.includes(k))throw new Error('편집에 허용되지 않은 필드가 있습니다.');
          if(edit.anchor){
            for(const k of Object.keys(edit.anchor))if(!['start','end','occurrence','bbox','style'].includes(k))throw new Error('anchor에 허용되지 않은 필드가 있습니다.');
            if(edit.anchor.bbox===null||edit.anchor.style===null)throw new Error('빈 bbox/style은 입력에서 생략합니다.');
          }
          const id='e'+(edits.length+1);const stored={...edit,id,enabled:true};edits.push(stored);past.push({kind:'add',id,edit:stored});future=[];added.push(edit);emit();return id;
        },
        update(id,changes){const e=edits.find(x=>x.id===id);if(!e)throw new Error('없는 편집');past.push({kind:'update',id,after:e.after,afterNow:changes.after});e.after=changes.after;future=[];emit();},
        remove(id){const edit=edits.find(e=>e.id===id);edits=edits.filter(e=>e.id!==id);past.push({kind:'remove',edit});future=[];emit();},
        setEnabled(id,on){const e=edits.find(x=>x.id===id);if(!e)throw new Error('없는 편집');e.enabled=!!on;past.push({kind:'enable',id,on:!on});future=[];emit();},
        undo(){const u=past.pop();if(!u)return;if(u.kind==='add')edits=edits.filter(e=>e.id!==u.id);else if(u.kind==='update'){const e=edits.find(x=>x.id===u.id);if(e){u.afterNow=e.after;e.after=u.after;}}else if(u.kind==='remove'&&u.edit)edits.push(u.edit);else if(u.kind==='enable'){const e=edits.find(x=>x.id===u.id);if(e)e.enabled=u.on;}future.push(u);emit();},
        redo(){const u=future.pop();if(!u)return;if(u.kind==='add')edits.push(u.edit);else if(u.kind==='update'){const e=edits.find(x=>x.id===u.id);if(e)e.after=u.afterNow;}else if(u.kind==='remove')edits=edits.filter(e=>e.id!==u.edit.id);else if(u.kind==='enable'){const e=edits.find(x=>x.id===u.id);if(e)e.enabled=!u.on;}past.push(u);emit();}};
      return last;
    },
    draft({snapshot,now}){drafts++;return {schema:'falsify.paper-edits-draft.v1',fileHash:snapshot.fileHash,savedAt:now,expiresAt:now+api.TTL,snapshot};},
    restoreDraft(envelope,{fileHash,now}){restores++;if(!envelope||envelope.fileHash!==fileHash)throw new Error('다른 파일의 초안입니다.');if(!(now<envelope.expiresAt))throw new Error('12시간이 지나 초안이 만료되었습니다.');const snapshot=envelope.snapshot;if(!snapshot||snapshot.fileHash!==fileHash)throw new Error('다른 파일의 초안입니다.');return snapshot;}};
  return core;
}
function mount(opts={}){
  const w=dom(),storage=opts.storage||memory(),downloads=[],long=[];
  const timers={setTimeout(fn,ms){if(ms>=1000){long.push(fn);return 1e9+long.length-1;}return setTimeout(fn,ms);},clearTimeout(id){if(id>=1e9){long[id-1e9]=null;return;}clearTimeout(id);}};
  const {lib,log}=pdfjs({pages:opts.pages??2,hold:!!opts.hold,make:tag=>w.document.createElement(tag),items:opts.items,rotation:opts.rotation||0});
  w.get('paper-before-stage').clientWidth=opts.width||640;w.get('paper-after-stage').clientWidth=opts.width||640;
  const edits=opts.edits===false?null:(opts.edits||editCore());
  const exporter=opts.exporter||null;
  const sourceBlobs=opts.sourceBlobs||blobMemory();
  const clock={value:opts.clock??1_700_000_000_000};
  const ws=api.create({document:w.document,preview:opts.preview===false?undefined:{pdfParams:Preview.pdfParams,fitScale:Preview.fitScale,defaultImport:async()=>lib},
    edits:edits||undefined,exporter:exporter||undefined,storage,sourceBlobs,urls:{createObjectURL(file){downloads.push(file);return 'blob:'+downloads.length;},revokeObjectURL(){}},
    timers,subtle:crypto.subtle,now:()=>clock.value});
  const file=f=>{w.get('paper-file').files=[f];w.get('paper-file').dispatchEvent(new Event('change'));};
  const canvas=()=>w.get('paper-before-stage').children.flatMap(page=>(page.children||[]).filter(c=>c.tagName==='canvas'));
  return {...w,ws,lib,log,edits,storage,sourceBlobs,downloads,clock,file,canvas,long};
}
function keydown(target,init){const e=new Event('keydown',{cancelable:true});Object.assign(e,init);target.dispatchEvent(e);return e;}
function buttons(v,act,id){return v.get('paper-edits').querySelectorAll('button').filter(b=>b.dataset.act===act&&(!id||b.dataset.edit===id));}

test('geometry: the second occurrence keeps its own top-left box and is not collapsed onto the first',()=>{
  const second=api.anchorFromSelection(ITEMS,[0,0,612,792],[1]);
  assert.equal(second.before,'Alpha');assert.deepEqual(second.anchor.bbox,[10,700,50,712]);
  assert.equal(second.anchor.occurrence,1);assert.equal(second.anchor.start,6);assert.equal(second.anchor.end,11);
  assert.equal(second.anchor.coordinate,'top-left');assert.equal(second.anchor.rotation,0);
  assert.equal(second.anchor.pageWidth,612);assert.equal(second.anchor.pageHeight,792);
  assert.equal(api.anchorFromSelection(ITEMS,[0,0,612,792],[1],{rotation:90}),null);
  assert.equal(api.anchorFromSelection(ITEMS,[0,0,612,792],[1],{rotation:180}),null);
  assert.equal(api.anchorFromSelection(ITEMS,[0,0,612,792],[1],{rotation:270}),null);
  assert.equal(api.anchorFromSelection(ITEMS,[0,0,612,792],[1],{rotation:360}).anchor.rotation,0);
  const first=api.anchorFromSelection(ITEMS,[0,0,612,792],[0]);
  assert.deepEqual(first.anchor.bbox,[10,680,50,692]);assert.equal(first.anchor.occurrence,0);assert.equal(first.anchor.start,0);
  assert.equal(api.pageIndexFromLabel('PDF p. 2'),1);assert.equal(api.pageIndexFromLabel('page 2'),null);
  const segs=[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'},{id:'s1',label:'PDF p. 2',text:'Only once.'},{id:'s2',text:'Only once.'}];
  const out=api.classifyProposals([
    {segmentId:'s0',before:'Alpha',after:'Beta',status:'matched'},
    {before:'Only once.',after:'Only twice.',status:'matched'},
    {before:'missing words',after:'still missing',status:'matched'},
    {segmentId:'s1',before:'Only once.',after:'Moved.',pageIndex:9,status:'matched'}
  ],segs,{origin:'external-ai-import',model:'gpt-sneaky'});
  assert.equal(out.model,undefined,'a non-model origin cannot carry a model id');
  assert.equal(out.items[0].status,'ambiguous');assert.equal(out.items[1].status,'ambiguous');
  assert.equal(out.items[2].status,'missing');assert.equal(out.items[3].status,'ambiguous');
  assert.equal(api.TTL,12*60*60*1000);
  const fit=api.clampScale({width:612,height:792},320,1,Preview.fitScale);
  assert.ok(612*fit<=320&&fit>0);
  const font11={str:'Hello',transform:[11,0,0,11,72,700],width:200,height:11,hasEOL:false};
  const wide=api.anchorFromSelection([font11],[0,0,612,792],[0]);
  assert.deepEqual(wide.anchor.bbox,[72,81,272,92]);
  assert.equal(wide.anchor.bbox[2]-wide.anchor.bbox[0],200);
  const word=api.anchorFromSelection([{str:'Alpha words stay',transform:[1,0,0,1,10,100],width:160,height:12,hasEOL:false}],[0,0,612,792],[0],{range:{startItem:0,startOffset:6,endItem:0,endOffset:11}});
  assert.equal(word.before,'words');assert.equal(word.anchor.start,6);assert.equal(word.anchor.end,11);
  assert.deepEqual(word.anchor.bbox,[70,680,120,692]);
  const crlf='Alpha\r\nBeta';
  const picked=api.classifyProposals([
    {segmentId:'s0',before:'Alpha',after:'Beta',pageIndex:0,anchor:{start:6,end:11,occurrence:1}},
    {segmentId:'s0',before:'Alpha',after:'Beta',pageIndex:0,anchor:{start:6,end:11,occurrence:0}},
    {segmentId:'s0',before:'Alpha',after:'',pageIndex:0,anchor:{start:0,end:5,occurrence:0}},
    {segmentId:'s0',before:'Alpha',after:'  ',pageIndex:0,anchor:{start:0,end:5,occurrence:0}},
    {segmentId:'s1',before:'Beta',after:'Gamma',pageIndex:0,anchor:{start:7,end:11,occurrence:0}},
    {segmentId:'s1',before:'Beta',after:'Gamma',pageIndex:0,anchor:{start:6,end:10,occurrence:0}}
  ],[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'},{id:'s1',label:'PDF p. 1',text:crlf}],{origin:'external-ai-import'});
  assert.equal(picked.items[0].status,'matched');assert.equal(picked.items[0].anchor.occurrence,1);assert.equal(picked.items[0].anchor.start,6);
  assert.equal(picked.items[1].status,'missing');assert.equal(picked.items[2].status,'matched');assert.equal(picked.items[2].after,'');
  assert.equal(picked.items[3].status,'missing');assert.equal(picked.items[4].status,'matched');assert.equal(picked.items[4].anchor.start,7);
  assert.equal(crlf.slice(7,11),'Beta');assert.equal(picked.items[5].status,'missing');
});

test('markup: scripts, optional AI disclosure, empty import mount, and bounded stage',()=>{
  const at=s=>HTML.indexOf(s);
  assert.ok(at('src="local-bridge.js"')<at('src="auto-pair.js"')&&at('src="auto-pair.js"')<at('src="app.js'));
  assert.ok(at('src="app.js')<at('src="paper-edits.js"')&&at('src="paper-edits.js"')<at('src="external-red.js"')&&at('src="external-red.js"')<at('src="browser-pdf.js"')&&at('src="browser-pdf.js"')<at('src="paper-workspace.js"')&&at('src="paper-workspace.js"')<at('src="external-red-ui.js"')&&at('src="external-red-ui.js"')<at('src="paper-manual-records.js"')&&at('src="paper-manual-records.js"')<at('src="document-red.js'));
  assert.match(HTML,/href="paper-workspace.css"/);assert.match(HTML,/href="external-red-ui.css"/);assert.match(HTML,/href="paper-manual-records.css"/);
  assert.match(HTML,/<div id="paper-external-mount"><\/div>/);
  assert.match(HTML,/<details class="red-help" id="red-ai-optional"><summary>AI 검토 · 선택 사항<\/summary>/);
  assert.doesNotMatch(HTML,/id="red-ai-optional"[^>]*\sopen/);
  assert.match(fs.readFileSync(path.resolve(__dirname,'../dist/visual-workflow.js'),'utf8'),/#red-ai-optional > summary/);
  assert.match(RED,/origin:'external-ai-import'/);assert.match(RED,/origin:'ai-proposal'/);
  assert.match(CSS,/max-height:\s*min\(70vh,\s*720px\)/);assert.match(CSS,/@media\(max-width:700px\)/);
  assert.match(HTML,/id="paper-page-jump"/);assert.match(CSS,/\.paper-inline\.is-open\{position:absolute/);
  assert.match(CSS,/\.paper-inline\.is-open\{position:fixed|\.paper-inline\.is-open.is-docked\{position:fixed/);
  assert.doesNotMatch(CSS,/box-shadow/);
  assert.doesNotMatch(WS+CSS,/\p{Extended_Pictographic}/u);
  const ids=[...HTML.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);
});

test('reader: file input paints one original page before extraction, and the second selection is a human edit',async()=>{
  const v=mount({width:320}),bytes=pdfBytes('MARKER-A'),file=pdfFile(bytes,'scan.pdf');
  const sources=[];v.document.addEventListener('falsify:paper-workspace-source',e=>sources.push(e.detail));
  v.file(file);
  await until(()=>v.canvas().length===1,'page painted');
  assert.equal(v.ws.getSource().file,file);assert.deepEqual(v.ws.getSource().segments,[]);
  assert.equal(v.get('paper-workspace-status').textContent,'');
  assert.match(v.get('paper-before-status').textContent,/원본 바이트/);
  assert.equal(v.canvas()[0].marker,'A');assert.ok(v.canvas()[0].width<=320&&v.canvas()[0].width>0,'mobile stage clamps the page');
  assert.equal(sources.at(-1).fileHash,v.ws.getSource().fileHash);assert.equal('file' in sources.at(-1),false);
  const params=v.log.params[0];
  assert.equal(params.isEvalSupported,false);assert.equal(params.disableFontFace,true);assert.equal('url' in params,false);
  assert.equal(v.lib.GlobalWorkerOptions.workerSrc,BASE+'vendor/pdf.worker.mjs');
  assert.equal(v.log.tasks.length,1);v.file(file);await settle();assert.equal(v.log.tasks.length,1,'the same File is not reloaded');
  const textEl=v.get('paper-before-stage').children[0].children.find(c=>String(c.className).includes('textLayer'));
  const span=textEl.querySelectorAll('span')[1];assert.equal(span.dataset.i,'1');
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:span,getRangeAt:()=>({commonAncestorContainer:textEl,intersectsNode:n=>n===span})});
  v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  assert.equal(v.get('paper-inline-before').textContent,'Alpha');
  assert.equal(v.get('paper-inline-after').value,'Alpha');
  assert.match(v.get('paper-inline-meta').textContent,/occurrence 1/);assert.match(v.get('paper-inline-meta').textContent,/10, 700, 50, 712/);
  v.get('paper-inline-after').value='Beta';v.get('paper-inline-apply').click();
  assert.equal(v.edits.added.length,0);assert.match(v.get('paper-edit-status').textContent,/원문 구간이 아직 없어/);
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[
    {id:'s0',label:'PDF p. 1',text:'Alpha Alpha',extra:'drop'},{id:'s1',label:'PDF p. 1',text:'Unique claim stays.'},{id:'s2',label:'PDF p. 2',text:'Alpha shared'},{id:'s3',label:'PDF p. 2',text:'Alpha shared'}]}}}));
  v.get('paper-inline-apply').click();
  const human=v.edits.added.at(-1);
  assert.equal(human.origin,'human');assert.equal(human.segmentId,'s0');
  assert.deepEqual(human.anchor,{start:6,end:11,occurrence:1,bbox:[10,700,50,712]});
  assert.equal('coordinate' in human.anchor,false);assert.equal('style' in human.anchor,false);
  assert.match(textOf(v.get('paper-edits')),/직접 편집/);assert.doesNotMatch(textOf(v.get('paper-edits')),/AI 제안|gpt-/);
  assert.match(v.get('paper-edit-status').textContent,/모델 실행으로 기록하지 않습니다/);
  v.get('paper-inline-after').value='';v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  assert.equal(v.get('paper-inline-after').value,'Alpha');
  v.get('paper-inline-after').value='';v.get('paper-inline-apply').click();
  assert.equal(v.edits.added.at(-1).after,'');assert.equal(v.edits.added.at(-1).before,'Alpha');
  v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  v.get('paper-inline-after').value='   ';v.get('paper-inline-apply').click();
  assert.match(v.get('paper-edit-status').textContent,/공백만/);assert.equal(v.edits.added.at(-1).after,'');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[
    {id:'s0',label:'PDF p. 1',text:'Unique claim stays.'},{id:'s1',label:'PDF p. 2',text:'Alpha shared'},{id:'s2',label:'PDF p. 2',text:'Alpha shared'}]}}}));
  v.ws.acceptProposals([
    {segmentId:'s0',before:'Unique claim stays.',after:'Unique claim moves.',status:'matched'},
    {before:'Alpha shared',after:'Alpha changed',status:'matched'},
    {before:'missing words',after:'nope',status:'matched'}
  ],{origin:'external-ai-import',model:'gpt-sneaky'});
  assert.doesNotMatch(textOf(v.get('paper-proposal-list')),/gpt-sneaky/);
  const proposals=v.get('paper-proposal-list').querySelectorAll('button');
  assert.equal(proposals[0].disabled,false);assert.equal(proposals[1].disabled,true);assert.equal(proposals[2].disabled,true);
  const before=v.edits.added.length;proposals[1].click();proposals[2].click();
  assert.equal(v.edits.added.length,before,'ambiguous and missing proposals are not applied');
  proposals[0].click();assert.equal(v.edits.added.at(-1).origin,'external-ai-import');
  const jumped=v.edits.last.add({pageIndex:1,before:'Later',after:'Now',origin:'human'});
  buttons(v,'jump',jumped)[0].click();
  assert.equal(v.get('paper-page-label').textContent,'2 / 2쪽');
  buttons(v,'toggle',jumped)[0].click();
  const off=buttons(v,'toggle',jumped)[0];assert.equal(off.textContent,'켜기');assert.equal(off.getAttribute('aria-pressed'),'false');
  buttons(v,'delete',jumped)[0].click();
  assert.equal(v.ws.getEditSnapshot().edits.some(e=>e.id===jumped),false);
  const src=v.ws.getSource();const kept=src.segments[0].text;
  assert.throws(()=>{src.segments[0].text='changed';});
  assert.equal(v.ws.getSource().segments[0].text,kept);assert.equal(src.file,file);
});

test('keyboard: arrows move pages except from a field, Escape returns to the stage, and Ctrl+Z undoes',async()=>{
  const v=mount(),file=pdfFile(pdfBytes('MARKER-A'));v.file(file);await until(()=>v.canvas().length===1,'painted');
  keydown(v.get('paper-inline-after'),{key:'ArrowRight'});
  assert.equal(v.get('paper-page-label').textContent,'1 / 2쪽');
  keydown(v.get('paper-before-stage'),{key:'ArrowRight'});
  await until(()=>v.canvas()[0]&&v.canvas()[0].painted===2,'page 2');
  v.get('paper-page-jump').value='1';v.get('paper-page-jump').dispatchEvent(new Event('change'));
  await until(()=>v.canvas()[0]&&v.canvas()[0].painted===1,'typed page 1');
  keydown(v.get('paper-page-jump'),{key:'ArrowRight'});
  assert.equal(v.get('paper-page-label').textContent,'1 / 2쪽');
  v.get('paper-page-jump').value='9';v.get('paper-page-jump').dispatchEvent(new Event('change'));
  assert.match(v.get('paper-before-status').textContent,/없는 쪽/);assert.equal(v.get('paper-page-label').textContent,'1 / 2쪽');
  v.get('paper-page-jump').value='2';keydown(v.get('paper-page-jump'),{key:'Enter'});
  await until(()=>v.canvas()[0]&&v.canvas()[0].painted===2,'enter page 2');
  const textEl=v.get('paper-before-stage').children[0].children.find(c=>String(c.className).includes('textLayer'));
  const span=textEl.querySelectorAll('span')[1];
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:span,getRangeAt:()=>({commonAncestorContainer:textEl,intersectsNode:n=>n===span})});
  v.get('paper-before-stage').dispatchEvent(new Event('pointerup'));
  assert.equal(v.get('paper-inline').hidden,false);
  keydown(v.get('paper-inline-after'),{key:'Escape'});
  assert.equal(v.get('paper-inline').hidden,true);assert.equal(v.document.activeElement,v.get('paper-before-stage'));
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 2',text:'Alpha'}]}}}));
  v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  v.get('paper-inline-after').value='Beta';v.get('paper-inline-apply').click();
  assert.equal(v.ws.getEditSnapshot().canUndo,true);assert.equal(v.edits.added.at(-1).anchor.occurrence,0);
  keydown(v.get('paper-workspace'),{key:'z',ctrlKey:true});
  assert.equal(v.ws.getEditSnapshot().edits.length,0);assert.equal(v.get('paper-undo').disabled,true);assert.equal(v.get('paper-redo').disabled,false);
  keydown(v.get('paper-workspace'),{key:'y',ctrlKey:true});
  assert.equal(v.ws.getEditSnapshot().edits.length,1);assert.equal(v.ws.getEditSnapshot().edits[0].origin,'human');
  keydown(v.get('paper-workspace'),{key:'z',metaKey:true});
  assert.equal(v.ws.getEditSnapshot().edits.length,0);
  keydown(v.get('paper-inline-after'),{key:'y',metaKey:true});
  assert.equal(v.ws.getEditSnapshot().edits.length,0,'redo stays out of a text field');
  keydown(v.get('paper-workspace'),{key:'Z',ctrlKey:true,shiftKey:true});
  assert.equal(v.ws.getEditSnapshot().edits.length,1);
});

test('refocus: last page, one-page replacement, and 200% zoom keep focus on an enabled control',async()=>{
  const v=mount({width:320});
  v.file(pdfFile(pdfBytes('MARKER-A'),'a.pdf'));await until(()=>v.canvas().length===1,'two pages');
  const next=v.get('paper-page-next'),prev=v.get('paper-page-prev'),stage=v.get('paper-before-stage');
  next.focus();next.click();assert.equal(next.disabled,true);assert.equal(v.document.activeElement,prev);
  v.log.setPages(1);prev.focus();
  v.file(pdfFile(pdfBytes('MARKER-B'),'b.pdf'));
  assert.equal(prev.disabled,true);assert.equal(next.disabled,true);assert.equal(v.document.activeElement,stage);
  await until(()=>v.canvas().length===1&&v.canvas()[0].marker==='B','one page');
  assert.equal(v.get('paper-page-prev').disabled,true);assert.equal(v.get('paper-page-next').disabled,true);
  assert.equal(v.document.activeElement,stage);assert.notEqual(v.document.activeElement,v.document.body);
  const z=mount({pages:1,width:320});
  z.file(pdfFile(pdfBytes('MARKER-A'),'z.pdf'));await until(()=>z.canvas().length===1,'zoom base');
  const zin=z.get('paper-zoom-in'),zout=z.get('paper-zoom-out');zin.focus();
  let guard=0;while(!zin.disabled){zin.click();if(++guard>6)assert.fail('zoom did not reach the end');}
  assert.equal(z.get('paper-zoom-label').textContent,'200%');assert.equal(z.document.activeElement,zout);
});

test('async: a held read of file A cannot become the source after B is chosen',async()=>{
  const v=mount({pages:1});
  let release;const gate=new Promise(r=>{release=r;});
  const aBytes=pdfBytes('MARKER-A');
  const a={name:'a.pdf',type:'application/pdf',size:aBytes.length,arrayBuffer:()=>gate.then(()=>Uint8Array.from(aBytes).buffer)};
  const b=pdfFile(pdfBytes('MARKER-B'),'b.pdf');
  const seen=new Set();const timer=setInterval(()=>{const s=v.ws.getSource();if(s)seen.add(s.file);},0);
  v.file(a);v.file(b);release();
  await until(()=>v.ws.getSource()&&v.ws.getSource().file===b&&v.canvas()[0]&&v.canvas()[0].marker==='B','B painted');
  clearInterval(timer);
  assert.equal(seen.has(a),false);assert.equal(sha(Buffer.from(await v.ws.getSource().file.arrayBuffer())),sha(pdfBytes('MARKER-B')));
  assert.ok(v.log.received.length>=1&&v.log.received.every(buf=>buf.includes('MARKER-B')&&!buf.includes('MARKER-A')));
});

test('async: a held load of A is destroyed and a late open does not paint over B',async()=>{
  const v=mount({pages:1,hold:true});
  const a=pdfFile(pdfBytes('MARKER-A'),'a.pdf'),b=pdfFile(pdfBytes('MARKER-B'),'b.pdf');
  v.file(a);await until(()=>v.log.tasks.length===1,'A loading');
  v.file(b);await until(()=>v.log.tasks.length===2,'B loading');
  assert.equal(v.log.tasks[0].destroyed,true);
  v.log.tasks[0].open();v.log.tasks[1].open();
  await until(()=>v.canvas().length===1&&v.canvas()[0].marker==='B','B painted');
  await settle();
  assert.equal(v.canvas().length,1);assert.equal(v.canvas()[0].marker,'B');assert.equal(v.ws.getSource().file,b);
});

test('output: preview and download use the generated bytes; failure keeps the last real file',async()=>{
  const exp={calls:[],fail:false,files:[]};exp.prepare=async req=>{exp.calls.push(req);if(exp.fail)throw new Error('<engine secret>');
    const bytes=pdfBytes('MARKER-GEN');const file=new File([bytes],'current.pdf',{type:'application/pdf'});exp.files.push(file);
    return {file,sha256:sha(bytes),verification:{applied:req.edits.length,token:'secret-token'},warnings:['font']};};
  const v=mount({pages:1,exporter:exp});
  const outputs=[],edits=[];
  v.document.addEventListener('falsify:paper-workspace-output',e=>outputs.push(e.detail));
  v.document.addEventListener('falsify:paper-workspace-edits',e=>edits.push(e.detail));
  const source=pdfFile(pdfBytes('MARKER-A'),'origin.pdf');v.file(source);
  await until(()=>v.ws.getSource()&&v.edits.last,'ready');
  v.edits.last.add({pageIndex:0,before:'Alpha',after:'Beta',origin:'human'});
  exp.fail=true;v.get('paper-generate').click();
  await until(()=>/생성하지 못했습니다/.test(v.get('paper-generate-status').textContent),'first failure');
  assert.match(v.get('paper-generate-status').textContent,/마지막 생성본은 그대로입니다/);
  assert.doesNotMatch(v.get('paper-generate-status').textContent,/성공|engine secret/);
  assert.equal(v.ws.getOutput(),null);assert.equal(outputs.length,0);
  exp.fail=false;v.get('paper-generate').click();
  await until(()=>v.ws.getOutput()&&v.get('paper-after-stage').children.some(c=>c.marker==='GEN'),'generated');
  const out=v.ws.getOutput();assert.equal(out.file,exp.files[0]);assert.equal(out.sha256,sha(pdfBytes('MARKER-GEN')));
  assert.equal(out.revision,outputs[0].revision);assert.equal(out.sha256,outputs[0].sha256);
  assert.throws(()=>{out.verification.applied=0;});assert.equal(v.ws.getOutput().verification.applied,1);
  assert.throws(()=>{edits.at(-1).edits[0].after='stamped';});assert.equal(v.ws.getEditSnapshot().edits[0].after,'Beta');
  for(const call of exp.calls){assert.equal(call.edits[0].after,'Beta');assert.doesNotMatch(JSON.stringify(call.edits),/공격|quality|stamp|provenance/);}
  assert.match(v.get('paper-generate-status').textContent,/생성본을 받았습니다\. 미리보기와 다운로드는 이 파일의 바이트입니다/);
  assert.match(v.get('paper-generate-status').textContent,/PDF 내용에는 넣지 않습니다/);
  assert.doesNotMatch(v.get('paper-after-stage').children.find(c=>c.marker==='GEN').getAttribute('aria-label'),/font|진단|secret/);
  assert.equal(out.verification.token,'secret-token');
  assert.equal(outputs.length,1);assert.equal('file' in outputs[0],false);assert.equal('token' in outputs[0].verification,false);
  assert.equal(outputs[0].sha256,out.sha256);assert.equal(outputs[0].verification.applied,1);
  assert.ok(edits.every(s=>!('file' in s)));
  assert.equal(v.get('paper-current-download').textContent,'현재 생성본 다운로드');
  v.get('paper-current-download').click();assert.equal(v.downloads.at(-1),out.file);
  v.get('paper-original-download').click();assert.equal(v.downloads.at(-1),source);
  const teams=[];v.document.addEventListener('falsify:paper-team-share',e=>teams.push(e.detail));
  const beforeTeam=v.downloads.length;v.get('paper-team-share').click();
  assert.equal(v.downloads.length,beforeTeam,'team publication is not a download');
  assert.deepEqual(Object.keys(teams[0]).sort(),['name','revision','sha256','verification']);
  assert.equal(teams[0].name,'current.pdf');assert.equal(teams[0].sha256,out.sha256);assert.equal(teams[0].revision,out.revision);
  assert.equal('token' in teams[0].verification,false);assert.doesNotMatch(JSON.stringify(teams[0]),/%PDF/);
  assert.match(v.get('paper-generate-status').textContent,/업로드하지 않으며/);
  let blue=null;v.document.addEventListener('falsify:blue-file',e=>{blue=e.detail;e.preventDefault();});
  v.get('paper-blue-handoff').click();
  assert.deepEqual(Object.keys(blue),['file']);assert.equal(blue.file,out.file);
  assert.match(v.get('paper-generate-status').textContent,/받지 않았습니다/);
  v.edits.last.add({pageIndex:0,before:'Beta',after:'Gamma',origin:'human'});
  assert.equal(v.get('paper-after-label').textContent,'마지막 생성본 · 현재 편집과 다름');
  assert.equal(v.get('paper-current-download').textContent,'마지막 생성본 다운로드');
  assert.equal(v.ws.getOutput().file,out.file);
  exp.fail=true;v.get('paper-generate').click();
  await until(()=>/생성하지 못했습니다/.test(v.get('paper-generate-status').textContent),'second failure');
  assert.match(v.get('paper-generate-status').textContent,/마지막 생성본은 그대로입니다/);
  assert.doesNotMatch(v.get('paper-generate-status').textContent,/성공/);
  assert.equal(v.ws.getOutput().file,out.file);assert.equal(outputs.length,1);
  v.get('paper-current-download').click();assert.equal(v.downloads.at(-1),out.file);
});

test('unavailable: a missing exporter or PDF helper never reports a generated file',async()=>{
  const v=mount({pages:1,preview:false,edits:false});
  const source=pdfFile(pdfBytes('MARKER-A'),'origin.pdf');v.file(source);
  await until(()=>/PDF\.js 도우미가 없어/.test(v.get('paper-workspace-status').textContent),'no preview');
  assert.equal(v.log.tasks.length,0);assert.equal(v.ws.getOutput(),null);
  assert.match(v.get('paper-export-note').textContent,/성공으로 표시하지 않습니다/);
  assert.match(v.get('paper-core-note').textContent,/편집 코어가 아직 없습니다/);
  v.get('paper-generate').click();assert.equal(v.get('paper-generate-status').textContent,'');
  v.get('paper-original-download').click();assert.equal(v.downloads[0],source);
});

test('draft: opt-in 12h storage, no automatic restore, expiry, and delete',async()=>{
  const v=mount();
  const file={name:'note.txt',type:'text/plain',size:11,arrayBuffer:async()=>new TextEncoder().encode('hello world').buffer};
  v.file(file);await until(()=>v.ws.getSource()&&v.edits.last,'hashed');
  v.edits.last.add({pageIndex:0,before:'hello',after:'goodbye',origin:'human'});
  v.get('paper-draft-save').click();
  assert.equal(v.storage.keys().length,0);assert.match(v.get('paper-draft-status').textContent,/직접 켠 뒤에만/);assert.equal(v.edits.drafts,0);
  v.get('paper-draft-opt').checked=true;v.get('paper-draft-opt').dispatchEvent(new Event('change'));
  const original=v.edits.draft.bind(v.edits);v.edits.draft=()=>({token:'x',fileHash:'abc'});
  v.get('paper-draft-save').click();assert.equal(v.storage.keys().length,0);assert.match(v.get('paper-draft-status').textContent,/비밀/);
  v.edits.draft=original;const savedAt=v.clock.value;v.get('paper-draft-save').click();
  const key='falsify.paper-draft.v1.'+v.ws.getSource().fileHash;const raw=v.storage.getItem(key);const envelope=JSON.parse(raw);
  assert.equal(envelope.schema,'falsify.paper-edits-draft.v1');
  assert.equal(envelope.expiresAt-envelope.savedAt,api.TTL);assert.equal(envelope.savedAt,savedAt);
  assert.doesNotMatch(raw,/token|password|bytes|%PDF/);assert.equal(envelope.snapshot.edits.length,1);assert.equal(Number.isInteger(envelope.snapshot.revision),true);
  v.document.dispatchEvent(new CustomEvent('falsify:document-clear'));
  v.file(file);await until(()=>v.ws.getSource(),'reopened');
  assert.equal(v.get('paper-draft-restore').hidden,false);assert.match(textOf(v.get('paper-edits')),/아직 편집이 없습니다/);assert.equal(v.edits.restores,0);
  v.clock.value=savedAt+api.TTL;v.get('paper-draft-restore').click();
  assert.match(v.get('paper-draft-status').textContent,/만료/);assert.match(textOf(v.get('paper-edits')),/아직 편집이 없습니다/);assert.equal(v.edits.restores,1);
  v.clock.value=savedAt+1000;v.get('paper-draft-restore').click();
  assert.equal(v.ws.getEditSnapshot().edits.length,1);assert.equal(v.ws.getEditSnapshot().edits[0].origin,'human');
  assert.equal(v.ws.getEditSnapshot().revision,envelope.snapshot.revision);assert.equal(v.ws.getEditSnapshot().canUndo,false);
  assert.match(v.get('paper-draft-status').textContent,/실행 취소 기록은 복구 이후부터/);
  v.get('paper-draft-delete').click();assert.equal(v.storage.getItem(key),null);assert.equal(v.get('paper-draft-restore').hidden,true);
});

test('confirmed imports apply once and saved drafts remain recoverable without an open file',async()=>{
  const real=require('../dist/paper-edits.js');
  const v=mount({pages:1,edits:real});
  const file=pdfFile(pdfBytes('MARKER-A'),'draft.pdf');
  v.file(file);await until(()=>v.ws.getSource()?.fileHash,'source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'}]}}}));
  const accepted=v.ws.acceptProposals([{segmentId:'s0',pageIndex:0,before:'Alpha',after:'Beta',anchor:{start:6,end:11,occurrence:1}}],{origin:'external-ai-import',confirmed:true});
  assert.equal(accepted.applied,1);
  assert.equal(v.ws.getEditSnapshot().edits.length,1);
  assert.equal(v.ws.getEditSnapshot().edits[0].origin,'external-ai-import');
  buttons(v,'edit')[0].click();v.get('paper-inline-after').value='Gamma';v.get('paper-inline-apply').click();
  const undo=keydown(v.get('paper-before-stage'),{key:'z',ctrlKey:true});
  v.get('paper-workspace').dispatchEvent(undo);
  assert.equal(v.ws.getEditSnapshot().edits[0].after,'Beta');
  v.get('paper-draft-opt').checked=true;v.get('paper-draft-source').checked=true;
  v.get('paper-draft-save').click();await settle();
  const reopened=mount({storage:v.storage,sourceBlobs:v.sourceBlobs,edits:real});
  assert.equal(reopened.get('paper-draft-restore').hidden,false);
  assert.equal(reopened.get('paper-draft-delete').disabled,false);
  reopened.get('paper-draft-delete').click();await settle();
  assert.equal(v.storage.keys().some(k=>k.startsWith('falsify.paper-draft.v1.')),false);
  assert.equal(v.sourceBlobs.box.size,0);
});

test('boot: the ready event is dispatched on a later turn',async()=>{
  const w=dom();let ready=0;w.document.addEventListener('falsify:paper-workspace-ready',()=>{ready++;});
  const ctx=vm.createContext({document:w.document,CustomEvent,Event,URL,TextDecoder,Uint8Array,Promise,Error,Math,Number,Array,Object,String,Set,Map,JSON,Date,crypto,setTimeout,clearTimeout,TextEncoder});
  vm.runInContext(WS,ctx,{filename:'paper-workspace.js'});
  assert.equal(typeof ctx.FalsifyPaperWorkspace.acceptProposals,'function');assert.equal(ready,0);
  await new Promise(r=>setTimeout(r,0));assert.equal(ready,1);
});

test('bridge: manual JSON is not a model run, and a broker result keeps its model id',async()=>{
  const w=dom(),edits=editCore(),storage=memory();
  const ws=api.create({document:w.document,edits,storage,subtle:crypto.subtle,timers:{setTimeout,clearTimeout},urls:URL,now:()=>1_700_000_000_000});
  w.get('red-level').value='1';w.get('red-budget').value='4';w.get('red-empty').textContent='비어 있음';
  const blobs=[];const jobs=[];
  const link={request:async(path,body)=>{if(path==='/api/red/jobs'&&body){jobs.push(body);return {id:body.requestId};}if(String(path).includes('/cancel'))return {};
    const req=jobs[0];return {state:'completed',progress:{},result:{schema:'falsify.document-red.v1',revision:req.revision,sourceHash:req.sourceHash,status:'ok',model:'gpt-test-1',candidates:[{id:'c1',segmentId:'s0',level:1,before:'does not show',after:'does show',rationale:'The sentence states the opposite of the reported direction.',uncertainty:'Synthetic fixture, not a domain review.',evidence:[{segmentId:'s0',quote:'does not show',relation:'contradicts the sentence'}]}]}};}};
  const ctx=vm.createContext({document:w.document,crypto,CustomEvent,Event,URL:{createObjectURL(b){blobs.push(b);return 'blob:'+blobs.length;},revokeObjectURL(){}},Blob,File,TextEncoder,TextDecoder,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,setTimeout,clearTimeout,confirm:()=>true,btoa,atob,
    FalsifyDocumentRed:require('../dist/document-red-core.js'),FalsifyHarness:require('../dist/harness-core.js'),
    FalsifyLocalBridge:{busy(){},session:()=>link,state:()=>({status:'manual',connected:false,cap:null}),capabilities:()=>({red:true,pdf:false})},
    FalsifyLab:{busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>'run1'},FalsifyPaperWorkspace:ws,addEventListener(){}});
  vm.runInContext(RED,ctx,{filename:'document-red.js'});
  const file={name:'note.txt',type:'text/plain',size:32,arrayBuffer:async()=>new TextEncoder().encode('Alpha does not show benefit.').buffer};
  w.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{text:'Alpha does not show benefit.',format:'TXT',segments:[{label:'PDF p. 1',text:'Alpha does not show benefit.'}]}}}));
  await until(()=>ws.getSource()&&ws.getSource().segments.some(s=>s.text.includes('does not show'))&&w.get('document-red').hidden===false,'bound');
  w.get('red-request').click();await until(()=>blobs.length===1,'request downloaded');
  const req=JSON.parse(await blobs[0].text());
  w.get('red-response').value=JSON.stringify({schema:req.schema,revision:req.revision,sourceHash:req.sourceHash,status:'ok',model:'gpt-sneaky',candidates:[{id:'m1',segmentId:'s0',level:1,before:'does not show',after:'does show',rationale:'The sentence states the opposite of the reported direction.',uncertainty:'Synthetic fixture, not a domain review.',evidence:[{segmentId:'s0',quote:'does not show',relation:'contradicts the sentence'}]}]});
  w.get('red-import-response').click();
  await until(()=>/외부 제안/.test(textOf(w.get('paper-proposal-list'))),'manual proposal');
  assert.doesNotMatch(textOf(w.get('paper-proposal-list')),/gpt-sneaky|AI 제안/);
  assert.match(textOf(w.get('paper-edits')),/아직 편집이 없습니다/);assert.equal(edits.added.length,0);
  w.get('red-consent').checked=true;w.get('red-start').click();
  await until(()=>/AI 제안 · gpt-test-1/.test(textOf(w.get('paper-proposal-list'))),'broker proposal');
  assert.match(textOf(w.get('paper-edits')),/아직 편집이 없습니다/);
  assert.equal(w.get('paper-proposal-list').querySelectorAll('button')[0].disabled,false);
});

test('coordinates: a rotated page stays visible and refuses a box; a unique upright match records top-left metadata',async()=>{
  const turned=mount({pages:1,rotation:90});
  turned.file(pdfFile(pdfBytes('MARKER-A'),'turn.pdf'));
  await until(()=>turned.canvas().length===1,'rotated page');
  assert.match(turned.get('paper-before-status').textContent,/회전된 쪽/);
  const textEl=turned.get('paper-before-stage').children[0].children.find(c=>String(c.className).includes('textLayer'));
  const span=textEl.querySelectorAll('span')[1];
  turned.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:span,getRangeAt:()=>({commonAncestorContainer:textEl,intersectsNode:n=>n===span})});
  turned.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  assert.equal(turned.get('paper-inline').hidden,true);assert.equal(turned.edits.added.length,0);
  assert.match(turned.get('paper-edit-status').textContent,/위쪽 원점 좌표로 확정할 수 없어/);
  const one=[{str:'Alpha',transform:[1,0,0,1,10,100],width:40,height:12,hasEOL:false}];
  const v=mount({pages:1,items:one});
  const file=pdfFile(pdfBytes('MARKER-B'),'flat.pdf');
  v.file(file);await until(()=>v.canvas().length===1,'upright page');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha'}]}}}));
  v.ws.acceptProposals([{segmentId:'s0',before:'Alpha',after:'Beta',status:'matched'}],{origin:'external-ai-import'});
  v.get('paper-proposal-list').querySelectorAll('button')[0].click();
  const anchor=v.edits.added.at(-1).anchor;
  assert.equal(v.edits.added.at(-1).after,'Beta');assert.equal(v.edits.added.at(-1).segmentId,'s0');
  assert.deepEqual(anchor,{start:0,end:5,occurrence:0,bbox:[10,680,50,692]});
  assert.equal('coordinate' in anchor,false);assert.equal('pageWidth' in anchor,false);assert.equal('rotation' in anchor,false);assert.equal('style' in anchor,false);
});

test('draft: metadata asks for the matching PDF, and a consented blob stays local',async()=>{
  const v=mount();
  const file=pdfFile(pdfBytes('MARKER-A'),'scan.pdf');
  v.file(file);await until(()=>v.ws.getSource()&&v.edits.last,'hashed');
  const hash=v.ws.getSource().fileHash;
  v.edits.last.add({pageIndex:0,segmentId:'s0',before:'Alpha',after:'Beta',origin:'human',anchor:{start:0,end:5,occurrence:0}});
  v.get('paper-draft-opt').checked=true;v.get('paper-draft-opt').dispatchEvent(new Event('change'));
  v.get('paper-draft-save').click();await settle();
  assert.equal(v.sourceBlobs.box.size,0);
  assert.doesNotMatch(v.storage.getItem('falsify.paper-draft.v1.'+hash),/%PDF/);
  v.document.dispatchEvent(new CustomEvent('falsify:document-clear'));
  assert.match(v.get('paper-draft-status').textContent,/다시 선택/);assert.match(v.get('paper-draft-status').textContent,new RegExp(hash.slice(0,12)));
  const other=pdfFile(pdfBytes('MARKER-B'),'other.pdf');
  v.file(other);await until(()=>v.ws.getSource()&&v.ws.getSource().file===other,'other');
  v.get('paper-draft-restore').click();await settle();
  assert.equal(v.ws.getEditSnapshot().edits.length,0);assert.match(v.get('paper-draft-status').textContent,/다시 선택/);assert.equal(v.edits.restores,0);
  v.file(file);await until(()=>v.ws.getSource()&&v.ws.getSource().fileHash===hash,'reselect');
  v.get('paper-draft-source').checked=true;
  v.edits.last.add({pageIndex:0,segmentId:'s0',before:'Alpha',after:'Beta',origin:'human',anchor:{start:0,end:5,occurrence:0}});
  v.get('paper-draft-save').click();await settle();
  assert.equal(v.sourceBlobs.box.get(hash).blob,file);assert.equal(v.sourceBlobs.box.get(hash).expiresAt-v.sourceBlobs.box.get(hash).savedAt,api.TTL);
  v.document.dispatchEvent(new CustomEvent('falsify:document-clear'));
  v.get('paper-draft-restore').click();
  await until(()=>v.ws.getSource()&&v.ws.getSource().file===file&&v.ws.getEditSnapshot().edits.length===1,'blob reopen');
  assert.match(v.get('paper-draft-status').textContent,/서버로 올리지 않습니다|원본 PDF 바이트가 없습니다/);
  assert.equal(v.downloads.length,0);
});

test('selection: one word keeps its own range, and the editor sits on that rect',async()=>{
  const sentence=[{str:'Alpha words stay',transform:[1,0,0,1,10,100],width:160,height:12,hasEOL:false}];
  const v=mount({pages:1,width:612,items:sentence});
  const file=pdfFile(pdfBytes('MARKER-A'),'sentence.pdf');
  v.file(file);await until(()=>v.canvas().length===1,'sentence page');
  const pageEl=v.get('paper-before-stage').children[0];
  const textEl=pageEl.children.find(c=>String(c.className).includes('textLayer'));
  const span=textEl.querySelectorAll('span')[0];
  const node={nodeType:3,nodeValue:sentence[0].str,textContent:sentence[0].str,parentElement:span,parentNode:span};
  span.childNodes=[node];
  pageEl.getBoundingClientRect=()=>({left:10,top:30,right:622,bottom:822,width:612,height:792});
  v.get('paper-workspace').getBoundingClientRect=()=>({left:0,top:0,right:900,bottom:800,width:900,height:800});
  const rect={left:80,top:50,right:140,bottom:62,width:60,height:12};
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:node,getRangeAt:()=>({commonAncestorContainer:span,startContainer:node,startOffset:6,endContainer:node,endOffset:11,getBoundingClientRect:()=>rect})});
  v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  assert.equal(v.get('paper-inline-before').textContent,'words');
  assert.equal(v.get('paper-inline-after').value,'words');
  assert.match(v.get('paper-inline-meta').textContent,/70, 20, 130, 32/);
  assert.equal(v.get('paper-inline').classList.contains('is-open'),true);
  assert.equal(v.get('paper-inline').classList.contains('is-docked'),false);
  assert.equal(v.get('paper-inline').style.left,'80px');assert.equal(v.get('paper-inline').style.top,'70px');
  assert.equal(v.document.activeElement,v.get('paper-inline-after'));
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha words stay'}]}}}));
  v.get('paper-inline-after').value='terms';v.get('paper-inline-apply').click();
  const edit=v.edits.added.at(-1);
  assert.equal(edit.before,'words');assert.equal(edit.after,'terms');
  assert.deepEqual(edit.anchor,{start:6,end:11,occurrence:0,bbox:[70,20,130,32]});
  assert.notEqual(edit.before,'Alpha words stay');
  const prior=global.matchMedia;
  global.matchMedia=()=>({matches:true,media:'(max-width:700px)'});
  try{
    v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
    assert.equal(v.get('paper-inline').classList.contains('is-docked'),true);
    keydown(v.get('paper-inline'),{key:'Escape'});
    assert.equal(v.get('paper-inline').hidden,true);assert.equal(v.document.activeElement,v.get('paper-before-stage'));
  }finally{global.matchMedia=prior;}
});

test('geometry: vendored PDF.js font 11 keeps TextItem width in page points',async()=>{
  if(typeof Promise.withResolvers!=='function')Promise.withResolvers=function(){let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
  if(typeof Promise.try!=='function')Promise.try=function(fn){const args=[].slice.call(arguments,1);return new Promise(ok=>{ok(fn.apply(null,args));});};
  if(!Uint8Array.prototype.toHex)Uint8Array.prototype.toHex=function(){let hex='';for(const b of this)hex+=b.toString(16).padStart(2,'0');return hex;};
  const parts=[];const push=s=>parts.push(Buffer.from(s,'latin1'));
  push('%PDF-1.4\n');const offs=[0];
  const add=(n,body)=>{offs[n]=parts.reduce((sum,part)=>sum+part.length,0);push(n+' 0 obj\n'+body+'\nendobj\n');};
  add(1,'<< /Type /Catalog /Pages 2 0 R >>');
  add(2,'<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  add(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  const stream='BT /F1 11 Tf 72 700 Td (Hello) Tj ET\n';
  add(4,'<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'endstream');
  add(5,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xrefAt=parts.reduce((sum,part)=>sum+part.length,0);
  let xref='xref\n0 6\n0000000000 65535 f \n';
  for(let i=1;i<=5;i++)xref+=String(offs[i]).padStart(10,'0')+' 00000 n \n';
  push(xref);push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xrefAt+'\n%%EOF\n');
  const lib=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../dist/vendor/pdf.mjs')).href);
  const task=lib.getDocument({data:new Uint8Array(Buffer.concat(parts)),isEvalSupported:false,disableFontFace:true});
  const pdf=await task.promise,page=await pdf.getPage(1),viewport=page.getViewport({scale:1});
  const content=await page.getTextContent();
  const item=content.items.find(row=>row&&row.str==='Hello');
  assert.equal(item.transform[0],11);assert.equal(item.height,11);
  assert.ok(item.width>20&&item.width<40,'font 11 Hello advance stays near 26pt');
  const located=api.anchorFromSelection([item],viewport.viewBox,[0]);
  const box=located.anchor.bbox;
  assert.ok(Math.abs((box[2]-box[0])-item.width)<0.01);assert.ok(Math.abs((box[3]-box[1])-item.height)<0.01);
  assert.ok(item.width*5>box[2]-box[0],'width is not multiplied by the font matrix again');
  assert.equal(box[0],72);assert.equal(box[1],81);
  if(typeof task.destroy==='function')await task.destroy();
});

function loadUmbrella(filename,src){
  const sandbox={console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Promise,Error,Math,Number,Array,Object,String,JSON,Date,Map,Set,RegExp,parseInt,isNaN,Boolean,WeakSet,WeakMap};
  sandbox.globalThis=sandbox;sandbox.module={exports:{}};sandbox.exports=sandbox.module.exports;
  vm.createContext(sandbox);vm.runInContext(src,sandbox,{filename});
  if(!sandbox.module.exports||typeof sandbox.module.exports.create!=='function'&&typeof sandbox.module.exports.parse!=='function')throw new Error(filename+' did not export');
  return sandbox.module.exports;
}
function siblingSource(file){
  return fs.readFileSync(path.join(__dirname,'../dist',file),'utf8');
}

test('core: second alpha, CRLF, deletion, and resume keep the real edit id',async()=>{
  const edits=loadUmbrella('paper-edits.js',siblingSource('paper-edits.js'));
  const external=loadUmbrella('external-red.js',siblingSource('external-red.js'));
  const v=mount({pages:1,edits});
  const file=pdfFile(pdfBytes('MARKER-A'),'scan.pdf');
  v.file(file);await until(()=>v.ws.getSource()&&v.ws.getSource().fileHash,'hashed');
  const hash=v.ws.getSource().fileHash;
  const pageText='Alpha Alpha',crlf='Alpha\r\nBeta stays\r\nTail';
  const segments=[{id:'s0',label:'PDF p. 1',text:pageText,pageIndex:0},{id:'s1',label:'PDF p. 1',text:crlf,pageIndex:0}];
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments}}}));
  await settle();
  const parsed=external.parse(JSON.stringify({changes:[
    {segmentId:'s0',pageIndex:0,before:'Alpha',after:'Beta'},
    {segmentId:'s1',pageIndex:0,before:'Beta',after:'Gamma'},
    {segmentId:'s1',pageIndex:0,before:'Tail',after:''}
  ]}),{segments,fileHash:hash});
  const alpha=parsed.proposals.find(p=>p.before==='Alpha');
  const beta=parsed.proposals.find(p=>p.before==='Beta');
  const tail=parsed.proposals.find(p=>p.before==='Tail');
  assert.equal(alpha.status,'ambiguous');assert.equal(alpha.anchor,null);assert.equal(alpha.matches.length,2);
  const second=alpha.matches.find(m=>m.occurrence===1);
  assert.equal(second.start,6);assert.equal(second.end,11);assert.equal(pageText.slice(second.start,second.end),'Alpha');
  assert.equal(beta.status,'matched');assert.equal(beta.anchor.start,7);assert.equal(crlf.slice(beta.anchor.start,beta.anchor.end),'Beta');
  assert.notEqual(beta.anchor.start,crlf.replace(/\r\n/g,'\n').indexOf('Beta'));
  assert.equal(tail.status,'matched');assert.equal(tail.after,'');
  const chosen={segmentId:second.segmentId,pageIndex:second.pageIndex,before:'Alpha',after:'Beta',anchor:{start:second.start,end:second.end,occurrence:second.occurrence}};
  v.ws.acceptProposals([chosen,beta,tail],{origin:'external-ai-import'});
  const buttons=v.get('paper-proposal-list').querySelectorAll('button');
  assert.equal(buttons.length,3);assert.equal(buttons.every(b=>!b.disabled),true);
  buttons[0].click();buttons[1].click();buttons[2].click();
  const snap=v.ws.getEditSnapshot();
  assert.equal(snap.edits[0].id,'e1');assert.equal(snap.edits[0].anchor.start,6);assert.equal(snap.edits[0].anchor.occurrence,1);
  assert.equal(snap.edits[1].anchor.start,7);assert.equal(snap.edits[1].before,'Beta');
  assert.equal(snap.edits[2].after,'');assert.equal(snap.edits[2].before,'Tail');assert.equal(snap.canUndo,true);
  const savedId=snap.edits[0].id,savedRevision=snap.revision,savedAt=snap.edits[0].createdAt;
  v.clock.value+=1000;
  v.get('paper-draft-opt').checked=true;v.get('paper-draft-opt').dispatchEvent(new Event('change'));
  v.get('paper-draft-save').click();await settle();
  v.document.dispatchEvent(new CustomEvent('falsify:document-clear'));
  v.file(file);await until(()=>v.ws.getSource()&&v.ws.getSource().fileHash===hash,'reopened');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments}}}));
  await settle();
  v.get('paper-draft-restore').click();await settle();
  const restored=v.ws.getEditSnapshot();
  assert.equal(restored.edits[0].id,savedId);assert.equal(restored.revision,savedRevision);
  assert.equal(restored.canUndo,false);assert.equal(restored.edits[0].createdAt,savedAt);
  assert.equal(restored.edits[0].anchor.start,6);assert.equal(restored.edits[2].after,'');
  assert.match(v.get('paper-draft-status').textContent,/실행 취소 기록은 복구 이후부터/);
});

test('download: an open PDF workspace skips the companion layout gate',async()=>{
  const v=mount({pages:1}),calls=[];
  const file=pdfFile(pdfBytes('MARKER-A'),'scan.pdf');
  v.file(file);await until(()=>v.ws.getSource(),'pdf source');
  const ctx=vm.createContext({document:v.document,crypto,CustomEvent,Event,URL,Blob,File,TextEncoder,TextDecoder,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,setTimeout,clearTimeout,confirm:()=>true,btoa,atob,
    FalsifyDocumentRed:require('../dist/document-red-core.js'),FalsifyHarness:require('../dist/harness-core.js'),
    FalsifyLocalBridge:{busy(){},session(){calls.push('session');return null;},state:()=>({status:'manual',connected:false,cap:null}),capabilities:()=>({red:false,pdf:false})},
    FalsifyLab:{busy(){},allowed:()=>false,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>'run1'},FalsifyPaperWorkspace:v.ws,addEventListener(){}});
  vm.runInContext(RED,ctx,{filename:'document-red.js'});
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{text:'Alpha',format:'PDF',segments:[{label:'PDF p. 1',text:'Alpha'}]}}}));
  await until(()=>v.get('document-red').hidden===false,'red bound');
  v.get('red-export-consent').checked=true;v.get('red-download').click();await settle();
  assert.equal(calls.length,0);assert.match(v.get('red-export-status').textContent,/현재 편집으로 생성/);
  assert.equal(v.document.activeElement,v.get('paper-generate'));
  const txt={name:'note.txt',type:'text/plain',size:5,arrayBuffer:async()=>new TextEncoder().encode('Alpha').buffer};
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file:txt,result:{text:'Alpha',format:'TXT',segments:[{label:'문단 1',text:'Alpha'}]}}}));
  await until(()=>v.get('document-red').hidden===false,'txt bound');
  v.get('red-export-consent').checked=true;v.get('red-download').click();await settle();
  assert.doesNotMatch(v.get('red-export-status').textContent,/현재 편집으로 생성/);
  assert.equal(calls.length,0);
});

test('output: object warnings and failed checks name the candidate without claiming success',async()=>{
  const exp={mode:'warning'};
  exp.prepare=async req=>{
    const bytes=pdfBytes('MARKER-GEN');const file=new File([bytes],'checked.pdf',{type:'application/pdf'});
    if(exp.mode==='warning')return {file,sha256:sha(bytes),verification:{status:'warning',applied:req.edits.length,edits:[{id:'e1',pageIndex:0,status:'applied',checks:[]}],checks:[],warnings:[{code:'font-substituted',severity:'warning',pageIndex:0,editId:'e1'}]},warnings:[{code:'font-substituted',severity:'warning',pageIndex:0,editId:'e1'},{code:'wrapped-after',severity:'info',pageIndex:0,editId:'e1'},{code:'<script>',severity:'warning',pageIndex:0,editId:'e1'}]};
    return {file,sha256:sha(bytes),verification:{status:'failed',edits:[{id:'e1',pageIndex:0,status:'failed',checks:[{id:'e1',pageIndex:0,status:'failed',code:'present-after'}]}],checks:[{id:'e1',pageIndex:0,status:'failed',code:'present-after'},{pageIndex:0,status:'failed',code:'figure-changed'}],warnings:[]},warnings:[]};
  };
  const v=mount({pages:1,exporter:exp});
  v.file(pdfFile(pdfBytes('MARKER-A'),'origin.pdf'));
  await until(()=>v.ws.getSource()&&v.edits.last,'ready');
  v.edits.last.add({pageIndex:0,before:'Alpha',after:'Beta',origin:'human'});
  v.get('paper-generate').click();
  await until(()=>v.ws.getOutput(),'warning candidate');
  const status=()=>v.get('paper-generate-status').textContent;
  assert.match(status(),/검증 상태는 warning입니다/);
  assert.match(status(),/글꼴을 대체함/);
  assert.match(status(),/After가 여러 줄로 바뀜/);
  assert.match(status(),/PDF 내용에는 넣지 않습니다/);
  assert.doesNotMatch(status(),/생성본을 받았습니다|<script>|script/);
  const row=()=>textOf(v.get('paper-edits'));
  assert.match(row(),/검증 warning · 주의 글꼴을 대체함 · 정보 After가 여러 줄로 바뀜/);
  assert.equal(v.ws.getEditSnapshot().edits[0].after,'Beta');
  assert.doesNotMatch(v.get('paper-after-stage').children.find(c=>c.marker==='GEN').getAttribute('aria-label'),/font-substituted|글꼴|진단|warning/);
  assert.equal(v.get('paper-current-download').disabled,false);
  assert.equal(v.get('paper-current-download').textContent,'현재 생성본 다운로드');
  v.get('paper-current-download').click();assert.equal(v.downloads.at(-1),v.ws.getOutput().file);
  exp.mode='failed';v.get('paper-generate').click();
  await until(()=>/검증 상태는 failed입니다/.test(status()),'failed candidate');
  assert.match(status(),/After가 출력에서 확인되지 않음/);
  assert.match(status(),/그림이 바뀜/);
  assert.doesNotMatch(status(),/생성본을 받았습니다/);
  assert.match(row(),/검증 failed · 실패 After가 출력에서 확인되지 않음/);
  assert.equal(v.get('paper-current-download').disabled,false);
  assert.equal(v.ws.getOutput().verification.status,'failed');
  v.get('paper-current-download').click();assert.equal(v.downloads.at(-1),v.ws.getOutput().file);
});

test('wayfinding: an uploaded RED file points at manual editing',async()=>{
  const VISUAL=fs.readFileSync(path.resolve(__dirname,'../dist/visual-workflow.js'),'utf8');
  const observers=[];
  class MutationObserver{constructor(fn){this.fn=fn;observers.push(this);}observe(target){this.target=target;}disconnect(){}}
  const nodes=new Map(),made=[];
  function node(tag='div'){
    const e=new EventTarget();
    e.tagName=String(tag).toUpperCase();e.children=[];e.className='';e.textContent='';e.id='';e.hidden=false;e.disabled=false;e.value='';e.dataset={};e.options=[];e.type='button';
    e.classList={add(){},remove(){},toggle(c,on){e.className=on?'x':'';},contains:()=>false};
    e.setAttribute=()=>{};e.getAttribute=()=>null;e.append=(...c)=>{e.children.push(...c);};e.prepend=(...c)=>{e.children.unshift(...c);};e.replaceChildren=(...c)=>{e.children=c;};
    e.after=()=>{};e.before=()=>{};e.remove=()=>{};e.focus=()=>{document.activeElement=e;};e.scrollIntoView=()=>{e.scrolled=true;};e.closest=()=>null;e.matches=()=>false;
    e.querySelector=sel=>e.querySelectorAll(sel)[0]||null;
    e.querySelectorAll=sel=>{
      if(sel===':scope > .role-step')return e.children.filter(c=>String(c.className||'').split(/\s+/).includes('role-step'));
      if(sel===':scope > p')return e.children.filter(c=>String(c.tagName).toLowerCase()==='p');
      if(sel==='.step-head h2'){const head=e.children.find(c=>String(c.className||'').split(/\s+/).includes('step-head'));return head?head.querySelectorAll('h2'):[];}
      const out=[];
      const wanted=sel.startsWith('.')?sel.slice(1):'';
      (function walk(n){for(const c of n.children||[]){const name=String(c.tagName||'').toLowerCase();const classes=String(c.className||'').split(/\s+/);if(wanted?classes.includes(wanted):name===sel)out.push(c);walk(c);}})(e);
      return out;
    };
    made.push(e);return e;
  }
  const document=new EventTarget();
  const get=id=>{if(!nodes.has(id)){const e=node('div');e.id=id;nodes.set(id,e);}return nodes.get(id);};
  for(const rootId of ['view-workbench','document-blue']){
    const root=get(rootId);
    for(let i=0;i<3;i++){const section=node('section');section.className='role-step';const code=node('span');code.className='step-code';const head=node('div');head.className='step-head';head.append(node('h2'));section.append(code,head);root.append(section);}
  }
  const redRow=node('div'),blueRow=node('div');
  get('red-start').closest=sel=>sel==='.button-row'?redRow:null;
  get('doc-blue-start').closest=sel=>sel==='.button-row'?blueRow:null;
  get('paper-file').closest=()=>null;get('doc-blue-file').closest=()=>null;
  for(const id of ['evaluation-case','evaluation-score','evaluation-note'])get(id).closest=()=>node('label');
  const runLabel=node('label');get('evaluation-run').closest=()=>runLabel;get('evaluation-run').options=[];get('evaluation-run').value='';
  get('evaluation-verdict').options=[];get('evaluation-verdict').id='evaluation-verdict';
  get('evaluation-form').insertBefore=()=>{};
  const manager=get('harness-manager'),heading=node('h2');manager.append(heading);
  manager.querySelector=sel=>sel==='h2'?heading:null;
  document.documentElement=node('html');document.body=node('body');document.activeElement=null;document.readyState='complete';document.baseURI=BASE;
  document.querySelector=sel=>{const id=sel.startsWith('#')?sel.slice(1).split(/[\s>]/)[0]:'';return id?get(id):null;};
  document.querySelectorAll=()=>[];
  document.createElement=tag=>node(tag);document.createElementNS=()=>node('svg');
  document.createTextNode=text=>{const e=node('#text');e.textContent=text;return e;};
  const ctx=vm.createContext({document,MutationObserver,Event,CustomEvent,EventTarget,URL,Promise,Error,Object,Array,String,Number,Set,Map,Math,JSON,setTimeout,clearTimeout,queueMicrotask,FalsifyLocalBridge:{state:()=>({connected:false})}});
  vm.runInContext(VISUAL,ctx,{filename:'visual-workflow.js'});
  await ctx.FalsifyVisual.ready;
  const title=get('sign-title'),detail=get('sign-detail'),label=get('sign-action-label'),action=get('sign-action');
  title.textContent='RED 실행 설정을 확인하세요';detail.textContent='paper.pdf · 0개 후보';label.textContent='실행 설정으로';
  for(const observer of observers)if(observer.target===title)observer.fn();
  assert.equal(title.textContent,'원본에서 직접 고치세요');
  assert.equal(detail.textContent,'쪽을 보고 글자를 고칩니다. AI 실행과 외부 제안은 선택입니다.');
  assert.equal(label.textContent,'원본 편집으로');
  title.textContent='RED 실행 설정을 확인하세요';
  document.dispatchEvent(new CustomEvent('falsify:document-state',{detail:{name:'paper.pdf',busy:false,hasResult:false,count:0}}));
  assert.equal(title.textContent,'원본에서 직접 고치세요');
  assert.equal(made.find(e=>e.className==='visual-next'&&/직접 고칠 수 있습니다/.test(e.textContent)).textContent,'원본 쪽에서 직접 고칠 수 있습니다. AI 실행은 선택입니다.');
  let bubbled=0;action.addEventListener('click',()=>{bubbled++;get('document-red').focus();});
  action.dispatchEvent(new Event('click',{bubbles:true,cancelable:true}));
  assert.equal(bubbled,0);assert.equal(document.activeElement,get('paper-before-stage'));assert.equal(get('paper-before-stage').scrolled,true);
  title.textContent='RED 검토 중입니다';detail.textContent='paper.pdf · 0개 후보';
  document.dispatchEvent(new CustomEvent('falsify:document-state',{detail:{name:'paper.pdf',busy:true,hasResult:false,count:0}}));
  assert.equal(title.textContent,'RED 검토 중입니다');
  assert.equal(made.find(e=>e.className==='visual-next'&&e.textContent==='검토 중').textContent,'검토 중');
});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({file:'paper-workspace.spec.cjs',passed,failed:tests.length-passed,total:tests.length}));})();
