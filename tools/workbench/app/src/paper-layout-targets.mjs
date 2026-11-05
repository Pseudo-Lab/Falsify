// Layout-only stable target registry.
//
// Raw source node IDs from analyzeLatexSource() hash the containing project
// ID, so every typed layout edit renames every node. This registry issues
// lineage-bound target IDs for raw nodes and keeps them mapped across explicit
// rebase(beforeProject, afterProject) calls. It never changes source node IDs,
// saved edits or archive contracts; reconstructed layout unit IDs are already
// stable and are returned unchanged.
//
// Mapping evidence is exact only:
//  - text outside the changed region of a file maps by offset, and the node
//    found there must have the same path, kind and source text;
//  - a node inside the changed region maps only when its trimmed text occurs
//    exactly once among same-kind nodes of that region before and after;
//  - the changed region is computed with both prefix-first and suffix-first
//    alignments; if the two disagree the target becomes ambiguous.
// Similar text in another path, project lineage or source origin is never used.
import {analyzeLatexSource} from './latex-source-model.mjs';
import {readLayoutStructure} from './paper-layout-structure.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

export const LAYOUT_TARGETS_SCHEMA='falsify.layout-targets.v1';
const PREFIX='lt1_',MAX_TARGETS=10000;
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const fail=(code,message)=>{throw Object.assign(new Error(message||code),{code});};
const isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const isRange=r=>r&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>=r.start;

function validateProject(project){
 if(project?.schema!=='falsify.latex-project.v1'||!Array.isArray(project.files)||!isHash(project.id))fail('INVALID_PROJECT','Invalid LaTeX project');
 const names=new Set();for(const f of project.files){if(!f?.path||names.has(f.path)||!(f.bytes instanceof Uint8Array)||hex(f.bytes)!==f.sha256)fail('STALE_PROJECT','Project contents do not match its identity');names.add(f.path);}
 const files=project.files.map(({path,sha256})=>[path,sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 if(hex(enc.encode(JSON.stringify({files,mainFile:project.mainFile,engine:project.engine,origin:project.origin})))!==project.id)fail('STALE_PROJECT','Project contents do not match its identity');
}
const originOf=p=>({origin:p.origin,engine:p.engine,mainFile:p.mainFile??null,sourcePdfHash:p.sourcePdfHash??null});
const sameOrigin=(a,b)=>a.origin===b.origin&&a.engine===b.engine&&a.mainFile===b.mainFile&&a.sourcePdfHash===b.sourcePdfHash;
const targetIdOf=(lineageId,firstSeenProjectId,path,kind,start,end)=>PREFIX+hex(enc.encode(JSON.stringify([LAYOUT_TARGETS_SCHEMA,lineageId,firstSeenProjectId,path,kind,start,end])));
const keyOf=(path,kind,start,end)=>JSON.stringify([path,kind,start,end]);

// Small per-registry cache; projects are immutable values keyed by identity.
function createModelCache(){
 const cache=new Map();
 return project=>{
  if(cache.has(project.id))return cache.get(project.id);
  const {nodes}=analyzeLatexSource(project),byKey=new Map(),byId=new Map();
  for(const n of nodes){const k=keyOf(n.path,n.kind,n.start,n.end);if(!byKey.has(k))byKey.set(k,n);byId.set(n.id,n);}
  let units=null;
  if(project.origin==='reconstructed-pdf'&&project.files.some(f=>f.path==='falsify-layout-structure.json')){try{units=new Set(readLayoutStructure(project).units.map(u=>u.id));}catch{units=null;}}
  const texts=new Map();for(const f of project.files)if(/\.tex$/i.test(f.path)){try{texts.set(f.path,dec.decode(f.bytes));}catch{}}
  const model={nodes,byKey,byId,units,texts};
  cache.set(project.id,model);while(cache.size>4)cache.delete(cache.keys().next().value);
  return model;
 };
}

function alignments(x,y){
 const lcp=(a,b,limit)=>{let i=0;while(i<limit&&a.charCodeAt(i)===b.charCodeAt(i))i++;return i;};
 const lcs=(a,b,limit)=>{let i=0;while(i<limit&&a.charCodeAt(a.length-1-i)===b.charCodeAt(b.length-1-i))i++;return i;};
 const min=Math.min(x.length,y.length);
 const p1=lcp(x,y,min),s1=lcs(x,y,min-p1);
 const s2=lcs(x,y,min),p2=lcp(x,y,min-s2);
 const a1={bs:p1,be:x.length-s1,as:p1,ae:y.length-s1},a2={bs:p2,be:x.length-s2,as:p2,ae:y.length-s2};
 return a1.bs===a2.bs&&a1.be===a2.be?[a1]:[a1,a2];
}
const touches=(r,s,e)=>r.end>=s&&r.start<=e;

// Map one before-range of one path into the after model under one alignment.
function mapOne({path,kind,range,text},align,before,after,claimed){
 if(!align)return {status:'matched',range:{...range}}; // file text identical
 const outside=range.end<align.bs?0:range.start>align.be?align.ae-align.be:null;
 if(outside!==null){const n=after.byKey.get(keyOf(path,kind,range.start+outside,range.end+outside));if(n&&n.sourceText===text)return {status:'matched',range:{start:n.start,end:n.end}};}
 const trimmed=text.trim();if(!trimmed)return {status:'missing',candidates:[]};
 const beforeHits=before.nodes.filter(n=>n.path===path&&n.kind===kind&&touches(n,align.bs,align.be)&&n.text.trim()===trimmed);
 const afterHits=after.nodes.filter(n=>n.path===path&&n.kind===kind&&touches(n,align.as,align.ae)&&!claimed.has(n.id)&&n.text.trim()===trimmed);
 if(beforeHits.length<=1&&afterHits.length===1)return {status:'matched',range:{start:afterHits[0].start,end:afterHits[0].end}};
 if(!afterHits.length)return {status:'missing',candidates:[]};
 return {status:'ambiguous',candidates:afterHits.map(n=>({start:n.start,end:n.end}))};
}

/**
 * createLayoutTargetRegistry(project?, metadata?)
 *  - project: optional falsify.latex-project.v1 baseline/current project.
 *  - metadata: optional object (or JSON string) previously returned by
 *    registry.serialize(). Restoring requires `project` to be exactly the
 *    serialized current project; every target is validated against it and any
 *    mismatch throws INVALID_TARGET_METADATA (nothing is partially restored).
 */
export function createLayoutTargetRegistry(project,metadata){
 const model=createModelCache();
 let lineage=null; // {baselineProjectId,currentProjectId,origin,engine,mainFile,sourcePdfHash,revisions}
 const targets=new Map(); // targetId -> {path,kind,firstSeenProjectId,firstRange,status,range,candidates,sourceTextSha256}
 const byCurrent=new Map(); // current raw-node key -> targetId (matched only)

 const bind=p=>{validateProject(p);if(!lineage)lineage={baselineProjectId:p.id,currentProjectId:p.id,...originOf(p),revisions:0};};
 const check=p=>{validateProject(p);if(!lineage){bind(p);return null;}if(!sameOrigin(lineage,originOf(p)))return 'LINEAGE_MISMATCH';if(p.id!==lineage.currentProjectId)return 'PROJECT_NOT_CURRENT';return null;};
 const reindex=()=>{byCurrent.clear();for(const [id,t] of targets)if(t.status==='matched')byCurrent.set(keyOf(t.path,t.kind,t.range.start,t.range.end),id);};

 if(metadata!==undefined&&metadata!==null){
  if(!project)fail('INVALID_TARGET_METADATA','Restoring metadata requires its current project');
  restore(project,metadata);
 } else if(project)bind(project);

 function validateTargetIdentity(t,next,l,bad){
   if(!t||typeof t.targetId!=='string'||typeof t.path!=='string'||typeof t.kind!=='string'||!isHash(t.firstSeenProjectId)||!isRange(t.firstRange)||!isHash(t.sourceTextSha256)||!['matched','ambiguous','missing'].includes(t.status))bad('Invalid target');
   if(next.has(t.targetId)||targetIdOf(l.baselineProjectId,t.firstSeenProjectId,t.path,t.kind,t.firstRange.start,t.firstRange.end)!==t.targetId)bad('Target ID does not match its lineage');
 }
 function validateMetadata(m,p,bad){
  if(!m||typeof m!=='object'||m.schema!==LAYOUT_TARGETS_SCHEMA)bad('Unknown metadata schema');
  const l=m.lineage;if(!l||!isHash(l.baselineProjectId)||!isHash(l.currentProjectId)||!Number.isSafeInteger(l.revisions)||l.revisions<0)bad('Invalid lineage');
  if(l.currentProjectId!==p.id)bad('Metadata belongs to a different project');
  if(!sameOrigin({origin:l.origin,engine:l.engine,mainFile:l.mainFile??null,sourcePdfHash:l.sourcePdfHash??null},originOf(p)))bad('Metadata belongs to a different source origin');
  if(!Array.isArray(m.targets)||m.targets.length>MAX_TARGETS)bad('Invalid targets');
  return l;
 }
 function restore(p,raw){
  validateProject(p);
  const bad=m=>fail('INVALID_TARGET_METADATA',m);
  let m=raw;if(typeof m==='string'){try{m=JSON.parse(m);}catch{bad('Metadata is not JSON');}}
  const l=validateMetadata(m,p,bad);
  const current=model(p),next=new Map();
  function restoreTarget(t){
   validateTargetIdentity(t,next,l,bad);
   const candidates=Array.isArray(t.candidates)?t.candidates:bad('Invalid candidates');
   const exists=r=>{const n=isRange(r)&&current.byKey.get(keyOf(t.path,t.kind,r.start,r.end));return n||bad('Target range is not in the current project');};
   let range=null;
   if(t.status==='matched'){const n=exists(t.range);if(hex(enc.encode(n.sourceText))!==t.sourceTextSha256)bad('Target content differs');range={start:n.start,end:n.end};if(candidates.length)bad('Matched target has candidates');}
   else if(t.range!==null&&t.range!==undefined)bad('Unmatched target has a range');
   if(t.status==='missing'&&candidates.length)bad('Missing target has candidates');
   if(t.status==='ambiguous'&&!candidates.length)bad('Ambiguous target lacks candidates');
   next.set(t.targetId,{path:t.path,kind:t.kind,firstSeenProjectId:t.firstSeenProjectId,firstRange:{start:t.firstRange.start,end:t.firstRange.end},status:t.status,range,candidates:candidates.map(c=>{const n=exists(c);return {start:n.start,end:n.end};}),sourceTextSha256:t.sourceTextSha256});
  }
  for(const t of m.targets)restoreTarget(t);
  lineage={baselineProjectId:l.baselineProjectId,currentProjectId:l.currentProjectId,...originOf(p),revisions:l.revisions};
  targets.clear();for(const [k,v] of next)targets.set(k,v);reindex();
 }

 /** Return a copy of `block` with stable id/targetId and the raw sourceBlockId. */
 function describe(p,block){
  const problem=check(p);if(problem)fail(problem,problem==='PROJECT_NOT_CURRENT'?'Rebase the registry to this project first':'Project belongs to a different lineage');
  if(!block||typeof block.id!=='string'||!block.id)fail('BLOCK_NOT_FOUND','Block has no ID');
  const m=model(p),raw=block.id;
  if(m.units?.has(raw))return {...block,id:raw,targetId:raw,sourceBlockId:raw};
  const n=m.byId.get(raw);if(!n)fail('BLOCK_NOT_FOUND','Block is not in the current project');
  const k=keyOf(n.path,n.kind,n.start,n.end);let targetId=byCurrent.get(k);
  if(!targetId){
   if(targets.size>=MAX_TARGETS)fail('TOO_MANY_TARGETS');
   targetId=targetIdOf(lineage.baselineProjectId,p.id,n.path,n.kind,n.start,n.end);
   targets.set(targetId,{path:n.path,kind:n.kind,firstSeenProjectId:p.id,firstRange:{start:n.start,end:n.end},status:'matched',range:{start:n.start,end:n.end},candidates:[],sourceTextSha256:hex(enc.encode(n.sourceText))});
   byCurrent.set(k,targetId);
  }
  return {...block,id:targetId,targetId,sourceBlockId:raw};
 }

 /** Resolve a target ID, a stable unit ID or a current raw node ID. */
 function resolve(p,id){
  const problem=check(p);if(problem)return {status:'missing',candidates:[],reason:problem};
  if(typeof id!=='string'||!id)return {status:'missing',candidates:[],reason:'INVALID_ID'};
  const m=model(p),t=targets.get(id);
  const rawOf=(path,kind,r)=>m.byKey.get(keyOf(path,kind,r.start,r.end))?.id;
  if(t){
   if(t.status==='matched'){const blockId=rawOf(t.path,t.kind,t.range);return blockId?{status:'matched',blockId,candidates:[blockId]}:{status:'missing',candidates:[],reason:'TARGET_MISSING'};}
   if(t.status==='ambiguous')return {status:'ambiguous',candidates:t.candidates.map(c=>rawOf(t.path,t.kind,c)).filter(Boolean),reason:'TARGET_AMBIGUOUS'};
   return {status:'missing',candidates:[],reason:'TARGET_MISSING'};
  }
  if(m.units?.has(id)||m.byId.has(id))return {status:'matched',blockId:id,candidates:[id]};
  return {status:'missing',candidates:[],reason:'NOT_IN_CURRENT_PROJECT'};
 }

 /** Move every target from `beforeProject` (the current project) to `afterProject`. */
 function rebase(beforeProject,afterProject){
  const problem=check(beforeProject);if(problem)fail(problem,problem==='PROJECT_NOT_CURRENT'?'beforeProject is not the registry current project':'Project belongs to a different lineage');
  validateProject(afterProject);if(!sameOrigin(lineage,originOf(afterProject)))fail('LINEAGE_MISMATCH','afterProject has a different source origin');
  if(afterProject.id===beforeProject.id)return summary();
  const before=model(beforeProject),after=model(afterProject);
  const aligns=new Map();
  for(const path of new Set([...before.texts.keys()])){const x=before.texts.get(path),y=after.texts.get(path);aligns.set(path,y===undefined?null:x===y?[null]:alignments(x,y));}
  // Claims: after nodes reached by exact offset mapping of any outside node.
  const claims=new Map();
  buildClaims();
  function buildClaims(){
  for(const [path,list] of aligns){if(!list)continue;list.forEach((a,i)=>{const set=claims.get(path+'\0'+i)||new Set();claims.set(path+'\0'+i,set);if(!a)return;for(const n of before.nodes){if(n.path!==path)continue;const shift=n.end<a.bs?0:n.start>a.be?a.ae-a.be:null;if(shift===null)continue;const hit=after.byKey.get(keyOf(path,n.kind,n.start+shift,n.end+shift));if(hit&&hit.sourceText===n.sourceText)set.add(hit.id);}});}
  }
  const mapRange=(t,range)=>{
   const list=aligns.get(t.path);if(!list)return {status:'missing',candidates:[]};
   const node=before.byKey.get(keyOf(t.path,t.kind,range.start,range.end));if(!node)return {status:'missing',candidates:[]};
   return list.map((a,i)=>mapOne({path:t.path,kind:t.kind,range,text:node.sourceText},a,before,after,claims.get(t.path+'\0'+i)));
  };
  const combine=results=>{
   if(!Array.isArray(results))return results;
   const ranges=[];for(const r of results){if(r.status==='matched')ranges.push(r.range);else ranges.push(...r.candidates);}
   const uniq=[...new Map(ranges.map(r=>[r.start+':'+r.end,r])).values()];
   if(results.every(r=>r.status==='matched')&&uniq.length===1)return {status:'matched',range:uniq[0]};
   if(!uniq.length)return {status:'missing',candidates:[]};
   return {status:'ambiguous',candidates:uniq};
  };
  const next=new Map();
  function rebaseTarget(id,t){
   let r;
   if(t.status==='matched')r=combine(mapRange(t,t.range));
   else if(t.status==='ambiguous'){const all=t.candidates.map(c=>combine(mapRange(t,c)));const c=all.flatMap(x=>x.status==='matched'?[x.range]:x.candidates);const uniq=[...new Map(c.map(x=>[x.start+':'+x.end,x])).values()];r=uniq.length?{status:'ambiguous',candidates:uniq}:{status:'missing',candidates:[]};}
   else r={status:'missing',candidates:[]};
   if(r.status==='matched'){const n=after.byKey.get(keyOf(t.path,t.kind,r.range.start,r.range.end));if(!n||n.text.trim()!==before.byKey.get(keyOf(t.path,t.kind,t.range.start,t.range.end)).text.trim())r={status:'missing',candidates:[]};else t.sourceTextSha256=hex(enc.encode(n.sourceText));}
   next.set(id,{...t,status:r.status,range:r.status==='matched'?r.range:null,candidates:r.status==='ambiguous'?r.candidates:[]});
  }
  for(const [id,t] of targets)rebaseTarget(id,t);
  // Two targets may never claim the same current node.
  rejectDuplicateClaims();
  function rejectDuplicateClaims(){
  const seen=new Map();for(const [id,t] of next)if(t.status==='matched'){const k=keyOf(t.path,t.kind,t.range.start,t.range.end);if(seen.has(k)){for(const other of [id,seen.get(k)]){const o=next.get(other);next.set(other,{...o,status:'ambiguous',candidates:[o.range??t.range],range:null});}}else seen.set(k,id);}
  }
  targets.clear();for(const [k,v] of next)targets.set(k,v);
  lineage={...lineage,currentProjectId:afterProject.id,revisions:lineage.revisions+1};reindex();
  return summary();
 }

 function summary(){const out={projectId:lineage?.currentProjectId??null,matched:0,ambiguous:0,missing:0};for(const t of targets.values())out[t.status]++;return out;}

 /** JSON-compatible metadata; restore with createLayoutTargetRegistry(project, metadata). */
 function serialize(){
  return {schema:LAYOUT_TARGETS_SCHEMA,lineage:lineage?{...lineage}:null,targets:[...targets].map(([targetId,t])=>({targetId,path:t.path,kind:t.kind,firstSeenProjectId:t.firstSeenProjectId,firstRange:{...t.firstRange},status:t.status,range:t.range?{...t.range}:null,candidates:t.candidates.map(c=>({...c})),sourceTextSha256:t.sourceTextSha256}))};
 }

 return {describe,resolve,rebase,serialize,summary};
}
