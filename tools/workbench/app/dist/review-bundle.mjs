// Portable Confluence archive codec. No DOM, storage, fetch, credentials, or browser-UMD imports.
// Validators are injected ({harness, red, blue, review}); browser globals are only a fallback.
export const ARCHIVE_SCHEMA='falsify.confluence-archive.v1';
export const BUNDLE_SCHEMA='falsify.review-bundle.v1';
export const LEDGER_SCHEMA='falsify.experiment-ledger.v1';
export const MAX_ARCHIVE_BYTES=6*1024*1024;
export const LEDGER_CHAR_LIMIT=4500000;
export const LIMITS=Object.freeze({harnesses:100,runs:100,reviews:1000,title:500,runId:160,segments:10000,source:1000000,verification:20000});

const HEX=/^[a-f0-9]{64}$/;
const RUN_KEYS=['id','createdAt','role','revision','fileHash','sourceHash','segments','harness','harnessHash','maxCalls','level','model','provenance','response','sourceName','format','finalState','sourceRunId','snapshotOf','requestId'];
const PATCH_KEYS=['id','segmentId','label','before','after','offset','edited'];
const MESSAGES={
  malformed:'Archive shape is not falsify.confluence-archive.v1.',
  cycle:'Archive references form a cycle.',
  missing_ref:'Archive is missing a required run, harness, or review source.',
  conflict:'Archive identifiers conflict or the record set is not the selected-case closure.',
  oversize:'Archive exceeds a size or count limit and was not truncated.',
  hash_mismatch:'Archive content hash or harness hash does not match.',
  validators:'Archive validators are unavailable.'
};

export class ReviewBundleError extends Error{
  constructor(code,message=MESSAGES[code]||MESSAGES.malformed){super(message);this.name='ReviewBundleError';this.code=code;}
}
const fail=(code,message)=>{throw new ReviewBundleError(code,message||MESSAGES[code]);};
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function plain(v){if(!v||typeof v!=='object'||Array.isArray(v))return false;const proto=Object.getPrototypeOf(v);return proto===null||Object.getPrototypeOf(proto)===null;}
function clone(v,seen){
  if(v===null||typeof v==='boolean'||typeof v==='string')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))fail('malformed');return v;}
  if(Array.isArray(v)){if(seen.has(v))fail('cycle');seen.add(v);const out=v.map(x=>clone(x,seen));seen.delete(v);return out;}
  if(!plain(v))fail('malformed');
  if(seen.has(v))fail('cycle');seen.add(v);const out={};for(const k of Object.keys(v))out[k]=clone(v[k],seen);seen.delete(v);return out;
}
const copy=v=>clone(v,new Set());
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
export function canonicalJSON(v){return stable(v);}
function exact(o,keys){return plain(o)&&Object.keys(o).length===keys.length&&keys.every(k=>own(o,k));}
async function sha256(s){return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
function utf8Bytes(s){return new TextEncoder().encode(s).length;}
function boundedJSON(v){let raw;try{raw=JSON.stringify(v);}catch{fail('malformed');}if(typeof raw!=='string')fail('malformed');const canon=canonicalJSON(v);if(utf8Bytes(raw)>MAX_ARCHIVE_BYTES||utf8Bytes(canon)>MAX_ARCHIVE_BYTES)fail('oversize');return v;}

function validatorsOf(v,kind){
  const g=globalThis,harness=v?.harness||g.FalsifyHarness;
  if(!harness||typeof harness.validate!=='function'||typeof harness.hash!=='function')fail('validators');
  if(kind==='harness')return {harness};
  const red=v?.red||g.FalsifyDocumentRed,blue=v?.blue||g.FalsifyDocumentBlue,review=v?.review||g.FalsifyReview;
  if(!red||typeof red.validateResponse!=='function'||typeof red.patches!=='function'||!blue||typeof blue.validateResponse!=='function'||typeof blue.validatePlan!=='function'||typeof blue.overlaps!=='function'||!review||typeof review.validateExtras!=='function')fail('validators');
  return {harness,red,blue,review};
}
function finalState(run,f,red){
  if(!plain(f)||Object.keys(f).some(k=>!['selected','outputFileHash','verification'].includes(k))||!Array.isArray(f.selected)||!f.selected.length||f.selected.length>12)fail('malformed','RED final state is malformed.');
  const original=new Map((run.response?.candidates||[]).map(c=>[c?.id,c]));
  const chosen=f.selected.map(p=>{if(!plain(p)||Object.keys(p).some(k=>!PATCH_KEYS.includes(k)))fail('malformed','RED final patch is malformed.');const c=original.get(p.id);if(!c)fail('conflict','RED final patch is not in the stored response.');if(p.segmentId!==c.segmentId||p.before!==c.before||typeof p.after!=='string')fail('conflict','RED final patch does not match the stored response.');if('edited' in p&&typeof p.edited!=='boolean')fail('malformed');return {id:c.id,segmentId:c.segmentId,before:c.before,after:p.after,edited:p.after!==c.after,selected:true};});
  if(new Set(chosen.map(c=>c.id)).size!==chosen.length)fail('conflict');
  let selected;try{selected=red.patches({segments:run.segments},chosen);}catch{fail('malformed','RED final state does not match the stored response.');}
  const outputFileHash=f.outputFileHash??null;if(outputFileHash!==null&&(typeof outputFileHash!=='string'||!HEX.test(outputFileHash)))fail('hash_mismatch');
  const verification=f.verification??null;if(verification!==null&&(!plain(verification)||JSON.stringify(verification).length>LIMITS.verification))fail('oversize');
  return {selected,outputFileHash,verification:copy(verification)};
}
async function checkRun(r,harnesses,prior,V){
  if(!plain(r)||Object.keys(r).some(k=>!RUN_KEYS.includes(k)))fail('malformed','Run record has an unknown field.');
  if(typeof r.id!=='string'||!r.id||r.id.length>LIMITS.runId||prior.some(x=>x.id===r.id)||!['red','blue'].includes(r.role)||typeof r.revision!=='string'||!r.revision||r.revision.length>160||!['local-codex','manual-unverified','imported-unverified'].includes(r.provenance)||!Number.isInteger(r.maxCalls)||r.maxCalls<1||r.maxCalls>32||typeof r.fileHash!=='string'||!HEX.test(r.fileHash)||typeof r.model!=='string'||!r.model||r.model.length>120||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))fail('malformed','Run identity or conditions are malformed.');
  if('sourceName' in r&&(typeof r.sourceName!=='string'||!r.sourceName.trim()||r.sourceName.length>200)||'format' in r&&(typeof r.format!=='string'||!r.format.trim()||r.format.length>40))fail('malformed');
  if('requestId' in r&&(typeof r.requestId!=='string'||!r.requestId.trim()||r.requestId.length>200))fail('malformed');
  let harness;try{harness=V.harness.validate(r.harness,r.role);}catch{fail('malformed','Run harness is malformed.');}
  if(await V.harness.hash(harness)!==r.harnessHash||!harnesses.some(h=>h.hash===r.harnessHash))fail('hash_mismatch');
  if(!Array.isArray(r.segments)||!r.segments.length||r.segments.length>LIMITS.segments||r.segments.some(s=>!plain(s)||typeof s.id!=='string'||!s.id||s.id.length>80||typeof s.label!=='string'||s.label.length>200||typeof s.text!=='string'||!s.text.trim())||new Set(r.segments.map(s=>s.id)).size!==r.segments.length)fail('malformed','Run source segments are malformed.');
  const source=r.segments.map(s=>s.text).join('\n\n');if(source.length>LIMITS.source||await sha256(source)!==r.sourceHash)fail('hash_mismatch');
  const doc={revision:r.revision,sourceHash:r.sourceHash,segments:r.segments};
  try{if(r.role==='blue')V.blue.validateResponse(doc,r.response);else{if(![1,2,3].includes(r.level))fail('malformed','RED level is malformed.');V.red.validateResponse(doc,r.response);}}catch(e){if(e instanceof ReviewBundleError)throw e;fail('malformed','Stored model response failed validation.');}
  if('finalState' in r&&(r.role!=='red'||stable(finalState(r,r.finalState,V.red))!==stable(r.finalState)))fail('conflict','RED final state does not match the stored response.');
  return copy(r);
}
// An imported-unverified snapshot may cite a root that keeps another provenance. Parent identity still has to match, and a non-imported snapshot may not.
function checkLinks(r,all){
  if('snapshotOf' in r){const root=typeof r.snapshotOf==='string'&&all.find(x=>x.id===r.snapshotOf);if(r.role!=='red'||!r.finalState||!root||root.id===r.id||'snapshotOf' in root||root.role!=='red'||root.sourceHash!==r.sourceHash||root.fileHash!==r.fileHash||root.model!==r.model||(root.provenance!==r.provenance&&r.provenance!=='imported-unverified')||root.revision!==r.revision||root.harnessHash!==r.harnessHash||'requestId' in root&&root.requestId!==r.requestId||root.level!==r.level||root.maxCalls!==r.maxCalls||stable(root.response)!==stable(r.response))fail('missing_ref','Snapshot parent is missing or does not match the stored response.');}
  if('sourceRunId' in r){const red=typeof r.sourceRunId==='string'&&all.find(x=>x.id===r.sourceRunId);if(r.role!=='blue'||red?.role!=='red'||red.finalState?.outputFileHash!==r.fileHash)fail('missing_ref','BLUE source RED run is missing or its output hash differs.');}
}
const REVIEW_KEYS=['id','runId','createdAt','reviewer','caseLabel','verdict','score','note','comparison','findingAssessments','reviewContext'];
function checkReview(v,runs,prior,V){
  if(!plain(v)||Object.keys(v).some(k=>!REVIEW_KEYS.includes(k))||!own(v,'comparison')||typeof v.id!=='string'||!v.id||v.id.length>160||prior.some(x=>x.id===v.id)||typeof v.runId!=='string'||!runs.some(r=>r.id===v.runId)||!['uncertain','supported','unsupported','mixed'].includes(v.verdict)||v.verdict==='uncertain'&&v.score!==null||v.score!==null&&(!Number.isInteger(v.score)||v.score<1||v.score>5)||typeof v.reviewer!=='string'||!v.reviewer.trim()||v.reviewer.length>120||typeof v.caseLabel!=='string'||!v.caseLabel.trim()||v.caseLabel.length>160||typeof v.note!=='string'||!v.note.trim()||v.note.length>3000||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt)))fail('malformed','Review record is malformed.');
  const run=runs.find(r=>r.id===v.runId);
  if(v.comparison!==null){const c=v.comparison;if(run.role!=='blue'||!plain(c)||Object.keys(c).some(k=>!['outputFileHash','selected','assessments','sourceRunId'].includes(k)))fail('malformed','BLUE comparison record is malformed.');
    if('sourceRunId' in c){const red=runs.find(x=>x.id===c.sourceRunId);if(red?.role!=='red'||red.finalState?.outputFileHash!==c.outputFileHash||stable((red.finalState?.selected||[]).map(p=>({id:p.id,before:p.before,after:p.after,label:p.label})))!==stable((c.selected||[]).map(p=>({id:p.id,before:p.before,after:p.after,label:p.label}))))fail('missing_ref','Review comparison RED source is missing or its final text differs.');}
    let patches;try{patches=V.blue.validatePlan(run,{schema:'falsify.document-edit-plan.v1',outputFileHash:c.outputFileHash,selected:c.selected});}catch{fail('malformed','BLUE comparison does not match the stored run.');}
    if(!Array.isArray(c.assessments)||c.assessments.length!==patches.length)fail('malformed');
    for(let i=0;i<patches.length;i++){const a=c.assessments[i],p=patches[i];if(!plain(a)||a.id!==p.id||!['pending','detected','missed','uncertain'].includes(a.verdict)||typeof a.note!=='string'||a.note.length>3000||JSON.stringify(a.quoteOverlapFindingIds)!==JSON.stringify(V.blue.overlaps(p,run.response.findings)))fail('conflict','Review item link does not match the stored response.');}
  }
  try{V.review.validateExtras(v,run);}catch{fail('malformed','Review item judgments do not match the stored response.');}
  return copy(v);
}
function closureIds(runs,reviews,selectedRunId){
  const byId=new Map();
  for(const r of runs){if(!plain(r)||typeof r.id!=='string'||byId.has(r.id))fail('conflict');byId.set(r.id,r);}
  if(!byId.has(selectedRunId))fail('missing_ref');
  const included=new Set(),stack=[];
  const add=id=>{if(!id)return;if(stack.includes(id))fail('cycle');if(included.has(id))return;if(!byId.has(id))fail('missing_ref');stack.push(id);included.add(id);const r=byId.get(id);add(r.snapshotOf);add(r.sourceRunId);stack.pop();};
  add(selectedRunId);
  let grew=true;
  while(grew){grew=false;
    for(const v of reviews){if(!plain(v)||!included.has(v.runId))continue;const red=plain(v.comparison)?v.comparison.sourceRunId:undefined;if(red&&!included.has(red)){add(red);grew=true;}}
    for(const id of [...included]){const r=byId.get(id);if(r?.role!=='blue'||r.sourceRunId)continue;const src=runs.filter(x=>x&&x.role==='red'&&x.finalState&&x.finalState.outputFileHash===r.fileHash).at(-1);if(src&&!included.has(src.id)){add(src.id);grew=true;}}
  }
  return included;
}
async function validateLedger(ledger,selectedRunId,V){
  if(!exact(ledger,['schema','harnesses','runs','reviews'])||ledger.schema!==LEDGER_SCHEMA)fail('malformed','Review bundle ledger shape is malformed.');
  if(!Array.isArray(ledger.harnesses)||!Array.isArray(ledger.runs)||!Array.isArray(ledger.reviews))fail('malformed');
  if(ledger.harnesses.length>LIMITS.harnesses||ledger.runs.length>LIMITS.runs||ledger.reviews.length>LIMITS.reviews)fail('oversize');
  const ids=closureIds(ledger.runs,ledger.reviews,selectedRunId);
  if(ledger.runs.some(r=>!ids.has(r?.id)))fail('conflict','Archive contains a run outside the selected-case closure.');
  const harnesses=[];
  for(const h of ledger.harnesses){if(!exact(h,['config','hash']))fail('malformed','Harness record shape is malformed.');let config;try{config=V.harness.validate(h.config);}catch{fail('malformed','Harness config is malformed.');}if(await V.harness.hash(config)!==h.hash||harnesses.some(x=>x.hash===h.hash))fail('hash_mismatch');if(!ledger.runs.some(r=>r&&r.harnessHash===h.hash))fail('conflict','Archive contains a harness the selected case does not use.');harnesses.push({config:copy(config),hash:h.hash});}
  const runs=[];
  for(const r of ledger.runs)runs.push(await checkRun(r,harnesses,runs,V));
  for(const r of runs)checkLinks(r,runs);
  if(runs.some(r=>!harnesses.some(h=>h.hash===r.harnessHash)))fail('missing_ref');
  const reviews=[];
  for(const v of ledger.reviews){if(!ids.has(v?.runId))fail('conflict','Archive contains a review outside the selected case.');reviews.push(checkReview(v,runs,reviews,V));}
  return {schema:LEDGER_SCHEMA,harnesses,runs,reviews};
}
function experimentTitle(run){
  const name=typeof run.sourceName==='string'&&run.sourceName.trim()?run.sourceName.trim():String(run.sourceHash||'').slice(0,12);
  const title=`${String(run.role||'').toUpperCase()} ${run.finalState?'최종 스냅샷':'응답 기록'} · ${name} · ${run.createdAt} · ${run.id}`;
  if(!title.trim()||title.length>LIMITS.title)fail('oversize','Archive title exceeds 500 characters and was not truncated.');
  return title;
}
function assertTitle(title){if(typeof title!=='string'||!title.trim()||title.length>LIMITS.title||/[\u0000-\u001f\u007f]/.test(title))fail('malformed','Archive title is malformed.');return title;}

export async function archiveHash(archive){const value=copy(archive);boundedJSON(value);return sha256(canonicalJSON(value));}

export async function buildExperimentArchive(snapshot,selectedRunId,validators){
  const V=validatorsOf(validators,'experiment');
  if(!plain(snapshot)||snapshot.schema!==LEDGER_SCHEMA||!Array.isArray(snapshot.harnesses)||!Array.isArray(snapshot.runs)||!Array.isArray(snapshot.reviews))fail('malformed','Snapshot is not a validated experiment ledger.');
  if(typeof selectedRunId!=='string'||!selectedRunId||selectedRunId.length>LIMITS.runId)fail('malformed');
  const before=canonicalJSON(snapshot);
  const ids=closureIds(snapshot.runs,snapshot.reviews,selectedRunId);
  const runs=snapshot.runs.filter(r=>ids.has(r.id));
  const hashes=new Set(runs.map(r=>r&&r.harnessHash));
  const ledger=await validateLedger({schema:LEDGER_SCHEMA,harnesses:snapshot.harnesses.filter(h=>h&&hashes.has(h.hash)),runs,reviews:snapshot.reviews.filter(v=>ids.has(v&&v.runId))},selectedRunId,V);
  if(canonicalJSON(snapshot)!==before)fail('conflict','Building an archive changed the source snapshot.');
  const selected=ledger.runs.find(r=>r.id===selectedRunId);
  const archive={schema:ARCHIVE_SCHEMA,kind:'experiment',id:selectedRunId,title:experimentTitle(selected),data:{schema:BUNDLE_SCHEMA,selectedRunId,ledger}};
  boundedJSON(archive);
  if(canonicalJSON(selected.response)!==canonicalJSON(snapshot.runs.find(r=>r.id===selectedRunId).response))fail('conflict','Archive changed the stored response.');
  return archive;
}

export async function buildHarnessArchive(harnessRecord,validators){
  const V=validatorsOf(validators,'harness');
  if(!plain(harnessRecord)||!own(harnessRecord,'config')||!own(harnessRecord,'hash'))fail('malformed','Harness archive source is malformed.');
  let config;try{config=V.harness.validate(harnessRecord.config);}catch{fail('malformed','Harness config is malformed.');}
  const hash=await V.harness.hash(config);
  if(harnessRecord.hash!==hash)fail('hash_mismatch');
  const title=`${config.role.toUpperCase()} harness · ${config.name} · v${config.version} · ${hash.slice(0,12)}`;
  if(title.length>LIMITS.title)fail('oversize');
  const archive={schema:ARCHIVE_SCHEMA,kind:'harness',id:hash,title,data:{config:copy(config),hash}};
  boundedJSON(archive);
  return archive;
}

export async function validateArchive(archive,validators){
  const value=copy(archive);
  boundedJSON(value);
  if(!exact(value,['schema','kind','id','title','data'])||value.schema!==ARCHIVE_SCHEMA)fail('malformed');
  assertTitle(value.title);
  if(value.kind==='harness'){
    const V=validatorsOf(validators,'harness');
    if(typeof value.id!=='string'||!HEX.test(value.id)||!exact(value.data,['config','hash']))fail('malformed','Harness archive shape is malformed.');
    let config;try{config=V.harness.validate(value.data.config);}catch{fail('malformed','Harness config is malformed.');}
    const hash=await V.harness.hash(config);
    if(value.id!==hash||value.data.hash!==hash)fail('hash_mismatch');
    return {schema:ARCHIVE_SCHEMA,kind:'harness',id:hash,title:value.title,data:{config:copy(config),hash}};
  }
  if(value.kind!=='experiment')fail('malformed');
  const V=validatorsOf(validators,'experiment');
  const data=value.data;
  if(!exact(data,['schema','selectedRunId','ledger'])||data.schema!==BUNDLE_SCHEMA||data.selectedRunId!==value.id||typeof value.id!=='string'||!value.id||value.id.length>LIMITS.runId)fail('malformed','Experiment archive shape is malformed.');
  const ledger=await validateLedger(data.ledger,value.id,V);
  return {schema:ARCHIVE_SCHEMA,kind:'experiment',id:value.id,title:value.title,data:{schema:BUNDLE_SCHEMA,selectedRunId:value.id,ledger}};
}
