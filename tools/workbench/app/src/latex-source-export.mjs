import {createLatexProject,exportLatexProject} from './latex-project.mjs';
import {applySourceChanges} from './latex-source-patches.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const hash=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function validLineage(l,sourceHash){return l?.schema==='falsify.reconstruction-lineage.v1'&&hash.test(l.projectId)&&l.sourcePdfHash===sourceHash&&hash.test(l.baselinePdfHash)&&l.comparison?.sourcePdfHash===sourceHash&&l.comparison?.baselinePdfHash===l.baselinePdfHash&&Array.isArray(l.bindings)&&Array.isArray(l.bindingProjectIds)&&l.bindings.length===l.bindingProjectIds.length&&l.bindings.every((b,i)=>b.projectId===l.projectId&&l.bindingProjectIds[i]===l.projectId);}
function descriptorId(d){if(d?.schema!=='falsify.latex-project-descriptor.v1'||!Array.isArray(d.files)||d.files.some(f=>typeof f.path!=='string'||!hash.test(f.sha256))||new Set(d.files.map(f=>f.path)).size!==d.files.length)return null;const files=d.files.map(({path,sha256})=>[path,sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return hex(encoder.encode(JSON.stringify({files,mainFile:d.mainFile,engine:d.engine,origin:d.origin})));}
function b64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
async function verified(p){
  if(p?.schema!=='falsify.latex-project.v1'||!hash.test(p.id)||!Array.isArray(p.files)||p.files.some(f=>!(f.bytes instanceof Uint8Array)||!hash.test(f.sha256)||hex(f.bytes)!==f.sha256))fail('INVALID_PROJECT');
  const copy=await createLatexProject(p);if(copy.id!==p.id)fail('INVALID_PROJECT');return copy;
}
/** Return a ZIP and its project. Reconstruction metadata refers to baseline bytes,
 * never to the edited/export project whose ID depends on the metadata itself. */
export async function prepareSourceExport({baselineProject,currentProject,changes,reconstruction=null}={}){
  const baseline=await verified(baselineProject),current=await verified(currentProject);
  if(!Array.isArray(changes))fail('INVALID_CHANGES');
  const enabled=changes.filter(c=>c.enabled!==false),result=await applySourceChanges(baseline,changes);
  if(result.diagnostics.length||result.project.id!==current.id||result.applied.length!==enabled.length||current.sourcePdfHash!==baseline.sourcePdfHash)fail('CHANGES_MISMATCH');
  if(baseline.origin!=='reconstructed-pdf')return {project:current,zip:await exportLatexProject(current)};
  if(!hash.test(baseline.sourcePdfHash))fail('INVALID_SOURCE_HASH');
  const file=baseline.files.find(f=>f.path==='falsify-reconstruction.json');let original;
  try {original=JSON.parse(decoder.decode(file.bytes));}catch{fail('INVALID_BASELINE_METADATA');}
  if(original?.schema!=='falsify.reconstruction-baseline.v1'||original.sourcePdfHash!==baseline.sourcePdfHash||!Array.isArray(original.bindings))fail('INVALID_BASELINE_METADATA');
  const baselineBindings=original.bindings.map(binding=>{
    const f=baseline.files.find(x=>x.path===binding?.path);
    if(binding?.bindingScope!=='containing-project'||Object.hasOwn(binding,'projectId')||!f||!/\.(tex|bib)$/i.test(f.path)||!Number.isSafeInteger(binding.start)||!Number.isSafeInteger(binding.end)||binding.start<0||binding.end<binding.start||binding.end>decoder.decode(f.bytes).length||!Array.isArray(binding.evidence)||binding.evidence.some(e=>e.sourceSha256!==baseline.sourcePdfHash))fail('INVALID_BASELINE_BINDING');
    const {bindingScope,...rest}=binding;return {...rest,projectId:baseline.id};
  });
  let baselinePdfHash=null,state='uncompared',history=null;
  if(reconstruction!==null){
    if(reconstruction?.schema==='falsify.reconstruction-lineage.v1'){
      if(!validLineage(reconstruction,baseline.sourcePdfHash)||reconstruction.projectId!==baseline.id||stable(reconstruction.bindings)!==stable(baselineBindings)||stable(reconstruction.decisions)!==stable(original.decisions))fail('INVALID_RECONSTRUCTION');
      baselinePdfHash=reconstruction.baselinePdfHash;state='compared-baseline';history=structuredClone(reconstruction);
    } else if(reconstruction?.schema==='falsify.reconstruction-pending.v1'){
      const prev=reconstruction.previousProject;
      if(reconstruction.sourcePdfHash!==baseline.sourcePdfHash||reconstruction.reason!=='files-added'||!validLineage(reconstruction.previous,baseline.sourcePdfHash)||prev?.id!==reconstruction.previous.projectId||descriptorId(prev)!==prev.id||prev.sourcePdfHash!==baseline.sourcePdfHash||prev.origin!==baseline.origin||prev.engine!==baseline.engine||prev.mainFile!==baseline.mainFile||prev.files.some(f=>!baseline.files.some(b=>b.path===f.path&&b.sha256===f.sha256)))fail('INVALID_RECONSTRUCTION');
      state='pending';history=structuredClone(reconstruction);
    } else fail('INVALID_RECONSTRUCTION');
  }
  const metadata={schema:'falsify.reconstruction-source-export.v1',sourcePdfHash:baseline.sourcePdfHash,baselineProjectId:baseline.id,baselinePdfHash,baselineStatus:state,baselineProject:{mainFile:baseline.mainFile,engine:baseline.engine,origin:baseline.origin,files:baseline.files.map(({path,sha256})=>({path,sha256}))},baselineSourceFiles:baseline.files.filter(f=>/\.(tex|bib)$/i.test(f.path)).map(f=>({path:f.path,sha256:f.sha256,encoding:'base64',bytes:b64(f.bytes)})),baselineBindings,baselineMetadata:{...original,bindings:baselineBindings},sourceChanges:structuredClone(changes),reconstruction:history};
  // Old metadata also says containing-project; preserve it only as baseline evidence.
  // Its scope is explicitly resolved by baselineProjectId above.
  const files=current.files.map(f=>({path:f.path,bytes:f.path==='falsify-reconstruction.json'?encoder.encode(JSON.stringify(metadata)):f.bytes.slice()}));
  const project=await createLatexProject({...current,files});
  return {project,zip:await exportLatexProject(project)};
}
