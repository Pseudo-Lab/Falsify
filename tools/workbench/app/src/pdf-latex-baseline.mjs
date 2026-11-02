import {extractReconstructionEvidence,buildReconstructionModel} from './pdf-latex-evidence.mjs';
import {enrichReconstructionRegions} from './pdf-latex-regions.mjs';
import {serializeReconstruction} from './pdf-latex-serialize.mjs';
import {serializeFlowReconstruction} from './pdf-latex-flow-serialize.mjs';
import {createLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import * as mupdf from 'mupdf';

const encoder=new TextEncoder();
const cancelled=signal=>{if(signal?.aborted)throw new DOMException('취소했습니다.','AbortError');};
// Compare exact normalized lexemes as a multiset; numeric spelling is retained,
// including sign, exponent and percent. This is not a semantic numeric comparison.
const numeric=/^[+\-−]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+\-−]?\d+)?%?$/u;
const words=text=>String(text||'').normalize('NFC').replace(/(\p{L})-\s*\n\s*(\p{L})/gu,'$1$2').match(/[+\-−]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+\-−]?\d+)?%?|[\p{L}\p{N}_]+/gu)||[];
const HASH=/^[a-f0-9]{64}$/;
const invalid=code=>{throw Object.assign(new Error(code),{code});};
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
function difference(a,b){const counts=new Map();for(const value of b)counts.set(value,(counts.get(value)||0)+1);const out=[];for(const value of a){const count=counts.get(value)||0;if(count)counts.set(value,count-1);else out.push(value);}return out;}
/** No-op reconstruction differences are separate from later RED changes. */
export function compareReconstruction(source,baseline){
  if(!source?.pages||!baseline?.pages)throw new TypeError('두 PDF의 추출 결과가 필요합니다.');
  const original=source.pages.map(p=>p.text||'').join('\n'), rebuilt=baseline.pages.map(p=>p.text||'').join('\n');
  const a=words(original),b=words(rebuilt),numbers=list=>list.filter(v=>numeric.test(v));
  return {schema:'falsify.reconstruction-comparison.v1',sourcePages:source.pages.length,baselinePages:baseline.pages.length,
    ...(HASH.test(source.sourceSha256)?{sourcePdfHash:source.sourceSha256}:{}),...(HASH.test(baseline.sourceSha256)?{baselinePdfHash:baseline.sourceSha256}:{}),
    text:{missing:difference(a,b),added:difference(b,a)},numbers:{missing:difference(numbers(a),numbers(b)),added:difference(numbers(b),numbers(a))},
    method:'extracted-token-multiset',readingOrderVerified:false,visualLayoutVerified:false};
}
export async function prepareReconstruction({file,signal,onProgress=()=>{}}={},dependencies={}){
  cancelled(signal);if(!file?.arrayBuffer)throw new TypeError('원본 PDF가 필요합니다.');
  const bytes=new Uint8Array(await file.arrayBuffer());cancelled(signal);const hash=hex(bytes);
  onProgress('원본의 글·그림·표를 읽고 있습니다.');
  const extract=dependencies.extract||extractReconstructionEvidence;
  const evidence=await extract({bytes,sourceSha256:hash,signal});cancelled(signal);
  const base=(dependencies.model||buildReconstructionModel)(evidence);
  const model=await(dependencies.regions||enrichReconstructionRegions)({model:base,bytes,signal,revision:hash,mupdf});cancelled(signal);
  return {file,sourceSha256:hash,evidence,model};
}
export async function createReconstructionProject(draft,decisions=[],dependencies={}){
  if(!draft?.sourceSha256||draft.model?.sourceSha256!==draft.sourceSha256)throw new Error('원본 PDF와 재구성 정보가 다릅니다.');
  const layout=dependencies.layout??'source-layout';
  if(!['source-layout','semantic-flow'].includes(layout))throw new TypeError('재구성 방식을 확인하세요.');
  const serialize=dependencies.serialize||(layout==='semantic-flow'?serializeFlowReconstruction:serializeReconstruction);
  const result=serialize({model:draft.model,decisions,engine:'pdflatex',profile:dependencies.profile,fontFiles:dependencies.fontFiles});
  const engine=result.engine??(layout==='semantic-flow'?'lualatex':'pdflatex');
  if(!result.mainFile||!result.files?.length)throw Object.assign(new Error('편집용 소스를 만들지 못했습니다.'),{diagnostics:result.diagnostics});
  const metadata={schema:'falsify.reconstruction-baseline.v1',sourcePdfHash:draft.sourceSha256,status:result.status,layout,...(result.typography?{typography:structuredClone(result.typography)}:{}),decisions:structuredClone(decisions),bindings:result.bindings.map(({projectId,...binding})=>({...binding,bindingScope:'containing-project'})),diagnostics:result.diagnostics};
  const files=[...result.files,...(result.structure?[{path:'falsify-layout-structure.json',bytes:encoder.encode(JSON.stringify(result.structure))}]:[]),{path:'falsify-reconstruction.json',bytes:encoder.encode(JSON.stringify(metadata))}];
  const project=await(dependencies.project||createLatexProject)({files,mainFile:result.mainFile,engine,origin:'reconstructed-pdf',sourcePdfHash:draft.sourceSha256});
  return {...result,project,bindings:result.bindings.map(b=>({...b,projectId:project.id}))};
}

/** Record a verified no-attack artifact and its reconstructed project lineage. */
export function createReconstructionLineage({project,artifact,comparison,bindings,decisions}={}){
  if(project?.schema!=='falsify.latex-project.v1'||project.origin!=='reconstructed-pdf'||!HASH.test(project.id)||!HASH.test(project.sourcePdfHash)||!Array.isArray(project.files)||!project.files.length)invalid('INVALID_PROJECT');
  const paths=new Set();
  for(const f of project.files){if(!f||typeof f.path!=='string'||!f.path||paths.has(f.path)||!(f.bytes instanceof Uint8Array)||!HASH.test(f.sha256)||hex(f.bytes)!==f.sha256)invalid('STALE_PROJECT');paths.add(f.path);}
  const files=project.files.map(({path,sha256})=>[path,sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  if(hex(encoder.encode(JSON.stringify({files,mainFile:project.mainFile,engine:project.engine,origin:project.origin})))!==project.id)invalid('STALE_PROJECT');
  if(artifact?.schema!=='falsify.latex-artifact.v1'||artifact.success!==true||artifact.projectId!==project.id||artifact.engine!==project.engine||!(artifact.pdfBytes instanceof Uint8Array)||!artifact.pdfBytes.length||!HASH.test(artifact.pdfHash)||hex(artifact.pdfBytes)!==artifact.pdfHash||!artifact.engineManifest||typeof artifact.engineManifest!=='object'||Array.isArray(artifact.engineManifest))invalid('INVALID_ARTIFACT');
  if(comparison?.schema!=='falsify.reconstruction-comparison.v1'||comparison.sourcePdfHash!==project.sourcePdfHash||comparison.baselinePdfHash!==artifact.pdfHash||comparison.method!=='extracted-token-multiset'||comparison.readingOrderVerified!==false||comparison.visualLayoutVerified!==false||!Number.isSafeInteger(comparison.sourcePages)||comparison.sourcePages<1||!Number.isSafeInteger(comparison.baselinePages)||comparison.baselinePages<1||![comparison.text?.missing,comparison.text?.added,comparison.numbers?.missing,comparison.numbers?.added].every(a=>Array.isArray(a)&&a.every(x=>typeof x==='string')))invalid('INVALID_COMPARISON');
  if(!Array.isArray(bindings)||!Array.isArray(decisions))invalid('INVALID_BINDINGS');
  let recorded;try{const f=project.files.find(x=>x.path==='falsify-reconstruction.json');recorded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(f.bytes));}catch{invalid('INVALID_METADATA');}
  if(recorded.schema!=='falsify.reconstruction-baseline.v1'||recorded.sourcePdfHash!==project.sourcePdfHash||!Array.isArray(recorded.bindings)||JSON.stringify(recorded.decisions)!==JSON.stringify(decisions)||recorded.bindings.length!==bindings.length)invalid('INVALID_METADATA');
  for(let i=0;i<bindings.length;i++){
    const b=bindings[i], saved=recorded.bindings[i], file=project.files.find(f=>f.path===b?.path);
    if(!b||b.projectId!==project.id||!file||!Number.isSafeInteger(b.start)||!Number.isSafeInteger(b.end)||b.start<0||b.end<b.start||b.end>new TextDecoder('utf-8',{fatal:true}).decode(file.bytes).length||!Array.isArray(b.evidence)||b.evidence.some(e=>e.sourceSha256!==project.sourcePdfHash))invalid('INVALID_BINDINGS');
    const {projectId,...rest}=b;
    if(saved?.bindingScope!=='containing-project'||Object.hasOwn(saved,'projectId')||JSON.stringify({...rest,bindingScope:'containing-project'})!==JSON.stringify(saved))invalid('INVALID_BINDINGS');
  }
  return freeze({schema:'falsify.reconstruction-lineage.v1',projectId:project.id,sourcePdfHash:project.sourcePdfHash,baselinePdfHash:artifact.pdfHash,engine:project.engine,engineManifest:structuredClone(artifact.engineManifest),comparison:structuredClone(comparison),bindingProjectIds:bindings.map(()=>project.id),bindings:structuredClone(bindings),decisions:structuredClone(decisions)});
}
