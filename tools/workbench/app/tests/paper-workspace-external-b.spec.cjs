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
    generation:require('../dist/paper-generation.js'),externalProposals:require('../dist/external-proposals.js'),edits:edits||undefined,fonts:opts.fonts,exporter:exporter||undefined,paragraphPdf:opts.paragraphPdf,tablePdf:opts.tablePdf,pipeline:opts.pipeline,recompositionPdf:opts.recompositionPdf,storage,sourceBlobs,urls:{createObjectURL(file){downloads.push(file);return 'blob:'+downloads.length;},revokeObjectURL(){}},
    timers,subtle:opts.subtle||crypto.subtle,now:()=>clock.value});
  const file=f=>{w.get('paper-file').files=[f];w.get('paper-file').dispatchEvent(new Event('change'));};
  const canvas=()=>w.get('paper-before-stage').children.flatMap(page=>(page.children||[]).filter(c=>c.tagName==='canvas'));
  return {...w,ws,lib,log,edits,storage,sourceBlobs,downloads,clock,file,canvas,long};
}
function keydown(target,init){const e=new Event('keydown',{cancelable:true});Object.assign(e,init);target.dispatchEvent(e);return e;}
function buttons(v,act,id){return v.get('paper-edits').querySelectorAll('button').filter(b=>b.dataset.act===act&&(!id||b.dataset.edit===id));}


test('external source excludes synthetic aliases but retains distinct occurrences and supports manual binding',async()=>{
  const X=require('../dist/external-exchange.js'),v=mount({paragraphPdf:paragraphMock('Unique 120.')});
  const file=pdfFile(pdfBytes('MARKER-A'));v.file(file);await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'paragraph alias');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',pageIndex:0,text:'Unique 120.'},{id:'s1',pageIndex:1,text:'Other text.'}]}}}));
  const source=v.ws.getSource();assert.ok(source.segments.some(s=>s.id.startsWith('paragraph:')));assert.deepEqual(source.externalSegments.map(s=>s.id),['s0','s1']);
  const prompt=X.buildPrompt({role:'red',fileHash:source.fileHash,segments:source.externalSegments,includeSource:true});assert.equal((prompt.match(/Unique 120\./g)||[]).length,1);
  const parsed=X.parse('{"changes":[{"before":"120","after":"121"}]}',{role:'red',fileHash:source.fileHash,segments:source.externalSegments});assert.equal(parsed.items[0].matchStatus,'matched');
  v.ws.acceptExternalResponse(parsed);assert.equal(v.ws.getExternalResponses().items[0].matchStatus,'matched');
  v.ws.acceptExternalResponse({schema:'falsify.external-batch.v1',id:'alias',role:'red',fileHash:source.fileHash,raw:'alias',items:[{id:'x',kind:'change',before:'120',after:'122',segmentId:'paragraph:0:p0',pageIndex:0,matchStatus:'matched',anchor:{start:7,end:10}}]});
  const row=v.get('paper-proposal-list').children[1];assert.equal(v.ws.getExternalResponses().items[1].matchStatus,'missing');assert.equal(row.children[4].children.length,2);
});

test('workspace imports additively and flush captures selected proposal',async()=>{
  let resolveExport;const requests=[];
  const exporter={prepare(req){requests.push(req);return new Promise(resolve=>{resolveExport=()=>{const bytes=pdfBytes('MARKER-GEN');resolve({file:pdfFile(bytes,'generated.pdf'),sha256:sha(bytes),verification:null,pageMap:null});};});}};
  const v=mount({exporter}),file=pdfFile(pdfBytes('MARKER-A'));
  v.file(file);await until(()=>v.ws.getSource()?.fileHash,'source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'}]}}}));
  const hash=v.ws.getSource().fileHash,batch=id=>({schema:'falsify.external-batch.v1',id,role:'red',fileHash:hash,raw:id,items:[{id:'x',kind:'change',before:'Alpha',after:'Beta',segmentId:'s0',pageIndex:0,matchStatus:'matched',anchor:{start:0,end:5}}]});
  v.ws.acceptExternalResponse(batch('a'));v.ws.acceptExternalResponse(batch('b'));assert.equal(v.ws.getExternalResponses().items[0].sourceRefs.length,2);
  const row=v.get('paper-proposal-list').children[0],check=row.children[0].children[0];check.checked=true;check.dispatchEvent(new Event('change'));
  v.get('paper-current-download').click();await until(()=>requests.length===1,'captured request');
  const replacement=v.get('paper-proposal-list').children[0].children[1];replacement.value='Gamma';replacement.dispatchEvent(new Event('change'));
  resolveExport();await until(()=>v.downloads.length===1,'captured download');assert.equal(requests[0].edits[0].after,'Beta');assert.ok(v.downloads[0].name==='generated.pdf');
});

test('current output only exposes the exact current draft key',async()=>{
  const bytes=pdfBytes('MARKER-GEN'),v=mount({exporter:{prepare:async()=>({file:pdfFile(bytes),sha256:sha(bytes)})}}),file=pdfFile(pdfBytes('MARKER-A'));
  v.file(file);await until(()=>v.ws.getSource()?.fileHash,'source');v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',pageIndex:0,text:'Alpha'}]}}}));
  const hash=v.ws.getSource().fileHash;v.ws.acceptExternalResponse({schema:'falsify.external-batch.v1',id:'a',role:'red',fileHash:hash,raw:'answer',items:[{id:'x',kind:'change',before:'Alpha',after:'Beta',segmentId:'s0',pageIndex:0,matchStatus:'matched',anchor:{start:0,end:5}}]});
  const c=v.get('paper-proposal-list').children[0].children[0].children[0];c.checked=true;c.dispatchEvent(new Event('change'));v.get('paper-generate').click();await until(()=>v.ws.getCurrentOutput()?.sha256===sha(bytes),'generated current');
  const last=v.ws.getOutput();assert.ok(last.generationKey);assert.equal(v.ws.getCurrentOutput().generationKey,last.generationKey);
  const editor=v.get('paper-proposal-list').children[0].children[1];editor.dispatchEvent(new Event('compositionstart'));editor.value='Gamma';editor.dispatchEvent(new Event('input'));assert.equal(v.ws.getCurrentOutput(),null);assert.equal(v.ws.getOutput().sha256,last.sha256);
  editor.value='Beta';assert.equal(v.ws.getCurrentOutput().generationKey,last.generationKey);
});

test('BLUE receives click-time file even after a later edit',async()=>{
  let finish;const calls=[];const exporter={prepare(req){calls.push(req);return new Promise(resolve=>{finish=()=>{const bytes=pdfBytes('MARKER-GEN');resolve({file:pdfFile(bytes,'blue.pdf'),sha256:sha(bytes)});};});}};
  const v=mount({exporter}),file=pdfFile(pdfBytes('MARKER-A'));v.file(file);await until(()=>v.ws.getSource()?.fileHash,'source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'}]}}}));
  const hash=v.ws.getSource().fileHash;v.ws.acceptExternalResponse({schema:'falsify.external-batch.v1',id:'a',role:'red',fileHash:hash,raw:'answer',items:[{id:'x',kind:'change',before:'Alpha',after:'Beta',segmentId:'s0',pageIndex:0,matchStatus:'matched',anchor:{start:0,end:5}}]});
  const c=v.get('paper-proposal-list').children[0].children[0].children[0];c.checked=true;c.dispatchEvent(new Event('change'));let received=null;v.document.addEventListener('falsify:blue-file',e=>received=e.detail);
  v.get('paper-blue-handoff').click();await until(()=>calls.length===1,'blue request');const t=v.get('paper-proposal-list').children[0].children[1];t.value='Gamma';t.dispatchEvent(new Event('change'));finish();await until(()=>received,'blue file');assert.deepEqual(Object.keys(received),['file']);assert.equal(calls[0].edits[0].after,'Beta');assert.equal(received.file.name,'paper.pdf');
});
test('opted-in draft restores the additive collection',async()=>{
  const v=mount(),file=pdfFile(pdfBytes('MARKER-A'));v.file(file);await until(()=>v.ws.getSource()?.fileHash,'source');v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'}]}}}));
  const hash=v.ws.getSource().fileHash;v.ws.acceptExternalResponse({schema:'falsify.external-batch.v1',id:'a',role:'red',fileHash:hash,raw:'answer',items:[{id:'x',kind:'change',before:'Alpha',after:'Beta',segmentId:'s0',pageIndex:0,matchStatus:'matched',anchor:{start:0,end:5}}]});
  v.get('paper-draft-opt').checked=true;v.get('paper-draft-save').click();await until(()=>v.storage.getItem('falsify.paper-draft.v1.'+hash),'draft saved');const saved=JSON.parse(v.storage.getItem('falsify.paper-draft.v1.'+hash));assert.equal(saved.extras.external.batches[0].raw,'answer');
  v.get('paper-draft-restore').click();await until(()=>/다시 넣었습니다/.test(v.get('paper-draft-status').textContent),'draft restored');assert.equal(v.ws.getExternalResponses().items.length,1);
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

test('direct editor owns typing and caret events, while source selection and IME remain safe',async()=>{
  const v=mount({paragraphPdf:paragraphMock('A full paragraph.')});v.file(pdfFile(pdfBytes('MARKER-A')));
  await until(()=>/문단을 클릭/.test(v.get('paper-before-status').textContent),'paragraph ready');clickParagraph(v);
  const editor=v.document.activeElement,stage=v.get('paper-before-stage');
  editor.value='First';editor.dispatchEvent(new Event('input'));
  for(const type of ['keyup','pointerup','mouseup']){
    const e=new Event(type);Object.defineProperty(e,'target',{value:editor});stage.dispatchEvent(e);
    assert.equal(editor.parentElement!==null,true,type+' keeps editor open');assert.equal(v.edits.added.length,0);
  }
  // A selection outside the PDF text layer must not commit an active editor either.
  const outside=v.document.createElement('span');
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:outside,getRangeAt:()=>({commonAncestorContainer:outside,startContainer:outside})});
  stage.dispatchEvent(new Event('keyup'));assert.ok(editor.parentElement);assert.equal(v.edits.added.length,0);
  editor.dispatchEvent(new Event('compositionstart'));
  assert.equal(keydown(editor,{key:'Escape',isComposing:true}).defaultPrevented,false);
  assert.equal(keydown(stage,{key:'Escape',isComposing:true}).defaultPrevented,false);
  keydown(stage,{key:'ArrowRight',isComposing:true});v.get('paper-page-next').click();editor.dispatchEvent(new Event('blur'));
  v.get('paper-inline-apply').click();v.get('paper-inline-cancel').click();
  assert.ok(editor.parentElement);assert.equal(v.edits.added.length,0);assert.equal(v.get('paper-page-label').textContent,'1 / 2쪽');
  editor.dispatchEvent(new Event('compositionend'));
  editor.value='First second';editor.dispatchEvent(new Event('input'));
  const pageEl=editor.parentElement,textEl=pageEl.children.find(c=>String(c.className).includes('textLayer')),span=textEl.querySelectorAll('span')[0];
  v.document.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:span,getRangeAt:()=>({commonAncestorContainer:textEl,intersectsNode:n=>n===span})});
  stage.dispatchEvent(new Event('keyup'));assert.equal(v.edits.added.length,1);assert.equal(v.edits.added[0].after,'First second');assert.equal(editor.parentElement,null);
  stage.dispatchEvent(new Event('keyup'));assert.equal(v.document.activeElement.tagName,'textarea','source Shift-arrow selection opens editor');
  keydown(v.document.activeElement,{key:'Escape'});assert.equal(v.document.activeElement,stage);
});


test('proposal textarea retains node and captures unfinished IME input',async()=>{
  const calls=[],bytes=pdfBytes('MARKER-GEN'),v=mount({exporter:{prepare:async req=>{calls.push(req);return {file:pdfFile(bytes,'out.pdf'),sha256:sha(bytes)};}}}),file=pdfFile(pdfBytes('MARKER-A'));v.file(file);await until(()=>v.ws.getSource()?.fileHash,'source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{id:'s0',label:'PDF p. 1',text:'Alpha Alpha'}]}}}));const hash=v.ws.getSource().fileHash;
  v.ws.acceptExternalResponse({schema:'falsify.external-batch.v1',id:'a',role:'red',fileHash:hash,raw:'raw',items:[{id:'x',kind:'change',before:'Alpha',after:'Beta',segmentId:'s0',pageIndex:0,matchStatus:'matched',anchor:{start:0,end:5}}]});
  let row=v.get('paper-proposal-list').children[0],c=row.children[0].children[0];c.checked=true;c.dispatchEvent(new Event('change'));row=v.get('paper-proposal-list').children[0];const editor=row.children[1];editor.focus();editor.dispatchEvent(new Event('compositionstart'));editor.value='한글';editor.dispatchEvent(new Event('input'));v.get('paper-current-download').click();await until(()=>v.downloads.length,'IME captured');assert.equal(calls[0].edits[0].after,'한글');assert.equal(v.get('paper-proposal-list').children[0].children[1],editor);assert.equal(v.document.activeElement,editor);editor.dispatchEvent(new Event('compositionend'));
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

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name,e);process.exitCode=1;}}console.log(JSON.stringify({passed,total:tests.length}));})();
