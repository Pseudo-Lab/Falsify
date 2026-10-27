// Portable Confluence archive codec. No DOM, storage, fetch, credentials, or browser-UMD imports.
// Validators are injected ({harness, red, blue, review}); browser globals are only a fallback.
export const ARCHIVE_SCHEMA='falsify.confluence-archive.v1';
export const BUNDLE_SCHEMA='falsify.review-bundle.v1';
export const LEDGER_SCHEMA='falsify.experiment-ledger.v1';
export const PAPER_EDIT_SCHEMA='falsify.paper-edit-record.v1';
export const MAX_ARCHIVE_BYTES=6*1024*1024;
export const LEDGER_CHAR_LIMIT=4500000;
export const LIMITS=Object.freeze({harnesses:100,runs:100,reviews:1000,title:500,runId:160,segments:10000,source:1000000,verification:20000,paperEdits:200,paperReviews:100,editText:8000});

const HEX=/^[a-f0-9]{64}$/;
const RUN_KEYS=['id','createdAt','role','revision','fileHash','sourceHash','segments','harness','harnessHash','maxCalls','level','model','provenance','response','sourceName','format','finalState','sourceRunId','snapshotOf','requestId','visualEvidence','inputMode'];
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
function checkVisualRefs(items,r){
  const hasGold=x=>x&&typeof x==='object'&&(own(x,'gold')||Object.values(x).some(hasGold));
  if(r.role!=='blue'||!Array.isArray(items)||items.length<1||items.length>2||hasGold(r.response))fail('malformed','Visual evidence is malformed.');
  for(const v of items){
    if(!exact(v,['fileHash','sourceHash','page','bbox','rotation','width','height','mime','sha256','provenance','artifact'])||v.fileHash!==r.fileHash||v.sourceHash!==r.sourceHash||!HEX.test(v.sha256)||v.mime!=='image/png'||v.provenance!=='client-declared-pdf-association'||v.artifact!=='unavailable'||!Number.isSafeInteger(v.page)||v.page<1||![0,90,180,270].includes(v.rotation)||!Array.isArray(v.bbox)||v.bbox.length!==4||!v.bbox.every(Number.isFinite)||v.bbox[0]<0||v.bbox[1]<0||v.bbox[2]<=0||v.bbox[3]<=0||!Number.isInteger(v.width)||!Number.isInteger(v.height)||v.width!==Math.ceil(v.bbox[2]*2)||v.height!==Math.ceil(v.bbox[3]*2)||v.width>4096||v.height>4096||v.width*v.height>8000000)fail('malformed','Visual evidence reference is malformed.');
  }
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
  if('inputMode' in r&&(!['text','visual'].includes(r.inputMode)||(r.inputMode==='visual')!==('visualEvidence' in r)))fail('malformed','Input mode and visual evidence do not match.');
  if('visualEvidence' in r)checkVisualRefs(r.visualEvidence,r);
  try{if(r.role==='blue')V.blue.validateResponse(doc,r.response,'visualEvidence' in r?{visualEvidence:r.visualEvidence}:undefined);else{if(![1,2,3].includes(r.level))fail('malformed','RED level is malformed.');V.red.validateResponse(doc,r.response);}}catch(e){if(e instanceof ReviewBundleError)throw e;fail('malformed','Stored model response failed validation.');}
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

const PAPER_ORIGINS=['human','external-ai-import','ai-proposal'];
const PAPER_VERDICTS=['uncertain','supported','unsupported','mixed'];
const FINDING_VERDICTS=['pending','supported','unsupported','mixed','uncertain'];
const PAPER_BANNED=/^(pdf|pdfBytes|sourcePdf|sourcePDF|binary|bytes|contentBase64|gold|harness|attestation)$/;
const LEGACY_ANCHOR_KEYS=['bbox','occurrence','start','end','fontSize','fontName','color'];
const REAL_ANCHOR_KEYS=['bbox','end','occurrence','start','style'];
const STYLE_KEYS=['color','font','size'];
const HISTORY_KEYS=['after','anchor','at','enabled','revision'];
const EDIT_META_KEYS=['createdAt','updatedAt','history'];
const PAPER_REVIEW_KEYS=['id','createdAt','reviewer','caseLabel','verdict','score','note','alignment','editRevision','outputHash','stale'];
const MAX_CLOCK=8640000000000000;

function rejectPaperCarrier(v,depth){
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='number'){if(!Number.isFinite(v))fail('malformed');return;}
  if(typeof v==='string'){if(v.startsWith('%PDF-'))fail('malformed','Source PDF bytes are not part of a paper-edit archive.');return;}
  if(depth>8)fail('oversize','Paper-edit verification is nested too deeply.');
  if(Array.isArray(v)){if(v.length>10000)fail('oversize');for(const item of v)rejectPaperCarrier(item,depth+1);return;}
  if(!plain(v))fail('malformed');
  const keys=Object.keys(v);
  if(keys.length>80)fail('oversize');
  for(const key of keys){if(PAPER_BANNED.test(key))fail('malformed','Paper-edit archive cannot carry PDF bytes, gold, or harness attestation.');rejectPaperCarrier(v[key],depth+1);}
}
function clockOf(value){return Number.isSafeInteger(value)&&value>=0&&value<=MAX_CLOCK;}
function paperStyle(style){
  if(style===null)return null;
  if(!exact(style,STYLE_KEYS))fail('malformed','Edit anchor style is malformed.');
  if(typeof style.font!=='string'||style.font.length<1||style.font.length>128||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(style.font))fail('malformed','Edit anchor style is malformed.');
  if(typeof style.size!=='number'||!Number.isFinite(style.size)||style.size<=0||style.size>1000)fail('malformed','Edit anchor style is malformed.');
  if(!Number.isInteger(style.color)||style.color<0||style.color>0xffffff)fail('malformed','Edit anchor style is malformed.');
  return {font:style.font,size:style.size,color:style.color};
}
function paperBbox(bbox,real){
  if(bbox===null){if(real)return null;fail('malformed','Edit anchor box is malformed.');}
  if(!Array.isArray(bbox)||bbox.length!==4)fail('malformed','Edit anchor box is malformed.');
  const out=[];
  for(const value of bbox){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>100000)fail('malformed','Edit anchor box is malformed.');out.push(value);}
  if(real&&!(out[0]<out[2]&&out[1]<out[3]))fail('malformed','Edit anchor box is malformed.');
  return out;
}
function paperAnchor(anchor){
  if(anchor===null)return null;
  if(!plain(anchor))fail('malformed','Edit anchor is malformed.');
  if(own(anchor,'style')||own(anchor,'bbox')&&anchor.bbox===null){
    if(!exact(anchor,REAL_ANCHOR_KEYS))fail('malformed','Edit anchor is malformed.');
    if(!Number.isInteger(anchor.start)||anchor.start<0||anchor.start>200000)fail('malformed','Edit anchor offset is malformed.');
    if(!Number.isInteger(anchor.end)||anchor.end<=anchor.start||anchor.end>200000)fail('malformed','Edit anchor offset is malformed.');
    if(!Number.isInteger(anchor.occurrence)||anchor.occurrence<0||anchor.occurrence>999)fail('malformed','Edit anchor offset is malformed.');
    return {start:anchor.start,end:anchor.end,occurrence:anchor.occurrence,bbox:paperBbox(anchor.bbox,true),style:paperStyle(anchor.style)};
  }
  if(!Object.keys(anchor).length||Object.keys(anchor).some(key=>!LEGACY_ANCHOR_KEYS.includes(key)))fail('malformed','Edit anchor is malformed.');
  const out={};
  if(own(anchor,'bbox'))out.bbox=paperBbox(anchor.bbox,false);
  for(const key of ['occurrence','start','end'])if(own(anchor,key)){if(!Number.isInteger(anchor[key])||anchor[key]<0||anchor[key]>10000000)fail('malformed','Edit anchor offset is malformed.');out[key]=anchor[key];}
  if(own(anchor,'fontSize')){if(typeof anchor.fontSize!=='number'||!Number.isFinite(anchor.fontSize)||anchor.fontSize<=0||anchor.fontSize>512)fail('malformed');out.fontSize=anchor.fontSize;}
  if(own(anchor,'fontName')){if(typeof anchor.fontName!=='string'||!anchor.fontName.trim()||anchor.fontName.length>80)fail('malformed');out.fontName=anchor.fontName;}
  if(own(anchor,'color')){if(typeof anchor.color!=='string'||!/^#[0-9a-fA-F]{3,8}$/.test(anchor.color))fail('malformed');out.color=anchor.color;}
  return out;
}
function paperHistory(list,edit){
  if(!Array.isArray(list)||list.length<1||list.length>12)fail('malformed','Edit history is malformed.');
  if(!clockOf(edit.createdAt)||!clockOf(edit.updatedAt)||edit.createdAt>edit.updatedAt)fail('malformed','Edit history is malformed.');
  if(!edit.anchor||!Number.isInteger(edit.anchor.start)||!Number.isInteger(edit.anchor.end)||!Number.isInteger(edit.anchor.occurrence))fail('malformed','Edit history range does not match the edit.');
  const history=[];
  for(const entry of list){
    if(!exact(entry,HISTORY_KEYS))fail('malformed','Edit history is malformed.');
    if(!clockOf(entry.revision)||!clockOf(entry.at))fail('malformed','Edit history is malformed.');
    if(typeof entry.after!=='string'||entry.after.length>LIMITS.editText||entry.after===edit.before)fail('malformed','Edit history is malformed.');
    if(typeof entry.enabled!=='boolean')fail('malformed','Edit history is malformed.');
    rejectPaperCarrier(entry.after,0);
    const anchor=paperAnchor(entry.anchor);
    if(!anchor||anchor.start!==edit.anchor.start||anchor.end!==edit.anchor.end||anchor.occurrence!==edit.anchor.occurrence)fail('malformed','Edit history range does not match the edit.');
    history.push({revision:entry.revision,at:entry.at,after:entry.after,enabled:entry.enabled,anchor});
  }
  const first=history[0],last=history[history.length-1];
  if(first.at!==edit.createdAt||last.at!==edit.updatedAt||last.after!==edit.after||last.enabled!==edit.enabled)fail('malformed','Edit history does not match the current After.');
  if(JSON.stringify(last.anchor)!==JSON.stringify(edit.anchor))fail('malformed','Edit history does not match the current After.');
  return {createdAt:edit.createdAt,updatedAt:edit.updatedAt,history};
}
function paperSegments(list){
  if(!Array.isArray(list))fail('malformed','Paper source segments are malformed.');
  if(list.length>LIMITS.segments)fail('oversize');
  const ids=new Set(),out=[];let chars=0;
  for(const segment of list){
    if(!plain(segment)||Object.keys(segment).some(key=>!['id','label','text','pageIndex'].includes(key))||!own(segment,'id')||!own(segment,'label')||!own(segment,'text'))fail('malformed','Paper source segment is malformed.');
    if(typeof segment.id!=='string'||!segment.id||segment.id.length>80||ids.has(segment.id))fail('conflict','Duplicate source segment id.');
    ids.add(segment.id);
    if(typeof segment.label!=='string'||!segment.label.trim()||segment.label.length>200||typeof segment.text!=='string')fail('malformed','Paper source segment text is malformed.');
    chars+=segment.text.length;if(chars>LIMITS.source)fail('oversize');
    rejectPaperCarrier(segment.text,0);
    const row={id:segment.id,label:segment.label.trim(),text:segment.text};
    if(own(segment,'pageIndex')){if(!Number.isInteger(segment.pageIndex)||segment.pageIndex<0||segment.pageIndex>100000)fail('malformed','Paper source page is malformed.');row.pageIndex=segment.pageIndex;}
    out.push(row);
  }
  return out;
}
function paperEdits(list,segments){
  if(!Array.isArray(list))fail('malformed','Paper edits are malformed.');
  if(list.length>LIMITS.paperEdits)fail('oversize');
  const ids=new Set(),known=new Set(segments.map(segment=>segment.id)),out=[];
  for(const edit of list){
    if(!plain(edit)||Object.keys(edit).some(key=>!['id','enabled','pageIndex','segmentId','before','after','anchor','origin',...EDIT_META_KEYS].includes(key)))fail('malformed','Paper edit is malformed.');
    for(const key of ['id','enabled','pageIndex','before','after','origin'])if(!own(edit,key))fail('malformed','Paper edit is missing captured text or provenance.');
    if(typeof edit.id!=='string'||!edit.id||edit.id.length>80||ids.has(edit.id))fail('conflict','Duplicate edit id.');
    ids.add(edit.id);
    if(typeof edit.enabled!=='boolean'||!Number.isInteger(edit.pageIndex)||edit.pageIndex<0||edit.pageIndex>100000)fail('malformed','Paper edit page or enabled flag is malformed.');
    if(typeof edit.before!=='string'||typeof edit.after!=='string'||edit.before.length>LIMITS.editText||edit.after.length>LIMITS.editText)fail('malformed','Paper edit text is malformed.');
    if(!PAPER_ORIGINS.includes(edit.origin))fail('malformed','Edit origin is not human, external-ai-import, or ai-proposal.');
    rejectPaperCarrier(edit.before,0);rejectPaperCarrier(edit.after,0);
    const anchor=own(edit,'anchor')?paperAnchor(edit.anchor):null;
    if(anchor&&Number.isInteger(anchor.start)&&Number.isInteger(anchor.end)&&anchor.end-anchor.start!==edit.before.length)fail('malformed','Edit anchor offset is malformed.');
    const row={id:edit.id,enabled:edit.enabled,pageIndex:edit.pageIndex,before:edit.before,after:edit.after,origin:edit.origin,anchor};
    if(own(edit,'segmentId')){if(typeof edit.segmentId!=='string'||!edit.segmentId||edit.segmentId.length>80||!known.has(edit.segmentId))fail('conflict','Edit segment is not in the captured source.');row.segmentId=edit.segmentId;}
    const meta=EDIT_META_KEYS.filter(key=>own(edit,key));
    if(meta.length){if(meta.length!==EDIT_META_KEYS.length)fail('malformed','Edit history is malformed.');const history=paperHistory(edit.history,{...row,createdAt:edit.createdAt,updatedAt:edit.updatedAt});row.createdAt=history.createdAt;row.updatedAt=history.updatedAt;row.history=history.history;}
    out.push(row);
  }
  return out;
}
function paperOutput(output,editRevision){
  if(output===null)return null;
  if(!exact(output,['sha256','revision','verification']))fail('malformed','Paper output link is malformed.');
  if(typeof output.sha256!=='string'||!HEX.test(output.sha256))fail('hash_mismatch','Paper output hash is malformed.');
  if(!Number.isInteger(output.revision)||output.revision!==editRevision)fail('conflict','Stale output revision is not the current edit revision.');
  if(!plain(output.verification))fail('malformed','Paper output verification is malformed.');
  const verification=copy(output.verification);
  rejectPaperCarrier(verification,0);
  if(utf8Bytes(canonicalJSON(verification))>LIMITS.verification)fail('oversize');
  return {sha256:output.sha256,revision:output.revision,verification};
}
function paperReviews(list,output,editRevision){
  if(!Array.isArray(list))fail('malformed','Paper review notes are malformed.');
  if(list.length>LIMITS.paperReviews)fail('oversize');
  const ids=new Set(),out=[],currentHash=output?output.sha256:null;
  for(const review of list){
    if(!plain(review)||Object.keys(review).some(key=>!PAPER_REVIEW_KEYS.includes(key)))fail('malformed','Paper review note is malformed.');
    for(const key of PAPER_REVIEW_KEYS)if(!own(review,key))fail('malformed','Paper review note is malformed.');
    if(typeof review.id!=='string'||!review.id||review.id.length>LIMITS.runId||ids.has(review.id))fail('conflict','Duplicate review id.');
    ids.add(review.id);
    if(typeof review.createdAt!=='string'||!Number.isFinite(Date.parse(review.createdAt)))fail('malformed','Paper review time is malformed.');
    if(typeof review.reviewer!=='string'||!review.reviewer.trim()||review.reviewer.length>120||typeof review.caseLabel!=='string'||!review.caseLabel.trim()||review.caseLabel.length>160)fail('malformed','Paper review identity is malformed.');
    if(!PAPER_VERDICTS.includes(review.verdict))fail('malformed','Paper review verdict is malformed.');
    if(review.verdict==='uncertain'&&review.score!==null||review.score!==null&&(!Number.isInteger(review.score)||review.score<1||review.score>5))fail('malformed','Paper review score is not a human 1–5 score.');
    if(typeof review.note!=='string'||!review.note.trim()||review.note.length>3000)fail('malformed','Paper review needs a human reason.');
    if(!Number.isInteger(review.editRevision)||review.editRevision<0||review.editRevision>1000000)fail('malformed','Paper review is not bound to an edit revision.');
    if(!(review.outputHash===null||typeof review.outputHash==='string'&&HEX.test(review.outputHash)))fail('hash_mismatch','Paper review is not bound to an output hash.');
    if(typeof review.stale!=='boolean')fail('malformed','Paper review staleness is malformed.');
    const current=review.editRevision===editRevision&&review.outputHash===currentHash;
    if(current&&review.stale)fail('conflict','A review of this edit revision is marked stale.');
    if(!current&&!review.stale)fail('conflict','A review of another edit revision cannot apply to the current After.');
    let alignment=null;
    if(review.alignment!==null){
      if(review.outputHash===null)fail('conflict','A review without an output hash cannot claim a BLUE file match.');
      if(!plain(review.alignment)||Object.keys(review.alignment).some(key=>!['fileHash','findingNotes'].includes(key))||!own(review.alignment,'fileHash')||!own(review.alignment,'findingNotes'))fail('malformed','Paper review alignment is malformed.');
      if(review.alignment.fileHash!==review.outputHash)fail('hash_mismatch','Review alignment file hash is not the reviewed output.');
      if(!Array.isArray(review.alignment.findingNotes)||review.alignment.findingNotes.length>12)fail('malformed','Paper finding notes are malformed.');
      const seen=new Set(),notes=[];
      for(const note of review.alignment.findingNotes){
        if(!exact(note,['id','verdict','note']))fail('malformed','Paper finding note is malformed.');
        if(typeof note.id!=='string'||!note.id||note.id.length>80||seen.has(note.id))fail('conflict','Duplicate finding note id.');
        seen.add(note.id);
        if(!FINDING_VERDICTS.includes(note.verdict)||typeof note.note!=='string'||note.note.length>3000)fail('malformed','Paper finding note is malformed.');
        if(note.verdict!=='pending'&&!note.note.trim())fail('malformed','A human finding judgment needs a reason.');
        notes.push({id:note.id,verdict:note.verdict,note:note.note});
      }
      alignment={fileHash:review.outputHash,findingNotes:notes};
    }
    out.push({id:review.id,createdAt:review.createdAt,reviewer:review.reviewer.trim(),caseLabel:review.caseLabel.trim(),verdict:review.verdict,score:review.score,note:review.note.trim(),alignment,editRevision:review.editRevision,outputHash:review.outputHash,stale:review.stale});
  }
  return out;
}
function paperTitle(record){
  const name=record.sourceName.trim()||record.sourceFileHash.slice(0,12);
  return assertTitle(`수동 편집 · ${name} · r${record.editRevision} · ${record.id}`);
}
export function normalizePaperEdit(input){
  if(!plain(input))fail('malformed','Paper-edit record is malformed.');
  const wrapped=input.schema===PAPER_EDIT_SCHEMA&&plain(input.record);
  if(wrapped&&!exact(input,['schema','record','reviews']))fail('malformed','Paper-edit payload shape is malformed.');
  const source=wrapped?input.record:input;
  const reviews=wrapped?input.reviews:source.reviews;
  if(reviews!==undefined&&!Array.isArray(reviews))fail('malformed','Paper review notes are malformed.');
  if(wrapped&&own(source,'reviews'))fail('malformed','Paper-edit record mixes review notes into the edit snapshot.');
  if(!plain(source)||Object.keys(source).some(key=>!['id','createdAt','sourceFileHash','sourceName','segments','edits','editRevision','output','reviews'].includes(key)))fail('malformed','Paper-edit record carries a field that is not manual provenance.');
  for(const key of ['id','createdAt','sourceFileHash','sourceName','segments','edits','editRevision','output'])if(!own(source,key))fail('malformed','Paper-edit record is missing captured provenance.');
  if(typeof source.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(source.id))fail('malformed','Paper-edit record id is malformed.');
  if(typeof source.createdAt!=='string'||!Number.isFinite(Date.parse(source.createdAt)))fail('malformed','Paper-edit record time is malformed.');
  if(typeof source.sourceFileHash!=='string'||!HEX.test(source.sourceFileHash))fail('hash_mismatch','Paper source file hash is malformed.');
  if(typeof source.sourceName!=='string'||source.sourceName.length>200||/[\u0000-\u001f\u007f]/.test(source.sourceName))fail('malformed','Paper source name is malformed.');
  if(!Number.isInteger(source.editRevision)||source.editRevision<0||source.editRevision>1000000)fail('malformed','Paper edit revision is malformed.');
  const segments=paperSegments(source.segments);
  const edits=paperEdits(source.edits,segments);
  const output=paperOutput(source.output,source.editRevision);
  const notes=paperReviews(reviews||[],output,source.editRevision);
  rejectPaperCarrier(source.sourceName,0);
  return {schema:PAPER_EDIT_SCHEMA,record:{id:source.id,createdAt:source.createdAt,sourceFileHash:source.sourceFileHash,sourceName:source.sourceName,segments,edits,editRevision:source.editRevision,output},reviews:notes};
}
export async function buildPaperEditArchive(record){
  const data=normalizePaperEdit(record);
  const archive={schema:ARCHIVE_SCHEMA,kind:'paper-edit',id:data.record.id,title:paperTitle(data.record),data};
  boundedJSON(archive);
  return archive;
}

function attemptOf(value,validators){
  const A=validators?.attempt||globalThis.FalsifyAttemptLedger;
  if(!A||typeof A.normalize!=='function')fail('validators','Attempt validator is unavailable.');
  try{return A.normalize(value);}catch{fail('malformed','Attempt metadata is malformed.');}
}
export async function buildAttemptArchive(record,validators){
  const attempt=attemptOf(copy(record),validators);
  const id=attempt.role+':'+attempt.id;
  const title=assertTitle(`${attempt.role.toUpperCase()} 시도 · ${attempt.harnessName||'이름 미상'} · ${attempt.status} · ${attempt.id}`);
  return boundedJSON({schema:ARCHIVE_SCHEMA,kind:'attempt',id,title,data:attempt});
}
export async function validateArchive(archive,validators){
  const value=copy(archive);
  boundedJSON(value);
  if(!exact(value,['schema','kind','id','title','data'])||value.schema!==ARCHIVE_SCHEMA)fail('malformed');
  assertTitle(value.title);
  if(value.kind==='attempt'){
    const attempt=attemptOf(value.data,validators);
    if(value.id!==attempt.role+':'+attempt.id)fail('conflict','Attempt archive identity differs.');
    return {schema:ARCHIVE_SCHEMA,kind:'attempt',id:value.id,title:value.title,data:attempt};
  }
  if(value.kind==='harness'){
    const V=validatorsOf(validators,'harness');
    if(typeof value.id!=='string'||!HEX.test(value.id)||!exact(value.data,['config','hash']))fail('malformed','Harness archive shape is malformed.');
    let config;try{config=V.harness.validate(value.data.config);}catch{fail('malformed','Harness config is malformed.');}
    const hash=await V.harness.hash(config);
    if(value.id!==hash||value.data.hash!==hash)fail('hash_mismatch');
    return {schema:ARCHIVE_SCHEMA,kind:'harness',id:hash,title:value.title,data:{config:copy(config),hash}};
  }
  if(value.kind==='paper-edit'){
    if(typeof value.id!=='string'||!value.id||value.id.length>LIMITS.runId)fail('malformed','Paper-edit archive id is malformed.');
    const data=normalizePaperEdit(value.data);
    if(value.id!==data.record.id)fail('conflict','Paper-edit archive id does not match the manual record.');
    return {schema:ARCHIVE_SCHEMA,kind:'paper-edit',id:data.record.id,title:value.title,data};
  }
  if(value.kind!=='experiment')fail('malformed');
  const V=validatorsOf(validators,'experiment');
  const data=value.data;
  if(!exact(data,['schema','selectedRunId','ledger'])||data.schema!==BUNDLE_SCHEMA||data.selectedRunId!==value.id||typeof value.id!=='string'||!value.id||value.id.length>LIMITS.runId)fail('malformed','Experiment archive shape is malformed.');
  const ledger=await validateLedger(data.ledger,value.id,V);
  return {schema:ARCHIVE_SCHEMA,kind:'experiment',id:value.id,title:value.title,data:{schema:BUNDLE_SCHEMA,selectedRunId:value.id,ledger}};
}
