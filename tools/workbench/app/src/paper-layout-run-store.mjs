import {unzipSync, zipSync} from 'fflate';
import {hex} from './paragraph-pdf-crypto.mjs';
import {createLatexProject as defaultCreateLatexProject} from './latex-project.mjs';

// Layout run snapshots (falsify.layout-run-state.v1) as produced by the layout
// engine's onState observer. This module validates, encodes and stores them; it
// never compiles, renders, calls a model or interprets trace text. Trace and
// quality entries are plain JSON data only.
export const LAYOUT_RUN_STATE_SCHEMA='falsify.layout-run-state.v1';
export const LAYOUT_RUN_ARCHIVE_SCHEMA='falsify.layout-run-archive.v1';
export const LAYOUT_RUN_DB_NAME='falsify-layout-runs';
export const LAYOUT_RUN_TTL_MS=12*60*60*1000;
export const MAX_LAYOUT_CHECKPOINTS=12;
export const MAX_LAYOUT_TRACE=2048;
export const MAX_MEMORY_RUNS=8;
export const MAX_LAYOUT_ARCHIVE_BYTES=180*1024*1024;
const MAX_JSON_BYTES=16*1024*1024, MAX_DEPTH=48, MAX_ZIP_ENTRIES=4096;
const STORE='runs', MANIFEST='layout-run.json';
const RUN_STATES=new Set(['running','completed','paused','cancelled','failed']);
const sha=/^[a-f0-9]{64}$/, runIdPattern=/^[A-Za-z0-9._:-]{1,128}$/, revisionPattern=/^[A-Za-z0-9._:-]{1,64}$/;
// Exact key names dropped from JSON data so connection credentials cannot be
// exported by accident. Ordinary data keys such as `tokens` are kept.
const SECRET_KEYS=new Set(['token','accesstoken','connectiontoken','officetoken','x-office-token','apikey','api_key','authorization','password','secret','credential','credentials','cookie']);
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

function fail(code='INVALID_LAYOUT_RUN',message='Invalid or mismatched layout run'){throw Object.assign(new Error(message),{code});}
function b64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
function unb64(s){if(typeof s!=='string'||s.length>MAX_LAYOUT_ARCHIVE_BYTES||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail();let raw;try{raw=atob(s);}catch{fail();}return Uint8Array.from(raw,c=>c.charCodeAt(0));}
const isPlain=v=>v!==null&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);

/** Copy plain JSON data. Binary, functions, cycles and non-finite numbers are rejected. */
function jsonData(value,depth=0){
  if(depth>MAX_DEPTH)fail();
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail();return value;}
  if(Array.isArray(value))return value.map(v=>v===undefined?null:jsonData(v,depth+1));
  if(!isPlain(value))fail();
  const out={};
  for(const [k,v] of Object.entries(value)){if(v===undefined||SECRET_KEYS.has(k.toLowerCase()))continue;out[k]=jsonData(v,depth+1);}
  return out;
}
function boundedJSON(value){let s;try{s=JSON.stringify(value);}catch{fail();}if(typeof s!=='string'||enc.encode(s).length>MAX_JSON_BYTES)fail('LAYOUT_RUN_TOO_LARGE','Layout run data exceeds the size limit');return s;}

// Supplied project/artifact bytes are treated as immutable: a verified object is
// hashed once and reused by later snapshots instead of being re-hashed or cloned.
const verifiedProjects=new WeakMap(), verifiedArtifacts=new WeakMap();
function validateProjectBytes(project){
  if(project?.schema!=='falsify.latex-project.v1'||!sha.test(project.id)||!Array.isArray(project.files)||!project.files.length)fail();
  for(const f of project.files)if(!(f?.bytes instanceof Uint8Array)||!sha.test(f.sha256)||hex(f.bytes)!==f.sha256)fail();
}
async function verifyProject(project,createLatexProject){
  if(project&&typeof project==='object'&&verifiedProjects.has(project))return verifiedProjects.get(project);
  validateProjectBytes(project);
  let p;try{p=await createLatexProject({files:project.files,mainFile:project.mainFile??null,engine:project.engine,origin:project.origin,sourcePdfHash:project.sourcePdfHash});}catch{fail();}
  if(p.id!==project.id)fail();
  // Hashes are equal, so keep the caller's buffers rather than createLatexProject's copies.
  const original=new Map(project.files.map(f=>[f.path,f]));
  const out={...p,revision:Number.isSafeInteger(project.revision)&&project.revision>=0?project.revision:p.revision,files:p.files.map(f=>({path:f.path,bytes:original.get(f.path)?.sha256===f.sha256?original.get(f.path).bytes:f.bytes,sha256:f.sha256}))};
  verifiedProjects.set(project,out);verifiedProjects.set(out,out);
  return out;
}
function verifyArtifact(artifact,project){
  if(artifact==null)return null;
  const cached=verifiedArtifacts.get(artifact);
  if(cached){if(cached.projectId!==project.id||cached.engine!==project.engine)fail();return cached;}
  if(artifact.success!==true||artifact.projectId!==project.id||artifact.engine!==project.engine||!(artifact.pdfBytes instanceof Uint8Array)||!artifact.pdfBytes.length||!sha.test(artifact.pdfHash)||hex(artifact.pdfBytes)!==artifact.pdfHash)fail();
  if(artifact.synctex!==undefined&&!(artifact.synctex instanceof Uint8Array))fail();
  const {pdfBytes,synctex,...meta}=artifact;
  const out={...jsonData(meta),pdfBytes,...(synctex?{synctex}:{})};
  verifiedArtifacts.set(artifact,out);verifiedArtifacts.set(out,out);
  return out;
}
// The same rule the layout engine applies to tool output: a later revision
// keeps origin/engine/source PDF and every non-TeX asset of the baseline.
function sameLineage(base,p){
  if(p.origin!==base.origin||p.engine!==base.engine||p.sourcePdfHash!==base.sourcePdfHash)fail();
  for(const f of base.files)if(!(/\.tex$/i.test(f.path)||/^falsify-(?:layout-structure|reconstruction)\.json$/.test(f.path))&&!p.files.some(g=>g.path===f.path&&g.sha256===f.sha256))fail();
}
async function verifyPair(pair,base,createLatexProject,{allowMissingArtifact=true}={}){
  if(!isPlain(pair)||!('project' in pair)||!('artifact' in pair))fail();
  const project=await verifyProject(pair.project,createLatexProject);sameLineage(base,project);
  const artifact=verifyArtifact(pair.artifact,project);
  if(!artifact&&!allowMissingArtifact)fail();
  return {project,artifact};
}

function validateRunHeader({runId,parentRunId,carriedStepCount,runState,status,stepCount}) {
  if(typeof runId!=='string'||!runIdPattern.test(runId))fail();
  if(parentRunId!=null&&(typeof parentRunId!=='string'||!runIdPattern.test(parentRunId)))fail();
  if(carriedStepCount!==undefined&&(!Number.isSafeInteger(carriedStepCount)||carriedStepCount<0))fail();
  if(!RUN_STATES.has(runState)||typeof status!=='string'||status.length>64||!Number.isSafeInteger(stepCount)||stepCount<0||stepCount>1e6)fail();
}
function validateCheckpoint(c,ids) {
  if(!isPlain(c)||typeof c.revisionId!=='string'||!revisionPattern.test(c.revisionId)||ids.has(c.revisionId)||typeof c.label!=='string'||c.label.length>200)fail();
}
function validateRunEvidence(trace,coverage,quality) {
  if(!Array.isArray(trace)||trace.length>MAX_LAYOUT_TRACE||trace.some(e=>!isPlain(e)))fail();
  if(coverage!==null&&!isPlain(coverage)||quality!==null&&!isPlain(quality))fail();
}
/** Validate a layout run state and return a normalized copy sharing the verified byte buffers. */
export async function validateLayoutRunState(state,{createLatexProject=defaultCreateLatexProject}={}){
  if(!isPlain(state)||(state.schema!==undefined&&state.schema!==LAYOUT_RUN_STATE_SCHEMA))fail();
  const {schema,runId,parentRunId,carriedStepCount,baselineProject,baselineArtifact=null,currentProject,candidate,previousCandidate,checkpoints=[],trace=[],coverage=null,quality=null,status,runState,stepCount,...extra}=state;
  validateRunHeader({runId,parentRunId,carriedStepCount,runState,status,stepCount});
  const base=await verifyProject(baselineProject,createLatexProject);
  const baseArtifact=verifyArtifact(baselineArtifact,base);
  const current=await verifyProject(currentProject,createLatexProject);sameLineage(base,current);
  const cand=await verifyPair(candidate,base,createLatexProject);
  const prev=previousCandidate==null?null:await verifyPair(previousCandidate,base,createLatexProject);
  if(!Array.isArray(checkpoints)||checkpoints.length>MAX_LAYOUT_CHECKPOINTS)fail();
  const ids=new Set(),cps=[];
  for(const c of checkpoints){
    validateCheckpoint(c,ids);
    ids.add(c.revisionId);
    const pair=await verifyPair({project:c.project,artifact:c.artifact??null},base,createLatexProject);
    cps.push({revisionId:c.revisionId,label:c.label,...pair});
  }
  validateRunEvidence(trace,coverage,quality);
  const out={schema:LAYOUT_RUN_STATE_SCHEMA,runId,...(parentRunId!=null?{parentRunId}:{}),...(carriedStepCount!==undefined?{carriedStepCount}:{}),
    baselineProject:base,baselineArtifact:baseArtifact,currentProject:current,candidate:cand,...(prev?{previousCandidate:prev}:{}),
    checkpoints:cps,trace:jsonData(trace),coverage:jsonData(coverage),quality:jsonData(quality),status,runState,stepCount,...jsonData(extra)};
  boundedJSON({trace:out.trace,coverage:out.coverage,quality:out.quality,extra:Object.keys(extra)});
  return out;
}

function manifestOf(state){
  const assets=new Map();
  const add=bytes=>{const h=hex(bytes);if(!assets.has(h))assets.set(h,bytes);return h;};
  const projectRef=p=>({schema:p.schema,id:p.id,revision:p.revision,origin:p.origin,mainFile:p.mainFile,engine:p.engine,...(p.sourcePdfHash?{sourcePdfHash:p.sourcePdfHash}:{}),files:p.files.map(f=>{if(add(f.bytes)!==f.sha256)fail();return {path:f.path,sha256:f.sha256};})});
  const artifactRef=a=>{if(!a)return null;const {pdfBytes,synctex,...meta}=a;if(add(pdfBytes)!==a.pdfHash)fail();return {...meta,...(synctex?{synctexHash:add(synctex)}:{})};};
  const pair=x=>({project:projectRef(x.project),artifact:artifactRef(x.artifact)});
  const {baselineProject,baselineArtifact,currentProject,candidate,previousCandidate,checkpoints,...rest}=state;
  const s={...rest,baselineProject:projectRef(baselineProject),baselineArtifact:artifactRef(baselineArtifact),currentProject:projectRef(currentProject),candidate:pair(candidate),...(previousCandidate?{previousCandidate:pair(previousCandidate)}:{}),checkpoints:checkpoints.map(c=>({revisionId:c.revisionId,label:c.label,...pair(c)}))};
  return {state:s,assets};
}
function rebuild(s,assets){
  const bytesOf=h=>{if(!sha.test(h)||!assets.has(h))fail();return assets.get(h);};
  const project=p=>{if(!isPlain(p)||!Array.isArray(p.files))fail();return {...p,files:p.files.map(f=>{if(!isPlain(f))fail();return {path:f.path,sha256:f.sha256,bytes:bytesOf(f.sha256)};})};};
  const artifact=a=>{if(a==null)return null;if(!isPlain(a))fail();const {synctexHash,...meta}=a;return {...meta,pdfBytes:bytesOf(a.pdfHash),...(synctexHash!==undefined?{synctex:bytesOf(synctexHash)}:{})};};
  const pair=x=>{if(!isPlain(x))fail();return {project:project(x.project),artifact:artifact(x.artifact)};};
  if(!isPlain(s)||!Array.isArray(s.checkpoints))fail();
  return {...s,baselineProject:project(s.baselineProject),baselineArtifact:artifact(s.baselineArtifact),currentProject:project(s.currentProject),candidate:pair(s.candidate),...(s.previousCandidate!=null?{previousCandidate:pair(s.previousCandidate)}:{}),checkpoints:s.checkpoints.map(c=>{if(!isPlain(c))fail();return {revisionId:c.revisionId,label:c.label,...pair(c)};})};
}
function sealed(payload){const body=boundedJSON(payload);return {schema:LAYOUT_RUN_ARCHIVE_SCHEMA,payload,sha256:hex(enc.encode(body))};}
function unseal(json){
  if(typeof json!=='string'||enc.encode(json).length>MAX_LAYOUT_ARCHIVE_BYTES)fail();
  let a;try{a=JSON.parse(json);}catch{fail();}
  if(!isPlain(a)||a.schema!==LAYOUT_RUN_ARCHIVE_SCHEMA||!sha.test(a.sha256)||!isPlain(a.payload))fail();
  let body;try{body=JSON.stringify(a.payload);}catch{fail();}
  if(hex(enc.encode(body))!==a.sha256)fail();
  return a.payload;
}

/** encodeLayoutRun(state,{createLatexProject?}) -> JSON string with hash-deduplicated base64 assets. */
export async function encodeLayoutRun(state,options={}){
  const valid=await validateLayoutRunState(state,options);
  const {state:s,assets}=manifestOf(valid);
  const out=boundedJSON(sealed({state:s,assets:Object.fromEntries([...assets].map(([h,b])=>[h,b64(b)]))}));
  if(enc.encode(out).length>MAX_LAYOUT_ARCHIVE_BYTES)fail('LAYOUT_RUN_TOO_LARGE','Layout run data exceeds the size limit');
  return out;
}
/** decodeLayoutRun(json,{createLatexProject?}) validates checksum, every asset hash and all pairings before returning. */
export async function decodeLayoutRun(json,options={}){
  const payload=unseal(json);
  if(!isPlain(payload.assets))fail();
  const assets=new Map();
  for(const [h,v] of Object.entries(payload.assets)){const bytes=unb64(v);if(!sha.test(h)||hex(bytes)!==h)fail();assets.set(h,bytes);}
  return validateLayoutRunState(rebuild(payload.state,assets),options);
}
/** exportLayoutRun(state) -> ZIP bytes: layout-run.json plus assets/<sha256>, each asset stored once. */
export async function exportLayoutRun(state,options={}){
  const valid=await validateLayoutRunState(state,options);
  const {state:s,assets}=manifestOf(valid);
  const entries=Object.create(null);
  entries[MANIFEST]=enc.encode(boundedJSON(sealed({state:s,assetHashes:[...assets.keys()].sort()})));
  for(const [h,b] of assets)entries['assets/'+h]=[b,{level:0}];
  return zipSync(entries);
}
/** importLayoutRun(bytes) validates ZIP bounds, entry names, asset hashes and the run state. */
export async function importLayoutRun(bytes,options={}){
  if(!(bytes instanceof Uint8Array)||bytes.length>MAX_LAYOUT_ARCHIVE_BYTES)fail();
  let files;
  try{let count=0,total=0;unzipSync(bytes,{filter:f=>{if(++count>MAX_ZIP_ENTRIES)throw 0;total+=f.originalSize;if(total>MAX_LAYOUT_ARCHIVE_BYTES)throw 0;return false;}});files=unzipSync(bytes);}catch{fail();}
  const names=Object.keys(files);
  if(!(MANIFEST in files))fail();
  let json;try{json=dec.decode(files[MANIFEST]);}catch{fail();}
  const payload=unseal(json);
  if(!Array.isArray(payload.assetHashes)||new Set(payload.assetHashes).size!==payload.assetHashes.length)fail();
  const expected=new Set([MANIFEST,...payload.assetHashes.map(h=>'assets/'+h)]);
  if(names.length!==expected.size||names.some(n=>!expected.has(n)))fail();
  const assets=new Map();
  for(const h of payload.assetHashes){const b=files['assets/'+h];if(!sha.test(h)||hex(b)!==h)fail();assets.set(h,b);}
  return validateLayoutRunState(rebuild(payload.state,assets),options);
}

// ---- IndexedDB persistence (separate database namespace) ----
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
function storageError(error){
  const name=error?.name||'';
  const code=name==='QuotaExceededError'||error?.code===22?'STORAGE_QUOTA':error?.code==='STORAGE_UNAVAILABLE'?'STORAGE_UNAVAILABLE':'STORAGE_FAILED';
  return {code,message:code==='STORAGE_QUOTA'?'Browser storage quota exceeded; the run is kept in this tab only.':code==='STORAGE_UNAVAILABLE'?'Browser storage is unavailable; the run is kept in this tab only.':'Browser storage failed; the run is kept in this tab only.'};
}
function tx(db,mode,work){
  return new Promise((resolve,reject)=>{
    let t,value;
    try{t=db.transaction(STORE,mode);}catch(e){reject(e);return;}
    t.oncomplete=()=>resolve(value);
    t.onerror=()=>reject(t.error);
    t.onabort=()=>reject(t.error||Object.assign(new Error('Transaction aborted'),{name:'AbortError'}));
    // Requests are issued synchronously while the transaction is active.
    let pending;try{pending=work(t.objectStore(STORE));}catch(e){try{t.abort();}catch{}reject(e);return;}
    Promise.resolve(pending).then(v=>{value=v;},e=>{try{t.abort();}catch{}reject(e);});
  });
}
// Unique identity of one persisted write. A row is only ever removed by the
// operation that observed exactly that write, never by key alone.
export function createWriteIdentity(){
  const nonce=globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;let seq=0;
  return ()=>`${nonce}:${++seq}`;
}
const sameWrite=(stored,row)=>!!stored&&!!row&&stored.writeId===row.writeId&&stored.savedAt===row.savedAt;
// Compare-and-delete inside the caller's transaction: get, then delete in the
// same transaction only when the stored row is still the observed write.
export function deleteIfSameWrite(store,key,row){
  return new Promise((resolve,reject)=>{
    const g=store.get(key);
    g.onerror=()=>reject(g.error);
    g.onsuccess=()=>{if(!sameWrite(g.result,row)){resolve(false);return;}const d=store.delete(key);d.onsuccess=()=>resolve(true);d.onerror=()=>reject(d.error);};
  });
}

/**
 * createLayoutRunStore({now,indexedDB,createLatexProject}) keeps every put in memory
 * (bounded to MAX_MEMORY_RUNS distinct runs, oldest evicted first, for the tab
 * session) and persists to IndexedDB only with explicit consent, for 12 hours.
 * Withdrawing consent deletes persisted runs; memory is kept. Storage failures are
 * returned as {code,message}, never thrown, so the current candidate is retained.
 */
export function createLayoutRunStore({now=Date.now,indexedDB=globalThis.indexedDB,createLatexProject=defaultCreateLatexProject}={}){
  const memory=new Map(),nextWriteId=createWriteIdentity(),latestWrite=new Map();let consent=false,epoch=0,wipeEpoch=0,dbPromise=null,disposed=false,lastError=null,activePuts=0,closeWhenIdle=null;
  const writeSeq=id=>{const n=Number(String(id).slice(String(id).lastIndexOf(':')+1));return Number.isSafeInteger(n)?n:0;};
  // Invocation order, not validation/encode completion order. A later put of the same run wins.
  const claim=(runId,writeId)=>{const prev=latestWrite.get(runId)??null;if(!prev||writeSeq(writeId)>=writeSeq(prev))latestWrite.set(runId,writeId);return prev;};
  const owns=(runId,writeId)=>latestWrite.get(runId)===writeId;
  const wantsPersistence=explicit=>explicit===true||explicit===undefined&&consent===true;
  const staleWrite=(at,runId,writeId)=>disposed||at<wipeEpoch||!owns(runId,writeId);
  const shouldSkipPersistence=(wanted,at,runId,writeId)=>!wanted||at!==epoch||staleWrite(at,runId,writeId);
  const staleConsentWrite=(at,runId,writeId)=>disposed||at!==epoch||at<wipeEpoch||!owns(runId,writeId);
  const unclaim=(runId,writeId,prev)=>{if(runId&&owns(runId,writeId)){if(prev)latestWrite.set(runId,prev);else latestWrite.delete(runId);}};
  const reconcileClaim=(runId,hinted,writeId,prev)=>{if(runId!==hinted){if(hinted)unclaim(hinted,writeId,prev);claim(runId,writeId);}};
  const closeDb=()=>{const p=dbPromise;dbPromise=null;p?.then(db=>db.close?.(),()=>{});};
  const live=()=>{if(disposed)throw Object.assign(new Error('Layout run store is disposed'),{code:'DISPOSED'});};
  const open=()=>{
    if(!indexedDB||typeof indexedDB.open!=='function')return Promise.reject(Object.assign(new Error('IndexedDB unavailable'),{code:'STORAGE_UNAVAILABLE'}));
    dbPromise??=new Promise((resolve,reject)=>{
      let r;try{r=indexedDB.open(LAYOUT_RUN_DB_NAME,1);}catch(e){reject(e);return;}
      r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'runId'});};
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Object.assign(new Error('IndexedDB blocked'),{code:'STORAGE_UNAVAILABLE'}));
    }).catch(e=>{dbPromise=null;throw e;});
    return dbPromise;
  };
  const fresh=r=>Number.isFinite(r?.savedAt)&&Number.isFinite(r?.expiresAt)&&r.savedAt<=now()&&now()<r.expiresAt;
  const remember=(state,savedAt)=>{memory.delete(state.runId);memory.set(state.runId,{state,savedAt});while(memory.size>MAX_MEMORY_RUNS)memory.delete(memory.keys().next().value);};
  const summary=(state,savedAt,persisted,expiresAt=null)=>({runId:state.runId,...(state.parentRunId?{parentRunId:state.parentRunId}:{}),runState:state.runState,status:state.status,stepCount:state.stepCount,candidatePdfHash:state.candidate.artifact?.pdfHash??null,savedAt,expiresAt,persisted});
  async function persistedRecords(){
    const db=await open();
    const rows=await tx(db,'readonly',s=>req(s.getAll()));
    const stale=rows.filter(r=>!fresh(r)||typeof r.runId!=='string');
    // A newer write of the same runId may land between the read and this cleanup.
    if(stale.length)await tx(db,'readwrite',s=>Promise.all(stale.map(r=>typeof r.runId==='string'?deleteIfSameWrite(s,r.runId,r):req(s.delete(r.runId)))));
    return rows.filter(r=>fresh(r)&&typeof r.runId==='string');
  }
  const writeWithdrawn=at=>disposed||at!==epoch||at<wipeEpoch;
  function failedPut(e,at,runId,savedAt){
    if(disposed||at<wipeEpoch)return {runId,savedAt,persisted:false};
    lastError=storageError(e);return {runId,savedAt,persisted:false,storageError:lastError};
  }
  function finishPut(){activePuts--;if(disposed&&activePuts===0&&closeWhenIdle){const close=closeWhenIdle;closeWhenIdle=null;close();}}
  return {
    async put(state,{consent:explicit}={}){
      live();
      // Capture the consent epoch at call time so a withdrawal during validation or the write wins.
      // writeId is assigned now so a slower earlier save cannot pass a save invoked after it.
      const at=epoch,wanted=wantsPersistence(explicit),writeId=nextWriteId();
      const hinted=typeof state?.runId==='string'?state.runId:null,prev=hinted?claim(hinted,writeId):null;
      activePuts++;
      try{
        let valid;
        try{valid=await validateLayoutRunState(state,{createLatexProject});}
        catch(e){if(hinted)unclaim(hinted,writeId,prev);throw e;}
        reconcileClaim(valid.runId,hinted,writeId,prev);
        const savedAt=now();
        // clear/dispose bumps wipeEpoch. Consent withdrawal bumps epoch only, so memory still updates.
        if(staleWrite(at,valid.runId,writeId))return {runId:valid.runId,savedAt,persisted:false};
        remember(valid,savedAt);
        if(shouldSkipPersistence(wanted,at,valid.runId,writeId))return {runId:valid.runId,savedAt,persisted:false};
        try{
          const data=await encodeLayoutRun(valid,{createLatexProject});
          if(staleConsentWrite(at,valid.runId,writeId))return {runId:valid.runId,savedAt,persisted:false};
          const db=await open();
          const row={runId:valid.runId,writeId,savedAt,expiresAt:savedAt+LAYOUT_RUN_TTL_MS,data};
          // Epoch and invocation identity are re-checked when the put is issued. A withdrawal,
          // clear, dispose, or a later save before that point means this put is never queued.
          // After it is queued, roll this exact write back only for consent withdrawal, clear,
          // or dispose. A newer invocation that only took the claim leaves this valid row;
          // a later issued readwrite transaction overwrites it when that save succeeds.
          const issued=await tx(db,'readwrite',s=>at!==epoch||!owns(valid.runId,writeId)?false:req(s.put(row)).then(()=>true));
          const withdrawn=writeWithdrawn(at);
          if(!issued||withdrawn){if(issued){try{await tx(db,'readwrite',s=>deleteIfSameWrite(s,valid.runId,row));}catch{}}return {runId:valid.runId,savedAt,persisted:false};}
          if(!owns(valid.runId,writeId))return {runId:valid.runId,savedAt,persisted:false};
          lastError=null;
          return {runId:valid.runId,savedAt,persisted:true,expiresAt:savedAt+LAYOUT_RUN_TTL_MS};
        }catch(e){return failedPut(e,at,valid.runId,savedAt);}
      }finally{finishPut();}
    },
    async get(runId){
      live();
      if(runId!==undefined&&(typeof runId!=='string'||!runIdPattern.test(runId)))return null;
      const hit=runId===undefined?[...memory.values()].at(-1):memory.get(runId);
      if(hit)return hit.state;
      let rows;try{rows=await persistedRecords();}catch(e){lastError=storageError(e);return null;}
      const row=runId===undefined?rows.sort((a,b)=>b.savedAt-a.savedAt)[0]:rows.find(r=>r.runId===runId);
      if(!row)return null;
      try{return await decodeLayoutRun(row.data,{createLatexProject});}
      catch{try{const db=await open();await tx(db,'readwrite',s=>deleteIfSameWrite(s,row.runId,row));}catch{}return null;}
    },
    async list(){
      live();
      const out=new Map();
      let rows=[];try{if(indexedDB)rows=await persistedRecords();}catch(e){lastError=storageError(e);}
      for(const r of rows){try{const s=await decodeLayoutRun(r.data,{createLatexProject});out.set(s.runId,summary(s,r.savedAt,true,r.expiresAt));}catch{}}
      for(const [id,m] of memory){const p=out.get(id);out.set(id,{...summary(m.state,m.savedAt,!!p&&p.savedAt>=m.savedAt,p?.expiresAt??null)});}
      return [...out.values()].sort((a,b)=>b.savedAt-a.savedAt);
    },
    async clear(){
      live();memory.clear();epoch++;wipeEpoch=epoch;
      if(!indexedDB)return {cleared:true};
      try{const db=await open();await tx(db,'readwrite',s=>req(s.clear()));return {cleared:true};}
      catch(e){lastError=storageError(e);return {cleared:false,storageError:lastError};}
    },
    async setConsent(value){
      live();
      if(typeof value!=='boolean')throw new TypeError('Consent must be boolean');
      consent=value;
      if(value)return {consent};
      epoch++;
      if(!indexedDB)return {consent};
      try{const db=await open();await tx(db,'readwrite',s=>req(s.clear()));return {consent};}
      catch(e){lastError=storageError(e);return {consent,storageError:lastError};}
    },
    get consent(){return consent;},
    get lastError(){return lastError;},
    dispose(){if(disposed)return;disposed=true;memory.clear();epoch++;wipeEpoch=epoch;if(activePuts===0)closeDb();else closeWhenIdle=closeDb;},
  };
}
