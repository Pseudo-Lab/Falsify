'use strict';
// Synthetic manual-provenance checks. No browser, network, model, or Confluence write.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const bundlePromise=import('../dist/review-bundle.mjs');
const dist=path.resolve(__dirname,'../dist');
const TTL=12*60*60*1000;
const LEDGER='falsify.experiment-ledger.v1';
const HASH_A='11'.repeat(32), HASH_B='22'.repeat(32), HASH_C='33'.repeat(32), SOURCE='ab'.repeat(32);
const flush=async(n=20)=>{for(let i=0;i<n;i++) await new Promise(resolve=>setImmediate(resolve));};
const until=async(fn,label)=>{for(let i=0;i<50&&!fn();i++) await flush(1); assert.equal(fn(),true,label);};
const copy=value=>JSON.parse(JSON.stringify(value));

function sourceText(marker='Study does not show benefit.'){return [{id:'s0',label:'p1',text:marker,pageIndex:0},{id:'s1',label:'p2',text:'External draft alpha.',pageIndex:1},{id:'s2',label:'p3',text:'Proposal beta remains.',pageIndex:2}];}
function edits(){return [
  {id:'e1',enabled:true,pageIndex:0,segmentId:'s0',before:'does not show',after:'does show',origin:'human',anchor:{bbox:[1,2,3,4],occurrence:1}},
  {id:'e2',enabled:false,pageIndex:1,segmentId:'s1',before:'alpha',after:'omega',origin:'external-ai-import',anchor:null},
  {id:'e3',enabled:true,pageIndex:2,segmentId:'s2',before:'beta',after:'gamma',origin:'ai-proposal',anchor:null}
];}
function snapshot(fileHash,revision,editRows){return {schema:'falsify.paper-edits.v1',fileHash,name:'synthetic.txt',revision,edits:editRows,canUndo:false,canRedo:false};}

class El extends EventTarget{
  constructor(tag){super(); this.tagName=String(tag).toUpperCase(); this.children=[]; this.attrs={}; this.id=''; this.className=''; this.value=''; this.checked=false; this.disabled=false; this.hidden=false; this.type=''; this._text='';
    const classes=new Set();
    this.classList={toggle:(name,on)=>{const next=on??!classes.has(name); next?classes.add(name):classes.delete(name); this.className=[...classes].join(' ');},contains:name=>classes.has(name)||this.className.split(/\s+/).includes(name)};}
  get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
  set textContent(value){this.children=[]; this._text=String(value);}
  append(...kids){for(const kid of kids){if(kid&&typeof kid==='object') kid.parent=this; this.children.push(kid);}}
  replaceChildren(...kids){this.children=[]; this._text=''; this.append(...kids);}
  setAttribute(key,value){this.attrs[key]=String(value); if(key==='id') this.id=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  *walk(){yield this; for(const child of this.children) if(child&&child.walk) yield* child.walk();}
  find(fn){for(const node of this.walk()) if(fn(node)) return node; return null;}
  querySelector(sel){if(sel==='select') return this.find(node=>node.tagName==='SELECT'); if(sel==='textarea') return this.find(node=>node.tagName==='TEXTAREA'); if(sel.startsWith('#')) return this.find(node=>node.id===sel.slice(1)); return null;}
  click(){if(!this.disabled) this.dispatchEvent(new Event('click'));}
  change(){this.dispatchEvent(new Event('change'));}
  focus(){}
}
function boot(extra={}){
  const posts=[], fetches=[];
  const storage=new Map([[LEDGER,'{"schema":"falsify.experiment-ledger.v1","runs":[{"id":"keep-local"}]}']]);
  const body=new El('body'), review=new El('section'); review.id='human-evaluation'; body.append(review);
  const location={hash:''};
  const document=new EventTarget();
  Object.assign(document,{readyState:'complete',currentScript:null,body,createElement:tag=>new El(tag),querySelector(sel){if(sel==='[data-view="review"]') return null; if(sel.startsWith('#')) return body.find(node=>node.id===sel.slice(1)); return null;}});
  const publish={fail:false};
  const ctx=vm.createContext({document,location,CustomEvent,Event,URL,Date,TextEncoder,crypto:globalThis.crypto,console,setTimeout,clearTimeout,
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch(){fetches.push('fetch'); throw Error('network disabled');},
    FalsifyReviewBundle:extra.bundle, FalsifyPaperWorkspace:extra.workspace||null,
    FalsifyConfluenceStore:{ready:Promise.resolve({async publishPaperEdit(record,options){posts.push({record,options}); if(publish.fail) throw Error('팀 보관이 저장되었는지 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.'); return {stored:true,pageId:'9001',archiveSha256:HASH_A,alreadyExisted:false};}})}
  });
  vm.runInContext(fs.readFileSync(path.join(dist,'paper-manual-records.js'),'utf8'),ctx,{filename:'paper-manual-records.js'});
  const $=id=>body.find(node=>node.id===id);
  return {ctx,document,body,location,posts,fetches,storage,publish,api:ctx.FalsifyPaperManualRecords,$};
}

test('archive hash round-trips and rejects duplicate ids, stale output, PDF bytes, and RED carriers',async()=>{
  const bundle=await bundlePromise;
  const record={id:'pmr-synthetic-1',createdAt:'2026-10-26T00:00:00.000Z',sourceFileHash:SOURCE,sourceName:'synthetic.txt',segments:sourceText(),edits:edits(),editRevision:3,output:{sha256:HASH_A,revision:3,verification:{applied:1,unapplied:0}},reviews:[]};
  const built=await bundle.buildPaperEditArchive(record);
  const validated=await bundle.validateArchive(built);
  assert.equal(built.kind,'paper-edit');
  assert.equal(built.data.schema,'falsify.paper-edit-record.v1');
  assert.equal(await bundle.archiveHash(built),await bundle.archiveHash(validated));
  assert.equal(await bundle.archiveHash(built),await bundle.archiveHash({title:built.title,schema:built.schema,data:built.data,kind:built.kind,id:built.id}));
  const tampered=copy(built); tampered.data.record.edits[0].after='changed';
  assert.notEqual(await bundle.archiveHash(tampered),await bundle.archiveHash(built));
  const duplicate=copy(record); duplicate.edits.push({...duplicate.edits[0]});
  await assert.rejects(bundle.buildPaperEditArchive(duplicate),error=>error.code==='conflict');
  await assert.rejects(bundle.buildPaperEditArchive({...record,output:{sha256:HASH_A,revision:2,verification:{}}}),error=>error.code==='conflict'&&/Stale output/.test(error.message));
  await assert.rejects(bundle.buildPaperEditArchive({...record,segments:[{id:'s0',label:'p1',text:'%PDF-1.7 binary'}]}),error=>error.code==='malformed');
  await assert.rejects(bundle.buildPaperEditArchive({...record,gold:true,red:{marker:'RED-META'}}),error=>error.code==='malformed');
  const reviews=[{id:'rv',createdAt:'2026-10-26T01:00:00.000Z',reviewer:'Synthetic',caseLabel:'manual',verdict:'supported',score:4,note:'Human reason.',alignment:null,editRevision:3,outputHash:HASH_A,stale:false}];
  await assert.rejects(bundle.buildPaperEditArchive({...record,reviews:[reviews[0],reviews[0]]}),error=>error.code==='conflict');
  assert.equal(JSON.stringify(built).includes('local-codex'),false);
  assert.equal(JSON.stringify(built).includes('"harness"'),false);
  assert.equal(built.data.record.edits.map(edit=>edit.origin).join(','),'human,external-ai-import,ai-proposal');
});

test('download hash follows the current revision and drops stale or binary output',async()=>{
  const bundle=await bundlePromise;
  const state={fileHash:SOURCE,name:'synthetic.txt',segments:sourceText(),revision:1,edits:edits(),output:{sha256:HASH_A,revision:1,verification:{applied:1},file:{name:'secret.pdf',bytes:'%PDF-1.7'}}};
  const workspace={getSource:()=>copy(state),getEditSnapshot:()=>snapshot(state.fileHash,state.revision,state.edits),getOutput:()=>copy(state.output)};
  const t=boot({bundle,workspace}); await t.api.ready;
  t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-edits',{detail:workspace.getEditSnapshot()}));
  await until(()=>t.api.records().length===1,'captured');
  assert.equal(t.api.downloadLink(t.api.records()[0]).sha256,HASH_A);
  assert.equal(JSON.stringify(t.api.records()).includes('secret.pdf'),false);
  assert.equal(JSON.stringify(t.api.records()).includes('%PDF-'),false);
  state.output={sha256:HASH_B,revision:1,verification:{applied:1}};
  t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-output',{detail:{...state.output,file:{name:'secret.pdf'}}}));
  await until(()=>t.api.downloadLink(t.api.records()[0]).sha256===HASH_B,'hash changed');
  assert.match(t.$('paper-manual-output').textContent,new RegExp(HASH_B));
  assert.equal(t.$('paper-manual-output').textContent.includes(HASH_A),false);
  state.revision=2;
  t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-edits',{detail:workspace.getEditSnapshot()}));
  await until(()=>t.api.records()[0].editRevision===2,'revision advanced');
  assert.equal(t.api.downloadLink(t.api.records()[0]),null);
  assert.match(t.$('paper-manual-output').textContent,/이전 해시/);
  t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-output',{detail:{sha256:HASH_C,revision:1,verification:{}}}));
  await flush();
  assert.equal(t.api.downloadLink(t.api.records()[0]),null);
  state.output={sha256:HASH_C,revision:2,verification:{note:'%PDF-1.7'}};
  const rejected=await t.api.linkOutput(state.output);
  assert.equal(rejected.linked,false);
  assert.equal(t.api.downloadLink(t.api.records()[0]),null);
  assert.equal(JSON.stringify(t.api.records()).includes('%PDF-'),false);
  const linked=await t.api.linkOutput({sha256:HASH_C,revision:2,verification:{applied:2}});
  assert.equal(linked.sha256,HASH_C);
  assert.equal(t.api.records().length,1);
  assert.equal(t.posts.length,0);
  assert.equal(t.fetches.length,0);
  assert.equal(t.storage.get(LEDGER).includes('keep-local'),true);
});

test('duplicate ids and source mismatches do not invent a match or a second record',async()=>{
  const bundle=await bundlePromise;
  const state={fileHash:SOURCE,name:'synthetic.txt',segments:sourceText(),revision:1,edits:edits()};
  const t=boot({bundle,workspace:{getSource:()=>copy(state),getEditSnapshot:()=>snapshot(state.fileHash,state.revision,state.edits),getOutput:()=>null}});
  await t.api.ready;
  await t.api.capture({source:state,snapshot:snapshot(SOURCE,1,edits()),output:null,now:Date.parse('2026-10-26T00:00:00Z')});
  const id=t.api.records()[0].id;
  state.edits=[edits()[0],{...edits()[0]}];
  await assert.rejects(t.api.capture({source:state,snapshot:snapshot(SOURCE,2,state.edits),output:null}),error=>error.code==='conflict');
  assert.equal(t.api.records().length,1);
  assert.equal(t.api.records()[0].id,id);
  assert.equal(t.api.records()[0].editRevision,1);
  await assert.rejects(t.api.capture({source:{...state,fileHash:'ff'.repeat(32)},snapshot:snapshot(SOURCE,1,edits()),output:null}),error=>error.code==='mismatch');
  assert.equal(t.api.records().length,1);
  const record=t.api.records()[0];
  assert.equal(t.api.locateEdit(record,record.edits[0]).status,'matched');
  assert.equal(t.api.locateEdit(record,{...record.edits[0],segmentId:undefined}).status,'source-only');
  assert.equal(t.api.locateEdit(record,{...record.edits[0],before:'missing phrase'}).status,'mismatch');
  assert.equal(t.api.locateEdit(record,{...record.edits[0],before:'e',segmentId:'s0'}).status,'mismatch');
  const bare=t.api.records()[0];
  assert.equal(t.api.matchBlue(bare,{fileHash:SOURCE,findings:[{id:'F1',quote:'does show'}],red:{marker:'RED-META'}}).status,'source-only');
  assert.equal(JSON.stringify(t.api.matchBlue(bare,{fileHash:SOURCE}).findings),'[]');
  assert.equal(t.api.blueHandoff(bare),null);
});

test('manual review stays separate from AI provenance and can be manual-only',async()=>{
  const bundle=await bundlePromise;
  const t=boot({bundle}); await t.api.ready;
  const captured=await t.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments:sourceText()},snapshot:snapshot(SOURCE,4,edits()),output:{sha256:HASH_A,revision:4,verification:{}},now:Date.parse('2026-10-26T00:00:00Z')});
  assert.match(t.$('paper-manual-edits').textContent,/사람 편집/);
  assert.match(t.$('paper-manual-edits').textContent,/외부 AI 가져오기/);
  assert.match(t.$('paper-manual-edits').textContent,/작업대 AI 제안/);
  assert.match(t.$('paper-manual-edits').textContent,/사용 안 함/);
  assert.match(t.$('paper-manual-records').textContent,/gold를 만들지 않습니다/);
  const manual=await t.api.addReview('local:'+captured.id,{reviewer:'Synthetic',caseLabel:'manual only',verdict:'supported',score:2,note:'Typed human reason.'});
  assert.equal(manual.alignment,null);
  assert.equal(manual.score,2);
  const uncertain=await t.api.addReview('local:'+captured.id,{reviewer:'Synthetic',caseLabel:'manual only',verdict:'uncertain',score:5,note:'No score while uncertain.'});
  assert.equal(uncertain.score,null);
  await assert.rejects(t.api.addReview('local:'+captured.id,{reviewer:'Synthetic',caseLabel:'manual',verdict:'supported',score:4,note:'no',gold:1}),/gold/);
  assert.equal(t.api.records()[0].reviews.length,2);
  const blue={id:'blue-1',fileHash:'ff'.repeat(32),findings:[{id:'F9',quote:'unrelated',rationale:'BLUE'}],red:{marker:'RED-META'},sourceRunId:'red-1',harness:{name:'no'},gold:true};
  const mismatched=t.api.matchBlue(t.api.records()[0],blue);
  assert.equal(mismatched.status,'mismatch');
  assert.equal(JSON.stringify(mismatched).includes('RED-META'),false);
  assert.equal(JSON.stringify(t.api.blueHandoff(t.api.records()[0])),JSON.stringify({fileHash:HASH_A}));
  const saved=await t.api.addReview('local:'+captured.id,{reviewer:'Synthetic',caseLabel:'mismatch',verdict:'mixed',score:3,note:'Did not treat the other file as the edit.',findingNotes:[{id:'F9',verdict:'supported',note:'should not stick'}]},{blue});
  assert.equal(saved.alignment,null);
  const matchedBlue={id:'blue-2',fileHash:HASH_A,findings:[{id:'F1',segmentId:'s0',label:'p1',quote:'does show',rationale:'BLUE-RATIONALE'}],red:{marker:'RED-META'},gold:1,sourceRunId:'red-9'};
  const aligned=t.api.matchBlue(t.api.records()[0],matchedBlue);
  assert.equal(aligned.status,'matched');
  assert.equal(JSON.stringify(aligned).includes('RED-META'),false);
  assert.equal(JSON.stringify(aligned).includes('sourceRunId'),false);
  assert.deepEqual(Object.keys(aligned).sort(),['fileHash','findings','status']);
  t.ctx.FalsifyLab={blueFileChoices:()=>[matchedBlue]};
  await t.api.refreshBlue();
  t.$('paper-manual-blue').value='blue-2'; t.$('paper-manual-blue').change();
  assert.match(t.$('paper-manual-edits').textContent,/F1/);
  assert.equal(t.$('paper-manual-edits').textContent.includes('RED-META'),false);
  const judged=await t.api.addReview('local:'+captured.id,{reviewer:'Synthetic',caseLabel:'aligned',verdict:'supported',score:4,note:'Human compared the quote.',findingNotes:[{id:'F1',verdict:'unsupported',note:'The quote does not establish the edit.'}]},{blue:matchedBlue});
  assert.equal(judged.alignment.fileHash,HASH_A);
  assert.equal(judged.alignment.findingNotes[0].note,'The quote does not establish the edit.');
  assert.equal(judged.score,4);
  const built=await bundle.buildPaperEditArchive(t.api.records()[0]);
  assert.equal(built.kind,'paper-edit');
  assert.equal(JSON.stringify(built).includes('local-codex'),false);
  assert.equal(JSON.stringify(built).includes('RED-META'),false);
});

test('private drafts and cancelled team consent do not publish or retry',async()=>{
  const bundle=await bundlePromise;
  const state={fileHash:SOURCE,name:'synthetic.txt',segments:sourceText(),revision:1,edits:edits(),output:{sha256:HASH_A,revision:1,verification:{}}};
  const workspace={getSource:()=>copy(state),getEditSnapshot:()=>snapshot(SOURCE,1,edits()),getOutput:()=>copy(state.output)};
  const t=boot({bundle,workspace}); await t.api.ready;
  t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-edits',{detail:workspace.getEditSnapshot()}));
  t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-source'));
  await until(()=>t.api.records().length===1,'draft captured');
  assert.equal(t.posts.length,0);
  assert.equal(t.fetches.length,0);
  assert.equal(t.storage.get(LEDGER).includes('keep-local'),true);
  t.document.dispatchEvent(new CustomEvent('falsify:paper-team-share'));
  await flush();
  assert.equal(t.$('paper-manual-publish').disabled,true);
  assert.equal(t.posts.length,0);
  t.$('paper-manual-cancel').click();
  assert.match(t.$('paper-manual-status').textContent,/취소/);
  assert.equal(t.posts.length,0);
  t.$('paper-manual-prepare').click();
  t.$('paper-manual-consent').checked=true; t.$('paper-manual-consent').change();
  t.$('paper-manual-publish').click();
  await until(()=>t.posts.length===1,'one consented post');
  assert.equal(t.posts[0].options.teamShare,true);
  assert.equal(t.posts[0].record.kind,undefined);
  assert.equal(JSON.stringify(t.posts[0].record).includes('%PDF-'),false);
  t.publish.fail=true;
  t.$('paper-manual-prepare').click();
  t.$('paper-manual-consent').checked=true; t.$('paper-manual-consent').change();
  t.$('paper-manual-publish').click();
  await until(()=>t.posts.length===2&&/다시 보내지/.test(t.$('paper-manual-status').textContent),'unknown outcome');
  await flush();
  assert.equal(t.posts.length,2);
  assert.equal(t.storage.get(LEDGER).includes('keep-local'),true);
});

test('imported paper archive stays in memory for 12 hours and does not replace the local record',async()=>{
  const bundle=await bundlePromise;
  const t=boot({bundle}); await t.api.ready;
  const local=await t.api.capture({source:{fileHash:SOURCE,name:'local.txt',segments:sourceText('LOCAL-MARKER does not show benefit.')},snapshot:snapshot(SOURCE,1,[{id:'e1',enabled:true,pageIndex:0,segmentId:'s0',before:'does not show',after:'local after',origin:'human',anchor:null}]),output:null,now:Date.parse('2026-10-26T00:00:00Z')});
  const imported=await bundle.buildPaperEditArchive({id:local.id,createdAt:'2026-10-26T02:00:00.000Z',sourceFileHash:SOURCE,sourceName:'imported.txt',segments:[{id:'s0',label:'p1',text:'IMPORT-MARKER does not show benefit.',pageIndex:0}],edits:[{id:'e9',enabled:true,pageIndex:0,segmentId:'s0',before:'does not show',after:'imported after',origin:'external-ai-import',anchor:null}],editRevision:1,output:null,reviews:[]});
  const now=Date.now();
  const opened=await t.api.openImported(imported,{now});
  assert.equal(opened.kind,'paper-edit');
  assert.equal(opened.id,local.id);
  assert.equal(t.api.records()[0].segments[0].text.includes('LOCAL-MARKER'),true);
  assert.equal(t.api.imported(now).record.segments[0].text.includes('IMPORT-MARKER'),true);
  assert.equal(t.storage.get(LEDGER).includes('IMPORT-MARKER'),false);
  assert.equal(t.posts.length,0);
  const review=await t.api.addReview('import:'+local.id,{reviewer:'Synthetic',caseLabel:'imported only',verdict:'uncertain',score:null,note:'Imported record only.'},{now});
  assert.equal(review.alignment,null);
  assert.equal(t.api.records()[0].reviews.length,0);
  assert.equal(t.api.imported(now).reviews.length,1);
  assert.equal(t.api.sweep(now+TTL-1),false);
  assert.equal(t.api.sweep(now+TTL),true);
  assert.equal(t.api.imported(now+TTL),null);
  assert.equal(t.api.records()[0].segments[0].text.includes('LOCAL-MARKER'),true);
  const again=await t.api.openImported(imported,{now});
  assert.equal(again.id,local.id);
  t.api.closeImported();
  assert.equal(t.api.imported(now),null);
  assert.equal(t.storage.get(LEDGER).includes('keep-local'),true);
});

test('ledger bridge opens a paper-edit without writing the AI ledger or copying RED into BLUE choices',async()=>{
  const bundle=await bundlePromise;
  const H=require('../dist/harness-core.js'), Red=require('../dist/document-red-core.js'), Blue=require('../dist/document-blue-core.js');
  const els=new Map();
  function element(tag){const node=new EventTarget(); const classes=new Set(); let id='';
    Object.defineProperty(node,'id',{get:()=>id,set:value=>{id=value; els.set(value,node);}});
    Object.assign(node,{tagName:String(tag).toUpperCase(),disabled:false,hidden:false,checked:false,value:'',textContent:'',placeholder:'',children:[],files:[],parent:null,dataset:{},attrs:{},
      classList:{toggle:(name,on)=>{(on??!classes.has(name))?classes.add(name):classes.delete(name);},contains:name=>classes.has(name)},
      setAttribute(key,value){this.attrs[key]=String(value);},getAttribute(key){return this.attrs[key]??null;},
      append(...kids){for(const kid of kids){if(kid&&typeof kid==='object') kid.parent=node; node.children.push(kid);}},
      replaceChildren(...kids){node.children=[]; node.append(...kids);},prepend(...kids){node.children.unshift(...kids);},after(){},remove(){},reset(){},focus(){},
      closest(sel){let current=node; while(current){if(current.tagName===String(sel).toUpperCase()) return current; current=current.parent;} return null;}});
    Object.defineProperty(node,'innerHTML',{set(){}});
    Object.defineProperty(node,'firstChild',{get(){return node.children[0]??null;}});
    return node;}
  const get=id=>{if(!els.has(id)) element('div').id=id; return els.get(id);};
  const storage=new Map(), writes=[];
  const document=new EventTarget();
  Object.assign(document,{readyState:'complete',currentScript:null,createElement:element,querySelector:sel=>sel.startsWith('#')?get(sel.slice(1)):null,querySelectorAll:()=>[],body:element('body')});
  const ctx=vm.createContext({document,FalsifyReview:require('../dist/review-workbench.js'),FalsifyHarness:H,FalsifyReviewBundle:bundle,FalsifyLocalBridge:{capabilities:()=>null,state:()=>({status:'manual',connected:false,cap:null})},FalsifyDocumentRed:Red,FalsifyDocumentBlue:Blue,
    localStorage:{getItem:key=>storage.get(key)??null,setItem(key,value){writes.push(key); storage.set(key,String(value));}},
    fetch(){throw Error('network disabled');},WebSocket(){throw Error('network disabled');},crypto:globalThis.crypto,TextEncoder,CustomEvent,Event,URL,Blob,setTimeout,clearTimeout,Date,console,location:{hash:''}});
  vm.runInContext(fs.readFileSync(path.join(dist,'paper-manual-records.js'),'utf8'),ctx,{filename:'paper-manual-records.js'});
  vm.runInContext(fs.readFileSync(path.join(dist,'experiment-ledger.js'),'utf8'),ctx,{filename:'experiment-ledger.js'});
  await ctx.FalsifyLab.ready; await ctx.FalsifyPaperManualRecords.ready;
  const before=storage.get(LEDGER), writeCount=writes.length;
  const archive=await bundle.buildPaperEditArchive({id:'pmr-bridge-1',createdAt:'2026-10-26T00:00:00.000Z',sourceFileHash:SOURCE,sourceName:'bridge.txt',segments:[{id:'s0',label:'p1',text:'MANUAL-ARCHIVE-MARKER does not show benefit.',pageIndex:0}],edits:[{id:'e1',enabled:true,pageIndex:0,segmentId:'s0',before:'does not show',after:'does show',origin:'human',anchor:null}],editRevision:1,output:{sha256:HASH_A,revision:1,verification:{}},reviews:[]});
  const opened=await ctx.FalsifyLab.openArchive(archive);
  assert.equal(opened.kind,'paper-edit');
  assert.equal(opened.id,'pmr-bridge-1');
  assert.equal(storage.get(LEDGER),before);
  assert.equal(writes.length,writeCount);
  assert.equal(String(storage.get(LEDGER)||'').includes('MANUAL-ARCHIVE-MARKER'),false);
  assert.equal((await ctx.FalsifyLab.cloudSnapshot()).runs.length,0);
  assert.equal(ctx.FalsifyPaperManualRecords.imported().record.edits[0].origin,'human');
  assert.equal(Object.hasOwn(ctx.FalsifyPaperManualRecords.imported().record,'harness'),false);
  await ctx.FalsifyLab.closeArchive();
  assert.equal(ctx.FalsifyPaperManualRecords.imported(),null);
  assert.equal(storage.get(LEDGER),before);
  const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const redSegments=[{id:'s0',label:'p1',text:'Study does not show benefit.'}];
  const blueSegments=[{id:'s0',label:'p1',text:'Study does show benefit.'}];
  const redDoc={revision:'synthetic-red',sourceHash:await sha(redSegments.map(item=>item.text).join('\n\n')),fileHash:'f'.repeat(64),name:'red.txt',format:'TXT',segments:redSegments};
  const blueDoc={revision:'synthetic-blue',sourceHash:await sha(blueSegments.map(item=>item.text).join('\n\n')),fileHash:HASH_A,name:'blue.txt',format:'TXT',segments:blueSegments};
  const redReq=copy(await ctx.FalsifyLab.bind('red',Red.request(redDoc,1,4)));
  const redEvidence=[{segmentId:'s0',quote:'benefit.',relation:'Synthetic support.'}];
  const redId=await ctx.FalsifyLab.record('red',redDoc,redReq,{schema:Red.VERSION,revision:redDoc.revision,sourceHash:redDoc.sourceHash,status:'ok',candidates:[{id:'c1',segmentId:'s0',level:1,before:redSegments[0].text,after:blueSegments[0].text,rationale:'RED-ONLY-TOKEN',evidence:redEvidence,uncertainty:'Synthetic.'}]},'manual-unverified',{finalState:{outputFileHash:blueDoc.fileHash,verification:null,selected:[{id:'c1',segmentId:'s0',label:'p1',before:redSegments[0].text,after:blueSegments[0].text,offset:0,edited:false}]}});
  const blueReq=copy(await ctx.FalsifyLab.bind('blue',Blue.request(blueDoc,4)));
  await ctx.FalsifyLab.record('blue',blueDoc,blueReq,{schema:Blue.VERSION,revision:blueDoc.revision,sourceHash:blueDoc.sourceHash,status:'ok',findings:[{id:'F1',segmentId:'s0',quote:blueSegments[0].text,rationale:'BLUE-RATIONALE',evidence:[{segmentId:'s0',quote:'benefit.',relation:'Synthetic support.'}],uncertainty:'Synthetic.'}]},'manual-unverified',{sourceRunId:redId});
  const choices=ctx.FalsifyLab.blueFileChoices();
  assert.equal(choices.length,1);
  assert.deepEqual(Object.keys(choices[0]).sort(),['createdAt','fileHash','findings','id','sourceName']);
  assert.equal(choices[0].fileHash,HASH_A);
  assert.equal(JSON.stringify(choices).includes('RED-ONLY-TOKEN'),false);
  assert.equal(JSON.stringify(choices).includes('sourceRunId'),false);
  assert.equal(JSON.stringify(choices).includes('BLUE-RATIONALE'),true);
  assert.equal(String(storage.get(LEDGER)).includes('MANUAL-ARCHIVE-MARKER'),false);
});

test('real paper-edits core captures null style, duplicate ranges, history, and review binding',async()=>{
  const bundle=await bundlePromise;
  const E=require('../dist/paper-edits.js');
  let tick=1700000000000;
  const segments=[{id:'s0',label:'p1',text:'alpha alpha',pageIndex:0}];
  const session=E.create({fileHash:SOURCE,name:'synthetic.txt',segments,now:()=>tick++});
  const editId=session.add({pageIndex:0,segmentId:'s0',before:'alpha',after:'beta',origin:'human',anchor:{start:6,end:11}});
  session.update(editId,{anchor:{style:{font:'Times',size:11.5,color:0x102030}}});
  const first=session.snapshot();
  assert.equal(first.edits[0].anchor.bbox,null);
  assert.equal(first.edits[0].anchor.style.font,'Times');
  assert.equal(first.edits[0].anchor.occurrence,1);
  assert.equal(first.edits[0].anchor.start,6);
  assert.equal(first.edits[0].anchor.end,11);
  const t=boot({bundle}); await t.api.ready;
  const captured=await t.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments},snapshot:first,output:{sha256:HASH_A,revision:first.revision,verification:{applied:1}},now:tick});
  const anchor=captured.edits[0].anchor;
  assert.equal(anchor.start,6);
  assert.equal(anchor.end,11);
  assert.equal(anchor.occurrence,1);
  assert.equal(anchor.bbox,null);
  assert.equal(anchor.style.font,'Times');
  assert.equal(anchor.style.size,11.5);
  assert.equal(anchor.style.color,0x102030);
  assert.equal(captured.edits[0].history.length,2);
  assert.equal(captured.edits[0].createdAt<=captured.edits[0].updatedAt,true);
  assert.equal(captured.edits[0].history[0].at,captured.edits[0].createdAt);
  assert.equal(captured.edits[0].history[captured.edits[0].history.length-1].after,'beta');
  const round=await bundle.validateArchive(await bundle.buildPaperEditArchive(captured));
  assert.equal(round.data.record.edits[0].history.length,2);
  assert.equal(round.data.record.edits[0].createdAt,captured.edits[0].createdAt);
  assert.equal(round.data.record.edits[0].updatedAt,captured.edits[0].updatedAt);
  assert.equal(round.data.record.edits[0].anchor.style.color,0x102030);
  assert.equal(round.data.record.edits[0].anchor.bbox,null);
  const located=t.api.locateEdit(captured,captured.edits[0]);
  assert.equal(located.status,'matched');
  assert.equal(located.start,6);
  assert.equal(located.end,11);
  assert.equal(located.occurrence,1);
  assert.equal(t.api.locateEdit(captured,{...captured.edits[0],anchor:null}).status,'mismatch');
  assert.equal(t.api.locateEdit(captured,{...captured.edits[0],anchor:{...anchor,occurrence:0}}).status,'mismatch');
  assert.equal(t.api.locateEdit(captured,{...captured.edits[0],anchor:{...anchor,start:7,end:12}}).status,'mismatch');
  const bad=copy(captured); bad.edits[0].anchor={...anchor,style:{font:'Times',size:12,color:'#ffffff'}};
  await assert.rejects(async()=>bundle.normalizePaperEdit(bad),error=>error.code==='malformed');
  const extra=copy(captured); extra.edits[0].anchor={...anchor,fontSize:12};
  await assert.rejects(async()=>bundle.normalizePaperEdit(extra),error=>error.code==='malformed');
  const review=await t.api.addReview('local:'+captured.id,{reviewer:'Synthetic',caseLabel:'first after',verdict:'supported',score:3,note:'Judged the first After.'});
  assert.equal(review.editRevision,first.revision);
  assert.equal(review.outputHash,HASH_A);
  assert.equal(review.stale,false);
  assert.match(t.$('paper-manual-history').textContent,/이 리비전 r/);
  session.update(editId,{after:'gamma'});
  const second=session.snapshot();
  const next=await t.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments},snapshot:second,output:null,now:tick});
  assert.equal(next.editRevision,second.revision);
  assert.notEqual(next.editRevision,review.editRevision);
  assert.equal(next.edits[0].after,'gamma');
  assert.equal(next.edits[0].history.length,3);
  assert.equal(next.reviews.length,1);
  assert.equal(next.reviews[0].stale,true);
  assert.equal(next.reviews[0].verdict,'supported');
  assert.equal(next.reviews[0].editRevision,review.editRevision);
  assert.equal(next.reviews[0].outputHash,HASH_A);
  assert.equal(next.output,null);
  const kept=await bundle.validateArchive(await bundle.buildPaperEditArchive(next));
  assert.equal(kept.data.record.edits[0].history.length,3);
  assert.equal(kept.data.reviews[0].stale,true);
  assert.equal(kept.data.reviews[0].editRevision,review.editRevision);
  const lie=copy(next); lie.reviews[0].stale=false;
  await assert.rejects(async()=>bundle.normalizePaperEdit(lie),error=>error.code==='conflict');
  assert.match(t.$('paper-manual-history').textContent,/현재 After에 적용하지 않음/);
  assert.match(t.$('paper-manual-history').textContent,/beta/);
  assert.equal(t.$('paper-manual-edits').textContent.includes('Judged the first After'),false);
  assert.match(t.$('paper-manual-edits').textContent,/gamma/);
  const linked=await t.api.linkOutput({sha256:HASH_B,revision:next.editRevision,verification:{applied:1}});
  assert.equal(linked.sha256,HASH_B);
  const current=t.api.records()[0];
  assert.equal(current.reviews[0].stale,true);
  assert.equal(current.reviews[0].outputHash,HASH_A);
  assert.notEqual(current.reviews[0].outputHash,current.output.sha256);
  const edit=current.edits[0];
  assert.equal(t.api.overlaps(current,edit,{id:'EXACT',segmentId:'s0',quote:'alpha',start:6,end:11,rationale:'exact'}),'same-position');
  assert.equal(t.api.overlaps(current,edit,{id:'OTHER',segmentId:'s0',quote:'alpha',start:0,end:5,rationale:'other'}),'same-page');
  assert.equal(t.api.overlaps(current,edit,{id:'PAGE',segmentId:'s0',quote:'unrelated page text',rationale:'page'}),'same-page');
  assert.equal(t.api.overlaps(current,edit,{id:'CTX',quote:'gamma',rationale:'context'}),'context');
  t.ctx.FalsifyLab={blueFileChoices:()=>[{id:'blue-x',fileHash:HASH_B,sourceName:'blue',findings:[
    {id:'EXACT',segmentId:'s0',quote:'alpha',start:6,end:11,rationale:'exact'},
    {id:'OTHER',segmentId:'s0',quote:'alpha',start:0,end:5,rationale:'other'},
    {id:'PAGE',segmentId:'s0',quote:'unrelated page text',rationale:'page'},
    {id:'CTX',quote:'gamma',rationale:'context'}
  ]}]};
  await t.api.refreshBlue();
  t.$('paper-manual-blue').value='blue-x'; t.$('paper-manual-blue').change();
  const text=t.$('paper-manual-edits').textContent;
  const same=text.indexOf('같은 자리의 BLUE 지적');
  const page=text.indexOf('같은 쪽의 BLUE 지적');
  const context=text.indexOf('문맥상 가까운 BLUE 지적');
  assert.equal(same>=0&&text.indexOf('EXACT')>same&&text.indexOf('EXACT')<page,true);
  assert.equal(text.indexOf('OTHER')>page&&text.indexOf('PAGE')>page&&text.indexOf('OTHER')<context,true);
  assert.equal(text.indexOf('CTX')>context,true);
  assert.equal(text.includes('탐지'),false);
  assert.equal(t.posts.length,0);
  assert.equal(t.fetches.length,0);
});

test('a stale capture or output link cannot overwrite a newer source or revision',async()=>{
  const bundle=await bundlePromise;
  const gate={hold:null};
  const wrapped={
    normalizePaperEdit(record){
      const hold=gate.hold;
      if(hold&&!hold.used){
        hold.used=true;
        return new Promise((resolve,reject)=>{hold.release=()=>{try{resolve(bundle.normalizePaperEdit(record));}catch(error){reject(error);}};});
      }
      return bundle.normalizePaperEdit(record);
    },
    buildPaperEditArchive:record=>bundle.buildPaperEditArchive(record),
    validateArchive:archive=>bundle.validateArchive(archive),
    archiveHash:archive=>bundle.archiveHash(archive)
  };
  const alpha=[{id:'s0',label:'p1',text:'alpha alpha',pageIndex:0}];
  const omega=[{id:'s0',label:'p1',text:'omega omega',pageIndex:0}];
  const alphaEdit={id:'e1',enabled:true,pageIndex:0,segmentId:'s0',before:'alpha',after:'OLD',origin:'human',anchor:{start:6,end:11,occurrence:1,bbox:null,style:null}};
  const omegaEdit={id:'e9',enabled:true,pageIndex:0,segmentId:'s0',before:'omega',after:'NEW',origin:'human',anchor:{start:6,end:11,occurrence:1,bbox:null,style:null}};
  const t=boot({bundle:wrapped}); await t.api.ready;
  gate.hold={used:false};
  const pending=t.api.capture({source:{fileHash:SOURCE,name:'a',segments:alpha},snapshot:snapshot(SOURCE,1,[alphaEdit]),output:{sha256:HASH_A,revision:1,verification:{}},now:1});
  await flush();
  assert.equal(typeof gate.hold.release,'function');
  const kept=await t.api.capture({source:{fileHash:HASH_C,name:'b',segments:omega},snapshot:snapshot(HASH_C,4,[omegaEdit]),output:{sha256:HASH_B,revision:4,verification:{}},now:2});
  gate.hold.release();
  const old=await pending;
  assert.equal(old.captured,false);
  assert.equal(old.reason,'superseded');
  assert.equal(t.api.records().length,1);
  assert.equal(t.api.records()[0].id,kept.id);
  assert.equal(t.api.records()[0].sourceFileHash,HASH_C);
  assert.equal(t.api.records()[0].edits[0].after,'NEW');
  assert.equal(t.api.records()[0].editRevision,4);
  assert.equal(t.api.downloadLink(t.api.records()[0]).sha256,HASH_B);
  gate.hold={used:false};
  const pendingRevision=t.api.capture({source:{fileHash:HASH_C,name:'b',segments:omega},snapshot:snapshot(HASH_C,5,[{...omegaEdit,after:'MID'}]),output:{sha256:HASH_A,revision:5,verification:{}},now:3});
  await flush();
  await t.api.capture({source:{fileHash:HASH_C,name:'b',segments:omega},snapshot:snapshot(HASH_C,6,[{...omegaEdit,after:'LATE'}]),output:{sha256:HASH_C,revision:6,verification:{}},now:4});
  gate.hold.release();
  const mid=await pendingRevision;
  assert.equal(mid.captured,false);
  assert.equal(t.api.records().length,1);
  assert.equal(t.api.records()[0].editRevision,6);
  assert.equal(t.api.records()[0].edits[0].after,'LATE');
  assert.equal(t.api.downloadLink(t.api.records()[0]).sha256,HASH_C);
  gate.hold={used:false};
  const pendingLink=t.api.linkOutput({sha256:HASH_A,revision:6,verification:{applied:1}});
  await flush();
  await t.api.capture({source:{fileHash:HASH_C,name:'b',segments:omega},snapshot:snapshot(HASH_C,7,[{...omegaEdit,after:'AFTER-LINK'}]),output:null,now:5});
  gate.hold.release();
  const linked=await pendingLink;
  assert.equal(linked.linked,false);
  assert.equal(linked.reason,'superseded');
  assert.equal(t.api.records()[0].editRevision,7);
  assert.equal(t.api.records()[0].edits[0].after,'AFTER-LINK');
  assert.equal(t.api.downloadLink(t.api.records()[0]),null);
  assert.equal(t.posts.length,0);
  assert.equal(t.fetches.length,0);
});

function bootFromScript(scriptSrc){
  const posts=[];
  const storage=new Map([[LEDGER,'{"schema":"falsify.experiment-ledger.v1","runs":[{"id":"keep-local"}]}']]);
  const body=new El('body'), review=new El('section'); review.id='human-evaluation'; body.append(review);
  const location={hash:''};
  let scriptEl=scriptSrc?{src:scriptSrc}:null;
  const document=new EventTarget();
  Object.assign(document,{readyState:'complete',body,createElement:tag=>new El(tag),
    get currentScript(){return scriptEl;},
    set currentScript(value){scriptEl=value&&value.src?{src:value.src}:null;},
    querySelector(sel){if(sel==='[data-view="review"]') return null; if(sel.startsWith('#')) return body.find(node=>node.id===sel.slice(1)); return null;}});
  const ctx=vm.createContext({document,location,CustomEvent,Event,URL,Date,TextEncoder,crypto:globalThis.crypto,console,setTimeout,clearTimeout,
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch(){posts.push('fetch'); throw Error('network disabled');},
    FalsifyConfluenceStore:{ready:Promise.resolve({async publishPaperEdit(record,options){posts.push({record,options}); return {stored:true,pageId:'9001',archiveSha256:HASH_A,alreadyExisted:false};}})}
  });
  const source=fs.readFileSync(path.join(dist,'paper-manual-records.js'),'utf8');
  new vm.Script(source,{filename:scriptSrc||'paper-manual-records.js',importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}).runInContext(ctx);
  document.currentScript=null;
  const $=id=>body.find(node=>node.id===id);
  return {ctx,document,body,posts,storage,api:ctx.FalsifyPaperManualRecords,$};
}
test('capture imports review-bundle from the evaluation URL without a preinjected global',async()=>{
  const bundle=await bundlePromise;
  const scriptSrc=pathToFileURL(path.join(dist,'paper-manual-records.js')).href;
  const t=bootFromScript(scriptSrc);
  await t.api.ready;
  assert.equal(t.document.currentScript,null);
  assert.equal(t.ctx.FalsifyReviewBundle,undefined);
  const anchor={start:6,end:11,occurrence:1,bbox:null,style:null};
  const segments=[{id:'s0',label:'p1',text:'alpha alpha',pageIndex:0}];
  const edit={id:'e1',enabled:true,pageIndex:0,segmentId:'s0',before:'alpha',after:'beta',origin:'human',anchor,createdAt:10,updatedAt:10,history:[{revision:1,at:10,after:'beta',enabled:true,anchor}]};
  const captured=await t.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments},snapshot:snapshot(SOURCE,1,[edit]),output:{sha256:HASH_A,revision:1,verification:{applied:1}},now:10});
  assert.equal(t.ctx.FalsifyReviewBundle,undefined);
  assert.equal(t.document.currentScript,null);
  assert.equal(captured.edits[0].history.length,1);
  assert.equal(captured.edits[0].history[0].after,'beta');
  assert.equal(captured.edits[0].anchor.bbox,null);
  assert.equal(captured.edits[0].anchor.style,null);
  assert.equal(captured.output.sha256,HASH_A);
  const built=await bundle.buildPaperEditArchive(t.api.records()[0]);
  const validated=await bundle.validateArchive(built);
  assert.equal(await bundle.archiveHash(built),await bundle.archiveHash(validated));
  assert.equal(validated.data.record.edits[0].history.length,1);
  assert.equal(validated.data.record.edits[0].createdAt,10);
  t.$('paper-manual-prepare').click();
  assert.equal(t.$('paper-manual-publish').disabled,true);
  assert.equal(t.posts.length,0);
  t.$('paper-manual-cancel').click();
  assert.equal(t.posts.length,0);
  t.$('paper-manual-prepare').click();
  t.$('paper-manual-consent').checked=true; t.$('paper-manual-consent').change();
  t.$('paper-manual-publish').click();
  await until(()=>t.posts.length===1,'one consented post');
  assert.equal(t.posts[0].options.teamShare,true);
  assert.equal(t.posts.some(item=>item==='fetch'),false);
  assert.equal(t.storage.get(LEDGER).includes('keep-local'),true);
  const crashes=[];
  const onUnhandled=error=>crashes.push(error);
  process.on('unhandledRejection', onUnhandled);
  try{
    const bare=bootFromScript(null);
    await bare.api.ready;
    await assert.rejects(bare.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments},snapshot:snapshot(SOURCE,1,[edit]),output:null}),/보관 형식 모듈/);
    await assert.rejects(bare.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments},snapshot:snapshot(SOURCE,1,[edit]),output:null}),/보관 형식 모듈/);
    const missing=bootFromScript(pathToFileURL('/tmp/falsify-no-such-manual/paper-manual-records.js').href);
    await missing.api.ready;
    await assert.rejects(missing.api.capture({source:{fileHash:SOURCE,name:'synthetic.txt',segments},snapshot:snapshot(SOURCE,1,[edit]),output:null}),/보관 형식 모듈|Failed to load|Cannot find/);
    await flush();
    assert.equal(crashes.length,0);
  }finally{process.off('unhandledRejection', onUnhandled);}
});

test('manual record stylesheet keeps the airport tokens',()=>{
  const css=fs.readFileSync(path.join(dist,'paper-manual-records.css'),'utf8');
  assert.match(css,/var\(--ink\)/);
  assert.match(css,/var\(--yellow\)/);
  assert.match(css,/var\(--paper\)/);
  assert.match(css,/#246388/);
  assert.equal(/box-shadow|online/i.test(css),false);
});
