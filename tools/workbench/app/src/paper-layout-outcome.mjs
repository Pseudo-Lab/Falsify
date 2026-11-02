// Derive layout run quality from evidence bound to one candidate PDF hash.
// Pure: no I/O, no model calls; input objects are never mutated.
//
// Accepted input fields (all optional; anything else is ignored):
//   candidatePdfHash   string|null  hash of the current candidate PDF (null: source-only candidate)
//   candidateProjectId string|null  id of the project paired with the candidate
//   baselinePdfHash    string|null  hash of the captured pre-layout PDF
//   baselineProjectId  string|null  id of the captured pre-layout project (includes selected RED edits)
//   inspection         falsify.layout-quality.v1 observation; used only when its pdfHash equals candidatePdfHash
//   comparison         falsify.layout-document-comparison.v1 observation; used only when its outputHash equals
//                      candidatePdfHash and (when both known) its baselineHash/baselineProjectId match the baseline
//   diagnostics        compiler diagnostics [{code,message,severity}] for candidatePdfHash
//   observedPages      candidate page indices actually delivered to the model for candidatePdfHash
//
// Output: {schema,pdfHash,content,layout,layoutScope,layoutVerified,inspectionStatus,limitations,coverage,observedPages,findings,evidence}
//   content: 'unchanged' | 'changed' | 'unverified'
//   layout:  'clear' | 'issues' | 'unverified'
//            'clear' (kept for compatibility) means only that the inspection detected no issue;
//            read it together with layoutScope.
//   layoutScope: 'complete'  inspection status 'ok' with no limitation and untruncated findings
//                'observed'  partial inspection: results hold only for the observed scope
//                null        no hash-bound usable inspection (layout stays 'unverified')
//   layoutVerified: true only for layout 'clear' with layoutScope 'complete'
//   inspectionStatus: 'ok' | 'partial' | 'unavailable' | null (hash-bound inspection status)
//   limitations: inspection limitations (bounded strings; 'Findings truncated.' when truncated)
//   coverage: bounded JSON copy of the inspection coverage, or null
//   findings: [{code,severity,document,pageIndex?,bbox?,message,evidence?}]
export const LAYOUT_OUTCOME_SCHEMA='falsify.layout-quality-outcome.v1';
const HASH=/^[a-f0-9]{64}$/;
const MAX_FINDINGS=200,SAMPLE=8;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const total=list=>isObject(list)&&Number.isSafeInteger(list.total)&&list.total>=0?list.total:null;
const sample=list=>Array.isArray(list?.items)?list.items.slice(0,SAMPLE).map(x=>typeof x==='string'||typeof x==='number'?x:JSON.parse(JSON.stringify(x??null))):[];
const text=(value,max=300)=>String(value??'').slice(0,max);
const finiteBox=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)?b.map(Number):null;
const severe=/overlap|collision|clip|overflow|outside|offpage|off-page/i;
const MAX_LIMITATIONS=24,MAX_COVERAGE_JSON=4000,TRUNCATED='Findings truncated.';

function inspectionScope(inspection){
 const limitations=[];
 for(const item of Array.isArray(inspection.limitations)?inspection.limitations:[]){
  if(typeof item!=='string'||!item.trim())continue;const s=text(item.trim());
  if(!limitations.includes(s)&&limitations.length<MAX_LIMITATIONS)limitations.push(s);
 }
 let coverage=null;
 if(isObject(inspection.coverage)){
  try{const json=JSON.stringify(inspection.coverage);coverage=json.length<=MAX_COVERAGE_JSON?JSON.parse(json):{truncated:true};}catch{coverage=null;}
 }
 const truncated=inspection.findingsTruncated===true||inspection.coverage?.findingsTruncated===true||limitations.includes(TRUNCATED);
 if(truncated&&!limitations.includes(TRUNCATED))limitations.push(TRUNCATED);
 return {limitations,coverage,truncated};
}

function inspectionFindings(inspection){
 const out=[];
 for(const issue of inspection.issues){
  if(!isObject(issue))continue;
  const code=text(issue.type||issue.code||'LAYOUT_ISSUE',80),bbox=finiteBox(issue.bbox);
  out.push({code,severity:severe.test(code)?'error':'warning',document:'candidate',...(Number.isSafeInteger(issue.pageIndex)&&issue.pageIndex>=0?{pageIndex:issue.pageIndex}:{}),...(bbox?{bbox}:{}),message:text(issue.message||`Layout inspection reported ${code}.`),...(issue.evidence!==undefined?{evidence:JSON.parse(JSON.stringify({penalty:issue.penalty??null,detail:issue.evidence}))}:{})});
 }
 return out;
}

// Returns {findings, verified:boolean} for the comparison's content dimensions.
function comparisonFindings(c){
 const findings=[];let verified=true;
 const add=(code,severity,list,message)=>{const n=total(list);if(n===null){verified=false;return;}if(n>0)findings.push({code,severity,document:'candidate',message:`${message} (${n}).`,evidence:{total:n,items:sample(list)}});};
 const tokens=c.tokens;
 if(!isObject(tokens)||!isObject(tokens.text)||!isObject(tokens.numbers))verified=false;
 else{
  add('TEXT_MISSING','error',tokens.text.missing,'Text tokens of the pre-layout PDF are missing in the candidate');
  add('TEXT_ADDED','warning',tokens.text.added,'Text tokens absent from the pre-layout PDF appear in the candidate');
  add('NUMBERS_MISSING','error',tokens.numbers.missing,'Numbers of the pre-layout PDF are missing in the candidate');
  add('NUMBERS_ADDED','error',tokens.numbers.added,'Numbers absent from the pre-layout PDF appear in the candidate');
 }
 const source=c.sourceContent;
 if(!isObject(source)||typeof source.unchanged!=='boolean')verified=false;
 else{
  if(!source.unchanged)findings.push({code:'SOURCE_CONTENT_CHANGED',severity:'error',document:'candidate',message:'Normalized source content differs from the pre-layout source.',evidence:{total:total(source.changes),items:sample(source.changes)}});
  if(isObject(source.numbers)){add('SOURCE_NUMBERS_MISSING','error',source.numbers.missing,'Source numbers are missing');add('SOURCE_NUMBERS_ADDED','error',source.numbers.added,'Source numbers were added');}
 }
 if(!isObject(c.links))verified=false;
 else add('LINKS_MISSING','error',c.links.missing,'Links of the pre-layout PDF are absent in the candidate');
 if(isObject(c.assets?.counts)){const n=(c.assets.counts.missing|0)+(c.assets.counts.changed|0);if(n>0)findings.push({code:'ASSETS_CHANGED',severity:'error',document:'candidate',message:`Source assets are missing or changed (${n}).`,evidence:{total:n}});}
 return {findings,verified};
}

export function deriveLayoutOutcome(input={}){
 const {candidatePdfHash=null,candidateProjectId=null,baselinePdfHash=null,baselineProjectId=null,inspection=null,comparison=null,diagnostics=null,observedPages=[]}=isObject(input)?input:{};
 const pdfHash=typeof candidatePdfHash==='string'&&HASH.test(candidatePdfHash)?candidatePdfHash:null;
 const pages=[...new Set((Array.isArray(observedPages)?observedPages:[]).filter(i=>Number.isSafeInteger(i)&&i>=0))].sort((a,b)=>a-b);
 const findings=[],evidence={inspection:false,comparison:false,diagnostics:false,sourceIdentical:false};
 let content='unverified',layout='unverified',layoutScope=null,inspectionStatus=null,limitations=[],coverage=null;
 if(pdfHash&&isObject(comparison)&&comparison.schema==='falsify.layout-document-comparison.v1'&&comparison.outputHash===pdfHash&&(!baselinePdfHash||comparison.baselineHash===baselinePdfHash)&&(!baselineProjectId||!comparison.baselineProjectId||comparison.baselineProjectId===baselineProjectId)){
  const c=comparisonFindings(comparison);evidence.comparison=true;findings.push(...c.findings);
  content=c.findings.length?'changed':c.verified?'unchanged':'unverified';
 }else if(pdfHash&&baselinePdfHash===pdfHash){
  // The actual generated bytes equal the captured PDF, including selected RED edits.
  content='unchanged';evidence.sourceIdentical=true;
 }
 if(pdfHash&&isObject(inspection)&&inspection.schema==='falsify.layout-quality.v1'&&inspection.pdfHash===pdfHash){
  const scope=inspectionScope(inspection);
  if(['ok','partial'].includes(inspection.status)&&Array.isArray(inspection.issues)){
   evidence.inspection=true;const issues=inspectionFindings(inspection);findings.push(...issues);layout=issues.length?'issues':'clear';
   inspectionStatus=inspection.status;({limitations,coverage}=scope);
   // Zero findings from a partial, limited or truncated inspection means "no detected issue
   // in the observed scope", never a verified layout.
   layoutScope=inspection.status==='ok'&&!scope.limitations.length&&!scope.truncated?'complete':'observed';
  }else if(inspection.status==='unavailable'){
   // Known unavailable stays unverified; its limitations are still reported.
   inspectionStatus='unavailable';({limitations,coverage}=scope);
  }
 }
 if(pdfHash&&Array.isArray(diagnostics)){
  evidence.diagnostics=true;
  for(const d of diagnostics)if(isObject(d)&&typeof d.code==='string'&&d.severity!=='info')findings.push({code:text(d.code,80),severity:d.severity==='error'?'error':'warning',document:'candidate',message:text(d.message||d.code),evidence:{source:'compiler',...(Number.isFinite(d.count)?{count:d.count}:{})}});
 }
 return {schema:LAYOUT_OUTCOME_SCHEMA,pdfHash,content,layout,layoutScope,layoutVerified:layout==='clear'&&layoutScope==='complete',inspectionStatus,limitations,coverage,observedPages:pages,findings:findings.slice(0,MAX_FINDINGS),...(findings.length>MAX_FINDINGS?{findingsTruncated:findings.length}:{}),evidence};
}
