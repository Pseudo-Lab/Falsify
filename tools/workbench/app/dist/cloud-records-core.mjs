// Falsify shared records v1: payload validation, public projection, local-to-cloud conversion and controlled comparison.
// One pure module for the Worker (bundled with the harness core) and the browser. Every remote record is client-reported:
// nothing here verifies an execution, a model, the identity of a reviewer or accuracy. The harness core (H) is injected; the
// browser default is the already loaded global. Errors carry a fixed code and a fixed message that never echoes input.
export const SCHEMA='falsify.cloud.v1';
export const KINDS=Object.freeze(['harness','run','review']);
export const RUN_STATUSES=Object.freeze(['ok','abstain','refusal','failed','cancelled','unknown']);
export const VERDICTS=Object.freeze(['uncertain','supported','unsupported','mixed']);
export const PROVENANCES=Object.freeze(['local-codex','manual-unverified','imported-unverified']);
export const ORIGINS=Object.freeze({'local-codex':'executed','manual-unverified':'manual','imported-unverified':'imported'});
// Sizes are JSON string lengths; the API separately bounds the whole request body (256 KiB).
export const LIMITS=Object.freeze({payload:240*1024,evidence:200*1024,localId:160,model:120,caseLabel:160,protocolVersion:80,note:3000,calls:100000,segments:10000,segmentId:80,segmentLabel:200});
export const COMPARISON_NOTICE='All shared records are client-reported claims: execution, model, coverage, provenance and reviewer names are not verified. Groups compare only identical conditions (input text hash, role, model label, RED level, call budget, protocol and case label). Scores are subjective human reviews, not accuracy or detection rates; uncertain reviews are excluded from means and means are shown only for claimed local broker runs. Differences between harnesses are observations, never causal conclusions.';
export const PUBLIC_FIELDS=Object.freeze({harness:Object.freeze(['config','hash','parentHash']),
  run:Object.freeze(['role','harnessHash','sourceHash','fileHash','model','level','maxCalls','status','calls','provenance','caseLabel','protocolVersion','createdAt']),
  review:Object.freeze(['runId','verdict','score','note','caseLabel','protocolVersion','supersedes'])});

export class CloudRecordError extends Error{constructor(code,message){super(message);this.name='CloudRecordError';this.code=code;}}
const fail=(code,message)=>{throw new CloudRecordError(code,message);};
const invalid=field=>fail('invalid_payload','Invalid payload field: '+field);
const HEX=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/,LINE=/[\u0000-\u001f\u007f\u{85}\u{2028}\u{2029}]/u;
// Single-line values are grouping keys shown to other users: bidi controls and invisible format characters would make
// visually equal labels differ. ZWNJ/ZWJ (U+200C/U+200D) stay allowed for scripts and emoji that need them.
const INVISIBLE=/[\u{ad}\u{61c}\u{180e}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{feff}\u{fff9}-\u{fffb}]/u;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
// Plain JSON-like object from any realm (a ledger snapshot may come from another frame or VM context): Object or null prototype.
const plain=v=>{if(!v||typeof v!=='object'||Array.isArray(v))return false;const proto=Object.getPrototypeOf(v);return proto===null||Object.getPrototypeOf(proto)===null;};

export function canonicalJSON(v){return Array.isArray(v)?'['+v.map(canonicalJSON).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(v[k])).join(',')+'}':JSON.stringify(v);}
async function sha256(s){return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
// Deterministic idempotency key for a validated payload: key order never changes it.
export async function payloadHash(kind,payload){return sha256(canonicalJSON({kind,payload}));}
// A JSON round trip drops getters, prototypes and toJSON tricks, so validation sees exactly what would be stored.
function json(v,max,field){let raw;try{raw=JSON.stringify(v);}catch{invalid(field);}if(typeof raw!=='string')invalid(field);if(raw.length>max)fail('payload_too_large','Payload too large: '+field);return JSON.parse(raw);}
function exact(o,required,optional,field){if(!plain(o))invalid(field);for(const k of required)if(!own(o,k))invalid(field+'.'+k);if(Object.keys(o).some(k=>!required.includes(k)&&!optional.includes(k)))fail('invalid_payload','Unknown field in '+field);}
function text(v,max,field,multiline=false){if(typeof v!=='string'||!v.trim()||v.length>max||(multiline?CONTROL:LINE).test(v)||!multiline&&INVISIBLE.test(v))invalid(field);return v;}
// RegExp.test coerces its argument (['<64 hex>'] would pass), so the type is checked first.
const hex=(v,field)=>typeof v==='string'&&HEX.test(v)?v:invalid(field);
// Date.parse rolls 2026-02-30 over to March instead of rejecting it, so the calendar fields are checked explicitly.
function iso(v,field){const m=typeof v==='string'&&v.length<=40?ISO.exec(v):null;if(!m)invalid(field);
  const [y,mo,d,h,mi,s,oh,om]=m.slice(1).map(x=>+(x??0)),day=new Date(0);day.setUTCFullYear(y,mo-1,d);
  if(mo<1||mo>12||day.getUTCMonth()!==mo-1||day.getUTCDate()!==d||h>23||mi>59||s>59||oh>23||om>59||!Number.isFinite(Date.parse(v)))invalid(field);
  return v;}

const RUN_REQUIRED=['localId','role','harnessHash','sourceHash','fileHash','model','level','maxCalls','status','calls','provenance','createdAt'];
// publicView checks a projection (no localId, no evidence) as read back from GET shared.
function checkRun(p,publicView=false){
  exact(p,publicView?RUN_REQUIRED.filter(k=>k!=='localId'):RUN_REQUIRED,publicView?['caseLabel','protocolVersion']:['caseLabel','protocolVersion','evidence'],'run');
  if(!['red','blue'].includes(p.role))invalid('role');
  if(p.role==='red'?![1,2,3].includes(p.level):p.level!==null)invalid('level');
  if(!Number.isInteger(p.maxCalls)||p.maxCalls<1||p.maxCalls>32)invalid('maxCalls');
  if(p.calls!==null&&(!Number.isSafeInteger(p.calls)||p.calls<0||p.calls>LIMITS.calls))invalid('calls');
  if(!RUN_STATUSES.includes(p.status))invalid('status');if(!PROVENANCES.includes(p.provenance))invalid('provenance');
  const out={...(publicView?{}:{localId:text(p.localId,LIMITS.localId,'localId')}),role:p.role,harnessHash:hex(p.harnessHash,'harnessHash'),sourceHash:hex(p.sourceHash,'sourceHash'),fileHash:hex(p.fileHash,'fileHash'),
    model:text(p.model,LIMITS.model,'model'),level:p.level,maxCalls:p.maxCalls,status:p.status,calls:p.calls,provenance:p.provenance,createdAt:iso(p.createdAt,'createdAt')};
  if(own(p,'caseLabel'))out.caseLabel=text(p.caseLabel,LIMITS.caseLabel,'caseLabel');
  if(own(p,'protocolVersion'))out.protocolVersion=text(p.protocolVersion,LIMITS.protocolVersion,'protocolVersion');
  if(own(p,'evidence'))out.evidence=checkEvidence(p.evidence);
  return out;}
// Evidence is owner-private: the extracted paper text and the stored model response, optionally the RED final selection.
function checkEvidence(e){exact(e,['segments','response'],['finalState'],'evidence');json(e,LIMITS.evidence,'evidence');
  if(!Array.isArray(e.segments)||!e.segments.length||e.segments.length>LIMITS.segments)invalid('evidence.segments');
  const segments=e.segments.map(s=>{exact(s,['id','label','text'],[],'evidence.segments');if(typeof s.id!=='string'||!s.id||s.id.length>LIMITS.segmentId||typeof s.label!=='string'||s.label.length>LIMITS.segmentLabel||typeof s.text!=='string'||!s.text.trim())invalid('evidence.segments');return {id:s.id,label:s.label,text:s.text};});
  if(new Set(segments.map(s=>s.id)).size!==segments.length)invalid('evidence.segments');
  if(!plain(e.response))invalid('evidence.response');if(own(e,'finalState')&&!plain(e.finalState))invalid('evidence.finalState');
  return {segments,response:e.response,...(own(e,'finalState')?{finalState:e.finalState}:{})};}
function checkReview(p){exact(p,['runId','verdict','score','note','caseLabel'],['protocolVersion','supersedes'],'review');
  if(typeof p.runId!=='string'||!UUID.test(p.runId))invalid('runId');if(!VERDICTS.includes(p.verdict))invalid('verdict');
  if(p.verdict==='uncertain'?p.score!==null:p.score!==null&&(!Number.isInteger(p.score)||p.score<1||p.score>5))invalid('score');
  const out={runId:p.runId,verdict:p.verdict,score:p.score,note:text(p.note,LIMITS.note,'note',true),caseLabel:text(p.caseLabel,LIMITS.caseLabel,'caseLabel')};
  if(own(p,'protocolVersion'))out.protocolVersion=text(p.protocolVersion,LIMITS.protocolVersion,'protocolVersion');
  if(own(p,'supersedes')){if(typeof p.supersedes!=='string'||!UUID.test(p.supersedes))invalid('supersedes');out.supersedes=p.supersedes;}
  return out;}
const validH=H=>!!H&&typeof H.validate==='function'&&typeof H.hash==='function';
async function checkHarness(p,H){exact(p,['config','hash'],['parentHash'],'harness');
  if(!validH(H))fail('harness_unavailable','Harness validator unavailable');
  let config;try{config=H.validate(p.config);}catch{invalid('config');}
  hex(p.hash,'hash');if(await H.hash(config)!==p.hash)fail('harness_hash_mismatch','Harness hash does not match its canonical content');
  if(own(p,'parentHash')&&(hex(p.parentHash,'parentHash')===p.hash))invalid('parentHash');
  return {config,hash:p.hash,...(own(p,'parentHash')?{parentHash:p.parentHash}:{})};}

// Returns the normalized stored payload or throws CloudRecordError. Unknown fields are rejected, never passed through.
export async function validatePayload(kind,payload,{harness:H=globalThis.FalsifyHarness}={}){
  if(!KINDS.includes(kind))fail('unsupported_kind','Unsupported record kind');
  const p=json(payload,LIMITS.payload,'payload');
  if(kind==='harness')return checkHarness(p,H);
  if(kind==='review')return checkReview(p);
  const run=checkRun(p);
  if(run.evidence&&await sha256(run.evidence.segments.map(s=>s.text).join('\n\n'))!==run.sourceHash)fail('invalid_payload','Invalid payload field: evidence.segments');
  return run;}
// Allowlist projection for anyone but the owner: run evidence and the local record ID never leave it.
export function publicPayload(kind,payload){if(!KINDS.includes(kind))fail('unsupported_kind','Unsupported record kind');if(!plain(payload))invalid('payload');
  const out={};for(const k of PUBLIC_FIELDS[kind])if(own(payload,k)&&payload[k]!==undefined)out[k]=JSON.parse(JSON.stringify(payload[k]));return out;}

// Status and call count come from the harness core when present (a call count only for a claimed local broker run),
// otherwise from validated response fields with the same rules.
function outcome(run,H){
  if(H&&typeof H.outcome==='function'){const x=H.outcome(run.role,run.response,run.provenance);return {status:RUN_STATUSES.includes(x?.status)?x.status:'unknown',calls:Number.isSafeInteger(x?.calls)&&x.calls>=0?x.calls:null};}
  const r=plain(run.response)?run.response:{},c=plain(r.coverage)?r.coverage:{};
  return {status:RUN_STATUSES.includes(r.status)?r.status:'unknown',calls:run.provenance==='local-codex'&&Number.isSafeInteger(c.calls)&&c.calls>=0?c.calls:null};}
// Local ledger run -> run payload. Paper text and model output stay out unless includeEvidence is exactly true.
// A final snapshot is not another execution; share its root run instead.
export function runFromLocal(run,{includeEvidence=false,caseLabel,protocolVersion,harness:H=globalThis.FalsifyHarness}={}){
  if(!plain(run))invalid('run');if(own(run,'snapshotOf'))fail('invalid_payload','A final snapshot is not a separate run');
  const x=outcome(run,H),out={localId:run.id,role:run.role,harnessHash:run.harnessHash,sourceHash:run.sourceHash,fileHash:run.fileHash,model:run.model,level:run.role==='red'?run.level??null:null,maxCalls:run.maxCalls,status:x.status,calls:x.calls,provenance:run.provenance,createdAt:run.createdAt};
  if(caseLabel!==undefined)out.caseLabel=caseLabel;
  const protocol=protocolVersion??(typeof run.response?.schema==='string'?run.response.schema:undefined);if(protocol!==undefined)out.protocolVersion=protocol;
  if(includeEvidence===true){if(!Array.isArray(run.segments))invalid('evidence.segments');out.evidence={segments:run.segments.map(s=>({id:s?.id,label:s?.label,text:s?.text})),response:run.response,...(plain(run.finalState)?{finalState:run.finalState}:{})};}
  return checkRun(json(out,LIMITS.payload,'payload'));}
// Local review -> review payload for a cloud run ID. The typed reviewer label, BLUE comparison and local IDs are dropped:
// the server owner is the only reviewer attribution, and it is self-reported, not an identity.
export function reviewFromLocal(review,cloudRunId,{protocolVersion,supersedes}={}){if(!plain(review))invalid('review');
  const out={runId:cloudRunId,verdict:review.verdict,score:review.score??null,note:review.note,caseLabel:review.caseLabel};
  if(protocolVersion!==undefined)out.protocolVersion=protocolVersion;if(supersedes!==undefined)out.supersedes=supersedes;
  return checkReview(json(out,LIMITS.payload,'payload'));}

const time=s=>{const t=Date.parse(s);return Number.isFinite(t)?t:-Infinity;};
const cmp=(a,b)=>a<b?-1:a>b?1:0;
// Newer wins: server createdAt, then revision, then ID, so the result never depends on input order.
const later=(a,b)=>time(a.createdAt)-time(b.createdAt)||(a.revision??0)-(b.revision??0)||cmp(a.id,b.id);
// Pure, deterministic comparison of visible server records (any mix of scopes). Returns {groups,warnings}:
// groups[] = {conditionKey, conditions:{sourceHash,role,model,level,maxCalls,protocolVersion,caseLabel}, attestation:'client-reported',
//   runCount, harnesses[]}; harnesses[] = one entry per harness hash and claimed origin (executed|manual|imported are never mixed):
//   {hash, origin, harnessAvailable, runIds, runCount, statuses, calls, callsUnknown, reviewCount, uncertainCount, scoreCount, scoreMean, reviewerCount}.
// Reviews count once per run and server owner (the latest among those whose caseLabel and protocolVersion both exactly match
// the run's); uncertain reviews never enter scoreMean. warnings[] = {code,message,recordIds}.
// harnessAvailable means a visible, structurally plausible definition: its hash is checked by validatePayload on write, not here.
export function compareRecords(records){
  const warned=new Map(),warn=(code,id)=>{if(!warned.has(code))warned.set(code,new Set());if(id!==undefined)warned.get(code).add(id);};
  const byId=new Map();
  for(const r of Array.isArray(records)?records:[]){
    if(!plain(r)||typeof r.id!=='string'||!r.id||!plain(r.owner)||typeof r.owner.id!=='string'||!r.owner.id||!KINDS.includes(r.kind)||!plain(r.payload)){warn('invalid_record',typeof r?.id==='string'?r.id:undefined);continue;}
    const prev=byId.get(r.id);if(!prev||(r.revision??0)>(prev.revision??0)||(r.revision??0)===(prev.revision??0)&&canonicalJSON(r)>canonicalJSON(prev))byId.set(r.id,r);}
  const runs=new Map(),reviews=[],harnesses=new Set();
  for(const r of byId.values()){try{
    if(r.kind==='harness'){const p=r.payload;if(!plain(p.config)||typeof p.hash!=='string'||!HEX.test(p.hash))invalid('harness');harnesses.add(p.hash);}
    else if(r.kind==='run')runs.set(r.id,{r,p:checkRun(publicPayload('run',r.payload),true)});
    else reviews.push({r,p:checkReview(publicPayload('review',r.payload))});}catch{warn('invalid_record',r.id);}}
  const latest=new Map();
  for(const v of reviews){const run=runs.get(v.p.runId)?.p;if(!run){warn('review_run_missing',v.r.id);continue;}
    if(v.p.supersedes&&byId.get(v.p.supersedes)?.kind==='review'&&byId.get(v.p.supersedes).owner.id!==v.r.owner.id)warn('review_supersedes_other_owner',v.r.id);
    // A review attaches by runId but declares the conditions it was judged under. Only an exact match with the run's own case
    // label and protocol version is a review under those conditions; matching is filtered before "latest" so a newer mismatched
    // review never hides an older matching one. Mismatched records stay in the data, they are only left out of the aggregation.
    if(!own(run,'caseLabel')||!own(run,'protocolVersion')||!own(v.p,'protocolVersion')||v.p.caseLabel!==run.caseLabel||v.p.protocolVersion!==run.protocolVersion){warn('review_condition_mismatch',v.r.id);continue;}
    const key=v.p.runId+'\n'+v.r.owner.id,prev=latest.get(key);if(!prev||later(v.r,prev.r)>0)latest.set(key,v);}
  const groups=new Map();
  for(const {r,p} of runs.values()){
    if(!own(p,'caseLabel')||!own(p,'protocolVersion')){warn('incomparable_missing_condition',r.id);continue;}
    const conditions={sourceHash:p.sourceHash,role:p.role,model:p.model,level:p.level,maxCalls:p.maxCalls,protocolVersion:p.protocolVersion,caseLabel:p.caseLabel},conditionKey=JSON.stringify(Object.values(conditions));
    if(!groups.has(conditionKey))groups.set(conditionKey,{conditionKey,conditions,attestation:'client-reported',runCount:0,entries:new Map()});
    const g=groups.get(conditionKey),origin=ORIGINS[p.provenance],entryKey=p.harnessHash+'\n'+origin;g.runCount++;
    if(!harnesses.has(p.harnessHash))warn('harness_definition_missing',r.id);
    if(!g.entries.has(entryKey))g.entries.set(entryKey,{hash:p.harnessHash,origin,harnessAvailable:harnesses.has(p.harnessHash),runIds:[],statuses:Object.fromEntries(RUN_STATUSES.map(s=>[s,0])),calls:0,callsUnknown:0,reviews:[]});
    const e=g.entries.get(entryKey);e.runIds.push(r.id);e.statuses[p.status]++;if(p.calls===null)e.callsUnknown++;else e.calls+=p.calls;
    for(const v of latest.values())if(v.p.runId===r.id)e.reviews.push(v);}
  const out=[...groups.values()].sort((a,b)=>cmp(a.conditionKey,b.conditionKey)).map(({entries,...g})=>({...g,harnesses:[...entries.values()].sort((a,b)=>cmp(a.hash,b.hash)||cmp(a.origin,b.origin)).map(({reviews:rs,...e})=>{
    const scores=rs.filter(v=>v.p.verdict!=='uncertain'&&v.p.score!==null).map(v=>v.p.score).sort((a,b)=>a-b);
    return {...e,runIds:e.runIds.sort(),runCount:e.runIds.length,reviewCount:rs.length,uncertainCount:rs.filter(v=>v.p.verdict==='uncertain').length,scoreCount:scores.length,
      scoreMean:e.origin==='executed'&&scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null,reviewerCount:new Set(rs.map(v=>v.r.owner.id)).size};})}));
  if(runs.size)warn('client_reported');
  const MESSAGES={client_reported:COMPARISON_NOTICE,invalid_record:'Records with an invalid shape or payload were ignored.',review_run_missing:'Reviews whose run is not visible were ignored.',
    review_supersedes_other_owner:'A review can only supersede a review by the same owner; the reference was ignored.',incomparable_missing_condition:'Runs without a protocol version or case label are not comparable and were left out.',
    review_condition_mismatch:'Reviews whose case label or protocol version is missing or differs from the reviewed run were left out of review counts and means.',
    harness_definition_missing:'Some runs reference a harness hash with no visible shared definition.'};
  const warnings=[...warned].sort((a,b)=>cmp(a[0],b[0])).map(([code,ids])=>({code,message:MESSAGES[code],recordIds:[...ids].sort()}));
  return {groups:out,warnings};}
