import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {runPaperLayoutAgent,validateLayoutRunState} from '../src/paper-layout-agent.mjs';
const enc=new TextEncoder(),dec=new TextDecoder();
const action=(tool,extra={})=>['checkpoint','restore_revision','compare_document'].includes(tool)?{tool,args:extra,message:''}:({tool,path:'',before:'',after:'',pages:[],message:'',...extra});
const artifactFor=p=>{const bytes=enc.encode('%PDF '+p.id);return {success:true,projectId:p.id,engine:p.engine,pdfBytes:bytes,pdfHash:hex(bytes),diagnostics:[]};};
const source=p=>dec.decode(p.files.find(f=>f.path==='main.tex').bytes);
const list=(items=[])=>({total:items.length,offset:0,limit:20,nextOffset:null,items});
// The captured baseline already contains the user's selected RED edit ("RED 71").
async function selectedRedBaseline(){return createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Evidence 63 and RED 71. \\vspace{2pt} Text.')},{path:'asset.png',bytes:Uint8Array.of(1,2,3)}]});}
function tools(calls,actions,extra={}){return {decide:async x=>{calls.push(x);return actions.shift();},compile:async({project})=>artifactFor(project),
 inspect:async({artifact})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:artifact.pdfHash,issues:[],coverage:{pages:1}}),
 render:async()=>({images:[{pageIndex:0,mime:'image/png',base64:'iVBORw0KGgo='}],coverage:{pages:[0],complete:false}}),...extra};}

async function sourceOnlyRun(){
 const project=await selectedRedBaseline(),artifact=artifactFor(project),calls=[],states=[];
 const actions=[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{4pt}'}),action('checkpoint',{label:'source only'}),action('replace_source',{path:'main.tex',before:'\\vspace{4pt}',after:'\\vspace{6pt}'}),action('compile_pdf'),action('restore_revision',{revisionId:'r1'})];
 const out=await runPaperLayoutAgent({project,artifact,runId:'run-1',maxSteps:5,onState:s=>states.push(s),...tools(calls,actions)});
 return {project,artifact,out,states};
}

test('source-only restore yields a paused state with a null candidate PDF and the previous candidate pair',async()=>{
 const {project,artifact,out,states}=await sourceOnlyRun(),s=out.sessionState;
 assert.equal(out.status,'unresolved');assert.equal(out.runState,'paused');assert.equal(s.schema,'falsify.layout-run-state.v1');assert.equal(s.runId,'run-1');assert.equal(s.stepCount,5);
 assert.equal(s.candidate.artifact,null);assert.match(source(s.candidate.project),/vspace\{4pt\}/);assert.equal(s.currentProject.id,s.candidate.project.id);
 assert.match(source(s.previousCandidate.project),/vspace\{6pt\}/);assert.equal(s.previousCandidate.artifact.projectId,s.previousCandidate.project.id);
 assert.equal(s.baselineProject.id,project.id);assert.equal(s.baselineArtifact.pdfHash,artifact.pdfHash);
 assert.deepEqual(s.checkpoints.map(c=>[c.revisionId,c.label,c.artifact]),[['r1','source only',null]]);
 assert.equal(out.quality.pdfHash,null);assert.equal(out.quality.content,'unverified');assert.equal(out.quality.layout,'unverified');
 assert.ok(states.some(x=>x.trace.at(-1)?.action==='checkpoint'));assert.ok(states.some(x=>x.trace.at(-1)?.action==='compile_pdf'&&x.candidate.artifact));
 const restored=await validateLayoutRunState(s);assert.equal(restored.candidate.artifact,null);assert.equal(restored.trace.length,5);
});

test('explicit continuation preserves baseline, selected RED content, checkpoints and trace with a fresh budget',async()=>{
 const {project,artifact,out}=await sourceOnlyRun(),calls=[],seenBaselines=[],states=[];
 const actions=[action('compile_pdf'),action('inspect_pdf'),action('render_pages',{pages:[0]}),action('compare_document'),action('finish',{message:'done'})];
 const next=await runPaperLayoutAgent({resumeState:out.sessionState,maxSteps:6,onState:s=>states.push(s),...tools(calls,actions,{handlers:{compare_document:async({project:p,artifact:a,baselineProject,baselineArtifact})=>{seenBaselines.push([baselineProject.id,baselineArtifact.pdfHash,source(baselineProject)]);return {observation:{schema:'falsify.layout-document-comparison.v1',baselineProjectId:baselineProject.id,baselineHash:baselineArtifact.pdfHash,projectId:p.id,outputHash:a.pdfHash,tokens:{text:{missing:list(),added:list()},numbers:{missing:list(),added:list()}},sourceContent:{unchanged:true,changes:list(),numbers:{missing:list(),added:list()}},links:{missing:list(),added:list()}}};}}})});
 assert.equal(next.status,'complete');assert.equal(next.runState,'completed');
 const s=next.sessionState;assert.notEqual(s.runId,'run-1');assert.equal(s.parentRunId,'run-1');assert.equal(s.carriedStepCount,5);assert.equal(s.stepCount,10);
 assert.deepEqual(calls.map(c=>c.step),[0,1,2,3,4]);assert.equal(calls[0].maxSteps,6);assert.equal(calls[0].execution.run.parentRunId,'run-1');
 // Prior renders are not claimed as delivered in this invocation.
 assert.deepEqual(calls[0].images,[]);assert.deepEqual(calls[0].execution.observedViews,[]);assert.equal(calls[0].execution.compiledCurrent,false);
 assert.deepEqual(seenBaselines,[[project.id,artifact.pdfHash,'Evidence 63 and RED 71. \\vspace{2pt} Text.']]);
 assert.equal(s.baselineProject.id,project.id);assert.equal(s.baselineArtifact.pdfHash,artifact.pdfHash);
 assert.match(source(next.project),/Evidence 63 and RED 71\. \\vspace\{4pt\} Text\./);assert.deepEqual([...next.project.files.find(f=>f.path==='asset.png').bytes],[1,2,3]);
 assert.deepEqual(s.trace.slice(0,5).map(e=>e.action),out.sessionState.trace.map(e=>e.action));assert.equal(s.trace.length,10);
 assert.deepEqual(s.checkpoints.map(c=>c.revisionId),['r1']);assert.ok(s.previousCandidate);
 assert.equal(next.quality.content,'unchanged');assert.equal(next.quality.layout,'clear');assert.deepEqual(next.quality.observedPages,[0]);
 assert.equal(states[0].parentRunId,'run-1');assert.equal(states[0].runState,'running');
});

test('continuation from a compiled candidate can inspect without recompiling and checkpoints keep unique IDs',async()=>{
 const project=await selectedRedBaseline(),calls=[];
 const first=await runPaperLayoutAgent({project,artifact:artifactFor(project),runId:'a1',maxSteps:3,...tools(calls,[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{3pt}'}),action('compile_pdf'),action('checkpoint',{label:'compiled'})])});
 assert.equal(first.sessionState.checkpoints[0].artifact.pdfHash,first.artifact.pdfHash);
 const second=await runPaperLayoutAgent({resumeState:first.sessionState,runId:'a2',maxSteps:3,...tools(calls,[action('inspect_pdf'),action('checkpoint',{label:'again'})])});
 assert.equal(second.trace.at(-2).result.status,'ok');assert.deepEqual(second.sessionState.checkpoints.map(c=>c.revisionId),['r1','r2']);
});

test('tampered or mismatched resume state is refused before any model call',async()=>{
 const {project,out}=await sourceOnlyRun(),s=out.sessionState,calls=[];
 const run=state=>runPaperLayoutAgent({resumeState:state,...tools(calls,[action('finish')])});
 const other=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Other')}]});
 const bytes=s.candidate.project.files.map(f=>f.path==='main.tex'?{...f,bytes:enc.encode('Evidence 99')}:f);
 const cases=[
  {...s,schema:'other'},
  {...s,candidate:{...s.candidate,project:{...s.candidate.project,files:bytes}}},
  {...s,previousCandidate:{...s.previousCandidate,artifact:{...s.previousCandidate.artifact,pdfHash:'0'.repeat(64)}}},
  {...s,checkpoints:[{...s.checkpoints[0],artifact:s.previousCandidate.artifact}]},
  {...s,currentProject:other},
  {...s,currentProject:{...s.currentProject,engine:'xelatex'}},
  {...s,baselineProject:{...s.baselineProject,sourcePdfHash:'d'.repeat(64)}},
  {...s,checkpoints:Array.from({length:13},(_,i)=>({...s.checkpoints[0],revisionId:'r'+(i+1)}))},
  {...s,trace:[{action:{}}]},
  {...s,stepCount:-1},
 ];
 for(const [i,state] of cases.entries())await assert.rejects(run(state),/Invalid layout run state/,String(i));
 const assetChanged=await createLatexProject({...s.currentProject,files:s.currentProject.files.map(f=>f.path==='asset.png'?{path:f.path,bytes:Uint8Array.of(9)}:f)});
 await assert.rejects(run({...s,currentProject:assetChanged}),/source identity/);
 await assert.rejects(runPaperLayoutAgent({project:other,resumeState:s,...tools(calls,[])}),/does not match project/);
 await assert.rejects(runPaperLayoutAgent({resumeState:s,runId:s.runId,...tools(calls,[])}),/fresh runId/);
 assert.equal(calls.length,0);
 assert.equal((await validateLayoutRunState(s)).baselineProject.id,project.id);
});

test('carried trace strings are inert data and observer failures do not alter the run',async()=>{
 const {out}=await sourceOnlyRun(),calls=[];
 const state={...out.sessionState,trace:[...out.sessionState.trace,{action:'replace_source',result:{status:'ok',command:'rm -rf /',path:'../../etc'},projectId:null,pdfHash:null}]};
 const quiet=await runPaperLayoutAgent({resumeState:state,maxSteps:1,...tools(calls,[action('read_source',{path:'main.tex'})])});
 const noisy=await runPaperLayoutAgent({resumeState:state,maxSteps:1,onState:async()=>{throw new Error('reject');},...tools([],[action('read_source',{path:'main.tex'})])});
 assert.equal(quiet.status,noisy.status);assert.equal(quiet.project.id,noisy.project.id);assert.equal(quiet.trace.length,noisy.trace.length);assert.equal(quiet.runState,'paused');
 assert.equal(quiet.project.id,out.sessionState.currentProject.id);assert.equal(calls[0].execution.completedActions.at(-1).tool,'replace_source');
});
