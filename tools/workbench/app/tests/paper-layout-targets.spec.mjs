import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {analyzeLatexSource} from '../src/latex-source-model.mjs';
import {updateBlockLayout} from '../src/paper-layout-edit-tools.mjs';
import {createReconstructionProject} from '../src/pdf-latex-baseline.mjs';
import {readLayoutStructure} from '../src/paper-layout-structure.mjs';
import {createLayoutTargetRegistry,LAYOUT_TARGETS_SCHEMA} from '../src/paper-layout-targets.mjs';

const enc=new TextEncoder(),dec=new TextDecoder();
const doc=body=>`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const make=(files,opts={})=>createLatexProject({mainFile:'main.tex',...opts,files:Object.entries(files).map(([path,text])=>({path,bytes:enc.encode(text)}))});
const nodes=p=>analyzeLatexSource(p).nodes;
const nodeWith=(p,text,{path,index=0}={})=>nodes(p).filter(n=>n.text.trim()===text&&(!path||n.path===path))[index];
const source=(p,path='main.tex')=>dec.decode(p.files.find(f=>f.path===path).bytes);
const edit=async(p,blockId,args={gapBeforeBp:8,gapAfterBp:6})=>(await updateBlockLayout({project:p,args:{blockId,...args}})).project;

test('B keeps its target after typed spacing changes to A without another document listing',async()=>{
 const p0=await make({'main.tex':doc('Alpha paragraph one.\n\nBeta paragraph two.\n\nGamma three.')});
 const reg=createLayoutTargetRegistry(p0);
 const a=reg.describe(p0,{id:nodeWith(p0,'Alpha paragraph one.').id,kind:'text',textPreview:'Alpha'});
 const b=reg.describe(p0,{id:nodeWith(p0,'Beta paragraph two.').id,kind:'text',extra:{keep:true}});
 assert.match(b.targetId,/^lt1_[a-f0-9]{64}$/);assert.equal(b.id,b.targetId);assert.equal(b.extra.keep,true);assert.equal(b.kind,'text');
 assert.equal(b.sourceBlockId,nodeWith(p0,'Beta paragraph two.').id);
 assert.equal(reg.describe(p0,{id:b.sourceBlockId}).targetId,b.targetId,'describing the same node twice is stable');
 // Typed mutation through the stable ID: resolve first, then edit the raw ID.
 const ra=reg.resolve(p0,a.targetId);assert.equal(ra.status,'matched');
 const p1=await edit(p0,ra.blockId);assert.notEqual(p1.id,p0.id);assert.match(source(p1),/vspace\*\{8bp\}/);
 assert.equal(reg.resolve(p1,b.targetId).reason,'PROJECT_NOT_CURRENT');
 assert.deepEqual(reg.rebase(p0,p1),{projectId:p1.id,matched:2,ambiguous:0,missing:0});
 const rb=reg.resolve(p1,b.targetId);assert.equal(rb.status,'matched');assert.deepEqual(rb.candidates,[rb.blockId]);
 assert.notEqual(rb.blockId,b.sourceBlockId,'raw node IDs still change with the project');
 assert.equal(rb.blockId,nodeWith(p1,'Beta paragraph two.').id);
 // The edited block itself is still uniquely justified inside the changed region.
 assert.equal(reg.resolve(p1,a.targetId).blockId,nodeWith(p1,'Alpha paragraph one.').id);
 // A second typed change to B via its old target ID.
 const p2=await edit(p1,rb.blockId,{gapAfterBp:12});reg.rebase(p1,p2);
 assert.match(source(p2),/Beta paragraph two\.[\s\S]*vspace\*\{12bp\}/);
 assert.equal(reg.resolve(p2,b.targetId).blockId,nodeWith(p2,'Beta paragraph two.').id);
 assert.equal(reg.resolve(p2,a.targetId).blockId,nodeWith(p2,'Alpha paragraph one.').id);
});

test('unchanged B survives insertions before it and stale raw IDs do not pass through',async()=>{
 const p0=await make({'main.tex':doc('Alpha.\n\nBeta stays.')});const reg=createLayoutTargetRegistry(p0);
 const b=reg.describe(p0,{id:nodeWith(p0,'Beta stays.').id});
 const p1=await make({'main.tex':doc('Inserted first.\n\nAlpha.\n\nMore inserted.\n\nBeta stays.')});
 reg.rebase(p0,p1);const r=reg.resolve(p1,b.targetId);
 assert.equal(r.status,'matched');assert.equal(r.blockId,nodeWith(p1,'Beta stays.').id);
 assert.deepEqual(reg.resolve(p1,b.sourceBlockId),{status:'missing',candidates:[],reason:'NOT_IN_CURRENT_PROJECT'});
 const raw=nodeWith(p1,'Inserted first.').id;assert.deepEqual(reg.resolve(p1,raw),{status:'matched',blockId:raw,candidates:[raw]});
 assert.equal(reg.resolve(p1,'unknown').status,'missing');
});

test('repeated paragraphs keep distinct targets and ambiguous moves are reported',async()=>{
 const p0=await make({'main.tex':doc('Alpha.\n\nSame words.\n\nSame words.\n\nOmega.')});const reg=createLayoutTargetRegistry(p0);
 const first=reg.describe(p0,{id:nodeWith(p0,'Same words.',{index:0}).id}),second=reg.describe(p0,{id:nodeWith(p0,'Same words.',{index:1}).id});
 assert.notEqual(first.targetId,second.targetId);
 // Edit the first repeated paragraph; both remain exactly justified.
 const p1=await edit(p0,reg.resolve(p0,first.targetId).blockId);reg.rebase(p0,p1);
 const r1=reg.resolve(p1,first.targetId),r2=reg.resolve(p1,second.targetId);
 assert.equal(r1.status,'matched');assert.equal(r2.status,'matched');
 assert.equal(r1.blockId,nodeWith(p1,'Same words.',{index:0}).id);assert.equal(r2.blockId,nodeWith(p1,'Same words.',{index:1}).id);
 // Inserting another identical paragraph next to them cannot be attributed uniquely.
 const text=source(p1).replace('Omega.','Same words.\n\nOmega.');
 const p2=await make({'main.tex':text});const s=reg.rebase(p1,p2);
 const r3=reg.resolve(p2,second.targetId);assert.equal(r3.status,'ambiguous');assert.ok(r3.candidates.length>=2);
 for(const id of r3.candidates)assert.equal(nodes(p2).find(n=>n.id===id).text.trim(),'Same words.');
 assert.equal(s.ambiguous>=1,true);
 // Ambiguity is never upgraded to a match later.
 const p3=await make({'main.tex':text.replace('Alpha.','Alpha!')});reg.rebase(p2,p3);assert.equal(reg.resolve(p3,second.targetId).status,'ambiguous');
});

test('deleted or rewritten targets are missing rather than fuzzily matched',async()=>{
 const p0=await make({'main.tex':doc('Keep me.\n\nDelete me please.\n\nRewrite this sentence.')});const reg=createLayoutTargetRegistry(p0);
 const del=reg.describe(p0,{id:nodeWith(p0,'Delete me please.').id}),rew=reg.describe(p0,{id:nodeWith(p0,'Rewrite this sentence.').id}),keep=reg.describe(p0,{id:nodeWith(p0,'Keep me.').id});
 const p1=await make({'main.tex':doc('Keep me.\n\nRewrite this sentence!')});const s=reg.rebase(p0,p1);
 assert.deepEqual(reg.resolve(p1,del.targetId),{status:'missing',candidates:[],reason:'TARGET_MISSING'});
 assert.equal(reg.resolve(p1,rew.targetId).status,'missing');
 assert.equal(reg.resolve(p1,keep.targetId).status,'matched');
 assert.deepEqual([s.matched,s.missing],[1,2]);
});

test('paths are never crossed even when text is identical',async()=>{
 const p0=await make({'main.tex':'\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\input{b}\n\\end{document}\n','a.tex':'Shared sentence.\n','b.tex':'Shared sentence.\n'});
 const reg=createLayoutTargetRegistry(p0);
 const a=reg.describe(p0,{id:nodeWith(p0,'Shared sentence.',{path:'a.tex'}).id}),b=reg.describe(p0,{id:nodeWith(p0,'Shared sentence.',{path:'b.tex'}).id});
 const p1=await edit(p0,reg.resolve(p0,a.targetId).blockId);reg.rebase(p0,p1);
 assert.equal(nodes(p1).find(n=>n.id===reg.resolve(p1,b.targetId).blockId).path,'b.tex');
 assert.equal(nodes(p1).find(n=>n.id===reg.resolve(p1,a.targetId).blockId).path,'a.tex');
 // Renaming a file loses the target; similar text in another path is not used.
 const p2=await createLatexProject({mainFile:'main.tex',files:p1.files.map(f=>({path:f.path==='a.tex'?'c.tex':f.path,bytes:f.bytes}))});reg.rebase(p1,p2);
 assert.equal(reg.resolve(p2,a.targetId).status,'missing');assert.equal(reg.resolve(p2,b.targetId).status,'matched');
});

test('wrong baseline, origin and lineage are refused',async()=>{
 const p0=await make({'main.tex':doc('Alpha.\n\nBeta.')});const reg=createLayoutTargetRegistry(p0);
 const b=reg.describe(p0,{id:nodeWith(p0,'Beta.').id});
 const other=await make({'main.tex':doc('Alpha.\n\nBeta.')},{engine:'lualatex'});
 assert.deepEqual(reg.resolve(other,b.targetId),{status:'missing',candidates:[],reason:'LINEAGE_MISMATCH'});
 assert.throws(()=>reg.describe(other,{id:nodeWith(other,'Beta.').id}),{code:'LINEAGE_MISMATCH'});
 assert.throws(()=>reg.rebase(other,p0),{code:'LINEAGE_MISMATCH'});assert.throws(()=>reg.rebase(p0,other),{code:'LINEAGE_MISMATCH'});
 // Same origin, unrelated content: not the current project.
 const unrelated=await make({'main.tex':doc('Something else.\n\nBeta.')});
 assert.equal(reg.resolve(unrelated,b.targetId).reason,'PROJECT_NOT_CURRENT');assert.throws(()=>reg.rebase(unrelated,p0),{code:'PROJECT_NOT_CURRENT'});
 // A registry with another baseline does not know this lineage's target IDs.
 const reg2=createLayoutTargetRegistry(unrelated);assert.equal(reg2.resolve(unrelated,b.targetId).status,'missing');
 const twin=createLayoutTargetRegistry(p0);assert.equal(twin.describe(p0,{id:b.sourceBlockId}).targetId,b.targetId,'IDs are deterministic within one lineage');
 // Tampered project bytes are refused.
 const tampered={...p0,files:p0.files.map(f=>({...f,bytes:enc.encode('x')}))};assert.throws(()=>reg.resolve(tampered,b.targetId),{code:'STALE_PROJECT'});
 assert.throws(()=>reg.describe(p0,{id:'not-a-node'}),{code:'BLOCK_NOT_FOUND'});
});

test('reconstructed layout units keep their real stable IDs across updateBlockLayout',async()=>{
 const hash='a'.repeat(64),ev=bbox=>({sourceSha256:hash,pageIndex:0,frame:'mupdf-display',bbox});
 const model={schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:600,height:800,frame:'mupdf-display'}],items:['a','b'].map((id,n)=>({id,kind:'paragraph',status:'observed',evidence:[ev([40,100+n*80,550,160+n*80])],text:n?'Unaffected 42':'Selected RED 123'})),assets:[],relations:[],diagnostics:[]};
 const p0=(await createReconstructionProject({sourceSha256:hash,model},[],{layout:'semantic-flow'})).project;
 const reg=createLayoutTargetRegistry(p0);
 const ua=reg.describe(p0,{id:'a',role:'body'}),ub=reg.describe(p0,{id:'b'});
 assert.deepEqual([ua.id,ua.targetId,ua.sourceBlockId,ua.role],['a','a','a','body']);
 const p1=(await updateBlockLayout({project:p0,args:{blockId:reg.resolve(p0,ua.targetId).blockId,gapBeforeBp:5}})).project;reg.rebase(p0,p1);
 assert.deepEqual(reg.resolve(p1,ub.targetId),{status:'matched',blockId:'b',candidates:['b']});
 assert.equal(readLayoutStructure(p1).units.length,2);
 // A raw source node inside a unit still gets a lineage target that follows the edit.
 const t=reg.describe(p1,{id:nodeWith(p1,'Unaffected 42').id});
 const p2=(await updateBlockLayout({project:p1,args:{blockId:'a',gapAfterBp:3}})).project;reg.rebase(p1,p2);
 assert.equal(reg.resolve(p2,t.targetId).blockId,nodeWith(p2,'Unaffected 42').id);
});

test('metadata restoration is validated explicitly',async()=>{
 const p0=await make({'main.tex':doc('Alpha.\n\nBeta restored.')});const reg=createLayoutTargetRegistry(p0);
 const a=reg.describe(p0,{id:nodeWith(p0,'Alpha.').id}),b=reg.describe(p0,{id:nodeWith(p0,'Beta restored.').id});
 const p1=await edit(p0,reg.resolve(p0,a.targetId).blockId);reg.rebase(p0,p1);
 const meta=JSON.parse(JSON.stringify(reg.serialize()));assert.equal(meta.schema,LAYOUT_TARGETS_SCHEMA);assert.equal(meta.lineage.revisions,1);
 const restored=createLayoutTargetRegistry(p1,meta);assert.equal(restored.resolve(p1,b.targetId).blockId,nodeWith(p1,'Beta restored.').id);
 assert.equal(createLayoutTargetRegistry(p1,JSON.stringify(meta)).resolve(p1,a.targetId).status,'matched');
 // Restoration continues to track further typed changes.
 const p2=await edit(p1,restored.resolve(p1,b.targetId).blockId,{gapAfterBp:2});restored.rebase(p1,p2);assert.equal(restored.resolve(p2,b.targetId).blockId,nodeWith(p2,'Beta restored.').id);
 const bad=(m,label)=>assert.throws(()=>createLayoutTargetRegistry(p1,m),{code:'INVALID_TARGET_METADATA'},label);
 assert.throws(()=>createLayoutTargetRegistry(undefined,meta),{code:'INVALID_TARGET_METADATA'});
 assert.throws(()=>createLayoutTargetRegistry(p0,meta),{code:'INVALID_TARGET_METADATA'},'wrong project');
 const clone=()=>JSON.parse(JSON.stringify(meta));
 let m=clone();m.schema='x';bad(m,'schema');
 m=clone();m.targets[1].range.start+=1;bad(m,'range');
 m=clone();m.targets[1].sourceTextSha256='0'.repeat(64);bad(m,'content');
 m=clone();m.targets[1].targetId='lt1_'+'0'.repeat(64);bad(m,'id');
 m=clone();m.lineage.baselineProjectId='0'.repeat(64);bad(m,'baseline');
 m=clone();m.targets[1].path='other.tex';bad(m,'path');
 m=clone();m.lineage.engine='xelatex';bad(m,'origin');
 bad('{not json','json');
 // The registry instance is untouched by a failed restore of another instance.
 assert.equal(reg.resolve(p1,b.targetId).status,'matched');
});
