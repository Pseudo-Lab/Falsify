import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import {prepareReconstruction,createReconstructionProject,compareReconstruction,createReconstructionLineage} from '../src/pdf-latex-baseline.mjs';
import {readDocument} from '../src/paper-document.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
const doc=t=>({pages:[{text:t}]});
function pdf(text){const d=new mupdf.PDFDocument(),f=new mupdf.Font('Helvetica');try{const font=d.addSimpleFont(f);d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},`BT /F 12 Tf 30 330 Td (${text}) Tj ET`));const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}}finally{f.destroy();d.destroy();}}
test('comparison preserves signed, decimal, exponent, percent and Unicode minus lexemes',()=>{
 const c=compareReconstruction(doc('Value -63, +.5; 1e-3 and −2.1E+4%; +12%.'),doc('Value 63, .5; 1e3 and 2.1E+4%; 12%.'));
 assert.deepEqual(c.numbers.missing,['-63','+.5','1e-3','−2.1E+4%','+12%']);
 assert.deepEqual(c.numbers.added,['63','.5','1e3','2.1E+4%','12%']);
 assert.equal(c.readingOrderVerified,false);assert.equal(c.visualLayoutVerified,false);assert.equal(c.method,'extracted-token-multiset');
 const p=compareReconstruction(doc('(-.5), [−63]; 1.2e−3! 4.0%.'),doc('[-.5] −63: 1.2e−3 4.0%'));
 assert.deepEqual(p.numbers,{missing:[],added:[]});
});
test('actual synthetic PDF flows through prepare, region, serialize and project; lineage validates and owns metadata',async()=>{
 const source=pdf('Evidence 63 and 1.5 percent.'),file={arrayBuffer:async()=>source.slice().buffer};
 const draft=await prepareReconstruction({file}),made=await createReconstructionProject(draft,[]);
 assert.equal(draft.sourceSha256,hex(source));assert.equal(made.project.origin,'reconstructed-pdf');assert.ok(made.bindings.length);
 const metadata=JSON.parse(new TextDecoder().decode(made.project.files.find(f=>f.path==='falsify-reconstruction.json').bytes));
 assert.ok(metadata.bindings.every(b=>b.bindingScope==='containing-project'&&!Object.hasOwn(b,'projectId')));
 assert.ok(made.bindings.every(b=>b.projectId===made.project.id));
 // A synthetic PDF exercises identity validation only: no compiler is called here.
 const baseline=pdf('Evidence 63 and 1.5 percent.'),artifact={schema:'falsify.latex-artifact.v1',success:true,projectId:made.project.id,engine:made.project.engine,engineManifest:{name:'synthetic-test',version:'1'},pdfBytes:baseline,pdfHash:hex(baseline)};
 const comparison=compareReconstruction(draft.evidence.document,await readDocument({file:baseline}));
 const input={project:made.project,artifact,comparison,bindings:made.bindings,decisions:[]};
 const lineage=createReconstructionLineage(input);assert.equal(lineage.projectId,made.project.id);assert.equal(lineage.baselinePdfHash,hex(baseline));assert.deepEqual(lineage.bindingProjectIds,made.bindings.map(()=>made.project.id));assert.ok(Object.isFrozen(lineage.comparison.numbers.missing));
 comparison.numbers.missing.push('injected');artifact.engineManifest.name='changed';assert.deepEqual(lineage.comparison.numbers.missing,[]);assert.equal(lineage.engineManifest.name,'synthetic-test');
 assert.throws(()=>createReconstructionLineage({...input,artifact:{...artifact,pdfHash:'0'.repeat(64)}}),{code:'INVALID_ARTIFACT'});
 assert.throws(()=>createReconstructionLineage({...input,artifact:{...artifact,projectId:'0'.repeat(64)}}),{code:'INVALID_ARTIFACT'});
 assert.throws(()=>createReconstructionLineage({...input,artifact:{...artifact,success:false}}),{code:'INVALID_ARTIFACT'});
 assert.throws(()=>createReconstructionLineage({...input,decisions:[{itemId:'forged'}]}),{code:'INVALID_METADATA'});
 assert.throws(()=>createReconstructionLineage({...input,comparison:{...comparison,sourcePdfHash:'0'.repeat(64)}}),{code:'INVALID_COMPARISON'});
 assert.throws(()=>createReconstructionLineage({...input,bindings:made.bindings.map(b=>({...b,projectId:'0'.repeat(64)}))}),{code:'INVALID_BINDINGS'});
 const changed=structuredClone(made.project);changed.files[0].bytes[0]^=1;assert.throws(()=>createReconstructionLineage({...input,project:changed}),{code:'STALE_PROJECT'});
});

test('flow reconstruction is explicit and preserves its typography and Lua engine in archive metadata',async()=>{
 const bytes=pdf('A result of 63.5 percent.'),draft=await prepareReconstruction({file:{arrayBuffer:async()=>bytes.slice().buffer}});
 const legacy=await createReconstructionProject(draft),flow=await createReconstructionProject(draft,[],{layout:'semantic-flow'});
 assert.equal(legacy.project.engine,'pdflatex');assert.equal(flow.project.engine,'lualatex');assert.notEqual(flow.project.id,legacy.project.id);
 const metadata=JSON.parse(new TextDecoder().decode(flow.project.files.find(f=>f.path==='falsify-reconstruction.json').bytes));
 assert.equal(metadata.layout,'semantic-flow');assert.equal(metadata.typography.schema,'falsify.paper-typography.v1');
 assert.ok(flow.bindings.every(b=>b.projectId===flow.project.id));
 await assert.rejects(createReconstructionProject(draft,[],{layout:'unknown'}),/재구성 방식/);
});
