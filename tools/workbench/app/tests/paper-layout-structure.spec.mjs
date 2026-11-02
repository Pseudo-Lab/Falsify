import test from 'node:test';
import assert from 'node:assert/strict';
import {createReconstructionProject} from '../src/pdf-latex-baseline.mjs';
import {createLatexProject} from '../src/latex-project.mjs';
import {readLayoutStructure,applyLayoutStructure,renderStructureRegion} from '../src/paper-layout-structure.mjs';
const hash='a'.repeat(64),enc=new TextEncoder(),dec=new TextDecoder();
const ev=bbox=>({sourceSha256:hash,pageIndex:0,frame:'mupdf-display',bbox});
const item=(id,kind,bbox,text)=>({id,kind,status:'observed',evidence:[ev(bbox)],text,extensions:{columns:2,span:'column'}});
const model={schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:600,height:800,frame:'mupdf-display',extensions:{layoutHints:{columns:2,gutterBp:[290,310],status:'proposed',provenance:'paper-flow'}}}],items:[item('title','heading',[40,80,520,100],'Title'),item('author','paragraph',[40,120,480,135],'A. Author'),item('abstract','paragraph',[40,150,520,220],'Abstract text'),item('left','paragraph',[40,260,280,350],'Left 123'),item('right','paragraph',[320,260,560,350],'Right 456')],assets:[],relations:[],diagnostics:[]};
const make=async(testModel=model)=> (await createReconstructionProject({sourceSha256:hash,model:testModel},[],{layout:'semantic-flow',profile:{schema:'falsify.paper-typography.v1',page:{widthBp:600,heightBp:800,columns:2,gutterBp:20,margins:{left:40,right:40,top:36,bottom:36}},body:{indentEm:1,paragraphGapEm:0},roles:Object.fromEntries(['body','heading','caption','footnote'].map(x=>[x,{sizeBp:10,leadingBp:12}])),fonts:{serif:'Latin Modern Roman'},packages:{}}})).project;
const source=p=>dec.decode(p.files.find(f=>f.path==='main.tex').bytes);
test('moving a native footnote to footer keeps its own reservation instead of a shipout parbox',async()=>{
 const m=structuredClone(model),foot=item('note','paragraph',[40,720,270,735],'* Contact author.');foot.extensions={...foot.extensions,publicationRole:'footnote',typography:{fontSizeBp:8}};m.items.push(foot);
 const p=await make(m),s=readLayoutStructure(p),plan={...s.plan,furniture:[...s.plan.furniture,{id:'note',placement:'footer'}]};
 const out=(await applyLayoutStructure({project:p,plan})).project,tex=source(out);
 assert.equal((tex.match(/\\footnotetext\{/g)||[]).length,1);assert.doesNotMatch(tex,/FalsifyFurniture6e6f7465/);assert.doesNotMatch(tex,/\\enlargethispage/);
 assert.deepEqual(readLayoutStructure(out).plan,plan);assert.match(tex,/\* Contact author\./);
});
test('source geometry forms front matter and current edited unit survives relocation',async()=>{
 let p=await make(),s=readLayoutStructure(p);assert.deepEqual(s.plan.frontMatter,['title','author','abstract']);assert.match(source(p),/\\twocolumn\[\{/);
 const files=p.files.map(f=>({path:f.path,bytes:f.path==='main.tex'?enc.encode(source(p).replace('Left 123','Edited RED 123')):f.bytes}));p=await createLatexProject({...p,files});s=readLayoutStructure(p);
 const plan={...s.plan,order:['title','author','abstract','right','left']};const result=await applyLayoutStructure({project:p,plan});assert.match(source(result.project),/Edited RED 123/);assert.ok(source(result.project).indexOf('Right 456')<source(result.project).indexOf('Edited RED 123'));assert.deepEqual(readLayoutStructure(result.project).plan,plan);
 const metadata=JSON.parse(dec.decode(result.project.files.find(f=>f.path==='falsify-reconstruction.json').bytes));const binding=metadata.bindings.find(b=>b.itemId==='left');assert.match(source(result.project).slice(binding.start,binding.end),/Edited RED 123/);assert.equal(binding.scope,'layout-unit');assert.ok(metadata.baselineBindings.length>0);
});
test('omissions, duplicate IDs, stale source, injection and separated figure groups are rejected',async()=>{
 const p=await make(),s=readLayoutStructure(p),base=s.plan;for(const order of [base.order.slice(1),[...base.order.slice(0,-1),base.order[0]], [...base.order.slice(0,-1),'unknown']])await assert.rejects(applyLayoutStructure({project:p,plan:{...base,order}}),{code:'INVALID_PLAN'});
 await assert.rejects(applyLayoutStructure({project:p,plan:{...base,sourcePdfHash:'b'.repeat(64)}}),{code:'INVALID_PLAN'});
 const files=p.files.map(f=>({path:f.path,bytes:f.path==='main.tex'?enc.encode(source(p).replace('% FALSIFY-LAYOUT-END','injected\n% FALSIFY-LAYOUT-END')):f.bytes}));const changed=await createLatexProject({...p,files});assert.throws(()=>readLayoutStructure(changed),{code:'INVALID_MARKERS'});
});
test('figure/caption groups cannot be split and furniture remains a bounded source unit',async()=>{
 const p=await make();const metadata=JSON.parse(dec.decode(p.files.find(f=>f.path==='falsify-layout-structure.json').bytes));metadata.groups=[['left','right']];const files=p.files.map(f=>({path:f.path,bytes:f.path==='falsify-layout-structure.json'?enc.encode(JSON.stringify(metadata)):f.bytes}));const grouped=await createLatexProject({...p,files});
 await assert.rejects(applyLayoutStructure({project:grouped,plan:{...metadata.plan,order:['title','author','abstract','right','left']}}),{code:'GROUP_SEPARATED'});
 await assert.rejects(applyLayoutStructure({project:grouped,plan:{...metadata.plan,frontMatter:metadata.plan.order}}),{code:'GROUP_SEPARATED'});
 const result=await applyLayoutStructure({project:p,plan:{...readLayoutStructure(p).plan,furniture:[{id:'left',placement:'header'}]}});assert.match(source(result.project),/\\AddToHook\{shipout\/foreground\}/);assert.match(source(result.project),/Left 123/);assert.equal(readLayoutStructure(result.project).plan.furniture[0].id,'left');
});

test('running header templates retain source payloads without blank trailing pages',()=>{
 const units=[0,1].map(n=>({id:'header'+n,pageIndex:n,pageHeight:800,bbox:[40,20,180,30],kind:'furniture'}));units.push({id:'body',pageIndex:0,pageHeight:800,bbox:[40,70,550,700],kind:'paragraph'});
 const plan={schema:'falsify.paper-layout-plan.v1',sourcePdfHash:hash,order:units.map(u=>u.id),frontMatter:[],furniture:units.slice(0,2).map(u=>({id:u.id,placement:'header'})),columns:1};const s={schema:'falsify.paper-layout-structure.v1',sourcePdfHash:hash,units,groups:[],plan};
 const result=renderStructureRegion(s,plan,new Map([['header0','Journal header\\par\n'],['header1','Journal header\\par\n'],['body','Evidence 63\\par\n% FALSIFY-UNIT-existing source comment\n']]));
 assert.equal((result.text.match(/Journal header/g)||[]).length,2);assert.equal((result.text.match(/AddToHook/g)||[]).length,1);assert.doesNotMatch(result.text,/\\null\\newpage/);assert.match(result.text,/% FALSIFY-UNIT-existing source comment/);
});

test('moving a first-column footnote into footer reserves local body space without rewriting units',async()=>{
 const m=structuredClone(model);m.items.push(item('correspondence','paragraph',[40,740,280,754],'Correspondence to A. Author'));
 const p=await make(m),s=readLayoutStructure(p),plan={...s.plan,furniture:[{id:'correspondence',placement:'footer'}]};
 assert.doesNotMatch(source(p),/\\enlargethispage/);
 const out=await applyLayoutStructure({project:p,plan}),n=readLayoutStructure(out.project);
 assert.deepEqual(n.bodyReservations,[{pageIndex:0,column:'left',deltaBp:42}]);
 assert.match(source(out.project),/\\enlargethispage\{-42bp\}/);
 const contents=text=>[...text.matchAll(/% FALSIFY-UNIT-BEGIN ([a-f0-9]+)\n([\s\S]*?)% FALSIFY-UNIT-END \1\n/g)].map(m=>[m[1],m[2]]).sort((a,b)=>a[0].localeCompare(b[0]));
 assert.deepEqual(contents(source(out.project)),contents(source(p)));
 const again=await applyLayoutStructure({project:out.project,plan});assert.equal(again.project.id,out.project.id);
 const restored=await applyLayoutStructure({project:out.project,plan:s.plan});assert.deepEqual(readLayoutStructure(restored.project).bodyReservations,[]);assert.doesNotMatch(source(restored.project),/\\enlargethispage/);
});
