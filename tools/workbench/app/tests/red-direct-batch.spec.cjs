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
    edits:edits||undefined,exporter:exporter||undefined,paragraphPdf:opts.paragraphPdf,tablePdf:opts.tablePdf,pipeline:opts.pipeline,blindPdf:opts.blindPdf,storage,sourceBlobs,urls:{createObjectURL(file){downloads.push(file);return 'blob:'+downloads.length;},revokeObjectURL(){}},
    timers,subtle:opts.subtle||crypto.subtle,now:()=>clock.value});
  const file=f=>{w.get('paper-file').files=[f];w.get('paper-file').dispatchEvent(new Event('change'));};
  const canvas=()=>w.get('paper-before-stage').children.flatMap(page=>(page.children||[]).filter(c=>c.tagName==='canvas'));
  return {...w,ws,lib,log,edits,storage,sourceBlobs,downloads,clock,file,canvas,long};
}
function keydown(target,init){const e=new Event('keydown',{cancelable:true});Object.assign(e,init);target.dispatchEvent(e);return e;}
function buttons(v,act,id){return v.get('paper-edits').querySelectorAll('button').filter(b=>b.dataset.act===act&&(!id||b.dataset.edit===id));}


test('isolated RED batch uses only selected current After and preserves workspace edits and output on failure or stale source',async()=>{
  const calls=[];let release, mode='ok';
  const exporter={prepare:async req=>{calls.push(req);if(mode==='fail')throw new Error('failed');if(mode==='hold')await new Promise(r=>release=r);const bytes=pdfBytes('MARKER-GEN');return {file:pdfFile(bytes,'out.pdf'),sha256:sha(bytes),verification:{status:mode==='draft'?'failed':'passed'}};}};
  const v=mount({pages:1,paragraphPdf:exporter,edits:require('../dist/paper-edits.js')});
  const file=pdfFile(pdfBytes('MARKER-A'));
  v.file(file);await until(()=>v.ws.getSource(),'source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result:{segments:[{label:'PDF p. 1',text:'Alpha Beta Gamma'}]}}}));await settle();
  v.ws.acceptProposals([{segmentId:'s0',before:'Gamma',after:'Manual',anchor:{start:11,end:16}}],{origin:'external-ai-import',confirmed:true});
  const before=v.ws.getEditSnapshot();assert.equal(before.edits.length,1);
  v.get('paper-generate').click();await until(()=>v.ws.getOutput(),'previous output');const previous=v.ws.getOutput();calls.length=0;
  const args={fileHash:v.ws.getSource().fileHash,revision:'red-rev',patches:[{segmentId:'s0',before:'Alpha',after:'Edited After',offset:0}],isCurrent:()=>true};
  const result=await v.ws.exportRedBatch(args);assert.equal(result.revision,'red-rev');assert.equal(result.workspaceRevision,before.revision);
  assert.equal(calls[0].edits.length,1);assert.equal(calls[0].edits[0].after,'Edited After');assert.deepEqual(v.ws.getEditSnapshot(),before);
  assert.equal(result.sha256,sha(Buffer.from(await result.file.arrayBuffer())));assert.equal(v.ws.getOutput().sha256,previous.sha256);
  mode='draft';const draft=await v.ws.exportRedBatch(args);assert.equal(draft.verification.status,'failed');assert.equal(draft.sha256,sha(Buffer.from(await draft.file.arrayBuffer())));assert.equal(v.ws.getOutput().sha256,previous.sha256,'readable draft preserves actual status and the last workspace file');
  mode='fail';await assert.rejects(v.ws.exportRedBatch(args),/failed/);assert.deepEqual(v.ws.getEditSnapshot(),before);assert.equal(v.ws.getOutput().sha256,previous.sha256);
  mode='hold';const pending=v.ws.exportRedBatch(args);await until(()=>release,'held');v.file(pdfFile(pdfBytes('MARKER-B')));await until(()=>v.ws.getSource()?.fileHash!==args.fileHash,'replacement');release();await assert.rejects(pending,/취소/);assert.equal(v.ws.getOutput(),null);
});
test('clean source hashes bind to original provenance and a mismatched engine source cannot be returned',async()=>{
  const original=pdfFile(pdfBytes('MARKER-A')),clean=pdfFile(pdfBytes('CLEAN')),cleanHash=sha(Buffer.from(await clean.arrayBuffer()));
  let mismatch=false,calls=0;
  const exporter={prepare:async req=>{calls++;assert.equal(req.file,clean);assert.equal(req.fileHash,cleanHash);const bytes=pdfBytes('MARKER-GEN');return {file:pdfFile(bytes),sha256:sha(bytes),verification:{status:'passed',sourceSha256:mismatch?'0'.repeat(64):cleanHash}};}};
  const blindPdf={prepare:async()=>({file:clean,sha256:cleanHash,changed:true,removed:[{pageIndex:0,markerId:'falsify-red-training-copy'}],verification:{status:'passed'}})};
  const v=mount({pages:1,paragraphPdf:exporter,blindPdf,edits:require('../dist/paper-edits.js')});v.file(original);await until(()=>v.ws.getSource(),'source');
  v.document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file:original,result:{segments:[{label:'PDF p. 1',text:'Alpha Beta Gamma'}]}}}));await settle();
  const originalHash=v.ws.getSource().fileHash,args={fileHash:originalHash,revision:'red-rev',patches:[{segmentId:'s0',before:'Alpha',after:'Edited After',offset:0}],isCurrent:()=>true};
  const result=await v.ws.exportRedBatch(args);assert.equal(result.verification.blinding.originalSourceSha256,originalHash);assert.equal(result.verification.blinding.cleanSourceSha256,cleanHash);assert.equal(result.verification.sourceSha256,cleanHash);assert.equal(v.ws.getSource().fileHash,originalHash);
  mismatch=true;await assert.rejects(v.ws.exportRedBatch(args),/원본 해시/);assert.equal(calls,2);assert.equal(v.ws.getOutput(),null);
});
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name,e);}}if(failed)process.exitCode=1;})();
