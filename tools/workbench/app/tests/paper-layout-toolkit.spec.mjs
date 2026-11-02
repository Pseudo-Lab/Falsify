import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutToolCatalog,normalizeLayoutAction} from '../src/paper-layout-tool-catalog.mjs';
import {createLatexProject} from '../src/latex-project.mjs';
import {runPaperLayoutAgent} from '../src/paper-layout-agent.mjs';
import {renderLayoutRegion} from '../src/paper-layout-agent-ui.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
const enc=new TextEncoder(),dec=new TextDecoder();
const action=(tool,args={},message='')=>({tool,args,message});
const make=()=>createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('\\documentclass{article}\n\\begin{document}\nRED 71\n\\end{document}')}]});
const artifact=project=>{const pdfBytes=new Uint8Array([37,80,68,70,45,...enc.encode(project.id)]);return {schema:'falsify.latex-artifact.v1',success:true,projectId:project.id,engine:project.engine,pdfBytes,pdfHash:hex(pdfBytes)};};
const setup=(project,actions,extra={})=>({project,artifact:artifact(project),decide:async()=>actions.shift()||action('finish'),compile:async({project})=>artifact(project),inspect:async({artifact})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:artifact.pdfHash,issues:[],coverage:{pages:1}}),render:async()=>({images:[{pageIndex:0,mime:'image/png',base64:'iVBORw0KGgo='}],coverage:{pages:1}}),...extra});

test('tool catalog exposes typed arguments for all 23 tools and keeps legacy actions',()=>{
 assert.equal(layoutToolCatalog.length,23);assert.equal(new Set(layoutToolCatalog.map(t=>t.name)).size,23);
 assert.equal(normalizeLayoutAction(action('update_layout',{blockId:'a',leadingBp:14})).args.leadingBp,14);
 assert.equal(normalizeLayoutAction(action('update_layout',{blockId:'a',leadingBp:Infinity})),null);
 assert.equal(normalizeLayoutAction(action('update_layout',{blockId:'a',script:'rm'})),null);
 assert.equal(normalizeLayoutAction(action('render_region',{document:'candidate',pageIndex:0,bbox:[0,0,20,30]})).tool,'render_region');
 assert.equal(normalizeLayoutAction({tool:'read_source',path:'main.tex',before:'',after:'',pages:[2],message:''}).args.chunk,2);
});

test('typed tools receive the current source and captured RED baseline, then restore a paired revision',async()=>{
 const original=await make(),calls=[];let index=0;
 const actions=[action('checkpoint',{label:'before'}),action('update_layout',{blockId:'body',leadingBp:14}),action('get_block',{blockId:'body'}),action('compile_pdf'),action('compare_document'),action('restore_revision',{revisionId:'r1'}),action('inspect_pdf'),action('render_pages'),action('finish')];
 const result=await runPaperLayoutAgent(setup(original,actions,{handlers:{
  update_layout:async({project,args})=>{calls.push(args);return {project:await createLatexProject({...project,files:project.files.map(f=>({path:f.path,bytes:enc.encode(dec.decode(f.bytes)+'\n\\setlength{\\parskip}{2pt}')}))}),summary:{blockId:'body'}};},
  get_block:async({project,artifact})=>{assert.notEqual(project.id,original.id);assert.equal(artifact,null);return {observation:{text:'RED 71'}};},
  compare_document:async({project,artifact:currentArtifact,baselineProject,baselineArtifact})=>{assert.equal(baselineProject.id,original.id);assert.equal(baselineArtifact.pdfHash,artifact(original).pdfHash);assert.equal(currentArtifact.projectId,project.id);return {observation:{content:'same'}};}
 },decide:async input=>{assert.equal(input.protocol,'v2');if(index===1)assert.equal(input.execution.checkpoints[0].revisionId,'r1');return actions[index++];}}));
 assert.equal(result.status,'complete');assert.equal(result.project.id,original.id);assert.equal(calls.length,1);assert.equal(result.trace.find(t=>t.action==='restore_revision').result.status,'ok');
});

test('tool failures return an actionable observation and preserve the last PDF',async()=>{
 const original=await make(),actions=[action('update_layout',{blockId:'missing'}),action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')];
 const result=await runPaperLayoutAgent(setup(original,actions,{handlers:{update_layout:async()=>{throw Object.assign(new Error('Read the block list and choose an existing ID.'),{code:'BLOCK_NOT_FOUND'});}}}));
 assert.equal(result.status,'complete');assert.equal(result.trace[0].result.code,'BLOCK_NOT_FOUND');assert.equal(result.project.id,original.id);
});

test('restoring an uncompiled checkpoint returns that source and labels the previous PDF separately',async()=>{
 const p=await make();let n=0,restored;
 const actions=[action('update_layout',{blockId:'body',leadingBp:13}),action('checkpoint'),action('update_layout',{blockId:'body',leadingBp:14}),action('compile_pdf'),action('restore_revision',{revisionId:'r1'}),action('finish')];
 const out=await runPaperLayoutAgent(setup(p,actions,{handlers:{update_layout:async({project})=>{const next=await createLatexProject({...project,files:project.files.map(f=>({path:f.path,bytes:enc.encode(dec.decode(f.bytes)+'\n% layout '+(++n))}))});restored??=next;return {project:next,summary:{}};}}}));
 assert.equal(out.status,'unresolved');assert.equal(out.project.id,restored.id);assert.equal(out.artifact,null);assert.ok(out.previousCandidate.artifact.pdfBytes.length);assert.notEqual(out.previousCandidate.project.id,out.project.id);
});

test('all queued renders reach a decision and coverage records pages actually observed',async()=>{
 const p=await make();let step=0;const seen=[];
 const out=await runPaperLayoutAgent(setup(p,[],{reference:null,maxSteps:8,decide:async input=>{seen.push(...input.images.map(i=>i.pageIndex));return [action('compile_pdf'),action('inspect_pdf'),action('render_pages',{pages:[0,1,2,3]}),action('finish')][Math.min(step++,3)];},render:async()=>({images:[0,1,2,3].map(pageIndex=>({pageIndex,mime:'image/png',base64:'iVBORw0KGgo='})),coverage:{renderedPages:[0,1,2,3],totalPages:7}})}));
 assert.equal(out.status,'complete');assert.deepEqual([...new Set(seen)],[0,1,2,3]);assert.deepEqual(out.coverage.observedViews.map(v=>v.pageIndex),[0,1,2,3]);assert.equal(out.coverage.visualQualityVerified,false);
});

test('region rendering crops using PDF point coordinates and cleans up the document',async()=>{
 let request,closed=false;
 const loadPdf=async()=>({getDocument:()=>({promise:Promise.resolve({numPages:2,getPage:async()=>({getViewport:({scale})=>({width:300*scale,height:400*scale}),render:r=>{request=r;return {promise:Promise.resolve()};}})}),destroy:async()=>{closed=true;}})});
 const doc={createElement:()=>({getContext:()=>({}),toDataURL:()=> 'data:image/png;base64,iVBORw0KGgo='})};
 const result=await renderLayoutRegion({bytes:new Uint8Array([1]),args:{document:'candidate',pageIndex:1,bbox:[30,40,80,100],scale:2},loadPdf,doc});
 assert.deepEqual(request.transform,[1,0,0,1,-60,-80]);assert.deepEqual(result.images[0].bbox,[30,40,80,100]);assert.equal(result.images[0].document,'candidate');assert.equal(closed,true);
 await assert.rejects(renderLayoutRegion({bytes:new Uint8Array([1]),args:{document:'candidate',pageIndex:1,bbox:[0,0,999,100]},loadPdf,doc}),/영역/);
});
