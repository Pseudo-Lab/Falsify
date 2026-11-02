import {layoutFailureDetails} from './paper-layout-transport.mjs';
import {createLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {readLayoutStructure} from './paper-layout-structure.mjs';
import {layoutToolCatalog,normalizeLayoutAction} from './paper-layout-tool-catalog.mjs';
import {deriveLayoutOutcome} from './paper-layout-outcome.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
const instruction = 'Adjust the current layout to the user\'s goal. Find blocks, apply typed edits, compile, inspect and compare the result. Save useful candidates and restore the chosen revision. Report changes and remaining findings in the user\'s language.';
const legacyTools=new Set(['read_source','replace_source','compile_pdf','inspect_pdf','render_pages','read_reference','render_reference_pages','restructure_source','finish']);
const length = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:pt|mm|cm|in|em|ex|bp|pc|dd|cc|sp|\\(?:textwidth|linewidth|columnwidth))`;
const number = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const patterns = [
  [new RegExp(String.raw`^\\setlength\s*\{\s*\\(parindent|parskip|baselineskip|textfloatsep|columnsep|linewidth)\s*\}\s*\{\s*${length}\s*\}`), m=>`<setlength:${m[1]}>`],
  [new RegExp(String.raw`^\\(parindent|parskip|baselineskip|textfloatsep|columnsep|linewidth)\s*=\s*${length}\b`),m=>`<length:${m[1]}>`],
  [new RegExp(String.raw`^\\(vspace|hspace)(\*?)\s*\{\s*${length}\s*\}`),m=>`<space:${m[1]}${m[2]}>`],
  [new RegExp(String.raw`^\\fontsize\s*\{\s*${number}(?:pt|bp)?\s*\}\s*\{\s*${number}(?:pt|bp)?\s*\}\s*\\selectfont\b`),()=>'<fontsize>'],
  [new RegExp(String.raw`^\\FalsifyImage\s*\{\s*${length}\s*\}\s*\{\s*${length}\s*\}\s*\{([^{}\n%]+)\}`),m=>'<falsify-image:'+m[1].replaceAll('<','<<')+'>'],
  [/^\\(?:rmfamily|sffamily|ttfamily)\b/,()=>'<family>'],
  [/^\\fontfamily\s*\{\s*(?:cmr|cmss|cmtt|lmr|lmss|lmtt|ptm|phv|pcr)\s*\}\s*\\selectfont\b/,()=>'<family-select>'],
  [/^\\(widowpenalty|clubpenalty|displaywidowpenalty)\s*=\s*\d{1,5}\b/,m=>`<penalty:${m[1]}>`],
  [/^\\(newpage|clearpage|pagebreak|nopagebreak|smallskip|medskip|bigskip)\b/,m=>`<break:${m[1]}>`],
  [/^\\begin\s*\{(figure\*?|table\*?)\}\s*\[([htbp!]+)\]/,m=>`\\begin{${m[1]}}<placement>`],
  [/^\\documentclass\s*\[([^\]\n%{}]+)\]/,m=>{const parts=m[1].split(',');return String.raw`\documentclass[`+parts.map(part=>{const v=part.trim();if(/^(?:10|11|12)pt$/.test(v))return '<class-size>';if(/^(?:onecolumn|twocolumn)$/.test(v))return '<class-columns>';return part.replaceAll('<','<<');}).join(',')+']';}],
  [new RegExp(String.raw`^\\geometry\s*\{((?:(?:margin|left|right|top|bottom|hmargin|vmargin)\s*=\s*${length}\s*,?\s*)+)\}`),m=>'<geometry:'+m[1].split(',').filter(x=>x.trim()).map(x=>x.split('=')[0].trim()).join(',')+'>'],
  [new RegExp(String.raw`^\\includegraphics\s*\[(?:(?:width|height)\s*=\s*${length}|scale\s*=\s*${number}|keepaspectratio)(?:\s*,\s*(?:(?:width|height)\s*=\s*${length}|scale\s*=\s*${number}|keepaspectratio))*\]`),()=>String.raw`\includegraphics<dimensions>`],
];
// Lex full source. Only top-level literal layout values are normalized; comments,
// math, nested arguments and everything else remain byte-for-byte evidence.
function sourceSignature(text, editStart=-1, editEnd=-1) {
  let out='', depth=0, math=false, comment=false, line='', safe=true;const groups=[];
  const literal=value=>value.replaceAll('<','<<');
  for(let i=0;i<text.length;) {
    if ((i===editStart || i===editEnd) && (comment || groups.includes('argument') || math || /\\(?:def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|catcode)\b/.test(line))) safe=false;
    const c=text[i];
    if (!comment && !math && c==='\\') {
      const verb=/^\\verb\*?([^A-Za-z\s])/.exec(text.slice(i));
      const env=/^\\begin\s*\{(verbatim\*?|lstlisting|minted)\}/.exec(text.slice(i));
      if (verb || env) {
        const end=verb ? text.indexOf(verb[1],i+verb[0].length) : text.indexOf('\\end{'+env[1]+'}',i+env[0].length);
        const stop=end<0 ? text.length : end+(verb?1:('\\end{'+env[1]+'}').length);
        if(editStart<stop && editEnd>i) safe=false;
        const segment=text.slice(i,stop); out+=literal(segment); line=segment.includes('\n')?segment.slice(segment.lastIndexOf('\n')+1):line+segment; i=stop; continue;
      }
    }
    if (comment) {out+=literal(c); i++; if(c==='\n'){comment=false;line='';} else line+=c; continue;}
    if (c==='%' ) {comment=true;out+=literal(c);line+=c;i++;continue;}
    if (c==='\\' && !math && !groups.includes('argument') && !/\\(?:def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|catcode)\b/.test(line)) {
      let found=false;
      for(const [re,normal] of patterns) {const m=re.exec(text.slice(i)); if(m){ if(editStart>=0 && ((i<editStart && i+m[0].length>editStart)||(i<editEnd && i+m[0].length>editEnd))) safe=false; out+=normal(m);line+=m[0];i+=m[0].length;found=true;break; }}
      if(found) continue;
    }
    if(c==='\\' && i+1<text.length && !/[A-Za-z@]/.test(text[i+1])) {const pair=text.slice(i,i+2); if(pair==='\\('||pair==='\\[')math=true;else if(pair==='\\)'||pair==='\\]')math=false;out+=literal(pair);line+=pair;i+=2;continue;}
    if(c==='$') math=!math;
    if(!math && c==='{'){depth++;groups.push(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?\s*$/.test(line)||line.trimEnd().endsWith('}')?'argument':'layout');}
    if(!math && c==='}'){depth--;groups.pop();}
    if(depth<0) safe=false;
    out+=literal(c);i++;line=c==='\n'?'':line+c;
  }
  return {signature:out,safe};
}
function safeReplacement(text, start, before, after) {
  if (!before || before===after || /%|\\(?:def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|catcode)\b/.test(before+after)) return false;
  const updated=text.slice(0,start)+after+text.slice(start+before.length);
  for(const match of updated.matchAll(/\\includegraphics\s*\[([^\]]+)\]/g)){
    if(match.index>start+after.length||match.index+match[0].length<start)continue;
    if(/\bwidth\s*=/.test(match[1])&&/\bheight\s*=/.test(match[1])&&!/(?:^|,)\s*keepaspectratio\s*(?:,|$)/.test(match[1]))return false;
  }
  const old=sourceSignature(text,start,start+before.length), next=sourceSignature(updated,start,start+after.length);
  return old.safe && next.safe && old.signature===next.signature;
}
function bounded(value) {
    try { const text = JSON.stringify(value); return text.length <= 12000 ? JSON.parse(text) : {status:'truncated', detail:'Tool result exceeded observation limit.'}; }
  catch { return {status:'unavailable', detail:'Tool result was not serializable.'}; }
}
function validArtifact(a, p) {
  return a?.success === true && a.projectId === p.id && a.engine === p.engine && a.pdfBytes instanceof Uint8Array && a.pdfBytes.length > 0 && typeof a.pdfHash === 'string' && hex(a.pdfBytes) === a.pdfHash;
}

export const LAYOUT_RUN_STATE_SCHEMA='falsify.layout-run-state.v1';
const RUN_STATES=new Set(['running','completed','paused','cancelled','failed']),LEGACY_STATUS=new Set(['running','complete','unresolved','cancelled']);
const MAX_CHECKPOINTS=12,MAX_TRACE=4096,RUN_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const editablePath=p=>/\.tex$/i.test(p)||/^falsify-(?:layout-structure|reconstruction)\.json$/.test(p);
const stateError=message=>Object.assign(new Error('Invalid layout run state: '+message),{code:'INVALID_RUN_STATE'});
// Supplied project and PDF bytes are treated as immutable, so one digest per buffer suffices.
const digests=new WeakMap();
const digest=bytes=>{let h=digests.get(bytes);if(h===undefined){h=hex(bytes);digests.set(bytes,h);}return h;};
function deepFreeze(value){
  if(value===null||typeof value!=='object'||ArrayBuffer.isView(value)||Object.isFrozen(value))return value;
  Object.freeze(value);for(const v of Object.values(value))deepFreeze(v);return value;
}
async function verifyStateProject(p,cache,label){
  if(!isObject(p)||typeof p.id!=='string'||!Array.isArray(p.files)||!p.files.length)throw stateError(label+' project');
  for(const f of p.files)if(!isObject(f)||!(f.bytes instanceof Uint8Array)||typeof f.sha256!=='string'||digest(f.bytes)!==f.sha256)throw stateError(label+' file hash');
  let canonical=cache.get(p.id);
  if(!canonical){canonical=await createLatexProject(p);if(canonical.id!==p.id)throw stateError(label+' project identity');cache.set(p.id,canonical);}
  else if(canonical.files.length!==p.files.length||canonical.mainFile!==(p.mainFile??null)||canonical.engine!==p.engine||canonical.origin!==p.origin||canonical.files.some(f=>!p.files.some(g=>g.path===f.path&&g.sha256===f.sha256)))throw stateError(label+' project identity');
  if((canonical.sourcePdfHash??null)!==(p.sourcePdfHash??null))throw stateError(label+' source PDF identity');
  const bytes=new Map(p.files.map(f=>[f.path,f.bytes]));
  return {...canonical,revision:Number.isSafeInteger(p.revision)&&p.revision>=0?p.revision:0,files:canonical.files.map(f=>({path:f.path,bytes:bytes.get(f.path),sha256:f.sha256}))};
}
function verifyStatePair(a,p,label){
  if(!(a?.success===true&&a.projectId===p.id&&a.engine===p.engine&&a.pdfBytes instanceof Uint8Array&&a.pdfBytes.length>0&&typeof a.pdfHash==='string'&&digest(a.pdfBytes)===a.pdfHash))throw stateError(label+' PDF does not match its project');
  return {...a};
}
const sameSource=(p,base)=>p.origin===base.origin&&p.engine===base.engine&&(p.sourcePdfHash??null)===(base.sourcePdfHash??null)&&base.files.every(f=>editablePath(f.path)||p.files.some(g=>g.path===f.path&&g.sha256===f.sha256));

/** Validate a saved falsify.layout-run-state.v1 snapshot. Never calls a model or tool. */
export async function validateLayoutRunState(state){
  if(!isObject(state)||state.schema!==LAYOUT_RUN_STATE_SCHEMA)throw stateError('schema');
  if(typeof state.runId!=='string'||!RUN_ID.test(state.runId))throw stateError('runId');
  if(state.parentRunId!=null&&(typeof state.parentRunId!=='string'||!RUN_ID.test(state.parentRunId)))throw stateError('parentRunId');
  if(!Number.isSafeInteger(state.stepCount)||state.stepCount<0)throw stateError('stepCount');
  if(!RUN_STATES.has(state.runState)||!LEGACY_STATUS.has(state.status))throw stateError('status');
  const cache=new Map(),baselineProject=await verifyStateProject(state.baselineProject,cache,'baseline');
  const member=async(p,label)=>{const v=await verifyStateProject(p,cache,label);if(!sameSource(v,baselineProject))throw stateError(label+' engine or source identity differs from baseline');return v;};
  const pair=async(c,label,required)=>{if(!isObject(c))throw stateError(label);const project=await member(c.project,label);if(c.artifact==null&&!required)return {project,artifact:null};return {project,artifact:verifyStatePair(c.artifact,project,label)};};
  const baselineArtifact=state.baselineArtifact==null?null:verifyStatePair(state.baselineArtifact,baselineProject,'baseline');
  const currentProject=await member(state.currentProject,'current');
  const candidate=await pair(state.candidate,'candidate',false);
  const previousCandidate=state.previousCandidate==null?null:await pair(state.previousCandidate,'previous candidate',true);
  if(!Array.isArray(state.checkpoints)||state.checkpoints.length>MAX_CHECKPOINTS)throw stateError('checkpoints');
  const ids=new Set(),checkpoints=[];
  for(const c of state.checkpoints){
    if(!isObject(c)||typeof c.revisionId!=='string'||!/^r\d{1,4}$/.test(c.revisionId)||ids.has(c.revisionId)||typeof c.label!=='string'||c.label.length>200)throw stateError('checkpoint');
    ids.add(c.revisionId);const p=await pair(c,'checkpoint '+c.revisionId,false);checkpoints.push({revisionId:c.revisionId,label:c.label,...p});
  }
  if(!Array.isArray(state.trace)||state.trace.length>MAX_TRACE)throw stateError('trace');
  // Trace strings remain data; each entry is re-bounded and never interpreted as a command.
  const trace=state.trace.map(e=>{if(!isObject(e)||typeof e.action!=='string'||e.action.length>80||(e.projectId!=null&&typeof e.projectId!=='string')||(e.pdfHash!=null&&typeof e.pdfHash!=='string'))throw stateError('trace entry');return deepFreeze({action:e.action,result:bounded(e.result??null),projectId:e.projectId??null,pdfHash:e.pdfHash??null});});
  return {schema:LAYOUT_RUN_STATE_SCHEMA,runId:state.runId,parentRunId:state.parentRunId??null,stepCount:state.stepCount,baselineProject,baselineArtifact,currentProject,candidate,...(previousCandidate?{previousCandidate}:{}),checkpoints,trace,coverage:bounded(state.coverage??null),quality:bounded(state.quality??null),status:state.status,runState:state.runState};
}

/** Model decisions select injected app tools. No model action executes host commands. */
export async function runPaperLayoutAgent({project, artifact=null, decide, compile, inspect, render, reference=null,readReference,renderReference,restructure,handlers={},signal, onProgress, maxSteps=12, runId, resumeState=null, onState}={}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32 || ![decide,compile,inspect,render].every(f=>typeof f==='function')) throw new TypeError('Invalid layout agent configuration');
  if ((runId!==undefined&&(typeof runId!=='string'||!RUN_ID.test(runId)))||(onState!==undefined&&onState!==null&&typeof onState!=='function')) throw new TypeError('Invalid layout agent configuration');
  // An explicit continuation restores the saved baseline, candidate and checkpoints.
  const resumed = resumeState==null ? null : await validateLayoutRunState(resumeState);
  if (resumed) {
    if (project && project.id !== resumed.baselineProject.id) throw new Error('Resume state does not match project');
    if (artifact && artifact.pdfHash !== resumed.baselineArtifact?.pdfHash) throw new Error('Resume state does not match artifact');
    if (runId === resumed.runId) throw new TypeError('A continuation needs a fresh runId');
  }
  const verified = resumed ? resumed.baselineProject : await createLatexProject(project);
  if (!resumed && (verified.id !== project.id || project.files.some(f => hex(f.bytes) !== f.sha256))) throw new Error('Stale project identity');
  if (!resumed && artifact && !validArtifact(artifact, verified)) throw new Error('Stale artifact identity');
  if(reference&&(!/^[a-f0-9]{64}$/.test(reference.sourcePdfHash||'')||reference.sourcePdfHash!==verified.sourcePdfHash||typeof readReference!=='function'||typeof renderReference!=='function'))throw new Error('Original PDF reference does not match project');
  const run={runId:runId??(globalThis.crypto?.randomUUID?.()||'run-'+Date.now().toString(36)+Math.random().toString(36).slice(2,10)),parentRunId:resumed?.runId??null,carriedStepCount:resumed?.stepCount??0};
  let current = resumed ? resumed.currentProject : verified, lastProject = resumed ? resumed.candidate.project : verified, lastArtifact = resumed ? resumed.candidate.artifact : artifact, inspected = null, rendered = null;
  // A saved PDF paired with the current source is a compiled fact; observations are not carried.
  let compiled = resumed && lastArtifact && lastProject.id === current.id ? current.id : null;
  let observations = [], images = [], trace = resumed ? [...resumed.trace] : [], coverage = null,referenceImages=[],referenceRead=false,referenceSeen=false,candidateSeen=null,compared=null,stepsTaken=0;
  const referencePages={read:new Set(),rendered:new Set(),observed:new Set()};
  const observedOriginal=new Set(),observedCandidates=new Map(),viewHistory=[];
  const viewKey=i=>JSON.stringify([i.pageIndex,i.bbox||null]);
  const candidateViews=()=>{const hash=lastArtifact?.pdfHash;if(!observedCandidates.has(hash))observedCandidates.set(hash,new Set());return observedCandidates.get(hash);};
  const alreadyObserved=i=>(i.document==='original'?observedOriginal:candidateViews()).has(viewKey(i));
  const observe=i=>{const views=i.document==='original'?observedOriginal:candidateViews(),key=viewKey(i);if(!views.has(key)){views.add(key);viewHistory.push({document:i.document||'candidate',pdfHash:i.document==='original'?reference?.sourcePdfHash:lastArtifact?.pdfHash,pageIndex:i.pageIndex,...(i.bbox?{bbox:i.bbox}:{})});}if(i.document==='original'&&!i.bbox)referencePages.observed.add(i.pageIndex);};
  let previousCandidate=resumed?.previousCandidate??null;
  const baselineProject=verified,baselineArtifact=resumed?resumed.baselineArtifact:artifact,checkpoints=new Map((resumed?.checkpoints||[]).map(c=>[c.revisionId,{label:c.label,project:c.project,artifact:c.artifact}]));
  const nextRevisionId=()=>'r'+(Math.max(0,...[...checkpoints.keys()].map(id=>Number(id.slice(1))))+1);
  const resetChecks=()=>{compiled=inspected=rendered=candidateSeen=compared=null;images=[];coverage=null;};
  const coverageOut=()=>({...(coverage||{status:'partial',visualQualityVerified:false}),observedViews:structuredClone(viewHistory),...(reference?{reference:{sourcePdfHash:reference.sourcePdfHash,readPages:[...referencePages.read],renderedPages:[...referencePages.rendered],observedPages:[...referencePages.observed],renderedRegions:trace.filter(e=>e.action==='render_region'&&e.result?.status==='ok').flatMap(e=>e.result.coverage?.regions||[]).filter(r=>r.document==='original'),observedRegions:viewHistory.filter(v=>v.document==='original'&&v.bbox)}}:{})});
  // Quality evidence is keyed by the PDF hash it describes; a different candidate never inherits it.
  const evidence={inspection:new Map(),comparison:new Map(),diagnostics:new Map()};
  const keep=(map,hash,value)=>{map.delete(hash);map.set(hash,value);if(map.size>16)map.delete(map.keys().next().value);};
  const ingest=entry=>{
    const r=entry.result,hash=entry.pdfHash;if(r?.status!=='ok'||typeof hash!=='string')return;
    if(entry.action==='inspect_pdf'&&r.observation?.schema==='falsify.layout-quality.v1'&&r.observation.pdfHash===hash)keep(evidence.inspection,hash,r.observation);
    else if(entry.action==='compare_document'&&r.observation?.schema==='falsify.layout-document-comparison.v1'&&r.observation.outputHash===hash)keep(evidence.comparison,hash,r.observation);
    else if(entry.action==='compile_pdf'&&Array.isArray(r.diagnostics))keep(evidence.diagnostics,hash,r.diagnostics);
  };
  trace.forEach(ingest);
  const candidateHash=()=>lastArtifact&&lastArtifact.projectId===lastProject.id?lastArtifact.pdfHash:null;
  const quality=()=>{
    const hash=candidateHash();
    try{return deepFreeze(deriveLayoutOutcome({candidatePdfHash:hash,candidateProjectId:lastProject.id,baselinePdfHash:baselineArtifact?.pdfHash??null,baselineProjectId:baselineProject.id,inspection:hash?evidence.inspection.get(hash)??null:null,comparison:hash?evidence.comparison.get(hash)??null:null,diagnostics:hash?evidence.diagnostics.get(hash)??null:null,observedPages:viewHistory.filter(v=>v.document==='candidate'&&v.pdfHash===hash&&!v.bbox).map(v=>v.pageIndex)}));}
    catch{return deepFreeze({schema:'falsify.layout-quality-outcome.v1',pdfHash:hash,content:'unverified',layout:'unverified',observedPages:[],findings:[]});}
  };
  // Snapshots share immutable byte buffers; frozen shells keep observers from altering the run.
  const projectViews=new WeakMap(),artifactViews=new WeakMap();
  const projectView=p=>{let v=projectViews.get(p);if(!v){v=Object.freeze({...p,files:Object.freeze(p.files.map(f=>Object.freeze({path:f.path,bytes:f.bytes,sha256:f.sha256})))});projectViews.set(p,v);}return v;};
  const artifactView=a=>{if(!a)return null;let v=artifactViews.get(a);if(!v){const {pdfBytes,...rest}=a;let copy;try{copy=structuredClone(rest);}catch{copy={...rest};}v=deepFreeze({...copy,pdfBytes});artifactViews.set(a,v);}return v;};
  const snapshot=(status,runState,q=quality())=>deepFreeze({schema:LAYOUT_RUN_STATE_SCHEMA,runId:run.runId,parentRunId:run.parentRunId,carriedStepCount:run.carriedStepCount,stepCount:run.carriedStepCount+stepsTaken,baselineProject:projectView(baselineProject),baselineArtifact:artifactView(baselineArtifact),currentProject:projectView(current),candidate:{project:projectView(lastProject),artifact:artifactView(lastArtifact)},...(previousCandidate?{previousCandidate:{project:projectView(previousCandidate.project),artifact:artifactView(previousCandidate.artifact)}}:{}),checkpoints:[...checkpoints].map(([revisionId,c])=>({revisionId,label:c.label,project:projectView(c.project),artifact:artifactView(c.artifact)})),trace:trace.slice(),coverage:coverageOut(),quality:q,status,runState});
  const emit=build=>{
    if(typeof onState!=='function')return;
    try{const pending=onState(build());if(pending&&typeof pending.then==='function')pending.then(null,()=>{});}catch{/* observers cannot alter the run */}
  };
  const result = (status, message, runState=status==='complete'?'completed':status==='cancelled'?'cancelled':'paused') => {
    let sessionState;try{sessionState=snapshot(status,runState,quality());}catch{sessionState=null;}
    const q=sessionState?.quality??quality();
    if(sessionState)emit(()=>sessionState);
    return {project:lastProject, artifact:lastArtifact,...(previousCandidate?{previousCandidate}:{}), status, trace, coverage:coverageOut(), message, runState, quality:q, sessionState};
  };
  const record = (action, data, identity=current.id, pdfHash=lastArtifact?.pdfHash ?? null) => {
    const entry = deepFreeze({action, result:bounded(data), projectId:identity, pdfHash});
    trace.push(entry); observations.push(entry); observations = observations.slice(-4);
    ingest(entry);
    try { onProgress?.(entry); } catch { /* observers cannot alter the run */ }
    if(entry.result?.status==='ok'||entry.result?.code==='invalid_action')emit(()=>snapshot('running','running'));
  };
  emit(()=>snapshot('running','running'));
  const cancelled = () => signal?.aborted;
  for (let step=0; step<maxSteps; step++) {
    if (cancelled()) return result('cancelled','Layout run cancelled.');
    let a;
    try {
      const sourceFiles=current.files.filter(f=>/\.tex$/i.test(f.path)),previewSize=Math.min(3000,Math.floor(16000/Math.max(1,sourceFiles.length)));
      let structure=null;try{const s=readLayoutStructure(current);structure={schema:s.schema,sourcePdfHash:s.sourcePdfHash,plan:s.plan,unitCount:s.units.length,units:s.units.slice(0,24).map(({id,pageIndex,bbox,kind,role,span})=>({id,pageIndex,bbox,kind,role,span})),unitsTruncated:s.units.length>24};}catch{}
      const priority=list=>[...list.filter(i=>!alreadyObserved(i)),...list.filter(alreadyObserved)];
      const attached=referenceImages.length&&images.length?[...priority(referenceImages).slice(0,2),...priority(images).slice(0,2)]:priority([...referenceImages,...images]).slice(0,4);
      const observedRead=referenceRead||observations.some(e=>e.action==='read_reference'&&e.result?.status==='ok'),originalVisible=referenceSeen||attached.some(i=>i.document==='original'),candidateVisible=candidateSeen===lastArtifact?.pdfHash||attached.some(i=>i.document!=='original');
      const execution={compiledCurrent:compiled===current.id,inspectedCurrent:inspected===lastArtifact?.pdfHash,renderedCurrent:rendered===lastArtifact?.pdfHash,originalRead:observedRead,originalVisible,candidateVisible,pdfHash:lastProject.id===current.id?lastArtifact?.pdfHash:null,remainingSteps:maxSteps-step,completedActions:trace.map(e=>({tool:e.action,status:e.result?.status})),checkpoints:[...checkpoints].map(([revisionId,c])=>({revisionId,label:c.label,projectId:c.project.id,pdfHash:c.artifact?.pdfHash||null}))};
      const visible=i=>alreadyObserved(i)||attached.some(a=>a.document===i.document&&viewKey(a)===viewKey(i));
      execution.pendingViews=[...referenceImages,...images].filter(i=>!visible(i)).map(({document='candidate',pageIndex,bbox})=>({document,pageIndex,...(bbox?{bbox}:{})}));
      execution.observedViews=structuredClone(viewHistory);
      execution.comparedCurrent=compared===lastArtifact?.pdfHash;
      execution.run={runId:run.runId,parentRunId:run.parentRunId,carriedStepCount:run.carriedStepCount};
      execution.comparisonRequired=typeof handlers.compare_document==='function'&&current.id!==baselineProject.id;
      execution.canFinish=execution.compiledCurrent&&execution.inspectedCurrent&&execution.renderedCurrent&&candidateVisible&&(!reference||observedRead&&originalVisible)&&execution.pendingViews.length===0&&(!execution.comparisonRequired||execution.comparedCurrent);
      const availableTools=layoutToolCatalog.filter(t=>legacyTools.has(t.name)||['checkpoint','restore_revision'].includes(t.name)||typeof handlers[t.name]==='function').filter(t=>!['read_reference','render_reference_pages'].includes(t.name)||reference).filter(t=>t.name!=='restructure_source'||structure&&typeof restructure==='function');
      stepsTaken=step+1;
      a = await decide({protocol:'v2',projectId:current.id, step, maxSteps, execution,instruction:instruction, tools:structuredClone(availableTools), observations:structuredClone(observations), images:structuredClone(attached), sourceFiles:sourceFiles.map(f=>({path:f.path,text:dec.decode(f.bytes).slice(0,previewSize)})),...(reference?{reference:structuredClone(reference)}:{}),...(structure?{structure}: {})});
      attached.forEach(observe);
      if(attached.some(i=>i.document==='original'))referenceSeen=true;
      if(observations.some(e=>e.action==='read_reference'&&e.result?.status==='ok'))referenceRead=true;
      if(attached.some(i=>i.document!=='original')&&compiled===current.id)candidateSeen=lastArtifact?.pdfHash;
      if (cancelled()) return result('cancelled','Layout run cancelled.');
      a=normalizeLayoutAction(a);
      if (!a||!availableTools.some(t=>t.name===a.tool)) { record('invalid_action',{status:'rejected',reason:'Choose an available tool and its listed arguments.'}); return result('unresolved','Malformed agent action.','failed'); }
      const action = a.tool;
      if(action==='checkpoint'){
        if(checkpoints.size>=12){record(action,{status:'rejected',reason:'Twelve revisions are saved. Restore a revision to continue.'});continue;}
        const revisionId=nextRevisionId(),paired=lastProject.id===current.id&&validArtifact(lastArtifact,current)?lastArtifact:null;
        checkpoints.set(revisionId,{label:a.args.label||revisionId,project:current,artifact:paired});record(action,{status:'ok',revisionId,label:a.args.label||revisionId,hasPdf:!!paired});continue;
      }
      if(action==='restore_revision'){
        const saved=checkpoints.get(a.args.revisionId);if(!saved){record(action,{status:'rejected',reason:'Choose a revision ID from execution.checkpoints.'});continue;}
        if(!saved.artifact&&lastArtifact)previousCandidate={project:lastProject,artifact:lastArtifact};
        current=saved.project;resetChecks();lastProject=current;lastArtifact=saved.artifact;if(saved.artifact)compiled=current.id;record(action,{status:'ok',revisionId:a.args.revisionId,hasPdf:!!saved.artifact});continue;
      }
      if(typeof handlers[action]==='function'){
        try{
          const activeArtifact=lastProject.id===current.id&&validArtifact(lastArtifact,current)?lastArtifact:null;
          const output=await handlers[action]({project:structuredClone(current),artifact:activeArtifact?structuredClone(activeArtifact):null,baselineProject:structuredClone(baselineProject),baselineArtifact:baselineArtifact?structuredClone(baselineArtifact):null,args:structuredClone(a.args),signal});
          if(cancelled())return result('cancelled','Layout run cancelled.');
          if(output?.project){const next=await createLatexProject(output.project);if(next.id!==output.project.id||next.origin!==current.origin||next.engine!==current.engine||next.sourcePdfHash!==current.sourcePdfHash||current.files.some(f=>!(/\.tex$/i.test(f.path)||/^falsify-(?:layout-structure|reconstruction)\.json$/.test(f.path))&&!next.files.some(g=>g.path===f.path&&g.sha256===f.sha256)))throw Object.assign(new Error('Tool returned a different source or changed an existing asset.'),{code:'SOURCE_CHANGED'});current=next;resetChecks();}
          if(output?.images){
            if(!Array.isArray(output.images)||!output.images.length||output.images.length>4||output.images.some(i=>!Number.isSafeInteger(i.pageIndex)||i.mime!=='image/png'||!i.base64?.startsWith('iVBORw0KGgo')||i.base64.length>699052||!['original','candidate'].includes(i.document)))throw Object.assign(new Error('Region renderer returned an invalid image.'),{code:'INVALID_REGION'});
            if(output.images.some(i=>i.document==='original'))referenceImages=output.images.filter(i=>i.document==='original');
            if(output.images.some(i=>i.document==='candidate')){if(!activeArtifact)throw Error('Compile the current project first.');images=output.images.filter(i=>i.document==='candidate');rendered=activeArtifact.pdfHash;coverage={status:'partial',render:output.coverage||{regions:images.map(({pageIndex,bbox})=>({pageIndex,bbox}))},visualQualityVerified:false};}
          }
          const observation=output?.observation??output?.summary??(output?.project?{}:output);
          if(action==='compare_document'&&observation?.schema==='falsify.layout-document-comparison.v1'&&observation.outputHash===activeArtifact?.pdfHash&&bounded({status:'ok',observation}).status!=='truncated')compared=activeArtifact.pdfHash;
          record(action,{status:'ok',observation,...(output?.coverage?{coverage:output.coverage}:{})});
        }catch(error){if(cancelled())return result('cancelled','Layout run cancelled.');record(action,{status:'rejected',code:typeof error.code==='string'?error.code.slice(0,80):'TOOL_INPUT',reason:typeof error.message==='string'?error.message.slice(0,500):'Read the target block and adjust the arguments.'});}
        continue;
      }
      if (action === 'finish') {
        if([...referenceImages,...images].some(i=>!alreadyObserved(i))){record(action,{status:'rejected',reason:'View the remaining rendered pages or regions before finishing.'});continue;}
        if(typeof handlers.compare_document==='function'&&current.id!==baselineProject.id&&compared!==lastArtifact?.pdfHash){record(action,{status:'rejected',reason:'Run compare_document for the current PDF before finishing.'});continue;}
        const complete = compiled === current.id && inspected === lastArtifact?.pdfHash && rendered === lastArtifact?.pdfHash && lastProject.id === current.id&&candidateSeen===lastArtifact?.pdfHash&&(!reference||referenceRead&&referenceSeen);
        record(action,{status:complete?'complete':'rejected',message:a.message});
        return result(complete?'complete':'unresolved',complete ? a.message : 'Current PDF has not been compiled, inspected and rendered.');
      }
      if(action==='read_reference'){
        if(!reference){record(action,{status:'rejected',reason:'No original PDF reference'});continue;}
        const output=await readReference({pages:[...a.pages],offset:a.args.offset??(/^\d+$/.test(a.before)?Number(a.before):0),textOffset:a.args.textOffset,unitOffset:a.args.unitOffset,signal});if(cancelled())return result('cancelled','Layout run cancelled.');
        if(output?.sourcePdfHash!==reference.sourcePdfHash||!Array.isArray(output.pages)||!output.pages.length||output.pages.some(p=>!Number.isSafeInteger(p.pageIndex)||p.pageIndex<0)||bounded({status:'ok',reference:output})?.status==='truncated'){record(action,{status:'rejected',reason:'Original reference is unavailable, too large, or has another hash'});continue;}
        for(const page of output.pages)referencePages.read.add(page.pageIndex);record(action,{status:'ok',reference:output});continue;
      }
      if(action==='render_reference_pages'){
        if(!reference){record(action,{status:'rejected',reason:'No original PDF reference'});continue;}
        const output=await renderReference({pages:[...a.pages],signal});if(cancelled())return result('cancelled','Layout run cancelled.');
        if(output?.sourcePdfHash!==reference.sourcePdfHash||!Array.isArray(output.images)||!output.images.length||output.images.length>4||output.images.some(i=>!Number.isSafeInteger(i.pageIndex)||i.pageIndex<0||i.mime!=='image/png'||typeof i.base64!=='string'||!i.base64.startsWith('iVBORw0KGgo')||i.base64.length>699052)||a.pages.length&&a.pages.some(p=>!output.images.some(i=>i.pageIndex===p))){record(action,{status:'rejected',reason:'Original page render does not match reference'});continue;}
        referenceImages=output.images.map(i=>({...i,document:'original'}));for(const i of referenceImages)referencePages.rendered.add(i.pageIndex);record(action,{status:'ok',sourcePdfHash:reference.sourcePdfHash,pages:referenceImages.map(i=>i.pageIndex),coverage:output.coverage});continue;
      }
      if(action==='restructure_source'){
        if(typeof restructure!=='function'){record(action,{status:'rejected',reason:'No structural editor for this source'});continue;}
        let plan;try{plan=JSON.parse(a.after);}catch{record(action,{status:'rejected',reason:'after must be a layout plan JSON object'});continue;}
        let output;try{output=await restructure({project:structuredClone(current),plan,signal});}catch{record(action,{status:'rejected',reason:'Structure plan must preserve all units, assets and source identity; use current structure.plan with every unit exactly once'});continue;}
        if(cancelled())return result('cancelled','Layout run cancelled.');
        const next=await createLatexProject(output.project);
        if(next.id!==output.project?.id||next.origin!==current.origin||next.engine!==current.engine||next.sourcePdfHash!==current.sourcePdfHash||current.files.some(f=>!(/\.tex$/i.test(f.path)||/^falsify-(?:layout-structure|reconstruction)\.json$/.test(f.path))&&!next.files.some(g=>g.path===f.path&&g.sha256===f.sha256))){record(action,{status:'rejected',reason:'Structural tool returned an unrelated project or changed source assets'});continue;}
        current=next;compiled=inspected=rendered=candidateSeen=null;images=[];coverage=null;record(action,{status:'ok',summary:output.summary});continue;
      }
      if (action === 'read_source' || action === 'replace_source') {
        const file = current.files.find(f=>f.path===a.path && /\.tex$/i.test(f.path));
        if (!file) { record(action,{status:'rejected',reason:'Unsupported path'}); continue; }
        const text = dec.decode(file.bytes);
        if (action === 'read_source') {
          const match=a.before?text.indexOf(a.before):-1,offset=match>=0?Math.max(0,match-500):(a.pages[0]||0)*8000;
          if(offset>=text.length&&text.length){record(action,{status:'rejected',reason:'Source chunk is outside this file',totalChunks:Math.ceil(text.length/8000)});continue;}
          record(action,{status:'ok',path:file.path,text:text.slice(offset,offset+8000),offset,totalCharacters:text.length,totalChunks:Math.ceil(text.length/8000)});continue;
        }
        const start=text.indexOf(a.before);
        // A layout operation must not occur within a commented line or a macro definition.
        const lineStart=text.lastIndexOf('\n',start-1)+1, prefix=text.slice(lineStart,start);
        if (start<0 || text.indexOf(a.before,start+1)!==-1 || !safeReplacement(text,start,a.before,a.after) || /(^|[^\\])%/.test(prefix) || /\\(?:def|gdef|edef|xdef|newcommand|renewcommand|catcode)\b/.test(prefix)) {
          record(action,{status:'rejected',reason:'Use a unique exact match and change only supported literal layout values; preserve prose, comments, definitions and structure. Include keepaspectratio when setting both graphic width and height. Example: \\setlength{\\parskip}{4pt} -> \\setlength{\\parskip}{6pt}.',path:file.path}); continue;
        }
        const files=current.files.map(f=>({path:f.path,bytes:f.path===file.path?enc.encode(text.slice(0,start)+a.after+text.slice(start+a.before.length)):f.bytes}));
        const next=await createLatexProject({...current,files});
        if (cancelled()) return result('cancelled','Layout run cancelled.');
        next.revision=(current.revision||0)+1; current=next; compiled=inspected=rendered=null; images=[]; coverage=null;
        record(action,{status:'ok',path:file.path,before:a.before,after:a.after}); continue;
      }
      if (action === 'compile_pdf') {
        const output=await compile({project:structuredClone(current),signal});
        if (cancelled()) return result('cancelled','Layout run cancelled.');
        if (!validArtifact(output,current)) { compiled=inspected=rendered=null; record(action,{status:'failed',diagnostics:output?.diagnostics||[]}); continue; }
        lastProject=current; lastArtifact={...output,pdfBytes:new Uint8Array(output.pdfBytes)}; compiled=current.id; inspected=rendered=null; images=[]; coverage=null;
        record(action,{status:'ok',diagnostics:output.diagnostics||[]}); continue;
      }
      if (compiled !== current.id || lastProject.id !== current.id || !validArtifact(lastArtifact,current)) { record(action,{status:'rejected',reason:'Compile current project first'}); continue; }
      if (action === 'inspect_pdf') {
        const output=await inspect({project:structuredClone(current),artifact:structuredClone(lastArtifact),signal});
        if (cancelled()) return result('cancelled','Layout run cancelled.');
        if (!output || output.schema !== 'falsify.layout-quality.v1' || !['ok','partial'].includes(output.status) || output.pdfHash !== lastArtifact.pdfHash || !Array.isArray(output.issues) || !output.coverage || typeof output.coverage !== 'object' || Array.isArray(output.coverage) || ['truncated','unavailable'].includes(bounded({status:'ok',observation:output})?.status)) { inspected=null; record(action,{status:'failed',observation:output}); continue; }
        inspected=lastArtifact.pdfHash; record(action,{status:'ok',observation:output}); continue;
      }
      const output=await render({project:structuredClone(current),artifact:structuredClone(lastArtifact),pages:[...a.pages],signal});
      if (cancelled()) return result('cancelled','Layout run cancelled.');
      if (!output || !Array.isArray(output.images) || !output.images.length || output.images.length > 4 || output.images.some(i=>!Number.isSafeInteger(i.pageIndex)||i.pageIndex<0||i.mime!=='image/png'||typeof i.base64!=='string'||!i.base64.startsWith('iVBORw0KGgo')||i.base64.length>699052)) { rendered=null; record(action,{status:'failed',reason:'No valid rendered pages'}); continue; }
      if (new Set(output.images.map(i=>i.pageIndex)).size !== output.images.length || (a.pages.length && (output.images.length !== a.pages.length || a.pages.some(p=>!output.images.some(i=>i.pageIndex===p))))) { rendered=null; record(action,{status:'failed',reason:'Rendered pages do not match request'}); continue; }
      images=output.images.map(i=>({pageIndex:i.pageIndex,mime:i.mime,base64:i.base64})); coverage={status:'partial',render:bounded(output.coverage ?? null),visualQualityVerified:false}; rendered=lastArtifact.pdfHash;
      record(action,{status:'ok',pages:images.map(i=>i.pageIndex),coverage});
    } catch (error) {
      if (cancelled()) return result('cancelled','Layout run cancelled.');
      const failure=layoutFailureDetails(error);
      if(error?.disposition==='cancelled'){record(a?.tool || 'decide',{status:'failed',...failure});return result('cancelled','이 단계는 취소되어 끝났습니다. 이어서 진행하려면 새 실행을 시작하세요. '+failure.reason);}
      if(!a&&failure.code==='invalid_action'){record('invalid_action',{status:'rejected',...failure,reason:failure.reason+' Choose an offered tool and use exactly its listed arguments. No edit was applied.'});continue;}
      record(a?.tool || 'decide',{status:'failed',...failure});
      return result('unresolved',failure.reason,'failed');
    }
  }
  return result('unresolved','Layout agent reached its step limit.');
}
