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
    replaceChildren(...c){for(const child of this.children)child.parentElement=null;this.children=c;for(const child of c)child.parentElement=this;},append(...c){for(const child of c)child.parentElement=this;this.children.push(...c);},prepend(...c){for(const child of c)child.parentElement=this;this.children.unshift(...c);},
    after(){},remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[{width:8,height:8}],
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
    edits:edits||undefined,fonts:opts.fonts,exporter:exporter||undefined,paragraphPdf:opts.paragraphPdf,tablePdf:opts.tablePdf,pipeline:opts.pipeline,recompositionPdf:opts.recompositionPdf,storage,sourceBlobs,urls:{createObjectURL(file){downloads.push(file);return 'blob:'+downloads.length;},revokeObjectURL(){}},
    timers,subtle:opts.subtle||crypto.subtle,now:()=>clock.value});
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
  assert.match(HTML,/id="paper-page-jump"/);assert.match(CSS,/\.paper-compare:has\(\.paper-inline\.is-open\)/);
  assert.doesNotMatch(CSS,/\.paper-inline\.is-open\{position:fixed/);
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
  const textEl=v.get('paper-before-stage').children.find(e=>e.className==='paper-page').children.find(c=>String(c.className).includes('textLayer'));
  const span=textEl.querySelectorAll('span')[1];assert.equal(span.dataset.i,'1');
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:span,getRangeAt:()=>({commonAncestorContainer:textEl,intersectsNode:n=>n===span})});
  v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  assert.equal(v.get('paper-inline-before').textContent,'Alpha');
  assert.equal(v.get('paper-inline-after').value,'Alpha');
  assert.equal(v.get('paper-inline-meta').textContent,'1쪽 · 선택한 구간');
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
  assert.match(v.get('paper-edit-status').textContent,/직접 편집을 기록/);
  v.get('paper-inline-after').value='';v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  assert.equal(v.get('paper-inline-after').value,'Beta');
  v.get('paper-inline-after').value='';v.get('paper-inline-apply').click();
  assert.equal(v.ws.getEditSnapshot().edits[0].after,'');assert.equal(v.edits.added.at(-1).before,'Alpha');
  v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
  v.get('paper-inline-after').value='   ';v.get('paper-inline-apply').click();
  assert.match(v.get('paper-edit-status').textContent,/공백만/);assert.equal(v.ws.getEditSnapshot().edits[0].after,'');
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
  v.get('paper-inline-cancel').click();buttons(v,'edit',jumped)[0].click();
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
  const textEl=v.get('paper-before-stage').children.find(e=>e.className==='paper-page').children.find(c=>String(c.className).includes('textLayer'));
  const span=textEl.querySelectorAll('span')[1];
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:span,getRangeAt:()=>({commonAncestorContainer:textEl,intersectsNode:n=>n===span})});
  v.get('paper-before-stage').dispatchEvent(new Event('pointerup'));
  assert.equal(v.get('paper-inline').hidden,true);
  keydown(v.document.activeElement,{key:'Escape'});
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

test('output: replacing source during generated-byte digest never resurrects the old output',async()=>{
  let started=false,release,digestFinished=false;
  const subtle={digest:async(algorithm,data)=>{
    if(!started&&Buffer.from(data).includes(Buffer.from('MARKER-GEN'))){started=true;await new Promise(resolve=>{release=resolve;});const result=await crypto.subtle.digest(algorithm,data);digestFinished=true;return result;}
    return crypto.subtle.digest(algorithm,data);
  }};
  const bytes=pdfBytes('MARKER-GEN'),generated=pdfFile(bytes,'a-generated.pdf');
  const v=mount({pages:1,subtle,exporter:{prepare:async()=>({file:generated,sha256:sha(bytes),verification:{status:'applied'}})}});
  v.file(pdfFile(pdfBytes('MARKER-A'),'a.pdf'));
  await until(()=>v.ws.getSource()?.fileHash&&v.edits.last,'source A');
  v.edits.last.add({pageIndex:0,before:'Alpha',after:'Beta',origin:'human'});
  v.get('paper-generate').click();await until(()=>started,'generated digest is pending');
  const b=pdfFile(pdfBytes('MARKER-B'),'b.pdf');v.file(b);
  await until(()=>v.ws.getSource()?.fileHash===sha(pdfBytes('MARKER-B')),'source B replaces A');
  assert.equal(v.ws.getOutput(),null);release();await until(()=>digestFinished,'cancelled generated digest completed');
  assert.equal(v.ws.getOutput(),null,'old A must not become current B output');
  assert.equal(v.ws.getSource().file,b);
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
  assert.deepEqual(Object.keys(blue),['file']);assert.equal(blue.file.name,'paper.pdf');assert.deepEqual(new Uint8Array(await blue.file.arrayBuffer()),new Uint8Array(await out.file.arrayBuffer()));
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
  v.get('paper-draft-save').click();await until(()=>v.storage.keys().some(k=>k.startsWith('falsify.paper-draft.v1.'))&&v.sourceBlobs.box.size===1,'draft and consented source saved');
  const reopened=mount({storage:v.storage,sourceBlobs:v.sourceBlobs,edits:real});
  assert.equal(reopened.get('paper-draft-restore').hidden,false);
  assert.equal(reopened.get('paper-draft-delete').disabled,false);
  reopened.get('paper-draft-delete').click();await until(()=>!v.storage.keys().some(k=>k.startsWith('falsify.paper-draft.v1.'))&&v.sourceBlobs.box.size===0,'draft and consented source deleted');
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
  const textEl=turned.get('paper-before-stage').children.find(e=>e.className==='paper-page').children.find(c=>String(c.className).includes('textLayer'));
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
  v.get('paper-draft-save').click();await until(()=>v.storage.getItem('falsify.paper-draft.v1.'+hash)!==null,'metadata draft saved');
  assert.equal(v.sourceBlobs.box.size,0);
  assert.doesNotMatch(v.storage.getItem('falsify.paper-draft.v1.'+hash),/%PDF/);
  v.document.dispatchEvent(new CustomEvent('falsify:document-clear'));
  assert.match(v.get('paper-draft-status').textContent,/다시 선택/);assert.match(v.get('paper-draft-status').textContent,new RegExp(hash.slice(0,12)));
  const other=pdfFile(pdfBytes('MARKER-B'),'other.pdf');
  v.file(other);await until(()=>v.ws.getSource()&&v.ws.getSource().file===other,'other');
  v.get('paper-draft-restore').click();await until(()=>/^초안에는 편집만 있습니다/.test(v.get('paper-draft-status').textContent),'metadata restore requests original');
  assert.equal(v.ws.getEditSnapshot().edits.length,0);assert.match(v.get('paper-draft-status').textContent,/다시 선택/);assert.equal(v.edits.restores,0);
  v.file(file);await until(()=>v.ws.getSource()&&v.ws.getSource().fileHash===hash,'reselect');
  v.get('paper-draft-source').checked=true;
  v.edits.last.add({pageIndex:0,segmentId:'s0',before:'Alpha',after:'Beta',origin:'human',anchor:{start:0,end:5,occurrence:0}});
  v.get('paper-draft-save').click();await until(()=>v.sourceBlobs.box.has(hash),'consented original source saved');
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
  const pageEl=v.get('paper-before-stage').children.find(e=>e.className==='paper-page');
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
  assert.match(v.get('paper-inline-meta').textContent,/1쪽 · 선택한 구간/);
  assert.equal(v.get('paper-inline').classList.contains('is-open'),true);
  assert.equal(v.get('paper-inline').classList.contains('is-docked'),true);
  const selectedEditor=v.document.activeElement;assert.equal(selectedEditor.tagName,'textarea');assert.equal(selectedEditor.parentElement,pageEl);
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha words stay'}]}}}));
  selectedEditor.value='terms';selectedEditor.dispatchEvent(new Event('input'));selectedEditor.dispatchEvent(new Event('blur'));
  const edit=v.edits.added.at(-1);
  assert.equal(edit.before,'words');assert.equal(edit.after,'terms');
  assert.deepEqual(edit.anchor,{start:6,end:11,occurrence:0,bbox:[70,20,130,32]});
  assert.notEqual(edit.before,'Alpha words stay');
  const prior=global.matchMedia;
  global.matchMedia=()=>({matches:true,media:'(max-width:700px)'});
  try{
    v.get('paper-before-stage').dispatchEvent(new Event('mouseup'));
    assert.equal(v.get('paper-inline').classList.contains('is-docked'),true);
    keydown(v.document.activeElement,{key:'Escape'});
    assert.equal(v.get('paper-inline').hidden,true);assert.equal(v.document.activeElement,buttons(v,'edit')[0]);
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
  v.get('paper-draft-save').click();await until(()=>v.storage.getItem('falsify.paper-draft.v1.'+hash)!==null,'canonical edit draft saved');
  v.document.dispatchEvent(new CustomEvent('falsify:document-clear'));
  v.file(file);await until(()=>v.ws.getSource()&&v.ws.getSource().fileHash===hash,'reopened');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments}}}));
  await settle();
  v.get('paper-draft-restore').click();await until(()=>/실행 취소 기록은 복구 이후부터/.test(v.get('paper-draft-status').textContent),'canonical edit draft restored');
  const restored=v.ws.getEditSnapshot();
  assert.equal(restored.edits[0].id,savedId);assert.equal(restored.revision,savedRevision);
  assert.equal(restored.canUndo,false);assert.equal(restored.edits[0].createdAt,savedAt);
  assert.equal(restored.edits[0].anchor.start,6);assert.equal(restored.edits[2].after,'');
  assert.match(v.get('paper-draft-status').textContent,/실행 취소 기록은 복구 이후부터/);
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
  await until(()=>v.get('paper-after-stage').children.some(c=>c.marker==='GEN'),'warning output rendered');
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
  assert.equal(made.find(e=>e.className==='visual-next').hidden,true,'the manual edit sign does not add another instruction paragraph');
  assert.equal(made.filter(e=>e.tagName==='BUTTON'&&e.children.some(c=>c.textContent==='내 PC 연결')).length,2,'each role has a direct connection action');
  let bubbled=0;action.addEventListener('click',()=>{bubbled++;get('document-red').focus();});
  action.dispatchEvent(new Event('click',{bubbles:true,cancelable:true}));
  assert.equal(bubbled,0);assert.equal(document.activeElement,get('paper-before-stage'));assert.equal(get('paper-before-stage').scrolled,true);
  title.textContent='RED 검토 중입니다';detail.textContent='paper.pdf · 0개 후보';
  document.dispatchEvent(new CustomEvent('falsify:document-state',{detail:{name:'paper.pdf',busy:true,hasResult:false,count:0}}));
  assert.equal(title.textContent,'RED 검토 중입니다');
  assert.equal(made.find(e=>e.className==='visual-next'&&e.textContent==='검토 중').textContent,'검토 중');
});


function clickParagraph(v,x=100,y=100){
  const page=v.get('paper-before-stage').children.find(e=>e.className==='paper-page');
  page.getBoundingClientRect=()=>({left:20,top:30,width:612,height:792,right:632,bottom:822});
  const event=new Event('click');Object.assign(event,{clientX:x+20,clientY:y+30,detail:1});
  v.get('paper-before-stage').dispatchEvent(event);
}
function paragraphMock(text='A full paragraph.\nSecond line.',extra={}){
  return {...extra,inspectPage:extra.inspectPage|| (async({file,pageIndex})=>({fileHash:sha(Buffer.from(await file.arrayBuffer())),pageIndex,width:612,height:792,rotation:0,paragraphs:[{id:'p0',text,bbox:[72,80,540,140]}]}))};
}
function tableMock(extra={}){
  return {inspectPage:async args=>({fileHash:args.fileHash,revision:args.revision,pageIndex:args.pageIndex,width:612,height:792,truncated:false,cells:[{
    row:12,col:1,cellBbox:[160,360,280,390],alias:'table:'+args.pageIndex+':source-cell-last',selection:{status:'ready',sourceSha256:args.fileHash,revision:args.revision,pageIndex:args.pageIndex,before:'10',anchor:{bbox:[170,370,180,380]}}}]}),...extra};
}
const tableButtons=v=>v.get('paper-before-stage').querySelectorAll('button').filter(n=>n.className==='paper-table-cell');
test('table toolbar markup has clear icon+label modes and fixed same-origin lazy loader',()=>{assert.match(HTML,/id="paper-mode-text"[^>]*><svg[\s\S]*?<\/svg>글 편집/);assert.match(HTML,/id="paper-mode-table"[^>]*><svg[\s\S]*?<\/svg>표 셀 편집/);assert.match(HTML,/<script src="table-pdf.js" defer>/);assert.match(CSS,/paper-table-cell.*focus-visible/);});
test('table: explicit mode lazy-inspects, tight glyph anchor records human edit, legacy receives no page ordinal and undo clears inline',async()=>{
  const calls=[],inspected=[],edits=require('../dist/paper-edits.js'),bytes=pdfBytes('MARKER-GEN'),generated=pdfFile(bytes);
  const adapter=tableMock(),v=mount({edits,tablePdf:tableMock({inspectPage:async args=>{inspected.push(args);return adapter.inspectPage(args);},checkFit:async args=>{assert.deepEqual(args.cells[0].bbox,[160,360,280,390]);return {results:[{id:args.cells[0].id,status:'overflow'}]};}}),paragraphPdf:paragraphMock('Paragraph.'),exporter:{prepare:async request=>{calls.push(request);return {file:generated,sha256:sha(bytes),pageMap:[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i,continuationPageIndices:[]})),verification:{status:'applied',pageCount:{source:2,output:2}}};}}});
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>!v.get('paper-mode-table').disabled,'table mode available');
  assert.equal(inspected.length,0,'plain text mode must not load table engine');
  v.get('paper-mode-table').click();await until(()=>tableButtons(v).length,'table buttons');
  tableButtons(v)[0].click();assert.equal(v.get('paper-inline-before').textContent,'10');
  v.get('paper-inline-after').value='11';v.get('paper-inline-apply').click();
  const saved=v.ws.getEditSnapshot().edits[0];assert.equal(saved.origin,'human');assert.ok(saved.segmentId.startsWith('table:'));
  assert.deepEqual(saved.anchor.bbox,[170,370,180,380]);assert.notDeepEqual(saved.anchor.bbox,[160,360,280,390]);
  v.get('paper-generate').click();await until(()=>calls.length===1,'legacy generation');assert.equal(calls[0].edits[0].anchor.occurrence,undefined);
  assert.equal(saved.anchor.occurrence,0,'core occurrence is local to its immutable alias');
  await until(()=>v.ws.getOutput(),'actual output');await until(()=>/셀 경계를 넘었습니다/.test(v.get('paper-generate-status').textContent),'overflow warning');assert.equal(v.ws.getOutput().file,generated);
  await until(()=>!v.get('paper-generate').disabled,'table generation finished');buttons(v,'edit',saved.id)[0].click();assert.equal(v.document.activeElement.tagName,'textarea');
  v.get('paper-undo').click();assert.equal(v.get('paper-inline').hidden,true);assert.equal(v.ws.getEditSnapshot().edits.length,0);
});
test('table actual engine: twelfth repeated value travels UI to generated bytes without changing other eleven',async()=>{
  const priorBrowser=globalThis.FalsifyBrowserPdf;
  const {pathToFileURL}=require('node:url'),{inspectTables}=await import(pathToFileURL(path.resolve(__dirname,'../dist/table-pdf-worker.mjs')).href),{prepare}=await import(pathToFileURL(path.resolve(__dirname,'../dist/browser-pdf.mjs')).href);
  if(priorBrowser===undefined)delete globalThis.FalsifyBrowserPdf;else globalThis.FalsifyBrowserPdf=priorBrowser;
  let body='0 0 0 RG .5 w\n';for(const x of [40,160,280])body+=`${x} 180 m ${x} 460 l S\n`;for(let i=0;i<=14;i++)body+=`40 ${460-i*20} m 280 ${460-i*20} l S\n`;
  for(let r=0;r<13;r++)for(const [x,t]of [[50,r?'Row'+r:'Name'],[170,r?'10':'Value']])body+=`BT /F1 8 Tf 1 0 0 1 ${x} ${447-r*20} Tm (${t}) Tj ET\n`;
  const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];let raw='%PDF-1.4\n',offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(Buffer.byteLength(raw));raw+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}const xref=Buffer.byteLength(raw);raw+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const source=Buffer.from(raw),file=pdfFile(source),tablePdf={inspectPage:async args=>inspectTables({...args,bytes:await args.file.arrayBuffer()})},v=mount({pages:1,edits:require('../dist/paper-edits.js'),tablePdf,exporter:{prepare}});
  v.file(file);await until(()=>!v.get('paper-mode-table').disabled,'actual table mode');v.get('paper-mode-table').click();await until(()=>tableButtons(v).length>=26,'26 actual cells');
  const last=tableButtons(v).find(n=>n.getAttribute('aria-label')==='13행 2열 · 10');assert.ok(last);last.click();assert.equal(v.get('paper-inline-before').textContent,'10');v.get('paper-inline-after').value='11';v.get('paper-inline-apply').click();v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'actual repeated-value generated PDF');
  const output=new Uint8Array(await v.ws.getOutput().file.arrayBuffer()),mupdf=await import(pathToFileURL(path.resolve(__dirname,'../dist/browser-pdf-vendor/mupdf.js')).href),doc=mupdf.Document.openDocument(output,'application/pdf'),page=doc.loadPage(0),text=page.toStructuredText().asText();
  assert.equal((text.match(/\b10\b/g)||[]).length,11);assert.equal((text.match(/\b11\b/g)||[]).length,1);assert.equal(sha(new Uint8Array(await file.arrayBuffer())),sha(source));page.destroy();doc.destroy();
});
async function mixedFixture(v){
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'mixed first body');clickParagraph(v);v.get('paper-inline-after').value='Expanded source body paragraph.';v.get('paper-inline-apply').click();
  v.get('paper-page-next').click();await until(()=>/^2.*문단을 클릭/.test(v.get('paper-before-status').textContent),'mixed second page');v.get('paper-mode-table').click();await until(()=>tableButtons(v).length,'mixed table cells');tableButtons(v)[0].click();v.get('paper-inline-after').value='11';v.get('paper-inline-apply').click();
}
const pipelineResult=(bytes,inputHash,outputCount=2,map=[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i,continuationPageIndices:[]})),status='applied')=>({file:pdfFile(bytes),sha256:sha(bytes),pageMap:map,verification:{sourceSha256:inputHash,outputSha256:sha(bytes),status,pageCount:{source:2,output:outputCount},edits:[],checks:[]}});
test('mixed UI: actual pipeline receives full original edit list and stage hash chain, remaps table fit after inserted pages',async()=>{
  const {prepare}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href),calls=[],fitCalls=[],a=pdfBytes('TABLE-A'),b=pdfBytes('MARKER-GEN'),finalMap=[{sourcePageIndex:0,outputPageIndex:0,continuationPageIndices:[1]},{sourcePageIndex:1,outputPageIndex:2,continuationPageIndices:[]}];
  const v=mount({edits:require('../dist/paper-edits.js'),pipeline:{prepare:async(req,engines)=>{calls.push({kind:'pipeline',request:req});return prepare(req,engines);}},exporter:{prepare:async req=>{calls.push({kind:'A',request:req});assert.equal(req.edits.length,1);assert.ok(req.edits[0].segmentId.startsWith('table:'));assert.equal(req.edits[0].anchor.occurrence,undefined);return pipelineResult(a,req.fileHash);}},paragraphPdf:paragraphMock('Source body paragraph.',{prepare:async req=>{calls.push({kind:'B',request:req});assert.equal(req.fileHash,sha(a));assert.equal(sha(req.file),sha(a));assert.equal(req.edits.length,1);assert.ok(req.edits[0].segmentId.startsWith('paragraph:'));return pipelineResult(b,req.fileHash,3,finalMap);}}),tablePdf:tableMock({checkFit:async req=>{fitCalls.push(req);return {results:[{id:req.cells[0].id,status:'inside'}]};}})});
  await mixedFixture(v);const original=structuredClone(v.ws.getEditSnapshot().edits);v.log.setPages(3);v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'mixed UI actual output');
  assert.deepEqual(calls.map(c=>c.kind),['pipeline','A','B']);assert.equal(calls[0].request.fileHash,sha(pdfBytes('MARKER-A')));assert.equal(calls[0].request.edits.length,2);assert.equal(calls[0].request.edits.find(e=>e.segmentId.startsWith('table:')).anchor.occurrence,0);assert.deepEqual(v.ws.getEditSnapshot().edits,original);
  const out=v.ws.getOutput();assert.equal(out.originalSourceSha256,sha(pdfBytes('MARKER-A')));assert.equal(out.sha256,sha(b));assert.deepEqual(out.verification.stages.map(s=>[s.inputSha256,s.outputSha256]),[[sha(pdfBytes('MARKER-A')),sha(a)],[sha(a),sha(b)]]);assert.equal(out.verification.independent,false);assert.equal(out.verification.layoutVerified,false);assert.equal(fitCalls[0].cells[0].pageIndex,2);assert.equal(fitCalls[0].pageIndex,2);assert.deepEqual(out.pageMap,finalMap);
});
test('mixed UI: failed stage A keeps actual partial output and explicitly leaves body pending',async()=>{
  const {prepare}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href),a=pdfBytes('READABLE-FAILED-A');let bCalls=0;
  const v=mount({edits:require('../dist/paper-edits.js'),pipeline:{prepare},exporter:{prepare:async req=>pipelineResult(a,req.fileHash,2,undefined,'failed')},paragraphPdf:paragraphMock('Source body paragraph.',{prepare:async()=>{bCalls++;assert.fail('failed A cannot run body');}}),tablePdf:tableMock()});await mixedFixture(v);v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'partial file');assert.equal(bCalls,0);assert.equal(v.ws.getOutput().sha256,sha(a));assert.equal(v.ws.getOutput().verification.status,'failed');assert.equal(v.ws.getOutput().verification.bodyPending,true);assert.match(v.get('paper-generate-status').textContent,/본문 편집은 실행하지 않았습니다/);assert.equal(v.get('paper-current-download').disabled,false);
});
test('mixed UI: readable body draft stays visibly draft with the actual returned file',async()=>{
  const {prepare}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href),a=pdfBytes('TABLE-A'),b=pdfBytes('READABLE-B-DRAFT');
  const v=mount({edits:require('../dist/paper-edits.js'),pipeline:{prepare},exporter:{prepare:async req=>pipelineResult(a,req.fileHash)},paragraphPdf:paragraphMock('Source body paragraph.',{prepare:async req=>pipelineResult(b,req.fileHash,2,undefined,'draft')}),tablePdf:tableMock()});await mixedFixture(v);v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'actual body draft');assert.equal(v.ws.getOutput().sha256,sha(b));assert.equal(v.ws.getOutput().verification.status,'draft');assert.equal(v.ws.getOutput().verification.stages[1].status,'draft');assert.match(v.get('paper-generate-status').textContent,/초안/);assert.equal(v.get('paper-current-download').disabled,false);
});
test('mixed UI: partial and draft per-edit diagnostics remain elements without false stale labels',async()=>{
  const {prepare}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href);
  for(const status of ['failed','draft']){
    const a=pdfBytes('PARTIAL-A'),b=pdfBytes('DRAFT-B');
    const result=(bytes,req,state)=>{const out=pipelineResult(bytes,req.fileHash,2,undefined,state);out.warnings=[{code:'font-substituted',severity:'warning',editId:req.edits[0].id}];return out;};
    const v=mount({edits:require('../dist/paper-edits.js'),pipeline:{prepare},exporter:{prepare:async req=>result(a,req,status==='failed'?'failed':'applied')},paragraphPdf:paragraphMock('Source body paragraph.',{prepare:async req=>result(b,req,'draft')}),tablePdf:tableMock()});
    await mixedFixture(v);v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'diagnostic '+status);
    const causes=v.get('paper-edits').querySelectorAll('span').filter(n=>n.className.includes('paper-edit-cause'));
    assert.ok(causes.length,'per-edit diagnostics must remain span elements');
    assert.ok(causes.some(n=>/글꼴을 대체함/.test(n.textContent)));
    assert.doesNotMatch(textOf(v.get('paper-edits')),/그 사이 편집이 바뀌어|본문 편집은 실행하지 않았습니다|검증을 통과하지 못한 초안입니다/);
    assert.doesNotMatch(v.get('paper-generate-status').textContent,/그 사이 편집이 바뀌어/);
  }
});

test('real combined UI: native table A then v14 paragraph B keep both actual edits without masking status',async()=>{
  const {pathToFileURL}=require('node:url'),priorBrowser=globalThis.FalsifyBrowserPdf,savedFetch=globalThis.fetch;
  const mupdf=await import(pathToFileURL(path.resolve(__dirname,'../dist/browser-pdf-vendor/mupdf.js')).href),selection=await import(pathToFileURL(path.resolve(__dirname,'../dist/browser-pdf.mjs')).href),paragraph=await import(pathToFileURL(path.resolve(__dirname,'../dist/paragraph-pdf.mjs')).href),pipeline=await import(pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href),table=await import(pathToFileURL(path.resolve(__dirname,'../dist/table-pdf-worker.mjs')).href);
  if(priorBrowser===undefined)delete globalThis.FalsifyBrowserPdf;else globalThis.FalsifyBrowserPdf=priorBrowser;
  globalThis.fetch=async input=>{const url=new URL(input);assert.equal(url.protocol,'file:');assert.ok(url.pathname.includes('/paragraph-vendor/'));return new Response(fs.readFileSync(url));};
  const before='Original paragraph has enough words to establish a reasonable source column width.',after='Every requested sentence remains present while the paragraph expands in its original column. '.repeat(4).trim();
  const d=new mupdf.PDFDocument();let source;
  try{const font=d.addSimpleFont(new mupdf.Font('Helvetica')),body=`BT /F1 12 Tf 72 700 Td (${before}) Tj 0 -25 Td (Following paragraph remains readable.) Tj 0 -475 Td (Lower body paragraph gives the column room to grow.) Tj 0 -165 Td (1) Tj ET`;let grid='0 0 0 RG .5 w\n';for(const x of [40,160,280])grid+=`${x} 440 m ${x} 720 l S\n`;for(let r=0;r<=14;r++)grid+=`40 ${720-r*20} m 280 ${720-r*20} l S\n`;for(let r=0;r<13;r++)for(const [x,t]of [[50,r?'Row'+r:'Name'],[170,r?'10':'Value']])grid+=`BT /F1 8 Tf ${x} ${707-r*20} Td (${t}) Tj ET\n`;for(const content of [body,grid])d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},content));const b=d.saveToBuffer();try{source=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
  try{
    const file=pdfFile(source),v=mount({edits:require('../dist/paper-edits.js'),pipeline,exporter:selection,paragraphPdf:paragraph,tablePdf:{inspectPage:async args=>table.inspectTables({...args,bytes:await args.file.arrayBuffer()}),checkFit:async args=>table.checkFit({...args,bytes:await args.file.arrayBuffer()})}});v.file(file);await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'native body inspection');const found=await paragraph.inspectPage({file,fileHash:sha(source),pageIndex:0}),p=found.paragraphs.find(p=>p.text.includes('Original paragraph'));assert.ok(p);clickParagraph(v,(p.bbox[0]+p.bbox[2])/2,(p.bbox[1]+p.bbox[3])/2);assert.match(v.get('paper-inline-before').textContent,/Original paragraph/);v.get('paper-inline-after').value=after;v.get('paper-inline-apply').click();
    v.get('paper-page-next').click();await until(()=>/^2.*문단을 클릭/.test(v.get('paper-before-status').textContent),'native table page');v.get('paper-mode-table').click();await until(()=>tableButtons(v).length>=26,'native table cells');const last=tableButtons(v).find(n=>n.getAttribute('aria-label')==='13행 2열 · 10');assert.ok(last);last.click();v.get('paper-inline-after').value='11';v.get('paper-inline-apply').click();v.get('paper-generate').click();await until(()=>v.ws.getOutput()||/생성하지 못했습니다/.test(v.get('paper-generate-status').textContent),'native mixed output');const out=v.ws.getOutput();assert.ok(out,v.get('paper-generate-status').textContent);assert.equal(out.verification.stages.length,2);assert.equal(out.verification.sourceSha256,sha(source));assert.equal(out.verification.stages[1].inputSha256,out.verification.stages[0].outputSha256);assert.equal(out.verification.status,out.verification.stages[1].status==='applied'&&out.verification.stages[0].status==='warning'?'warning':out.verification.stages[1].status);const final=new Uint8Array(await out.file.arrayBuffer());assert.equal(sha(final),out.sha256);assert.equal(sha(new Uint8Array(await file.arrayBuffer())),sha(source));
    const doc=mupdf.Document.openDocument(final,'application/pdf'),texts=[];try{for(let i=0;i<doc.countPages();i++){const page=doc.loadPage(i),st=page.toStructuredText();texts.push(st.asText());st.destroy();page.destroy();}}finally{doc.destroy();}assert.equal((texts.join('\n').match(/\b10\b/g)||[]).length,11);assert.equal((texts.join('\n').match(/\b11\b/g)||[]).length,1);assert.ok(texts.join(' ').replace(/\s+/g,' ').includes(after));
  }finally{globalThis.fetch=savedFetch;}
});

test('mixed UI: raw human B uses legacy first and exact long-room fallback contains no table edits',async()=>{
  const {prepare}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href),calls=[],a=pdfBytes('TABLE-A'),b=pdfBytes('MARKER-GEN');
  const v=mount({pipeline:{prepare},exporter:{prepare:async req=>{if(req.edits.some(e=>e.segmentId.startsWith('table:'))){calls.push('table-A');assert.equal(req.edits.length,1);return pipelineResult(a,req.fileHash);}calls.push('body-legacy');throw Object.assign(new Error('no room'),{code:'unsupported',details:{edits:[{code:'long-after-no-room'}]}});}},paragraphPdf:{prepare:async req=>{calls.push('body-flow');assert.equal(req.fileHash,sha(a));assert.ok(req.edits.every(e=>!e.segmentId.startsWith('table:')));return pipelineResult(b,req.fileHash);}}});
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>v.ws.getEditSnapshot(),'raw mixed source');v.edits.last.add({segmentId:'table:1:manual',pageIndex:1,before:'10',after:'11',anchor:{bbox:[170,370,180,380],occurrence:0},origin:'human'});v.edits.last.add({segmentId:'raw0',pageIndex:0,before:'Before',after:'Long after',origin:'human'});v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'raw mixed output');assert.deepEqual(calls,['table-A','body-legacy','body-flow']);
});
test('mixed UI: missing/duplicate identity maps never check table on an assumed original output page',async()=>{
  for(const badMap of [null,[{sourcePageIndex:0,outputPageIndex:0},{sourcePageIndex:0,outputPageIndex:1}],[{sourcePageIndex:0,outputPageIndex:0,continuationPageIndices:[2]},{sourcePageIndex:1,outputPageIndex:0,continuationPageIndices:[]}],[{sourcePageIndex:0,outputPageIndex:0,continuationPageIndices:[3]},{sourcePageIndex:1,outputPageIndex:1,continuationPageIndices:[]}]]){let fitCalls=0;const bytes=pdfBytes('MARKER-GEN'),v=mount({edits:require('../dist/paper-edits.js'),pipeline:{prepare:async req=>({file:pdfFile(bytes),sha256:sha(bytes),pageMap:badMap,verification:{status:'warning',pageCount:{source:2,output:3}}})},paragraphPdf:paragraphMock('Source body paragraph.',{prepare:async()=>assert.fail('mock pipeline owns body')}),exporter:{prepare:async()=>assert.fail('mock pipeline owns stages')},tablePdf:tableMock({checkFit:async()=>{fitCalls++;return {results:[]};}})});await mixedFixture(v);v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'unverified map output');assert.equal(fitCalls,0);assert.match(v.get('paper-generate-status').textContent,/出力|출력 쪽 대응/);assert.equal(v.ws.getOutput().verification.tableCellFit.reason,'output-page-map-unverified');}
});
test('mixed UI: same-page missing body bbox refuses before either engine, no whole-table paragraph fallback',async()=>{
  const {prepare}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../src/pdf-edit-pipeline.mjs')).href);let engines=0;
  const v=mount({pipeline:{prepare},exporter:{prepare:async()=>{engines++;}},paragraphPdf:{prepare:async()=>{engines++;}}});v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>v.ws.getEditSnapshot(),'missing-box mixed source');v.edits.last.add({segmentId:'table:0:manual',pageIndex:0,before:'10',after:'11',anchor:{bbox:[170,370,180,380]},origin:'human'});v.edits.last.add({segmentId:'raw0',pageIndex:0,before:'Before',after:'Long after',origin:'human'});v.get('paper-generate').click();await until(()=>/생성하지 못했습니다/.test(v.get('paper-generate-status').textContent),'conservative rejection');assert.equal(engines,0);assert.equal(v.ws.getOutput(),null);
});
test('pipeline loader precedes workspace, while single-kind body and table routes bypass mixed pipeline',async()=>{
  assert.ok(HTML.indexOf('src="pdf-edit-pipeline.js"')<HTML.indexOf('src="paper-workspace.js"'));let pipelineCalls=0,bodyCalls=0,tableCalls=0;
  const v=mount({edits:require('../dist/paper-edits.js'),pipeline:{prepare:async()=>{pipelineCalls++;}},paragraphPdf:paragraphMock('Body paragraph.',{prepare:async req=>{bodyCalls++;return pipelineResult(pdfBytes('MARKER-GEN'),req.fileHash);}}),exporter:{prepare:async req=>{tableCalls++;return pipelineResult(pdfBytes('MARKER-GEN'),req.fileHash);}},tablePdf:tableMock()});v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'single body');clickParagraph(v);v.get('paper-inline-after').value='Changed body.';v.get('paper-inline-apply').click();v.get('paper-generate').click();await until(()=>bodyCalls===1&&!v.get('paper-generate').disabled,'body bypass');v.get('paper-undo').click();v.get('paper-mode-table').click();await until(()=>tableButtons(v).length,'single table');tableButtons(v)[0].click();v.get('paper-inline-after').value='11';v.get('paper-inline-apply').click();v.get('paper-generate').click();await until(()=>tableCalls===1,'table bypass');assert.equal(pipelineCalls,0);
});

test('table: late responses cannot cross source, page, mode or revision and unsupported cells cannot open After',async()=>{
  const pending=[],v=mount({edits:require('../dist/paper-edits.js'),tablePdf:tableMock({inspectPage:args=>new Promise(resolve=>pending.push({args,resolve}))})});
  const ready=tableMock();v.file(pdfFile(pdfBytes('MARKER-A'),'a.pdf'));await until(()=>!v.get('paper-mode-table').disabled,'ready A');v.get('paper-mode-table').click();await until(()=>pending.length===1,'pending A');
  v.file(pdfFile(pdfBytes('MARKER-B'),'b.pdf'));await until(()=>pending.length===2,'pending B');assert.equal(pending[0].args.signal.aborted,true);
  pending[0].resolve(await ready.inspectPage(pending[0].args));await settle();assert.equal(tableButtons(v).length,0);
  v.get('paper-mode-text').click();assert.equal(pending[1].args.signal.aborted,true);pending[1].resolve(await ready.inspectPage(pending[1].args));await settle();assert.equal(tableButtons(v).length,0);
  v.get('paper-mode-table').click();await until(()=>pending.length===3,'third inspect');
  const unsupported=await ready.inspectPage(pending[2].args);unsupported.cells[0].selection={status:'unsupported',reason:'multi-run-cell'};pending[2].resolve(unsupported);await until(()=>tableButtons(v).length,'unsupported drawn');tableButtons(v)[0].click();assert.equal(v.get('paper-inline').hidden,true);assert.match(v.get('paper-table-status').textContent,/여러 글 조각/);
  v.get('paper-page-next').click();await until(()=>pending.length===4,'page two inspect');assert.equal(pending[3].args.pageIndex,1);
});
test('table draft: explicit restore re-inspects only saved pages and deterministic source aliases; mismatch refuses whole restore',async()=>{
  const edits=require('../dist/paper-edits.js'),storage=memory(),file=pdfFile(pdfBytes('MARKER-A')),first=mount({edits,storage,tablePdf:tableMock()});
  first.file(file);await until(()=>!first.get('paper-mode-table').disabled,'first ready');first.get('paper-mode-table').click();await until(()=>tableButtons(first).length,'cells');tableButtons(first)[0].click();first.get('paper-inline-after').value='11';first.get('paper-inline-apply').click();
  first.get('paper-draft-opt').checked=true;first.get('paper-draft-opt').dispatchEvent(new Event('change'));first.get('paper-draft-save').click();await until(()=>storage.keys().some(k=>k.startsWith('falsify.paper-draft.v1.')),'table edit draft saved');
  const inspected=[],adapter=tableMock(),second=mount({edits,storage,tablePdf:tableMock({inspectPage:async args=>{inspected.push(args.pageIndex);return adapter.inspectPage(args);}})});second.file(file);await until(()=>second.ws.getEditSnapshot(),'second ready');
  assert.equal(inspected.length,0);assert.equal(second.ws.getEditSnapshot().edits.length,0);second.get('paper-draft-restore').click();await until(()=>second.ws.getEditSnapshot().edits.length===1,'restored cell');assert.deepEqual(inspected,[0]);assert.equal(second.ws.getEditSnapshot().edits[0].after,'11');
  const third=mount({edits,storage,tablePdf:tableMock({inspectPage:async args=>{const r=await adapter.inspectPage(args);r.cells[0].alias+='wrong';return r;}})});third.file(file);await until(()=>third.ws.getEditSnapshot(),'third ready');third.get('paper-draft-restore').click();await until(()=>/복구하지 않았습니다/.test(third.get('paper-draft-status').textContent),'restore refused');assert.equal(third.ws.getEditSnapshot().edits.length,0);
});

test('paragraph: a click edits the exact inspected paragraph with human origin and source coordinates; pending text survives another click',async()=>{
  const text='A full paragraph.\nSecond line.';
  const v=mount({paragraphPdf:paragraphMock(text)});v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'inspected paragraph');
  clickParagraph(v);
  assert.equal(v.get('paper-inline-before').textContent,text);assert.equal(v.get('paper-inline-after').value,text);
  assert.equal(v.ws.getEditSnapshot().edits.length,0,'opening the editor does not apply');
  const editor=v.document.activeElement;editor.value='My full replacement paragraph.';editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));
  assert.equal(v.edits.added.length,1);const edit=v.edits.added[0];
  assert.equal(edit.before,text);assert.equal(edit.after,'My full replacement paragraph.');assert.equal(edit.origin,'human');
  assert.equal(edit.pageIndex,0);assert.equal(edit.segmentId,'paragraph:0:p0');
  assert.deepEqual(edit.anchor,{start:0,end:text.length,occurrence:0,bbox:[72,80,540,140]});
  v.get('paper-undo').click();assert.equal(v.ws.getEditSnapshot().edits.length,0);
  v.get('paper-redo').click();assert.equal(v.ws.getEditSnapshot().edits.length,1);
});
test('paragraph list: native button opens the same source binding and stale page controls cannot reopen',async()=>{
  const v=mount({paragraphPdf:paragraphMock('Keyboard paragraph.'),tablePdf:tableMock()});v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'paragraph list');
  const stage=v.get('paper-before-stage'),list=stage.children.find(e=>e.tagName==='details');
  assert.ok(list);assert.equal(list.children[0].tagName,'summary');
  const button=list.querySelectorAll('button')[0];assert.equal(button.type,'button');assert.equal(button.textContent,'Keyboard paragraph.');
  button.focus();button.click();const editor=v.document.activeElement;assert.equal(editor.tagName,'textarea');
  assert.equal(v.get('paper-inline-before').textContent,'Keyboard paragraph.');editor.value='Keyboard replacement.';editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));
  const edit=v.ws.getEditSnapshot().edits[0];assert.equal(edit.segmentId,'paragraph:0:p0');assert.deepEqual(edit.anchor.bbox,[72,80,540,140]);
  v.get('paper-page-next').click();assert.ok(!stage.children.includes(list));button.click();assert.equal(v.get('paper-inline').hidden,true);
  await until(()=>/^2.*문단을 클릭/.test(v.get('paper-before-status').textContent),'next page list');
  const next=stage.children.find(e=>e.tagName==='details'),nextButton=next.querySelectorAll('button')[0];
  v.get('paper-mode-table').click();assert.ok(!stage.children.includes(next));nextButton.click();assert.equal(v.get('paper-inline').hidden,true);
  v.get('paper-mode-text').click();await until(()=>stage.children.some(e=>e.tagName==='details'),'restored paragraph list');
  const old=stage.children.find(e=>e.tagName==='details'),oldButton=old.querySelectorAll('button')[0];
  v.get('paper-file').files=[];v.get('paper-file').dispatchEvent(new Event('change'));
  assert.ok(!stage.children.includes(old));oldButton.click();assert.equal(v.get('paper-inline').hidden,true);
});
test('paragraph: a late inspection is aborted and cannot bind the next source; drag selection remains available',async()=>{
  let resolveA,signalA;
  const adapter=paragraphMock('New paragraph.',{inspectPage:async({file,pageIndex,signal})=>{
    const fileHash=sha(Buffer.from(await file.arrayBuffer()));
    if(file.name==='a.pdf'){signalA=signal;return new Promise(resolve=>{resolveA=()=>resolve({fileHash,pageIndex,width:612,height:792,rotation:0,paragraphs:[{id:'old',text:'Old paragraph.',bbox:[72,80,540,140]}]});});}
    return {fileHash,pageIndex,width:612,height:792,rotation:0,paragraphs:[{id:'new',text:'New paragraph.',bbox:[72,80,540,140]}]};
  }});
  const v=mount({paragraphPdf:adapter});v.file(pdfFile(pdfBytes('MARKER-A'),'a.pdf'));
  await until(()=>resolveA,'inspection A');v.file(pdfFile(pdfBytes('MARKER-B'),'b.pdf'));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'inspection B');
  assert.equal(signalA.aborted,true);resolveA();await settle();
  v.document.getSelection=()=>({isCollapsed:false});clickParagraph(v);assert.equal(v.get('paper-inline').hidden,true);
  v.document.getSelection=()=>null;clickParagraph(v);assert.equal(v.get('paper-inline-before').textContent,'New paragraph.');
  assert.ok(v.ws.getSource().segments.every(s=>s.text!=='Old paragraph.'));
});
test('paragraph output: preferred adapter retains page map and previews mapped continuation bytes; an invalid map makes no page claim',async()=>{
  const bytes=pdfBytes('MARKER-GEN'),file=pdfFile(bytes,'edited.pdf');let calls=0;
  const map=[{sourcePageIndex:0,outputPageIndex:1,continuationPageIndices:[2]},{sourcePageIndex:1,outputPageIndex:0,continuationPageIndices:[]}];
  const adapter=paragraphMock('A full paragraph.',{prepare:async args=>{calls++;assert.equal(args.fileHash,sha(pdfBytes('MARKER-A')));return {file,sha256:sha(bytes),verification:{status:'warning'},pageMap:map};}});
  const v=mount({paragraphPdf:adapter,exporter:{prepare:async()=>{assert.fail('canonical paragraph must use the flow adapter');}}});v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'inspected paragraph');clickParagraph(v);
  v.get('paper-inline-after').value='Longer flowing replacement.';v.get('paper-inline-apply').click();
  v.log.setPages(3);v.get('paper-generate').click();
  await until(()=>v.get('paper-after-stage').children[0]?.painted===2,'mapped original page');
  assert.equal(calls,1);assert.deepEqual(v.ws.getOutput().pageMap,map);
  const nav=v.created.find(e=>e.className==='paper-after-nav');assert.equal(nav.hidden,false);
  nav.children[2].click();await until(()=>v.get('paper-after-stage').children[0]?.painted===3,'continuation page');
  assert.match(v.get('paper-after-status').textContent,/이어지는 쪽/);
  assert.deepEqual(v.log.received.at(-1),bytes);
  v.get('paper-page-next').click();await until(()=>v.get('paper-after-stage').children[0]?.painted===1,'mapped second source page');
  assert.equal(nav.hidden,true);
  map[1].outputPageIndex=99;v.get('paper-generate').click();
  await until(()=>/페이지 대응이 없습니다/.test(v.get('paper-after-status').textContent),'invalid map diagnostic');
  assert.equal(v.get('paper-after-stage').children.length,0);assert.ok(v.ws.getOutput(),'verified bytes remain downloadable');
});


test('mixed document flow preview uses content output pages and refuses present malformed content map',async()=>{
  const bytes=pdfBytes('MARKER-GEN'),file=pdfFile(bytes),map=[{sourcePageIndex:0,outputPageIndex:0,continuationPageIndices:[],contentOutputPageIndices:[0,1]},{sourcePageIndex:1,outputPageIndex:1,continuationPageIndices:[2],contentOutputPageIndices:[1,2]}];
  const v=mount({paragraphPdf:paragraphMock('Paragraph.',{prepare:async()=>({file,sha256:sha(bytes),pageMap:map})})});v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'mixed source');clickParagraph(v);v.get('paper-inline-after').value='Rewritten paragraph.';v.get('paper-inline-apply').click();v.log.setPages(3);v.get('paper-generate').click();await until(()=>v.get('paper-after-stage').children[0]?.painted===1,'first mixed output');
  const nav=v.created.find(n=>n.className==='paper-after-nav');assert.equal(nav.hidden,false);nav.children[2].click();await until(()=>v.get('paper-after-stage').children[0]?.painted===2,'body continued in original next page');
  v.get('paper-page-next').click();await until(()=>v.get('paper-after-stage').children[0]?.painted===2&&nav.children[1].textContent.includes('원본 2쪽'),'next source shares mixed page');nav.children[2].click();await until(()=>v.get('paper-after-stage').children[0]?.painted===3,'next source reaches final page');
  for(const invalid of [[],[1,1],[1,3],[2,1],null]){map[1].contentOutputPageIndices=invalid;v.get('paper-generate').click();await until(()=>/페이지 대응이 없습니다/.test(v.get('paper-after-status').textContent),'malformed mixed map refused');assert.equal(v.get('paper-after-stage').children.length,0);assert.ok(v.ws.getOutput());}
});

test('paragraph core: discovering another page appends source bindings without losing human edit undo history',async()=>{
  const edits=require('../dist/paper-edits.js');
  const v=mount({edits,paragraphPdf:paragraphMock('Canonical paragraph.\nLine two.')});v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'first paragraph');
  clickParagraph(v);v.get('paper-inline-after').value='First replacement.';v.get('paper-inline-apply').click();
  assert.equal(v.ws.getEditSnapshot().edits.length,1);const first=v.ws.getEditSnapshot().edits[0];
  v.get('paper-page-next').click();
  await until(()=>/^2 \/ 2쪽.*문단을 클릭/.test(v.get('paper-before-status').textContent),'second paragraph');
  clickParagraph(v);v.get('paper-inline-after').value='Second replacement.';v.get('paper-inline-apply').click();
  assert.equal(v.ws.getEditSnapshot().edits.length,2);assert.equal(v.ws.getEditSnapshot().edits[0].id,first.id);
  v.get('paper-undo').click();assert.equal(v.ws.getEditSnapshot().edits.length,1);
  v.get('paper-undo').click();assert.equal(v.ws.getEditSnapshot().edits.length,0);
});


test('paragraph draft: explicit restore verifies only saved pages and rebinds exact canonical edits across pages',async()=>{
  const edits=require('../dist/paper-edits.js'),storage=memory(),file=pdfFile(pdfBytes('MARKER-A'));
  const adapter=paragraphMock('Canonical paragraph.\nLine two.');
  const first=mount({edits,storage,paragraphPdf:adapter});first.file(file);
  await until(()=>/문단을 클릭/.test(first.get('paper-before-status').textContent),'draft page one');
  clickParagraph(first);first.get('paper-inline-after').value='First saved replacement.';first.get('paper-inline-apply').click();
  first.get('paper-page-next').click();
  await until(()=>/^2 \/ 2쪽.*문단을 클릭/.test(first.get('paper-before-status').textContent),'draft page two');
  clickParagraph(first);first.get('paper-inline-after').value='Second saved replacement.';first.get('paper-inline-apply').click();
  const saved=first.ws.getEditSnapshot();first.get('paper-draft-opt').checked=true;first.get('paper-draft-save').click();
  await until(()=>storage.keys().some(k=>k.startsWith('falsify.paper-draft.v1.')),'saved draft');
  const inspected=[],second=mount({edits,storage,paragraphPdf:paragraphMock('',{inspectPage:async args=>{inspected.push(args.pageIndex);return adapter.inspectPage(args);}})});
  second.file(file);await until(()=>/문단을 클릭/.test(second.get('paper-before-status').textContent),'new source initial page');
  assert.equal(second.ws.getEditSnapshot().edits.length,0,'a matching draft never restores automatically');
  second.get('paper-draft-restore').click();await until(()=>second.ws.getEditSnapshot().edits.length===2,'two restored edits');
  assert.deepEqual(inspected,[0,0,1],'only unique saved pages are inspected during explicit restore');
  const restored=second.ws.getEditSnapshot();assert.equal(restored.canUndo,false,'restored history starts at this session');
  assert.deepEqual(restored.edits.map(e=>({id:e.id,before:e.before,after:e.after,origin:e.origin,anchor:e.anchor})),saved.edits.map(e=>({id:e.id,before:e.before,after:e.after,origin:e.origin,anchor:e.anchor})));
  clickParagraph(second);second.get('paper-inline-after').value='Revised after restoring.';second.get('paper-inline-apply').click();
  second.get('paper-undo').click();assert.equal(second.ws.getEditSnapshot().edits[0].after,'First saved replacement.');
});


test('proposal aliases: exact same-page canonical aliases prefer the original while real duplicate quotes stay ambiguous',()=>{
  const raw={id:'raw0',pageIndex:0,text:'Latin words. Other text.'},alias={id:'paragraph:0:p0',pageIndex:0,text:'Latin words.'};
  const classify=segments=>api.classifyProposals([{before:'words',after:'changed'}],segments,{origin:'external-ai-import'}).items[0];
  assert.equal(classify([raw,alias]).status,'matched');assert.equal(classify([raw,alias]).segmentId,'raw0');
  assert.equal(classify([raw,alias,{id:'raw1',pageIndex:1,text:'More words.'}]).status,'ambiguous');
  assert.equal(classify([{...raw,text:'Latin words. Latin words.'},alias]).status,'ambiguous');
  assert.equal(classify([raw,{...alias,text:'Novel words.'}]).status,'ambiguous','unproven aliases remain separate');
  const explicit=api.classifyProposals([{segmentId:alias.id,before:'words',after:'changed'}],[raw,alias],{origin:'external-ai-import'}).items[0];
  assert.equal(explicit.segmentId,alias.id);assert.equal(explicit.status,'matched');
});
test('export intent: legacy source edits stay on MuPDF; only an exact unsupported long-room failure reflows the whole batch',async()=>{
  const bytes=pdfBytes('MARKER-GEN'),file=pdfFile(bytes,'edited.pdf'),result={file,sha256:sha(bytes),verification:{status:'warning'}};
  const calls=[],flow=[],text='Latin words. Other text.';let failure=null,firstStarted=false,releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const v=mount({paragraphPdf:paragraphMock(text,{prepare:async request=>{flow.push(request);return result;}}),exporter:{prepare:async request=>{if(!calls.length){firstStarted=true;await firstGate;}calls.push(request);if(failure)throw failure;return result;}}});
  const source=pdfFile(pdfBytes('MARKER-A'));v.file(source);await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'export intent source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file:source,result:{segments:[{id:'raw0',pageIndex:0,text}]}}}));
  v.edits.last.add({segmentId:'raw0',pageIndex:0,before:'Latin',after:'Hello한국어',origin:'human'});
  v.edits.last.add({segmentId:'raw0',pageIndex:0,before:'Other',after:'Another replacement',origin:'human'});
  assert.equal(v.ws.getEditSnapshot().edits.length,2);v.get('paper-generate').click();
  await until(()=>firstStarted,'held legacy engine entered');assert.equal(v.ws.getOutput(),null);assert.equal(flow.length,0);releaseFirst();
  await until(()=>calls.length===1&&v.ws.getOutput()&&!v.get('paper-generate').disabled,'legacy selection generation completed');
  assert.equal(calls.length,1);assert.equal(flow.length,0);assert.equal(v.ws.getOutput().verification.status,'warning');
  failure=Object.assign(new Error('no room'),{code:'unsupported',details:{edits:[{code:'long-after-no-room'}]}});
  v.get('paper-generate').click();await until(()=>flow.length===1&&!v.get('paper-generate').disabled,'exact long-room fallback completed');assert.equal(flow.length,1);
  assert.deepEqual(flow[0].edits,calls[1].edits);assert.equal(flow[0].edits.length,2);assert.equal(flow[0].edits[0].after,'Hello한국어');
  for(const error of [
    {code:'aborted',details:{edits:[{code:'long-after-no-room'}]}},
    {code:'stale-source',details:{edits:[{code:'long-after-no-room'}]}},
    {code:'unsupported',details:{edits:[{code:'long-after-no-room'},{code:'ambiguous-anchor'}]}},
    {code:'unsupported',details:{edits:[{code:'anchor-mismatch'}]}}
  ]){failure=Object.assign(new Error('guarded failure'),error);const expectedCalls=calls.length+1;v.get('paper-generate').click();await until(()=>calls.length===expectedCalls&&!v.get('paper-generate').disabled&&/생성하지 못했습니다|생성을 중단했습니다/.test(v.get('paper-generate-status').textContent),'guarded selection failure completed');assert.equal(flow.length,1,'no fallback for '+JSON.stringify(error));}
  assert.equal(v.ws.getOutput().file,file,'failure preserves the last real output');
});
test('proposal acceptance: a source-segment substring cannot overlap a canonical paragraph edit through an alias',async()=>{
  const text='Latin words. Other text.',v=mount({paragraphPdf:paragraphMock('Latin words.')});const file=pdfFile(pdfBytes('MARKER-A'));
  v.file(file);await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'overlap source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'raw0',pageIndex:0,text}]}}}));
  clickParagraph(v);v.get('paper-inline-after').value='Changed paragraph.';v.get('paper-inline-apply').click();assert.equal(v.ws.getEditSnapshot().edits.length,1);
  const rejected=v.ws.acceptProposals([{segmentId:'raw0',before:'words',after:'overlap'}],{origin:'external-ai-import',confirmed:true});
  assert.equal(rejected.applied,0);assert.equal(v.ws.getEditSnapshot().edits.length,1);assert.match(v.get('paper-proposal-status').textContent,/같은 위치/);
  const added=v.ws.acceptProposals([{segmentId:'raw0',before:'Other',after:'Separate'}],{origin:'external-ai-import',confirmed:true});
  assert.equal(added.applied,1);assert.equal(v.ws.getEditSnapshot().edits.length,2);
});


test('export intent: an eight-item external rewrite batch with source-proven hyphenated Before routes directly to paragraph flow',async()=>{
  const bytes=pdfBytes('MARKER-GEN'),file=pdfFile(bytes,'edited.pdf'),calls=[];
  const quotes=Array.from({length:8},(_,i)=>i===0?'This prag-\nmatic approach.':'Unique source quotation '+i+'.');
  const v=mount({paragraphPdf:{prepare:async request=>{calls.push(request);return {file,sha256:sha(bytes),verification:{status:'applied'}};}},exporter:{prepare:async()=>assert.fail('external rewrite batch must not visit legacy exact selection adapter')}});
  const source=pdfFile(pdfBytes('MARKER-A'));v.file(source);await until(()=>v.ws.getSource()?.fileHash,'external source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file:source,result:{segments:quotes.map((text,i)=>({id:'raw'+i,pageIndex:0,text}))}}}));
  const result=v.ws.acceptProposals(quotes.map((before,i)=>({segmentId:'raw'+i,before,after:'A full flowing replacement paragraph '+i+'.'})),{origin:'external-ai-import',confirmed:true});
  assert.equal(result.applied,8);v.get('paper-generate').click();await until(()=>calls.length===1&&v.ws.getOutput()&&!v.get('paper-generate').disabled,'external rewrite generation completed');
  assert.equal(calls.length,1);assert.equal(calls[0].edits.length,8);assert.equal(calls[0].edits[0].before,'This prag-\nmatic approach.');
  assert.ok(calls[0].edits.every(e=>e.origin==='external-ai-import'));assert.equal(v.ws.getOutput().verification.status,'applied');
});

test('paragraph preparation is reused for the same original page and reset for a different file',async()=>{
  const calls=[],adapter=paragraphMock('Cached paragraph.');
  const v=mount({paragraphPdf:paragraphMock('Cached paragraph.',{inspectPage:async request=>{calls.push(request);return adapter.inspectPage(request);}})});
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'first prepared page');
  assert.equal(calls.length,1);
  v.get('paper-zoom-in').click();await settle();
  assert.equal(calls.length,1,'zoom reuses page-point source geometry');
  v.get('paper-mode-text').click();await settle();assert.equal(calls.length,1,'reopening text tools reuses source geometry');
  v.file(pdfFile(pdfBytes('MARKER-B')));await until(()=>calls.length===2&&/문단을 클릭/.test(v.get('paper-before-status').textContent),'new original inspected');
  assert.notEqual(calls[0].fileHash,calls[1].fileHash);
  assert.equal(v.ws.getEditSnapshot().edits.length,0);
});

test('a font requiring complete embedding uses the full-font writer',async()=>{
  let paragraphCalls=0;const selected=[],bytes=pdfBytes('FULL-FONT');
  const fonts={revision:0,list:()=>[],resolve:async()=>({revision:0,digest:'full-font',fonts:[{fsType:256,bytes:new Uint8Array([1])}]})};
  const adapter=paragraphMock('Original paragraph.',{prepare:async()=>{paragraphCalls++;throw new Error('wrong writer');}});
  const v=mount({fonts,paragraphPdf:adapter,exporter:{prepare:async r=>{selected.push(r);return {file:pdfFile(bytes),sha256:sha(bytes),verification:{status:'applied'}};}}});
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'full-font source');
  clickParagraph(v);v.get('paper-inline-after').value='Edited paragraph.';v.get('paper-inline-apply').click();
  v.get('paper-generate').click();await until(()=>v.ws.getOutput()&&!v.get('paper-generate').disabled,'full-font output');
  assert.equal(paragraphCalls,0);assert.equal(selected.length,1);assert.equal(selected[0].fontSnapshot.fonts[0].fsType,256);
});

test('font buttons pass a frozen font snapshot to PDF generation and mark the previous file stale',async()=>{
  let revision=0,localCalls=0;const requests=[],bytes=pdfBytes('FONT-GENERATED');
  const fonts={get revision(){return revision;},list:()=>[{family:'Example',source:'local'}],requestLocalFonts:async()=>{localCalls++;revision++;},resolve:async requirements=>{assert.ok(requirements.length);return {revision,digest:'fonts-'+revision,fonts:[{id:'private-font',bytes:new Uint8Array([4,5,6])}]};}};
  const adapter=paragraphMock('Original paragraph.',{prepare:async r=>{requests.push(r);return {file:pdfFile(bytes),sha256:sha(bytes),verification:{status:'applied'}};}});
  const v=mount({fonts,paragraphPdf:adapter});v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'font source');
  clickParagraph(v);v.get('paper-inline-after').value='Edited paragraph.';v.get('paper-inline-apply').click();
  v.get('paper-generate').click();await until(()=>v.ws.getOutput()&&!v.get('paper-generate').disabled,'font generated');
  assert.equal(requests.length,1);assert.ok(requests[0].fontSnapshot.fonts[0].bytes instanceof Uint8Array);
  assert.doesNotMatch(JSON.stringify(v.ws.getOutput()),/private-font/);
  v.get('paper-font-local').click();assert.equal(localCalls,1,'local access starts inside click');
  await until(()=>/사용 가능/.test(v.get('paper-font-status').textContent),'local fonts');
  assert.equal(v.get('paper-current-download').textContent,'마지막 생성본 다운로드');
  assert.match(v.get('paper-generate-status').textContent,/글꼴이 바뀌었습니다/);
  v.get('paper-generate').click();await until(()=>requests.length===2&&!v.get('paper-generate').disabled,'regenerated fonts');
  assert.equal(requests[1].fontSnapshot.digest,'fonts-1');assert.equal(v.get('paper-current-download').textContent,'현재 생성본 다운로드');
});

test('generation failure identifies pages and causes while preserving edits and last output',async()=>{
  const file=pdfFile(pdfBytes('MARKER-GEN'),'edited.pdf');let failure=null;
  const v=mount({paragraphPdf:{...paragraphMock('Original paragraph.'),prepare:async()=>{
    if(failure)throw failure;return {file,sha256:sha(pdfBytes('MARKER-GEN')),verification:{status:'applied'}};
  }}});
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'source');
  clickParagraph(v);v.get('paper-inline-after').value='Replacement paragraph.';v.get('paper-inline-apply').click();
  v.get('paper-generate').click();await until(()=>v.ws.getOutput()&&!v.get('paper-generate').disabled,'first output');
  failure=Object.assign(new Error('2 edit(s) could not be matched exactly once or planned'),{code:'MATCH_FAILED',details:{failures:[{pageIndex:9,code:'NOT_FOUND'},{pageIndex:18,code:'AMBIGUOUS_MATCH'}]}});
  v.get('paper-generate').click();await until(()=>/생성하지 못했습니다/.test(v.get('paper-generate-status').textContent)&&!v.get('paper-generate').disabled,'failure');
  assert.match(v.get('paper-generate-status').textContent,/쪽 10 · 원문 인용의 위치를 찾지 못했습니다/);
  assert.match(v.get('paper-generate-status').textContent,/쪽 19 · 같은 원문 인용이 여러 곳에 있습니다/);
  assert.equal(v.ws.getOutput().file,file);assert.equal(v.ws.getEditSnapshot().edits[0].after,'Replacement paragraph.');
});

test('direct editing and chosen recomposition keep multiple page edits and exact output bytes',async()=>{
  const original=pdfFile(pdfBytes('MARKER-A')), bytes=pdfBytes('MARKER-GEN'), result=pdfFile(bytes,'result.pdf'),calls=[];
  const v=mount({edits:require('../dist/paper-edits.js'),paragraphPdf:paragraphMock('Original paragraph.'),recompositionPdf:{prepare:async req=>{calls.push(req);return {file:result,sha256:sha(bytes),revision:req.revision,verification:{status:'warning'}};}}});
  v.get('paper-recompose').checked=true;v.get('paper-recompose').dispatchEvent(new Event('change'));
  v.file(original);await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'first page');
  clickParagraph(v);let editor=v.document.activeElement;assert.equal(editor.parentElement.className,'paper-page');editor.value='A long replacement '.repeat(100);editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));
  v.get('paper-page-next').click();await until(()=>/^2.*문단을 클릭/.test(v.get('paper-before-status').textContent),'second page');
  clickParagraph(v);editor=v.document.activeElement;editor.value='Second replacement';editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));
  const snap=v.ws.getEditSnapshot();assert.equal(snap.edits.length,2);assert.deepEqual(snap.edits.map(e=>e.origin),['human','human']);assert.deepEqual(snap.edits.map(e=>e.pageIndex),[0,1]);
  v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'recomposition output');assert.equal(calls.length,1);assert.equal(calls[0].revision,snap.revision);assert.equal(calls[0].file,original);assert.equal(calls[0].edits[0].after.length,1900);
  await until(()=>v.log.received.some(b=>b.equals(bytes)),'preview bytes');v.get('paper-current-download').click();assert.equal(v.downloads.at(-1),result);assert.deepEqual(Buffer.from(await v.downloads.at(-1).arrayBuffer()),bytes);assert.deepEqual(Buffer.from(await original.arrayBuffer()),pdfBytes('MARKER-A'));
});
test('generation cancel aborts the worker request and preserves the draft',async()=>{
  let request;
  const v=mount({edits:require('../dist/paper-edits.js'),paragraphPdf:paragraphMock('Original paragraph.'),recompositionPdf:{prepare:r=>{request=r;return new Promise((resolve,reject)=>r.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'})),{once:true}));}}});
  v.get('paper-recompose').checked=true;v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'source');
  clickParagraph(v);const editor=v.document.activeElement;editor.value='Keep this draft';editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));
  v.get('paper-generate').click();await until(()=>request,'worker request');assert.equal(v.get('paper-generate-cancel').hidden,false);
  v.get('paper-generate-cancel').click();await settle();
  assert.equal(request.signal.aborted,true);assert.equal(v.get('paper-generate-cancel').hidden,true);
  assert.equal(v.ws.getEditSnapshot().edits[0].after,'Keep this draft');assert.equal(v.ws.getOutput(),null);
  assert.match(v.get('paper-generate-status').textContent,/취소/);
});

test('recomposition discards late revision and preserves last real output after failure',async()=>{
  const bytes=pdfBytes('MARKER-GEN'),file=pdfFile(bytes);let release,calls=0;
  const v=mount({edits:require('../dist/paper-edits.js'),paragraphPdf:paragraphMock('Original paragraph.'),recompositionPdf:{prepare:req=>{calls++;if(calls===1)return Promise.resolve({file,sha256:sha(bytes),revision:req.revision});return new Promise(ok=>{release=()=>ok({file,sha256:sha(bytes),revision:req.revision});});}}});
  v.get('paper-recompose').checked=true;v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'page');clickParagraph(v);let e=v.document.activeElement;e.value='First';e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('blur'));v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'first output');const old=v.ws.getOutput();
  v.get('paper-generate').click();await until(()=>release,'pending');v.get('paper-undo').click();release();await settle();assert.equal(v.ws.getOutput().file,old.file);assert.notEqual(v.ws.getEditSnapshot().revision,old.revision);assert.equal(v.get('paper-current-download').disabled,false);
});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({file:'paper-workspace.spec.cjs',passed,failed:tests.length-passed,total:tests.length}));})();

test('paragraph and change item reopen saved text and protect an unfinished edit',async()=>{
  const v=mount({paragraphPdf:paragraphMock('Original paragraph.')});
  v.file(pdfFile(pdfBytes('MARKER-A')));await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'paragraph');
  clickParagraph(v);let editor=v.document.activeElement;editor.value='Saved replacement.';editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));
  const id=v.ws.getEditSnapshot().edits[0].id;
  clickParagraph(v);assert.equal(v.get('paper-inline-after').value,'Saved replacement.');
  editor=v.document.activeElement;editor.value='Unfinished replacement.';editor.dispatchEvent(new Event('input'));editor.dispatchEvent(new Event('blur'));buttons(v,'edit',id)[0].click();
  assert.equal(v.document.activeElement.tagName,'textarea');assert.equal(v.document.activeElement.value,'Unfinished replacement.');
  assert.equal(v.get('paper-inline-after').value,'Unfinished replacement.');
  assert.doesNotMatch(textOf(v.get('paper-edits')),/After 수정/);
  v.get('paper-inline-after').value='Revised replacement.';v.get('paper-inline-apply').click();
  assert.equal(v.ws.getEditSnapshot().edits[0].after,'Revised replacement.');
});
