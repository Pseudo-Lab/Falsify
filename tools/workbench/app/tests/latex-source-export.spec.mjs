import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import {prepareReconstruction,createReconstructionProject,compareReconstruction,createReconstructionLineage} from '../src/pdf-latex-baseline.mjs';
import {prepareSourceExport} from '../src/latex-source-export.mjs';
import {readDocument} from '../src/paper-document.mjs';
import {createLatexProject,importLatexProject,analyzeProjectFiles} from '../src/latex-project.mjs';
import {locateSourceText} from '../src/latex-source-model.mjs';
import {applySourceChanges} from '../src/latex-source-patches.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
const decoder=new TextDecoder(),encode=new TextEncoder();
function pdf(){const d=new mupdf.PDFDocument(),font=new mupdf.Font('Helvetica');try{const f=d.addSimpleFont(font);d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f}},'BT /F 12 Tf 30 330 Td (Evidence 63 remains.) Tj ET'));const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}}finally{font.destroy();d.destroy();}}
async function fixture(){
 const bytes=pdf(),draft=await prepareReconstruction({file:{arrayBuffer:async()=>bytes.slice().buffer}}),made=await createReconstructionProject(draft,[]),asset=Uint8Array.from([0,255,1,7]);
 const baseline=await createLatexProject({...made.project,files:[...made.project.files,{path:'asset.png',bytes:asset}]});
 const bindings=made.bindings.map(b=>({...b,projectId:baseline.id}));
 const artifact={schema:'falsify.latex-artifact.v1',success:true,projectId:baseline.id,engine:baseline.engine,engineManifest:{name:'synthetic'},pdfBytes:bytes,pdfHash:hex(bytes)};
 const lineage=createReconstructionLineage({project:baseline,artifact,comparison:compareReconstruction(draft.evidence.document,await readDocument({file:bytes})),bindings,decisions:[]});
 const hit=locateSourceText(baseline,{before:'Evidence 63 remains.'}).candidates[0],changes=[{id:'red',kind:'text',anchor:hit.anchor,before:hit.before,after:'A much longer altered sentence remains.',enabled:true}];
 const current=(await applySourceChanges(baseline,changes)).project;
 return {baseline,current,changes,lineage,asset};
}
test('edited source ZIP preserves baseline evidence against baseline bytes and current assets',async()=>{
 const {baseline,current,changes,lineage,asset}=await fixture();const result=await prepareSourceExport({baselineProject:baseline,currentProject:current,changes,reconstruction:lineage});
 const imported=await importLatexProject({name:'paper.zip',arrayBuffer:async()=>result.zip.slice().buffer});assert.deepEqual(analyzeProjectFiles(imported).mainCandidates,['main.tex']);
 const get=(p,n)=>p.files.find(f=>f.path===n).bytes,meta=JSON.parse(decoder.decode(get(imported,'falsify-reconstruction.json')));
 assert.equal(meta.schema,'falsify.reconstruction-source-export.v1');assert.equal(meta.baselineProjectId,baseline.id);assert.equal(meta.baselinePdfHash,lineage.baselinePdfHash);assert.equal(meta.sourcePdfHash,baseline.sourcePdfHash);assert.equal(meta.baselineStatus,'compared-baseline');assert.deepEqual(meta.sourceChanges,changes);
 assert.deepEqual(get(imported,'main.tex'),get(current,'main.tex'));assert.ok(decoder.decode(get(imported,'main.tex')).includes('A much longer altered sentence remains.'));assert.deepEqual(get(imported,'asset.png'),asset);
 const b=meta.baselineBindings[0],sf=meta.baselineSourceFiles.find(f=>f.path===b.path),old=Uint8Array.from(atob(sf.bytes),c=>c.charCodeAt(0));assert.equal(hex(old),sf.sha256);assert.deepEqual(old,get(baseline,b.path));assert.equal(b.projectId,baseline.id);assert.ok(decoder.decode(old).slice(b.start,b.end).includes('Evidence 63 remains.'));assert.notEqual(decoder.decode(get(imported,b.path)).slice(b.start,b.end),decoder.decode(old).slice(b.start,b.end));
 assert.notEqual(result.project.id,current.id);assert.equal(JSON.stringify(meta).includes('containing-project'),false);assert.ok(!meta.currentProjectId);assert.equal(imported.files.filter(f=>f.path.endsWith('.tex')).length,1);
});
test('pending reconstruction is recorded as pending, with no new baseline claim',async()=>{
 const {baseline,lineage}=await fixture();const added=await createLatexProject({...baseline,files:[...baseline.files,{path:'additional.sty',bytes:encode.encode('supplement')}]});const hit=locateSourceText(added,{before:'Evidence 63 remains.'}).candidates[0],changes=[{id:'red',kind:'text',anchor:hit.anchor,before:hit.before,after:'A much longer altered sentence remains.',enabled:true}],current=(await applySourceChanges(added,changes)).project;const pending={schema:'falsify.reconstruction-pending.v1',sourcePdfHash:baseline.sourcePdfHash,reason:'files-added',previous:lineage,previousProject:{schema:'falsify.latex-project-descriptor.v1',id:lineage.projectId,mainFile:baseline.mainFile,engine:baseline.engine,origin:baseline.origin,sourcePdfHash:baseline.sourcePdfHash,files:baseline.files.map(({path,sha256})=>({path,sha256}))}};
 const {project}=await prepareSourceExport({baselineProject:added,currentProject:current,changes,reconstruction:pending});const meta=JSON.parse(decoder.decode(project.files.find(f=>f.path==='falsify-reconstruction.json').bytes));assert.equal(meta.baselineStatus,'pending');assert.equal(meta.baselinePdfHash,null);assert.deepEqual(meta.reconstruction,pending);
});
test('stale changes and fabricated lineage are refused; original source is untouched',async()=>{
 const {baseline,current,changes,lineage}=await fixture();await assert.rejects(prepareSourceExport({baselineProject:baseline,currentProject:current,changes:[],reconstruction:lineage}),{code:'CHANGES_MISMATCH'});await assert.rejects(prepareSourceExport({baselineProject:baseline,currentProject:current,changes,reconstruction:{...lineage,projectId:'0'.repeat(64)}}),{code:'INVALID_RECONSTRUCTION'});
 const source=await createLatexProject({files:[{path:'main.tex',bytes:encode.encode('Hello')}],mainFile:'main.tex'}),out=await prepareSourceExport({baselineProject:source,currentProject:source,changes:[]});assert.equal(out.project.id,source.id);assert.deepEqual(out.project.files,source.files);
});
