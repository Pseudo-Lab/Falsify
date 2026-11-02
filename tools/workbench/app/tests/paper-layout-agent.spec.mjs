import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {runPaperLayoutAgent} from '../src/paper-layout-agent.mjs';
const enc=new TextEncoder(), dec=new TextDecoder();
const action=(tool,extra={})=>({tool,path:'',before:'',after:'',pages:[],message:'',...extra});
async function fixture(source='Evidence 63. \\vspace{2pt} More text.') {
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode(source)},{path:'asset.png',bytes:Uint8Array.of(1,2)}]});
 const bytes=enc.encode('%PDF synthetic');
 const artifact=p=>({success:true,projectId:p.id,engine:p.engine,pdfBytes:bytes,pdfHash:hex(bytes),diagnostics:[]});
 return {project,artifact};
}
function setup(f,actions,extra={}) {let calls=[]; return {calls, args:{project:f.project,artifact:f.artifact(f.project),decide:async x=>{calls.push(x);return actions.shift();},compile:async ({project})=>f.artifact(project),inspect:async({artifact})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:artifact.pdfHash,issues:[],coverage:{pages:1}}),render:async()=>({images:[{pageIndex:0,mime:'image/png',base64:'iVBORw0KGgo='}],coverage:{pages:[0],complete:false}}),...extra}};}

test('reference-aware completion observes original text and original/candidate images',async()=>{
 const f=await fixture();f.project=await createLatexProject({...f.project,sourcePdfHash:'a'.repeat(64)});
 const reference={sourcePdfHash:'a'.repeat(64),sourcePages:7};
 const extra={reference,readReference:async()=>({...reference,pages:[{pageIndex:0,text:'Evidence 63'}]}),renderReference:async()=>({...reference,images:[{pageIndex:0,mime:'image/png',base64:'iVBORw0KGgo='}]})};
 const s=setup(f,[action('read_reference'),action('render_reference_pages',{pages:[0]}),action('compile_pdf'),action('inspect_pdf'),action('render_pages',{pages:[0]}),action('finish')],extra);
 const out=await runPaperLayoutAgent(s.args);assert.equal(out.status,'complete');assert.deepEqual(s.calls.at(-1).images.map(i=>i.document||'candidate'),['original','candidate']);assert.equal(s.calls[0].reference.sourcePdfHash,reference.sourcePdfHash);
 const missing=await runPaperLayoutAgent(setup(f,[action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')],extra).args);assert.equal(missing.status,'unresolved');
 await assert.rejects(runPaperLayoutAgent({...s.args,reference:{sourcePdfHash:'b'.repeat(64)}}),/reference/);
});

test('a reference observation truncated by its record envelope cannot satisfy completion',async()=>{
 const f=await fixture();f.project=await createLatexProject({...f.project,sourcePdfHash:'a'.repeat(64)});const reference={sourcePdfHash:'a'.repeat(64)};
 const page={pageIndex:0,text:''},output={sourcePdfHash:reference.sourcePdfHash,pages:[page]};page.text='x'.repeat(11990-JSON.stringify(output).length);
 const s=setup(f,[action('read_reference'),action('render_reference_pages'),action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')],{reference,readReference:async()=>output,renderReference:async()=>({...reference,images:[{pageIndex:0,mime:'image/png',base64:'iVBORw0KGgo='}]})});
 const out=await runPaperLayoutAgent(s.args);assert.equal(out.trace[0].result.status,'rejected');assert.equal(out.status,'unresolved');assert.equal(s.calls.some(c=>c.observations.some(e=>e.action==='read_reference'&&e.result.status==='ok')),false);
});

test('current execution status survives the short observation window',async()=>{
 const f=await fixture(),actions=[action('compile_pdf'),action('inspect_pdf'),action('render_pages'),...Array.from({length:5},()=>action('read_source',{path:'main.tex'})),action('finish')];const s=setup(f,actions);const out=await runPaperLayoutAgent(s.args);
 assert.equal(out.status,'complete');assert.equal(s.calls.at(-1).execution.canFinish,true);assert.equal(s.calls.at(-1).execution.compiledCurrent,true);assert.equal(s.calls.at(-1).observations.some(e=>e.action==='compile_pdf'),false);assert.ok(s.calls.at(-1).execution.completedActions.some(e=>e.tool==='compile_pdf'));
});

test('agent can fit a figure with preserved aspect ratio and cannot flatten it',async()=>{
 const before='\\includegraphics[width=0.8\\linewidth]';
 for(const [after,allowed] of [['\\includegraphics[width=0.8\\linewidth,height=1pt]',false],['\\includegraphics[width=0.8\\linewidth,height=120pt,keepaspectratio]',true]]){
  const f=await fixture(before+'{asset.png}');const out=await runPaperLayoutAgent(setup(f,[action('replace_source',{path:'main.tex',before,after}),action('compile_pdf'),action('finish')]).args);
  assert.equal(out.trace[0].result.status,allowed?'ok':'rejected');
 }
});

test('reconstructed paragraph typography and figure envelopes retain their source content',async()=>{
 for(const [before,after] of [['\\fontsize{10bp}{12bp}\\selectfont','\\fontsize{10bp}{13bp}\\selectfont'],['\\FalsifyImage{100bp}{90bp}{assets/a.png}','\\FalsifyImage{120bp}{110bp}{assets/a.png}']]){
  const f=await fixture('\\begin{document}\n{'+before+' Evidence 63.\\par}\n\\end{document}');const out=await runPaperLayoutAgent(setup(f,[action('replace_source',{path:'main.tex',before,after}),action('compile_pdf'),action('finish')]).args);assert.equal(out.trace[0].result.status,'ok');assert.match(dec.decode(out.project.files.find(x=>x.path==='main.tex').bytes),/Evidence 63/);
 }
});

test('large sources are read in bounded chunks without losing edit access',async()=>{
 const source='Evidence 63.\n'.repeat(10000)+'\\setlength{\\parskip}{18pt}';const f=await fixture(source);
 const s=setup(f,[action('read_source',{path:'main.tex',before:'\\setlength'}),action('replace_source',{path:'main.tex',before:'\\setlength{\\parskip}{18pt}',after:'\\setlength{\\parskip}{6pt}'}),action('compile_pdf'),action('finish')]);
 const out=await runPaperLayoutAgent(s.args);assert.ok(s.calls[0].sourceFiles[0].text.length<=3000);assert.ok(out.trace[0].result.text.includes('\\setlength'));assert.ok(out.trace[0].result.totalChunks>1);assert.equal(out.trace[1].result.status,'ok');
});
test('edits layout, compiles, inspects, renders and delivers observations before finish',async()=>{
 const f=await fixture(), s=setup(f,[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{4pt}'}),action('compile_pdf'),action('inspect_pdf'),action('render_pages',{pages:[0]}),action('finish',{message:'done'})]);
 const out=await runPaperLayoutAgent(s.args); assert.equal(out.status,'complete'); assert.match(dec.decode(out.project.files.find(x=>x.path==='main.tex').bytes),/vspace\{4pt\}/); assert.deepEqual([...out.project.files.find(x=>x.path==='asset.png').bytes],[1,2]); assert.equal(out.artifact.projectId,out.project.id); assert.equal(s.calls.at(-1).images[0].pageIndex,0); assert.equal(s.calls.at(-1).observations.at(-1).action,'render_pages'); assert.equal(out.coverage.render.complete,false);
});
test('rejects scientific edits, ambiguous matches and unsupported paths without changing source',async()=>{
 const f=await fixture('Evidence 63. Evidence 63.'); const s=setup(f,[action('replace_source',{path:'main.tex',before:'63',after:'64'}),action('replace_source',{path:'main.tex',before:'Evidence',after:'Other'}),action('replace_source',{path:'asset.png',before:'x',after:'y'}),action('finish')]);const out=await runPaperLayoutAgent(s.args);assert.equal(out.status,'unresolved');assert.equal(out.project.id,f.project.id);assert.deepEqual(out.trace.slice(0,3).map(x=>x.result.status),['rejected','rejected','rejected']);
});
test('refuses stale artifact and does not accept finish after compilation alone',async()=>{
 const f=await fixture();await assert.rejects(runPaperLayoutAgent(setup(f,[],{artifact:{...f.artifact(f.project),projectId:'wrong'}}).args),/Stale artifact/);
 const out=await runPaperLayoutAgent(setup(f,[action('compile_pdf'),action('finish')]).args);assert.equal(out.status,'unresolved');
});
test('late cancellation retains last paired artifact and does not consume tool output',async()=>{
 const f=await fixture(), controller=new AbortController();let release;const gate=new Promise(r=>release=r);const s=setup(f,[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{4pt}'}),action('compile_pdf')],{signal:controller.signal,compile:async({project})=>{await gate;return f.artifact(project);}});const pending=runPaperLayoutAgent(s.args);await new Promise(r=>setTimeout(r,0));controller.abort();release();const out=await pending;assert.equal(out.status,'cancelled');assert.equal(out.project.id,f.project.id);assert.equal(out.artifact.projectId,f.project.id);assert.equal(out.trace.length,1);
});
test('malformed actions and failed inspections cannot complete',async()=>{
 const f=await fixture();let out=await runPaperLayoutAgent(setup(f,[{tool:'finish'}]).args);assert.equal(out.status,'unresolved');out=await runPaperLayoutAgent(setup(f,[action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')],{inspect:async()=>({status:'unavailable'})}).args);assert.equal(out.status,'unresolved');
});

test('supports useful layout settings without changing adjacent science or assets',async()=>{
 const examples=[['\\setlength{\\parskip}{4pt}','\\setlength { \\parskip } { 6pt }'],['\\fontsize{10}{12}\\selectfont','\\fontsize{10}{14}\\selectfont'],['\\columnsep=10pt','\\columnsep = 12pt'],['\\widowpenalty=1000','\\widowpenalty=5000'],['\\rmfamily','\\sffamily'],['\\includegraphics[width=0.8\\linewidth]','\\includegraphics[width=0.9\\linewidth]'],['\\begin{figure}[ht]','\\begin{figure}[tb]'],['\\geometry{margin=2cm}','\\geometry{margin=3cm}'],['\\documentclass[10pt,onecolumn]{article}','\\documentclass[11pt,twocolumn]{article}']];
 for(const [before,after] of examples){const f=await fixture(`\\begin{document}\n${before}\nEvidence 63 and RED 71.\\cite{ref}\n\\end{document}\n% retained comment`);const s=setup(f,[action('replace_source',{path:'main.tex',before,after}),action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')]);const out=await runPaperLayoutAgent(s.args);assert.equal(out.status,'complete',before);assert.equal(out.trace[0].result.status,'ok',before);assert.match(dec.decode(out.project.files[0].path==='main.tex'?out.project.files[0].bytes:out.project.files[1].bytes),/Evidence 63 and RED 71/);assert.equal(typeof s.calls[0].tools[1].description,'string');}
});
test('normal document completes workflow with partial coverage and no edits',async()=>{
 const f=await fixture('Normal evidence 63.');const out=await runPaperLayoutAgent(setup(f,[action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')]).args);assert.equal(out.status,'complete');assert.equal(out.project.id,f.project.id);assert.equal(out.coverage.render.complete,false);
});
test('rejects changes to science, comments, definitions, verbatim and math even alongside layout',async()=>{
 const sources=[['Evidence 63. \\setlength{\\parskip}{4pt}','Evidence 64. \\setlength{\\parskip}{6pt}'],['% \\setlength{\\parskip}{4pt}\nText','% \\setlength{\\parskip}{6pt}\nText'],['\\newcommand{\\x}{\n\\setlength{\\parskip}{4pt}}','\\newcommand{\\x}{\n\\setlength{\\parskip}{6pt}}'],['\\verb|\\vspace{2pt}|','\\verb|\\vspace{4pt}|'],['$\\vspace{2pt}$','$\\vspace{4pt}$'],['<setlength:parskip>','\\setlength{\\parskip}{6pt}']];
 for(const [before,after] of sources){const f=await fixture(before);const out=await runPaperLayoutAgent(setup(f,[action('replace_source',{path:'main.tex',before,after}),action('finish')]).args);assert.equal(out.trace[0].result.status,'rejected',before);assert.match(out.trace[0].result.reason,/Example/);assert.equal(out.project.id,f.project.id);}
});
test('empty or stale inspection and stale compile cannot replace valid output',async()=>{
 const f=await fixture();for(const inspect of [async()=>({}),async()=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:'0'.repeat(64),issues:[],coverage:{pages:1}})]){const out=await runPaperLayoutAgent(setup(f,[action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')],{inspect}).args);assert.equal(out.status,'unresolved');}
 const out=await runPaperLayoutAgent(setup(f,[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{4pt}'}),action('compile_pdf'),action('finish')],{compile:async()=>f.artifact(f.project)}).args);assert.equal(out.status,'unresolved');assert.equal(out.project.id,f.project.id);assert.equal(out.artifact.projectId,f.project.id);
});


test('invalid model action is corrected under a fresh step without losing the candidate',async()=>{
 const f=await fixture();let calls=0;const seen=[];
 const s=setup(f,[],{maxSteps:5,decide:async input=>{seen.push(input);if(calls++===0)throw Object.assign(new Error('private prompt'),{code:'invalid_action',stepReceipt:{runId:'r1',stepId:'r1-s0',fingerprint:'a'.repeat(64),request:{secret:'never export'}}});return [action('compile_pdf'),action('inspect_pdf'),action('render_pages'),action('finish')][calls-2];}});
 const out=await runPaperLayoutAgent(s.args);assert.equal(out.status,'complete');assert.equal(seen.length,5);assert.deepEqual(seen.map(x=>x.step),[0,1,2,3,4]);assert.equal(out.project.id,f.project.id);assert.equal(out.trace[0].action,'invalid_action');assert.equal(out.trace[0].result.status,'rejected');assert.equal(out.trace[0].result.request.stepId,'r1-s0');assert.equal(JSON.stringify(out.trace).includes('private prompt'),false);assert.equal(JSON.stringify(out.trace).includes('never export'),false);
});
test('cancelled invalid_action ends cancelled without another decision and keeps the artifact',async()=>{
 const f=await fixture(),hash=f.artifact(f.project).pdfHash;let calls=0;
 const stop=error=>async()=>{calls++;throw error;};
 const cancelled=await runPaperLayoutAgent(setup(f,[],{maxSteps:2,decide:stop(Object.assign(new Error('private prompt'),{code:'invalid_action',disposition:'cancelled',stepReceipt:{runId:'r1',stepId:'r1-s0',fingerprint:'a'.repeat(64),request:{secret:'never export'}}}))}).args);
 assert.equal(calls,1);assert.equal(cancelled.runState,'cancelled');assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.artifact.pdfHash,hash);assert.equal(cancelled.trace[0].result.request.stepId,'r1-s0');assert.equal(cancelled.trace[0].result.code,'invalid_action');assert.match(cancelled.message,/새 실행을 시작하세요/);assert.equal(cancelled.message.includes('private'),false);assert.equal(JSON.stringify(cancelled.trace).includes('never export'),false);
 calls=0;const finalStep=await runPaperLayoutAgent(setup(f,[],{maxSteps:1,decide:stop(Object.assign(new Error(),{code:'invalid_action',disposition:'cancelled'}))}).args);
 assert.equal(calls,1);assert.equal(finalStep.runState,'cancelled');assert.equal(finalStep.message.includes('step limit'),false);assert.equal(finalStep.artifact.pdfHash,hash);
 calls=0;const retried=await runPaperLayoutAgent(setup(f,[],{maxSteps:2,decide:stop(Object.assign(new Error(),{code:'invalid_action',disposition:'failed'}))}).args);
 assert.equal(calls,2);assert.equal(retried.runState,'paused');assert.equal(retried.artifact.pdfHash,hash);
 calls=0;const timeout=await runPaperLayoutAgent(setup(f,[],{maxSteps:2,decide:stop(Object.assign(new Error('private diagnostic'),{code:'model_timeout',disposition:'cancelled'}))}).args);
 assert.equal(calls,1);assert.equal(timeout.runState,'cancelled');assert.match(timeout.message,/시간/);assert.equal(timeout.message.includes('private'),false);assert.equal(timeout.artifact.pdfHash,hash);
});
test('invalid action correction has a step budget and other failures do not retry',async()=>{
 const f=await fixture();let calls=0;
 const out=await runPaperLayoutAgent(setup(f,[],{maxSteps:2,decide:async()=>{calls++;throw Object.assign(new Error(),{code:'invalid_action'});}}).args);assert.equal(calls,2);assert.equal(out.runState,'paused');assert.equal(out.artifact.pdfHash,f.artifact(f.project).pdfHash);
 calls=0;const stopped=await runPaperLayoutAgent(setup(f,[],{decide:async()=>{calls++;throw Object.assign(new Error('private diagnostic'),{code:'model_timeout'});}}).args);assert.equal(calls,1);assert.equal(stopped.runState,'failed');assert.equal(stopped.trace[0].result.code,'model_timeout');assert.match(stopped.message,/시간/);assert.equal(stopped.message.includes('private'),false);
});
